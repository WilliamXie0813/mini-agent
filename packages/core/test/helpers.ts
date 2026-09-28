import type {
  AssistantMessage,
  IdGenerator,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from "../src/types.ts";

export function createIdGenerator(prefix = "id"): IdGenerator {
  let next = 1;
  return () => `${prefix}-${next++}`;
}

export function systemMessage(
  id = "system-1",
  content = "system",
  timestamp = 1,
): SystemMessage {
  return { id, role: "system", content, timestamp };
}

export function userMessage(
  id = "user-1",
  content = "hello",
  timestamp = 2,
): UserMessage {
  return { id, role: "user", content, timestamp };
}

export function assistantMessage(
  id = "assistant-1",
  text = "done",
  timestamp = 3,
): AssistantMessage {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp,
  };
}

export function toolResultMessage(
  id = "tool-result-1",
  timestamp = 4,
): ToolResultMessage {
  return {
    id,
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: "{}",
    isError: false,
    timestamp,
  };
}
