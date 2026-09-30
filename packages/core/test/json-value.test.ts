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
