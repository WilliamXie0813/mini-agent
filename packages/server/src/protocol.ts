import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AssistantMessage,
} from "@mini-agent/core";

export interface QueueState {
  steering: AgentMessage[];
  followUp: AgentMessage[];
}

export interface SerializableAgentState {
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage?: AssistantMessage;
  pendingToolCalls: string[];
  errorMessage?: string;
  queues: QueueState;
}

export type ClientCommand =
  | { type: "prompt"; content: string }
  | { type: "steer"; content: string }
  | { type: "followUp"; content: string }
  | { type: "abort" }
  | { type: "reset" };

export type ServerMessage =
  | { type: "state"; state: SerializableAgentState }
  | { type: "event"; event: AgentEvent }
  /** Broadcast after a session reset so every client can clear local logs. */
  | { type: "reset" }
  | { type: "error"; message: string };

export function serializeState(
  state: AgentState,
  queues: QueueState,
): SerializableAgentState {
  const serialized: SerializableAgentState = {
    messages: state.messages,
    isStreaming: state.isStreaming,
    pendingToolCalls: [...state.pendingToolCalls],
    queues,
  };
  // omit undefined so the result survives a JSON round-trip unchanged
  if (state.streamingMessage !== undefined) {
    serialized.streamingMessage = state.streamingMessage;
  }
  if (state.errorMessage !== undefined) {
    serialized.errorMessage = state.errorMessage;
  }
  return serialized;
}

export function encodeMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

export function parseCommand(raw: string): ClientCommand | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (data === null || typeof data !== "object" || !("type" in data)) {
    return undefined;
  }
  const type = (data as { type: unknown }).type;
  switch (type) {
    case "prompt":
    case "steer":
    case "followUp": {
      const content = (data as { content?: unknown }).content;
      if (typeof content !== "string" || content.length === 0) {
        return undefined;
      }
      return { type, content };
    }
    case "abort":
    case "reset":
      return { type };
    default:
      return undefined;
  }
}
