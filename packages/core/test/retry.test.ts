import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelError,
  isRetryableModelError,
  toModelError,
} from "../src/errors.ts";
import { createDefaultRetryPolicy } from "../src/retry.ts";
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

test("retry API is available from the package entrypoint", async () => {
  const core = await import("../src/index.ts");

  assert.equal(typeof core.ModelError, "function");
  assert.equal(typeof core.isRetryableModelError, "function");
  assert.equal(typeof core.toModelError, "function");
  assert.equal(typeof core.createDefaultRetryPolicy, "function");
  assert.equal(typeof core.streamWithRetry, "function");
});
