/**
 * execute-call.ts — 单条 Tool Call 的执行路径。
 *
 * 两种路径共享同一个 Finalization：
 * - ready：真实执行工具，update 经串行事件通道转交；
 * - immediate：未知工具、非法参数、被阻止调用的合成生命周期。
 */
import type {
  ToolCall,
  ToolExecutionResult,
} from "../types.ts";
import type {
  MarkStarted,
  MarkTerminal,
  ToolExecutionBatchOptions,
} from "./batch.ts";
import {
  ToolEventDispatchError,
  ToolEventDispatcher,
} from "./event-dispatcher.ts";
import { errorResult } from "./prepare.ts";
import type { PreparedToolCall } from "./prepare.ts";
import type { SerialQueue } from "./serial-queue.ts";

export interface CompletedToolCall {
  index: number;
  toolCall: ToolCall;
  result: ToolExecutionResult;
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
export async function executeReady(
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
export async function executeImmediate(
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
