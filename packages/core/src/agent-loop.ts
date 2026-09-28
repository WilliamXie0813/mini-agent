/**
 * agent-loop.ts — Agent 循环编排层（整个系统的心脏）
 *
 * 负责把一个 run 拆解成若干 Turn，并在正确的边界做正确的事：
 * - 启动 / 结束 run 与 Turn，发出全部生命周期事件；
 * - 调用 StreamFn 拿 assistant 响应（模型只描述意图，不执行）；
 * - 查找工具、校验参数、应用 before/after 钩子、执行工具、生成 ToolResultMessage；
 * - 在 Turn 边界排空 steering 队列（插队消息），在任务自然停止后才排空 followUp 队列；
 * - 尊重 finishTurn 钩子的 end / continue 决策。
 *
 * 每轮循环对应一个 Turn；Turn 结束后只做非破坏性队列检查，
 * 确认确实还有工作时才启动下一 Turn。
 */
import type {
  AgentContext,
  AgentContextSnapshot,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AssistantMessage,
  CompletedTurn,
  EventSink,
  ToolCall,
  ToolResultMessage,
} from "./types.ts";
import type { QueuedMessageReservation } from "./session.ts";
import { executeToolCallBatch } from "./tool-execution.ts";
import { streamWithRetry } from "./retry.ts";

function snapshotContext(context: AgentContext): AgentContextSnapshot {
  // 只复制容器，不深拷贝消息；消息在一次 Run 内按不可变值使用。
  return {
    messages: context.messages.slice(),
    tools: context.tools.slice(),
  };
}

function applyPreparation(
  context: AgentContext,
  preparation: { messages?: readonly AgentMessage[] } | undefined,
): void {
  if (preparation?.messages) {
    // 再复制一次，避免 Hook 返回后继续修改自己持有的数组影响 Loop。
    context.messages = preparation.messages.slice();
  }
}

/** 浅拷贝 assistant 消息（含 content 数组元素），避免订阅者改到模型发出的原对象 */
function cloneAssistant(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((content) => ({ ...content })),
  };
}

/**
 * 非流式消息（用户消息、工具结果）的持久化优先定稿仪式：
 * 先落盘并确认队列预留，再成对发出 message_start / message_end 并写回历史。
 * 落盘失败时消息既不进历史也不发事件，调用方（runAgentLoop 或 Agent）
 * 会把异常翻译成终态失败消息。
 */
async function commitMessages(
  messages: readonly AgentMessage[],
  reservations: readonly QueuedMessageReservation[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EventSink,
): Promise<void> {
  await config.sessionCommitter?.commitMessages({
    messages,
    dequeued: reservations,
  });
  config.acknowledgeReservations(reservations);
  for (const message of messages) {
    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });
    context.messages.push(message);
  }
}

/**
 * Assistant 终稿：end 事件到达时才算定稿——先落盘，再发 message_end 并写回历史。
 * start / text_delta / tool_call 仍即时转发（流式观感不变），但都不进历史。
 */
async function commitAssistant(
  message: AssistantMessage,
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EventSink,
): Promise<void> {
  await config.sessionCommitter?.commitMessages({ messages: [message] });
  await emit({ type: "message_end", message });
  context.messages.push(message);
}

/**
 * 调用模型并把模型事件流转译成 Agent 事件流：
 *   model start      → message_start
 *   text_delta/tool_call → message_update
 *   end              → 定稿（commitAssistant：落盘 → message_end → 进历史）
 * 流结束后返回最终 assistant 消息（不在此处二次 push）。
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EventSink,
  signal: AbortSignal,
): Promise<AssistantMessage> {
  let finalMessage: AssistantMessage | undefined;
  signal.throwIfAborted();
  // prepareRequest 可以同步权威历史，因此它修改的是本 Run 的工作上下文。
  applyPreparation(
    context,
    await config.prepareRequest?.(snapshotContext(context), signal),
  );
  signal.throwIfAborted();
  const transformed = config.transformContext
    ? await config.transformContext(context.messages, signal)
    : context.messages;
  const requestMessages = transformed.slice();
  // requestMessages 是一次性投影；后续 Assistant 仍写回 context.messages。
  // 重试时所有 attempt 共享同一个 requestMessages 数组对象。

  const stream =
    config.retryPolicy && config.sleep
      ? streamWithRetry({
          startAttempt: () => config.stream(requestMessages, signal),
          policy: config.retryPolicy,
          sleep: config.sleep,
          signal,
          emit,
        })
      : config.stream(requestMessages, signal);

  let receivedEnd = false;
  for await (const modelEvent of stream) {
    if (modelEvent.type === "end") {
      receivedEnd = true;
      finalMessage = modelEvent.message;
      await commitAssistant(modelEvent.message, context, config, emit);
      continue;
    }
    finalMessage = modelEvent.message;

    if (modelEvent.type === "start") {
      await emit({
        type: "message_start",
        message: cloneAssistant(modelEvent.message),
      });
      continue;
    }

    if (
      modelEvent.type === "text_delta" ||
      modelEvent.type === "tool_call"
    ) {
      await emit({
        type: "message_update",
        message: cloneAssistant(modelEvent.message),
        modelEvent,
      });
      continue;
    }
  }

  if (!finalMessage || !receivedEnd) {
    throw new Error("Model stream ended before end event");
  }

  return finalMessage;
}

/**
 * 跑一个完整的 Agent run。
 *
 * @param prompts  本轮要追加的输入消息（prompt() 的用户消息，或 continue() 从队列取出的消息）
 * @param context  上下文快照（messages 会被本函数就地 push 增长）
 * @param config   模型入口、队列 peek/drain 方法与生命周期钩子
 * @param emit     事件出口（Agent 会把它归约成状态再通知订阅者）
 * @param signal   整个 run 的中止信号，同时传给模型和工具
 */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EventSink,
  signal: AbortSignal,
): Promise<void> {
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  // 初始 prompt 先落盘再发出；落盘失败则整个 run 直接走失败通道。
  await commitMessages(prompts, [], context, config, emit);

  let completedTurn: CompletedTurn | undefined;
  let firstTurn = true;
  let toolResultsPending = false;
  // Run 启动前已排队的 steering 与初始 prompt 一起进入首 Turn（只预留不出队）。
  let pendingReservations: QueuedMessageReservation[] =
    config.reserveSteeringMessages();
  // continue() 从 assistant 尾部续跑时 prompts 为空：没有 steering 就回落到
  // followUp，避免模型对着自己的答案空转出一个 spurious Turn。
  // prompt() 永远带 ≥1 条消息，因此 prompt 触发的 run 仍保持
  // “followUp 等任务自然停止后才投递”的语义。
  if (
    prompts.length === 0 &&
    pendingReservations.length === 0 &&
    config.hasFollowUpMessages()
  ) {
    pendingReservations = config.reserveFollowUpMessages();
  }

  while (true) {
    if (!firstTurn) {
      if (!completedTurn) {
        throw new Error("Missing completed Turn before next Turn");
      }
      await emit({ type: "turn_start" });
      signal.throwIfAborted();
      applyPreparation(
        context,
        await config.prepareNextTurn?.(completedTurn, signal),
      );
      // Hook 可能耗时；返回后再检查队列，期间到达的 steering 不会错过本 Turn。
      pendingReservations = [];
      if (config.hasSteeringMessages()) {
        pendingReservations = config.reserveSteeringMessages();
      } else if (!toolResultsPending && config.hasFollowUpMessages()) {
        pendingReservations = config.reserveFollowUpMessages();
      }
    }
    firstTurn = false;

    if (pendingReservations.length > 0) {
      // 落盘成功才确认出队、发事件、进历史；失败时预留留在队列里。
      await commitMessages(
        pendingReservations.map((item) => item.message),
        pendingReservations,
        context,
        config,
        emit,
      );
      pendingReservations = [];
    }

    const assistant = await streamAssistantResponse(
      context,
      config,
      emit,
      signal,
    );
    const toolCalls = assistant.content.filter(
      (content): content is ToolCall => content.type === "toolCall",
    );
    // 执行器可以按真实完成顺序发送 end 事件，但只在整个批次成功后
    // 返回按模型源顺序排列的消息，避免并发调度改变 Transcript。
    const batch = await executeToolCallBatch(toolCalls, {
      tools: context.tools,
      toolExecutionMode: config.toolExecutionMode,
      maxConcurrency: config.maxToolConcurrency,
      idGenerator: config.idGenerator,
      beforeToolCall: config.beforeToolCall,
      afterToolCall: config.afterToolCall,
      emit,
      signal,
    });
    const toolResults: ToolResultMessage[] = batch.messages;
    // Tool Result 作为一个连续提交区间写入历史，队列消息只能在 Turn 边界进入。
    // 每条先落盘再发出；落盘成功后才终结对应的 effect 记录。
    for (const message of toolResults) {
      await commitMessages([message], [], context, config, emit);
      await config.sessionCommitter?.finishEffect(message.toolCallId);
    }

    completedTurn = {
      message: assistant,
      toolResults: toolResults.slice(),
      context: snapshotContext(context),
    };
    const decision = await config.finishTurn?.(completedTurn, signal);
    await emit({ type: "turn_end", message: assistant, toolResults });
    if (decision?.action === "end") {
      await emit({ type: "agent_end", messages: context.messages.slice() });
      return;
    }

    toolResultsPending = toolResults.length > 0;
    // 这里只“看”队列，不消费；真正 drain 发生在下一 Turn 已开始之后。
    const hasNextTurn =
      toolResultsPending ||
      config.hasSteeringMessages() ||
      (!toolResultsPending && config.hasFollowUpMessages()) ||
      decision?.action === "continue";
    if (!hasNextTurn) break;
  }

  await emit({ type: "agent_end", messages: context.messages.slice() });
}
