/**
 * event-dispatcher.ts — 工具事件的串行出口。
 *
 * 并行工具共享同一个事件出口。Dispatcher 保证 EventSink 任意时刻
 * 只处理一个事件，从而保留 Agent 状态归约和 Listener 的串行契约。
 */
import type { AgentEvent, EventSink } from "../types.ts";
import { SerialQueue } from "./serial-queue.ts";

/** 标记失败来自事件通道，避免被误当成普通工具异常返回给模型。 */
export class ToolEventDispatchError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Tool event dispatch failed");
    this.cause = cause;
  }
}

export class ToolEventDispatcher {
  private readonly queue = new SerialQueue();
  private readonly sink: EventSink;

  constructor(sink: EventSink) {
    this.sink = sink;
  }

  async emit(event: AgentEvent): Promise<void> {
    try {
      await this.queue.enqueue(() => this.sink(event));
    } catch (error) {
      // 包一层专属错误类型：下游（executeReady）靠 instanceof 区分
      // “事件通道坏了”（属于控制面故障，要中止整个批次）和
      // “工具自身抛错”（属于业务结果，反馈给模型即可）。
      throw error instanceof ToolEventDispatchError
        ? error
        : new ToolEventDispatchError(error);
    }
  }

  get failed(): boolean {
    return this.queue.failed;
  }
}
