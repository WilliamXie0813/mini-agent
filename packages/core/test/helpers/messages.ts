import type {
  AgentMessage,
  AssistantMessage,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from "../../src/types.ts";

type MessageWithoutId =
  | Omit<SystemMessage, "id">
  | Omit<UserMessage, "id">
  | Omit<AssistantMessage, "id">
  | Omit<ToolResultMessage, "id">;

export function identifiedMessage<T extends MessageWithoutId>(
  id: string,
  message: T,
): T & Pick<AgentMessage, "id"> {
  return { id, ...message };
}

export function createTestIdGenerator(prefix = "id"): () => string {
  let next = 1;
  return () => `${prefix}-${next++}`;
}
