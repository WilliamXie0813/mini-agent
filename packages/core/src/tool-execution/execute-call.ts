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
  // updateFailure 是本文件最难的一段，动机是：onUpdate 是交给工具
  // 实现的回调，工具可以 try/catch 把它吞掉。如果事件分发失败被吞，
  // 工具会带着一个“残缺事件流”正常返回，错误还会被包装成 Tool Result
  // 喂给模型。所以这里把分发失败存进变量，execute 返回后重新抛出。
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
    // 工具正常返回了，但曾经吞掉过分发失败 —— 补上这一抛。
    if (updateFailure) throw updateFailure;
  } catch (error) {
    // 分发失败优先于一切其他错误抛出（控制面故障 > 工具自身故障）。
    if (updateFailure) throw updateFailure;
    // 两类错误不当成工具结果：事件通道故障（控制面）和用户取消。
    // 它们向上抛给批次协调器，由它统一走取消/失败流程。
    if (error instanceof ToolEventDispatchError || options.signal.aborted) {
      throw error;
    }
    // 剩下的就是工具自身的普通异常：降级为错误结果反馈给模型。
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
