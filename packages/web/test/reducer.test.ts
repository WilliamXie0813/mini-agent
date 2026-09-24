import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@mini-agent/core";
import { emptyState, reduceEvent } from "../src/state/reducer";

const assistantMessage: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "你好" }],
  stopReason: "stop",
  timestamp: 1,
};

describe("reduceEvent", () => {
  it("tracks the streaming assistant message and appends it on message_end", () => {
    let state = emptyState();
    state = reduceEvent(state, { type: "message_start", message: assistantMessage });
    expect(state.streamingMessage).toBe(assistantMessage);
    expect(state.messages).toHaveLength(0);

    state = reduceEvent(state, { type: "message_end", message: assistantMessage });
    expect(state.streamingMessage).toBeUndefined();
    expect(state.messages).toEqual([assistantMessage]);
  });

  it("ignores message_start/update for non-assistant messages", () => {
    const user = { role: "user" as const, content: "hi", timestamp: 1 };
    const state = reduceEvent(emptyState(), {
      type: "message_start",
      message: user,
    });
    expect(state.streamingMessage).toBeUndefined();
  });

  it("tracks pending tool calls", () => {
    let state = emptyState();
    state = reduceEvent(state, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      argumentsValue: { path: "package.json" },
    });
    expect(state.pendingToolCalls).toEqual(["call-1"]);

    state = reduceEvent(state, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: "{}" },
      isError: false,
    });
    expect(state.pendingToolCalls).toEqual([]);
  });

  it("toggles isStreaming on agent_start/agent_end and records turn errors", () => {
    let state = emptyState();
    state = reduceEvent(state, { type: "agent_start" });
    expect(state.isStreaming).toBe(true);

    const failed: AssistantMessage = {
      ...assistantMessage,
      stopReason: "error",
      errorMessage: "boom",
    };
    state = reduceEvent(state, {
      type: "turn_end",
      message: failed,
      toolResults: [],
    });
    expect(state.errorMessage).toBe("boom");

    state = reduceEvent(state, { type: "agent_end", messages: [] });
    expect(state.isStreaming).toBe(false);
    expect(state.streamingMessage).toBeUndefined();
  });
});
