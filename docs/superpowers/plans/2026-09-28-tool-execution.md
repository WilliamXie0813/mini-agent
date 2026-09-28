# Concurrent Tool Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, bounded parallel tool execution while preserving serial hooks/events, deterministic Tool Result ordering, and safe cancellation.

**Architecture:** `Agent` normalizes public execution options and passes them to `runAgentLoop`. A new internal `tool-execution.ts` module owns batch validation, sequential preflight, strategy selection, serial event/finalization queues, bounded scheduling, cancellation settlement, and stable result assembly; the Loop only commits returned Tool Result messages in model order.

**Tech Stack:** TypeScript 5.9, Node.js 22 built-in test runner, Vitest 2, pnpm workspaces, zero new runtime dependencies.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/types.ts` | Public execution mode and cancelled-event contracts; normalized Loop configuration |
| `packages/core/src/agent.ts` | Public option validation, normalized defaults, pending-state reduction |
| `packages/core/src/tools.ts` | Explicitly mark the built-in read tool as parallel-safe |
| `packages/core/src/tool-execution.ts` | Batch validation, preflight, serial dispatcher/finalizer, sequential and parallel execution |
| `packages/core/src/agent-loop.ts` | Delegate batches and commit stable Tool Result messages |
| `packages/core/test/tool-execution.test.ts` | Direct unit tests for batch execution invariants |
| `packages/core/test/agent-loop.test.ts` | Loop integration, stable transcript ordering, and Turn behavior |
| `packages/core/test/agent.test.ts` | Public configuration, cancellation cleanup, and listener-failure behavior |
| `packages/server/test/protocol.test.ts` | Cancelled-event wire encoding and multi-pending state serialization |
| `packages/web/src/state/reducer.ts` | Remove pending IDs on end or cancelled |
| `packages/web/test/reducer.test.ts` | Out-of-order end/cancelled state transitions |

Do not modify plugin manifests or add dependencies. Do not expose internal strategy, dispatcher, finalization, or prepared-call types from `@mini-agent/core`.

### Task 1: Add public contracts and normalized configuration

**Files:**
- Modify: `packages/core/src/types.ts:76-106,155-192,290-310`
- Modify: `packages/core/src/agent.ts:18-45,90-145,275-300,370-405`
- Modify: `packages/core/src/tools.ts:35-65`
- Modify: `packages/core/test/agent-loop.test.ts`
- Modify: `packages/core/test/agent.test.ts`

- [ ] **Step 1: Write failing Agent option validation tests**

Add this helper and tests to `packages/core/test/agent.test.ts`:

```ts
function createAgentWithExecutionOptions(
  overrides: Partial<ConstructorParameters<typeof Agent>[0]> = {},
): Agent {
  return new Agent({
    systemPrompt: "test",
    stream: createMockStream(),
    tools: [],
    ...overrides,
  });
}

test("Agent accepts valid tool execution options", () => {
  assert.doesNotThrow(() =>
    createAgentWithExecutionOptions({
      toolExecutionMode: "parallel",
      maxToolConcurrency: 2,
    }),
  );
});

test("Agent rejects invalid maxToolConcurrency", () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createAgentWithExecutionOptions({ maxToolConcurrency: value }),
      /maxToolConcurrency must be a positive integer/,
    );
  }
});
```

- [ ] **Step 2: Run the focused tests and type-check to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/core run check
```

Expected: FAIL because `AgentOptions` does not accept the execution fields.

- [ ] **Step 3: Add the public execution contracts**

In `packages/core/src/types.ts`, add before `Tool`:

```ts
export type ToolExecutionMode = "parallel" | "sequential";
```

Extend `Tool<TParameters>`:

```ts
export interface Tool<TParameters> {
  name: string;
  description: string;
  executionMode?: ToolExecutionMode;
  validate(argumentsValue: unknown): ValidationResult<TParameters>;
  execute(
    toolCallId: string,
    parameters: TParameters,
    signal: AbortSignal,
    onUpdate: ToolUpdate,
  ): Promise<ToolExecutionResult>;
}
```

Add the cancelled event to `AgentEvent` immediately after `tool_execution_end`:

```ts
  | {
      type: "tool_execution_cancelled";
      toolCallId: string;
      toolName: string;
      reason: "aborted" | "control_error";
    }
```

Add required normalized fields to `AgentLoopConfig`:

```ts
export interface AgentLoopConfig {
  stream: StreamFn;
  getSteeringMessages(): AgentMessage[];
  getFollowUpMessages(): AgentMessage[];
  hasSteeringMessages(): boolean;
  hasFollowUpMessages(): boolean;
  toolExecutionMode: ToolExecutionMode;
  maxToolConcurrency: number;
  prepareNextTurn?: PrepareNextTurn;
  prepareRequest?: PrepareRequest;
  transformContext?: TransformContext;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  finishTurn?: FinishTurn;
}
```

- [ ] **Step 4: Normalize options in Agent**

Import `ToolExecutionMode` in `packages/core/src/agent.ts`, then extend `AgentOptions`:

```ts
export interface AgentOptions {
  systemPrompt: string;
  stream: StreamFn;
  tools: Tool<unknown>[];
  toolExecutionMode?: ToolExecutionMode;
  maxToolConcurrency?: number;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  finishTurn?: FinishTurn;
  prepareNextTurn?: PrepareNextTurn;
  prepareRequest?: PrepareRequest;
  transformContext?: TransformContext;
}
```

Add this validator above `Agent`:

```ts
function normalizeMaxToolConcurrency(value: number | undefined): number {
  const normalized = value ?? 4;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error("maxToolConcurrency must be a positive integer");
  }
  return normalized;
}
```

Add fields:

```ts
private readonly toolExecutionMode: ToolExecutionMode;
private readonly maxToolConcurrency: number;
```

Initialize them in the constructor:

```ts
this.toolExecutionMode = options.toolExecutionMode ?? "sequential";
this.maxToolConcurrency = normalizeMaxToolConcurrency(
  options.maxToolConcurrency,
);
```

Pass them in the existing `runAgentLoop` config:

```ts
toolExecutionMode: this.toolExecutionMode,
maxToolConcurrency: this.maxToolConcurrency,
```

Handle both terminal tool events in `processEvent`:

```ts
case "tool_execution_end":
case "tool_execution_cancelled": {
  const next = new Set(this.mutableState.pendingToolCalls);
  next.delete(event.toolCallId);
  this.mutableState.pendingToolCalls = next;
  break;
}
```

- [ ] **Step 5: Mark the built-in read tool parallel-safe**

In `packages/core/src/tools.ts`, add the explicit declaration:

```ts
return {
  name: "read",
  description: "Read a UTF-8 file from the virtual file system",
  executionMode: "parallel",
  validate: validateReadArguments,
  async execute(_toolCallId, parameters, signal, onUpdate) {
    // existing body unchanged
  },
};
```

- [ ] **Step 6: Keep direct Loop tests buildable**

In `packages/core/test/agent-loop.test.ts`, import `AgentLoopConfig` and add:

```ts
function loopConfig(
  overrides: Partial<AgentLoopConfig> = {},
): AgentLoopConfig {
  return {
    stream: createMockStream(),
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    hasSteeringMessages: () => false,
    hasFollowUpMessages: () => false,
    toolExecutionMode: "sequential",
    maxToolConcurrency: 4,
    ...overrides,
  };
}
```

Replace each inline third argument to `runAgentLoop` with `loopConfig({ ...existing overrides... })`. When the existing object supplies `stream`, queue functions, or hooks, keep those values inside the override object.

- [ ] **Step 7: Run tests and checks**

Run:

```bash
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/core run check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/agent.ts packages/core/src/tools.ts packages/core/test/agent-loop.test.ts packages/core/test/agent.test.ts
git commit -m "feat(core): add tool execution contracts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Extract sequential batch execution

**Files:**
- Create: `packages/core/src/tool-execution.ts`
- Create: `packages/core/test/tool-execution.test.ts`
- Modify: `packages/core/src/agent-loop.ts:115-210,285-300`

- [ ] **Step 1: Write batch test helpers and failing sequential tests**

Create `packages/core/test/tool-execution.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { executeToolCallBatch } from "../src/tool-execution.ts";
import type {
  AgentEvent,
  Tool,
  ToolCall,
  ToolExecutionResult,
} from "../src/types.ts";

function toolCall(id: string, name = id): ToolCall {
  return { type: "toolCall", id, name, arguments: { id } };
}

function createTool(
  name: string,
  execute: () => Promise<ToolExecutionResult>,
  executionMode: "parallel" | "sequential" = "parallel",
): Tool<{ id: string }> {
  return {
    name,
    description: name,
    executionMode,
    validate(value) {
      if (
        value === null ||
        typeof value !== "object" ||
        !("id" in value) ||
        typeof value.id !== "string"
      ) {
        return { ok: false, error: "invalid id" };
      }
      return { ok: true, value: { id: value.id } };
    },
    async execute() {
      return execute();
    },
  };
}

function options(overrides: {
  tools?: Tool<unknown>[];
  events?: AgentEvent[];
  beforeToolCall?: (
    call: ToolCall,
    parameters: unknown,
    signal: AbortSignal,
  ) => Promise<{ block: true; reason: string } | undefined>;
  afterToolCall?: (
    call: ToolCall,
    result: ToolExecutionResult,
    signal: AbortSignal,
  ) => Promise<ToolExecutionResult | undefined>;
  signal?: AbortSignal;
} = {}) {
  const events = overrides.events ?? [];
  return {
    tools: overrides.tools ?? [],
    toolExecutionMode: "sequential" as const,
    maxConcurrency: 4,
    beforeToolCall: overrides.beforeToolCall,
    afterToolCall: overrides.afterToolCall,
    signal: overrides.signal ?? new AbortController().signal,
    emit: async (event: AgentEvent) => {
      events.push(event);
    },
  };
}

test("rejects empty and duplicate tool call ids before hooks run", async () => {
  let hookCalls = 0;
  const batchOptions = options({
    beforeToolCall: async () => {
      hookCalls += 1;
      return undefined;
    },
  });

  await assert.rejects(
    executeToolCallBatch([toolCall("", "read")], batchOptions),
    /Tool Call ID must be non-empty/,
  );
  await assert.rejects(
    executeToolCallBatch(
      [toolCall("same", "read"), toolCall("same", "read")],
      batchOptions,
    ),
    /Duplicate Tool Call ID: same/,
  );
  assert.equal(hookCalls, 0);
});

test("preflights every call in source order before executing", async () => {
  const order: string[] = [];
  const tools = ["a", "b"].map((name) =>
    createTool(name, async () => {
      order.push(`execute:${name}`);
      return { content: name };
    }),
  );

  await executeToolCallBatch(
    [toolCall("a"), toolCall("b")],
    options({
      tools,
      beforeToolCall: async (call) => {
        order.push(`before:${call.id}`);
        return undefined;
      },
    }),
  );

  assert.deepEqual(order, [
    "before:a",
    "before:b",
    "execute:a",
    "execute:b",
  ]);
});

test("sequential execution produces complete immediate error lifecycles", async () => {
  const events: AgentEvent[] = [];
  const batch = await executeToolCallBatch(
    [toolCall("missing", "missing")],
    options({ events }),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["tool_execution_start", "tool_execution_end"],
  );
  assert.equal(batch.messages[0]?.toolCallId, "missing");
  assert.equal(batch.messages[0]?.isError, true);
  assert.equal(batch.messages[0]?.content, "Unknown tool: missing");
});

test("afterToolCall is applied before end and message creation", async () => {
  const events: AgentEvent[] = [];
  const batch = await executeToolCallBatch(
    [toolCall("read")],
    options({
      tools: [createTool("read", async () => ({ content: "original" }))],
      events,
      afterToolCall: async () => ({ content: "replacement", isError: false }),
    }),
  );

  const end = events.find((event) => event.type === "tool_execution_end");
  assert.equal(end?.type, "tool_execution_end");
  if (end?.type !== "tool_execution_end") return;
  assert.equal(end.result.content, "replacement");
  assert.equal(batch.messages[0]?.content, "replacement");
});
```

- [ ] **Step 2: Run the new test to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core run test
```

Expected: FAIL because `tool-execution.ts` does not exist.

- [ ] **Step 3: Implement validation, preparation, serial dispatch, and serial finalization**

Create `packages/core/src/tool-execution.ts` with these public-to-core-module contracts and helpers:

```ts
import type {
  AfterToolCall,
  AgentEvent,
  BeforeToolCall,
  EventSink,
  Tool,
  ToolCall,
  ToolExecutionMode,
  ToolExecutionResult,
  ToolResultMessage,
} from "./types.ts";

export interface ToolExecutionBatchOptions {
  tools: readonly Tool<unknown>[];
  toolExecutionMode: ToolExecutionMode;
  maxConcurrency: number;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  emit: EventSink;
  signal: AbortSignal;
}

export interface ToolExecutionBatch {
  messages: ToolResultMessage[];
}

type PreparedToolCall =
  | {
      kind: "ready";
      index: number;
      toolCall: ToolCall;
      tool: Tool<unknown>;
      parameters: unknown;
    }
  | {
      kind: "immediate";
      index: number;
      toolCall: ToolCall;
      result: ToolExecutionResult;
    };

interface CompletedToolCall {
  index: number;
  toolCall: ToolCall;
  result: ToolExecutionResult;
}

class ToolEventDispatchError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Tool event dispatch failed");
    this.cause = cause;
  }
}

class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private failedState = false;
  private failure: unknown;

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.failedState) throw this.failure;
      try {
        return await operation();
      } catch (error) {
        this.failedState = true;
        this.failure = error;
        throw error;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  get failed(): boolean {
    return this.failedState;
  }
}

class ToolEventDispatcher {
  private readonly queue = new SerialQueue();
  private readonly sink: EventSink;

  constructor(sink: EventSink) {
    this.sink = sink;
  }

  async emit(event: AgentEvent): Promise<void> {
    try {
      await this.queue.enqueue(() => this.sink(event));
    } catch (error) {
      throw error instanceof ToolEventDispatchError
        ? error
        : new ToolEventDispatchError(error);
    }
  }

  get failed(): boolean {
    return this.queue.failed;
  }
}

function errorResult(content: string): ToolExecutionResult {
  return { content, isError: true };
}

function validateToolCallIds(toolCalls: readonly ToolCall[]): void {
  const ids = new Set<string>();
  for (const toolCall of toolCalls) {
    if (toolCall.id.length === 0) {
      throw new Error("Tool Call ID must be non-empty");
    }
    if (ids.has(toolCall.id)) {
      throw new Error(`Duplicate Tool Call ID: ${toolCall.id}`);
    }
    ids.add(toolCall.id);
  }
}

async function prepareToolCalls(
  toolCalls: readonly ToolCall[],
  options: ToolExecutionBatchOptions,
): Promise<PreparedToolCall[]> {
  validateToolCallIds(toolCalls);
  const prepared: PreparedToolCall[] = [];

  for (const [index, toolCall] of toolCalls.entries()) {
    options.signal.throwIfAborted();
    const tool = options.tools.find(
      (candidate) => candidate.name === toolCall.name,
    );
    if (!tool) {
      prepared.push({
        kind: "immediate",
        index,
        toolCall,
        result: errorResult(`Unknown tool: ${toolCall.name}`),
      });
      continue;
    }

    const validation = tool.validate(toolCall.arguments);
    if (!validation.ok) {
      prepared.push({
        kind: "immediate",
        index,
        toolCall,
        result: errorResult(validation.error),
      });
      continue;
    }

    const blocked = await options.beforeToolCall?.(
      toolCall,
      validation.value,
      options.signal,
    );
    options.signal.throwIfAborted();
    if (blocked) {
      prepared.push({
        kind: "immediate",
        index,
        toolCall,
        result: errorResult(blocked.reason),
      });
      continue;
    }

    prepared.push({
      kind: "ready",
      index,
      toolCall,
      tool,
      parameters: validation.value,
    });
  }

  return prepared;
}

function toMessage(completed: CompletedToolCall): ToolResultMessage {
  return {
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

Keep `ToolEventDispatchError`, `PreparedToolCall`, `CompletedToolCall`, queues, and preparation helpers module-private.

- [ ] **Step 4: Implement sequential execution and the batch entry point**

Continue in `packages/core/src/tool-execution.ts`:

```ts
async function finalizeCall(
  prepared: PreparedToolCall,
  result: ToolExecutionResult,
  options: ToolExecutionBatchOptions,
  events: ToolEventDispatcher,
  finalization: SerialQueue,
): Promise<CompletedToolCall> {
  return finalization.enqueue(async () => {
    const replacement = await options.afterToolCall?.(
      prepared.toolCall,
      result,
      options.signal,
    );
    const finalResult = replacement ?? result;
    await events.emit({
      type: "tool_execution_end",
      toolCallId: prepared.toolCall.id,
      toolName: prepared.toolCall.name,
      result: finalResult,
      isError: finalResult.isError === true,
    });
    return {
      index: prepared.index,
      toolCall: prepared.toolCall,
      result: finalResult,
    };
  });
}

async function executeReady(
  prepared: Extract<PreparedToolCall, { kind: "ready" }>,
  options: ToolExecutionBatchOptions,
  events: ToolEventDispatcher,
  finalization: SerialQueue,
): Promise<CompletedToolCall> {
  await events.emit({
    type: "tool_execution_start",
    toolCallId: prepared.toolCall.id,
    toolName: prepared.toolCall.name,
    argumentsValue: prepared.toolCall.arguments,
  });
  options.signal.throwIfAborted();

  let result: ToolExecutionResult;
  let updateFailure: ToolEventDispatchError | undefined;
  try {
    result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.parameters,
      options.signal,
      async (partial) => {
        try {
          await events.emit({
            type: "tool_execution_update",
            toolCallId: prepared.toolCall.id,
            toolName: prepared.toolCall.name,
            partial,
          });
        } catch (error) {
          updateFailure =
            error instanceof ToolEventDispatchError
              ? error
              : new ToolEventDispatchError(error);
          throw updateFailure;
        }
      },
    );
    if (updateFailure) throw updateFailure;
  } catch (error) {
    if (error instanceof ToolEventDispatchError || options.signal.aborted) {
      throw error;
    }
    result = errorResult(error instanceof Error ? error.message : String(error));
  }

  options.signal.throwIfAborted();
  return finalizeCall(prepared, result, options, events, finalization);
}

async function executeImmediate(
  prepared: Extract<PreparedToolCall, { kind: "immediate" }>,
  options: ToolExecutionBatchOptions,
  events: ToolEventDispatcher,
  finalization: SerialQueue,
): Promise<CompletedToolCall> {
  await events.emit({
    type: "tool_execution_start",
    toolCallId: prepared.toolCall.id,
    toolName: prepared.toolCall.name,
    argumentsValue: prepared.toolCall.arguments,
  });
  options.signal.throwIfAborted();
  return finalizeCall(
    prepared,
    prepared.result,
    options,
    events,
    finalization,
  );
}

async function executeSequential(
  preparedCalls: readonly PreparedToolCall[],
  options: ToolExecutionBatchOptions,
  events: ToolEventDispatcher,
  finalization: SerialQueue,
): Promise<CompletedToolCall[]> {
  const completed: CompletedToolCall[] = [];
  for (const prepared of preparedCalls) {
    options.signal.throwIfAborted();
    completed.push(
      prepared.kind === "ready"
        ? await executeReady(prepared, options, events, finalization)
        : await executeImmediate(prepared, options, events, finalization),
    );
  }
  return completed;
}

function shouldExecuteInParallel(
  preparedCalls: readonly PreparedToolCall[],
  mode: ToolExecutionMode,
): boolean {
  return (
    mode === "parallel" &&
    preparedCalls.every(
      (prepared) =>
        prepared.kind === "immediate" ||
        prepared.tool.executionMode === "parallel",
    )
  );
}

export async function executeToolCallBatch(
  toolCalls: readonly ToolCall[],
  options: ToolExecutionBatchOptions,
): Promise<ToolExecutionBatch> {
  if (toolCalls.length === 0) return { messages: [] };

  const prepared = await prepareToolCalls(toolCalls, options);
  const events = new ToolEventDispatcher(options.emit);
  const finalization = new SerialQueue();
  const completed = await executeSequential(
    prepared,
    options,
    events,
    finalization,
  );

  completed.sort((left, right) => left.index - right.index);
  return { messages: completed.map(toMessage) };
}
```

At this point `shouldExecuteInParallel` is intentionally unused until Task 3. Do not export it. If TypeScript reports it as unused, add the Task 3 branch in the same working tree before running `check`; do not export a private helper only to silence the compiler.

- [ ] **Step 5: Delegate from Agent Loop**

In `packages/core/src/agent-loop.ts`:

1. Import `executeToolCallBatch`.
2. Delete the local `errorResult` and `executeToolCall`.
3. Replace the current per-call loop with:

```ts
const batch = await executeToolCallBatch(toolCalls, {
  tools: context.tools,
  toolExecutionMode: config.toolExecutionMode,
  maxConcurrency: config.maxToolConcurrency,
  beforeToolCall: config.beforeToolCall,
  afterToolCall: config.afterToolCall,
  emit,
  signal,
});

const toolResults = batch.messages;
for (const message of toolResults) {
  await emitMessage(message, emit);
  context.messages.push(message);
}
```

Do not move `finishTurn`, `turn_end`, or next-Turn scheduling.

- [ ] **Step 6: Run tests and checks**

Run:

```bash
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/core run check
```

Expected: PASS with the original behavior still serial.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tool-execution.ts packages/core/src/agent-loop.ts packages/core/test/tool-execution.test.ts
git commit -m "refactor(core): extract sequential tool batches" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Add bounded opt-in parallel scheduling

**Files:**
- Modify: `packages/core/src/tool-execution.ts`
- Modify: `packages/core/test/tool-execution.test.ts`
- Modify: `packages/core/test/agent-loop.test.ts`

- [ ] **Step 1: Add deterministic deferred helpers**

Add near the top of `packages/core/test/tool-execution.test.ts`:

```ts
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
```

- [ ] **Step 2: Write failing parallelism, cap, downgrade, and ordering tests**

Add:

```ts
test("parallel mode starts explicitly parallel tools before either completes", async () => {
  const first = deferred<ToolExecutionResult>();
  const second = deferred<ToolExecutionResult>();
  const started: string[] = [];
  const events: AgentEvent[] = [];

  const running = executeToolCallBatch(
    [toolCall("a"), toolCall("b")],
    {
      ...options({
        tools: [
          createTool("a", async () => {
            started.push("a");
            return first.promise;
          }),
          createTool("b", async () => {
            started.push("b");
            return second.promise;
          }),
        ],
        events,
      }),
      toolExecutionMode: "parallel",
      maxConcurrency: 2,
    },
  );

  await flushMicrotasks();
  assert.deepEqual(started, ["a", "b"]);

  second.resolve({ content: "B" });
  await flushMicrotasks();
  first.resolve({ content: "A" });

  const batch = await running;
  assert.deepEqual(
    events
      .filter((event) => event.type === "tool_execution_end")
      .map((event) => event.toolCallId),
    ["b", "a"],
  );
  assert.deepEqual(
    batch.messages.map((message) => message.toolCallId),
    ["a", "b"],
  );
});

test("parallel mode never exceeds maxConcurrency", async () => {
  const gates = [deferred<ToolExecutionResult>(), deferred<ToolExecutionResult>(), deferred<ToolExecutionResult>()];
  let active = 0;
  let peak = 0;
  const tools = gates.map((gate, index) =>
    createTool(String(index), async () => {
      active += 1;
      peak = Math.max(peak, active);
      const result = await gate.promise;
      active -= 1;
      return result;
    }),
  );

  const running = executeToolCallBatch(
    [toolCall("0"), toolCall("1"), toolCall("2")],
    {
      ...options({ tools }),
      toolExecutionMode: "parallel",
      maxConcurrency: 2,
    },
  );

  await flushMicrotasks();
  assert.equal(active, 2);
  assert.equal(peak, 2);
  gates[0]?.resolve({ content: "0" });
  await flushMicrotasks();
  assert.equal(active, 2);
  gates[1]?.resolve({ content: "1" });
  gates[2]?.resolve({ content: "2" });
  await running;
  assert.equal(peak, 2);
});

test("an undeclared or sequential ready tool downgrades the whole batch", async () => {
  for (const mode of [undefined, "sequential"] as const) {
    const first = deferred<ToolExecutionResult>();
    let secondStarted = false;
    const firstTool = createTool("a", () => first.promise);
    const secondTool: Tool<{ id: string }> = {
      ...createTool("b", async () => {
        secondStarted = true;
        return { content: "b" };
      }),
      executionMode: mode,
    };

    const running = executeToolCallBatch(
      [toolCall("a"), toolCall("b")],
      {
        ...options({ tools: [firstTool, secondTool] }),
        toolExecutionMode: "parallel",
      },
    );
    await flushMicrotasks();
    assert.equal(secondStarted, false);
    first.resolve({ content: "a" });
    await running;
    assert.equal(secondStarted, true);
  }
});

test("EventSink and afterToolCall remain serial under parallel execution", async () => {
  let activeEvents = 0;
  let peakEvents = 0;
  let activeHooks = 0;
  let peakHooks = 0;

  await executeToolCallBatch(
    [toolCall("a"), toolCall("b")],
    {
      ...options({
        tools: [
          createTool("a", async () => ({ content: "a" })),
          createTool("b", async () => ({ content: "b" })),
        ],
        afterToolCall: async (_call, result) => {
          activeHooks += 1;
          peakHooks = Math.max(peakHooks, activeHooks);
          await Promise.resolve();
          activeHooks -= 1;
          return result;
        },
      }),
      toolExecutionMode: "parallel",
      emit: async () => {
        activeEvents += 1;
        peakEvents = Math.max(peakEvents, activeEvents);
        await Promise.resolve();
        activeEvents -= 1;
      },
    },
  );

  assert.equal(peakEvents, 1);
  assert.equal(peakHooks, 1);
});

test("a ready slot remains occupied through finalization and terminal dispatch", async () => {
  const releaseHook = deferred<void>();
  const started: string[] = [];
  const tools = ["a", "b"].map((name) =>
    createTool(name, async () => {
      started.push(name);
      return { content: name };
    }),
  );

  const running = executeToolCallBatch(
    [toolCall("a"), toolCall("b")],
    {
      ...options({
        tools,
        afterToolCall: async (call, result) => {
          if (call.id === "a") await releaseHook.promise;
          return result;
        },
      }),
      toolExecutionMode: "parallel",
      maxConcurrency: 1,
    },
  );

  await flushMicrotasks();
  assert.deepEqual(started, ["a"]);
  releaseHook.resolve();
  await flushMicrotasks();
  assert.deepEqual(started, ["a", "b"]);
  await running;
});
```

- [ ] **Step 3: Run the new tests to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core run test
```

Expected: parallel-start and concurrency-cap tests FAIL because the batch always uses sequential execution.

- [ ] **Step 4: Implement bounded parallel scheduling**

Add this implementation in `packages/core/src/tool-execution.ts`:

```ts
async function executeParallel(
  preparedCalls: readonly PreparedToolCall[],
  options: ToolExecutionBatchOptions,
  events: ToolEventDispatcher,
  finalization: SerialQueue,
): Promise<CompletedToolCall[]> {
  const completed: CompletedToolCall[] = [];
  const activeReady = new Set<Promise<void>>();
  const allStarted: Promise<void>[] = [];
  let hasPrimaryError = false;
  let primaryError: unknown;

  const record = (
    promise: Promise<CompletedToolCall>,
    consumesSlot: boolean,
  ): void => {
    let tracked!: Promise<void>;
    tracked = promise
      .then((value) => {
        completed.push(value);
      })
      .catch((error: unknown) => {
        if (!hasPrimaryError) {
          hasPrimaryError = true;
          primaryError = error;
        }
      })
      .finally(() => {
        if (consumesSlot) activeReady.delete(tracked);
      });
    allStarted.push(tracked);
    if (consumesSlot) activeReady.add(tracked);
  };

  for (const prepared of preparedCalls) {
    if (hasPrimaryError) break;
    options.signal.throwIfAborted();

    if (prepared.kind === "immediate") {
      record(
        executeImmediate(prepared, options, events, finalization),
        false,
      );
      await Promise.resolve();
      continue;
    }

    while (activeReady.size >= options.maxConcurrency) {
      await Promise.race(activeReady);
      if (hasPrimaryError) break;
      options.signal.throwIfAborted();
    }
    if (hasPrimaryError) break;

    record(executeReady(prepared, options, events, finalization), true);
    await Promise.resolve();
  }

  await Promise.allSettled(allStarted);
  options.signal.throwIfAborted();
  if (hasPrimaryError) throw primaryError;
  return completed;
}
```

Replace the fixed sequential call in `executeToolCallBatch`:

```ts
const completed = shouldExecuteInParallel(
  prepared,
  options.toolExecutionMode,
)
  ? await executeParallel(prepared, options, events, finalization)
  : await executeSequential(prepared, options, events, finalization);
```

The ready slot remains occupied until `executeReady` finishes Finalization and its terminal event.

- [ ] **Step 5: Add a Loop-level stable transcript test**

In `packages/core/test/agent-loop.test.ts`, add:

```ts
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function toolCall(id: string): ToolCall {
  return { type: "toolCall", id, name: id, arguments: { id } };
}

function createTool(
  name: string,
  execute: () => Promise<ToolExecutionResult>,
): Tool<{ id: string }> {
  return {
    name,
    description: name,
    executionMode: "parallel",
    validate: () => ({ ok: true, value: { id: name } }),
    async execute() {
      return execute();
    },
  };
}

function createTwoToolCallStream(): StreamFn {
  return async function* (messages) {
    if (messages.at(-1)?.role === "toolResult") {
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        timestamp: 3,
      };
      yield { type: "start", message };
      yield { type: "end", message };
      return;
    }

    const calls: ToolCall[] = [toolCall("a"), toolCall("b")];
    const start: AssistantMessage = {
      role: "assistant",
      content: [],
      stopReason: "toolUse",
      timestamp: 2,
    };
    const end: AssistantMessage = {
      ...start,
      content: calls,
    };
    yield { type: "start", message: start };
    for (const call of calls) {
      yield { type: "tool_call", toolCall: call, message: end };
    }
    yield { type: "end", message: end };
  };
}

test("loop emits completion order but commits model source order", async () => {
  const first = deferred<ToolExecutionResult>();
  const second = deferred<ToolExecutionResult>();
  const events: AgentEvent[] = [];
  const context = {
    messages: [] as AgentMessage[],
    tools: [
      createTool("a", () => first.promise),
      createTool("b", () => second.promise),
    ],
  };

  const running = runAgentLoop(
    [{ role: "user", content: "run both", timestamp: 1 }],
    context,
    loopConfig({
      stream: createTwoToolCallStream(),
      toolExecutionMode: "parallel",
      maxToolConcurrency: 2,
    }),
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
  );

  await flushMicrotasks();
  second.resolve({ content: "B" });
  await flushMicrotasks();
  first.resolve({ content: "A" });
  await running;

  assert.deepEqual(
    events
      .filter((event) => event.type === "tool_execution_end")
      .map((event) => event.toolCallId),
    ["b", "a"],
  );
  assert.deepEqual(
    context.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => message.toolCallId),
    ["a", "b"],
  );
});
```

Add `ToolExecutionResult` to the existing type imports in this test file.

- [ ] **Step 6: Run tests and checks**

Run:

```bash
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/core run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tool-execution.ts packages/core/test/tool-execution.test.ts packages/core/test/agent-loop.test.ts
git commit -m "feat(core): execute safe tools in parallel" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Complete cancellation and control-error settlement

**Files:**
- Modify: `packages/core/src/tool-execution.ts`
- Modify: `packages/core/test/tool-execution.test.ts`
- Modify: `packages/core/test/agent.test.ts`

- [ ] **Step 1: Write failing cancellation and dispatch-failure tests**

Add to `packages/core/test/tool-execution.test.ts`:

```ts
test("abort stops new calls, settles started calls, and emits cancelled", async () => {
  const controller = new AbortController();
  const first = deferred<ToolExecutionResult>();
  const second = deferred<ToolExecutionResult>();
  const thirdStarted: string[] = [];
  const events: AgentEvent[] = [];

  const running = executeToolCallBatch(
    [toolCall("a"), toolCall("b"), toolCall("c")],
    {
      ...options({
        tools: [
          createTool("a", () => first.promise),
          createTool("b", () => second.promise),
          createTool("c", async () => {
            thirdStarted.push("c");
            return { content: "c" };
          }),
        ],
        events,
        signal: controller.signal,
      }),
      toolExecutionMode: "parallel",
      maxConcurrency: 2,
    },
  );

  await flushMicrotasks();
  controller.abort();
  first.reject(controller.signal.reason);
  second.reject(controller.signal.reason);

  await assert.rejects(running, (error) => error === controller.signal.reason);
  assert.deepEqual(thirdStarted, []);
  assert.deepEqual(
    events
      .filter((event) => event.type === "tool_execution_cancelled")
      .map((event) => event.toolCallId),
    ["a", "b"],
  );
});

test("afterToolCall failure keeps the first control error and cancels unfinished calls", async () => {
  const second = deferred<ToolExecutionResult>();
  const events: AgentEvent[] = [];
  const failure = new Error("after failed");

  const running = executeToolCallBatch(
    [toolCall("a"), toolCall("b")],
    {
      ...options({
        tools: [
          createTool("a", async () => ({ content: "a" })),
          createTool("b", () => second.promise),
        ],
        events,
        afterToolCall: async (call, result) => {
          if (call.id === "a") throw failure;
          return result;
        },
      }),
      toolExecutionMode: "parallel",
      maxConcurrency: 2,
    },
  );

  await flushMicrotasks();
  second.resolve({ content: "b" });
  await assert.rejects(running, (error) => error === failure);
  assert.equal(
    events.some(
      (event) =>
        event.type === "tool_execution_cancelled" &&
        event.toolCallId === "a" &&
        event.reason === "control_error",
    ),
    true,
  );
});

test("EventSink failure is a control error and does not promise cancelled delivery", async () => {
  const sinkFailure = new Error("listener failed");
  let eventCalls = 0;
  const swallowingTool: Tool<{ id: string }> = {
    ...createTool("a", async () => ({ content: "unused" })),
    async execute(_toolCallId, _parameters, _signal, onUpdate) {
      try {
        await onUpdate({ content: "progress" });
      } catch {
        // A Tool may incorrectly swallow callback errors; the Runtime must
        // still remember and rethrow the dispatch failure after execute returns.
      }
      return { content: "should not become a Tool Result" };
    },
  };

  await assert.rejects(
    executeToolCallBatch(
      [toolCall("a")],
      {
        ...options({
          tools: [swallowingTool],
        }),
        emit: async (event) => {
          eventCalls += 1;
          if (event.type === "tool_execution_update") {
            throw sinkFailure;
          }
        },
      },
    ),
    (error) =>
      error instanceof Error &&
      error.message === "Tool event dispatch failed" &&
      "cause" in error &&
      error.cause === sinkFailure,
  );
  assert.equal(eventCalls, 2);
});

test("the first observed concurrent control error remains the primary error", async () => {
  const firstFailure = new Error("first failure");
  const secondFailure = new Error("second failure");
  const releaseSecond = deferred<void>();

  const running = executeToolCallBatch(
    [toolCall("a"), toolCall("b")],
    {
      ...options({
        tools: [
          createTool("a", async () => ({ content: "a" })),
          createTool("b", async () => {
            await releaseSecond.promise;
            return { content: "b" };
          }),
        ],
        afterToolCall: async (call, result) => {
          if (call.id === "a") throw firstFailure;
          throw secondFailure;
        },
      }),
      toolExecutionMode: "parallel",
      maxConcurrency: 2,
    },
  );

  await flushMicrotasks();
  releaseSecond.resolve();
  await assert.rejects(running, (error) => error === firstFailure);
});
```

- [ ] **Step 2: Run the focused test to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core run test
```

Expected: FAIL because cancellation events and coordinated cleanup are not implemented.

- [ ] **Step 3: Track started and terminal calls**

In `executeToolCallBatch`, create:

```ts
const started = new Map<string, ToolCall>();
const terminal = new Set<string>();
```

Pass callbacks into `executeReady` and `executeImmediate`:

```ts
const markStarted = (toolCall: ToolCall): void => {
  started.set(toolCall.id, toolCall);
};
const markTerminal = (toolCallId: string): void => {
  terminal.add(toolCallId);
};
```

Call `markStarted` only after the start event resolves successfully. Call `markTerminal` only after the end event resolves successfully.

- [ ] **Step 4: Add terminal cleanup**

Add:

```ts
async function emitCancelledForOpenCalls(
  started: ReadonlyMap<string, ToolCall>,
  terminal: ReadonlySet<string>,
  reason: "aborted" | "control_error",
  events: ToolEventDispatcher,
): Promise<void> {
  if (events.failed) return;
  for (const toolCall of started.values()) {
    if (terminal.has(toolCall.id)) continue;
    await events.emit({
      type: "tool_execution_cancelled",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      reason,
    });
  }
}
```

Wrap strategy execution in `executeToolCallBatch`:

```ts
let completed: CompletedToolCall[];
try {
  completed = shouldExecuteInParallel(prepared, options.toolExecutionMode)
    ? await executeParallel(
        prepared,
        options,
        events,
        finalization,
        markStarted,
        markTerminal,
      )
    : await executeSequential(
        prepared,
        options,
        events,
        finalization,
        markStarted,
        markTerminal,
      );
} catch (error) {
  const reason = options.signal.aborted ? "aborted" : "control_error";
  await emitCancelledForOpenCalls(started, terminal, reason, events);
  if (options.signal.aborted) options.signal.throwIfAborted();
  throw error;
}
```

Update the sequential and parallel helper signatures to receive and invoke `markStarted` and `markTerminal`.

- [ ] **Step 5: Preserve EventSink failures as control errors**

Keep `ToolEventDispatchError` module-private. In `executeReady`, retain this distinction:

```ts
} catch (error) {
  if (error instanceof ToolEventDispatchError || options.signal.aborted) {
    throw error;
  }
  result = errorResult(error instanceof Error ? error.message : String(error));
}
```

Do not catch errors from `finalizeCall` as ordinary tool failures. A rejected `afterToolCall` or end-event dispatch must reach the batch coordinator.

- [ ] **Step 6: Add Agent-level pending cleanup coverage**

Add this stream helper to `packages/core/test/agent.test.ts`:

```ts
function createNamedToolCallStream(names: readonly string[]): StreamFn {
  return async function* (messages) {
    if (messages.at(-1)?.role === "toolResult") {
      const done: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        timestamp: Date.now(),
      };
      yield { type: "start", message: done };
      yield { type: "end", message: done };
      return;
    }

    const calls: ToolCall[] = names.map((name) => ({
      type: "toolCall",
      id: `call-${name}`,
      name,
      arguments: {},
    }));
    const start: AssistantMessage = {
      role: "assistant",
      content: [],
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    const end: AssistantMessage = { ...start, content: calls };
    yield { type: "start", message: start };
    for (const call of calls) {
      yield { type: "tool_call", toolCall: call, message: end };
    }
    yield { type: "end", message: end };
  };
}
```

Also import `AssistantMessage` and `ToolCall`, then add:

```ts
test("Agent abort clears pending parallel tools through cancelled events", async () => {
  const tools: Tool<unknown>[] = ["a", "b"].map((name) => ({
    name,
    description: name,
    executionMode: "parallel",
    validate: () => ({ ok: true, value: {} }),
    async execute(_id, _parameters, signal) {
      signal.throwIfAborted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return { content: "unreachable" };
    },
  }));
  const agent = new Agent({
    systemPrompt: "test",
    stream: createNamedToolCallStream(["a", "b"]),
    tools,
    toolExecutionMode: "parallel",
    maxToolConcurrency: 2,
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
    if (
      events.filter((candidate) => candidate.type === "tool_execution_start")
        .length === 2
    ) {
      agent.abort();
    }
  });

  await agent.prompt("run");

  assert.equal(
    events.filter((event) => event.type === "tool_execution_cancelled").length,
    2,
  );
  assert.deepEqual([...agent.state.pendingToolCalls], []);
  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.equal(finalMessage.stopReason, "aborted");
});

test("Agent finally clears pending state when a listener fails", async () => {
  const agent = new Agent({
    systemPrompt: "test",
    stream: createNamedToolCallStream(["a"]),
    tools: [
      {
        name: "a",
        description: "a",
        executionMode: "parallel",
        validate: () => ({ ok: true, value: {} }),
        async execute() {
          return { content: "a" };
        },
      },
    ],
    toolExecutionMode: "parallel",
  });
  let failed = false;
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start" && !failed) {
      failed = true;
      throw new Error("listener failed");
    }
  });

  await agent.prompt("run");

  assert.equal(failed, true);
  assert.deepEqual([...agent.state.pendingToolCalls], []);
  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.equal(finalMessage.stopReason, "error");
  assert.equal(finalMessage.errorMessage, "Tool event dispatch failed");
});
```

Do not assert receipt of cancelled in the listener-failure test, because the EventSink path itself failed.

- [ ] **Step 7: Run tests and checks**

Run:

```bash
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/core run check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/tool-execution.ts packages/core/test/tool-execution.test.ts packages/core/test/agent.test.ts
git commit -m "feat(core): settle cancelled tool batches" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Integrate cancelled events with Server and Web

**Files:**
- Modify: `packages/server/test/protocol.test.ts`
- Modify: `packages/web/src/state/reducer.ts:35-52`
- Modify: `packages/web/test/reducer.test.ts:25-55`

- [ ] **Step 1: Write the failing Web reducer test**

Replace the existing pending-tool test in `packages/web/test/reducer.test.ts` with:

```ts
it("tracks out-of-order completed and cancelled tool calls", () => {
  let state = emptyState();
  state = reduceEvent(state, {
    type: "tool_execution_start",
    toolCallId: "call-a",
    toolName: "read",
    argumentsValue: { path: "a" },
  });
  state = reduceEvent(state, {
    type: "tool_execution_start",
    toolCallId: "call-b",
    toolName: "read",
    argumentsValue: { path: "b" },
  });
  expect(state.pendingToolCalls).toEqual(["call-a", "call-b"]);

  state = reduceEvent(state, {
    type: "tool_execution_cancelled",
    toolCallId: "call-b",
    toolName: "read",
    reason: "aborted",
  });
  expect(state.pendingToolCalls).toEqual(["call-a"]);

  state = reduceEvent(state, {
    type: "tool_execution_end",
    toolCallId: "call-a",
    toolName: "read",
    result: { content: "a" },
    isError: false,
  });
  expect(state.pendingToolCalls).toEqual([]);
});
```

- [ ] **Step 2: Run the Web test to verify failure**

Run:

```bash
pnpm --filter @mini-agent/web run test
```

Expected: FAIL because cancelled does not remove the pending ID.

- [ ] **Step 3: Handle both terminal events in the Web reducer**

In `packages/web/src/state/reducer.ts`:

```ts
case "tool_execution_end":
case "tool_execution_cancelled":
  return {
    ...state,
    pendingToolCalls: state.pendingToolCalls.filter(
      (id) => id !== event.toolCallId,
    ),
  };
```

- [ ] **Step 4: Add a Server event encoding test**

In `packages/server/test/protocol.test.ts`, import `encodeMessage` and add:

```ts
test("encodeMessage preserves tool_execution_cancelled events", () => {
  const encoded = encodeMessage({
    type: "event",
    event: {
      type: "tool_execution_cancelled",
      toolCallId: "call-2",
      toolName: "read",
      reason: "control_error",
    },
  });

  assert.deepEqual(JSON.parse(encoded), {
    type: "event",
    event: {
      type: "tool_execution_cancelled",
      toolCallId: "call-2",
      toolName: "read",
      reason: "control_error",
    },
  });
});
```

Keep the existing test that serializes two pending IDs; it already covers the unchanged state schema.

- [ ] **Step 5: Run package tests and checks**

Run:

```bash
pnpm --filter @mini-agent/server run test
pnpm --filter @mini-agent/server run check
pnpm --filter @mini-agent/web run test
pnpm --filter @mini-agent/web run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/test/protocol.test.ts packages/web/src/state/reducer.ts packages/web/test/reducer.test.ts
git commit -m "feat: propagate cancelled tool events" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 6: Close regression gaps and verify the workspace

**Files:**
- Modify: `packages/core/test/tool-execution.test.ts`
- Modify: `packages/core/test/agent-loop.test.ts`
- Modify: `packages/core/test/agent.test.ts`
- Modify: `packages/core/src/demo.ts`

- [ ] **Step 1: Add the remaining regression assertions**

Add focused tests for these exact cases:

```ts
test("immediate calls do not force a parallel batch to downgrade", async () => {
  const first = deferred<ToolExecutionResult>();
  const second = deferred<ToolExecutionResult>();
  const started: string[] = [];

  const running = executeToolCallBatch(
    [
      toolCall("missing", "missing"),
      toolCall("a"),
      toolCall("b"),
    ],
    {
      ...options({
        tools: [
          createTool("a", async () => {
            started.push("a");
            return first.promise;
          }),
          createTool("b", async () => {
            started.push("b");
            return second.promise;
          }),
        ],
      }),
      toolExecutionMode: "parallel",
      maxConcurrency: 2,
    },
  );

  await flushMicrotasks();
  assert.deepEqual(started, ["a", "b"]);
  first.resolve({ content: "a" });
  second.resolve({ content: "b" });
  const batch = await running;
  assert.deepEqual(
    batch.messages.map((message) => message.toolCallId),
    ["missing", "a", "b"],
  );
});

test("parallel maxConcurrency one has no overlapping ready calls", async () => {
  let active = 0;
  let peak = 0;
  const tools = ["a", "b"].map((name) =>
    createTool(name, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { content: name };
    }),
  );
  await executeToolCallBatch(
    [toolCall("a"), toolCall("b")],
    {
      ...options({ tools }),
      toolExecutionMode: "parallel",
      maxConcurrency: 1,
    },
  );
  assert.equal(peak, 1);
});
```

In `packages/core/test/agent-loop.test.ts`, assert Tool Result message lifecycle events are contiguous and ordered:

```ts
const committedToolIds = events
  .filter(
    (event) =>
      event.type === "message_end" && event.message.role === "toolResult",
  )
  .map((event) =>
    event.type === "message_end" && event.message.role === "toolResult"
      ? event.message.toolCallId
      : "",
  );
assert.deepEqual(committedToolIds, ["a", "b"]);
```

In `packages/core/test/agent.test.ts`, retain the existing steering-on-`tool_execution_end` test to prove queue behavior is unchanged.

- [ ] **Step 2: Display cancelled events in the demo**

In `packages/core/src/demo.ts`, add:

```ts
case "tool_execution_cancelled":
  console.log(
    `[tool cancelled] ${event.toolName} (${event.toolCallId}): ${event.reason}`,
  );
  break;
```

Do not add a new UI panel or protocol field.

- [ ] **Step 3: Run the complete validation suite**

Run:

```bash
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/core run check
pnpm --filter @mini-agent/server run test
pnpm --filter @mini-agent/server run check
pnpm --filter @mini-agent/web run test
pnpm --filter @mini-agent/web run check
pnpm test
pnpm check
```

Expected: every command exits with status 0.

- [ ] **Step 4: Inspect the final diff for scope and generated artifacts**

Run:

```bash
git --no-pager diff --check
git --no-pager status --short
git --no-pager diff --stat
```

Expected:

- No whitespace errors.
- Only files named in this plan are modified.
- No dependency manifest or lockfile changes.

- [ ] **Step 5: Commit final regression coverage**

```bash
git add packages/core/src/demo.ts packages/core/test/tool-execution.test.ts packages/core/test/agent-loop.test.ts packages/core/test/agent.test.ts
git commit -m "test: cover concurrent tool execution invariants" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
