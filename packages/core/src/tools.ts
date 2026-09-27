/**
 * tools.ts — 工具接口的示例实现：虚拟文件系统上的 read 工具
 *
 * 演示 Tool 接口的两个核心职责：
 * 1. validate：手写校验，把模型给的 unknown 参数收窄为强类型；
 *    非法参数在这里就变成错误结果，永远到不了 execute。
 * 2. execute：从内存 map 读文件，演示协作式取消（signal.throwIfAborted）
 *    和进度上报（onUpdate → tool_execution_update 事件）。
 */
import type { Tool, ValidationResult } from "./types.ts";

/** read 工具校验通过后的参数形状 */
export interface ReadParameters {
  path: string;
}

/**
 * 手写参数校验：不依赖任何校验库（设计目标：零运行时依赖）。
 * 模型给的 arguments 是 unknown，必须逐字段检查后才能信任。
 */
function validateReadArguments(value: unknown): ValidationResult<ReadParameters> {
  if (
    value === null ||
    typeof value !== "object" ||
    !("path" in value) ||
    typeof value.path !== "string"
  ) {
    return {
      ok: false,
      error: 'read requires an object with a string "path"',
    };
  }

  return { ok: true, value: { path: value.path } };
}

/**
 * 创建一个 read 工具，files 是路径 → 内容的虚拟文件表，例如：
 * { "package.json": "{\"name\":\"mock-agent-demo\"}" }
 */
export function createReadTool(files: Readonly<Record<string, string>>): Tool<ReadParameters> {
  return {
    name: "read",
    description: "Read a UTF-8 file from the virtual file system",
    validate: validateReadArguments,
    async execute(_toolCallId, parameters, signal, onUpdate) {
      // 协作式取消：进入时先检查一次，让 abort() 能尽快生效
      signal.throwIfAborted();
      // 上报进度：循环层会把这次回调转成 tool_execution_update 事件
      await onUpdate({ content: `Reading ${parameters.path}` });
      signal.throwIfAborted();

      const content = files[parameters.path];
      if (content === undefined) {
        // 文件不存在也走正常的错误结果路径（而不是抛异常），
        // 这样错误会作为 ToolResultMessage 喂回模型，模型能看到并回应
        return {
          content: `File not found: ${parameters.path}`,
          details: { path: parameters.path },
          isError: true,
        };
      }

      return {
        content,
        details: { path: parameters.path },
        isError: false,
      };
    },
  };
}
