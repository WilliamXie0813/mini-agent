import type {
  AfterToolCall,
  AgentEvent,
  BeforeToolCall,
  EventSink,
  Tool,
  ToolCall,
  ToolExecutionMode,
  ToolExecutionResult,
  ToolResultMessage,
} from "./types.ts";

export interface ToolExecutionBatchOptions {
  tools: readonly Tool<unknown>[];
  toolExecutionMode: ToolExecutionMode;
  maxConcurrency: number;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  emit: EventSink;
  signal: AbortSignal;
}

export interface ToolExecutionBatch {
  messages: ToolResultMessage[];
}

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

class ToolEventDispatchError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Tool event dispatch failed");
    this.cause = cause;
  }
}

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

function toMessage(completed: CompletedToolCall): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: completed.toolCall.id,
    toolName: completed.toolCall.name,
    content: completed.result.content,
    details: completed.result.details,
    isError: completed.result.isError === true,
    timestamp: Date.now(),
  };
}

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

async function executeReady(
  prepared: Extract<PreparedToolCall, { kind: "ready" }>,
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

  let result: ToolExecutionResult;
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

async function executeSequential(
  preparedCalls: readonly PreparedToolCall[],
  options: ToolExecutionBatchOptions,
  events: ToolEventDispatcher,
  finalization: SerialQueue,
  markStarted: MarkStarted,
  markTerminal: MarkTerminal,
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

async function executeParallel(
  preparedCalls: readonly PreparedToolCall[],
  options: ToolExecutionBatchOptions,
  events: ToolEventDispatcher,
  finalization: SerialQueue,
  markStarted: MarkStarted,
  markTerminal: MarkTerminal,
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

async function emitCancelledForOpenCalls(
  started: ReadonlyMap<string, ToolCall>,
  terminal: ReadonlySet<string>,
  reason: "aborted" | "control_error",
  events: ToolEventDispatcher,
): Promise<void> {
  if (events.failed) return;
  for (const toolCall of started.values()) {
    if (terminal.has(toolCall.id)) continue;
    await events.emit({
      type: "tool_execution_cancelled",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      reason,
    });
  }
}

export async function executeToolCallBatch(
  toolCalls: readonly ToolCall[],
  options: ToolExecutionBatchOptions,
): Promise<ToolExecutionBatch> {
  if (toolCalls.length === 0) return { messages: [] };

  const prepared = await prepareToolCalls(toolCalls, options);
  const events = new ToolEventDispatcher(options.emit);
  const finalization = new SerialQueue();
  const started = new Map<string, ToolCall>();
  const terminal = new Set<string>();
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
        )
      : await executeSequential(
          prepared,
          options,
          events,
          finalization,
          markStarted,
          markTerminal,
        );
  } catch (error) {
    const reason = options.signal.aborted ? "aborted" : "control_error";
    try {
      await emitCancelledForOpenCalls(started, terminal, reason, events);
    } catch {
      // Preserve the original control error or abort reason.
    }
    if (options.signal.aborted) options.signal.throwIfAborted();
    throw error;
  }

  completed.sort((left, right) => left.index - right.index);
  return { messages: completed.map(toMessage) };
}
