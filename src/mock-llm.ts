import type {
  AgentMessage,
  AssistantMessage,
  ModelStreamEvent,
  StreamFn,
  ToolResultMessage,
} from "./types.ts";

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

export function createMockStream(options: { delayMs?: number } = {}): StreamFn {
  const delayMs = options.delayMs ?? 0;

  return async function* mockStream(messages, signal) {
    signal.throwIfAborted();
    const lastMessage = messages.at(-1);
    const readResult = latestReadResult(messages);

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
        stopReason: "toolUse",
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

    yield* streamText(
      lastMessage?.role === "user"
        ? `你说的是：${lastMessage.content}`
        : "没有可处理的用户消息。",
      signal,
      delayMs,
    );
  };
}
