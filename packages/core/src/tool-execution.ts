import type {
  AfterToolCall,
  AgentEvent,
  BeforeToolCall,
  EventSink,
  IdGenerator,
  Tool,
  ToolCall,
  ToolExecutionMode,
  ToolExecutionResult,
  ToolResultMessage,
} from "./types.ts";
import type { SessionCommitter } from "./session.ts";
import { toJsonValue } from "./session-store.ts";

/**
 * 执行一个 Tool Call 批次所需的运行时依赖。
 *
 * 这里接收已经由 Agent 规范化的配置，因此本模块只负责执行语义，
 * 不再猜测默认值或读取 Agent 的可变状态。
 */
export interface ToolExecutionBatchOptions {
  tools: readonly Tool<unknown>[];
  toolExecutionMode: ToolExecutionMode;
  maxConcurrency: number;
  idGenerator: IdGenerator;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  /** 持久化入口（可选）：ready 调用的 effect intent 在任何副作用之前落盘。 */
  sessionCommitter?: SessionCommitter;
  emit: EventSink;
  signal: AbortSignal;
}

export interface ToolExecutionBatch {
  messages: ToolResultMessage[];
  /** 本批次中真正开始了外部副作用（已持久化 effect_started）的调用 ID。 */
  startedEffectIds: string[];
}

/**
 * 预检把“能否执行”与“何时执行”分开：
 * - ready：工具存在、参数合法且未被 Hook 阻止；
 * - immediate：无需调用 execute，直接产生一个错误结果。
 *
 * index 保存模型给出的原始顺序，供批次完成后恢复 Transcript 顺序。
 */
type PreparedToolCall =
  | {
      kind: "ready";
      index: number;
      toolCall: ToolCall;
      tool: Tool<unknown>;
      parameters: unknown;
    }
  | {
      kind: "immediate";
      index: number;
      toolCall: ToolCall;
      result: ToolExecutionResult;
    };

interface CompletedToolCall {
  index: number;
  toolCall: ToolCall;
  result: ToolExecutionResult;
}

type MarkStarted = (toolCall: ToolCall) => void;
type MarkTerminal = (toolCallId: string) => void;

/** 标记失败来自事件通道，避免被误当成普通工具异常返回给模型。 */
class ToolEventDispatchError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Tool event dispatch failed");
    this.cause = cause;
  }
}

/**
 * 将异步操作链接到同一条 Promise tail 上。
 *
 * 队列采用 fail-stop：第一个任务失败后，后续任务复用同一失败，
 * 避免 Hook 或事件在批次已失效后继续改变共享状态。
 */
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private failedState = false;
  private failure: unknown;

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.failedState) throw this.failure;
      try {
        return await operation();
      } catch (error) {
        this.failedState = true;
        this.failure = error;
        throw error;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  get failed(): boolean {
    return this.failedState;
  }
}

/**
 * 并行工具共享同一个事件出口。Dispatcher 保证 EventSink 任意时刻
 * 只处理一个事件，从而保留 Agent 状态归约和 Listener 的串行契约。
 */
class ToolEventDispatcher {
  private readonly queue = new SerialQueue();
  private readonly sink: EventSink;

  constructor(sink: EventSink) {
    this.sink = sink;
  }

  async emit(event: AgentEvent): Promise<void> {
    try {
      await this.queue.enqueue(() => this.sink(event));
    } catch (error) {
      throw error instanceof ToolEventDispatchError
        ? error
        : new ToolEventDispatchError(error);
    }
  }

  get failed(): boolean {
    return this.queue.failed;
  }
}

function errorResult(content: string): ToolExecutionResult {
  return { content, isError: true };
}

/** 在任何 Hook 或工具启动前验证模型协议中的调用 ID。 */
function validateToolCallIds(toolCalls: readonly ToolCall[]): void {
  const ids = new Set<string>();
  for (const toolCall of toolCalls) {
    if (toolCall.id.length === 0) {
      throw new Error("Tool Call ID must be non-empty");
    }
    if (ids.has(toolCall.id)) {
      throw new Error(`Duplicate Tool Call ID: ${toolCall.id}`);
    }
    ids.add(toolCall.id);
  }
}

/**
 * 严格按模型源顺序完成整个批次的预检。
 *
 * 所有调用都准备完成后才进入执行阶段，因此 beforeToolCall 可以基于
 * 一个尚未产生工具副作用的批次做出决定。
 */
async function prepareToolCalls(
  toolCalls: readonly ToolCall[],
  options: ToolExecutionBatchOptions,
): Promise<PreparedToolCall[]> {
  validateToolCallIds(toolCalls);
  const prepared: PreparedToolCall[] = [];

  for (const [index, toolCall] of toolCalls.entries()) {
    options.signal.throwIfAborted();
    const tool = options.tools.find(
      (candidate) => candidate.name === toolCall.name,
    );
    if (!tool) {
      prepared.push({
        kind: "immediate",
        index,
        toolCall,
        result: errorResult(`Unknown tool: ${toolCall.name}`),
      });
      continue;
    }

    // ready 调用的 effect intent 依赖可持久化的参数；任何已注册工具的
    // 非 JSON 参数都必须在执行任何副作用之前让整个批次失败。
    toJsonValue(toolCall.arguments);

    const validation = tool.validate(toolCall.arguments);
    if (!validation.ok) {
      prepared.push({
        kind: "immediate",
        index,
        toolCall,
        result: errorResult(validation.error),
      });
      continue;
    }

    const blocked = await options.beforeToolCall?.(
      toolCall,
      validation.value,
      options.signal,
    );
    options.signal.throwIfAborted();
    if (blocked) {
      prepared.push({
        kind: "immediate",
        index,
        toolCall,
        result: errorResult(blocked.reason),
      });
      continue;
    }

    prepared.push({
      kind: "ready",
      index,
      toolCall,
      tool,
      parameters: validation.value,
    });
  }

  return prepared;
}

/** 将内部完成记录转换成下一轮模型可见的 Tool Result Message。 */
function toMessage(
  completed: CompletedToolCall,
  idGenerator: IdGenerator,
): ToolResultMessage {
  return {
    id: idGenerator(),
    role: "toolResult",
    toolCallId: completed.toolCall.id,
    toolName: completed.toolCall.name,
    content: completed.result.content,
    details: completed.result.details,
    isError: completed.result.isError === true,
    timestamp: Date.now(),
  };
}

/**
 * Tool 主体可以并发结束，但 afterToolCall 和 terminal event 必须串行。
 * 并发槽位直到本函数结束才释放，因此 maxConcurrency 限制的是完整的
 * in-flight Tool Call 生命周期，而不只是 execute() 的运行时间。
 */
async function finalizeCall(
  prepared: PreparedToolCall,
  result: ToolExecutionResult,
  options: ToolExecutionBatchOptions,
  events: ToolEventDispatcher,
  finalization: SerialQueue,
  markTerminal: MarkTerminal,
): Promise<CompletedToolCall> {
  return finalization.enqueue(async () => {
    const replacement = await options.afterToolCall?.(
      prepared.toolCall,
      result,
      options.signal,
    );
    const finalResult = replacement ?? result;
    await events.emit({
      type: "tool_execution_end",
      toolCallId: prepared.toolCall.id,
      toolName: prepared.toolCall.name,
      result: finalResult,
      isError: finalResult.isError === true,
    });
    markTerminal(prepared.toolCall.id);
    return {
      index: prepared.index,
      toolCall: prepared.toolCall,
      result: finalResult,
    };
  });
}

/** 执行一个通过预检的真实工具，并把 update 转交给串行事件通道。 */
async function executeReady(
  prepared: Extract<PreparedToolCall, { kind: "ready" }>,
  options: ToolExecutionBatchOptions,
  events: ToolEventDispatcher,
  finalization: SerialQueue,
  markStarted: MarkStarted,
  markTerminal: MarkTerminal,
  effectStarted: Set<string>,
): Promise<CompletedToolCall> {
  // Effect intent 必须先于任何外部副作用落盘：只有持久化成功后 execute
  // 才被允许运行，恢复时才能区分“未开始”与“结果未知”。
  await options.sessionCommitter?.startEffect({
    toolCallId: prepared.toolCall.id,
    toolName: prepared.toolCall.name,
    arguments: toJsonValue(prepared.toolCall.arguments),
    replay: prepared.tool.replay ?? "never",
  });
  effectStarted.add(prepared.toolCall.id);
  markStarted(prepared.toolCall);
  await events.emit({
    type: "tool_execution_start",
    toolCallId: prepared.toolCall.id,
    toolName: prepared.toolCall.name,
    argumentsValue: prepared.toolCall.arguments,
  });
  options.signal.throwIfAborted();

  let result: ToolExecutionResult;
  // 即使工具错误地吞掉 onUpdate 的异常，Runtime 仍会在 execute 返回后
  // 重新抛出事件分发错误，防止它被包装成普通 Tool Result。
  let updateFailure: ToolEventDispatchError | undefined;
  try {
    result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.parameters,
      options.signal,
      async (partial) => {
        try {
          await events.emit({
            type: "tool_execution_update",
            toolCallId: prepared.toolCall.id,
            toolName: prepared.toolCall.name,
            partial,
          });
        } catch (error) {
          updateFailure =
            error instanceof ToolEventDispatchError
              ? error
              : new ToolEventDispatchError(error);
          throw updateFailure;
        }
      },
    );
    if (updateFailure) throw updateFailure;
  } catch (error) {
    if (updateFailure) throw updateFailure;
    if (error instanceof ToolEventDispatchError || options.signal.aborted) {
      throw error;
    }
    result = errorResult(error instanceof Error ? error.message : String(error));
  }

  options.signal.throwIfAborted();
  return finalizeCall(
    prepared,
    result,
    options,
    events,
    finalization,
    markTerminal,
  );
}

/** 为未知工具、非法参数和被阻止调用生成完整的 start/end 生命周期。 */
async function executeImmediate(
  prepared: Extract<PreparedToolCall, { kind: "immediate" }>,
  options: ToolExecutionBatchOptions,
  events: ToolEventDispatcher,
  finalization: SerialQueue,
  markStarted: MarkStarted,
  markTerminal: MarkTerminal,
): Promise<CompletedToolCall> {
  await events.emit({
    type: "tool_execution_start",
    toolCallId: prepared.toolCall.id,
    toolName: prepared.toolCall.name,
    argumentsValue: prepared.toolCall.arguments,
  });
  markStarted(prepared.toolCall);
  options.signal.throwIfAborted();
  return finalizeCall(
    prepared,
    prepared.result,
    options,
    events,
    finalization,
    markTerminal,
  );
}

/** 兼容模式：每个调用完成 Finalization 后才开始下一个调用。 */
async function executeSequential(
  preparedCalls: readonly PreparedToolCall[],
  options: ToolExecutionBatchOptions,
  events: ToolEventDispatcher,
  finalization: SerialQueue,
  markStarted: MarkStarted,
  markTerminal: MarkTerminal,
  effectStarted: Set<string>,
): Promise<CompletedToolCall[]> {
  const completed: CompletedToolCall[] = [];
  for (const prepared of preparedCalls) {
    options.signal.throwIfAborted();
    completed.push(
      prepared.kind === "ready"
        ? await executeReady(
            prepared,
            options,
            events,
            finalization,
            markStarted,
            markTerminal,
            effectStarted,
          )
        : await executeImmediate(
            prepared,
            options,
            events,
            finalization,
            markStarted,
            markTerminal,
          ),
    );
  }
  return completed;
}

/**
 * 并行采用显式 opt-in。任何 ready 工具未声明 parallel，
 * 整个批次都会降级为串行；immediate 错误不会影响策略选择。
 */
function shouldExecuteInParallel(
  preparedCalls: readonly PreparedToolCall[],
  mode: ToolExecutionMode,
): boolean {
  return (
    mode === "parallel" &&
    preparedCalls.every(
      (prepared) =>
        prepared.kind === "immediate" ||
        prepared.tool.executionMode === "parallel",
    )
  );
}

/**
 * 受限并行调度器。
 *
 * activeReady 只保存占用并发槽位的 ready 调用；allStarted 还包含
 * 不占槽位的 immediate 调用，用于批次退出前等待所有已启动工作 settle。
 * tracked Promise 会吸收单任务 rejection，并把第一个错误交给协调器统一处理，
 * 从而避免未处理 rejection 和提前退出后遗留后台任务。
 */
async function executeParallel(
  preparedCalls: readonly PreparedToolCall[],
  options: ToolExecutionBatchOptions,
  events: ToolEventDispatcher,
  finalization: SerialQueue,
  markStarted: MarkStarted,
  markTerminal: MarkTerminal,
  effectStarted: Set<string>,
): Promise<CompletedToolCall[]> {
  const completed: CompletedToolCall[] = [];
  const activeReady = new Set<Promise<void>>();
  const allStarted: Promise<void>[] = [];
  let hasPrimaryError = false;
  let primaryError: unknown;

  const record = (
    promise: Promise<CompletedToolCall>,
    consumesSlot: boolean,
  ): void => {
    let tracked!: Promise<void>;
    tracked = promise
      .then((value) => {
        completed.push(value);
      })
      .catch((error: unknown) => {
        if (!hasPrimaryError) {
          hasPrimaryError = true;
          primaryError = error;
        }
      })
      .finally(() => {
        if (consumesSlot) activeReady.delete(tracked);
      });
    allStarted.push(tracked);
    if (consumesSlot) activeReady.add(tracked);
  };

  for (const prepared of preparedCalls) {
    if (hasPrimaryError) break;
    options.signal.throwIfAborted();

    if (prepared.kind === "immediate") {
      // immediate 仍走事件和 Finalization，但不占用真实工具并发槽位。
      record(
        executeImmediate(
          prepared,
          options,
          events,
          finalization,
          markStarted,
          markTerminal,
        ),
        false,
      );
      await Promise.resolve();
      continue;
    }

    while (activeReady.size >= options.maxConcurrency) {
      // 等任意完整 Tool Call 生命周期结束并释放槽位，不要求按启动顺序等待。
      await Promise.race(activeReady);
      if (hasPrimaryError) break;
      options.signal.throwIfAborted();
    }
    if (hasPrimaryError) break;

    record(
      executeReady(
        prepared,
        options,
        events,
        finalization,
        markStarted,
        markTerminal,
        effectStarted,
      ),
      true,
    );
    await Promise.resolve();
  }

  await Promise.allSettled(allStarted);
  options.signal.throwIfAborted();
  if (hasPrimaryError) throw primaryError;
  return completed;
}

/**
 * 为已经 start、但尚未 end 的调用补发取消终止事件。
 * EventSink 自身失败时无法可靠通知外部消费者，只能由 Agent finally
 * 清理内部 pending 状态，所以事件分发直接跳过；但 effect 的取消记录
 * 仍必须持久化——恢复时“已取消”远比“结果未知”更有用。
 */
async function emitCancelledForOpenCalls(
  started: ReadonlyMap<string, ToolCall>,
  terminal: ReadonlySet<string>,
  reason: "aborted" | "control_error",
  events: ToolEventDispatcher,
  sessionCommitter: SessionCommitter | undefined,
  effectStarted: ReadonlySet<string>,
): Promise<void> {
  for (const toolCall of started.values()) {
    if (terminal.has(toolCall.id)) continue;
    if (effectStarted.has(toolCall.id)) {
      await sessionCommitter?.cancelEffect(toolCall.id);
    }
    if (!events.failed) {
      await events.emit({
        type: "tool_execution_cancelled",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        reason,
      });
    }
  }
}

/**
 * 批次入口：预检、选择策略、等待结算，最后按模型源顺序构造消息。
 * 在本函数成功返回前不会修改 Transcript，因此失败批次不会部分提交结果。
 */
export async function executeToolCallBatch(
  toolCalls: readonly ToolCall[],
  options: ToolExecutionBatchOptions,
): Promise<ToolExecutionBatch> {
  if (toolCalls.length === 0) return { messages: [], startedEffectIds: [] };

  const prepared = await prepareToolCalls(toolCalls, options);
  const events = new ToolEventDispatcher(options.emit);
  const finalization = new SerialQueue();
  const started = new Map<string, ToolCall>();
  const terminal = new Set<string>();
  // effectStarted 只记录真正持久化了 effect_started 的 ready 调用：
  // 它与事件生命周期的 started map 分离，避免 immediate 调用或
  // 事件失败污染恢复语义。
  const effectStarted = new Set<string>();
  const markStarted = (toolCall: ToolCall): void => {
    started.set(toolCall.id, toolCall);
  };
  const markTerminal = (toolCallId: string): void => {
    terminal.add(toolCallId);
  };

  let completed: CompletedToolCall[];
  try {
    completed = shouldExecuteInParallel(prepared, options.toolExecutionMode)
      ? await executeParallel(
          prepared,
          options,
          events,
          finalization,
          markStarted,
          markTerminal,
          effectStarted,
        )
      : await executeSequential(
          prepared,
          options,
          events,
          finalization,
          markStarted,
          markTerminal,
          effectStarted,
        );
  } catch (error) {
    const reason = options.signal.aborted ? "aborted" : "control_error";
    try {
      await emitCancelledForOpenCalls(
        started,
        terminal,
        reason,
        events,
        options.sessionCommitter,
        effectStarted,
      );
    } catch {
      // Preserve the original control error or abort reason.
    }
    if (options.signal.aborted) options.signal.throwIfAborted();
    throw error;
  }

  completed.sort((left, right) => left.index - right.index);
  return {
    messages: completed.map((item) => toMessage(item, options.idGenerator)),
    startedEffectIds: [...effectStarted],
  };
}
