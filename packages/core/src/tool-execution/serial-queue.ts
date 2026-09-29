/**
 * serial-queue.ts — 通用串行队列：把异步操作链接到同一条 Promise tail 上。
 *
 * 与工具执行语义无关的纯基础设施，可独立测试、可在其他模块复用。
 * 队列采用 fail-stop：第一个任务失败后，后续任务复用同一失败，
 * 避免 Hook 或事件在批次已失效后继续改变共享状态。
 */
export class SerialQueue {
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
