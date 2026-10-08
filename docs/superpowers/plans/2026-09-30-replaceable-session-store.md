# Replaceable Session Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add interchangeable in-memory and JSONL-backed Session stores that create, append, load, list, validate, and replay Session records without depending on Agent or Server runtime code.

**Architecture:** Keep the public storage contract and errors in `session-store.ts`, the in-memory implementation in `memory-session-store.ts`, and filesystem concerns in `jsonl-session-store.ts`. A focused internal codec validates JSONL records at the untyped file boundary; both stores derive snapshots through the existing pure `replaySessionRecords()` function so sequence, queue, effect, and reset semantics remain centralized.

**Tech Stack:** TypeScript 5.9, Node.js 22 built-in test runner, `node:fs/promises`, `node:path`, `node:os`, `node --experimental-strip-types`, pnpm workspace.

---

## Scope

This plan implements only small requirement 3 from:

- `docs/superpowers/specs/2026-09-30-session-persistence-incremental-design-zh.md`
- `docs/superpowers/specs/2026-09-28-session-persistence-design-zh.md`

Included:

- `SessionStore.create()`, `load()`, `append()`, and `list()`.
- `SessionNotFoundError`, `SessionAlreadyExistsError`, and `InvalidSessionIdError`.
- `MemorySessionStore` with one-shot `failNextAppend()` fault injection.
- `JsonlSessionStore` using `<dataDir>/sessions/<sessionId>.jsonl`.
- Safe Session IDs matching `^[A-Za-z0-9_-]+$`.
- Shared contract tests run against both implementations.
- Strict JSONL record decoding before replay.
- Recovery from a malformed unterminated final line by truncating only the invalid tail bytes and emitting an observable diagnostic.
- Failure for malformed complete lines, invalid record shapes, and invalid replay sequences.
- Deterministic Session listing and public Core exports.

Excluded:

- `SessionCommitter`.
- `openOrCreateSession()`.
- Agent, Agent Loop, queue reservation, tool execution, Server, or Web integration.
- Multi-process locking or concurrent writers to the same JSONL file.
- Repair of malformed complete lines or middle-file corruption.
- Persisting streaming message deltas.

## Domain Decisions

1. `create()` writes exactly one Session Header and fails rather than overwriting an existing Session.
2. `append()` accepts only Commit records. A second Header is rejected before either store mutates.
3. Both stores clone caller-owned records so later caller mutation cannot change persisted state.
4. `load()` always calls `replaySessionRecords()`; stores do not duplicate replay rules.
5. `list()` returns replayed metadata, including the derived `updatedAt`, sorted by `metadata.id`.
6. Missing Sessions throw `SessionNotFoundError` from `load()` and `append()`.
7. Every public operation validates the Session ID before touching a Map or filesystem path.
8. `JsonlSessionStore` requires an absolute `dataDir` and creates its internal `sessions/` directory lazily.
9. Every record is encoded as one JSON object followed by `\n`.
10. A final segment without `\n` is parsed if it is complete valid JSON. If it is malformed, it is treated as a crash-truncated tail: `load()` truncates the file back to the last complete newline, drops the incomplete record, and reports the recovery through `onDiagnostic`.
11. A malformed line terminated by `\n`, including the last terminated line, is corruption and causes `load()` to fail.
12. Store diagnostics are separate from `SessionSnapshot.recoveryWarnings`; recovery warnings remain reserved for tool-effect state.
13. `failNextAppend()` affects exactly one subsequent Memory append after ID, existence, and Commit-kind validation, then clears itself.
14. Empty `append()` input is a successful no-op only after Session ID validation and existence checking.

## File Structure

### New production files

- `packages/core/src/session-store.ts` — public Store interface, errors, diagnostics, ID validation, and Commit-only append validation.
- `packages/core/src/memory-session-store.ts` — Map-backed implementation and append fault injection.
- `packages/core/src/session-record-codec.ts` — internal JSONL encoding and untyped record-shape validation.
- `packages/core/src/jsonl-session-store.ts` — filesystem-backed implementation and tail-truncation diagnostics.

### New test files

- `packages/core/test/session-store-contract.ts` — reusable behavior suite; its filename intentionally does not end in `.test.ts`.
- `packages/core/test/memory-session-store.test.ts` — contract registration plus Memory-only failure injection tests.
- `packages/core/test/session-record-codec.test.ts` — codec validation and tail classification tests.
- `packages/core/test/jsonl-session-store.test.ts` — contract registration plus filesystem layout and corruption tests.

### Existing file to modify

- `packages/core/src/index.ts` — export the public Store types, errors, and implementations.

## Task 1: Define the Public Session Store Contract

**Files:**

- Create: `packages/core/src/session-store.ts`
- Create: `packages/core/test/memory-session-store.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write a failing public-contract test**

Create `packages/core/test/memory-session-store.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidSessionIdError,
  SessionAlreadyExistsError,
  SessionNotFoundError,
} from "../src/index.ts";
import type {
  SessionMetadata,
  SessionStore,
  SessionStoreDiagnostic,
} from "../src/index.ts";

test("Session Store contracts are exported from the package entrypoint", () => {
  const methodName: keyof SessionStore = "append";
  const metadata: SessionMetadata = {
    id: "session-1",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  };
  const diagnostic: SessionStoreDiagnostic = {
    kind: "truncated_tail",
    sessionId: metadata.id,
    message: "Dropped an incomplete final JSONL record",
  };

  assert.equal(methodName, "append");
  assert.equal(diagnostic.kind, "truncated_tail");
  assert.equal(
    new SessionNotFoundError(metadata.id).sessionId,
    metadata.id,
  );
  assert.equal(
    new SessionAlreadyExistsError(metadata.id).sessionId,
    metadata.id,
  );
  assert.equal(
    new InvalidSessionIdError("../escape").sessionId,
    "../escape",
  );
});
```

- [ ] **Step 2: Run the Core type-check and verify the API is missing**

Run:

```bash
pnpm --filter @mini-agent/core check
```

Expected: FAIL because the Store types and errors are not exported.

- [ ] **Step 3: Create the Store contract and shared validation**

Create `packages/core/src/session-store.ts`:

```ts
import type {
  SessionMetadata,
  SessionRecord,
  SessionSnapshot,
} from "./session.ts";

export interface SessionStore {
  create(metadata: SessionMetadata): Promise<void>;
  load(sessionId: string): Promise<SessionSnapshot>;
  append(
    sessionId: string,
    records: readonly SessionRecord[],
  ): Promise<void>;
  list(): Promise<SessionMetadata[]>;
}

export interface SessionStoreDiagnostic {
  kind: "truncated_tail";
  sessionId: string;
  message: string;
}

export type SessionStoreDiagnosticHandler = (
  diagnostic: SessionStoreDiagnostic,
) => void;

export class SessionNotFoundError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
    this.sessionId = sessionId;
  }
}

export class SessionAlreadyExistsError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session already exists: ${sessionId}`);
    this.name = "SessionAlreadyExistsError";
    this.sessionId = sessionId;
  }
}

export class InvalidSessionIdError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Invalid Session ID: ${sessionId}`);
    this.name = "InvalidSessionIdError";
    this.sessionId = sessionId;
  }
}

const safeSessionIdPattern = /^[A-Za-z0-9_-]+$/;

export function isValidSessionId(sessionId: string): boolean {
  return safeSessionIdPattern.test(sessionId);
}

export function assertValidSessionId(sessionId: string): void {
  if (!isValidSessionId(sessionId)) {
    throw new InvalidSessionIdError(sessionId);
  }
}

export function assertCommitRecords(
  records: readonly SessionRecord[],
): void {
  for (const record of records) {
    if (record.type !== "commit") {
      throw new Error(
        "SessionStore.append accepts Commit records only",
      );
    }
  }
}
```

Do not add Store methods to `session.ts`. That file remains the pure Session domain model; this file is the storage boundary.

- [ ] **Step 4: Export the public Store API**

Add to `packages/core/src/index.ts` immediately before the Session domain exports:

```ts
export {
  InvalidSessionIdError,
  SessionAlreadyExistsError,
  SessionNotFoundError,
} from "./session-store.ts";
export type {
  SessionStore,
  SessionStoreDiagnostic,
  SessionStoreDiagnosticHandler,
} from "./session-store.ts";
```

- [ ] **Step 5: Run the public-contract test and type-check**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/memory-session-store.test.ts
pnpm --filter @mini-agent/core check
```

Expected: the export test PASS and the Core type-check PASS.

- [ ] **Step 6: Commit the Store contract**

```bash
git add \
  packages/core/src/session-store.ts \
  packages/core/src/index.ts \
  packages/core/test/memory-session-store.test.ts
git commit -m "feat(core): define session store contract" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 2: Implement the Shared Contract and Memory Store

**Files:**

- Create: `packages/core/src/memory-session-store.ts`
- Create: `packages/core/test/session-store-contract.ts`
- Modify: `packages/core/test/memory-session-store.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Create deterministic Store contract fixtures**

Create `packages/core/test/session-store-contract.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type {
  SessionMetadata,
  SessionRecord,
  SessionStore,
} from "../src/index.ts";
import {
  InvalidSessionIdError,
  SessionAlreadyExistsError,
  SessionNotFoundError,
} from "../src/index.ts";
import { identifiedMessage } from "./helpers/messages.ts";

export interface SessionStoreHarness {
  store: SessionStore;
  dispose(): Promise<void>;
}

export type SessionStoreHarnessFactory =
  () => Promise<SessionStoreHarness>;

const createdAt = "2026-09-30T00:00:00.000Z";
const firstCommitAt = "2026-09-30T00:00:01.000Z";

function metadata(id: string): SessionMetadata {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
  };
}

function messageCommit(
  sequence: number,
  id: string,
  content: string,
): SessionRecord {
  return {
    type: "commit",
    sequence,
    timestamp: firstCommitAt,
    operations: [
      {
        type: "message",
        message: identifiedMessage(id, {
          role: "user",
          content,
          timestamp: sequence,
        }),
      },
    ],
  };
}

async function usingHarness(
  createHarness: SessionStoreHarnessFactory,
  run: (store: SessionStore) => Promise<void>,
): Promise<void> {
  const harness = await createHarness();
  try {
    await run(harness.store);
  } finally {
    await harness.dispose();
  }
}

export function registerSessionStoreContract(
  implementationName: string,
  createHarness: SessionStoreHarnessFactory,
): void {
  test(`${implementationName}: creates and loads an empty Session`, async () => {
    await usingHarness(createHarness, async (store) => {
      await store.create(metadata("session-1"));

      assert.deepEqual(await store.load("session-1"), {
        metadata: metadata("session-1"),
        messages: [],
        steeringQueue: [],
        followUpQueue: [],
        pendingEffects: [],
        cancelledEffects: [],
        recoveryWarnings: [],
      });
    });
  });

  test(`${implementationName}: appends Commits and replays a Snapshot`, async () => {
    await usingHarness(createHarness, async (store) => {
      await store.create(metadata("session-1"));
      await store.append(
        "session-1",
        [messageCommit(1, "user-1", "hello")],
      );

      const snapshot = await store.load("session-1");
      assert.deepEqual(
        snapshot.messages.map((message) => message.id),
        ["user-1"],
      );
      assert.equal(snapshot.metadata.updatedAt, firstCommitAt);
    });
  });

  test(`${implementationName}: isolates Sessions`, async () => {
    await usingHarness(createHarness, async (store) => {
      await store.create(metadata("session-a"));
      await store.create(metadata("session-b"));
      await store.append(
        "session-a",
        [messageCommit(1, "user-a", "only a")],
      );

      assert.equal((await store.load("session-a")).messages.length, 1);
      assert.equal((await store.load("session-b")).messages.length, 0);
    });
  });

  test(`${implementationName}: lists derived metadata in ID order`, async () => {
    await usingHarness(createHarness, async (store) => {
      await store.create(metadata("session-b"));
      await store.create(metadata("session-a"));
      await store.append(
        "session-b",
        [messageCommit(1, "user-b", "updated")],
      );

      assert.deepEqual(await store.list(), [
        metadata("session-a"),
        {
          ...metadata("session-b"),
          updatedAt: firstCommitAt,
        },
      ]);
    });
  });

  test(`${implementationName}: reports missing and duplicate Sessions`, async () => {
    await usingHarness(createHarness, async (store) => {
      await assert.rejects(
        store.load("missing"),
        SessionNotFoundError,
      );
      await assert.rejects(
        store.append("missing", []),
        SessionNotFoundError,
      );

      await store.create(metadata("session-1"));
      await assert.rejects(
        store.create(metadata("session-1")),
        SessionAlreadyExistsError,
      );
    });
  });

  test(`${implementationName}: rejects unsafe Session IDs`, async () => {
    await usingHarness(createHarness, async (store) => {
      for (const sessionId of [
        "",
        "../escape",
        "nested/session",
        "space value",
        "session.jsonl",
      ]) {
        await assert.rejects(
          store.load(sessionId),
          InvalidSessionIdError,
        );
        await assert.rejects(
          store.create(metadata(sessionId)),
          InvalidSessionIdError,
        );
      }
    });
  });

  test(`${implementationName}: rejects Headers passed to append`, async () => {
    await usingHarness(createHarness, async (store) => {
      const sessionMetadata = metadata("session-1");
      await store.create(sessionMetadata);

      await assert.rejects(
        store.append("session-1", [
          {
            type: "session",
            version: 1,
            metadata: sessionMetadata,
          },
        ]),
        /SessionStore\.append accepts Commit records only/,
      );
    });
  });

  test(`${implementationName}: fails load on invalid Commit sequence`, async () => {
    await usingHarness(createHarness, async (store) => {
      await store.create(metadata("session-1"));
      await store.append(
        "session-1",
        [messageCommit(2, "user-1", "gap")],
      );

      await assert.rejects(
        store.load("session-1"),
        /Expected Commit sequence 1 but received 2/,
      );
    });
  });

  test(`${implementationName}: snapshots caller-owned records`, async () => {
    await usingHarness(createHarness, async (store) => {
      await store.create(metadata("session-1"));
      const record = messageCommit(1, "user-1", "original");
      await store.append("session-1", [record]);

      if (record.type !== "commit") {
        assert.fail("Expected a Commit fixture");
      }
      const operation = record.operations[0];
      if (!operation || operation.type !== "message") {
        assert.fail("Expected a message operation");
      }
      if (operation.message.role !== "user") {
        assert.fail("Expected a User message");
      }
      operation.message.content = "mutated";

      const snapshot = await store.load("session-1");
      const loaded = snapshot.messages[0];
      assert.equal(loaded?.role, "user");
      if (loaded?.role === "user") {
        assert.equal(loaded.content, "original");
      }
    });
  });
}
```

- [ ] **Step 2: Register the Memory implementation and add fault tests**

Replace `packages/core/test/memory-session-store.test.ts` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { MemorySessionStore } from "../src/index.ts";
import type { SessionMetadata } from "../src/index.ts";
import { registerSessionStoreContract } from "./session-store-contract.ts";

const createdAt = "2026-09-30T00:00:00.000Z";

function metadata(): SessionMetadata {
  return {
    id: "session-1",
    createdAt,
    updatedAt: createdAt,
  };
}

registerSessionStoreContract("MemorySessionStore", async () => ({
  store: new MemorySessionStore(),
  async dispose() {},
}));

test("MemorySessionStore failNextAppend fails once without mutating records", async () => {
  const store = new MemorySessionStore();
  await store.create(metadata());
  store.failNextAppend(new Error("injected append failure"));

  await assert.rejects(
    store.append("session-1", [
      {
        type: "commit",
        sequence: 1,
        timestamp: "2026-09-30T00:00:01.000Z",
        operations: [],
      },
    ]),
    /injected append failure/,
  );

  assert.equal(
    (await store.load("session-1")).metadata.updatedAt,
    createdAt,
  );

  await store.append("session-1", [
    {
      type: "commit",
      sequence: 1,
      timestamp: "2026-09-30T00:00:02.000Z",
      operations: [],
    },
  ]);
  assert.equal(
    (await store.load("session-1")).metadata.updatedAt,
    "2026-09-30T00:00:02.000Z",
  );
});
```

- [ ] **Step 3: Run the Memory tests and verify the implementation is missing**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/memory-session-store.test.ts
```

Expected: FAIL because `MemorySessionStore` is not exported.

- [ ] **Step 4: Create the complete Memory implementation**

Create `packages/core/src/memory-session-store.ts`:

```ts
import { replaySessionRecords } from "./session-replay.ts";
import type {
  SessionMetadata,
  SessionRecord,
  SessionSnapshot,
} from "./session.ts";
import {
  assertCommitRecords,
  assertValidSessionId,
  SessionAlreadyExistsError,
  SessionNotFoundError,
} from "./session-store.ts";
import type { SessionStore } from "./session-store.ts";

export class MemorySessionStore implements SessionStore {
  private readonly recordsBySession =
    new Map<string, SessionRecord[]>();
  private nextAppendError: Error | undefined;

  async create(metadata: SessionMetadata): Promise<void> {
    assertValidSessionId(metadata.id);
    if (this.recordsBySession.has(metadata.id)) {
      throw new SessionAlreadyExistsError(metadata.id);
    }

    this.recordsBySession.set(metadata.id, [
      structuredClone({
        type: "session",
        version: 1,
        metadata,
      }),
    ]);
  }

  async load(sessionId: string): Promise<SessionSnapshot> {
    assertValidSessionId(sessionId);
    const records = this.recordsBySession.get(sessionId);
    if (!records) {
      throw new SessionNotFoundError(sessionId);
    }
    return replaySessionRecords(structuredClone(records));
  }

  async append(
    sessionId: string,
    records: readonly SessionRecord[],
  ): Promise<void> {
    assertValidSessionId(sessionId);
    const storedRecords = this.recordsBySession.get(sessionId);
    if (!storedRecords) {
      throw new SessionNotFoundError(sessionId);
    }
    assertCommitRecords(records);

    const injectedError = this.nextAppendError;
    this.nextAppendError = undefined;
    if (injectedError) {
      throw injectedError;
    }

    storedRecords.push(...structuredClone(records));
  }

  async list(): Promise<SessionMetadata[]> {
    const metadata = await Promise.all(
      [...this.recordsBySession.keys()].map(
        async (sessionId) => (await this.load(sessionId)).metadata,
      ),
    );
    return metadata.sort((left, right) =>
      left.id.localeCompare(right.id)
    );
  }

  failNextAppend(
    error: Error = new Error("Injected Session append failure"),
  ): void {
    this.nextAppendError = error;
  }
}
```

- [ ] **Step 5: Export the Memory implementation**

Add to `packages/core/src/index.ts` after the Store contract exports:

```ts
export { MemorySessionStore } from "./memory-session-store.ts";
```

- [ ] **Step 6: Run the Memory contract and Core type-check**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/memory-session-store.test.ts
pnpm --filter @mini-agent/core check
```

Expected: all Memory tests PASS and type-check PASS.

- [ ] **Step 7: Commit the Memory Store**

```bash
git add \
  packages/core/src/memory-session-store.ts \
  packages/core/src/index.ts \
  packages/core/test/session-store-contract.ts \
  packages/core/test/memory-session-store.test.ts
git commit -m "feat(core): add memory session store" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 3: Validate and Encode JSONL Session Records

**Files:**

- Create: `packages/core/src/session-record-codec.ts`
- Create: `packages/core/test/session-record-codec.test.ts`

- [ ] **Step 1: Write codec success and tail-recovery tests**

Create `packages/core/test/session-record-codec.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSessionRecords,
  encodeSessionRecords,
} from "../src/session-record-codec.ts";
import type { SessionRecord } from "../src/session.ts";

const header: SessionRecord = {
  type: "session",
  version: 1,
  metadata: {
    id: "session-1",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  },
};

const commit: SessionRecord = {
  type: "commit",
  sequence: 1,
  timestamp: "2026-09-30T00:00:01.000Z",
  operations: [],
};

test("Session record codec writes one newline-terminated JSON object per record", () => {
  const encoded = encodeSessionRecords([header, commit]);

  assert.equal(
    encoded,
    `${JSON.stringify(header)}\n${JSON.stringify(commit)}\n`,
  );
  assert.deepEqual(
    decodeSessionRecords(encoded, "session-1"),
    {
      records: [header, commit],
    },
  );
});

test("Session record codec accepts a complete final record without newline", () => {
  assert.deepEqual(
    decodeSessionRecords(
      `${JSON.stringify(header)}\n${JSON.stringify(commit)}`,
      "session-1",
    ),
    {
      records: [header, commit],
    },
  );
});

test("Session record codec drops a malformed unterminated tail", () => {
  assert.deepEqual(
    decodeSessionRecords(
      `${JSON.stringify(header)}\n{"type":"commit"`,
      "session-1",
    ),
    {
      records: [header],
      truncateToBytes: Buffer.byteLength(
        `${JSON.stringify(header)}\n`,
        "utf8",
      ),
    },
  );
});
```

- [ ] **Step 2: Add corruption and shape-validation tests**

Append to `packages/core/test/session-record-codec.test.ts`:

```ts
test("Session record codec rejects malformed complete lines", () => {
  assert.throws(
    () =>
      decodeSessionRecords(
        `${JSON.stringify(header)}\n{bad json}\n`,
        "session-1",
      ),
    /Invalid JSONL record for Session session-1 at line 2/,
  );
});

test("Session record codec rejects empty complete lines", () => {
  assert.throws(
    () =>
      decodeSessionRecords(
        `${JSON.stringify(header)}\n\n${JSON.stringify(commit)}\n`,
        "session-1",
      ),
    /Empty JSONL record for Session session-1 at line 2/,
  );
});

test("Session record codec rejects invalid record and operation shapes", () => {
  for (const value of [
    null,
    { type: "session", version: 2, metadata: header.metadata },
    {
      type: "commit",
      sequence: 1.5,
      timestamp: commit.timestamp,
      operations: [],
    },
    {
      type: "commit",
      sequence: 1,
      timestamp: commit.timestamp,
      operations: [{ type: "unknown" }],
    },
  ]) {
    assert.throws(
      () =>
        decodeSessionRecords(
          `${JSON.stringify(value)}\n`,
          "session-1",
        ),
      /Invalid Session record for session-1 at line 1/,
    );
  }
});

test("Session record codec does not hide a complete invalid record as truncation", () => {
  assert.throws(
    () =>
      decodeSessionRecords(
        JSON.stringify({ type: "unknown" }),
        "session-1",
      ),
    /Invalid Session record for session-1 at line 1/,
  );
});
```

- [ ] **Step 3: Run the codec test and verify the module is missing**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/session-record-codec.test.ts
```

Expected: FAIL because `session-record-codec.ts` does not exist.

- [ ] **Step 4: Implement strict record-shape validation**

Create `packages/core/src/session-record-codec.ts`:

```ts
import type { AgentMessage } from "./types.ts";
import type {
  PendingEffect,
  SessionMetadata,
  SessionOperation,
  SessionRecord,
} from "./session.ts";

interface DecodeResult {
  records: SessionRecord[];
  truncateToBytes?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return (
    isObject(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function isMetadata(value: unknown): value is SessionMetadata {
  return (
    isObject(value) &&
    isString(value.id) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

function isAssistantContent(value: unknown): boolean {
  if (!isObject(value) || !isString(value.type)) {
    return false;
  }
  if (value.type === "text") {
    return isString(value.text);
  }
  return (
    value.type === "toolCall" &&
    isString(value.id) &&
    isString(value.name) &&
    "arguments" in value &&
    isJsonValue(value.arguments)
  );
}

function isMessage(value: unknown): value is AgentMessage {
  if (
    !isObject(value) ||
    !isString(value.id) ||
    !isString(value.role) ||
    !isFiniteNumber(value.timestamp)
  ) {
    return false;
  }

  switch (value.role) {
    case "system":
    case "user":
      return isString(value.content);
    case "assistant":
      return (
        Array.isArray(value.content) &&
        value.content.every(isAssistantContent) &&
        ["stop", "toolUse", "error", "aborted"].includes(
          String(value.stopReason),
        ) &&
        (
          value.errorMessage === undefined ||
          isString(value.errorMessage)
        )
      );
    case "toolResult":
      return (
        isString(value.toolCallId) &&
        isString(value.toolName) &&
        isString(value.content) &&
        typeof value.isError === "boolean" &&
        (
          value.details === undefined ||
          isJsonValue(value.details)
        )
      );
    default:
      return false;
  }
}

function isPendingEffect(value: unknown): value is PendingEffect {
  return (
    isObject(value) &&
    isString(value.toolCallId) &&
    isString(value.toolName) &&
    (value.replay === "safe" || value.replay === "never") &&
    "arguments" in value &&
    isJsonValue(value.arguments)
  );
}

function isQueueName(value: unknown): value is "steering" | "followUp" {
  return value === "steering" || value === "followUp";
}

function isOperation(value: unknown): value is SessionOperation {
  if (!isObject(value) || !isString(value.type)) {
    return false;
  }

  switch (value.type) {
    case "message":
      return isMessage(value.message);
    case "queue_enqueued":
      return isQueueName(value.queue) && isMessage(value.message);
    case "queue_dequeued":
      return isQueueName(value.queue) && isString(value.messageId);
    case "effect_started":
      return isPendingEffect(value.effect);
    case "effect_finished":
    case "effect_cancelled":
      return isString(value.toolCallId);
    case "reset":
      return (
        isMessage(value.systemMessage) &&
        value.systemMessage.role === "system"
      );
    default:
      return false;
  }
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!isObject(value) || !isString(value.type)) {
    return false;
  }

  if (value.type === "session") {
    return value.version === 1 && isMetadata(value.metadata);
  }

  return (
    value.type === "commit" &&
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence) &&
    isString(value.timestamp) &&
    Array.isArray(value.operations) &&
    value.operations.every(isOperation)
  );
}

function parseRecord(
  value: unknown,
  sessionId: string,
  lineNumber: number,
): SessionRecord {
  if (!isSessionRecord(value)) {
    throw new Error(
      `Invalid Session record for ${sessionId} at line ${lineNumber}`,
    );
  }
  return value;
}

export function encodeSessionRecords(
  records: readonly SessionRecord[],
): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

export function decodeSessionRecords(
  text: string,
  sessionId: string,
): DecodeResult {
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) {
    lines.pop();
  }

  const records: SessionRecord[] = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const isUnterminatedTail =
      !terminated && index === lines.length - 1;

    if (line.length === 0) {
      if (isUnterminatedTail) {
        return {
          records,
          truncateToBytes: Buffer.byteLength(
            lines
              .slice(0, -1)
              .map((validLine) => `${validLine}\n`)
              .join(""),
            "utf8",
          ),
        };
      }
      throw new Error(
        `Empty JSONL record for Session ${sessionId} at line ${lineNumber}`,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (isUnterminatedTail) {
        return {
          records,
          truncateToBytes: Buffer.byteLength(
            lines
              .slice(0, -1)
              .map((validLine) => `${validLine}\n`)
              .join(""),
            "utf8",
          ),
        };
      }
      throw new Error(
        `Invalid JSONL record for Session ${sessionId} at line ${lineNumber}`,
        { cause: error },
      );
    }

    records.push(parseRecord(value, sessionId, lineNumber));
  }

  return { records };
}
```

The decoder deliberately classifies only malformed unterminated final content as recoverable. A valid final JSON object without a newline remains a valid record.

- [ ] **Step 5: Run codec tests and type-check**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/session-record-codec.test.ts
pnpm --filter @mini-agent/core check
```

Expected: all codec tests PASS and type-check PASS.

- [ ] **Step 6: Commit the JSONL codec**

```bash
git add \
  packages/core/src/session-record-codec.ts \
  packages/core/test/session-record-codec.test.ts
git commit -m "feat(core): validate session JSONL records" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 4: Implement the JSONL Session Store

**Files:**

- Create: `packages/core/test/jsonl-session-store.test.ts`
- Create: `packages/core/src/jsonl-session-store.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Register the shared contract with temporary directories**

Create `packages/core/test/jsonl-session-store.test.ts`:

```ts
import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  JsonlSessionStore,
  SessionNotFoundError,
} from "../src/index.ts";
import type {
  SessionMetadata,
  SessionStoreDiagnostic,
} from "../src/index.ts";
import { registerSessionStoreContract } from "./session-store-contract.ts";

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mini-agent-session-store-"));
}

registerSessionStoreContract("JsonlSessionStore", async () => {
  const dataDir = await createTempDir();
  return {
    store: new JsonlSessionStore(dataDir),
    async dispose() {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
});

const createdAt = "2026-09-30T00:00:00.000Z";

function metadata(): SessionMetadata {
  return {
    id: "session-1",
    createdAt,
    updatedAt: createdAt,
  };
}

function sessionPath(dataDir: string): string {
  return join(dataDir, "sessions", "session-1.jsonl");
}
```

- [ ] **Step 2: Add filesystem layout and recovery tests**

Append to `packages/core/test/jsonl-session-store.test.ts`:

```ts
test("JsonlSessionStore writes readable Header and Commit lines", async () => {
  const dataDir = await createTempDir();
  try {
    const store = new JsonlSessionStore(dataDir);
    await store.create(metadata());
    await store.append("session-1", [
      {
        type: "commit",
        sequence: 1,
        timestamp: "2026-09-30T00:00:01.000Z",
        operations: [],
      },
    ]);

    const lines = (await readFile(sessionPath(dataDir), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(
      lines.map((record) => record.type),
      ["session", "commit"],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("JsonlSessionStore drops a truncated tail and reports it", async () => {
  const dataDir = await createTempDir();
  const diagnostics: SessionStoreDiagnostic[] = [];
  try {
    const store = new JsonlSessionStore(dataDir, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await store.create(metadata());
    await appendFile(
      sessionPath(dataDir),
      '{"type":"commit","sequence":1',
      "utf8",
    );

    const snapshot = await store.load("session-1");
    assert.equal(snapshot.metadata.updatedAt, createdAt);
    assert.deepEqual(diagnostics, [
      {
        kind: "truncated_tail",
        sessionId: "session-1",
        message: "Dropped an incomplete final JSONL record",
      },
    ]);

    await store.append("session-1", [
      {
        type: "commit",
        sequence: 1,
        timestamp: "2026-09-30T00:00:01.000Z",
        operations: [],
      },
    ]);
    assert.equal(
      (await store.load("session-1")).metadata.updatedAt,
      "2026-09-30T00:00:01.000Z",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("JsonlSessionStore fails on malformed complete JSONL", async () => {
  const dataDir = await createTempDir();
  try {
    const store = new JsonlSessionStore(dataDir);
    await store.create(metadata());
    await appendFile(sessionPath(dataDir), "{bad json}\n", "utf8");

    await assert.rejects(
      store.load("session-1"),
      /Invalid JSONL record for Session session-1 at line 2/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("JsonlSessionStore fails when corruption occurs before a later record", async () => {
  const dataDir = await createTempDir();
  try {
    const store = new JsonlSessionStore(dataDir);
    await store.create(metadata());
    await appendFile(
      sessionPath(dataDir),
      [
        "{bad json}",
        JSON.stringify({
          type: "commit",
          sequence: 1,
          timestamp: "2026-09-30T00:00:01.000Z",
          operations: [],
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    await assert.rejects(
      store.load("session-1"),
      /Invalid JSONL record for Session session-1 at line 2/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("JsonlSessionStore does not create a file while appending a missing Session", async () => {
  const dataDir = await createTempDir();
  try {
    const store = new JsonlSessionStore(dataDir);
    await assert.rejects(
      store.append("missing", []),
      SessionNotFoundError,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("JsonlSessionStore rejects a Header whose ID does not match its filename", async () => {
  const dataDir = await createTempDir();
  try {
    const store = new JsonlSessionStore(dataDir);
    await store.create(metadata());
    await writeFile(
      sessionPath(dataDir),
      `${JSON.stringify({
        type: "session",
        version: 1,
        metadata: {
          ...metadata(),
          id: "different-session",
        },
      })}\n`,
      "utf8",
    );

    await assert.rejects(
      store.load("session-1"),
      /Session Header ID different-session does not match file ID session-1/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("JsonlSessionStore requires an absolute data directory", () => {
  assert.throws(
    () => new JsonlSessionStore(".mini-agent"),
    /JsonlSessionStore dataDir must be absolute/,
  );
});
```

- [ ] **Step 3: Run the JSONL tests and verify the implementation is missing**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/jsonl-session-store.test.ts
```

Expected: FAIL because `JsonlSessionStore` is not exported.

- [ ] **Step 4: Create the complete JSONL implementation**

Create `packages/core/src/jsonl-session-store.ts`:

```ts
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  truncate,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
} from "node:path";
import { replaySessionRecords } from "./session-replay.ts";
import {
  decodeSessionRecords,
  encodeSessionRecords,
} from "./session-record-codec.ts";
import type {
  SessionMetadata,
  SessionRecord,
  SessionSnapshot,
} from "./session.ts";
import {
  assertCommitRecords,
  assertValidSessionId,
  isValidSessionId,
  SessionAlreadyExistsError,
  SessionNotFoundError,
} from "./session-store.ts";
import type {
  SessionStore,
  SessionStoreDiagnosticHandler,
} from "./session-store.ts";

export interface JsonlSessionStoreOptions {
  onDiagnostic?: SessionStoreDiagnosticHandler;
}

function isNodeError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class JsonlSessionStore implements SessionStore {
  private readonly sessionsDir: string;
  private readonly onDiagnostic:
    SessionStoreDiagnosticHandler | undefined;

  constructor(
    dataDir: string,
    options: JsonlSessionStoreOptions = {},
  ) {
    if (!isAbsolute(dataDir)) {
      throw new Error(
        "JsonlSessionStore dataDir must be absolute",
      );
    }
    this.sessionsDir = join(dataDir, "sessions");
    this.onDiagnostic = options.onDiagnostic;
  }

  async create(metadata: SessionMetadata): Promise<void> {
    assertValidSessionId(metadata.id);
    await mkdir(this.sessionsDir, { recursive: true });

    try {
      await writeFile(
        this.pathFor(metadata.id),
        encodeSessionRecords([
          {
            type: "session",
            version: 1,
            metadata: structuredClone(metadata),
          },
        ]),
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new SessionAlreadyExistsError(metadata.id);
      }
      throw error;
    }
  }

  async load(sessionId: string): Promise<SessionSnapshot> {
    const path = this.pathFor(sessionId);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }

    const decoded = decodeSessionRecords(text, sessionId);
    const header = decoded.records[0];
    if (
      header?.type === "session" &&
      header.metadata.id !== sessionId
    ) {
      throw new Error(
        `Session Header ID ${header.metadata.id} does not match file ID ${sessionId}`,
      );
    }

    if (decoded.truncateToBytes !== undefined) {
      await truncate(path, decoded.truncateToBytes);
      this.onDiagnostic?.({
        kind: "truncated_tail",
        sessionId,
        message: "Dropped an incomplete final JSONL record",
      });
    }
    return replaySessionRecords(decoded.records);
  }

  async append(
    sessionId: string,
    records: readonly SessionRecord[],
  ): Promise<void> {
    const path = this.pathFor(sessionId);
    assertCommitRecords(records);

    try {
      await access(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }

    if (records.length === 0) {
      return;
    }

    await appendFile(
      path,
      encodeSessionRecords(structuredClone(records)),
      "utf8",
    );
  }

  async list(): Promise<SessionMetadata[]> {
    let entries;
    try {
      entries = await readdir(this.sessionsDir, {
        withFileTypes: true,
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const sessionIds = entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(".jsonl"),
      )
      .map((entry) => basename(entry.name, ".jsonl"))
      .filter(isValidSessionId)
      .sort((left, right) => left.localeCompare(right));

    return Promise.all(
      sessionIds.map(
        async (sessionId) => (await this.load(sessionId)).metadata,
      ),
    );
  }

  private pathFor(sessionId: string): string {
    assertValidSessionId(sessionId);
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }
}
```

The `access()` plus `appendFile()` pair is sufficient for this single-process stage. Multi-process races are explicitly outside the design scope; the later `SessionCommitter` will serialize in-process append calls.

- [ ] **Step 5: Export the JSONL implementation**

Add to `packages/core/src/index.ts` after the Memory Store export:

```ts
export { JsonlSessionStore } from "./jsonl-session-store.ts";
export type {
  JsonlSessionStoreOptions,
} from "./jsonl-session-store.ts";
```

- [ ] **Step 6: Run both Store contracts and codec tests**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test \
  test/memory-session-store.test.ts \
  test/session-record-codec.test.ts \
  test/jsonl-session-store.test.ts
pnpm --filter @mini-agent/core check
```

Expected: all focused tests PASS and Core type-check PASS.

- [ ] **Step 7: Commit the JSONL Store**

```bash
git add \
  packages/core/src/jsonl-session-store.ts \
  packages/core/src/index.ts \
  packages/core/test/jsonl-session-store.test.ts
git commit -m "feat(core): add JSONL session store" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 5: Verify Persistence Boundaries and Full Repository Health

**Files:**

- Modify: `packages/core/test/jsonl-session-store.test.ts`
- Modify: `packages/core/test/memory-session-store.test.ts`

- [ ] **Step 1: Add a Memory replay-regression test for queue, effect, and reset operations**

Append to `packages/core/test/memory-session-store.test.ts`:

```ts
test("MemorySessionStore delegates queue, effect, and reset semantics to replay", async () => {
  const store = new MemorySessionStore();
  await store.create(metadata());
  await store.append("session-1", [
    {
      type: "commit",
      sequence: 1,
      timestamp: "2026-09-30T00:00:01.000Z",
      operations: [
        {
          type: "effect_started",
          effect: {
            toolCallId: "call-1",
            toolName: "read",
            arguments: { path: "package.json" },
            replay: "never",
          },
        },
      ],
    },
  ]);

  const snapshot = await store.load("session-1");
  assert.deepEqual(
    snapshot.pendingEffects.map((effect) => effect.toolCallId),
    ["call-1"],
  );
  assert.deepEqual(
    snapshot.recoveryWarnings.map((warning) => warning.kind),
    ["unknown"],
  );
});
```

This test does not duplicate all pure replay tests. It proves the Store returns the replayer's derived effect state rather than returning raw records or inventing a second reconstruction path.

- [ ] **Step 2: Add a JSONL valid-unterminated-record test**

Append to `packages/core/test/jsonl-session-store.test.ts`:

```ts
test("JsonlSessionStore keeps a complete final record without newline", async () => {
  const dataDir = await createTempDir();
  const diagnostics: SessionStoreDiagnostic[] = [];
  try {
    const store = new JsonlSessionStore(dataDir, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await store.create(metadata());

    const path = sessionPath(dataDir);
    const headerLine = (await readFile(path, "utf8")).trimEnd();
    const commit = {
      type: "commit",
      sequence: 1,
      timestamp: "2026-09-30T00:00:01.000Z",
      operations: [],
    } as const;
    await writeFile(
      path,
      `${headerLine}\n${JSON.stringify(commit)}`,
      "utf8",
    );

    assert.equal(
      (await store.load("session-1")).metadata.updatedAt,
      commit.timestamp,
    );
    assert.deepEqual(diagnostics, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the complete Core test suite**

Run:

```bash
pnpm --filter @mini-agent/core test
```

Expected: all Core tests PASS, including the pre-existing Session replay, message identity, Agent, queue, retry, and tool execution tests.

- [ ] **Step 4: Run full repository tests and type-check**

Run:

```bash
pnpm test
pnpm check
```

Expected: all workspace tests PASS and all package type-checks PASS.

- [ ] **Step 5: Perform the JSONL learning exercise**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --input-type=module \
  --eval '
    import { mkdtemp, readFile, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { JsonlSessionStore } from "./src/index.ts";

    const dataDir = await mkdtemp(join(tmpdir(), "mini-agent-observe-"));
    const store = new JsonlSessionStore(dataDir);
    const metadata = {
      id: "observe",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    };
    await store.create(metadata);
    await store.append("observe", [{
      type: "commit",
      sequence: 1,
      timestamp: "2026-09-30T00:00:01.000Z",
      operations: [],
    }]);
    console.log(
      await readFile(
        join(dataDir, "sessions", "observe.jsonl"),
        "utf8",
      ),
    );
    await rm(dataDir, { recursive: true, force: true });
  '
```

Expected output: exactly two JSONL objects in order—one `session` Header and one `commit` with `sequence: 1`—with no array wrapper.

- [ ] **Step 6: Commit the final boundary tests**

```bash
git add \
  packages/core/test/memory-session-store.test.ts \
  packages/core/test/jsonl-session-store.test.ts
git commit -m "test(core): verify session store recovery boundaries" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Completion Criteria

- Both Store implementations pass the same contract suite.
- `MemorySessionStore.failNextAppend()` fails exactly one append without changing stored records.
- JSONL files contain one Header followed by newline-delimited Commit Envelopes.
- Unsafe Session IDs cannot escape `<dataDir>/sessions`.
- A malformed unterminated tail is truncated to the last valid byte boundary, reported, and does not poison the next append.
- A malformed complete or middle line fails loudly.
- Replay sequence and operation invariants remain owned by `replaySessionRecords()`.
- Session listing is isolated, deterministic, and reports derived `updatedAt`.
- No Agent, Committer, Server, or Web persistence integration is introduced.
- `pnpm test` and `pnpm check` pass.
