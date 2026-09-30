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
    // 关键技巧：无论之前排了多少任务，新任务永远接在 tail 后面。
    // 每个任务都要等前一个 settle 后才开始，所以任意时刻只有一个
    // 任务真正在执行 —— “串行”不是靠锁，而是靠这条 Promise 链。
    const result = this.tail.then(async () => {
      if (this.failedState) throw this.failure;
      try {
        return await operation();
      } catch (error) {
        // fail-stop：记住第一个失败，之后 enqueue 进来的任务
        // 全部直接复用这个失败，不再执行 operation。
        this.failedState = true;
        this.failure = error;
        throw error;
      }
    });
    // tail 只维护“排队顺序”，不关心任务成败：两个回调都返回
    // undefined，把成功和失败都吸收掉。否则某个任务失败后，
    // tail 本身变成 rejected，后续所有任务链都会被跳过。
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    // 返回给调用方的是带成败的 result，而不是被吞掉错误的 tail。
    return result;
  }

  get failed(): boolean {
    return this.failedState;
  }
}
