import assert from "node:assert/strict";
import test from "node:test";
import {
  replaySessionRecords,
  toJsonValue,
} from "../src/session-store.ts";
import type { SessionRecord } from "../src/session.ts";
import {
  assistantMessage,
  systemMessage,
  userMessage,
} from "./helpers.ts";

test("toJsonValue accepts JSON and rejects unsupported values", () => {
  assert.deepEqual(toJsonValue({ path: "a", flags: [true, null, 2] }), {
    path: "a",
    flags: [true, null, 2],
  });
  assert.throws(() => toJsonValue(1n), /not JSON serializable/);
  assert.throws(() => toJsonValue(() => undefined), /not JSON serializable/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => toJsonValue(cyclic), /circular/);
});

test("replay rebuilds transcript queues effects and updatedAt", () => {
  const records: SessionRecord[] = [
    {
      type: "session",
      version: 1,
      metadata: {
        id: "session-a",
        createdAt: "2026-09-28T00:00:00.000Z",
        updatedAt: "2026-09-28T00:00:00.000Z",
      },
    },
    {
      type: "commit",
      sequence: 1,
      timestamp: "2026-09-28T00:00:01.000Z",
      operations: [
        { type: "message", message: systemMessage() },
        {
          type: "queue_enqueued",
          queue: "steering",
          message: userMessage("queued-1", "queued"),
        },
        {
          type: "effect_started",
          effect: {
            toolCallId: "call-1",
            toolName: "write",
            arguments: { path: "a" },
            replay: "never",
          },
        },
      ],
    },
    {
      type: "commit",
      sequence: 2,
      timestamp: "2026-09-28T00:00:02.000Z",
      operations: [
        {
          type: "queue_dequeued",
          queue: "steering",
          messageId: "queued-1",
        },
        { type: "message", message: userMessage("queued-1", "queued") },
        { type: "message", message: assistantMessage() },
      ],
    },
  ];

  const snapshot = replaySessionRecords(records, []);
  assert.deepEqual(
    snapshot.messages.map((message) => message.id),
    ["system-1", "queued-1", "assistant-1"],
  );
  assert.deepEqual(snapshot.steeringQueue, []);
  assert.deepEqual(
    snapshot.pendingEffects.map((effect) => effect.toolCallId),
    ["call-1"],
  );
  assert.equal(snapshot.lastSequence, 2);
  assert.equal(snapshot.metadata.updatedAt, "2026-09-28T00:00:02.000Z");
  assert.equal(snapshot.recoveryWarnings[0]?.kind, "unknown");
});

test("replay rejects sequence holes and unmatched dequeues", () => {
  const header: SessionRecord = {
    type: "session",
    version: 1,
    metadata: {
      id: "session-a",
      createdAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
    },
  };
  assert.throws(
    () =>
      replaySessionRecords(
        [
          header,
          {
            type: "commit",
            sequence: 2,
            timestamp: "2026-09-28T00:00:02.000Z",
            operations: [],
          },
        ],
        [],
      ),
    /Expected sequence 1 but received 2/,
  );
  assert.throws(
    () =>
      replaySessionRecords(
        [
          header,
          {
            type: "commit",
            sequence: 1,
            timestamp: "2026-09-28T00:00:01.000Z",
            operations: [
              {
                type: "queue_dequeued",
                queue: "followUp",
                messageId: "missing",
              },
            ],
          },
        ],
        [],
      ),
    /missing queued message/,
  );
});
