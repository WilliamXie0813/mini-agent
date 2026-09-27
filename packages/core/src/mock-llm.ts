/**
 * mock-llm.ts — 确定性的伪模型
 *
 * 在真实模型适配器将来要使用的同一条流式边界（StreamFn）背后，
 * 实现一个纯函数式的状态机：输入消息历史，输出 assistant 事件流。
 *
 * 行为剧本（按优先级匹配）：
 * 1. 历史尾部是 toolResult → 根据 read 结果给出最终答案（成功或报错）；
 * 2. 尾部是含“只回答项目名称”的用户消息 → 复用已有的 read 结果直接回答（follow-up 场景）；
 * 3. 尾部是含“版本号”的用户消息 → 同上，回答版本；
 * 4. 尾部是含“package.json”的用户消息且还没有 read 结果 → 发出一次 read 工具调用；
 * 5. 兜底：复述用户消息。
 *
 * 关键约束（设计文档明确要求）：Mock LLM 从不执行工具，也从不修改 Agent 状态。
 */
import type {
  AgentMessage,
  AssistantMessage,
  ModelStreamEvent,
  StreamFn,
  ToolResultMessage,
} from "./types.ts";

/** 从历史尾部往前找最近一次成功的 read 工具结果（供后续 follow-up 问题复用） */
function latestReadResult(messages: readonly AgentMessage[]): ToolResultMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "toolResult" &&
      message.toolName === "read" &&
      !message.isError
    ) {
      return message;
    }
  }
  return undefined;
}

/** 把 read 到的 package.json 内容解析成 { name, version }，解析失败返回空对象 */
function parsePackage(result: ToolResultMessage): {
  name?: string;
  version?: string;
} {
  try {
    const parsed: unknown = JSON.parse(result.content);
    if (parsed === null || typeof parsed !== "object") return {};
    return {
      name:
        "name" in parsed && typeof parsed.name === "string"
          ? parsed.name
          : undefined,
      version:
        "version" in parsed && typeof parsed.version === "string"
          ? parsed.version
          : undefined,
    };
  } catch {
    return {};
  }
}

/** 可被取消的延迟：delayMs 为 0 时只检查中止信号；否则挂 timer 并监听 abort */
async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs === 0) {
    signal.throwIfAborted();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * 逐字符流式输出一段文本的通用生成器：
 * 先发 start（空消息），再逐字符发 text_delta（携带累计快照），最后发 end。
 * 每个字符之间插入可中止的延迟，模拟真实模型的流式输出节奏。
 */
async function* streamText(
  text: string,
  signal: AbortSignal,
  delayMs: number,
): AsyncGenerator<ModelStreamEvent> {
  let message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "stop",
    timestamp: Date.now(),
  };
  yield { type: "start", message };

  for (const character of text) {
    await wait(delayMs, signal);
    const current = message.content[0];
    if (current?.type !== "text") throw new Error("Invalid text stream state");
    message = {
      ...message,
      content: [{ type: "text", text: current.text + character }],
    };
    yield { type: "text_delta", delta: character, message };
  }

  yield { type: "end", message };
}

/**
 * 创建一个 Mock 模型的 StreamFn。
 * delayMs 控制流式速度（demo 里设为 10ms 便于肉眼观察流式效果；测试里为 0 追求速度）。
 */
export function createMockStream(options: { delayMs?: number } = {}): StreamFn {
  const delayMs = options.delayMs ?? 0;

  return async function* mockStream(messages, signal) {
    signal.throwIfAborted();
    const lastMessage = messages.at(-1);
    const readResult = latestReadResult(messages);

    // 场景 1：上一轮刚执行完工具 → 给出最终答案
    if (lastMessage?.role === "toolResult") {
      if (lastMessage.isError) {
        yield* streamText(
          `工具执行失败：${lastMessage.content}`,
          signal,
          delayMs,
        );
        return;
      }

      const packageData = parsePackage(lastMessage);
      yield* streamText(
        packageData.name
          ? `项目名称是 ${packageData.name}。`
          : "package.json 中没有有效的 name。",
        signal,
        delayMs,
      );
      return;
    }

    // 场景 2：follow-up 问题——“只回答项目名称”，复用历史中的 read 结果，不再调工具
    if (
      lastMessage?.role === "user" &&
      lastMessage.content.includes("只回答项目名称")
    ) {
      const packageData = readResult ? parsePackage(readResult) : {};
      yield* streamText(
        packageData.name ?? "当前上下文中没有项目名称。",
        signal,
        delayMs,
      );
      return;
    }

    // 场景 3：follow-up 问题——问版本号
    if (lastMessage?.role === "user" && lastMessage.content.includes("版本号")) {
      const packageData = readResult ? parsePackage(readResult) : {};
      yield* streamText(
        packageData.version
          ? `项目版本是 ${packageData.version}。`
          : "当前上下文中没有项目版本信息。",
        signal,
        delayMs,
      );
      return;
    }

    // 场景 4：用户提到 package.json → 发出一次 read 工具调用（不发文本流，只发 tool_call）
    if (
      lastMessage?.role === "user" &&
      lastMessage.content.includes("package.json")
    ) {
      const toolCall = {
        type: "toolCall" as const,
        id: "call-read-package",
        name: "read",
        arguments: { path: "package.json" },
      };
      const startMessage: AssistantMessage = {
        role: "assistant",
        content: [],
        stopReason: "toolUse", // 注意：stopReason 是 toolUse，告诉循环“我还有工具要跑”
        timestamp: Date.now(),
      };
      const toolMessage: AssistantMessage = {
        ...startMessage,
        content: [toolCall],
      };
      yield { type: "start", message: startMessage };
      yield { type: "tool_call", toolCall, message: toolMessage };
      yield { type: "end", message: toolMessage };
      return;
    }

    // 兜底：复述用户消息（steering 等未识别的输入会走到这里）
    yield* streamText(
      lastMessage?.role === "user"
        ? `你说的是：${lastMessage.content}`
        : "没有可处理的用户消息。",
      signal,
      delayMs,
    );
  };
}
