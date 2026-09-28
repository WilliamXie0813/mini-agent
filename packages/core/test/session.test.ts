import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionCommitter,
  openOrCreateSession,
} from "../src/session-committer.ts";
import { MemorySessionStore } from "../src/session-store.ts";
import { systemMessage, userMessage } from "./helpers.ts";

test("openOrCreate creates header and initial system message once", async () => {
  const store = new MemorySessionStore();
  const first = await openOrCreateSession({
    store,
    sessionId: "session-a",
    systemMessage: systemMessage(),
    now: () => new Date("2026-09-28T00:00:00.000Z"),
  });
  assert.deepEqual(
    first.snapshot.messages.map((message) => message.id),
    ["system-1"],
  );
  assert.equal(first.snapshot.lastSequence, 1);

  const reopened = await openOrCreateSession({
    store,
    sessionId: "session-a",
    systemMessage: systemMessage("duplicate-system"),
  });
  assert.deepEqual(
    reopened.snapshot.messages.map((message) => message.id),
    ["system-1"],
  );
});

test("committer serializes concurrent operations with monotonic sequences", async () => {
  const store = new MemorySessionStore();
  await store.create({
    id: "serialized",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
  });
  const committer = createSessionCommitter({
    store,
    sessionId: "serialized",
    initialSequence: 0,
    now: () => new Date("2026-09-28T00:00:01.000Z"),
  });
  await Promise.all([
    committer.enqueue("steering", userMessage("queued-a", "a")),
    committer.enqueue("followUp", userMessage("queued-b", "b")),
  ]);
  const snapshot = await store.load("serialized");
  assert.equal(snapshot.lastSequence, 2);
  assert.equal(snapshot.steeringQueue[0]?.id, "queued-a");
  assert.equal(snapshot.followUpQueue[0]?.id, "queued-b");
});

test("message commit atomically combines dequeue and message", async () => {
  const store = new MemorySessionStore();
  const opened = await openOrCreateSession({
    store,
    sessionId: "atomic",
    systemMessage: systemMessage(),
  });
  const queued = userMessage("queued-1", "queued");
  await opened.committer.enqueue("steering", queued);
  await opened.committer.commitMessages({
    dequeued: [{ queue: "steering", message: queued }],
    messages: [queued],
  });
  const snapshot = await store.load("atomic");
  assert.deepEqual(snapshot.steeringQueue, []);
  assert.equal(snapshot.messages.at(-1)?.id, "queued-1");
});

test("failed append leaves no sequence hole and does not poison the tail", async () => {
  const store = new MemorySessionStore();
  const opened = await openOrCreateSession({
    store,
    sessionId: "resilient",
    systemMessage: systemMessage(),
  });
  assert.equal(opened.snapshot.lastSequence, 1);

  store.failNextAppend(new Error("disk full"));
  await assert.rejects(
    opened.committer.enqueue("steering", userMessage("lost", "lost")),
    /disk full/,
  );

  await opened.committer.enqueue("steering", userMessage("retried", "retried"));
  const afterRetry = await store.load("resilient");
  assert.equal(afterRetry.lastSequence, 2);
  assert.deepEqual(
    afterRetry.steeringQueue.map((message) => message.id),
    ["retried"],
  );

  await opened.committer.enqueue("followUp", userMessage("next", "next"));
  const afterNext = await store.load("resilient");
  assert.equal(afterNext.lastSequence, 3);
  assert.equal(afterNext.followUpQueue[0]?.id, "next");
});

test("openOrCreate heals a header-only session left by interrupted creation", async () => {
  const store = new MemorySessionStore();
  await store.create({
    id: "interrupted",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
  });

  const healed = await openOrCreateSession({
    store,
    sessionId: "interrupted",
    systemMessage: systemMessage(),
  });
  assert.deepEqual(
    healed.snapshot.messages.map((message) => message.id),
    ["system-1"],
  );
  assert.equal(healed.snapshot.lastSequence, 1);

  const reopened = await openOrCreateSession({
    store,
    sessionId: "interrupted",
    systemMessage: systemMessage("duplicate-system"),
  });
  assert.deepEqual(
    reopened.snapshot.messages.map((message) => message.id),
    ["system-1"],
  );
  assert.equal(reopened.snapshot.lastSequence, 1);
});
