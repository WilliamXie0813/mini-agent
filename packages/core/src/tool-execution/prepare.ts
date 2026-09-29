/**
 * prepare.ts — 批次预检：把“能否执行”与“何时执行”分开。
 *
 * - ready：工具存在、参数合法且未被 Hook 阻止；
 * - immediate：无需调用 execute，直接产生一个错误结果。
 *
 * index 保存模型给出的原始顺序，供批次完成后恢复 Transcript 顺序。
 */
import type {
  Tool,
  ToolCall,
  ToolExecutionResult,
} from "../types.ts";
import type { ToolExecutionBatchOptions } from "./batch.ts";

export type PreparedToolCall =
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

export function errorResult(content: string): ToolExecutionResult {
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
export async function prepareToolCalls(
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
