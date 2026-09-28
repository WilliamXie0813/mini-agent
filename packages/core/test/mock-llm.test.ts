import assert from "node:assert/strict";
import test from "node:test";
import { createMockStream } from "../src/mock-llm.ts";
import type { AgentMessage, ModelStreamEvent } from "../src/types.ts";

async function collect(
  messages: AgentMessage[],
  signal = new AbortController().signal,
  options: Parameters<typeof createMockStream>[0] = {},
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of createMockStream(options)(messages, signal)) {
    events.push(event);
  }
  return events;
}

test("one mock stream uses one Assistant message id", async () => {
  const ids = ["assistant-fixed"];
  const events = await collect(
    [{ id: "user-1", role: "user", content: "hello", timestamp: 1 }],
    new AbortController().signal,
    { idGenerator: () => ids[0]! },
  );

  assert.deepEqual(
    [...new Set(events.map((event) => event.message.id))],
    ["assistant-fixed"],
  );
});

test("mock model requests package.json when no read result exists", async () => {
  const events = await collect([
    {
      id: "user-package",
      role: "user",
      content: "读取 package.json，并告诉我项目名称。",
      timestamp: 1,
    },
  ]);

  const toolEvent = events.find((event) => event.type === "tool_call");
  assert.equal(toolEvent?.type, "tool_call");
  if (toolEvent?.type !== "tool_call") return;
  assert.deepEqual(toolEvent.toolCall.arguments, { path: "package.json" });
});

test("mock model answers from a read tool result", async () => {
  const events = await collect([
    {
      id: "user-package",
      role: "user",
      content: "读取 package.json，并告诉我项目名称。",
      timestamp: 1,
    },
    {
      id: "tool-result-read",
      role: "toolResult",
      toolCallId: "call-read-package",
      toolName: "read",
      content: "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
      isError: false,
      timestamp: 2,
    },
  ]);

  const end = events.at(-1);
  assert.equal(end?.type, "end");
  if (end?.type !== "end") return;
  assert.deepEqual(end.message.content, [
    { type: "text", text: "项目名称是 mock-agent-demo。" },
  ]);
  assert.equal(end.message.stopReason, "stop");
});

test("mock model answers a version follow-up from existing tool history", async () => {
  const events = await collect([
    {
      id: "tool-result-read",
      role: "toolResult",
      toolCallId: "call-read-package",
      toolName: "read",
      content: "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
      isError: false,
      timestamp: 1,
    },
    {
      id: "user-version",
      role: "user",
      content: "再告诉我版本号。",
      timestamp: 2,
    },
  ]);

  const end = events.at(-1);
  assert.equal(end?.type, "end");
  if (end?.type !== "end") return;
  assert.deepEqual(end.message.content, [
    { type: "text", text: "项目版本是 1.0.0。" },
  ]);
});
