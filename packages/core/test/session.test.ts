import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionCommitter,
  openOrCreateSession,
} from "../src/session-committer.ts";
import { MemorySessionStore } from "../src/session-store.ts";
import type { AgentEvent } from "../src/types.ts";
import type { SessionCommitter, SessionSnapshot } from "../src/session.ts";
import {
  assistantMessage,
  systemMessage,
  toolResultMessage,
  userMessage,
} from "./helpers.ts";

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

import { Agent } from "../src/agent.ts";
import { createMockStream } from "../src/mock-llm.ts";

test("restored Agent uses snapshot messages and queues without a duplicate system message", async () => {
  const store = new MemorySessionStore();
  const opened = await openOrCreateSession({
    store,
    sessionId: "restored",
    systemMessage: systemMessage(),
  });
  await opened.committer.commitMessages({
    messages: [userMessage("restored-user", "hello")],
  });
  await opened.committer.enqueue(
    "followUp",
    userMessage("restored-follow-up", "later"),
  );
  const snapshot = await store.load("restored");
  const agent = new Agent({
    systemPrompt: "must not be inserted",
    stream: createMockStream({ idGenerator: () => "assistant-restored" }),
    tools: [],
    initialSession: snapshot,
    sessionCommitter: opened.committer,
    idGenerator: (() => {
      let index = 0;
      return () => `agent-id-${++index}`;
    })(),
  });

  assert.deepEqual(agent.state.messages.map((message) => message.id), [
    "system-1",
    "restored-user",
  ]);
  assert.equal(
    agent.queuedMessages.followUp[0]?.id,
    "restored-follow-up",
  );
});

test("durable enqueue becomes visible only after append succeeds", async () => {
  const store = new MemorySessionStore();
  const opened = await openOrCreateSession({
    store,
    sessionId: "enqueue-failure",
    systemMessage: systemMessage(),
  });
  const agent = new Agent({
    systemPrompt: "unused",
    stream: createMockStream(),
    tools: [],
    initialSession: opened.snapshot,
    sessionCommitter: opened.committer,
    idGenerator: () => "queued-fixed",
  });

  store.failNextAppend(new Error("disk full"));
  await assert.rejects(agent.steer("queued"), /disk full/);
  assert.deepEqual(
    agent.queuedMessages.steering.map((message) => message.id),
    [],
  );
  await agent.steer("queued");
  assert.equal(agent.queuedMessages.steering[0]?.id, "queued-fixed");
});

test("durable reset leaves memory unchanged on append failure", async () => {
  const store = new MemorySessionStore();
  const opened = await openOrCreateSession({
    store,
    sessionId: "reset-failure",
    systemMessage: systemMessage(),
  });
  const agent = new Agent({
    systemPrompt: "unused",
    stream: createMockStream(),
    tools: [],
    initialSession: opened.snapshot,
    sessionCommitter: opened.committer,
    idGenerator: () => "new-system",
  });
  store.failNextAppend(new Error("disk full"));
  await assert.rejects(agent.reset(), /disk full/);
  assert.equal(agent.state.messages[0]?.id, "system-1");
});

test("Agent rejects half-configured persistence", () => {
  assert.throws(
    () =>
      new Agent({
        systemPrompt: "test",
        stream: createMockStream(),
        tools: [],
        initialSession: {
          metadata: {
            id: "x",
            createdAt: "",
            updatedAt: "",
          },
          messages: [],
          steeringQueue: [],
          followUpQueue: [],
          pendingEffects: [],
          cancelledEffects: [],
          recoveryWarnings: [],
          loadDiagnostics: [],
          lastSequence: 0,
        },
      }),
    /initialSession and sessionCommitter must be configured together/,
  );
});

test("continue applies the same tail rules after recovery", async () => {
  const createRestored = (messages: SessionSnapshot["messages"]) =>
    new Agent({
      systemPrompt: "unused",
      stream: createMockStream({
        idGenerator: () => "continued-assistant",
      }),
      tools: [],
      initialSession: {
        metadata: {
          id: "continue",
          createdAt: "",
          updatedAt: "",
        },
        messages,
        steeringQueue: [],
        followUpQueue: [],
        pendingEffects: [],
        cancelledEffects: [],
        recoveryWarnings: [],
        loadDiagnostics: [],
        lastSequence: 0,
      },
      sessionCommitter: {
        commitMessages: async () => {},
        enqueue: async () => {},
        startEffect: async () => {},
        finishEffect: async () => {},
        cancelEffect: async () => {},
        reset: async () => {},
      },
      idGenerator: () => "continued-user",
    });

  const userTail = createRestored([
    systemMessage(),
    userMessage("pending-user", "pending"),
  ]);
  await userTail.continue();
  assert.equal(userTail.state.messages.at(-1)?.role, "assistant");

  const toolTail = createRestored([
    systemMessage(),
    toolResultMessage("pending-tool-result"),
  ]);
  await toolTail.continue();
  assert.equal(toolTail.state.messages.at(-1)?.role, "assistant");

  const assistantTail = createRestored([
    systemMessage(),
    assistantMessage("answered-assistant"),
  ]);
  await assert.rejects(
    assistantTail.continue(),
    /Cannot continue from message role: assistant/,
  );

  const empty = createRestored([systemMessage()]);
  await assert.rejects(empty.continue(), /No messages to continue from/);
});

test("failed prompt commit emits no user message events and stores no user message", async () => {
  const store = new MemorySessionStore();
  const opened = await openOrCreateSession({
    store,
    sessionId: "prompt-failure",
    systemMessage: systemMessage(),
  });
  const events: AgentEvent[] = [];
  const agent = new Agent({
    systemPrompt: "unused",
    stream: createMockStream(),
    tools: [],
    initialSession: opened.snapshot,
    sessionCommitter: opened.committer,
    idGenerator: (() => {
      let index = 0;
      return () => `generated-${++index}`;
    })(),
  });
  agent.subscribe((event) => {
    events.push(event);
  });
  store.failNextAppend(new Error("disk full"));

  await agent.prompt("not committed");

  assert.equal(
    agent.state.messages.some(
      (message) =>
        message.role === "user" && message.content === "not committed",
    ),
    false,
  );
  assert.equal(
    events.some(
      (event) =>
        (event.type === "message_start" ||
          event.type === "message_end") &&
        event.message.role === "user" &&
        event.message.content === "not committed",
    ),
    false,
  );
  assert.equal(agent.state.errorMessage, "disk full");
});

test("failed Assistant commit emits no message_end and stores no Assistant", async () => {
  const store = new MemorySessionStore();
  const opened = await openOrCreateSession({
    store,
    sessionId: "assistant-failure",
    systemMessage: systemMessage(),
  });
  const events: AgentEvent[] = [];
  const agent = new Agent({
    systemPrompt: "unused",
    stream: async function* () {
      const message = assistantMessage("assistant-streamed");
      yield { type: "start", message: { ...message, content: [] } };
      store.failNextAppend(new Error("disk full"));
      yield { type: "end", message };
    },
    tools: [],
    initialSession: opened.snapshot,
    sessionCommitter: opened.committer,
    idGenerator: () => "user-prompt",
  });
  agent.subscribe((event) => {
    events.push(event);
  });

  await agent.prompt("hello");

  assert.equal(
    agent.state.messages.some(
      (message) => message.id === "assistant-streamed",
    ),
    false,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === "message_end" &&
        event.message.id === "assistant-streamed",
    ),
    false,
  );
  assert.equal(agent.state.errorMessage, "disk full");
});

test("failed queue dequeue commit keeps the reservation in memory", async () => {
  const store = new MemorySessionStore();
  const opened = await openOrCreateSession({
    store,
    sessionId: "reservation-failure",
    systemMessage: systemMessage(),
  });
  const agent = new Agent({
    systemPrompt: "unused",
    stream: createMockStream(),
    tools: [],
    initialSession: opened.snapshot,
    sessionCommitter: opened.committer,
    idGenerator: (() => {
      let index = 0;
      return () => `reservation-${++index}`;
    })(),
  });
  // Arming point adjusted from the plan sketch: the loop commits queued
  // messages BEFORE it ever calls the model, so arming after steer() would
  // fail the prompt commit instead of the dequeue commit, and arming inside
  // the stream would never fire. The prompt's message_end is the last
  // observable point before the steering dequeue commit runs.
  agent.subscribe((event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "user" &&
      event.message.content === "prompt"
    ) {
      store.failNextAppend(new Error("disk full"));
    }
  });
  await agent.steer("keep me");
  await agent.prompt("prompt");
  assert.equal(agent.queuedMessages.steering[0]?.content, "keep me");
  assert.equal(agent.state.errorMessage, "disk full");
});

test("double persistence failure emits no terminal message events but still settles the run", async () => {
  const store = new MemorySessionStore();
  const opened = await openOrCreateSession({
    store,
    sessionId: "double-failure",
    systemMessage: systemMessage(),
  });
  // MemorySessionStore.failNextAppend arms exactly ONE failed append, and no
  // event fires between the two failures we need: the prompt commit fails
  // before any message event, and the terminal failure message only emits
  // after its own commit succeeds. So wrap the committer and re-arm the store
  // from the second commitMessages call (the emitFailure terminal commit).
  const inner = opened.committer;
  let commitCalls = 0;
  const committer: SessionCommitter = {
    ...inner,
    commitMessages: (commit) => {
      commitCalls += 1;
      if (commitCalls === 2) {
        store.failNextAppend(new Error("disk still full"));
      }
      return inner.commitMessages(commit);
    },
  };
  const events: AgentEvent[] = [];
  const agent = new Agent({
    systemPrompt: "unused",
    stream: createMockStream(),
    tools: [],
    initialSession: opened.snapshot,
    sessionCommitter: committer,
    idGenerator: () => "double-failure-user",
  });
  agent.subscribe((event) => {
    events.push(event);
  });
  store.failNextAppend(new Error("disk full"));

  await agent.prompt("not committed");
  await agent.waitForIdle();

  // The terminal failure message never emits: its persistence failed, so the
  // non-recursive branch records only errorMessage and a bare agent_end.
  const terminalMessageEvents = events.filter(
    (event) =>
      (event.type === "message_start" || event.type === "message_end") &&
      event.message.role === "assistant",
  );
  assert.deepEqual(terminalMessageEvents, []);
  assert.equal(events.some((event) => event.type === "agent_end"), true);
  assert.equal(agent.state.errorMessage, "disk full");
});

test("Session APIs are exported from the package entrypoint", async () => {
  const core = await import("../src/index.ts");
  assert.equal(typeof core.MemorySessionStore, "function");
  assert.equal(typeof core.JsonlSessionStore, "function");
  assert.equal(typeof core.SessionNotFoundError, "function");
  assert.equal(typeof core.openOrCreateSession, "function");
  assert.equal(typeof core.toJsonValue, "function");
});
