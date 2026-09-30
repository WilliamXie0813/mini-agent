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

function effect(
  toolCallId: string,
  replay: "safe" | "never" = "never",
): PendingEffect {
  return {
    toolCallId,
    toolName: "read",
    arguments: { path: "package.json" },
    replay,
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

test("replaySessionRecords rebuilds both queues in enqueue order", () => {
  const steering = identifiedMessage("steering-1", {
    role: "user",
    content: "interrupt",
    timestamp: 1,
  });
  const followUp = identifiedMessage("follow-up-1", {
    role: "user",
    content: "later",
    timestamp: 2,
  });

  const snapshot = replaySessionRecords([
    header(),
    {
      type: "commit",
      sequence: 1,
      timestamp: firstCommitAt,
      operations: [
        {
          type: "queue_enqueued",
          queue: "steering",
          message: steering,
        },
        {
          type: "queue_enqueued",
          queue: "followUp",
          message: followUp,
        },
      ],
    },
    {
      type: "commit",
      sequence: 2,
      timestamp: secondCommitAt,
      operations: [
        {
          type: "queue_dequeued",
          queue: "steering",
          messageId: steering.id,
        },
        {
          type: "message",
          message: steering,
        },
      ],
    },
  ]);

  assert.deepEqual(snapshot.messages, [steering]);
  assert.deepEqual(snapshot.steeringQueue, []);
  assert.deepEqual(snapshot.followUpQueue, [followUp]);
});

test("queue dequeue can pair with a message in the same Commit", () => {
  const queued = identifiedMessage("queued-1", {
    role: "user",
    content: "queued",
    timestamp: 1,
  });

  const snapshot = replaySessionRecords([
    header(),
    {
      type: "commit",
      sequence: 1,
      timestamp: firstCommitAt,
      operations: [
        {
          type: "queue_enqueued",
          queue: "followUp",
          message: queued,
        },
      ],
    },
    {
      type: "commit",
      sequence: 2,
      timestamp: secondCommitAt,
      operations: [
        {
          type: "queue_dequeued",
          queue: "followUp",
          messageId: queued.id,
        },
        { type: "message", message: queued },
      ],
    },
  ]);

  assert.deepEqual(snapshot.followUpQueue, []);
  assert.deepEqual(snapshot.messages, [queued]);
});

test("queue operations reject duplicate and missing identities", () => {
  const queued = identifiedMessage("queued-1", {
    role: "user",
    content: "queued",
    timestamp: 1,
  });

  assert.throws(
    () =>
      replaySessionRecords([
        header(),
        {
          type: "commit",
          sequence: 1,
          timestamp: firstCommitAt,
          operations: [
            {
              type: "queue_enqueued",
              queue: "steering",
              message: queued,
            },
            {
              type: "queue_enqueued",
              queue: "followUp",
              message: queued,
            },
          ],
        },
      ]),
    /Queue message already enqueued: queued-1/,
  );

  assert.throws(
    () =>
      replaySessionRecords([
        header(),
        {
          type: "commit",
          sequence: 1,
          timestamp: firstCommitAt,
          operations: [
            {
              type: "queue_dequeued",
              queue: "steering",
              messageId: "missing",
            },
          ],
        },
      ]),
    /Queue message missing is not enqueued in steering/,
  );
});

test("reset replaces messages and clears queues", () => {
  const oldMessage = identifiedMessage("old-user", {
    role: "user",
    content: "old",
    timestamp: 1,
  });
  const queued = identifiedMessage("queued-user", {
    role: "user",
    content: "queued",
    timestamp: 2,
  });
  const resetSystem = identifiedMessage("reset-system", {
    role: "system",
    content: "new system",
    timestamp: 3,
  });

  const snapshot = replaySessionRecords([
    header(),
    {
      type: "commit",
      sequence: 1,
      timestamp: firstCommitAt,
      operations: [
        { type: "message", message: oldMessage },
        {
          type: "queue_enqueued",
          queue: "steering",
          message: queued,
        },
        {
          type: "reset",
          systemMessage: resetSystem,
        },
      ],
    },
  ]);

  assert.deepEqual(snapshot.messages, [resetSystem]);
  assert.deepEqual(snapshot.steeringQueue, []);
  assert.deepEqual(snapshot.followUpQueue, []);
});

test("effect outcomes separate pending, finished, and cancelled calls", () => {
  const pending = effect("call-pending", "never");
  const finished = effect("call-finished", "safe");
  const cancelled = effect("call-cancelled", "never");

  const snapshot = replaySessionRecords([
    header(),
    {
      type: "commit",
      sequence: 1,
      timestamp: firstCommitAt,
      operations: [
        { type: "effect_started", effect: pending },
        { type: "effect_started", effect: finished },
        { type: "effect_started", effect: cancelled },
      ],
    },
    {
      type: "commit",
      sequence: 2,
      timestamp: secondCommitAt,
      operations: [
        {
          type: "effect_finished",
          toolCallId: finished.toolCallId,
        },
        {
          type: "effect_cancelled",
          toolCallId: cancelled.toolCallId,
        },
      ],
    },
  ]);

  assert.deepEqual(snapshot.pendingEffects, [pending]);
  assert.deepEqual(snapshot.cancelledEffects, [cancelled]);
  assert.deepEqual(
    snapshot.recoveryWarnings.map((warning) => ({
      kind: warning.kind,
      toolCallId: warning.effect.toolCallId,
    })),
    [
      { kind: "unknown", toolCallId: "call-pending" },
      { kind: "cancelled", toolCallId: "call-cancelled" },
    ],
  );
  assert.match(
    snapshot.recoveryWarnings[0]?.message ?? "",
    /call-pending.*outcome is unknown/,
  );
  assert.match(
    snapshot.recoveryWarnings[1]?.message ?? "",
    /call-cancelled.*was cancelled/,
  );
});

test("effect operations require a single pending lifecycle", () => {
  const started = effect("call-1");

  assert.throws(
    () =>
      replaySessionRecords([
        header(),
        {
          type: "commit",
          sequence: 1,
          timestamp: firstCommitAt,
          operations: [
            { type: "effect_started", effect: started },
            { type: "effect_started", effect: started },
          ],
        },
      ]),
    /Tool effect already recorded: call-1/,
  );

  for (const operation of [
    {
      type: "effect_finished" as const,
      toolCallId: "missing",
    },
    {
      type: "effect_cancelled" as const,
      toolCallId: "missing",
    },
  ]) {
    assert.throws(
      () =>
        replaySessionRecords([
          header(),
          {
            type: "commit",
            sequence: 1,
            timestamp: firstCommitAt,
            operations: [operation],
          },
        ]),
      /Pending Tool effect not found: missing/,
    );
  }
});

test("reset preserves pending and cancelled effect audit state", () => {
  const pending = effect("call-pending");
  const cancelled = effect("call-cancelled");
  const resetSystem = identifiedMessage("reset-system", {
    role: "system",
    content: "new system",
    timestamp: 3,
  });

  const snapshot = replaySessionRecords([
    header(),
    {
      type: "commit",
      sequence: 1,
      timestamp: firstCommitAt,
      operations: [
        { type: "effect_started", effect: pending },
        { type: "effect_started", effect: cancelled },
        {
          type: "effect_cancelled",
          toolCallId: cancelled.toolCallId,
        },
        { type: "reset", systemMessage: resetSystem },
      ],
    },
  ]);

  assert.deepEqual(snapshot.messages, [resetSystem]);
  assert.deepEqual(snapshot.pendingEffects, [pending]);
  assert.deepEqual(snapshot.cancelledEffects, [cancelled]);
});
