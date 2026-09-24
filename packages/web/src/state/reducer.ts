import type { AgentEvent } from "@mini-agent/core";
import type { SerializableAgentState } from "@mini-agent/server";

export function emptyState(): SerializableAgentState {
  return {
    messages: [],
    isStreaming: false,
    pendingToolCalls: [],
    queues: { steering: [], followUp: [] },
  };
}

/**
 * Folds a streamed AgentEvent into a SerializableAgentState. Intentionally
 * diverges from core's `Agent.processEvent` in two ways:
 * - `isStreaming` is toggled here on agent_start/agent_end (core does it in
 *   `Agent.run()`'s try/finally, outside the event handler).
 * - `pendingToolCalls` cleanup on agent_end is left to the server's
 *   low-frequency state resend rather than duplicated here.
 */
export function reduceEvent(
  state: SerializableAgentState,
  event: AgentEvent,
): SerializableAgentState {
  switch (event.type) {
    case "agent_start":
      return { ...state, isStreaming: true, errorMessage: undefined };
    case "agent_end":
      return { ...state, isStreaming: false, streamingMessage: undefined };
    case "message_start":
    case "message_update":
      if (event.message.role !== "assistant") return state;
      return { ...state, streamingMessage: event.message };
    case "message_end":
      return {
        ...state,
        streamingMessage: undefined,
        messages: [...state.messages, event.message],
      };
    case "tool_execution_start":
      return {
        ...state,
        pendingToolCalls: [...state.pendingToolCalls, event.toolCallId],
      };
    case "tool_execution_end":
      return {
        ...state,
        pendingToolCalls: state.pendingToolCalls.filter(
          (id) => id !== event.toolCallId,
        ),
      };
    case "turn_end":
      return { ...state, errorMessage: event.message.errorMessage };
    default:
      return state;
  }
}
