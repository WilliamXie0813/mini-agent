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
