# Context Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a three-stage context preparation pipeline and deterministic request-only compaction to `@mini-agent/core` without changing the observable transcript or server/web protocols.

**Architecture:** `Agent` accepts optional lifecycle hooks and exposes non-destructive queue checks; `runAgentLoop` owns all Turn scheduling and creates immutable snapshots before calling hooks. A new `context.ts` module implements deterministic token estimation and compaction as a normal `TransformContext`, so the Loop never needs to understand budgets or compaction policy.

**Tech Stack:** TypeScript 5.9, Node.js 22 built-in test runner, pnpm workspaces, zero runtime dependencies.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/types.ts` | Public snapshot, hook, estimator, and deterministic compaction contracts |
| `packages/core/src/context.ts` | Stable serialization, heuristic estimation, Turn grouping, deterministic compaction |
| `packages/core/src/agent-loop.ts` | Hook timing, request projection, immutable snapshots, non-destructive next-Turn scheduling |
| `packages/core/src/agent.ts` | Public hook options and queue `hasMessages()` integration |
| `packages/core/src/index.ts` | Public exports for context utilities |
| `packages/core/test/context.test.ts` | Estimator and deterministic compactor behavior |
| `packages/core/test/agent-loop.test.ts` | Hook order, snapshots, queue priority, Turn lifecycle |
| `packages/core/test/agent.test.ts` | Transcript ownership, hook errors, cancellation |
| `packages/core/test/queues.test.ts` | Startup steering and queue observability regression |

Do not modify `packages/server` or `packages/web`. Do not introduce a model-backed summarizer, persistent compaction entry, retry, or overflow recovery.

### Task 1: Add public context contracts

**Files:**
- Modify: `packages/core/src/types.ts:150-250`
- Modify: `packages/core/src/index.ts:1-15`
- Test: `packages/core/test/context.test.ts`

- [ ] **Step 1: Write a failing public-contract test**

Create `packages/core/test/context.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeterministicCompactingTransform,
  createHeuristicTokenEstimator,
} from "../src/index.ts";
import type {
  AgentContextSnapshot,
  AgentMessage,
  ContextPreparation,
  DeterministicCompactingTransformOptions,
  PrepareNextTurn,
  PrepareRequest,
  TokenEstimator,
  TransformContext,
} from "../src/index.ts";

test("context pipeline contracts are publicly available", () => {
  const snapshot: AgentContextSnapshot = {
    messages: [],
    tools: [],
  };
  const preparation: ContextPreparation = { messages: snapshot.messages };
  const prepareRequest: PrepareRequest = async () => preparation;
  const prepareNextTurn: PrepareNextTurn = async () => preparation;
  const transform: TransformContext = async (messages) => messages.slice();
  const options: DeterministicCompactingTransformOptions = {
    maxInputTokens: 100,
    preserveRecentTurns: 1,
  };

  assert.equal(typeof prepareRequest, "function");
  assert.equal(typeof prepareNextTurn, "function");
  assert.equal(typeof transform, "function");
  assert.equal(typeof createHeuristicTokenEstimator(), "object");
  assert.equal(
    typeof createDeterministicCompactingTransform(options),
    "function",
  );
});
```

The imports intentionally fail because the contracts and factories do not exist yet.

- [ ] **Step 2: Run the focused test and type-check to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/core run check
```

Expected: FAIL because `context.ts` exports and the new public types are missing.

- [ ] **Step 3: Add the public types**

In `packages/core/src/types.ts`, add the snapshot and hook contracts after `AgentContext`:

```ts
export interface AgentContextSnapshot {
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly Tool<unknown>[];
}

export interface ContextPreparation {
  messages?: readonly AgentMessage[];
}

export type PrepareRequest = (
  context: AgentContextSnapshot,
  signal: AbortSignal,
) => Promise<ContextPreparation | undefined>;

export type TransformContext = (
  messages: readonly AgentMessage[],
  signal: AbortSignal,
) => Promise<readonly AgentMessage[]>;

export interface TokenEstimator {
  estimate(messages: readonly AgentMessage[]): number;
}

export interface DeterministicCompactingTransformOptions {
  maxInputTokens: number;
  preserveRecentTurns: number;
  maxExcerptCharacters?: number;
  estimator?: TokenEstimator;
}
```

Replace `CompletedTurn` and add `PrepareNextTurn` immediately after it:

```ts
export interface CompletedTurn {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  context: AgentContextSnapshot;
}

export type PrepareNextTurn = (
  turn: CompletedTurn,
  signal: AbortSignal,
) => Promise<ContextPreparation | undefined>;
```

Extend `AgentLoopConfig` only with optional hooks in this task:

```ts
export interface AgentLoopConfig {
  stream: StreamFn;
  getSteeringMessages(): AgentMessage[];
  getFollowUpMessages(): AgentMessage[];
  prepareNextTurn?: PrepareNextTurn;
  prepareRequest?: PrepareRequest;
  transformContext?: TransformContext;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  finishTurn?: FinishTurn;
}
```

Do not add queue peek methods yet; Task 5 adds them together with the scheduler change so the repository stays buildable between commits.

- [ ] **Step 4: Add temporary factory stubs and public exports**

Create `packages/core/src/context.ts` with validated stubs that establish the final signatures:

```ts
import type {
  DeterministicCompactingTransformOptions,
  TokenEstimator,
  TransformContext,
} from "./types.ts";

export function createHeuristicTokenEstimator(): TokenEstimator {
  return {
    estimate: () => 0,
  };
}

export function createDeterministicCompactingTransform(
  options: DeterministicCompactingTransformOptions,
): TransformContext {
  if (!Number.isInteger(options.maxInputTokens) || options.maxInputTokens <= 0) {
    throw new Error("maxInputTokens must be a positive integer");
  }
  if (
    !Number.isInteger(options.preserveRecentTurns) ||
    options.preserveRecentTurns < 0
  ) {
    throw new Error("preserveRecentTurns must be a non-negative integer");
  }

  return async (messages) => messages.slice();
}
```

Add to `packages/core/src/index.ts`:

```ts
export {
  createDeterministicCompactingTransform,
  createHeuristicTokenEstimator,
} from "./context.ts";
```

The existing `export * from "./types.ts"` already publishes the new types.

- [ ] **Step 5: Run tests and type-check**

Run:

```bash
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/core run check
```

Expected: all existing tests and the new contract test PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/context.ts packages/core/src/index.ts packages/core/test/context.test.ts
git commit -m "feat(core): add context pipeline contracts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Implement stable token estimation

**Files:**
- Modify: `packages/core/src/context.ts`
- Modify: `packages/core/test/context.test.ts`

- [ ] **Step 1: Add failing estimator and validation tests**

Append the tests below to `packages/core/test/context.test.ts`; `AgentMessage` and `TokenEstimator` are already part of the type import created in Task 1:

```ts
test("heuristic estimator counts natural text and message overhead", () => {
  const estimator = createHeuristicTokenEstimator();
  const messages: AgentMessage[] = [
    { role: "system", content: "你好ab", timestamp: 1 },
    { role: "user", content: "abcdefgh", timestamp: 2 },
  ];

  assert.equal(estimator.estimate(messages), 13);
});

test("heuristic estimator serializes tool data with sorted keys", () => {
  const estimator = createHeuristicTokenEstimator();
  const first: AgentMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { z: 1, a: 2 },
        },
      ],
      stopReason: "toolUse",
      timestamp: 1,
    },
  ];
  const second: AgentMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { a: 2, z: 1 },
        },
      ],
      stopReason: "toolUse",
      timestamp: 1,
    },
  ];

  assert.equal(estimator.estimate(first), estimator.estimate(second));
});

test("heuristic estimator rejects circular values and bigint", () => {
  const estimator = createHeuristicTokenEstimator();
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  assert.throws(
    () =>
      estimator.estimate([
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-circular",
              name: "tool",
              arguments: circular,
            },
          ],
          stopReason: "toolUse",
          timestamp: 1,
        },
      ]),
    /Cannot serialize circular tool data/,
  );
  assert.throws(
    () =>
      estimator.estimate([
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-bigint",
              name: "tool",
              arguments: 1n,
            },
          ],
          stopReason: "toolUse",
          timestamp: 1,
        },
      ]),
    /Cannot serialize bigint tool data/,
  );
});

test("compacting transform validates all numeric options", () => {
  const invalidOptions: DeterministicCompactingTransformOptions[] = [
    { maxInputTokens: 0, preserveRecentTurns: 1 },
    { maxInputTokens: 10, preserveRecentTurns: -1 },
    {
      maxInputTokens: 10,
      preserveRecentTurns: 1,
      maxExcerptCharacters: 0,
    },
  ];

  for (const options of invalidOptions) {
    assert.throws(() => createDeterministicCompactingTransform(options));
  }
});

function messageCountEstimator(): TokenEstimator {
  return { estimate: (messages) => messages.length };
}
```

The first expected value is: two message overheads (`8`) + `"你好ab"` (`3`) + `"abcdefgh"` (`2`) = `13`.

- [ ] **Step 2: Run the focused test to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/context.test.ts
```

Expected: FAIL because the estimator still returns zero and `maxExcerptCharacters` is not validated.

- [ ] **Step 3: Implement stable serialization and estimation**

Replace the estimator stub in `packages/core/src/context.ts` with focused helpers:

```ts
import type {
  AgentMessage,
  DeterministicCompactingTransformOptions,
  TokenEstimator,
  TransformContext,
} from "./types.ts";

const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const UNDEFINED_SENTINEL = "[undefined]";

function stableSerialize(value: unknown): string {
  const ancestors = new Set<object>();

  function normalize(current: unknown): unknown {
    if (current === undefined) return UNDEFINED_SENTINEL;
    if (typeof current === "bigint") {
      throw new Error("Cannot serialize bigint tool data");
    }
    if (typeof current === "function" || typeof current === "symbol") {
      throw new Error(`Cannot serialize ${typeof current} tool data`);
    }
    if (current === null || typeof current !== "object") return current;
    if (ancestors.has(current)) {
      throw new Error("Cannot serialize circular tool data");
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((item) => normalize(item));
      }

      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(current).sort()) {
        normalized[key] = normalize(
          (current as Record<string, unknown>)[key],
        );
      }
      return normalized;
    } finally {
      ancestors.delete(current);
    }
  }

  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) {
    throw new Error("Cannot serialize tool data");
  }
  return serialized;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function estimateNaturalText(value: string): number {
  let cjk = 0;
  let other = 0;
  for (const character of value) {
    if (CJK_CHARACTER.test(character)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function estimateStructuredText(value: string): number {
  return Math.ceil(codePointLength(value) / 3);
}

function estimateMessage(message: AgentMessage): number {
  let tokens = 4;

  if (message.role === "system" || message.role === "user") {
    return tokens + estimateNaturalText(message.content);
  }
  if (message.role === "toolResult") {
    tokens += estimateStructuredText(message.toolName);
    tokens += estimateStructuredText(message.content);
    if ("details" in message) {
      tokens += estimateStructuredText(stableSerialize(message.details));
    }
    return tokens;
  }

  for (const content of message.content) {
    if (content.type === "text") {
      tokens += estimateNaturalText(content.text);
    } else {
      tokens += estimateStructuredText(content.name);
      tokens += estimateStructuredText(stableSerialize(content.arguments));
    }
  }
  return tokens;
}

export function createHeuristicTokenEstimator(): TokenEstimator {
  return {
    estimate(messages) {
      return messages.reduce(
        (total, message) => total + estimateMessage(message),
        0,
      );
    },
  };
}
```

Keep these helpers module-private; only the estimator factory is public.

- [ ] **Step 4: Complete option validation**

At the start of `createDeterministicCompactingTransform()` add:

```ts
  const maxExcerptCharacters = options.maxExcerptCharacters ?? 120;
  if (
    !Number.isInteger(maxExcerptCharacters) ||
    maxExcerptCharacters <= 0
  ) {
    throw new Error("maxExcerptCharacters must be a positive integer");
  }
```

- [ ] **Step 5: Run focused and full core validation**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/context.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/context.ts packages/core/test/context.test.ts
git commit -m "feat(core): add heuristic token estimator" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Implement deterministic compaction

**Files:**
- Modify: `packages/core/src/context.ts`
- Modify: `packages/core/test/context.test.ts`

- [ ] **Step 1: Add failing no-op and basic compaction tests**

Append:

```ts
test("compacting transform returns a new array below budget", async () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "system", timestamp: 1 },
    { role: "user", content: "hello", timestamp: 2 },
  ];
  const transform = createDeterministicCompactingTransform({
    maxInputTokens: 3,
    preserveRecentTurns: 1,
    estimator: messageCountEstimator(),
  });

  const result = await transform(messages, new AbortController().signal);

  assert.deepEqual(result, messages);
  assert.notEqual(result, messages);
});

test("compacting transform replaces old turns and preserves recent turns", async () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "system", timestamp: 1 },
    { role: "user", content: "old user", timestamp: 2 },
    {
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
      stopReason: "stop",
      timestamp: 3,
    },
    { role: "user", content: "recent user", timestamp: 4 },
    {
      role: "assistant",
      content: [{ type: "text", text: "recent answer" }],
      stopReason: "stop",
      timestamp: 5,
    },
  ];
  const transform = createDeterministicCompactingTransform({
    maxInputTokens: 4,
    preserveRecentTurns: 1,
    estimator: messageCountEstimator(),
  });

  const result = await transform(messages, new AbortController().signal);

  assert.deepEqual(
    result.map((message) => message.role),
    ["system", "system", "user", "assistant"],
  );
  assert.match(
    result[1]?.role === "system" ? result[1].content : "",
    /\[Earlier context compacted\][\s\S]*Users: 1[\s\S]*Assistants: 1/,
  );
  assert.equal(result[2], messages[3]);
  assert.equal(result[3], messages[4]);
});
```

- [ ] **Step 2: Add failing segmentation, excerpt, and error tests**

Append:

```ts
test("system messages split compacted segments without moving", async () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "initial", timestamp: 1 },
    { role: "user", content: "before update", timestamp: 2 },
    {
      role: "assistant",
      content: [{ type: "text", text: "before answer" }],
      stopReason: "stop",
      timestamp: 3,
    },
    { role: "system", content: "policy update", timestamp: 4 },
    { role: "user", content: "after update", timestamp: 5 },
    {
      role: "assistant",
      content: [{ type: "text", text: "after answer" }],
      stopReason: "stop",
      timestamp: 6,
    },
    { role: "user", content: "current", timestamp: 7 },
  ];
  const transform = createDeterministicCompactingTransform({
    maxInputTokens: 5,
    preserveRecentTurns: 0,
    estimator: messageCountEstimator(),
  });

  const result = await transform(messages, new AbortController().signal);

  assert.deepEqual(
    result.map((message) =>
      message.role === "system" ? message.content.split("\n")[0] : message.role,
    ),
    [
      "initial",
      "[Earlier context compacted]",
      "policy update",
      "[Earlier context compacted]",
      "user",
    ],
  );
});

test("deterministic summary reports tools, errors, and code-point excerpts", async () => {
  const messages: AgentMessage[] = [
    {
      role: "user",
      content: "line one\n😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀",
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-read",
          name: "read",
          arguments: { z: 1, a: 2 },
        },
      ],
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read",
      content: "missing file",
      isError: true,
      timestamp: 3,
    },
    { role: "user", content: "tail", timestamp: 4 },
  ];
  const transform = createDeterministicCompactingTransform({
    maxInputTokens: 2,
    preserveRecentTurns: 0,
    maxExcerptCharacters: 20,
    estimator: messageCountEstimator(),
  });

  const result = await transform(messages, new AbortController().signal);
  const summary = result[0];

  assert.equal(summary?.role, "system");
  if (summary?.role !== "system") return;
  assert.match(summary.content, /Messages: 3/);
  assert.match(summary.content, /Tools used: read/);
  assert.match(summary.content, /Errors: read/);
  assert.match(summary.content, /user: line one 😀/);
  assert.match(summary.content, /read\(\{"a":2,"z":1\}\)/);
  assert.equal(Array.from(summary.content).includes("\ud83d"), false);
});

test("compaction fails when no old region exists or result remains over budget", async () => {
  const noOldRegion = createDeterministicCompactingTransform({
    maxInputTokens: 1,
    preserveRecentTurns: 1,
    estimator: messageCountEstimator(),
  });
  await assert.rejects(
    noOldRegion(
      [
        { role: "user", content: "current", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          stopReason: "stop",
          timestamp: 2,
        },
      ],
      new AbortController().signal,
    ),
    /No context messages can be compacted/,
  );

  const alwaysOverBudget: TokenEstimator = { estimate: () => 999 };
  const remainsOver = createDeterministicCompactingTransform({
    maxInputTokens: 10,
    preserveRecentTurns: 0,
    estimator: alwaysOverBudget,
  });
  await assert.rejects(
    remainsOver(
      [
        { role: "user", content: "old", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          stopReason: "stop",
          timestamp: 2,
        },
        { role: "user", content: "tail", timestamp: 3 },
      ],
      new AbortController().signal,
    ),
    /Context remains over budget after deterministic compaction/,
  );
});
```

- [ ] **Step 3: Run the focused test to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/context.test.ts
```

Expected: FAIL because the transform is still a no-op.

- [ ] **Step 4: Implement Turn discovery and compaction segments**

Add module-private structures and helpers to `context.ts`:

```ts
interface Turn {
  indices: number[];
}

function findTurns(messages: readonly AgentMessage[]): {
  turns: Turn[];
  incompleteIndices: number[];
} {
  const turns: Turn[] = [];
  let pendingUsers: number[] = [];
  let activeTurn: Turn | undefined;
  const incomplete = new Set<number>();

  function finishActiveTurn(): void {
    if (activeTurn) turns.push(activeTurn);
    activeTurn = undefined;
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role === "system") continue;

    if (message.role === "user") {
      finishActiveTurn();
      pendingUsers.push(index);
      continue;
    }
    if (message.role === "assistant") {
      finishActiveTurn();
      activeTurn = { indices: [...pendingUsers, index] };
      pendingUsers = [];
      continue;
    }
    if (activeTurn) {
      activeTurn.indices.push(index);
    } else {
      incomplete.add(index);
    }
  }

  finishActiveTurn();
  for (const index of pendingUsers) incomplete.add(index);
  return { turns, incompleteIndices: [...incomplete] };
}

function selectOldIndices(
  messages: readonly AgentMessage[],
  preserveRecentTurns: number,
): Set<number> {
  const { turns, incompleteIndices } = findTurns(messages);
  const preserved = new Set(incompleteIndices);
  const recentTurns =
    preserveRecentTurns === 0
      ? []
      : turns.slice(-preserveRecentTurns);
  for (const turn of recentTurns) {
    for (const index of turn.indices) preserved.add(index);
  }

  const old = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role !== "system" && !preserved.has(index)) {
      old.add(index);
    }
  }
  return old;
}
```

Build the result in one pass. Consecutive old indices form one segment; any System Message or preserved message flushes the segment:

```ts
function replaceOldSegments(
  messages: readonly AgentMessage[],
  oldIndices: ReadonlySet<number>,
  maxExcerptCharacters: number,
): AgentMessage[] {
  const result: AgentMessage[] = [];
  let segment: AgentMessage[] = [];

  function flush(): void {
    if (segment.length === 0) return;
    result.push(createCompactionMessage(segment, maxExcerptCharacters));
    segment = [];
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (oldIndices.has(index)) {
      segment.push(message);
    } else {
      flush();
      result.push(message);
    }
  }
  flush();
  return result;
}
```

- [ ] **Step 5: Implement deterministic summary formatting**

Add helpers:

```ts
function uniqueInOrder(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function truncateExcerpt(value: string, maximum: number): string {
  const normalized = value.replace(/[\r\n]+/g, " ");
  const codePoints = Array.from(normalized);
  return codePoints.length <= maximum
    ? normalized
    : `${codePoints.slice(0, maximum).join("")}...`;
}

function assistantExcerpt(message: Extract<AgentMessage, { role: "assistant" }>): string {
  return message.content
    .map((content) =>
      content.type === "text"
        ? content.text
        : `${content.name}(${stableSerialize(content.arguments)})`,
    )
    .join(" ");
}

function createCompactionMessage(
  segmentMessages: readonly AgentMessage[],
  maxExcerptCharacters: number,
): AgentMessage {
  const users = segmentMessages.filter((message) => message.role === "user");
  const assistants = segmentMessages.filter(
    (message) => message.role === "assistant",
  );
  const toolResults = segmentMessages.filter(
    (message) => message.role === "toolResult",
  );
  const tools = uniqueInOrder([
    ...assistants.flatMap((message) =>
      message.content
        .filter((content) => content.type === "toolCall")
        .map((content) => content.name),
    ),
    ...toolResults.map((message) => message.toolName),
  ]);
  const errors = uniqueInOrder(
    toolResults
      .filter((message) => message.isError)
      .map((message) => message.toolName),
  );
  const excerpts: string[] = [];
  const user = users.at(-1);
  const assistant = assistants.at(-1);
  const toolResult = toolResults.at(-1);
  if (user) {
    excerpts.push(
      `- user: ${truncateExcerpt(user.content, maxExcerptCharacters)}`,
    );
  }
  if (assistant) {
    excerpts.push(
      `- assistant: ${truncateExcerpt(
        assistantExcerpt(assistant),
        maxExcerptCharacters,
      )}`,
    );
  }
  if (toolResult) {
    excerpts.push(
      `- toolResult(${toolResult.toolName}): ${truncateExcerpt(
        toolResult.content,
        maxExcerptCharacters,
      )}`,
    );
  }

  return {
    role: "system",
    content: [
      "[Earlier context compacted]",
      `Messages: ${segmentMessages.length}`,
      `Users: ${users.length}`,
      `Assistants: ${assistants.length}`,
      `Tool results: ${toolResults.length}`,
      `Tools used: ${tools.join(", ") || "none"}`,
      `Errors: ${errors.join(", ") || "none"}`,
      "Recent excerpts:",
      ...excerpts,
    ].join("\n"),
    timestamp: segmentMessages.at(-1)?.timestamp ?? 0,
  };
}
```

- [ ] **Step 6: Complete the transform implementation**

Replace the no-op return:

```ts
  const estimator = options.estimator ?? createHeuristicTokenEstimator();

  return async (messages, signal) => {
    signal.throwIfAborted();
    const original = messages.slice();
    if (estimator.estimate(original) <= options.maxInputTokens) {
      return original;
    }

    const oldIndices = selectOldIndices(
      original,
      options.preserveRecentTurns,
    );
    if (oldIndices.size === 0) {
      throw new Error("No context messages can be compacted");
    }

    const compacted = replaceOldSegments(
      original,
      oldIndices,
      maxExcerptCharacters,
    );
    if (estimator.estimate(compacted) > options.maxInputTokens) {
      throw new Error(
        "Context remains over budget after deterministic compaction",
      );
    }
    return compacted;
  };
```

- [ ] **Step 7: Run focused tests and type-check**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/context.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: PASS with the explicit message-count budgets used by the tests.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/context.ts packages/core/test/context.test.ts
git commit -m "feat(core): add deterministic context compaction" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Add request preparation and projection to the Loop

**Files:**
- Modify: `packages/core/src/agent-loop.ts:20-80`
- Modify: `packages/core/test/agent-loop.test.ts`

- [ ] **Step 1: Add failing hook-order and request-isolation tests**

Append to `packages/core/test/agent-loop.test.ts`:

```ts
test("first Turn runs prepareRequest then transformContext then stream", async () => {
  const order: string[] = [];
  const received: AgentMessage[][] = [];
  const stream: StreamFn = async function* (messages) {
    order.push("stream");
    received.push(messages.slice());
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      timestamp: 3,
    };
    yield { type: "start", message };
    yield { type: "end", message };
  };
  const context = {
    messages: [{ role: "system", content: "system", timestamp: 1 }] as AgentMessage[],
    tools: [],
  };

  await runAgentLoop(
    [{ role: "user", content: "original", timestamp: 2 }],
    context,
    {
      stream,
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      prepareRequest: async (snapshot) => {
        order.push("prepareRequest");
        return {
          messages: [
            ...snapshot.messages,
            { role: "user", content: "prepared", timestamp: 20 },
          ],
        };
      },
      transformContext: async (messages) => {
        order.push("transformContext");
        return messages.filter(
          (message) =>
            message.role !== "user" || message.content !== "original",
        );
      },
    },
    async () => {},
    new AbortController().signal,
  );

  assert.deepEqual(order, ["prepareRequest", "transformContext", "stream"]);
  assert.equal(
    received[0]?.some(
      (message) => message.role === "user" && message.content === "original",
    ),
    false,
  );
  assert.equal(
    context.messages.some(
      (message) => message.role === "user" && message.content === "original",
    ),
    true,
  );
  assert.equal(
    context.messages.some(
      (message) => message.role === "user" && message.content === "prepared",
    ),
    true,
  );
});

test("transformContext never mutates the working transcript", async () => {
  const context = {
    messages: [{ role: "system", content: "system", timestamp: 1 }] as AgentMessage[],
    tools: [],
  };

  await runAgentLoop(
    [{ role: "user", content: "keep me", timestamp: 2 }],
    context,
    {
      stream: createMockStream(),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      transformContext: async (messages) =>
        messages.filter((message) => message.role === "user"),
    },
    async () => {},
    new AbortController().signal,
  );

  assert.deepEqual(
    context.messages.slice(0, 2).map((message) => message.role),
    ["system", "user"],
  );
});
```

The first test intentionally proves that `prepareRequest` changes the Run working copy, while `transformContext` only changes the model request.

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/agent-loop.test.ts
```

Expected: FAIL because neither hook is called.

- [ ] **Step 3: Add snapshot and preparation helpers**

In `agent-loop.ts`, import `AgentContextSnapshot` and add:

```ts
function snapshotContext(context: AgentContext): AgentContextSnapshot {
  return {
    messages: context.messages.slice(),
    tools: context.tools.slice(),
  };
}

function applyPreparation(
  context: AgentContext,
  preparation: { messages?: readonly AgentMessage[] } | undefined,
): void {
  if (preparation?.messages) {
    context.messages = preparation.messages.slice();
  }
}
```

- [ ] **Step 4: Prepare request messages before streaming**

At the start of `streamAssistantResponse()`:

```ts
  signal.throwIfAborted();
  const preparation = await config.prepareRequest?.(
    snapshotContext(context),
    signal,
  );
  applyPreparation(context, preparation);
  signal.throwIfAborted();
  const transformed = config.transformContext
    ? await config.transformContext(context.messages, signal)
    : context.messages;
  const requestMessages = transformed.slice();
```

Change:

```ts
for await (const modelEvent of config.stream(context.messages, signal)) {
```

to:

```ts
for await (const modelEvent of config.stream(requestMessages, signal)) {
```

Do not append transformed messages to `context.messages`; only append the final Assistant message as before.

- [ ] **Step 5: Run focused and full Loop tests**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/agent-loop.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agent-loop.ts packages/core/test/agent-loop.test.ts
git commit -m "feat(core): project model request context" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Make next-Turn scheduling non-destructive

**Files:**
- Modify: `packages/core/src/types.ts:220-250`
- Modify: `packages/core/src/agent.ts:30-280`
- Modify: `packages/core/src/agent-loop.ts:180-310`
- Modify: `packages/core/test/agent-loop.test.ts`
- Modify: `packages/core/test/queues.test.ts`

- [ ] **Step 1: Add failing scheduling and ordering tests**

Add a local helper near the top of `agent-loop.test.ts`:

```ts
function emptyQueueConfig(stream: StreamFn) {
  return {
    stream,
    getSteeringMessages: () => [] as AgentMessage[],
    getFollowUpMessages: () => [] as AgentMessage[],
    hasSteeringMessages: () => false,
    hasFollowUpMessages: () => false,
  };
}
```

Update existing direct `runAgentLoop` configs to include the two `has...` methods, then append:

```ts
test("later Turn starts before prepareNextTurn and preserves hook order", async () => {
  const order: string[] = [];
  let streamCount = 0;
  const stream: StreamFn = async function* () {
    streamCount += 1;
    order.push(`stream:${streamCount}`);
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: `turn ${streamCount}` }],
      stopReason: "stop",
      timestamp: streamCount,
    };
    yield { type: "start", message };
    yield { type: "end", message };
  };

  await runAgentLoop(
    [{ role: "user", content: "start", timestamp: 1 }],
    { messages: [], tools: [] },
    {
      ...emptyQueueConfig(stream),
      prepareNextTurn: async () => {
        order.push("prepareNextTurn");
        return undefined;
      },
      prepareRequest: async () => {
        order.push("prepareRequest");
        return undefined;
      },
      transformContext: async (messages) => {
        order.push("transformContext");
        return messages;
      },
      finishTurn: async () =>
        streamCount === 1 ? { action: "continue" } : undefined,
    },
    async (event) => {
      if (event.type === "turn_start") order.push("turn_start");
    },
    new AbortController().signal,
  );

  assert.deepEqual(order, [
    "turn_start",
    "prepareRequest",
    "transformContext",
    "stream:1",
    "turn_start",
    "prepareNextTurn",
    "prepareRequest",
    "transformContext",
    "stream:2",
  ]);
});

test("steering arriving during prepareNextTurn wins over queued follow-up", async () => {
  const steering: AgentMessage[] = [];
  const followUps: AgentMessage[] = [
    { role: "user", content: "follow-up", timestamp: 10 },
  ];
  const seenRequests: string[][] = [];
  let streamCount = 0;
  const stream: StreamFn = async function* (messages) {
    streamCount += 1;
    seenRequests.push(
      messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    );
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: `turn ${streamCount}` }],
      stopReason: "stop",
      timestamp: streamCount,
    };
    yield { type: "start", message };
    yield { type: "end", message };
  };

  await runAgentLoop(
    [{ role: "user", content: "initial", timestamp: 1 }],
    { messages: [], tools: [] },
    {
      stream,
      getSteeringMessages: () => steering.splice(0, 1),
      getFollowUpMessages: () => followUps.splice(0, 1),
      hasSteeringMessages: () => steering.length > 0,
      hasFollowUpMessages: () => followUps.length > 0,
      prepareNextTurn: async () => {
        if (streamCount === 1) {
          steering.push({
            role: "user",
            content: "steering",
            timestamp: 11,
          });
        }
        return undefined;
      },
    },
    async () => {},
    new AbortController().signal,
  );

  assert.deepEqual(seenRequests, [
    ["initial"],
    ["initial", "steering"],
    ["initial", "steering", "follow-up"],
  ]);
});
```

In `queues.test.ts`, add:

```ts
test("steering queued before prompt is included in the first Turn", async () => {
  const requests: AgentMessage[][] = [];
  const agent = new Agent({
    systemPrompt: "test",
    stream: async function* (messages) {
      requests.push(messages.slice());
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "done" }],
        stopReason: "stop" as const,
        timestamp: 1,
      };
      yield { type: "start", message };
      yield { type: "end", message };
    },
    tools: [],
  });
  agent.steer("queued steering");

  await agent.prompt("initial");

  assert.deepEqual(
    requests[0]
      ?.filter((message) => message.role === "user")
      .map((message) => message.content),
    ["initial", "queued steering"],
  );
});
```

- [ ] **Step 2: Run Loop and queue tests to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/agent-loop.test.ts test/queues.test.ts
```

Expected: type-check or test FAIL because queue peek methods and `prepareNextTurn` scheduling are not implemented.

- [ ] **Step 3: Add non-destructive queue contracts**

Extend `AgentLoopConfig`:

```ts
  hasSteeringMessages(): boolean;
  hasFollowUpMessages(): boolean;
```

Add to `MessageQueue` in `agent.ts`:

```ts
  hasMessages(): boolean {
    return this.messages.length > 0;
  }
```

Extend `createConfig()`:

```ts
      hasSteeringMessages: () => this.steeringQueue.hasMessages(),
      hasFollowUpMessages: () => this.followUpQueue.hasMessages(),
```

Update every direct `runAgentLoop` config in tests with deterministic `has...` methods. Use the actual backing array length when a test has a mutable queue; do not return a hard-coded value in those tests.

- [ ] **Step 4: Replace destructive look-ahead with an explicit next-Turn loop**

Refactor the scheduling portion of `runAgentLoop()` around this shape:

```ts
  let completedTurn: CompletedTurn | undefined;
  let firstTurn = true;
  let toolResultsPending = false;
  let pendingMessages = config.getSteeringMessages();

  while (true) {
    if (!firstTurn) {
      if (!completedTurn) {
        throw new Error("Missing completed Turn before next Turn");
      }
      await emit({ type: "turn_start" });
      signal.throwIfAborted();
      const preparation = await config.prepareNextTurn?.(
        completedTurn,
        signal,
      );
      applyPreparation(context, preparation);
      pendingMessages = [];
      if (config.hasSteeringMessages()) {
        pendingMessages = config.getSteeringMessages();
      } else if (!toolResultsPending && config.hasFollowUpMessages()) {
        pendingMessages = config.getFollowUpMessages();
      }
    }
    firstTurn = false;

    for (const message of pendingMessages) {
      await emitMessage(message, emit);
      context.messages.push(message);
    }

    const assistant = await streamAssistantResponse(
      context,
      config,
      emit,
      signal,
    );
    const toolCalls = assistant.content.filter(
      (content): content is ToolCall => content.type === "toolCall",
    );
    const toolResults: ToolResultMessage[] = [];
    for (const toolCall of toolCalls) {
      toolResults.push(
        await executeToolCall(context, toolCall, config, emit, signal),
      );
    }

    completedTurn = {
      message: assistant,
      toolResults: toolResults.slice(),
      context: snapshotContext(context),
    };
    const decision = await config.finishTurn?.(completedTurn, signal);
    await emit({ type: "turn_end", message: assistant, toolResults });

    if (decision?.action === "end") {
      await emit({ type: "agent_end", messages: context.messages.slice() });
      return;
    }

    toolResultsPending = toolResults.length > 0;
    const hasNextTurn =
      toolResultsPending ||
      config.hasSteeringMessages() ||
      (!toolResultsPending && config.hasFollowUpMessages()) ||
      decision?.action === "continue";
    if (!hasNextTurn) break;
  }
```

Important details:

- Do not call `prepareNextTurn` for the first Turn.
- Initialize `pendingMessages` from `getSteeringMessages()` once before the loop; this is the only queue consumption allowed for the first Turn.
- Never inspect or consume follow-up during the first Turn.
- Emit `turn_start` before `prepareNextTurn`.
- Drain steering only after `prepareNextTurn`.
- If a follow-up caused the next Turn but steering arrives during the Hook, steering is consumed and the follow-up remains queued.
- A Turn caused by tool results does not consume follow-up.
- Reset `toolResultsPending` after entering the Turn; it is only a scheduling reason, not durable state.

- [ ] **Step 5: Run scheduler regression tests**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/agent-loop.test.ts test/queues.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: PASS, including the pre-existing tool, follow-up, and explicit continuation tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/agent.ts packages/core/src/agent-loop.ts packages/core/test/agent-loop.test.ts packages/core/test/queues.test.ts
git commit -m "refactor(core): schedule context preparation at Turn boundaries" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 6: Wire Agent hooks and verify ownership, snapshots, errors, and cancellation

**Files:**
- Modify: `packages/core/src/agent.ts:15-80,220-280`
- Modify: `packages/core/test/agent.test.ts`
- Modify: `packages/core/test/agent-loop.test.ts`

- [ ] **Step 1: Add failing Agent ownership and error tests**

Append to `agent.test.ts`:

```ts
test("Agent transform changes model input without changing transcript", async () => {
  const requests: AgentMessage[][] = [];
  const agent = new Agent({
    systemPrompt: "system",
    stream: async function* (messages) {
      requests.push(messages.slice());
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "done" }],
        stopReason: "stop" as const,
        timestamp: 3,
      };
      yield { type: "start", message };
      yield { type: "end", message };
    },
    tools: [],
    transformContext: async (messages) =>
      messages.filter((message) => message.role !== "system"),
  });

  await agent.prompt("hello");

  assert.deepEqual(
    requests[0]?.map((message) => message.role),
    ["user"],
  );
  assert.deepEqual(
    agent.state.messages.map((message) => message.role),
    ["system", "user", "assistant"],
  );
});

test("temporary transformed messages do not emit lifecycle events", async () => {
  const ended: AgentMessage[] = [];
  const agent = new Agent({
    systemPrompt: "system",
    stream: createMockStream(),
    tools: [],
    transformContext: async (messages) => [
      ...messages,
      {
        role: "system",
        content: "[Earlier context compacted]",
        timestamp: 2,
      },
    ],
  });
  agent.subscribe((event) => {
    if (event.type === "message_end") ended.push(event.message);
  });

  await agent.prompt("hello");

  assert.equal(
    ended.some(
      (message) =>
        message.role === "system" &&
        message.content === "[Earlier context compacted]",
    ),
    false,
  );
});

test("prepareRequest can replace working messages without deleting Agent history", async () => {
  const requests: AgentMessage[][] = [];
  const agent = new Agent({
    systemPrompt: "system",
    stream: async function* (messages) {
      requests.push(messages.slice());
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "done" }],
        stopReason: "stop" as const,
        timestamp: 3,
      };
      yield { type: "start", message };
      yield { type: "end", message };
    },
    tools: [],
    prepareRequest: async (snapshot) => ({
      messages: snapshot.messages.filter(
        (message) => message.role !== "user",
      ),
    }),
  });

  await agent.prompt("keep in transcript");

  assert.deepEqual(
    requests[0]?.map((message) => message.role),
    ["system"],
  );
  assert.equal(
    agent.state.messages.some(
      (message) =>
        message.role === "user" &&
        message.content === "keep in transcript",
    ),
    true,
  );
});

test("prepareRequest errors become error Assistant messages", async () => {
  const agent = new Agent({
    systemPrompt: "system",
    stream: createMockStream(),
    tools: [],
    prepareRequest: async () => {
      throw new Error("prepare request exploded");
    },
  });

  await agent.prompt("hello");

  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  if (final?.role !== "assistant") return;
  assert.equal(final.stopReason, "error");
  assert.equal(final.errorMessage, "prepare request exploded");
});

test("aborting a slow prepareRequest produces an aborted Assistant message", async () => {
  const agent = new Agent({
    systemPrompt: "system",
    stream: createMockStream(),
    tools: [],
    prepareRequest: async (_context, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return undefined;
    },
  });

  const running = agent.prompt("hello");
  setTimeout(() => agent.abort(), 5);
  await running;

  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  if (final?.role !== "assistant") return;
  assert.equal(final.stopReason, "aborted");
});

test("aborting a slow transformContext produces an aborted Assistant message", async () => {
  const agent = new Agent({
    systemPrompt: "system",
    stream: createMockStream(),
    tools: [],
    transformContext: async (_messages, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return [];
    },
  });

  const running = agent.prompt("hello");
  setTimeout(() => agent.abort(), 5);
  await running;

  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  if (final?.role !== "assistant") return;
  assert.equal(final.stopReason, "aborted");
});

test("aborting a slow prepareNextTurn produces an aborted Assistant message", async () => {
  let turns = 0;
  const agent = new Agent({
    systemPrompt: "system",
    stream: createMockStream(),
    tools: [],
    finishTurn: async () => {
      turns += 1;
      return turns === 1 ? { action: "continue" } : undefined;
    },
    prepareNextTurn: async (_turn, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return undefined;
    },
  });

  const running = agent.prompt("hello");
  setTimeout(() => agent.abort(), 5);
  await running;

  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  if (final?.role !== "assistant") return;
  assert.equal(final.stopReason, "aborted");
});
```

Add missing imports:

```ts
import type {
  AgentEvent,
  AgentMessage,
  StreamFn,
  Tool,
} from "../src/types.ts";
```

- [ ] **Step 2: Add failing snapshot and Turn-pairing tests**

Append to `agent-loop.test.ts`:

```ts
test("CompletedTurn context remains stable after later context changes", async () => {
  const collected: Array<readonly AgentMessage[]> = [];
  let turns = 0;

  await runAgentLoop(
    [{ role: "user", content: "start", timestamp: 1 }],
    { messages: [], tools: [] },
    {
      ...emptyQueueConfig(createMockStream()),
      finishTurn: async (turn) => {
        collected.push(turn.context.messages);
        turns += 1;
        return turns === 1 ? { action: "continue" } : undefined;
      },
      prepareNextTurn: async () => ({
        messages: [{ role: "user", content: "rebuilt", timestamp: 10 }],
      }),
    },
    async () => {},
    new AbortController().signal,
  );

  assert.deepEqual(
    collected[0]?.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.equal(
    collected[0]?.some(
      (message) => message.role === "user" && message.content === "rebuilt",
    ),
    false,
  );
});

test("prepareNextTurn failure has paired Turn lifecycle events", async () => {
  const events: AgentEvent[] = [];
  let turns = 0;
  const context = { messages: [] as AgentMessage[], tools: [] };

  await assert.rejects(
    runAgentLoop(
      [{ role: "user", content: "start", timestamp: 1 }],
      context,
      {
        ...emptyQueueConfig(createMockStream()),
        finishTurn: async () => {
          turns += 1;
          return turns === 1 ? { action: "continue" } : undefined;
        },
        prepareNextTurn: async () => {
          throw new Error("next Turn preparation failed");
        },
      },
      async (event) => {
        events.push(event);
      },
      new AbortController().signal,
    ),
    /next Turn preparation failed/,
  );

  assert.equal(
    events.filter((event) => event.type === "turn_start").length,
    2,
  );
  assert.equal(
    events.filter((event) => event.type === "turn_end").length,
    1,
  );
});
```

The direct Loop throws before it can emit the second `turn_end`; `Agent.emitFailure()` supplies that paired failure `turn_end` in the public API. Add an Agent-level companion test:

```ts
test("prepareNextTurn failure becomes a paired error Turn", async () => {
  const events: AgentEvent[] = [];
  let turns = 0;
  const agent = new Agent({
    systemPrompt: "system",
    stream: createMockStream(),
    tools: [],
    finishTurn: async () => {
      turns += 1;
      return turns === 1 ? { action: "continue" } : undefined;
    },
    prepareNextTurn: async () => {
      throw new Error("next Turn preparation failed");
    },
  });
  agent.subscribe((event) => {
    events.push(event);
  });

  await agent.prompt("hello");

  assert.equal(
    events.filter((event) => event.type === "turn_start").length,
    2,
  );
  assert.equal(
    events.filter((event) => event.type === "turn_end").length,
    2,
  );
  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  if (final?.role !== "assistant") return;
  assert.equal(final.stopReason, "error");
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/agent.test.ts test/agent-loop.test.ts
```

Expected: FAIL because `AgentOptions` does not accept or forward the new hooks.

- [ ] **Step 4: Wire hooks through Agent**

Extend imports in `agent.ts`:

```ts
  PrepareNextTurn,
  PrepareRequest,
  TransformContext,
```

Extend `AgentOptions`:

```ts
  prepareNextTurn?: PrepareNextTurn;
  prepareRequest?: PrepareRequest;
  transformContext?: TransformContext;
```

Add private fields:

```ts
  private readonly prepareNextTurn?: PrepareNextTurn;
  private readonly prepareRequest?: PrepareRequest;
  private readonly transformContext?: TransformContext;
```

Assign them in the constructor:

```ts
    this.prepareNextTurn = options.prepareNextTurn;
    this.prepareRequest = options.prepareRequest;
    this.transformContext = options.transformContext;
```

Forward them from `createConfig()`:

```ts
      prepareNextTurn: this.prepareNextTurn,
      prepareRequest: this.prepareRequest,
      transformContext: this.transformContext,
```

Do not add Turn tracking state to `Agent`; the Loop already emits the second `turn_start` before invoking `prepareNextTurn`.

- [ ] **Step 5: Verify returned Hook arrays are copied**

Append to `agent-loop.test.ts`:

```ts
test("Loop copies messages returned by preparation hooks", async () => {
  const returned: AgentMessage[] = [
    { role: "user", content: "prepared", timestamp: 1 },
  ];
  const context = { messages: [] as AgentMessage[], tools: [] };

  await runAgentLoop(
    [],
    context,
    {
      ...emptyQueueConfig(createMockStream()),
      prepareRequest: async () => ({ messages: returned }),
    },
    async () => {},
    new AbortController().signal,
  );

  returned.push({
    role: "user",
    content: "late mutation",
    timestamp: 2,
  });
  assert.equal(
    context.messages.some(
      (message) =>
        message.role === "user" && message.content === "late mutation",
    ),
    false,
  );
});
```

- [ ] **Step 6: Run core tests and type-check**

Run:

```bash
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/core run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent.ts packages/core/src/agent-loop.ts packages/core/test/agent.test.ts packages/core/test/agent-loop.test.ts
git commit -m "feat(core): expose context lifecycle hooks" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 7: Run repository-level regression checks

**Files:**
- Verify: `packages/core/src/index.ts`
- Verify: `packages/server`
- Verify: `packages/web`

- [ ] **Step 1: Run the complete core test suite**

Run:

```bash
pnpm --filter @mini-agent/core run test
```

Expected: all `packages/core/test/*.test.ts` tests PASS with zero failures.

- [ ] **Step 2: Run the complete workspace type-check**

Run:

```bash
pnpm run check
```

Expected: `@mini-agent/core`, server, web, and any other workspace package checks PASS. This proves the new required `AgentLoopConfig` queue methods are contained behind the internal Loop API and public type exports do not break consumers.

- [ ] **Step 3: Run the complete workspace tests**

Run:

```bash
pnpm run test
```

Expected: all workspace tests PASS.

- [ ] **Step 4: Inspect the final diff for scope and accidental transcript changes**

Run:

```bash
git --no-pager diff --check
git --no-pager status --short
git --no-pager diff --stat
```

Expected:

- No whitespace errors.
- Only the core source/test files named in this plan are modified.
- No `packages/server` or `packages/web` source changes.
- No dependency manifest changes.

- [ ] **Step 5: Commit any final test-only corrections**

Only if Step 1-4 required a correction:

```bash
git add packages/core
git commit -m "test(core): complete context pipeline coverage" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If no correction was needed, do not create an empty commit.
