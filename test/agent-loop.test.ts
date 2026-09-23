import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/agent-loop.ts";
import { createMockStream } from "../src/mock-llm.ts";
import { createReadTool } from "../src/tools.ts";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  StreamFn,
  Tool,
  ToolCall,
} from "../src/types.ts";

test("loop completes user to tool to final answer flow", async () => {
  const events: AgentEvent[] = [];
  const context = {
    messages: [] as AgentMessage[],
    tools: [
      createReadTool({
        "package.json":
          "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
      }),
    ],
  };

  await runAgentLoop(
    [
      {
        role: "user",
        content: "读取 package.json，并告诉我项目名称。",
        timestamp: 1,
      },
    ],
    context,
    {
      stream: createMockStream(),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
    },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
  );

  const roles = context.messages.map((message) => message.role);
  assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant"]);

  const finalMessage = context.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.deepEqual(finalMessage.content, [
    { type: "text", text: "项目名称是 mock-agent-demo。" },
  ]);

  assert.deepEqual(
    events
      .filter((event) =>
        [
          "agent_start",
          "turn_start",
          "tool_execution_start",
          "tool_execution_end",
          "turn_end",
          "agent_end",
        ].includes(event.type),
      )
      .map((event) => event.type),
    [
      "agent_start",
      "turn_start",
      "tool_execution_start",
      "tool_execution_end",
      "turn_end",
      "turn_start",
      "turn_end",
      "agent_end",
    ],
  );
});

test("beforeToolCall can block execution", async () => {
  const context = {
    messages: [] as AgentMessage[],
    tools: [createReadTool({ "package.json": "{}" })],
  };

  await runAgentLoop(
    [
      {
        role: "user",
        content: "读取 package.json。",
        timestamp: 1,
      },
    ],
    context,
    {
      stream: createMockStream(),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      beforeToolCall: async () => ({
        block: true,
        reason: "Reading files is blocked",
      }),
    },
    async () => {},
    new AbortController().signal,
  );

  const result = context.messages.find(
    (message) => message.role === "toolResult",
  );
  assert.equal(result?.role, "toolResult");
  if (result?.role !== "toolResult") return;
  assert.equal(result.isError, true);
  assert.equal(result.content, "Reading files is blocked");
});

test("afterToolCall can replace a successful result", async () => {
  const context = {
    messages: [] as AgentMessage[],
    tools: [
      createReadTool({
        "package.json": "{\"name\":\"original\",\"version\":\"1.0.0\"}",
      }),
    ],
  };

  await runAgentLoop(
    [
      {
        role: "user",
        content: "读取 package.json。",
        timestamp: 1,
      },
    ],
    context,
    {
      stream: createMockStream(),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      afterToolCall: async () => ({
        content: "{\"name\":\"replaced\",\"version\":\"2.0.0\"}",
        isError: false,
      }),
    },
    async () => {},
    new AbortController().signal,
  );

  const finalMessage = context.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.deepEqual(finalMessage.content, [
    { type: "text", text: "项目名称是 replaced。" },
  ]);
});

function createSingleToolCallStream(toolCall: ToolCall): StreamFn {
  return async function* (messages) {
    if (messages.at(-1)?.role === "toolResult") {
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Tool result observed." }],
        stopReason: "stop",
        timestamp: Date.now(),
      };
      yield { type: "start", message };
      yield { type: "end", message };
      return;
    }

    const start: AssistantMessage = {
      role: "assistant",
      content: [],
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    const end: AssistantMessage = { ...start, content: [toolCall] };
    yield { type: "start", message: start };
    yield { type: "tool_call", toolCall, message: end };
    yield { type: "end", message: end };
  };
}

async function runSingleToolCall(
  toolCall: ToolCall,
  tools: Tool<unknown>[],
): Promise<AgentMessage[]> {
  const context = { messages: [] as AgentMessage[], tools };
  await runAgentLoop(
    [{ role: "user", content: "run tool", timestamp: 1 }],
    context,
    {
      stream: createSingleToolCallStream(toolCall),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
    },
    async () => {},
    new AbortController().signal,
  );
  return context.messages;
}

test("unknown tool becomes an explicit error tool result", async () => {
  const messages = await runSingleToolCall(
    {
      type: "toolCall",
      id: "call-missing",
      name: "missing",
      arguments: {},
    },
    [],
  );

  const result = messages.find((message) => message.role === "toolResult");
  assert.equal(result?.role, "toolResult");
  if (result?.role !== "toolResult") return;
  assert.equal(result.isError, true);
  assert.equal(result.content, "Unknown tool: missing");
});

test("invalid tool arguments become an explicit error tool result", async () => {
  const messages = await runSingleToolCall(
    {
      type: "toolCall",
      id: "call-invalid",
      name: "read",
      arguments: { path: 42 },
    },
    [createReadTool({})],
  );

  const result = messages.find((message) => message.role === "toolResult");
  assert.equal(result?.role, "toolResult");
  if (result?.role !== "toolResult") return;
  assert.equal(result.isError, true);
  assert.equal(
    result.content,
    'read requires an object with a string "path"',
  );
});

test("tool exceptions become explicit error tool results", async () => {
  const explodingTool: Tool<unknown> = {
    name: "explode",
    description: "Throw a test error",
    validate: () => ({ ok: true, value: {} }),
    async execute() {
      throw new Error("boom");
    },
  };
  const messages = await runSingleToolCall(
    {
      type: "toolCall",
      id: "call-explode",
      name: "explode",
      arguments: {},
    },
    [explodingTool],
  );

  const result = messages.find((message) => message.role === "toolResult");
  assert.equal(result?.role, "toolResult");
  if (result?.role !== "toolResult") return;
  assert.equal(result.isError, true);
  assert.equal(result.content, "boom");
});

test("finishTurn can request exactly one extra context-only Turn", async () => {
  const context = {
    messages: [] as AgentMessage[],
    tools: [],
  };
  let requested = false;
  let turnCount = 0;

  await runAgentLoop(
    [
      {
        role: "user",
        content: "普通消息",
        timestamp: 1,
      },
    ],
    context,
    {
      stream: createMockStream(),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      finishTurn: async () => {
        turnCount += 1;
        if (!requested) {
          requested = true;
          return { action: "continue" };
        }
        return undefined;
      },
    },
    async () => {},
    new AbortController().signal,
  );

  assert.equal(turnCount, 2);
});

test("finishTurn can stop before a queued follow-up", async () => {
  const context = {
    messages: [] as AgentMessage[],
    tools: [],
  };
  const followUps: AgentMessage[] = [
    { role: "user", content: "不应执行", timestamp: 2 },
  ];

  await runAgentLoop(
    [{ role: "user", content: "普通消息", timestamp: 1 }],
    context,
    {
      stream: createMockStream(),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => followUps.splice(0),
      finishTurn: async () => ({ action: "end" }),
    },
    async () => {},
    new AbortController().signal,
  );

  assert.equal(
    context.messages.some(
      (message) => message.role === "user" && message.content === "不应执行",
    ),
    false,
  );
});
