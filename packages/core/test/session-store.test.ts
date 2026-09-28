import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import {
  JsonlSessionStore,
  MemorySessionStore,
  SessionNotFoundError,
  replaySessionRecords,
  toJsonValue,
} from "../src/session-store.ts";
import type { SessionRecord, SessionStore } from "../src/session.ts";
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

function metadata(id: string) {
  return {
    id,
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
  };
}

async function storeFactories(): Promise<
  Array<{ name: string; store: SessionStore }>
> {
  const root = await mkdtemp(join(tmpdir(), "mini-agent-session-"));
  return [
    { name: "memory", store: new MemorySessionStore() },
    { name: "jsonl", store: new JsonlSessionStore(root) },
  ];
}

test("store implementations share create append load list behavior", async () => {
  for (const { name, store } of await storeFactories()) {
    await store.create(metadata(`session-${name}`));
    await store.append(`session-${name}`, [
      {
        type: "commit",
        sequence: 1,
        timestamp: "2026-09-28T00:00:01.000Z",
        operations: [
          { type: "message", message: systemMessage(`${name}-system`) },
        ],
      },
    ]);
    const loaded = await store.load(`session-${name}`);
    assert.equal(loaded.messages[0]?.id, `${name}-system`);
    assert.equal(loaded.lastSequence, 1);
    assert.deepEqual(
      (await store.list()).map((item) => item.id),
      [`session-${name}`],
    );
  }
});

test("stores isolate sessions and reject missing ids", async () => {
  for (const { store } of await storeFactories()) {
    await store.create(metadata("a"));
    await store.create(metadata("b"));
    await assert.rejects(store.load("missing"), SessionNotFoundError);
    assert.deepEqual(
      (await store.list()).map((item) => item.id).sort(),
      ["a", "b"],
    );
  }
});

test("memory store can fail exactly the next append", async () => {
  const store = new MemorySessionStore();
  await store.create(metadata("failure"));
  store.failNextAppend(new Error("disk full"));
  await assert.rejects(
    store.append("failure", [
      {
        type: "commit",
        sequence: 1,
        timestamp: "2026-09-28T00:00:01.000Z",
        operations: [],
      },
    ]),
    /disk full/,
  );
  await store.append("failure", [
    {
      type: "commit",
      sequence: 1,
      timestamp: "2026-09-28T00:00:02.000Z",
      operations: [],
    },
  ]);
  assert.equal((await store.load("failure")).lastSequence, 1);
});

test("jsonl store ignores only a truncated final line", async () => {
  const root = await mkdtemp(join(tmpdir(), "mini-agent-jsonl-"));
  const store = new JsonlSessionStore(root);
  await store.create(metadata("truncated"));
  await store.append("truncated", [
    {
      type: "commit",
      sequence: 1,
      timestamp: "2026-09-28T00:00:01.000Z",
      operations: [
        { type: "message", message: systemMessage("committed-system") },
      ],
    },
  ]);
  const path = join(root, "sessions", "truncated.jsonl");
  const content = await readFile(path, "utf8");
  await writeFile(
    path,
    `${content}{"type":"commit","sequence":2,"operations":[`,
  );

  const snapshot = await store.load("truncated");
  assert.equal(snapshot.lastSequence, 1);
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.loadDiagnostics[0]?.kind, "truncated_tail");
});

test("stores reject appending to a missing session", async () => {
  for (const { store } of await storeFactories()) {
    await assert.rejects(
      store.append("missing", [
        {
          type: "commit",
          sequence: 1,
          timestamp: "2026-09-28T00:00:01.000Z",
          operations: [],
        },
      ]),
      SessionNotFoundError,
    );
  }
});

test("stores reject duplicate create", async () => {
  for (const { store } of await storeFactories()) {
    await store.create(metadata("duplicate"));
    await assert.rejects(store.create(metadata("duplicate")), /already exists/);
  }
});

test("stores list sessions ordered by updatedAt descending", async () => {
  for (const { store } of await storeFactories()) {
    await store.create(metadata("first"));
    await store.create(metadata("second"));
    // Only the second-created session gets a commit, so its updatedAt is
    // later; updatedAt-descending order must differ from insertion order.
    await store.append("second", [
      {
        type: "commit",
        sequence: 1,
        timestamp: "2026-09-28T00:00:01.000Z",
        operations: [],
      },
    ]);
    assert.deepEqual(
      (await store.list()).map((item) => item.id),
      ["second", "first"],
    );
  }
});

test("cancelled effects are diagnostic but not unknown", () => {
  const snapshot = replaySessionRecords(
    [
      {
        type: "session",
        version: 1,
        metadata: metadata("effects"),
      },
      {
        type: "commit",
        sequence: 1,
        timestamp: "2026-09-28T00:00:01.000Z",
        operations: [
          {
            type: "effect_started",
            effect: {
              toolCallId: "call-cancelled",
              toolName: "write",
              arguments: {},
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
          { type: "effect_cancelled", toolCallId: "call-cancelled" },
        ],
      },
    ],
    [],
  );
  assert.deepEqual(snapshot.pendingEffects, []);
  assert.equal(snapshot.cancelledEffects.length, 1);
  assert.deepEqual(
    snapshot.recoveryWarnings.map((warning) => warning.kind),
    ["cancelled"],
  );
});

test("reset clears queues while cancelled effects stay diagnostic", () => {
  const snapshot = replaySessionRecords(
    [
      {
        type: "session",
        version: 1,
        metadata: metadata("reset-effects"),
      },
      {
        type: "commit",
        sequence: 1,
        timestamp: "2026-09-28T00:00:01.000Z",
        operations: [
          {
            type: "effect_started",
            effect: {
              toolCallId: "call-cancelled",
              toolName: "write",
              arguments: {},
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
          { type: "effect_cancelled", toolCallId: "call-cancelled" },
        ],
      },
      {
        type: "commit",
        sequence: 3,
        timestamp: "2026-09-28T00:00:03.000Z",
        operations: [
          {
            type: "queue_enqueued",
            queue: "steering",
            message: userMessage("queued-reset", "queued"),
          },
        ],
      },
      {
        type: "commit",
        sequence: 4,
        timestamp: "2026-09-28T00:00:04.000Z",
        operations: [{ type: "reset", systemMessage: systemMessage("system-after-reset") }],
      },
    ],
    [],
  );
  assert.deepEqual(
    snapshot.messages.map((message) => message.id),
    ["system-after-reset"],
  );
  assert.deepEqual(snapshot.steeringQueue, []);
  assert.equal(snapshot.cancelledEffects[0]?.toolCallId, "call-cancelled");
  assert.equal(snapshot.recoveryWarnings[0]?.kind, "cancelled");
});
