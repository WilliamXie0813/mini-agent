# Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add append-only Session persistence and crash recovery so the server can reopen independent Sessions with committed transcripts, durable queues, and explicit diagnostics for unfinished tool effects.

**Architecture:** `@mini-agent/core` owns the Session data model, replay logic, interchangeable memory/JSONL stores, and a serialized `SessionCommitter`; Agent and Loop code use that committer only at stable state boundaries. `@mini-agent/server` owns Session selection, safe IDs, per-session Agent caching, WebSocket binding, and protocol responses, while the existing web client remains bound to the automatically opened `default` Session.

**Tech Stack:** TypeScript 5.9, Node.js 22 (`node:fs/promises`, `crypto.randomUUID`, built-in test runner), JSONL, WebSocket (`ws`), pnpm workspaces, zero new runtime dependencies.

---

## Required design clarifications

The specification needs two minimal fields for an implementable recovery contract:

1. `SessionSnapshot.lastSequence: number` is required to initialize a restarted `SessionCommitter`; message/effect counts cannot reconstruct the unified Commit Envelope sequence.
2. `SessionSnapshot.loadDiagnostics: SessionLoadDiagnostic[]` is required to retain the specified “truncated final line was ignored” diagnostic without misclassifying it as an effect recovery warning.

These fields are bookkeeping only. They do not change Transcript, queue, warning, or protocol semantics.

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/types.ts` | Required message IDs, `IdGenerator`, tool replay metadata, recovery event, reservation-aware Loop config |
| `packages/core/src/session.ts` | Session records, JSON value validation, snapshots, diagnostics, store/committer contracts |
| `packages/core/src/session-store.ts` | Record replay, `MemorySessionStore`, `JsonlSessionStore`, not-found error |
| `packages/core/src/session-committer.ts` | Serialized commits and `openOrCreateSession()` |
| `packages/core/src/agent.ts` | ID generation, restored state/queues, durable enqueue/reset, failure persistence |
| `packages/core/src/agent-loop.ts` | Persist-before-finalize message ordering and queue reservation acknowledgement |
| `packages/core/src/tool-execution.ts` | Durable effect start/cancel boundaries and Tool Result IDs |
| `packages/core/src/mock-llm.ts` | Stable Assistant IDs across one stream |
| `packages/core/src/index.ts` | Public Session API |
| `packages/core/test/helpers.ts` | Deterministic IDs and message factories used by core tests |
| `packages/core/test/session-store.test.ts` | Shared store contract, replay, truncation, sequence, reset, effect warnings |
| `packages/core/test/session.test.ts` | Committer/open/recovery and Agent persistence integration |
| `packages/core/test/*.test.ts` | Message-ID migration and existing behavior regressions |
| `packages/server/src/protocol.ts` | Session commands, responses, rich parse result |
| `packages/server/src/session-manager.ts` | Store ownership, open de-duplication, active AgentSession cache |
| `packages/server/src/session.ts` | Per-session broadcasting and connection-to-session binding |
| `packages/server/src/server.ts` | Data directory setup and multi-session WebSocket server |
| `packages/server/src/index.ts` | Public server exports |
| `packages/server/test/protocol.test.ts` | Protocol parsing and session response encoding |
| `packages/server/test/session.test.ts` | Reconnect, warning order, isolation, in-flight open, default compatibility |
| `packages/web/test/*.ts(x)` | Required `id` fields in message fixtures only |

Do not add a Session UI, SQLite, multi-process file locking, Session branching, automatic tool replay, or user/permission isolation.

### Task 1: Add stable message identities and deterministic test factories

**Files:**
- Modify: `packages/core/src/types.ts:14-105`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/mock-llm.ts`
- Modify: `packages/core/src/tool-execution.ts`
- Create: `packages/core/test/helpers.ts`
- Modify: all `packages/core/test/*.test.ts` files containing message literals
- Modify: `packages/web/test/client.test.ts`
- Modify: `packages/web/test/reducer.test.ts`
- Modify: `packages/web/test/inspector.test.tsx`
- Modify: `packages/web/test/chat-panel.test.tsx`

- [ ] **Step 1: Add a deterministic message helper used by new tests**

Create `packages/core/test/helpers.ts`:

```ts
import type {
  AssistantMessage,
  IdGenerator,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from "../src/types.ts";

export function createIdGenerator(prefix = "id"): IdGenerator {
  let next = 1;
  return () => `${prefix}-${next++}`;
}

export function systemMessage(
  id = "system-1",
  content = "system",
  timestamp = 1,
): SystemMessage {
  return { id, role: "system", content, timestamp };
}

export function userMessage(
  id = "user-1",
  content = "hello",
  timestamp = 2,
): UserMessage {
  return { id, role: "user", content, timestamp };
}

export function assistantMessage(
  id = "assistant-1",
  text = "done",
  timestamp = 3,
): AssistantMessage {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp,
  };
}

export function toolResultMessage(
  id = "tool-result-1",
  timestamp = 4,
): ToolResultMessage {
  return {
    id,
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: "{}",
    isError: false,
    timestamp,
  };
}
```

- [ ] **Step 2: Write failing ID propagation tests**

Add to `packages/core/test/mock-llm.test.ts`:

```ts
test("one mock stream uses one Assistant message id", async () => {
  const ids = ["assistant-fixed"];
  const events = await collect(
    [{ id: "user-1", role: "user", content: "hello", timestamp: 1 }],
    new AbortController().signal,
    { idGenerator: () => ids[0]! },
  );

  assert.deepEqual(
    [...new Set(events.map((event) => event.message.id))],
    ["assistant-fixed"],
  );
});
```

Update the local `collect` helper to accept the options:

```ts
async function collect(
  messages: AgentMessage[],
  signal = new AbortController().signal,
  options: Parameters<typeof createMockStream>[0] = {},
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of createMockStream(options)(messages, signal)) {
    events.push(event);
  }
  return events;
}
```

Add to `packages/core/test/tool-execution.test.ts`:

```ts
test("tool results use the injected id generator", async () => {
  const batch = await executeToolCallBatch(
    [toolCall("a")],
    options({
      tools: [createTool("a", async () => ({ content: "ok" }))],
      idGenerator: () => "tool-result-fixed",
    }),
  );
  assert.equal(batch.messages[0]?.id, "tool-result-fixed");
});
```

Extend the `options` test helper override type and returned object:

```ts
  idGenerator?: () => string;
```

```ts
    idGenerator: overrides.idGenerator ?? (() => "tool-result-default"),
```

- [ ] **Step 3: Run check to verify required IDs are missing**

Run:

```bash
pnpm --filter @mini-agent/core run check
```

Expected: FAIL because message interfaces and factories do not expose `id`/`idGenerator`.

- [ ] **Step 4: Add IDs and replay metadata to public types**

In `packages/core/src/types.ts`, add:

```ts
export type IdGenerator = () => string;
export type ReplayPolicy = "safe" | "never";
```

Add `id: string` to `SystemMessage`, `UserMessage`, `AssistantMessage`, and `ToolResultMessage`.

Add to `Tool<TParameters>`:

```ts
  /** Recovery metadata only; this runtime never automatically replays tools. */
  replay?: ReplayPolicy;
```

Add `idGenerator: IdGenerator` to `ToolExecutionBatchOptions` in `tool-execution.ts`, and change `toMessage` to:

```ts
function toMessage(
  completed: CompletedToolCall,
  idGenerator: IdGenerator,
): ToolResultMessage {
  return {
    id: idGenerator(),
    role: "toolResult",
    toolCallId: completed.toolCall.id,
    toolName: completed.toolCall.name,
    content: completed.result.content,
    details: completed.result.details,
    isError: completed.result.isError === true,
    timestamp: Date.now(),
  };
}
```

Change the batch return to:

```ts
  return {
    messages: completed.map((item) => toMessage(item, options.idGenerator)),
  };
```

- [ ] **Step 5: Inject IDs at each production construction point**

In `agent.ts`, import `randomUUID` and add `idGenerator?: IdGenerator` to `AgentOptions`. Store:

```ts
private readonly idGenerator: IdGenerator;
```

Initialize it before state construction:

```ts
this.idGenerator = options.idGenerator ?? randomUUID;
```

Add IDs to System, User, and failure messages:

```ts
{
  id: this.idGenerator(),
  role: "system",
  content: options.systemPrompt,
  timestamp: Date.now(),
}
```

```ts
return {
  id: this.idGenerator(),
  role: "user",
  content,
  timestamp: Date.now(),
};
```

```ts
const message = {
  id: this.idGenerator(),
  role: "assistant" as const,
  // existing fields unchanged
};
```

Pass `idGenerator: this.idGenerator` through `AgentLoopConfig` and into `executeToolCallBatch`.

In `mock-llm.ts`, extend options:

```ts
export function createMockStream(
  options: {
    delayMs?: number;
    idGenerator?: IdGenerator;
  } = {},
): StreamFn {
  const delayMs = options.delayMs ?? 0;
  const idGenerator = options.idGenerator ?? randomUUID;
```

Change `streamText` to receive an `id` and initialize the message with it. At the start of each `mockStream` invocation call `const messageId = idGenerator()` and pass that same value to every text/tool Assistant snapshot.

- [ ] **Step 6: Migrate test fixtures mechanically but explicitly**

For every message literal reported by:

```bash
rg -n 'role: "(system|user|assistant|toolResult)"' packages/core/test packages/web/test
```

add a stable literal ID matching its role and local purpose, for example:

```ts
{ id: "user-original", role: "user", content: "original", timestamp: 2 }
```

```ts
const assistantMessage: AssistantMessage = {
  id: "assistant-1",
  role: "assistant",
  // existing fields unchanged
};
```

Use distinct IDs inside each test when two messages coexist. Update Agent constructions in tests to inject `createIdGenerator()` when assertions depend on exact identity. Do not generate IDs with `Date.now()` in tests.

- [ ] **Step 7: Run repository type checks and focused tests**

Run:

```bash
pnpm --filter @mini-agent/core run check
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/web run check
pnpm --filter @mini-agent/web run test
```

Expected: PASS; existing runtime behavior is unchanged and every message now has a stable ID.

- [ ] **Step 8: Commit**

```bash
git add packages/core packages/web/test
git commit -m "feat(core): add stable message identities"
```

### Task 2: Define Session records, replay state, and JSON validation

**Files:**
- Create: `packages/core/src/session.ts`
- Create: `packages/core/test/session-store.test.ts`

- [ ] **Step 1: Write failing pure replay and JSON tests**

Create `packages/core/test/session-store.test.ts` with:

```ts
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
```

- [ ] **Step 2: Run the test to verify missing modules**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/session-store.test.ts
```

Expected: FAIL with missing `session.ts` and `session-store.ts`.

- [ ] **Step 3: Add the complete Session domain contracts**

Create `packages/core/src/session.ts`:

```ts
import type {
  AgentMessage,
  SystemMessage,
} from "./types.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type QueueName = "steering" | "followUp";

export interface PendingEffect {
  toolCallId: string;
  toolName: string;
  arguments: JsonValue;
  replay: "safe" | "never";
}

export interface SessionMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type SessionOperation =
  | { type: "message"; message: AgentMessage }
  | { type: "queue_enqueued"; queue: QueueName; message: AgentMessage }
  | { type: "queue_dequeued"; queue: QueueName; messageId: string }
  | { type: "effect_started"; effect: PendingEffect }
  | { type: "effect_finished"; toolCallId: string }
  | { type: "effect_cancelled"; toolCallId: string }
  | { type: "reset"; systemMessage: SystemMessage };

export type SessionRecord =
  | { type: "session"; version: 1; metadata: SessionMetadata }
  | {
      type: "commit";
      sequence: number;
      timestamp: string;
      operations: SessionOperation[];
    };

export interface SessionRecoveryWarning {
  kind: "unknown" | "cancelled";
  effect: PendingEffect;
  message: string;
}

export interface SessionLoadDiagnostic {
  kind: "truncated_tail";
  message: string;
}

export interface SessionSnapshot {
  metadata: SessionMetadata;
  messages: AgentMessage[];
  steeringQueue: AgentMessage[];
  followUpQueue: AgentMessage[];
  pendingEffects: PendingEffect[];
  cancelledEffects: PendingEffect[];
  recoveryWarnings: SessionRecoveryWarning[];
  loadDiagnostics: SessionLoadDiagnostic[];
  lastSequence: number;
}

export interface SessionStore {
  create(metadata: SessionMetadata): Promise<void>;
  load(sessionId: string): Promise<SessionSnapshot>;
  append(
    sessionId: string,
    records: readonly SessionRecord[],
  ): Promise<void>;
  list(): Promise<SessionMetadata[]>;
}

export interface QueuedMessageReservation {
  queue: QueueName;
  message: AgentMessage;
}

export interface MessageCommit {
  messages: readonly AgentMessage[];
  dequeued?: readonly QueuedMessageReservation[];
}

export interface SessionCommitter {
  commitMessages(commit: MessageCommit): Promise<void>;
  enqueue(queue: QueueName, message: AgentMessage): Promise<void>;
  startEffect(effect: PendingEffect): Promise<void>;
  finishEffect(toolCallId: string): Promise<void>;
  cancelEffect(toolCallId: string): Promise<void>;
  reset(systemMessage: SystemMessage): Promise<void>;
}

export interface OpenedSession {
  snapshot: SessionSnapshot;
  committer: SessionCommitter;
}
```

- [ ] **Step 4: Implement JSON conversion and record replay**

Create `packages/core/src/session-store.ts` initially with the pure helpers:

```ts
import type {
  JsonValue,
  PendingEffect,
  QueueName,
  SessionLoadDiagnostic,
  SessionRecord,
  SessionRecoveryWarning,
  SessionSnapshot,
} from "./session.ts";
import type { AgentMessage } from "./types.ts";

export function toJsonValue(value: unknown): JsonValue {
  const visiting = new Set<object>();
  const visit = (candidate: unknown): JsonValue => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return candidate;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw new Error("Tool arguments are not JSON serializable");
    }
    if (visiting.has(candidate)) {
      throw new Error("Tool arguments contain a circular reference");
    }
    visiting.add(candidate);
    try {
      if (Array.isArray(candidate)) return candidate.map(visit);
      const result: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(candidate)) {
        result[key] = visit(item);
      }
      return result;
    } finally {
      visiting.delete(candidate);
    }
  };
  return visit(value);
}

function warning(
  kind: SessionRecoveryWarning["kind"],
  effect: PendingEffect,
): SessionRecoveryWarning {
  return {
    kind,
    effect,
    message:
      kind === "unknown"
        ? `Tool outcome is unknown: ${effect.toolName} (${effect.toolCallId})`
        : `Tool execution was cancelled: ${effect.toolName} (${effect.toolCallId})`,
  };
}

export function replaySessionRecords(
  records: readonly SessionRecord[],
  loadDiagnostics: SessionLoadDiagnostic[],
): SessionSnapshot {
  const header = records[0];
  if (!header || header.type !== "session" || header.version !== 1) {
    throw new Error("Session file must begin with a version 1 header");
  }

  let messages: AgentMessage[] = [];
  const queues: Record<QueueName, AgentMessage[]> = {
    steering: [],
    followUp: [],
  };
  const pending = new Map<string, PendingEffect>();
  const cancelled = new Map<string, PendingEffect>();
  let expectedSequence = 1;
  let updatedAt = header.metadata.createdAt;

  for (const record of records.slice(1)) {
    if (record.type !== "commit") {
      throw new Error("Session header may only appear once");
    }
    if (record.sequence !== expectedSequence) {
      throw new Error(
        `Expected sequence ${expectedSequence} but received ${record.sequence}`,
      );
    }
    expectedSequence += 1;
    updatedAt = record.timestamp;

    for (const operation of record.operations) {
      switch (operation.type) {
        case "message":
          messages.push(operation.message);
          break;
        case "queue_enqueued":
          queues[operation.queue].push(operation.message);
          break;
        case "queue_dequeued": {
          const queue = queues[operation.queue];
          const index = queue.findIndex(
            (message) => message.id === operation.messageId,
          );
          if (index < 0) {
            throw new Error(
              `Commit references missing queued message: ${operation.messageId}`,
            );
          }
          queue.splice(index, 1);
          break;
        }
        case "effect_started":
          pending.set(operation.effect.toolCallId, operation.effect);
          break;
        case "effect_finished":
          pending.delete(operation.toolCallId);
          break;
        case "effect_cancelled": {
          const effect = pending.get(operation.toolCallId);
          if (!effect) {
            throw new Error(
              `Cancelled effect was not started: ${operation.toolCallId}`,
            );
          }
          pending.delete(operation.toolCallId);
          cancelled.set(operation.toolCallId, effect);
          break;
        }
        case "reset":
          messages = [operation.systemMessage];
          queues.steering = [];
          queues.followUp = [];
          break;
      }
    }
  }

  const pendingEffects = [...pending.values()];
  const cancelledEffects = [...cancelled.values()];
  return {
    metadata: { ...header.metadata, updatedAt },
    messages,
    steeringQueue: queues.steering,
    followUpQueue: queues.followUp,
    pendingEffects,
    cancelledEffects,
    recoveryWarnings: [
      ...pendingEffects.map((effect) => warning("unknown", effect)),
      ...cancelledEffects.map((effect) => warning("cancelled", effect)),
    ],
    loadDiagnostics,
    lastSequence: expectedSequence - 1,
  };
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/session-store.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: pure replay and JSON tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/session.ts packages/core/src/session-store.ts packages/core/test/session-store.test.ts
git commit -m "feat(core): define session records and replay"
```

### Task 3: Implement interchangeable Memory and JSONL stores

**Files:**
- Modify: `packages/core/src/session-store.ts`
- Modify: `packages/core/test/session-store.test.ts`

- [ ] **Step 1: Add a shared store contract**

Append to `packages/core/test/session-store.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import {
  JsonlSessionStore,
  MemorySessionStore,
  SessionNotFoundError,
} from "../src/session-store.ts";
import type { SessionStore } from "../src/session.ts";

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
```

- [ ] **Step 2: Run focused tests to verify missing implementations**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/session-store.test.ts
```

Expected: FAIL because both store classes and `SessionNotFoundError` are missing.

- [ ] **Step 3: Implement MemorySessionStore**

Append to `session-store.ts`:

```ts
import type { SessionMetadata, SessionStore } from "./session.ts";

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord[]>();
  private nextAppendFailure?: Error;

  failNextAppend(error = new Error("Session append failed")): void {
    this.nextAppendFailure = error;
  }

  async create(metadata: SessionMetadata): Promise<void> {
    if (this.sessions.has(metadata.id)) {
      throw new Error(`Session already exists: ${metadata.id}`);
    }
    this.sessions.set(metadata.id, [
      { type: "session", version: 1, metadata: { ...metadata } },
    ]);
  }

  async load(sessionId: string): Promise<SessionSnapshot> {
    const records = this.sessions.get(sessionId);
    if (!records) throw new SessionNotFoundError(sessionId);
    return replaySessionRecords(structuredClone(records), []);
  }

  async append(
    sessionId: string,
    records: readonly SessionRecord[],
  ): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (!existing) throw new SessionNotFoundError(sessionId);
    if (this.nextAppendFailure) {
      const failure = this.nextAppendFailure;
      this.nextAppendFailure = undefined;
      throw failure;
    }
    existing.push(...structuredClone(records));
  }

  async list(): Promise<SessionMetadata[]> {
    const metadata = await Promise.all(
      [...this.sessions.keys()].map(async (id) => (await this.load(id)).metadata),
    );
    return metadata.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }
}
```

- [ ] **Step 4: Implement JsonlSessionStore**

Append imports:

```ts
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
```

Append:

```ts
/**
 * 基于 JSONL 文件的 SessionStore：每个 session 一个 `<dataDir>/sessions/<id>.jsonl` 文件。
 *
 * 语义与约束：
 * - 只增不改（append-only）：header 记录创建时写入，之后只追加 commit；
 * - 不做 fsync：进程崩溃最多丢失末尾未刷盘的 commit，但 OS 崩溃可能丢失
 *   已被 append 确认的记录；
 * - 容忍损坏：仅文件最后一行允许是被截断的残行（记为 truncated_tail 诊断），
 *   中间行损坏视为文件损坏，直接抛错；
 * - sessionId 必须由调用方校验（路径穿越防护在 server 协议层，不在这一层）。
 */
export class JsonlSessionStore implements SessionStore {
  private readonly sessionsDir: string;

  constructor(dataDir: string) {
    if (!isAbsolute(dataDir)) {
      throw new Error("JsonlSessionStore dataDir must be absolute");
    }
    this.sessionsDir = join(dataDir, "sessions");
  }

  private path(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  async create(metadata: SessionMetadata): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    const header: SessionRecord = {
      type: "session",
      version: 1,
      metadata,
    };
    await writeFile(this.path(metadata.id), `${JSON.stringify(header)}\n`, {
      flag: "wx",
    }).catch((error: unknown) => {
      if (errorCode(error) === "EEXIST") {
        throw new Error(`Session already exists: ${metadata.id}`);
      }
      throw error;
    });
  }

  async load(sessionId: string): Promise<SessionSnapshot> {
    let content: string;
    try {
      content = await readFile(this.path(sessionId), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }

    const diagnostics: SessionLoadDiagnostic[] = [];
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const records: SessionRecord[] = [];
    for (const [index, line] of lines.entries()) {
      try {
        records.push(JSON.parse(line) as SessionRecord);
      } catch (error) {
        if (index === lines.length - 1 && !content.endsWith("\n")) {
          diagnostics.push({
            kind: "truncated_tail",
            message: `Ignored truncated final line for session ${sessionId}`,
          });
          break;
        }
        throw new Error(
          `Invalid JSONL at ${sessionId}:${index + 1}`,
          { cause: error },
        );
      }
    }
    return replaySessionRecords(records, diagnostics);
  }

  async append(
    sessionId: string,
    records: readonly SessionRecord[],
  ): Promise<void> {
    if (records.length === 0) return;
    try {
      await stat(this.path(sessionId));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }
    try {
      await appendFile(
        this.path(sessionId),
        records.map((record) => `${JSON.stringify(record)}\n`).join(""),
        "utf8",
      );
    } catch (error) {
      // The session may have been removed between stat and appendFile.
      if (errorCode(error) === "ENOENT") {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }
  }

  async list(): Promise<SessionMetadata[]> {
    try {
      const names = await readdir(this.sessionsDir);
      const snapshots = await Promise.all(
        names
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => this.load(name.slice(0, -".jsonl".length))),
      );
      return snapshots
        .map((snapshot) => snapshot.metadata)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}
```

- [ ] **Step 5: Run the shared contract and type-check**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/session-store.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: both stores pass the same contract; only malformed final partial JSON is ignored.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/session-store.ts packages/core/test/session-store.test.ts
git commit -m "feat(core): add memory and jsonl session stores"
```

### Task 4: Add serialized commits and open-or-create recovery

**Files:**
- Create: `packages/core/src/session-committer.ts`
- Create: `packages/core/test/session.test.ts`

- [ ] **Step 1: Write committer and open/create tests**

Create `packages/core/test/session.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionCommitter,
  openOrCreateSession,
} from "../src/session-committer.ts";
import { MemorySessionStore } from "../src/session-store.ts";
import {
  systemMessage,
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
  assert.deepEqual(first.snapshot.messages.map((message) => message.id), [
    "system-1",
  ]);
  assert.equal(first.snapshot.lastSequence, 1);

  const reopened = await openOrCreateSession({
    store,
    sessionId: "session-a",
    systemMessage: systemMessage("duplicate-system"),
  });
  assert.deepEqual(reopened.snapshot.messages.map((message) => message.id), [
    "system-1",
  ]);
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
```

The failure-injection test pins the serialization chain's resilience contract: a rejected append must (a) propagate to the caller, (b) leave no sequence hole (the retried commit reuses the failed call's sequence number, because `sequence` is only advanced after a successful `store.append`), and (c) not poison the tail for later commits.

- [ ] **Step 2: Run focused tests to verify missing module**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/session.test.ts
```

Expected: FAIL because `session-committer.ts` is missing.

- [ ] **Step 3: Implement the serialized committer**

Create `packages/core/src/session-committer.ts`:

```ts
import type {
  MessageCommit,
  OpenedSession,
  PendingEffect,
  QueueName,
  SessionCommitter,
  SessionOperation,
  SessionStore,
} from "./session.ts";
import { SessionNotFoundError } from "./session-store.ts";
import type { SystemMessage } from "./types.ts";

export function createSessionCommitter(options: {
  store: SessionStore;
  sessionId: string;
  initialSequence: number;
  now?: () => Date;
}): SessionCommitter {
  const now = options.now ?? (() => new Date());
  let sequence = options.initialSequence;
  let tail = Promise.resolve();

  const append = (operations: SessionOperation[]): Promise<void> => {
    const operation = async () => {
      const nextSequence = sequence + 1;
      await options.store.append(options.sessionId, [
        {
          type: "commit",
          sequence: nextSequence,
          timestamp: now().toISOString(),
          operations,
        },
      ]);
      sequence = nextSequence;
    };
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    commitMessages(commit: MessageCommit) {
      return append([
        ...(commit.dequeued ?? []).map(
          ({ queue, message }): SessionOperation => ({
            type: "queue_dequeued",
            queue,
            messageId: message.id,
          }),
        ),
        ...commit.messages.map(
          (message): SessionOperation => ({ type: "message", message }),
        ),
      ]);
    },
    enqueue(queue: QueueName, message) {
      return append([{ type: "queue_enqueued", queue, message }]);
    },
    startEffect(effect: PendingEffect) {
      return append([{ type: "effect_started", effect }]);
    },
    finishEffect(toolCallId: string) {
      return append([{ type: "effect_finished", toolCallId }]);
    },
    cancelEffect(toolCallId: string) {
      return append([{ type: "effect_cancelled", toolCallId }]);
    },
    reset(systemMessage: SystemMessage) {
      return append([{ type: "reset", systemMessage }]);
    },
  };
}

export async function openOrCreateSession(options: {
  store: SessionStore;
  sessionId: string;
  systemMessage: SystemMessage;
  now?: () => Date;
}): Promise<OpenedSession> {
  try {
    const snapshot = await options.store.load(options.sessionId);
    const committer = createSessionCommitter({
      store: options.store,
      sessionId: options.sessionId,
      initialSequence: snapshot.lastSequence,
      now: options.now,
    });
    if (snapshot.lastSequence === 0) {
      // The header exists but the initial system message commit never
      // landed (crash or rejected append during creation). Re-attempt it
      // rather than returning a session with no system message.
      await committer.commitMessages({ messages: [options.systemMessage] });
      return { snapshot: await options.store.load(options.sessionId), committer };
    }
    return { snapshot, committer };
  } catch (error) {
    if (!(error instanceof SessionNotFoundError)) throw error;
  }

  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  await options.store.create({
    id: options.sessionId,
    createdAt,
    updatedAt: createdAt,
  });
  const committer = createSessionCommitter({
    store: options.store,
    sessionId: options.sessionId,
    initialSequence: 0,
    now,
  });
  await committer.commitMessages({ messages: [options.systemMessage] });
  return {
    snapshot: await options.store.load(options.sessionId),
    committer,
  };
}
```

- [ ] **Step 4: Run focused tests and core check**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/session.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: PASS; reopen does not duplicate the System Message and concurrent calls receive distinct sequences. A failed append must not leave a sequence hole or poison the serialization tail, and a header-only session (interrupted creation, `lastSequence === 0`) must be healed by re-attempting the initial system message commit on open.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session-committer.ts packages/core/test/session.test.ts
git commit -m "feat(core): add serialized session commits"
```

### Task 5: Restore Agent state and make queues/reset durable

**Files:**
- Modify: `packages/core/src/types.ts:170-330`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/test/session.test.ts`
- Modify: `packages/core/test/queues.test.ts`
- Modify: server callers of `steer`, `followUp`, and `reset`

- [ ] **Step 1: Add restored Agent and queue rollback tests**

Add the type imports, and replace the existing helper import in `packages/core/test/session.test.ts` with:

```ts
import type { AgentEvent } from "../src/types.ts";
import type { SessionSnapshot } from "../src/session.ts";
import {
  assistantMessage,
  systemMessage,
  toolResultMessage,
  userMessage,
} from "./helpers.ts";
```

Append to `packages/core/test/session.test.ts`:

```ts
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
  assert.deepEqual(agent.queuedMessages.steering, []);
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
```

- [ ] **Step 2: Run focused tests to verify missing Agent options**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/session.test.ts
```

Expected: FAIL because Agent persistence options and async queue/reset methods are missing.

- [ ] **Step 3: Add reservation-aware queue contracts**

In `types.ts`, import:

```ts
import type {
  QueuedMessageReservation,
  SessionCommitter,
  SessionRecoveryWarning,
} from "./session.ts";
```

Add the observation-only event:

```ts
  | {
      type: "session_recovery_warning";
      warnings: readonly SessionRecoveryWarning[];
    }
```

Replace Loop queue methods with:

```ts
  reserveSteeringMessages(): QueuedMessageReservation[];
  reserveFollowUpMessages(): QueuedMessageReservation[];
  acknowledgeReservations(
    reservations: readonly QueuedMessageReservation[],
  ): void;
  hasSteeringMessages(): boolean;
  hasFollowUpMessages(): boolean;
  sessionCommitter?: SessionCommitter;
  idGenerator: IdGenerator;
```

- [ ] **Step 4: Replace MessageQueue drain with reservation/acknowledgement**

In `agent.ts`, replace `drainOne` with:

```ts
reserveOne(queue: QueueName): QueuedMessageReservation[] {
  const first = this.messages[0];
  return first ? [{ queue, message: first }] : [];
}

acknowledge(messageId: string): void {
  if (this.messages[0]?.id !== messageId) {
    throw new Error(`Queue reservation is no longer at the head: ${messageId}`);
  }
  this.messages.shift();
}
```

Add `restore(messages)`:

```ts
restore(messages: readonly AgentMessage[]): void {
  this.messages = messages.slice();
}
```

- [ ] **Step 5: Add Agent persistence options and restored initialization**

Add to `AgentOptions`:

```ts
initialSession?: SessionSnapshot;
sessionCommitter?: SessionCommitter;
idGenerator?: IdGenerator;
```

Validate in the constructor:

```ts
if (Boolean(options.initialSession) !== Boolean(options.sessionCommitter)) {
  throw new Error(
    "initialSession and sessionCommitter must be configured together",
  );
}
```

Store `sessionCommitter`, initialize queues from the Snapshot, and initialize messages as:

```ts
const messages = options.initialSession
  ? options.initialSession.messages.slice()
  : [
      {
        id: this.idGenerator(),
        role: "system" as const,
        content: options.systemPrompt,
        timestamp: Date.now(),
      },
    ];
```

Change queue methods:

```ts
async steer(content: string): Promise<void> {
  const message = this.createUserMessage(content);
  await this.sessionCommitter?.enqueue("steering", message);
  this.steeringQueue.enqueue(message);
}

async followUp(content: string): Promise<void> {
  const message = this.createUserMessage(content);
  await this.sessionCommitter?.enqueue("followUp", message);
  this.followUpQueue.enqueue(message);
}
```

Change reset:

```ts
async reset(): Promise<void> {
  this.assertIdle();
  const existingSystem = this.mutableState.messages.find(
    (message): message is SystemMessage => message.role === "system",
  );
  const systemMessage: SystemMessage = {
    id: this.idGenerator(),
    role: "system",
    content: existingSystem?.content ?? "",
    timestamp: Date.now(),
  };
  await this.sessionCommitter?.reset(systemMessage);
  this.mutableState.messages = [systemMessage];
  // existing transient/queue clearing follows
}
```

- [ ] **Step 6: Update continue without destructive pre-drain**

Replace the Assistant-tail branch with:

```ts
if (lastMessage.role === "assistant") {
  if (
    !this.steeringQueue.hasMessages() &&
    !this.followUpQueue.hasMessages()
  ) {
    throw new Error("Cannot continue from message role: assistant");
  }
  await this.run([]);
  return;
}
```

This lets the Loop reserve and atomically commit queued messages instead of removing them before the run.

- [ ] **Step 7: Pass reservations and committer to the Loop**

In `createConfig()` return:

```ts
reserveSteeringMessages: () =>
  this.steeringQueue.reserveOne("steering"),
reserveFollowUpMessages: () =>
  this.followUpQueue.reserveOne("followUp"),
acknowledgeReservations: (reservations) => {
  for (const reservation of reservations) {
    const queue =
      reservation.queue === "steering"
        ? this.steeringQueue
        : this.followUpQueue;
    queue.acknowledge(reservation.message.id);
  }
},
sessionCommitter: this.sessionCommitter,
idGenerator: this.idGenerator,
```

Update all call sites and tests from synchronous `steer`/`followUp`/`reset` to `await`.

- [ ] **Step 8: Run Agent/queue/session tests**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/session.test.ts test/queues.test.ts test/agent.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: restored state has one System Message, failed enqueue/reset does not mutate memory, and non-persistent Agents retain existing behavior.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/agent.ts packages/core/test packages/server/src/session.ts
git commit -m "feat(core): restore durable agent queues"
```

### Task 6: Persist messages before finalization

**Files:**
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/test/session.test.ts`
- Modify: `packages/core/test/agent-loop.test.ts`

- [ ] **Step 1: Add persist-before-emit failure tests**

Append to `packages/core/test/session.test.ts`:

```ts
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
  await agent.steer("keep me");
  store.failNextAppend(new Error("disk full"));
  await agent.prompt("prompt");
  assert.equal(agent.queuedMessages.steering[0]?.content, "keep me");
});
```

- [ ] **Step 2: Run focused tests to verify current ordering fails**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/session.test.ts
```

Expected: FAIL because current Loop emits and mutates before persistence.

- [ ] **Step 3: Add one commit/finalize helper in agent-loop**

Replace `emitMessage` with:

```ts
async function commitMessages(
  messages: readonly AgentMessage[],
  reservations: readonly QueuedMessageReservation[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EventSink,
): Promise<void> {
  await config.sessionCommitter?.commitMessages({
    messages,
    dequeued: reservations,
  });
  config.acknowledgeReservations(reservations);
  for (const message of messages) {
    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });
    context.messages.push(message);
  }
}
```

For Assistant finalization, add:

```ts
async function commitAssistant(
  message: AssistantMessage,
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EventSink,
): Promise<void> {
  await config.sessionCommitter?.commitMessages({ messages: [message] });
  await emit({ type: "message_end", message });
  context.messages.push(message);
}
```

- [ ] **Step 4: Convert prompts and queue delivery to reservations**

Commit initial prompts first:

```ts
await commitMessages(prompts, [], context, config, emit);
```

Reserve initial steering without deleting it:

```ts
let pendingReservations = config.reserveSteeringMessages();
```

At each Turn boundary choose steering first, otherwise follow-up under the existing priority rules. Replace per-message emission with:

```ts
await commitMessages(
  pendingReservations.map((item) => item.message),
  pendingReservations,
  context,
  config,
  emit,
);
pendingReservations = [];
```

- [ ] **Step 5: Commit Assistant only on `end`**

Inside `streamAssistantResponse`, continue emitting `message_start` and `message_update` immediately. For `end`, call:

```ts
await commitAssistant(modelEvent.message, context, config, emit);
```

Return the final message without pushing it a second time after iteration. Ensure the function contains this terminal-`end` validation:

```ts
if (!finalMessage || !receivedEnd) {
  throw new Error("Model stream ended before end event");
}
```

- [ ] **Step 6: Persist Tool Results before exposing them**

After `executeToolCallBatch`, replace the Tool Result loop with:

```ts
for (const message of toolResults) {
  await commitMessages([message], [], context, config, emit);
  await config.sessionCommitter?.finishEffect(message.toolCallId);
}
```

When persistence is disabled, optional chaining preserves existing runtime ordering.

- [ ] **Step 7: Make failure-message persistence non-recursive**

In `Agent.emitFailure`, attempt:

```ts
try {
  await this.sessionCommitter?.commitMessages({ messages: [message] });
} catch {
  this.mutableState.errorMessage = message.errorMessage;
  await this.processEvent(
    { type: "agent_end", messages: this.mutableState.messages.slice() },
    signal,
  );
  return;
}
```

Only after a successful commit emit `message_start`, `message_end`, `turn_end`, and `agent_end`. This prevents a failed persistence operation from recursively generating another uncommitted terminal message.

- [ ] **Step 8: Run persistence ordering and regression tests**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/session.test.ts test/agent-loop.test.ts test/agent.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: failed appends create no finalized message, queue reservations survive, and non-persistent ordering remains unchanged.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/agent-loop.ts packages/core/src/agent.ts packages/core/test
git commit -m "feat(core): persist messages before finalization"
```

### Task 7: Persist tool effect intent and terminal outcomes

**Files:**
- Modify: `packages/core/src/tool-execution.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/test/tool-execution.test.ts`
- Modify: `packages/core/test/session-store.test.ts`
- Modify: `packages/core/test/session.test.ts`

- [ ] **Step 1: Add effect ordering and recovery tests**

Append to `packages/core/test/tool-execution.test.ts`:

```ts
test("effect intent is committed before tool_execution_start and execute", async () => {
  const order: string[] = [];
  const tool = createTool("write", async () => {
    order.push("execute");
    return { content: "ok" };
  });
  tool.replay = "never";
  await executeToolCallBatch(
    [toolCall("write")],
    {
      ...options({ tools: [tool] }),
      sessionCommitter: {
        commitMessages: async () => {},
        enqueue: async () => {},
        startEffect: async () => {
          order.push("effect_started");
        },
        finishEffect: async () => {},
        cancelEffect: async () => {},
        reset: async () => {},
      },
      emit: async (event) => {
        if (event.type === "tool_execution_start") order.push("event_start");
      },
    },
  );
  assert.deepEqual(order, ["effect_started", "event_start", "execute"]);
});

test("non-JSON arguments fail before tool execution", async () => {
  let executed = false;
  const tool = createTool("write", async () => {
    executed = true;
    return { content: "ok" };
  });
  await assert.rejects(
    executeToolCallBatch(
      [
        {
          type: "toolCall",
          id: "write",
          name: "write",
          arguments: { value: 1n },
        },
      ],
      {
        ...options({ tools: [tool] }),
        sessionCommitter: {
          commitMessages: async () => {},
          enqueue: async () => {},
          startEffect: async () => {},
          finishEffect: async () => {},
          cancelEffect: async () => {},
          reset: async () => {},
        },
      },
    ),
    /not JSON serializable/,
  );
  assert.equal(executed, false);
});
```

Append to `session-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run focused tests to verify missing effect integration**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/tool-execution.test.ts test/session-store.test.ts
```

Expected: FAIL because tool execution does not accept a committer or validate JSON arguments.

- [ ] **Step 3: Add committer to ToolExecutionBatchOptions**

Add:

```ts
sessionCommitter?: SessionCommitter;
```

Import `toJsonValue` and `SessionCommitter`.

Extend the batch result:

```ts
export interface ToolExecutionBatch {
  messages: ToolResultMessage[];
  startedEffectIds: string[];
}
```

Return `{ messages: [], startedEffectIds: [] }` for an empty batch.

Inside `executeToolCallBatch`, add:

```ts
const effectStarted = new Set<string>();
```

Thread this set through `executeSequential`, `executeParallel`, and `executeReady`. After `startEffect` succeeds, add the ID and call `markStarted` before emitting `tool_execution_start`. Remove the old later `markStarted` call so each ready call is tracked once.

For a `ready` call, before `tool_execution_start`:

```ts
await options.sessionCommitter?.startEffect({
  toolCallId: prepared.toolCall.id,
  toolName: prepared.toolCall.name,
  arguments: toJsonValue(prepared.toolCall.arguments),
  replay: prepared.tool.replay ?? "never",
});
effectStarted.add(prepared.toolCall.id);
markStarted(prepared.toolCall);
```

Only real `ready` calls produce effect records; unknown tools, invalid arguments, and blocked calls never begin an external side effect.

- [ ] **Step 4: Persist cancellation before publishing cancelled events**

Maintain a separate `effectStarted` set from the existing event-lifecycle `started` map. In `emitCancelledForOpenCalls`, cancel only IDs present in `effectStarted` and continue persisting even if the event channel has failed:

```ts
for (const toolCall of started.values()) {
  if (terminal.has(toolCall.id)) continue;
  if (effectStarted.has(toolCall.id)) {
    await sessionCommitter?.cancelEffect(toolCall.id);
  }
  if (!events.failed) {
    await events.emit({
      type: "tool_execution_cancelled",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      reason,
    });
  }
}
```

Pass the optional committer and `effectStarted` into this helper. Persist cancellation even when `events.failed` is true; only skip the cancellation event in that case. Preserve the original abort/control error if cancellation persistence or event dispatch also fails.

At successful batch return:

```ts
return {
  messages: completed.map((item) => toMessage(item, options.idGenerator)),
  startedEffectIds: [...effectStarted],
};
```

- [ ] **Step 5: Pass committer from AgentLoop**

Add to `executeToolCallBatch` options:

```ts
sessionCommitter: config.sessionCommitter,
idGenerator: config.idGenerator,
```

Keep `finishEffect` after each Tool Result message commit in AgentLoop so a result cannot be marked finished before it is durable:

```ts
for (const message of toolResults) {
  await commitMessages([message], [], context, config, emit);
  if (batch.startedEffectIds.includes(message.toolCallId)) {
    await config.sessionCommitter?.finishEffect(message.toolCallId);
  }
}
```

This prevents unknown/invalid/blocked immediate Tool Results from creating unmatched `effect_finished` records.

- [ ] **Step 6: Add reset/effect replay regression**

Append a store test that replays:

1. `effect_started`,
2. `effect_cancelled`,
3. queue enqueue,
4. `reset`.

Assert exact values:

```ts
assert.deepEqual(snapshot.messages.map((message) => message.id), [
  "system-after-reset",
]);
assert.deepEqual(snapshot.steeringQueue, []);
assert.equal(snapshot.cancelledEffects[0]?.toolCallId, "call-cancelled");
assert.equal(snapshot.recoveryWarnings[0]?.kind, "cancelled");
```

- [ ] **Step 7: Run tool/session/core validation**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/tool-execution.test.ts test/session-store.test.ts test/session.test.ts
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/core run check
```

Expected: durable intent precedes side effects, cancelled effects are not unknown, and tools are never automatically replayed.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/tool-execution.ts packages/core/src/agent-loop.ts packages/core/test
git commit -m "feat(core): persist tool effect boundaries"
```

### Task 8: Publish the core Session API

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/session.test.ts`

- [ ] **Step 1: Add public-entrypoint tests**

Append:

```ts
test("Session APIs are exported from the package entrypoint", async () => {
  const core = await import("../src/index.ts");
  assert.equal(typeof core.MemorySessionStore, "function");
  assert.equal(typeof core.JsonlSessionStore, "function");
  assert.equal(typeof core.SessionNotFoundError, "function");
  assert.equal(typeof core.openOrCreateSession, "function");
  assert.equal(typeof core.toJsonValue, "function");
});
```

- [ ] **Step 2: Run focused test to verify missing exports**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/session.test.ts
```

Expected: FAIL because Session APIs are not exported.

- [ ] **Step 3: Add public exports**

Add to `packages/core/src/index.ts`:

```ts
export {
  JsonlSessionStore,
  MemorySessionStore,
  SessionNotFoundError,
  toJsonValue,
} from "./session-store.ts";
export {
  createSessionCommitter,
  openOrCreateSession,
} from "./session-committer.ts";
export type {
  JsonValue,
  MessageCommit,
  OpenedSession,
  PendingEffect,
  QueueName,
  QueuedMessageReservation,
  SessionCommitter,
  SessionLoadDiagnostic,
  SessionMetadata,
  SessionOperation,
  SessionRecord,
  SessionRecoveryWarning,
  SessionSnapshot,
  SessionStore,
} from "./session.ts";
```

- [ ] **Step 4: Run all core validation**

Run:

```bash
pnpm --filter @mini-agent/core run check
pnpm --filter @mini-agent/core run test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/test/session.test.ts
git commit -m "feat(core): publish session persistence API"
```

### Task 9: Extend the server protocol for Session selection

**Files:**
- Modify: `packages/server/src/protocol.ts`
- Modify: `packages/server/test/protocol.test.ts`

- [ ] **Step 1: Replace parser tests with rich-result expectations**

Add Session command tests:

```ts
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
  assert.deepEqual(parseCommand('{"type":"nope"}'), {
    ok: false,
    kind: "command",
    message: "Unrecognized command",
  });
});
```

Update existing valid-command assertions to wrap commands in `{ ok: true, command }`, and malformed assertions to expect the command error result.

- [ ] **Step 2: Run protocol tests to verify failure**

Run:

```bash
pnpm --filter @mini-agent/server exec node --experimental-strip-types --test test/protocol.test.ts
```

Expected: FAIL because Session commands and rich parse results are missing.

- [ ] **Step 3: Add protocol types and validation**

In `protocol.ts`, import `SessionMetadata` and add:

```ts
export type ClientCommand =
  | { type: "prompt"; content: string }
  | { type: "steer"; content: string }
  | { type: "followUp"; content: string }
  | { type: "abort" }
  | { type: "reset" }
  | { type: "list_sessions" }
  | { type: "create_session"; sessionId?: string }
  | { type: "open_session"; sessionId: string };

export type ServerMessage =
  | { type: "state"; state: SerializableAgentState }
  | { type: "event"; event: AgentEvent }
  | { type: "reset" }
  | { type: "error"; message: string }
  | { type: "session_list"; sessions: SessionMetadata[] }
  | { type: "session_opened"; sessionId: string }
  | { type: "session_error"; message: string };

export type ParseCommandResult =
  | { ok: true; command: ClientCommand }
  | {
      ok: false;
      kind: "command" | "session";
      message: string;
    };
```

Use:

```ts
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
```

Return `kind: "session"` only when a recognized Session command has a missing/invalid ID; all malformed JSON, invalid content, or unknown commands return `kind: "command"`.

- [ ] **Step 4: Run protocol tests and check**

Run:

```bash
pnpm --filter @mini-agent/server exec node --experimental-strip-types --test test/protocol.test.ts
pnpm --filter @mini-agent/server run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/protocol.ts packages/server/test/protocol.test.ts
git commit -m "feat(server): add session protocol commands"
```

### Task 10: Add SessionManager and per-connection binding

**Files:**
- Create: `packages/server/src/session-manager.ts`
- Modify: `packages/server/src/session.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/test/session.test.ts`

- [ ] **Step 1: Add a persistent server test harness**

Add imports:

```ts
import {
  MemorySessionStore,
  openOrCreateSession,
  type SessionStore,
} from "@mini-agent/core";
import { SessionManager } from "../src/session-manager.ts";
import {
  SessionSocketServer,
  createAgent,
} from "../src/session.ts";
```

Replace the current `TestContext`, `connect`, and `cleanup` helpers with:

```ts
interface SocketClient {
  socket: WebSocket;
  received: ServerMessage[];
}

interface TestContext extends SocketClient {
  server: Server;
  url: string;
  manager: SessionManager;
  router: SessionSocketServer;
  store: SessionStore;
}

async function openSocket(url: string): Promise<SocketClient> {
  const socket = new WebSocket(url);
  const received: ServerMessage[] = [];
  socket.on("message", (data) => {
    received.push(JSON.parse(data.toString()) as ServerMessage);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, received };
}

async function connect(
  store: SessionStore = new MemorySessionStore(),
): Promise<TestContext> {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: "/ws" });
  const manager = new SessionManager(store, (options) =>
    createAgent(options),
  );
  const router = new SessionSocketServer(manager);
  router.attach(wss);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  assert(address !== null && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const client = await openSocket(url);
  return {
    server,
    url,
    manager,
    router,
    store,
    ...client,
  };
}

async function cleanup(context: TestContext): Promise<void> {
  context.socket.close();
  context.router.dispose();
  context.manager.dispose();
  await new Promise<void>((resolve) => {
    context.server.close(() => resolve());
  });
}
```

- [ ] **Step 2: Add manager and reconnect integration tests**

Append:

```ts
test("two concurrent opens share one in-flight AgentSession", async () => {
  let factoryCalls = 0;
  const manager = new SessionManager(
    new MemorySessionStore(),
    (options) => {
      factoryCalls += 1;
      return createAgent(options);
    },
    (() => {
      let index = 0;
      return () => `session-id-${++index}`;
    })(),
  );
  const [left, right] = await Promise.all([
    manager.getOrOpen("same"),
    manager.getOrOpen("same"),
  ]);
  assert.equal(left, right);
  assert.equal(factoryCalls, 1);
  manager.dispose();
});

test("default session remains compatible without an explicit open command", async () => {
  const context = await connect();
  try {
    const state = await waitFor(
      context.received,
      (message) => message.type === "state",
    );
    assert.equal(state.type, "state");
    assert.equal(state.state.messages[0]?.role, "system");
    context.socket.send(
      JSON.stringify({ type: "prompt", content: "你好" }),
    );
    await waitFor(
      context.received,
      (message) =>
        message.type === "event" && message.event.type === "agent_end",
    );
  } finally {
    await cleanup(context);
  }
});

test("reconnect receives state before recovery warnings", async () => {
  const store = new MemorySessionStore();
  const opened = await openOrCreateSession({
    store,
    sessionId: "recovering",
    systemMessage: {
      id: "recovering-system",
      role: "system",
      content: "system",
      timestamp: 1,
    },
  });
  await opened.committer.startEffect({
    toolCallId: "call-unknown",
    toolName: "write",
    arguments: { path: "a" },
    replay: "never",
  });
  const context = await connect(store);
  try {
    await waitFor(
      context.received,
      (message) => message.type === "state",
    );
    context.received.length = 0;
    context.socket.send(
      JSON.stringify({
        type: "open_session",
        sessionId: "recovering",
      }),
    );
    await waitFor(
      context.received,
      (message) =>
        message.type === "event" &&
        message.event.type === "session_recovery_warning",
    );
    const stateIndex = context.received.findIndex(
      (message) => message.type === "state",
    );
    const warningIndex = context.received.findIndex(
      (message) =>
        message.type === "event" &&
        message.event.type === "session_recovery_warning",
    );
    assert.ok(stateIndex >= 0);
    assert.ok(warningIndex > stateIndex);
  } finally {
    await cleanup(context);
  }
});

test("opening another session isolates broadcasts", async () => {
  const context = await connect();
  const right = await openSocket(context.url);
  try {
    await waitFor(context.received, (m) => m.type === "state");
    await waitFor(right.received, (m) => m.type === "state");
    context.received.length = 0;
    right.received.length = 0;
    context.socket.send(
      JSON.stringify({ type: "open_session", sessionId: "left" }),
    );
    right.socket.send(
      JSON.stringify({ type: "open_session", sessionId: "right" }),
    );
    await waitFor(context.received, (m) => m.type === "session_opened");
    await waitFor(right.received, (m) => m.type === "session_opened");
    context.socket.send(
      JSON.stringify({ type: "prompt", content: "left only" }),
    );
    await waitFor(
      context.received,
      (m) => m.type === "event" && m.event.type === "agent_end",
    );
    assert.equal(
      right.received.some(
        (m) => m.type === "event" && m.event.type === "agent_start",
      ),
      false,
    );
  } finally {
    right.socket.close();
    await cleanup(context);
  }
});
```

- [ ] **Step 3: Run server tests to verify missing manager**

Run:

```bash
pnpm --filter @mini-agent/server run test
```

Expected: FAIL because `SessionManager` and connection rebinding do not exist.

- [ ] **Step 4: Implement SessionManager**

Create `packages/server/src/session-manager.ts`:

```ts
import {
  Agent,
  openOrCreateSession,
  type IdGenerator,
  type SessionStore,
  type SystemMessage,
} from "@mini-agent/core";
import { randomUUID } from "node:crypto";
import { AgentSession, createAgent } from "./session.ts";

export type AgentFactory = (options: {
  initialSession: Awaited<
    ReturnType<typeof openOrCreateSession>
  >["snapshot"];
  sessionCommitter: Awaited<
    ReturnType<typeof openOrCreateSession>
  >["committer"];
  idGenerator: IdGenerator;
}) => Agent;

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly opening = new Map<string, Promise<AgentSession>>();

  constructor(
    private readonly store: SessionStore,
    private readonly agentFactory: AgentFactory = (options) =>
      createAgent(options),
    private readonly idGenerator: IdGenerator = randomUUID,
  ) {}

  async getOrOpen(sessionId: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const inFlight = this.opening.get(sessionId);
    if (inFlight) return inFlight;

    const opening = this.open(sessionId).finally(() => {
      this.opening.delete(sessionId);
    });
    this.opening.set(sessionId, opening);
    return opening;
  }

  async list() {
    return this.store.list();
  }

  createId(): string {
    return this.idGenerator();
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  private async open(sessionId: string): Promise<AgentSession> {
    const systemMessage: SystemMessage = {
      id: this.idGenerator(),
      role: "system",
      content: "You are a deterministic teaching Agent.",
      timestamp: Date.now(),
    };
    const opened = await openOrCreateSession({
      store: this.store,
      sessionId,
      systemMessage,
    });
    const session = new AgentSession(
      sessionId,
      this.agentFactory({
        initialSession: opened.snapshot,
        sessionCommitter: opened.committer,
        idGenerator: this.idGenerator,
      }),
      opened.snapshot,
    );
    this.sessions.set(sessionId, session);
    return session;
  }
}
```

- [ ] **Step 5: Parameterize createAgent for restored Sessions**

Change `createAgent`:

```ts
export function createAgent(
  persistence: Pick<
    AgentOptions,
    "initialSession" | "sessionCommitter" | "idGenerator"
  > = {},
): Agent {
  return new Agent({
    systemPrompt: "You are a deterministic teaching Agent.",
    stream: createMockStream({
      delayMs: 30,
      idGenerator: persistence.idGenerator,
    }),
    tools: [
      createReadTool({
        "package.json":
          "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
      }),
    ],
    ...persistence,
  });
}
```

- [ ] **Step 6: Make AgentSession own one Session's client set**

Change its constructor to receive `sessionId`, `agent`, and `snapshot`. Add:

```ts
addClient(socket: WebSocket): void {
  this.clients.add(socket);
}

removeClient(socket: WebSocket): void {
  this.clients.delete(socket);
}

sendInitialState(socket: WebSocket): void {
  this.sendState(socket);
  if (this.snapshot.recoveryWarnings.length > 0) {
    this.send(socket, {
      type: "event",
      event: {
        type: "session_recovery_warning",
        warnings: this.snapshot.recoveryWarnings,
      },
    });
  }
}
```

Keep Agent event subscription and same-session broadcast behavior inside this class.

- [ ] **Step 7: Add a socket router that can rebind Sessions**

In `session.ts`, replace the single-Agent `attach` implementation with a `SessionSocketServer` class that stores:

```ts
private readonly bindings = new Map<WebSocket, AgentSession>();
```

Use `import type { SessionManager } from "./session-manager.ts"` so `session-manager.ts` can import `AgentSession` without creating a runtime circular dependency.

On connection:

1. `await manager.getOrOpen("default")`;
2. bind socket;
3. send full State;
4. send recovery warning if present;
5. then install/execute incremental commands.

For `open_session`/`create_session`, remove the socket from its old `AgentSession`, bind to the new one, send `session_opened`, State, then warning.

For `list_sessions`, send only to the requesting socket.

For normal Agent commands, dispatch to the currently bound `AgentSession`. Await `steer`, `followUp`, and `reset`. On reset success broadcast existing `{ type: "reset" }`.

Parse failures map:

```ts
result.kind === "session"
  ? { type: "session_error", message: result.message }
  : { type: "error", message: result.message }
```

- [ ] **Step 8: Export manager/router**

Update `packages/server/src/index.ts`:

```ts
export * from "./protocol.ts";
export {
  AgentSession,
  SessionSocketServer,
  createAgent,
} from "./session.ts";
export { SessionManager } from "./session-manager.ts";
export type { AgentFactory } from "./session-manager.ts";
```

- [ ] **Step 9: Run server integration tests**

Run:

```bash
pnpm --filter @mini-agent/server run check
pnpm --filter @mini-agent/server run test
```

Expected: default compatibility, in-flight de-duplication, session isolation, State-before-warning order, and busy-Agent errors all pass.

- [ ] **Step 10: Commit**

```bash
git add packages/server/src packages/server/test/session.test.ts
git commit -m "feat(server): manage persistent sessions"
```

### Task 11: Wire JSONL persistence into server startup and run full regression

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/test/session.test.ts`
- Modify: `README.md` if it documents server startup/environment variables

- [ ] **Step 1: Add a restart-through-JSONL integration test**

Add a test that:

1. creates a temporary absolute data directory,
2. starts a server with `JsonlSessionStore`,
3. prompts the `default` Session and waits for `agent_end`,
4. shuts down server/session manager,
5. creates a new store/manager/server using the same directory,
6. reconnects and asserts the initial State contains the previously committed User and Assistant IDs exactly once.

Use exact assertions:

```ts
assert.equal(
  state.state.messages.filter((message) => message.role === "user").length,
  1,
);
assert.equal(
  state.state.messages.filter((message) => message.role === "assistant")
    .length,
  1,
);
assert.equal(
  new Set(state.state.messages.map((message) => message.id)).size,
  state.state.messages.length,
);
```

- [ ] **Step 2: Run the restart test to verify startup is not wired**

Run:

```bash
pnpm --filter @mini-agent/server run test
```

Expected: the new restart test FAILS because `server.ts` still creates one in-memory Agent.

- [ ] **Step 3: Wire the production data directory**

In `server.ts`, import `resolve`, `JsonlSessionStore`, `SessionManager`, and `SessionSocketServer`.

Add:

```ts
const DATA_DIR = resolve(process.env.MINI_AGENT_DATA_DIR ?? "./.mini-agent");
const store = new JsonlSessionStore(DATA_DIR);
const manager = new SessionManager(store);
const socketServer = new SessionSocketServer(manager);
socketServer.attach(wss);
```

Remove the old global `AgentSession(createAgent())`.

In shutdown:

```ts
socketServer.dispose();
manager.dispose();
```

Keep existing client termination, WebSocket close, HTTP close, and timeout behavior.

- [ ] **Step 4: Document the data directory**

After the README development command block, add:

```md
- `MINI_AGENT_DATA_DIR`: absolute or relative Session data directory.
  Defaults to `./.mini-agent`; Session files are stored under
  `<dataDir>/sessions/<sessionId>.jsonl`.
```

- [ ] **Step 5: Run complete workspace validation**

Run:

```bash
pnpm --filter @mini-agent/core run check
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/server run check
pnpm --filter @mini-agent/server run test
pnpm --filter @mini-agent/web run check
pnpm --filter @mini-agent/web run test
pnpm --filter @mini-agent/web run build
```

Expected:

- Core shared store contracts and persistence integration pass.
- Server restart restores committed messages without duplicates.
- Existing web tests/build pass with only fixture IDs changed.
- The web client connects to `default` without sending Session commands.

- [ ] **Step 6: Inspect scope and persistence invariants**

Run:

```bash
git --no-pager diff --check
git --no-pager diff --stat
git --no-pager diff -- packages/core packages/server packages/web/test README.md
```

Confirm:

- no message enters history before its commit succeeds;
- no queue reservation is removed before the combined dequeue/message commit succeeds;
- no real tool executes before `effect_started` is durable;
- no effect is marked finished before its Tool Result is durable;
- no recovery path automatically replays a tool;
- no System Message is duplicated on reopen;
- server never parses JSONL directly;
- session IDs cannot escape the data directory.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/server.ts packages/server/test README.md
git commit -m "feat(server): persist sessions to jsonl"
```

## Final acceptance checklist

- [ ] Restarting the server and opening a Session restores each committed message exactly once.
- [ ] `MemorySessionStore` and `JsonlSessionStore` pass the same contract.
- [ ] A truncated final JSONL line is ignored as one whole commit and recorded as a load diagnostic.
- [ ] Corrupt middle lines, sequence holes, and decreasing/duplicate sequences fail load.
- [ ] `updatedAt` equals the last valid commit timestamp.
- [ ] All four message roles have required stable IDs.
- [ ] Restored Agent construction does not add another System Message.
- [ ] User/Tool Result messages are invisible until commit succeeds.
- [ ] Streaming Assistant updates remain transient; `message_end` occurs only after commit.
- [ ] Failed queue commits retain reservations in memory and on disk.
- [ ] `continue()` permits User/ToolResult or queued input tails and rejects empty/answered tails.
- [ ] `effect_started` is durable before real tool execution.
- [ ] Abort/control cancellation records `effect_cancelled`.
- [ ] Pending effects produce `unknown` warnings; cancelled effects produce only `cancelled` warnings.
- [ ] Reset is append-only, clears transcript/queues, and preserves effect audit state.
- [ ] Concurrent opens of one Session share one in-flight Promise and one Agent.
- [ ] Each WebSocket is bound to exactly one Session at a time.
- [ ] Initial State is sent before recovery warnings and incremental events.
- [ ] Existing clients work unchanged through the automatic `default` Session.
- [ ] Core, server, and web checks/tests/build all pass.
