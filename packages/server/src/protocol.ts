import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AssistantMessage,
  SessionMetadata,
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
  | { type: "reset" }
  | { type: "list_sessions" }
  | { type: "create_session"; sessionId?: string }
  | { type: "open_session"; sessionId: string };

export type ServerMessage =
  | { type: "state"; state: SerializableAgentState }
  | { type: "event"; event: AgentEvent }
  /** Broadcast after a session reset so every client can clear local logs. */
  | { type: "reset" }
  | { type: "error"; message: string }
  | { type: "session_list"; sessions: SessionMetadata[] }
  | { type: "session_opened"; sessionId: string }
  | { type: "session_error"; message: string };

export type ParseCommandResult =
  | { ok: true; command: ClientCommand }
  | {
      ok: false;
      kind: "command" | "session";
      message: string;
    };

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

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

export function parseCommand(raw: string): ParseCommandResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, kind: "command", message: "Unrecognized command" };
  }
  if (data === null || typeof data !== "object" || !("type" in data)) {
    return { ok: false, kind: "command", message: "Unrecognized command" };
  }
  const type = (data as { type: unknown }).type;
  switch (type) {
    case "prompt":
    case "steer":
    case "followUp": {
      const content = (data as { content?: unknown }).content;
      if (typeof content !== "string" || content.length === 0) {
        return { ok: false, kind: "command", message: "Unrecognized command" };
      }
      return { ok: true, command: { type, content } };
    }
    case "abort":
    case "reset":
    case "list_sessions":
      return { ok: true, command: { type } };
    case "create_session": {
      const sessionId = (data as { sessionId?: unknown }).sessionId;
      // 省略 sessionId 时由服务器稍后自动生成，属于合法命令
      if (sessionId === undefined) {
        return { ok: true, command: { type: "create_session" } };
      }
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
        return { ok: false, kind: "session", message: "Invalid sessionId" };
      }
      return { ok: true, command: { type: "create_session", sessionId } };
    }
    case "open_session": {
      const sessionId = (data as { sessionId?: unknown }).sessionId;
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
        return { ok: false, kind: "session", message: "Invalid sessionId" };
      }
      return { ok: true, command: { type: "open_session", sessionId } };
    }
    default:
      return { ok: false, kind: "command", message: "Unrecognized command" };
  }
}
