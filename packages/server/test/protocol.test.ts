import assert from "node:assert/strict";
import test from "node:test";
import type { AgentState } from "@mini-agent/core";
import { parseCommand, serializeState } from "../src/protocol.ts";

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

test("parseCommand accepts valid commands", () => {
  assert.deepEqual(parseCommand('{"type":"prompt","content":"hi"}'), {
    type: "prompt",
    content: "hi",
  });
  assert.deepEqual(parseCommand('{"type":"abort"}'), { type: "abort" });
  assert.deepEqual(parseCommand('{"type":"reset"}'), { type: "reset" });
});

test("parseCommand rejects malformed payloads", () => {
  assert.equal(parseCommand("not json"), undefined);
  assert.equal(parseCommand('{"type":"prompt"}'), undefined);
  assert.equal(parseCommand('{"type":"prompt","content":""}'), undefined);
  assert.equal(parseCommand('{"type":"nope"}'), undefined);
  assert.equal(parseCommand("42"), undefined);
});
