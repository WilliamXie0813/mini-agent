import assert from "node:assert/strict";
import test from "node:test";
import { createReadTool } from "../src/tools.ts";

test("read tool validates and reads a virtual file", async () => {
  const tool = createReadTool({
    "package.json": "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
  });

  const validation = tool.validate({ path: "package.json" });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const result = await tool.execute(
    "call-1",
    validation.value,
    new AbortController().signal,
    async () => {},
  );

  assert.equal(result.isError, false);
  assert.match(result.content, /mock-agent-demo/);
});

test("read tool rejects invalid arguments", () => {
  const tool = createReadTool({});
  assert.deepEqual(tool.validate({ path: 42 }), {
    ok: false,
    error: 'read requires an object with a string "path"',
  });
});

test("read tool returns an explicit missing-file error", async () => {
  const tool = createReadTool({});
  const validation = tool.validate({ path: "missing.txt" });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const result = await tool.execute(
    "call-1",
    validation.value,
    new AbortController().signal,
    async () => {},
  );

  assert.equal(result.isError, true);
  assert.equal(result.content, "File not found: missing.txt");
});
