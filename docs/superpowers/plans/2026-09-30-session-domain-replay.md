# Session Domain Model and Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the Session event-log domain model, safely convert unknown tool arguments into JSON values, and replay in-memory Session records into a validated `SessionSnapshot` without file I/O or Agent integration.

**Architecture:** Keep pure data contracts in `session.ts`, JSON boundary validation in `json-value.ts`, and deterministic state reconstruction in `session-replay.ts`. The replay function processes one Session Header followed by strictly contiguous Commit Envelopes, applies operations in recorded order, and derives queues, effects, warnings, and `updatedAt` without mutating the input records.

**Tech Stack:** TypeScript 5.9, Node.js 22 built-in test runner, `node --experimental-strip-types`, pnpm workspace.

---

## Scope

This plan implements only small requirement 2 from:

- `docs/superpowers/specs/2026-09-30-session-persistence-incremental-design-zh.md`
- `docs/superpowers/specs/2026-09-28-session-persistence-design-zh.md`

Included:

- Session domain types.
- Commit Envelope sequence and operation types.
- Strict conversion from `unknown` to `JsonValue`.
- Pure replay of message, queue, effect, and reset operations.
- Sequence validation.
- Queue enqueue/dequeue pairing validation.
- Effect start/finish/cancel pairing validation.
- Stable recovery warnings.
- Public Core exports.

Excluded:

- `SessionStore`, `MemorySessionStore`, `JsonlSessionStore`.
- Reading or writing JSONL.
- Tail truncation handling.
- Session file paths and session ID filename validation.
- `SessionCommitter`.
- Agent, Agent Loop, tool execution, Server, or Web integration.

## Domain Decisions

The implementation must use these explicit rules:

1. The first record must be exactly one Session Header.
2. No second Session Header is allowed.
3. Commit sequence starts at `1` and each following Commit increments by exactly `1`.
4. Operations inside one Commit are applied in array order.
5. `metadata.updatedAt` equals the final valid Commit timestamp; with no Commit it equals Header `createdAt`.
6. A queue message ID may be enqueued only once across both queues until it is dequeued or reset.
7. `queue_dequeued` must reference a currently enqueued message in the named queue.
8. `effect_started` requires a tool call ID not currently pending and not previously completed or cancelled.
9. `effect_finished` and `effect_cancelled` must reference a currently pending effect.
10. Reset replaces Transcript messages with its System Message and clears both queues.
11. Reset does not clear pending or cancelled effect audit state.
12. Pending effects become `unknown` recovery warnings.
13. Cancelled effects remain in `cancelledEffects` and become `cancelled` recovery warnings.
14. The replayer never executes or retries a tool.
15. `toJsonValue()` rejects values that JSON would silently lose or coerce: `undefined`, functions, symbols, bigint, non-finite numbers, non-plain objects, symbol-keyed object properties, and circular references.
16. Repeated non-circular references are allowed and copied independently, matching JSON serialization semantics.

## File Structure

### New production files

- `packages/core/src/session.ts` — Session domain types only.
- `packages/core/src/json-value.ts` — pure `unknown` to `JsonValue` conversion.
- `packages/core/src/session-replay.ts` — pure record validation and Snapshot reconstruction.

### New test files

- `packages/core/test/json-value.test.ts` — JSON conversion contract.
- `packages/core/test/session-replay.test.ts` — Header, Commit, message, queue, effect, reset, warning, and sequence behavior.

### Existing file to modify

- `packages/core/src/index.ts` — export the public Session types and pure functions.

## Task 1: Define the Session Domain Contracts

**Files:**

- Create: `packages/core/src/session.ts`
- Create: `packages/core/test/session-replay.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write a failing public-contract test**

Create `packages/core/test/session-replay.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and verify the contracts are missing**

Run:

```bash
pnpm --filter @mini-agent/core check
```

Expected: FAIL with TypeScript errors stating that the Session types are not exported from `../src/index.ts`.

- [ ] **Step 3: Create the complete domain type file**

Create `packages/core/src/session.ts`:

```ts
import type {
  AgentMessage,
  ReplayPolicy,
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

export interface SessionMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingEffect {
  toolCallId: string;
  toolName: string;
  arguments: JsonValue;
  replay: ReplayPolicy;
}

export type SessionOperation =
  | { type: "message"; message: AgentMessage }
  | {
      type: "queue_enqueued";
      queue: QueueName;
      message: AgentMessage;
    }
  | {
      type: "queue_dequeued";
      queue: QueueName;
      messageId: string;
    }
  | { type: "effect_started"; effect: PendingEffect }
  | { type: "effect_finished"; toolCallId: string }
  | { type: "effect_cancelled"; toolCallId: string }
  | { type: "reset"; systemMessage: SystemMessage };

export type SessionRecord =
  | {
      type: "session";
      version: 1;
      metadata: SessionMetadata;
    }
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

export interface SessionSnapshot {
  metadata: SessionMetadata;
  messages: AgentMessage[];
  steeringQueue: AgentMessage[];
  followUpQueue: AgentMessage[];
  pendingEffects: PendingEffect[];
  cancelledEffects: PendingEffect[];
  recoveryWarnings: SessionRecoveryWarning[];
}
```

Keep this file free of runtime functions. It is the shared contract layer for later Store and Committer requirements.

- [ ] **Step 4: Export the contracts**

Add to `packages/core/src/index.ts` before the final `export * from "./types.ts"`:

```ts
export type {
  JsonValue,
  PendingEffect,
  QueueName,
  SessionMetadata,
  SessionOperation,
  SessionRecord,
  SessionRecoveryWarning,
  SessionSnapshot,
} from "./session.ts";
```

- [ ] **Step 5: Run the contract test and type-check**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/session-replay.test.ts
pnpm --filter @mini-agent/core check
```

Expected: PASS.

- [ ] **Step 6: Commit the domain contracts**

```bash
git add \
  packages/core/src/session.ts \
  packages/core/src/index.ts \
  packages/core/test/session-replay.test.ts
git commit -m "feat(core): define session domain contracts" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 2: Convert Unknown Values into Strict JSON Values

**Files:**

- Create: `packages/core/src/json-value.ts`
- Create: `packages/core/test/json-value.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write successful-conversion tests**

Create `packages/core/test/json-value.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { toJsonValue } from "../src/json-value.ts";

test("toJsonValue copies nested JSON-compatible values", () => {
  const input = {
    path: "package.json",
    range: [1, 2],
    options: {
      exact: true,
      note: null,
    },
  };

  const result = toJsonValue(input);

  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  if (
    result === null ||
    Array.isArray(result) ||
    typeof result !== "object"
  ) {
    assert.fail("Expected an object result");
  }
  assert.notEqual(result.options, input.options);
});

test("toJsonValue allows repeated non-circular references", () => {
  const shared = { value: 1 };

  assert.deepEqual(
    toJsonValue({ left: shared, right: shared }),
    {
      left: { value: 1 },
      right: { value: 1 },
    },
  );
});
```

- [ ] **Step 2: Write rejection tests**

Append to `packages/core/test/json-value.test.ts`:

```ts
test("toJsonValue rejects unsupported root values", () => {
  for (const value of [
    undefined,
    1n,
    Symbol("value"),
    () => "value",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    new Date("2026-09-30T00:00:00.000Z"),
  ]) {
    assert.throws(
      () => toJsonValue(value),
      /Value at \$ is not JSON-compatible/,
    );
  }
});

test("toJsonValue rejects unsupported nested values", () => {
  assert.throws(
    () => toJsonValue({ value: undefined }),
    /Value at \$\.value is not JSON-compatible/,
  );
  assert.throws(
    () => toJsonValue([1, () => "value"]),
    /Value at \$\[1\] is not JSON-compatible/,
  );
});

test("toJsonValue rejects circular references", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  assert.throws(
    () => toJsonValue(circular),
    /Circular JSON value at \$\.self/,
  );
});

test("toJsonValue rejects symbol-keyed object properties", () => {
  const key = Symbol("secret");
  const input = { visible: true, [key]: "hidden" };

  assert.throws(
    () => toJsonValue(input),
    /Symbol-keyed properties are not JSON-compatible at \$/,
  );
});

test("toJsonValue rejects sparse arrays", () => {
  const input = [1, 2];
  delete input[1];

  assert.throws(
    () => toJsonValue(input),
    /Sparse array entry at \$\[1\] is not JSON-compatible/,
  );
});
```

- [ ] **Step 3: Run the tests and verify the converter is missing**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/json-value.test.ts
```

Expected: FAIL because `json-value.ts` does not exist.

- [ ] **Step 4: Implement the strict converter**

Create `packages/core/src/json-value.ts`:

```ts
import type { JsonValue } from "./session.ts";

function isPlainObject(
  value: object,
): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function convertJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Value at ${path} is not JSON-compatible`);
    }
    return value;
  }

  if (typeof value !== "object") {
    throw new Error(`Value at ${path} is not JSON-compatible`);
  }

  if (ancestors.has(value)) {
    throw new Error(`Circular JSON value at ${path}`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new Error(
            `Sparse array entry at ${path}[${index}] is not JSON-compatible`,
          );
        }
        result.push(
          convertJsonValue(
            value[index],
            `${path}[${index}]`,
            ancestors,
          ),
        );
      }
      return result;
    }

    if (!isPlainObject(value)) {
      throw new Error(`Value at ${path} is not JSON-compatible`);
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(
        `Symbol-keyed properties are not JSON-compatible at ${path}`,
      );
    }

    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = convertJsonValue(
        item,
        `${path}.${key}`,
        ancestors,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function toJsonValue(value: unknown): JsonValue {
  return convertJsonValue(value, "$", new WeakSet<object>());
}
```

The `ancestors.delete(value)` call is required. It rejects cycles in the current recursion path while allowing the same object to appear in two independent branches.

- [ ] **Step 5: Export the converter**

Add to `packages/core/src/index.ts`:

```ts
export { toJsonValue } from "./json-value.ts";
```

- [ ] **Step 6: Run converter tests and Core type-check**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/json-value.test.ts
pnpm --filter @mini-agent/core check
```

Expected: all converter tests PASS.

- [ ] **Step 7: Commit JSON value conversion**

```bash
git add \
  packages/core/src/json-value.ts \
  packages/core/src/index.ts \
  packages/core/test/json-value.test.ts
git commit -m "feat(core): validate session JSON values" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 3: Replay Headers, Commits, and Messages

**Files:**

- Create: `packages/core/src/session-replay.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/session-replay.test.ts`

- [ ] **Step 1: Add identified-message test helpers**

Update imports in `packages/core/test/session-replay.test.ts`:

```ts
import {
  replaySessionRecords,
} from "../src/index.ts";
import {
  identifiedMessage,
} from "./helpers/messages.ts";
```

Add these local fixtures below the imports:

```ts
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
```

- [ ] **Step 2: Write Header and message replay tests**

Append:

```ts
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
```

- [ ] **Step 3: Write structural and sequence failure tests**

Append:

```ts
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
```

- [ ] **Step 4: Run tests and verify the replayer is missing**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/session-replay.test.ts
```

Expected: FAIL because `replaySessionRecords` is not exported.

- [ ] **Step 5: Implement the replay skeleton**

Create `packages/core/src/session-replay.ts`:

```ts
import type { AgentMessage } from "./types.ts";
import type {
  PendingEffect,
  SessionMetadata,
  SessionRecord,
  SessionSnapshot,
} from "./session.ts";

interface ReplayState {
  metadata: SessionMetadata;
  messages: AgentMessage[];
  steeringQueue: AgentMessage[];
  followUpQueue: AgentMessage[];
  pendingEffects: Map<string, PendingEffect>;
  finishedEffectIds: Set<string>;
  cancelledEffects: PendingEffect[];
}

function createReplayState(
  header: Extract<SessionRecord, { type: "session" }>,
): ReplayState {
  return {
    metadata: {
      ...header.metadata,
      updatedAt: header.metadata.createdAt,
    },
    messages: [],
    steeringQueue: [],
    followUpQueue: [],
    pendingEffects: new Map(),
    finishedEffectIds: new Set(),
    cancelledEffects: [],
  };
}

function applyOperation(
  state: ReplayState,
  operation: Extract<
    SessionRecord,
    { type: "commit" }
  >["operations"][number],
): void {
  switch (operation.type) {
    case "message":
      state.messages.push(operation.message);
      return;
    case "queue_enqueued":
    case "queue_dequeued":
    case "effect_started":
    case "effect_finished":
    case "effect_cancelled":
    case "reset":
      throw new Error(
        `Session operation is not supported by the current replay slice: ${operation.type}`,
      );
  }
}

function createSnapshot(state: ReplayState): SessionSnapshot {
  return {
    metadata: { ...state.metadata },
    messages: state.messages.slice(),
    steeringQueue: state.steeringQueue.slice(),
    followUpQueue: state.followUpQueue.slice(),
    pendingEffects: [...state.pendingEffects.values()],
    cancelledEffects: state.cancelledEffects.slice(),
    recoveryWarnings: [],
  };
}

export function replaySessionRecords(
  records: readonly SessionRecord[],
): SessionSnapshot {
  const firstRecord = records[0];
  if (!firstRecord || firstRecord.type !== "session") {
    throw new Error(
      "Session records must begin with a Session Header",
    );
  }

  const state = createReplayState(firstRecord);
  let expectedSequence = 1;

  for (const record of records.slice(1)) {
    if (record.type === "session") {
      throw new Error(
        "Unexpected Session Header after replay began",
      );
    }
    if (record.sequence !== expectedSequence) {
      throw new Error(
        `Expected Commit sequence ${expectedSequence} but received ${record.sequence}`,
      );
    }

    for (const operation of record.operations) {
      applyOperation(state, operation);
    }
    state.metadata.updatedAt = record.timestamp;
    expectedSequence += 1;
  }

  return createSnapshot(state);
}
```

This fail-closed branch keeps the message/sequence slice type-safe while queue, reset, and effect behavior are added in the immediately following tasks.

- [ ] **Step 6: Export the replay function**

Add to `packages/core/src/index.ts`:

```ts
export { replaySessionRecords } from "./session-replay.ts";
```

- [ ] **Step 7: Run the replay tests and type-check**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/session-replay.test.ts
pnpm --filter @mini-agent/core check
```

Expected: Header, message, metadata, and sequence tests PASS.

- [ ] **Step 8: Commit the replay foundation**

```bash
git add \
  packages/core/src/session-replay.ts \
  packages/core/src/index.ts \
  packages/core/test/session-replay.test.ts
git commit -m "feat(core): replay session messages" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 4: Replay Queue Operations and Reset

**Files:**

- Modify: `packages/core/src/session-replay.ts`
- Modify: `packages/core/test/session-replay.test.ts`

- [ ] **Step 1: Write queue replay tests**

Append to `packages/core/test/session-replay.test.ts`:

```ts
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
```

- [ ] **Step 2: Write queue invariant tests**

Append:

```ts
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
```

- [ ] **Step 3: Write reset tests**

Append:

```ts
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
```

- [ ] **Step 4: Run the tests and verify queue/reset operations fail**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/session-replay.test.ts
```

Expected: queue/reset tests FAIL with `Session operation is not supported by the current replay slice`.

- [ ] **Step 5: Add queue helpers to the replay state**

In `packages/core/src/session-replay.ts`, add `QueueName` to the Session imports:

```ts
import type {
  PendingEffect,
  QueueName,
  SessionMetadata,
  SessionRecord,
  SessionSnapshot,
} from "./session.ts";
```

Add these helpers before `applyOperation()`:

```ts
function queueFor(
  state: ReplayState,
  queue: QueueName,
): AgentMessage[] {
  return queue === "steering"
    ? state.steeringQueue
    : state.followUpQueue;
}

function findQueuedMessage(
  state: ReplayState,
  messageId: string,
): { queue: QueueName; index: number } | undefined {
  const steeringIndex = state.steeringQueue.findIndex(
    (message) => message.id === messageId,
  );
  if (steeringIndex >= 0) {
    return { queue: "steering", index: steeringIndex };
  }

  const followUpIndex = state.followUpQueue.findIndex(
    (message) => message.id === messageId,
  );
  if (followUpIndex >= 0) {
    return { queue: "followUp", index: followUpIndex };
  }
  return undefined;
}
```

- [ ] **Step 6: Implement queue and reset operations**

Replace the queue/reset fail-closed cases in `applyOperation()` with:

```ts
case "queue_enqueued": {
  if (findQueuedMessage(state, operation.message.id)) {
    throw new Error(
      `Queue message already enqueued: ${operation.message.id}`,
    );
  }
  queueFor(state, operation.queue).push(operation.message);
  return;
}
case "queue_dequeued": {
  const queue = queueFor(state, operation.queue);
  const index = queue.findIndex(
    (message) => message.id === operation.messageId,
  );
  if (index < 0) {
    throw new Error(
      `Queue message ${operation.messageId} is not enqueued in ${operation.queue}`,
    );
  }
  queue.splice(index, 1);
  return;
}
case "reset":
  state.messages = [operation.systemMessage];
  state.steeringQueue = [];
  state.followUpQueue = [];
  return;
```

Keep the same fail-closed error for the three effect operation cases until Task 5 adds their lifecycle semantics.

- [ ] **Step 7: Run queue/reset tests and type-check**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/session-replay.test.ts
pnpm --filter @mini-agent/core check
```

Expected: Header, message, queue, reset, and sequence tests PASS.

- [ ] **Step 8: Commit queue and reset replay**

```bash
git add \
  packages/core/src/session-replay.ts \
  packages/core/test/session-replay.test.ts
git commit -m "feat(core): replay session queues and reset" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 5: Replay Tool Effects and Derive Recovery Warnings

**Files:**

- Modify: `packages/core/src/session-replay.ts`
- Modify: `packages/core/test/session-replay.test.ts`

- [ ] **Step 1: Add a reusable effect fixture**

Add below `header()` in `packages/core/test/session-replay.test.ts`:

```ts
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
```

- [ ] **Step 2: Write effect replay and warning tests**

Append:

```ts
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
```

- [ ] **Step 3: Write effect invariant tests**

Append:

```ts
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
```

- [ ] **Step 4: Write the reset/effect boundary test**

Append:

```ts
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
```

- [ ] **Step 5: Run the tests and verify effect operations fail**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/session-replay.test.ts
```

Expected: effect tests FAIL with `Session operation is not supported by the current replay slice`.

- [ ] **Step 6: Implement effect lifecycle replay**

Replace the remaining effect fail-closed cases in `applyOperation()`:

```ts
case "effect_started":
  if (
    state.pendingEffects.has(operation.effect.toolCallId) ||
    state.finishedEffectIds.has(operation.effect.toolCallId) ||
    state.cancelledEffects.some(
      (effect) =>
        effect.toolCallId === operation.effect.toolCallId,
    )
  ) {
    throw new Error(
      `Tool effect already recorded: ${operation.effect.toolCallId}`,
    );
  }
  state.pendingEffects.set(
    operation.effect.toolCallId,
    operation.effect,
  );
  return;
case "effect_finished": {
  const pending = state.pendingEffects.get(operation.toolCallId);
  if (!pending) {
    throw new Error(
      `Pending Tool effect not found: ${operation.toolCallId}`,
    );
  }
  state.pendingEffects.delete(operation.toolCallId);
  state.finishedEffectIds.add(operation.toolCallId);
  return;
}
case "effect_cancelled": {
  const pending = state.pendingEffects.get(operation.toolCallId);
  if (!pending) {
    throw new Error(
      `Pending Tool effect not found: ${operation.toolCallId}`,
    );
  }
  state.pendingEffects.delete(operation.toolCallId);
  state.cancelledEffects.push(pending);
  return;
}
```

- [ ] **Step 7: Derive stable recovery warnings**

Add imports in `packages/core/src/session-replay.ts`:

```ts
import type {
  PendingEffect,
  QueueName,
  SessionMetadata,
  SessionRecord,
  SessionRecoveryWarning,
  SessionSnapshot,
} from "./session.ts";
```

Add:

```ts
function unknownWarning(
  effect: PendingEffect,
): SessionRecoveryWarning {
  return {
    kind: "unknown",
    effect,
    message:
      `Tool ${effect.toolName} (${effect.toolCallId}) started ` +
      "before shutdown; outcome is unknown.",
  };
}

function cancelledWarning(
  effect: PendingEffect,
): SessionRecoveryWarning {
  return {
    kind: "cancelled",
    effect,
    message:
      `Tool ${effect.toolName} (${effect.toolCallId}) was cancelled ` +
      "before producing a committed result.",
  };
}
```

Replace `createSnapshot()` with this compilable implementation:

```ts
const pendingEffects = [...state.pendingEffects.values()];
return {
  metadata: { ...state.metadata },
  messages: state.messages.slice(),
  steeringQueue: state.steeringQueue.slice(),
  followUpQueue: state.followUpQueue.slice(),
  pendingEffects,
  cancelledEffects: state.cancelledEffects.slice(),
  recoveryWarnings: [
    ...pendingEffects.map(unknownWarning),
    ...state.cancelledEffects.map(cancelledWarning),
  ],
};
```

- [ ] **Step 8: Run effect tests and type-check**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/session-replay.test.ts
pnpm --filter @mini-agent/core check
```

Expected: all Session replay tests PASS.

- [ ] **Step 9: Commit effect replay**

```bash
git add \
  packages/core/src/session-replay.ts \
  packages/core/test/session-replay.test.ts
git commit -m "feat(core): replay session tool effects" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 6: Verify Purity, Public API, and Workspace Compatibility

**Files:**

- Modify: `packages/core/test/session-replay.test.ts`

- [ ] **Step 1: Add an input immutability test**

Append:

```ts
test("replaySessionRecords does not mutate input records", () => {
  const user = identifiedMessage("user-1", {
    role: "user",
    content: "hello",
    timestamp: 1,
  });
  const records: SessionRecord[] = [
    header(),
    {
      type: "commit",
      sequence: 1,
      timestamp: firstCommitAt,
      operations: [{ type: "message", message: user }],
    },
  ];
  const before = structuredClone(records);

  replaySessionRecords(records);

  assert.deepEqual(records, before);
});
```

- [ ] **Step 2: Add an operations-within-one-Commit ordering test**

Append:

```ts
test("operations inside one Commit are applied in recorded order", () => {
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
              type: "queue_dequeued",
              queue: "steering",
              messageId: queued.id,
            },
            {
              type: "queue_enqueued",
              queue: "steering",
              message: queued,
            },
          ],
        },
      ]),
    /Queue message queued-1 is not enqueued in steering/,
  );
});
```

- [ ] **Step 3: Run all focused Session tests**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test \
  test/json-value.test.ts \
  test/session-replay.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 4: Run full workspace validation**

Run:

```bash
pnpm test
pnpm check
pnpm demo
```

Expected:

- All package tests PASS.
- All package type checks PASS.
- Demo behavior and Transcript remain unchanged.
- No Session file is created because this requirement contains no Store or I/O.

- [ ] **Step 5: Confirm scope boundaries**

Run:

```bash
rg -n \
  'appendFile|readFile|writeFile|JsonlSessionStore|MemorySessionStore|SessionCommitter|openOrCreateSession' \
  packages/core/src/session.ts \
  packages/core/src/json-value.ts \
  packages/core/src/session-replay.ts
```

Expected: no matches.

- [ ] **Step 6: Commit final test coverage**

```bash
git add packages/core/test/session-replay.test.ts
git commit -m "test(core): cover pure session replay invariants" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Completion Criteria

- `JsonValue` represents only JSON-compatible values.
- `toJsonValue()` deep-copies supported values and rejects unsupported or circular data before any tool side effect.
- Session Header and Commit Envelope types are public.
- Commit sequence starts at `1` and is strictly contiguous.
- Message operations preserve recorded order.
- Queue state is reconstructed from enqueue/dequeue operations.
- Missing or duplicate queue identities fail explicitly.
- Pending, finished, and cancelled effects are distinguished.
- Recovery warnings are stable derived Snapshot data.
- Reset replaces messages and clears queues without erasing effect audit state.
- `updatedAt` reflects the last valid Commit timestamp.
- Replay is deterministic, synchronous, pure, and free of file I/O.
- `pnpm test`, `pnpm check`, and `pnpm demo` pass.
- No Store, Committer, Agent integration, Server integration, or JSONL parsing is introduced.
