import assert from "node:assert/strict";
import test from "node:test";
import type { AgentState } from "@mini-agent/core";
import { encodeMessage, parseCommand, serializeState } from "../src/protocol.ts";

function fakeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    messages: [],
    tools: [],
    isStreaming: false,
    pendingToolCalls: new Set<string>(),
    ...overrides,
  };
}

test("serializeState converts pendingToolCalls Set to an array", () => {
  const state = fakeState({ pendingToolCalls: new Set(["call-1", "call-2"]) });
  const serialized = serializeState(state, {
    steering: [],
    followUp: [],
  });
  assert.deepEqual(serialized.pendingToolCalls, ["call-1", "call-2"]);
  assert.deepEqual(serialized.queues, { steering: [], followUp: [] });
  // 结果必须可 JSON 序列化且可还原
  assert.deepEqual(JSON.parse(JSON.stringify(serialized)), serialized);
});

test("encodeMessage preserves tool_execution_cancelled events", () => {
  const encoded = encodeMessage({
    type: "event",
    event: {
      type: "tool_execution_cancelled",
      toolCallId: "call-2",
      toolName: "read",
      reason: "control_error",
    },
  });

  assert.deepEqual(JSON.parse(encoded), {
    type: "event",
    event: {
      type: "tool_execution_cancelled",
      toolCallId: "call-2",
      toolName: "read",
      reason: "control_error",
    },
  });
});

test("parseCommand accepts valid commands", () => {
  assert.deepEqual(parseCommand('{"type":"prompt","content":"hi"}'), {
    ok: true,
    command: { type: "prompt", content: "hi" },
  });
  assert.deepEqual(parseCommand('{"type":"abort"}'), {
    ok: true,
    command: { type: "abort" },
  });
  assert.deepEqual(parseCommand('{"type":"reset"}'), {
    ok: true,
    command: { type: "reset" },
  });
});

test("parseCommand rejects malformed payloads", () => {
  const unrecognized = {
    ok: false,
    kind: "command",
    message: "Unrecognized command",
  } as const;
  assert.deepEqual(parseCommand("not json"), unrecognized);
  assert.deepEqual(parseCommand('{"type":"prompt"}'), unrecognized);
  assert.deepEqual(parseCommand('{"type":"prompt","content":""}'), unrecognized);
  assert.deepEqual(parseCommand('{"type":"nope"}'), unrecognized);
  assert.deepEqual(parseCommand("42"), unrecognized);
});

test("parseCommand accepts session commands", () => {
  assert.deepEqual(parseCommand('{"type":"list_sessions"}'), {
    ok: true,
    command: { type: "list_sessions" },
  });
  assert.deepEqual(parseCommand('{"type":"create_session"}'), {
    ok: true,
    command: { type: "create_session" },
  });
  assert.deepEqual(
    parseCommand('{"type":"create_session","sessionId":"work_1"}'),
    {
      ok: true,
      command: { type: "create_session", sessionId: "work_1" },
    },
  );
  assert.deepEqual(parseCommand('{"type":"open_session","sessionId":"a"}'), {
    ok: true,
    command: { type: "open_session", sessionId: "a" },
  });
});

test("parseCommand distinguishes malformed commands from invalid session ids", () => {
  assert.deepEqual(
    parseCommand('{"type":"open_session","sessionId":"../escape"}'),
    {
      ok: false,
      kind: "session",
      message: "Invalid sessionId",
    },
  );
  assert.deepEqual(parseCommand('{"type":"open_session"}'), {
    ok: false,
    kind: "session",
    message: "Invalid sessionId",
  });
  assert.deepEqual(
    parseCommand('{"type":"create_session","sessionId":"../escape"}'),
    {
      ok: false,
      kind: "session",
      message: "Invalid sessionId",
    },
  );
  assert.deepEqual(parseCommand('{"type":"create_session","sessionId":42}'), {
    ok: false,
    kind: "session",
    message: "Invalid sessionId",
  });
  assert.deepEqual(parseCommand('{"type":"nope"}'), {
    ok: false,
    kind: "command",
    message: "Unrecognized command",
  });
});

test("serializeState omits undefined optional keys but includes defined ones", () => {
  const absent = serializeState(fakeState(), { steering: [], followUp: [] });
  assert.equal("streamingMessage" in absent, false);
  assert.equal("errorMessage" in absent, false);
  const present = serializeState(
    fakeState({ errorMessage: "boom" }),
    { steering: [], followUp: [] },
  );
  assert.equal(present.errorMessage, "boom");
});
