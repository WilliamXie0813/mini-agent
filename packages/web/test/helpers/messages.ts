import type {
  AgentMessage,
  AssistantMessage,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from "@mini-agent/core";

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
