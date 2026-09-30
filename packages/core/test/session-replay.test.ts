import assert from "node:assert/strict";
import test from "node:test";
import type {
  JsonValue,
  PendingEffect,
  QueueName,
  SessionMetadata,
  SessionOperation,
  SessionRecord,
  SessionSnapshot,
} from "../src/index.ts";

test("Session domain contracts are available from the package entrypoint", () => {
  const queue: QueueName = "steering";
  const value: JsonValue = { path: "package.json", lines: [1, 2] };
  const metadata: SessionMetadata = {
    id: "session-1",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  };
  const effect: PendingEffect = {
    toolCallId: "call-1",
    toolName: "read",
    arguments: value,
    replay: "safe",
  };
  const operation: SessionOperation = {
    type: "effect_started",
    effect,
  };
  const record: SessionRecord = {
    type: "commit",
    sequence: 1,
    timestamp: "2026-09-30T00:00:01.000Z",
    operations: [operation],
  };
  const snapshot: SessionSnapshot = {
    metadata,
    messages: [],
    steeringQueue: [],
    followUpQueue: [],
    pendingEffects: [effect],
    cancelledEffects: [],
    recoveryWarnings: [],
  };

  assert.equal(queue, "steering");
  assert.equal(record.type, "commit");
  assert.equal(snapshot.pendingEffects[0]?.toolCallId, "call-1");
});
