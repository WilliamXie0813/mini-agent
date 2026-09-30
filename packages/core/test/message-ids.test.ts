import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.ts";
import { createMockStream } from "../src/mock-llm.ts";
import { createReadTool } from "../src/tools.ts";
import type { AssistantMessage, StreamFn } from "../src/types.ts";
import {
  createTestIdGenerator,
  identifiedMessage,
} from "./helpers/messages.ts";

test("a completed tool flow gives every message a unique non-empty id", async () => {
  const agent = new Agent({
    systemPrompt: "test",
    stream: createMockStream(),
    tools: [
      createReadTool({
        "package.json": "{\"name\":\"mini-agent\",\"version\":\"1.0.0\"}",
      }),
    ],
  });

  await agent.prompt("读取 package.json，并告诉我项目名称。");

  const ids = agent.state.messages.map((message) => message.id);
  assert.equal(ids.length, 5);
  assert.equal(ids.every((id) => typeof id === "string" && id.length > 0), true);
  assert.equal(new Set(ids).size, ids.length);
});

test("Agent uses its injected generator for System and User messages", async () => {
  const assistant: AssistantMessage = {
    id: "model-answer",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    timestamp: 3,
  };
  const stream: StreamFn = async function* () {
    yield { type: "start", message: assistant };
    yield { type: "end", message: assistant };
  };
  const agent = new Agent({
    systemPrompt: "test",
    stream,
    tools: [],
    idGenerator: createTestIdGenerator("agent"),
  });

  await agent.prompt("hello");

  assert.deepEqual(
    agent.state.messages.map((message) => message.id),
    ["agent-1", "agent-2", "model-answer"],
  );
});

test("Agent uses its injected generator for a failure message", async () => {
  const stream: StreamFn = async function* () {
    throw new Error("model failed");
  };
  const agent = new Agent({
    systemPrompt: "test",
    stream,
    tools: [],
    idGenerator: createTestIdGenerator("failure"),
  });

  await agent.prompt("hello");

  assert.deepEqual(
    agent.state.messages.map((message) => message.id),
    ["failure-1", "failure-2", "failure-3"],
  );
  assert.equal(agent.state.messages.at(-1)?.role, "assistant");
});

test("mock text stream reuses one injected Assistant id", async () => {
  const idGenerator = createTestIdGenerator("model");
  const stream = createMockStream({ idGenerator });
  const events = [];

  for await (const event of stream(
    [
      identifiedMessage("user-plain", {
        role: "user",
        content: "hello",
        timestamp: 1,
      }),
    ],
    new AbortController().signal,
  )) {
    events.push(event);
  }

  assert.equal(events.length > 2, true);
  assert.deepEqual(
    [...new Set(events.map((event) => event.message.id))],
    ["model-1"],
  );
});

test("mock tool-call stream reuses one injected Assistant id", async () => {
  const stream = createMockStream({
    idGenerator: createTestIdGenerator("tool-request"),
  });
  const events = [];

  for await (const event of stream(
    [
      identifiedMessage("user-tool", {
        role: "user",
        content: "读取 package.json",
        timestamp: 1,
      }),
    ],
    new AbortController().signal,
  )) {
    events.push(event);
  }

  assert.deepEqual(
    [...new Set(events.map((event) => event.message.id))],
    ["tool-request-1"],
  );
});

test("Agent passes its generator to ToolResult creation", async () => {
  const agent = new Agent({
    systemPrompt: "test",
    stream: createMockStream({
      idGenerator: createTestIdGenerator("assistant"),
    }),
    tools: [
      createReadTool({
        "package.json": "{\"name\":\"mini-agent\",\"version\":\"1.0.0\"}",
      }),
    ],
    idGenerator: createTestIdGenerator("agent"),
  });

  await agent.prompt("读取 package.json，并告诉我项目名称。");

  assert.deepEqual(
    agent.state.messages.map((message) => message.id),
    [
      "agent-1",
      "agent-2",
      "assistant-1",
      "agent-3",
      "assistant-2",
    ],
  );
});

test("Agent rejects empty generated message ids", () => {
  assert.throws(
    () =>
      new Agent({
        systemPrompt: "test",
        stream: createMockStream(),
        tools: [],
        idGenerator: () => " ",
      }),
    /Message ID must be non-empty/,
  );
});

test("Agent rejects empty model-provided Assistant ids", async () => {
  const invalidAssistant: AssistantMessage = {
    id: "",
    role: "assistant",
    content: [],
    stopReason: "stop",
    timestamp: 1,
  };
  const stream: StreamFn = async function* () {
    yield { type: "start", message: invalidAssistant };
    yield { type: "end", message: invalidAssistant };
  };
  const agent = new Agent({
    systemPrompt: "test",
    stream,
    tools: [],
    idGenerator: createTestIdGenerator("agent"),
  });

  await agent.prompt("hello");

  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.equal(finalMessage.stopReason, "error");
  assert.equal(finalMessage.errorMessage, "Message ID must be non-empty");
});

test("Agent rejects Assistant ids that change during one stream", async () => {
  const start: AssistantMessage = {
    id: "assistant-start",
    role: "assistant",
    content: [],
    stopReason: "stop",
    timestamp: 1,
  };
  const end: AssistantMessage = {
    ...start,
    id: "assistant-end",
  };
  const stream: StreamFn = async function* () {
    yield { type: "start", message: start };
    yield { type: "end", message: end };
  };
  const agent = new Agent({
    systemPrompt: "test",
    stream,
    tools: [],
    idGenerator: createTestIdGenerator("agent"),
  });

  await agent.prompt("hello");

  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.equal(finalMessage.stopReason, "error");
  assert.equal(
    finalMessage.errorMessage,
    "Model stream changed Assistant message ID",
  );
});
