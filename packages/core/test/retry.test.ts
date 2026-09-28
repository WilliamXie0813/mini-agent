import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelError,
  isRetryableModelError,
  toModelError,
} from "../src/errors.ts";
import { createDefaultRetryPolicy } from "../src/retry.ts";

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
