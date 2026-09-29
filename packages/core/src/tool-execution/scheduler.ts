/**
 * scheduler.ts — 批次调度策略：串行兼容模式与受限并行调度器。
 *
 * 并行采用显式 opt-in：任何 ready 工具未声明 parallel，
 * 整个批次都会降级为串行；immediate 错误不影响策略选择。
 */
import type { ToolExecutionMode } from "../types.ts";
import type {
  MarkStarted,
  MarkTerminal,
  ToolExecutionBatchOptions,
} from "./batch.ts";
import type { ToolEventDispatcher } from "./event-dispatcher.ts";
import { executeImmediate, executeReady } from "./execute-call.ts";
import type { CompletedToolCall } from "./execute-call.ts";
import type { PreparedToolCall } from "./prepare.ts";
import type { SerialQueue } from "./serial-queue.ts";

/** 兼容模式：每个调用完成 Finalization 后才开始下一个调用。 */
export async function executeSequential(
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

export function shouldExecuteInParallel(
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
export async function executeParallel(
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
    // tracked 在声明时被“掏空”（let 不赋值），随后立即赋值为整条
    // 处理链。finally 回调引用 tracked 时看起来它还没赋值，但
    // finally 只会在 promise settle 后运行 —— 那时赋值早已完成。
    // 这个自引用是为了能在 activeReady 集合里精确删除“自己”。
    let tracked!: Promise<void>;
    tracked = promise
      .then((value) => {
        completed.push(value);
      })
      .catch((error: unknown) => {
        // 不在单任务里抛错，只记录第一个错误（primary error），
        // 由协调器在主循环末尾统一抛出 —— 避免未处理 rejection，
        // 也避免某个任务失败时其他已启动任务变成孤儿。
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
      // 让出一个微任务 tick：给刚启动的调用一次机会把它的
      // tool_execution_start 排进事件队列，保持事件顺序与启动顺序一致。
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
      ),
      true,
    );
    // 同上：让出微任务，保证 start 事件先于下一次循环迭代入队。
    await Promise.resolve();
  }

  await Promise.allSettled(allStarted);
  options.signal.throwIfAborted();
  if (hasPrimaryError) throw primaryError;
  return completed;
}
