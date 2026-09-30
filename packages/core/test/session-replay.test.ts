import assert from "node:assert/strict";
import test from "node:test";
import {
  replaySessionRecords,
} from "../src/index.ts";
import type {
  JsonValue,
  PendingEffect,
  QueueName,
  SessionMetadata,
  SessionOperation,
  SessionRecord,
  SessionSnapshot,
} from "../src/index.ts";
import {
  identifiedMessage,
} from "./helpers/messages.ts";

const createdAt = "2026-09-30T00:00:00.000Z";
const firstCommitAt = "2026-09-30T00:00:01.000Z";
const secondCommitAt = "2026-09-30T00:00:02.000Z";

function metadata(): SessionMetadata {
  return {
    id: "session-1",
    createdAt,
    updatedAt: createdAt,
  };
}

function header(): SessionRecord {
  return {
    type: "session",
    version: 1,
    metadata: metadata(),
  };
}

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

test("replaySessionRecords returns an empty Snapshot from only a Header", () => {
  assert.deepEqual(
    replaySessionRecords([header()]),
    {
      metadata: metadata(),
      messages: [],
      steeringQueue: [],
      followUpQueue: [],
      pendingEffects: [],
      cancelledEffects: [],
      recoveryWarnings: [],
    },
  );
});

test("replaySessionRecords applies message operations in Commit order", () => {
  const system = identifiedMessage("system-1", {
    role: "system",
    content: "system",
    timestamp: 1,
  });
  const user = identifiedMessage("user-1", {
    role: "user",
    content: "hello",
    timestamp: 2,
  });

  const snapshot = replaySessionRecords([
    header(),
    {
      type: "commit",
      sequence: 1,
      timestamp: firstCommitAt,
      operations: [
        { type: "message", message: system },
        { type: "message", message: user },
      ],
    },
    {
      type: "commit",
      sequence: 2,
      timestamp: secondCommitAt,
      operations: [],
    },
  ]);

  assert.deepEqual(snapshot.messages, [system, user]);
  assert.equal(snapshot.metadata.updatedAt, secondCommitAt);
});

test("replaySessionRecords requires exactly one leading Header", () => {
  assert.throws(
    () => replaySessionRecords([]),
    /Session records must begin with a Session Header/,
  );
  assert.throws(
    () =>
      replaySessionRecords([
        {
          type: "commit",
          sequence: 1,
          timestamp: firstCommitAt,
          operations: [],
        },
      ]),
    /Session records must begin with a Session Header/,
  );
  assert.throws(
    () => replaySessionRecords([header(), header()]),
    /Unexpected Session Header after replay began/,
  );
});

test("replaySessionRecords rejects gaps, duplicates, and backwards sequence", () => {
  for (const sequences of [
    [2],
    [1, 1],
    [1, 3],
    [1, 0],
  ]) {
    const records: SessionRecord[] = [
      header(),
      ...sequences.map((sequence, index) => ({
        type: "commit" as const,
        sequence,
        timestamp:
          index === 0 ? firstCommitAt : secondCommitAt,
        operations: [],
      })),
    ];

    assert.throws(
      () => replaySessionRecords(records),
      /Expected Commit sequence \d+ but received -?\d+/,
    );
  }
});
