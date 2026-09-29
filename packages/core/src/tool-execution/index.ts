/**
 * index.ts — tool-execution 模块的对外接口。
 *
 * 包外只能看到这里导出的入口函数和配置类型；目录内部拆分的
 * prepare / execute-call / scheduler / event-dispatcher / serial-queue
 * 均为实现细节，内部类型（PreparedToolCall 等）只在目录内流通。
 */
export { executeToolCallBatch } from "./batch.ts";
export type {
  ToolExecutionBatch,
  ToolExecutionBatchOptions,
} from "./batch.ts";
