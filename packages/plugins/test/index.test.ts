import { test } from "node:test";
import assert from "node:assert/strict";

test("plugins package loads", async () => {
  const mod = await import("../src/index.ts");
  assert.ok(mod);
});
