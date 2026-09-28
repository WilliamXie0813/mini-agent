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
  ToolExecutionResult,
  ToolResultMessage,
} from "./types.ts";

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

/** 非流式消息（用户消息、工具结果）的定稿仪式：成对发出 message_start / message_end */
async function emitMessage(message: AgentMessage, emit: EventSink): Promise<void> {
  await emit({ type: "message_start", message });
  await emit({ type: "message_end", message });
}

/**
 * 调用模型并把模型事件流转译成 Agent 事件流：
 *   model start      → message_start
 *   text_delta/tool_call → message_update
 *   end              → message_end
 * 流结束后把最终 assistant 消息 push 进历史并返回。
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

  for await (const modelEvent of config.stream(requestMessages, signal)) {
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

    await emit({ type: "message_end", message: modelEvent.message });
  }

  if (!finalMessage) {
    throw new Error("Model stream ended without an Assistant message");
  }

  context.messages.push(finalMessage);
  return finalMessage;
}

/** 构造一个错误工具结果（未知工具 / 参数非法 / 被钩子阻止 / 工具抛异常共用） */
function errorResult(content: string): ToolExecutionResult {
  return { content, isError: true };
}

/**
 * 执行一次工具调用的完整流水线：
 *   查工具 → 校验参数 → beforeToolCall 拦截 → execute → afterToolCall 改写
 *   → 发 tool_execution_end → 生成并定稿 ToolResultMessage → push 进历史
 *
 * 除“中止”之外的任何失败都被降级为 isError 的错误结果（喂回模型），
 * 而不是抛出 —— 工具错误对下一个模型 Turn 保持可见，run 不因此崩掉。
 * 唯独 abort 会重新抛出，让取消能打断整个循环。
 */
async function executeToolCall(
  context: AgentContext,
  toolCall: ToolCall,
  config: AgentLoopConfig,
  emit: EventSink,
  signal: AbortSignal,
): Promise<ToolResultMessage> {
  await emit({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    argumentsValue: toolCall.arguments,
  });

  const tool = context.tools.find((candidate) => candidate.name === toolCall.name);
  let result: ToolExecutionResult;

  if (!tool) {
    result = errorResult(`Unknown tool: ${toolCall.name}`);
  } else {
    const validation = tool.validate(toolCall.arguments);
    if (!validation.ok) {
      result = errorResult(validation.error);
    } else {
      // 参数已收窄为强类型，先给拦截钩子一次说“不”的机会
      const blocked = await config.beforeToolCall?.(
        toolCall,
        validation.value,
        signal,
      );

      if (blocked) {
        result = errorResult(blocked.reason);
      } else {
        try {
          result = await tool.execute(
            toolCall.id,
            validation.value,
            signal,
            // 工具内每次 onUpdate 都转译成一个 tool_execution_update 事件
            async (partial) => {
              await emit({
                type: "tool_execution_update",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                partial,
              });
            },
          );
        } catch (error) {
          // 中止信号优先：取消不属于“工具错误”，向上抛出终止整个 run
          if (signal.aborted) throw error;
          result = errorResult(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
  }

  // afterToolCall 可以整体替换结果（含把成功改成失败、改写 content/details）
  const replacement = await config.afterToolCall?.(toolCall, result, signal);
  const finalResult = replacement ?? result;
  const isError = finalResult.isError === true;

  await emit({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result: finalResult,
    isError,
  });

  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: finalResult.content,
    details: finalResult.details,
    isError,
    timestamp: Date.now(),
  };
  await emitMessage(message, emit);
  context.messages.push(message);
  return message;
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

  for (const prompt of prompts) {
    await emitMessage(prompt, emit);
    context.messages.push(prompt);
  }

  let completedTurn: CompletedTurn | undefined;
  let firstTurn = true;
  let toolResultsPending = false;
  // Run 启动前已排队的 steering 与初始 prompt 一起进入首 Turn。
  let pendingMessages = config.getSteeringMessages();

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
      pendingMessages = [];
      if (config.hasSteeringMessages()) {
        pendingMessages = config.getSteeringMessages();
      } else if (!toolResultsPending && config.hasFollowUpMessages()) {
        pendingMessages = config.getFollowUpMessages();
      }
    }
    firstTurn = false;

    for (const message of pendingMessages) {
      await emitMessage(message, emit);
      context.messages.push(message);
    }
    pendingMessages = [];

    const assistant = await streamAssistantResponse(
      context,
      config,
      emit,
      signal,
    );
    const toolCalls = assistant.content.filter(
      (content): content is ToolCall => content.type === "toolCall",
    );
    const toolResults: ToolResultMessage[] = [];
    for (const toolCall of toolCalls) {
      toolResults.push(
        await executeToolCall(context, toolCall, config, emit, signal),
      );
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
