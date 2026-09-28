# Retry Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add normalized model errors and opt-in, cancellable model-stream retries to `@mini-agent/core` while guaranteeing that tools are never replayed and each logical model request contributes at most one Assistant Message.

**Architecture:** A new `errors.ts` module owns model-error normalization, while `retry.ts` owns pure retry decisions, abort-aware sleeping, and the `streamWithRetry` async-generator boundary. `agent-loop.ts` prepares one immutable request projection, optionally wraps only the model stream, and refuses to commit any stream that does not end with an `end` event; `Agent` only validates and normalizes retry dependencies.

**Tech Stack:** TypeScript 5.9, Node.js 22 built-in test runner, async iterables, AbortSignal, pnpm workspaces, zero runtime dependencies.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/errors.ts` | `ModelError`, error codes, default retryability, unknown-error normalization |
| `packages/core/src/retry.ts` | Retry contracts, default exponential-backoff policy, abort-aware sleep, `streamWithRetry` |
| `packages/core/src/types.ts` | Retry lifecycle events, retry-aware Loop config, tool replay metadata |
| `packages/core/src/agent-loop.ts` | Reuse one prepared request across attempts and enforce the terminal `end` protocol |
| `packages/core/src/agent.ts` | Public retry options, dependency normalization, default sleep injection |
| `packages/core/src/index.ts` | Public error/retry exports |
| `packages/core/test/retry.test.ts` | Error model, policy, jitter/budget, stream retry, locking, cancellation |
| `packages/core/test/agent-loop.test.ts` | Loop event ordering, request reuse, transcript integrity, incomplete-stream behavior |
| `packages/core/test/agent.test.ts` | Public configuration, default sleep, success/error/abort lifecycle |
| `packages/core/test/tools.test.ts` | Replay metadata is accepted but has no runtime replay behavior |

Do not modify `packages/server` or `packages/web`. Do not retry tools, retry after any model event, map real provider errors, add a circuit breaker, or add retry UI.

### Task 1: Add the normalized model error boundary

**Files:**
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/test/retry.test.ts`

- [ ] **Step 1: Write failing error-model tests**

Create `packages/core/test/retry.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelError,
  isRetryableModelError,
  toModelError,
} from "../src/errors.ts";

test("model error codes have one default retryability source", () => {
  for (const code of ["rate_limit", "timeout", "network", "server"] as const) {
    assert.equal(isRetryableModelError(code), true);
  }
  for (const code of [
    "authentication",
    "invalid_request",
    "context_overflow",
    "unknown",
  ] as const) {
    assert.equal(isRetryableModelError(code), false);
  }
});

test("ModelError preserves retry metadata and cause", () => {
  const cause = new Error("socket reset");
  const error = new ModelError("network", "request failed", {
    retryableOverride: false,
    retryAfterMs: 250,
    cause,
  });

  assert.equal(error.name, "ModelError");
  assert.equal(error.code, "network");
  assert.equal(error.retryableOverride, false);
  assert.equal(error.retryAfterMs, 250);
  assert.equal(error.cause, cause);
});

test("toModelError preserves ModelError identity", () => {
  const original = new ModelError("timeout", "timed out");
  assert.equal(toModelError(original), original);
});

test("toModelError wraps other thrown values as unknown", () => {
  const native = new Error("native failure");
  const wrappedNative = toModelError(native);
  assert.equal(wrappedNative.code, "unknown");
  assert.equal(wrappedNative.message, "native failure");
  assert.equal(wrappedNative.cause, native);

  const wrappedValue = toModelError("string failure");
  assert.equal(wrappedValue.code, "unknown");
  assert.equal(wrappedValue.message, "string failure");
  assert.equal(wrappedValue.cause, "string failure");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/retry.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/errors.ts`.

- [ ] **Step 3: Implement the error model**

Create `packages/core/src/errors.ts`:

```ts
export type ModelErrorCode =
  | "rate_limit"
  | "timeout"
  | "network"
  | "server"
  | "authentication"
  | "invalid_request"
  | "context_overflow"
  | "unknown";

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly retryableOverride?: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: ModelErrorCode,
    message: string,
    options: {
      retryableOverride?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ModelError";
    this.code = code;
    this.retryableOverride = options.retryableOverride;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isRetryableModelError(code: ModelErrorCode): boolean {
  return (
    code === "rate_limit" ||
    code === "timeout" ||
    code === "network" ||
    code === "server"
  );
}

export function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  return new ModelError(
    "unknown",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}
```

- [ ] **Step 4: Run the focused test and type-check**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/retry.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: all four tests PASS and TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/errors.ts packages/core/test/retry.test.ts
git commit -m "feat(core): add normalized model errors"
```

### Task 2: Implement the pure default retry policy

**Files:**
- Create: `packages/core/src/retry.ts`
- Modify: `packages/core/test/retry.test.ts`

- [ ] **Step 1: Add deterministic policy tests**

Append to `packages/core/test/retry.test.ts`:

```ts
import { createDefaultRetryPolicy } from "../src/retry.ts";

test("default policy produces 2s 4s 8s delays", () => {
  const policy = createDefaultRetryPolicy({ random: () => 0.5 });
  const error = new ModelError("network", "offline");

  assert.deepEqual(policy.decide({ attempt: 1, error, totalDelayMs: 0 }), {
    retry: true,
    delayMs: 2_000,
  });
  assert.deepEqual(policy.decide({ attempt: 2, error, totalDelayMs: 2_000 }), {
    retry: true,
    delayMs: 4_000,
  });
  assert.deepEqual(policy.decide({ attempt: 3, error, totalDelayMs: 6_000 }), {
    retry: true,
    delayMs: 8_000,
  });
  assert.deepEqual(policy.decide({ attempt: 4, error, totalDelayMs: 14_000 }), {
    retry: false,
  });
});

test("policy rejects non-retryable codes and honors overrides", () => {
  const policy = createDefaultRetryPolicy({ random: () => 0.5 });

  for (const code of [
    "authentication",
    "invalid_request",
    "context_overflow",
    "unknown",
  ] as const) {
    assert.deepEqual(
      policy.decide({
        attempt: 1,
        error: new ModelError(code, code),
        totalDelayMs: 0,
      }),
      { retry: false },
    );
  }

  assert.deepEqual(
    policy.decide({
      attempt: 1,
      error: new ModelError("authentication", "custom", {
        retryableOverride: true,
      }),
      totalDelayMs: 0,
    }),
    { retry: true, delayMs: 2_000 },
  );
  assert.deepEqual(
    policy.decide({
      attempt: 1,
      error: new ModelError("network", "custom", {
        retryableOverride: false,
      }),
      totalDelayMs: 0,
    }),
    { retry: false },
  );
});

test("retryAfter skips jitter but respects single and total caps", () => {
  const capped = createDefaultRetryPolicy({
    maxDelayMs: 5_000,
    maxTotalDelayMs: 10_000,
    jitterRatio: 1,
    random: () => 0,
  });
  const error = new ModelError("rate_limit", "slow down", {
    retryAfterMs: 8_000,
  });

  assert.deepEqual(capped.decide({ attempt: 1, error, totalDelayMs: 0 }), {
    retry: true,
    delayMs: 5_000,
  });
  assert.deepEqual(capped.decide({ attempt: 2, error, totalDelayMs: 6_000 }), {
    retry: false,
  });
});

test("policy applies deterministic jitter endpoints", () => {
  const low = createDefaultRetryPolicy({
    jitterRatio: 0.1,
    random: () => 0,
  });
  const high = createDefaultRetryPolicy({
    jitterRatio: 0.1,
    random: () => 1,
  });
  const error = new ModelError("timeout", "timeout");

  assert.deepEqual(low.decide({ attempt: 1, error, totalDelayMs: 0 }), {
    retry: true,
    delayMs: 1_800,
  });
  assert.deepEqual(high.decide({ attempt: 1, error, totalDelayMs: 0 }), {
    retry: true,
    delayMs: 2_200,
  });
});

test("maxRetries zero disables retries", () => {
  const policy = createDefaultRetryPolicy({ maxRetries: 0 });
  assert.deepEqual(
    policy.decide({
      attempt: 1,
      error: new ModelError("server", "unavailable"),
      totalDelayMs: 0,
    }),
    { retry: false },
  );
});

test("default policy validates options", () => {
  const invalid: Array<Parameters<typeof createDefaultRetryPolicy>[0]> = [
    { maxRetries: -1 },
    { maxRetries: 1.5 },
    { baseDelayMs: 0 },
    { factor: 0 },
    { maxDelayMs: 0 },
    { maxTotalDelayMs: -1 },
    { jitterRatio: -0.1 },
    { jitterRatio: 1.1 },
  ];

  for (const options of invalid) {
    assert.throws(() => createDefaultRetryPolicy(options));
  }
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/retry.test.ts
```

Expected: FAIL because `src/retry.ts` does not exist.

- [ ] **Step 3: Implement retry contracts and default policy**

Create `packages/core/src/retry.ts` with the policy portion first:

```ts
import {
  ModelError,
  isRetryableModelError,
  toModelError,
} from "./errors.ts";
import type {
  EventSink,
  ModelStreamEvent,
} from "./types.ts";

export interface RetryContext {
  attempt: number;
  error: ModelError;
  totalDelayMs: number;
}

export type RetryDecision =
  | { retry: false }
  | { retry: true; delayMs: number };

export interface RetryPolicy {
  decide(context: RetryContext): RetryDecision;
}

export type SleepFn = (
  ms: number,
  signal: AbortSignal,
) => Promise<void>;

export interface DefaultRetryPolicyOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  maxTotalDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be greater than 0`);
  }
  return value;
}

export function createDefaultRetryPolicy(
  options: DefaultRetryPolicyOptions = {},
): RetryPolicy {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = positive("baseDelayMs", options.baseDelayMs ?? 2_000);
  const factor = positive("factor", options.factor ?? 2);
  const maxDelayMs = positive("maxDelayMs", options.maxDelayMs ?? 10_000);
  const maxTotalDelayMs = options.maxTotalDelayMs ?? 30_000;
  const jitterRatio = options.jitterRatio ?? 0.1;
  const random = options.random ?? Math.random;

  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("maxRetries must be a non-negative integer");
  }
  if (!Number.isFinite(maxTotalDelayMs) || maxTotalDelayMs < 0) {
    throw new Error("maxTotalDelayMs must be greater than or equal to 0");
  }
  if (
    !Number.isFinite(jitterRatio) ||
    jitterRatio < 0 ||
    jitterRatio > 1
  ) {
    throw new Error("jitterRatio must be between 0 and 1");
  }

  return {
    decide({ attempt, error, totalDelayMs }) {
      const retryable =
        error.retryableOverride ??
        isRetryableModelError(error.code);
      if (!retryable || attempt > maxRetries) return { retry: false };

      const candidateDelay =
        error.retryAfterMs ??
        baseDelayMs *
          factor ** (attempt - 1) *
          (1 + jitterRatio * (2 * random() - 1));
      const delayMs = Math.min(candidateDelay, maxDelayMs);

      if (totalDelayMs + delayMs > maxTotalDelayMs) {
        return { retry: false };
      }
      return { retry: true, delayMs };
    },
  };
}
```

Keep the currently unused `toModelError`, `EventSink`, and `ModelStreamEvent` imports; Task 3 uses them in the same file.

- [ ] **Step 4: Run policy tests and type-check**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/retry.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: all error and policy tests PASS and TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/retry.ts packages/core/test/retry.test.ts
git commit -m "feat(core): add default retry policy"
```

### Task 3: Add cancellable sleep and the first-event retry boundary

**Files:**
- Modify: `packages/core/src/retry.ts`
- Modify: `packages/core/test/retry.test.ts`

- [ ] **Step 1: Add stream test helpers and retry behavior tests**

Append to the imports in `packages/core/test/retry.test.ts`:

```ts
import {
  defaultSleep,
  streamWithRetry,
} from "../src/retry.ts";
import type {
  AgentEvent,
  AssistantMessage,
  ModelStreamEvent,
} from "../src/types.ts";
import type { SleepFn } from "../src/retry.ts";
```

Append the following helpers and tests:

```ts
function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    stopReason: "stop",
    timestamp: 1,
  };
}

async function collectRetryStream(options: {
  startAttempt: () => AsyncIterable<ModelStreamEvent>;
  sleep?: SleepFn;
  signal?: AbortSignal;
  policy?: ReturnType<typeof createDefaultRetryPolicy>;
}): Promise<{ events: ModelStreamEvent[]; agentEvents: AgentEvent[] }> {
  const events: ModelStreamEvent[] = [];
  const agentEvents: AgentEvent[] = [];
  for await (const event of streamWithRetry({
    startAttempt: options.startAttempt,
    policy:
      options.policy ??
      createDefaultRetryPolicy({ random: () => 0.5 }),
    sleep: options.sleep ?? (async () => {}),
    signal: options.signal ?? new AbortController().signal,
    emit: async (event) => {
      agentEvents.push(event);
    },
  })) {
    events.push(event);
  }
  return { events, agentEvents };
}

test("stream retries pre-event network failure then yields only successful events", async () => {
  let attempts = 0;
  const final = assistant("done");
  const result = await collectRetryStream({
    startAttempt: async function* () {
      attempts += 1;
      if (attempts === 1) {
        throw new ModelError("network", "connection reset");
      }
      yield { type: "start", message: assistant("") };
      yield { type: "end", message: final };
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result.events.map((event) => event.type), ["start", "end"]);
  assert.deepEqual(result.agentEvents, [
    {
      type: "model_retry_scheduled",
      attempt: 2,
      delayMs: 2_000,
      code: "network",
    },
    { type: "model_retry_started", attempt: 2 },
  ]);
});

test("stream never retries after text or start locks the attempt", async () => {
  for (const firstEvent of ["start", "text_delta"] as const) {
    let attempts = 0;
    const source = async function* (): AsyncIterable<ModelStreamEvent> {
      attempts += 1;
      const message = assistant(firstEvent === "text_delta" ? "x" : "");
      if (firstEvent === "start") {
        yield { type: "start", message };
      } else {
        yield { type: "text_delta", delta: "x", message };
      }
      throw new ModelError("network", "late failure");
    };

    await assert.rejects(
      collectRetryStream({ startAttempt: source }),
      /late failure/,
    );
    assert.equal(attempts, 1);
  }
});

test("pre-event EOF retries but post-start EOF fails immediately", async () => {
  let attempts = 0;
  const successful = await collectRetryStream({
    startAttempt: async function* () {
      attempts += 1;
      if (attempts === 1) return;
      const message = assistant("done");
      yield { type: "start", message };
      yield { type: "end", message };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(successful.events.at(-1)?.type, "end");

  let lockedAttempts = 0;
  await assert.rejects(
    collectRetryStream({
      startAttempt: async function* () {
        lockedAttempts += 1;
        yield { type: "start", message: assistant("") };
      },
    }),
    /Model stream ended before end event/,
  );
  assert.equal(lockedAttempts, 1);
});

test("unknown exceptions are normalized and not retried", async () => {
  let attempts = 0;
  await assert.rejects(
    collectRetryStream({
      startAttempt: async function* () {
        attempts += 1;
        throw new Error("plain failure");
      },
    }),
    (error) =>
      error instanceof ModelError &&
      error.code === "unknown" &&
      error.message === "plain failure",
  );
  assert.equal(attempts, 1);
});

test("abort during sleep emits scheduled but not started", async () => {
  const controller = new AbortController();
  const agentEvents: AgentEvent[] = [];
  let attempts = 0;

  const collecting = async () => {
    for await (const _event of streamWithRetry({
      startAttempt: async function* () {
        attempts += 1;
        throw new ModelError("network", "offline");
      },
      policy: createDefaultRetryPolicy({ random: () => 0.5 }),
      sleep: async (_ms, signal) => {
        controller.abort(new DOMException("aborted", "AbortError"));
        signal.throwIfAborted();
      },
      signal: controller.signal,
      emit: async (event) => {
        agentEvents.push(event);
      },
    })) {
      // No model event is expected.
    }
  };

  await assert.rejects(collecting(), { name: "AbortError" });
  assert.equal(attempts, 1);
  assert.deepEqual(agentEvents.map((event) => event.type), [
    "model_retry_scheduled",
  ]);
});

test("completed fake sleeps count toward the total budget", async () => {
  const delays: number[] = [];
  let attempts = 0;
  await assert.rejects(
    collectRetryStream({
      policy: createDefaultRetryPolicy({
        baseDelayMs: 4,
        factor: 1,
        maxDelayMs: 4,
        maxTotalDelayMs: 8,
        maxRetries: 10,
        jitterRatio: 0,
      }),
      sleep: async (ms) => {
        delays.push(ms);
      },
      startAttempt: async function* () {
        attempts += 1;
        throw new ModelError("network", "offline");
      },
    }),
    /network error after 3 attempts: offline/,
  );
  assert.deepEqual(delays, [4, 4]);
  assert.equal(attempts, 3);
});

test("final retry error preserves model metadata and original cause", async () => {
  const root = new Error("socket");
  const thrown = new ModelError("network", "connection reset", {
    retryableOverride: true,
    retryAfterMs: 1,
    cause: root,
  });
  let caught: unknown;
  try {
    await collectRetryStream({
      policy: createDefaultRetryPolicy({
        maxRetries: 1,
        maxDelayMs: 1,
        jitterRatio: 0,
      }),
      startAttempt: async function* () {
        throw thrown;
      },
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof ModelError);
  assert.equal(caught.message, "network error after 2 attempts: connection reset");
  assert.equal(caught.code, "network");
  assert.equal(caught.retryableOverride, true);
  assert.equal(caught.retryAfterMs, 1);
  assert.equal(caught.cause, thrown);
  assert.equal((caught.cause as ModelError).cause, root);
});

test("default sleep rejects immediately for an aborted signal", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("aborted", "AbortError"));
  await assert.rejects(defaultSleep(10_000, controller.signal), {
    name: "AbortError",
  });
});
```

- [ ] **Step 2: Run the focused test to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/retry.test.ts
```

Expected: FAIL because `defaultSleep` and `streamWithRetry` are not exported.

- [ ] **Step 3: Implement abort-aware sleep and streamWithRetry**

Append to `packages/core/src/retry.ts`:

```ts
export const defaultSleep: SleepFn = (ms, signal) => {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

export interface StreamRetryOptions {
  startAttempt: () => AsyncIterable<ModelStreamEvent>;
  policy: RetryPolicy;
  sleep: SleepFn;
  signal: AbortSignal;
  emit: EventSink;
}

function finalAttemptError(error: ModelError, attempt: number): ModelError {
  if (attempt === 1) return error;
  return new ModelError(
    error.code,
    `${error.code} error after ${attempt} attempts: ${error.message}`,
    {
      retryableOverride: error.retryableOverride,
      retryAfterMs: error.retryAfterMs,
      cause: error,
    },
  );
}

export async function* streamWithRetry({
  startAttempt,
  policy,
  sleep,
  signal,
  emit,
}: StreamRetryOptions): AsyncIterable<ModelStreamEvent> {
  let attempt = 1;
  let totalDelayMs = 0;

  while (true) {
    let locked = false;
    let receivedEnd = false;

    try {
      signal.throwIfAborted();
      for await (const event of startAttempt()) {
        locked = true;
        if (event.type === "end") receivedEnd = true;
        yield event;
      }
      if (receivedEnd) return;
      throw new ModelError(
        "network",
        "Model stream ended before end event",
      );
    } catch (thrown) {
      if (signal.aborted) throw thrown;
      const error = toModelError(thrown);
      if (locked) throw finalAttemptError(error, attempt);

      const decision = policy.decide({
        attempt,
        error,
        totalDelayMs,
      });
      if (!decision.retry) {
        throw finalAttemptError(error, attempt);
      }

      const nextAttempt = attempt + 1;
      await emit({
        type: "model_retry_scheduled",
        attempt: nextAttempt,
        delayMs: decision.delayMs,
        code: error.code,
      });
      await sleep(decision.delayMs, signal);
      totalDelayMs += decision.delayMs;
      signal.throwIfAborted();
      await emit({
        type: "model_retry_started",
        attempt: nextAttempt,
      });
      attempt = nextAttempt;
    }
  }
}
```

Ensure the imports at the top of `retry.ts` include the runtime error helpers and type-only model/event contracts shown in Task 2.

- [ ] **Step 4: Run retry tests and type-check**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/retry.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: all retry tests PASS and TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/retry.ts packages/core/test/retry.test.ts
git commit -m "feat(core): retry model streams before first event"
```

### Task 4: Extend public events, Loop config, and tool metadata

**Files:**
- Modify: `packages/core/src/types.ts:1-330`
- Modify: `packages/core/test/tools.test.ts`

- [ ] **Step 1: Add a compile-time replay metadata test**

Add this import to `packages/core/test/tools.test.ts`:

```ts
import type { Tool } from "../src/types.ts";
```

Then append:

```ts
test("tools may declare replay metadata without changing execution", async () => {
  let calls = 0;
  const tool: Tool<Record<string, never>> = {
    name: "write",
    description: "write once",
    replay: "never" as const,
    validate: () => ({ ok: true, value: {} }),
    async execute() {
      calls += 1;
      return { content: "written", isError: false };
    },
  };

  const validation = tool.validate({});
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  await tool.execute(
    "call-write",
    validation.value,
    new AbortController().signal,
    async () => {},
  );
  assert.equal(tool.replay, "never");
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run tests and check to verify the public contracts are missing**

Run:

```bash
pnpm --filter @mini-agent/core run check
```

Expected: FAIL because `Tool` does not yet declare `replay`.

- [ ] **Step 3: Add retry-related imports and public contracts**

At the top of `packages/core/src/types.ts`, add:

```ts
import type { ModelErrorCode } from "./errors.ts";
import type { RetryPolicy, SleepFn } from "./retry.ts";
```

Add before `Tool`:

```ts
export type ReplayPolicy = "safe" | "never";
```

Add this optional field to `Tool<TParameters>` after `executionMode`:

```ts
  /** Future recovery metadata only; the current runtime never replays tools. */
  replay?: ReplayPolicy;
```

Add these two members to `AgentEvent` before `turn_end`:

```ts
  | {
      type: "model_retry_scheduled";
      attempt: number;
      delayMs: number;
      code: ModelErrorCode;
    }
  | {
      type: "model_retry_started";
      attempt: number;
    }
```

Add these optional fields to `AgentLoopConfig` immediately after `stream`:

```ts
  retryPolicy?: RetryPolicy;
  sleep?: SleepFn;
```

Do not add cases for retry events to `Agent.processEvent`; the existing switch intentionally leaves observation-only events state-neutral.

- [ ] **Step 4: Run the core check and existing tests**

Run:

```bash
pnpm --filter @mini-agent/core run check
pnpm --filter @mini-agent/core run test
```

Expected: PASS. Existing Loop configs remain valid because both new fields are optional.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/test/tools.test.ts
git commit -m "feat(core): add retry events and replay metadata"
```

### Task 5: Integrate retries at the model-stream boundary

**Files:**
- Modify: `packages/core/src/agent-loop.ts:17-120`
- Modify: `packages/core/test/agent-loop.test.ts`

- [ ] **Step 1: Add Loop integration helpers and tests**

Add these imports to `packages/core/test/agent-loop.test.ts`:

```ts
import { ModelError } from "../src/errors.ts";
import { createDefaultRetryPolicy } from "../src/retry.ts";
```

Append:

```ts
function baseLoopConfig(stream: StreamFn) {
  return {
    stream,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    hasSteeringMessages: () => false,
    hasFollowUpMessages: () => false,
    toolExecutionMode: "sequential" as const,
    maxToolConcurrency: 4,
  };
}

test("Loop retries with one request projection and commits one Assistant message", async () => {
  const context = {
    messages: [] as AgentMessage[],
    tools: [],
  };
  const requests: Array<readonly AgentMessage[]> = [];
  const events: AgentEvent[] = [];
  let attempts = 0;
  let prepareCalls = 0;
  let transformCalls = 0;

  const stream: StreamFn = async function* (messages) {
    attempts += 1;
    requests.push(messages);
    if (attempts === 1) {
      throw new ModelError("network", "offline");
    }
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      timestamp: 3,
    };
    yield { type: "start", message: { ...message, content: [] } };
    yield { type: "end", message };
  };

  await runAgentLoop(
    [{ role: "user", content: "hello", timestamp: 1 }],
    context,
    {
      ...baseLoopConfig(stream),
      retryPolicy: createDefaultRetryPolicy({ random: () => 0.5 }),
      sleep: async () => {},
      prepareRequest: async () => {
        prepareCalls += 1;
        return undefined;
      },
      transformContext: async (messages) => {
        transformCalls += 1;
        return messages.slice();
      },
    },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
  );

  assert.equal(attempts, 2);
  assert.equal(prepareCalls, 1);
  assert.equal(transformCalls, 1);
  assert.equal(requests[0], requests[1]);
  assert.equal(
    context.messages.filter((message) => message.role === "assistant").length,
    1,
  );
  assert.deepEqual(
    events
      .filter((event) =>
        event.type.startsWith("model_retry_") ||
        event.type.startsWith("message_"),
      )
      .map((event) => event.type),
    [
      "message_start",
      "message_end",
      "model_retry_scheduled",
      "model_retry_started",
      "message_start",
      "message_end",
    ],
  );
});

test("Loop rejects incomplete streams even when retry is disabled", async () => {
  const context = {
    messages: [] as AgentMessage[],
    tools: [],
  };

  await assert.rejects(
    runAgentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      context,
      baseLoopConfig(async function* () {
        yield {
          type: "start",
          message: {
            role: "assistant",
            content: [],
            stopReason: "stop",
            timestamp: 2,
          },
        };
      }),
      async () => {},
      new AbortController().signal,
    ),
    /Model stream ended before end event/,
  );
  assert.equal(
    context.messages.some((message) => message.role === "assistant"),
    false,
  );
});

test("tool failures stay Tool Results and never call model retry policy", async () => {
  let decisions = 0;
  const context = {
    messages: [] as AgentMessage[],
    tools: [
      {
        name: "explode",
        description: "explode",
        replay: "never" as const,
        validate: () => ({ ok: true as const, value: {} }),
        async execute() {
          throw new Error("tool exploded");
        },
      },
    ] as Tool<unknown>[],
  };

  await runAgentLoop(
    [{ role: "user", content: "run", timestamp: 1 }],
    context,
    {
      ...baseLoopConfig(
        createSingleToolCallStream({
          type: "toolCall",
          id: "call-explode",
          name: "explode",
          arguments: {},
        }),
      ),
      retryPolicy: {
        decide() {
          decisions += 1;
          return { retry: false };
        },
      },
      sleep: async () => {},
    },
    async () => {},
    new AbortController().signal,
  );

  const toolResult = context.messages.find(
    (message) => message.role === "toolResult",
  );
  assert.equal(toolResult?.role, "toolResult");
  if (toolResult?.role !== "toolResult") return;
  assert.equal(toolResult.isError, true);
  assert.equal(toolResult.content, "tool exploded");
  assert.equal(decisions, 0);
});
```

The initial user message's `message_start`/`message_end` pair appears before retry events; the assertion deliberately includes it and proves that no Assistant lifecycle event appears before the retry pair.

- [ ] **Step 2: Run the Loop test file to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/agent-loop.test.ts
```

Expected: the retry test FAILS with one attempt, and the incomplete-stream test FAILS because the current Loop commits the last `start` snapshot.

- [ ] **Step 3: Wrap only the model stream and require an end event**

Add to `packages/core/src/agent-loop.ts`:

```ts
import { streamWithRetry } from "./retry.ts";
```

Replace the direct model loop in `streamAssistantResponse` with:

```ts
  const stream =
    config.retryPolicy && config.sleep
      ? streamWithRetry({
          startAttempt: () => config.stream(requestMessages, signal),
          policy: config.retryPolicy,
          sleep: config.sleep,
          signal,
          emit,
        })
      : config.stream(requestMessages, signal);

  let receivedEnd = false;
  for await (const modelEvent of stream) {
    if (modelEvent.type === "end") receivedEnd = true;
    finalMessage = modelEvent.message;

    if (modelEvent.type === "start") {
      await emit({
        type: "message_start",
        message: cloneAssistant(modelEvent.message),
      });
      continue;
    }

    if (
      modelEvent.type === "text_delta" ||
      modelEvent.type === "tool_call"
    ) {
      await emit({
        type: "message_update",
        message: cloneAssistant(modelEvent.message),
        modelEvent,
      });
      continue;
    }

    await emit({ type: "message_end", message: modelEvent.message });
  }

  if (!receivedEnd || !finalMessage) {
    throw new Error("Model stream ended before end event");
  }
```

Keep `requestMessages` outside `startAttempt`; this is what guarantees that prepare/transform run once and every attempt receives the same array object.

- [ ] **Step 4: Run Loop and core regression tests**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/agent-loop.test.ts
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/core run check
```

Expected: PASS. The tool test records zero retry-policy decisions.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-loop.ts packages/core/test/agent-loop.test.ts
git commit -m "feat(core): integrate model stream retries"
```

### Task 6: Normalize retry configuration in Agent

**Files:**
- Modify: `packages/core/src/agent.ts:17-330`
- Modify: `packages/core/test/agent.test.ts`

- [ ] **Step 1: Add public configuration and lifecycle tests**

Add these imports to `packages/core/test/agent.test.ts`:

```ts
import { ModelError } from "../src/errors.ts";
import { createDefaultRetryPolicy } from "../src/retry.ts";
```

Append:

```ts
test("Agent rejects sleep without retryPolicy", () => {
  assert.throws(
    () =>
      createAgentWithExecutionOptions({
        sleep: async () => {},
      }),
    /sleep requires retryPolicy/,
  );
});

test("Agent accepts retryPolicy without a custom sleep", () => {
  assert.doesNotThrow(() =>
    createAgentWithExecutionOptions({
      retryPolicy: createDefaultRetryPolicy(),
    }),
  );
});

test("Agent retries a pre-event failure without duplicate Assistant messages", async () => {
  let attempts = 0;
  const events: AgentEvent[] = [];
  const agent = new Agent({
    systemPrompt: "test",
    tools: [],
    retryPolicy: createDefaultRetryPolicy({ random: () => 0.5 }),
    sleep: async () => {},
    stream: async function* () {
      attempts += 1;
      if (attempts === 1) {
        throw new ModelError("network", "offline");
      }
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
        stopReason: "stop",
        timestamp: 2,
      };
      yield { type: "start", message: { ...message, content: [] } };
      yield { type: "end", message };
    },
  });
  agent.subscribe((event) => {
    events.push(event);
  });

  await agent.prompt("hello");

  assert.equal(attempts, 2);
  assert.equal(
    agent.state.messages.filter((message) => message.role === "assistant")
      .length,
    1,
  );
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith("model_retry_"))
      .map((event) => event.type),
    ["model_retry_scheduled", "model_retry_started"],
  );
});

test("Agent turns non-retryable model errors into one error message", async () => {
  let attempts = 0;
  const agent = new Agent({
    systemPrompt: "test",
    tools: [],
    retryPolicy: createDefaultRetryPolicy(),
    stream: async function* () {
      attempts += 1;
      throw new ModelError("authentication", "invalid token");
    },
  });

  await agent.prompt("hello");

  assert.equal(attempts, 1);
  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  if (final?.role !== "assistant") return;
  assert.equal(final.stopReason, "error");
  assert.equal(final.errorMessage, "invalid token");
});

test("Agent aborts during retry sleep without starting another attempt", async () => {
  let attempts = 0;
  const retryScheduled = new Promise<void>((resolve) => {
    const agent = new Agent({
      systemPrompt: "test",
      tools: [],
      retryPolicy: createDefaultRetryPolicy({ random: () => 0.5 }),
      stream: async function* () {
        attempts += 1;
        throw new ModelError("network", "offline");
      },
    });
    agent.subscribe((event) => {
      if (event.type === "model_retry_scheduled") {
        agent.abort();
        resolve();
      }
    });

    void agent.prompt("hello").then(() => {
      const final = agent.state.messages.at(-1);
      assert.equal(final?.role, "assistant");
      if (final?.role !== "assistant") return;
      assert.equal(final.stopReason, "aborted");
    });
  });

  await retryScheduled;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 1);
});

test("Agent converts an incomplete non-retried stream into an error message", async () => {
  const agent = new Agent({
    systemPrompt: "test",
    tools: [],
    stream: async function* () {
      yield {
        type: "start",
        message: {
          role: "assistant",
          content: [],
          stopReason: "stop",
          timestamp: 2,
        },
      };
    },
  });

  await agent.prompt("hello");

  const assistants = agent.state.messages.filter(
    (message) => message.role === "assistant",
  );
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0]?.stopReason, "error");
  assert.equal(
    assistants[0]?.errorMessage,
    "Model stream ended before end event",
  );
});
```

- [ ] **Step 2: Run Agent tests to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/agent.test.ts
```

Expected: FAIL because `AgentOptions` does not accept `retryPolicy` or `sleep`.

- [ ] **Step 3: Add and normalize Agent retry dependencies**

In `packages/core/src/agent.ts`, add:

```ts
import { defaultSleep } from "./retry.ts";
import type { RetryPolicy, SleepFn } from "./retry.ts";
```

Add to `AgentOptions`:

```ts
  retryPolicy?: RetryPolicy;
  sleep?: SleepFn;
```

Add fields to `Agent` near `stream`:

```ts
  private readonly retryPolicy?: RetryPolicy;
  private readonly sleep?: SleepFn;
```

In the constructor, immediately after `this.stream = options.stream`, add:

```ts
    if (!options.retryPolicy && options.sleep) {
      throw new Error("sleep requires retryPolicy");
    }
    this.retryPolicy = options.retryPolicy;
    this.sleep = options.retryPolicy
      ? options.sleep ?? defaultSleep
      : undefined;
```

Add both normalized fields to `createConfig()`:

```ts
      retryPolicy: this.retryPolicy,
      sleep: this.sleep,
```

Do not add retry event cases to `processEvent`; listeners receive them after state remains unchanged.

- [ ] **Step 4: Make the abort test await the run deterministically**

If the initial test implementation races the final assertion, replace that test with this deterministic version:

```ts
test("Agent aborts during retry sleep without starting another attempt", async () => {
  let attempts = 0;
  let agent!: Agent;
  agent = new Agent({
    systemPrompt: "test",
    tools: [],
    retryPolicy: createDefaultRetryPolicy({ random: () => 0.5 }),
    stream: async function* () {
      attempts += 1;
      throw new ModelError("network", "offline");
    },
  });
  agent.subscribe((event) => {
    if (event.type === "model_retry_scheduled") agent.abort();
  });

  await agent.prompt("hello");

  assert.equal(attempts, 1);
  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  if (final?.role !== "assistant") return;
  assert.equal(final.stopReason, "aborted");
});
```

- [ ] **Step 5: Run Agent and full core validation**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/agent.test.ts
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/core run check
```

Expected: PASS. Retry events do not alter `AgentState`, and abort produces `stopReason: "aborted"`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agent.ts packages/core/test/agent.test.ts
git commit -m "feat(core): expose retry configuration"
```

### Task 7: Publish the API and verify workspace compatibility

**Files:**
- Modify: `packages/core/src/index.ts:1-20`
- Modify: `packages/core/test/retry.test.ts`

- [ ] **Step 1: Add a public-entrypoint contract test**

Append to `packages/core/test/retry.test.ts`:

```ts
test("retry API is available from the package entrypoint", async () => {
  const core = await import("../src/index.ts");

  assert.equal(typeof core.ModelError, "function");
  assert.equal(typeof core.isRetryableModelError, "function");
  assert.equal(typeof core.toModelError, "function");
  assert.equal(typeof core.createDefaultRetryPolicy, "function");
  assert.equal(typeof core.streamWithRetry, "function");
});
```

- [ ] **Step 2: Run the focused test to verify failure**

Run:

```bash
pnpm --filter @mini-agent/core exec node --experimental-strip-types --test test/retry.test.ts
```

Expected: FAIL because the new runtime APIs are not exported by `src/index.ts`.

- [ ] **Step 3: Export the stable error and retry API**

Add to `packages/core/src/index.ts` before `export * from "./types.ts"`:

```ts
export {
  ModelError,
  isRetryableModelError,
  toModelError,
} from "./errors.ts";
export type { ModelErrorCode } from "./errors.ts";
export {
  createDefaultRetryPolicy,
  streamWithRetry,
} from "./retry.ts";
export type {
  DefaultRetryPolicyOptions,
  RetryContext,
  RetryDecision,
  RetryPolicy,
  SleepFn,
  StreamRetryOptions,
} from "./retry.ts";
```

Keep `defaultSleep` internal to `@mini-agent/core`; callers inject a custom `SleepFn` when needed, while `Agent` supplies the production default.

- [ ] **Step 4: Run all required validation**

Run:

```bash
pnpm --filter @mini-agent/core run check
pnpm --filter @mini-agent/core run test
pnpm --filter @mini-agent/server run check
pnpm --filter @mini-agent/server run test
pnpm --filter @mini-agent/web run check
pnpm --filter @mini-agent/web run test
```

Expected:

- Core check and all core tests PASS.
- Server check/tests PASS without source changes because it forwards `AgentEvent` generically.
- Web check/tests PASS without source changes because unknown event colors already fall back and the reducer ignores observation-only events.

- [ ] **Step 5: Inspect the final diff for scope and invariants**

Run:

```bash
git --no-pager diff --check
git --no-pager diff --stat
git --no-pager diff -- packages/core
```

Expected:

- No whitespace errors.
- Changes are limited to the core source/tests listed in this plan.
- `streamWithRetry` surrounds only `config.stream`, not tool execution.
- `requestMessages` is created once outside `startAttempt`.
- No Assistant Message is pushed before an `end` event.
- Retry events never enter `context.messages`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/core/test/retry.test.ts
git commit -m "feat(core): publish retry policy API"
```

## Final acceptance checklist

- [ ] A pre-event `network`, `timeout`, `rate_limit`, or `server` failure can recover when a policy is configured.
- [ ] `authentication`, `invalid_request`, `context_overflow`, and `unknown` fail immediately by default.
- [ ] Any emitted model event, including `start`, locks the attempt and prevents retry.
- [ ] A stream without `end` never commits a pending Assistant Message.
- [ ] Retry attempts reuse the same prepared/transformed request array.
- [ ] Retry waiting is abortable and fake sleep advances the logical total-delay budget.
- [ ] `model_retry_scheduled` precedes sleep; `model_retry_started` appears only after successful sleep.
- [ ] A final multi-attempt `ModelError` reports the attempt count and preserves code, override, retry-after, and cause.
- [ ] Tool errors remain Tool Results and never enter retry decisions.
- [ ] `Tool.replay` is metadata only.
- [ ] Without `retryPolicy`, normal model/queue behavior remains unchanged except for terminal-`end` enforcement.
- [ ] Core, server, and web validation commands all pass.
