/**
 * index.ts — 包的公共出口
 *
 * 只 re-export 对外的稳定 API：Agent、Mock 流工厂、read 工具工厂和全部公共类型。
 * agent-loop 的 runAgentLoop 不导出——循环编排是内部实现细节，
 * 外部始终通过 Agent 的有状态 API 交互。
 */
export { Agent } from "./agent.ts";
export type { AgentOptions } from "./agent.ts";
export { createMockStream } from "./mock-llm.ts";
export { createReadTool } from "./tools.ts";
export { editFile, readFile } from "./harness/tools/index.ts";
export {
  createDeterministicCompactingTransform,
  createHeuristicTokenEstimator,
} from "./context.ts";
export type { ReadParameters } from "./tools.ts";
export {
  ModelError,
  isRetryableModelError,
  toModelError,
} from "./errors.ts";
export type { ModelErrorCode } from "./errors.ts";
export {
  createDefaultRetryPolicy,
  streamWithRetry,
} from "./retry.ts";
export type {
  DefaultRetryPolicyOptions,
  RetryContext,
  RetryDecision,
  RetryPolicy,
  SleepFn,
  StreamRetryOptions,
} from "./retry.ts";
export type {
  EditFileParameters,
  ReadFileParameters,
} from "./harness/tools/index.ts";
export * from "./types.ts";
