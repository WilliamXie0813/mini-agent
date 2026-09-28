import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/agent-loop.ts";
import { ModelError } from "../src/errors.ts";
import { createMockStream } from "../src/mock-llm.ts";
import { createDefaultRetryPolicy } from "../src/retry.ts";
import { createReadTool } from "../src/tools.ts";
import {
  assistantMessage,
  createIdGenerator,
  systemMessage,
  userMessage,
} from "./helpers.ts";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  StreamFn,
  Tool,
  ToolCall,
  ToolExecutionResult,
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
        id: "user-package",
        role: "user",
        content: "读取 package.json，并告诉我项目名称。",
        timestamp: 1,
      },
    ],
    context,
    {
      stream: createMockStream(),
      idGenerator: createIdGenerator(),
      reserveSteeringMessages: () => [],
      reserveFollowUpMessages: () => [],
      acknowledgeReservations: () => {},
      hasSteeringMessages: () => false,
      hasFollowUpMessages: () => false,
      toolExecutionMode: "sequential",
      maxToolConcurrency: 4,
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
        id: "user-package",
        role: "user",
        content: "读取 package.json。",
        timestamp: 1,
      },
    ],
    context,
    {
      stream: createMockStream(),
      idGenerator: createIdGenerator(),
      reserveSteeringMessages: () => [],
      reserveFollowUpMessages: () => [],
      acknowledgeReservations: () => {},
      hasSteeringMessages: () => false,
      hasFollowUpMessages: () => false,
      toolExecutionMode: "sequential",
      maxToolConcurrency: 4,
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
        id: "user-package",
        role: "user",
        content: "读取 package.json。",
        timestamp: 1,
      },
    ],
    context,
    {
      stream: createMockStream(),
      idGenerator: createIdGenerator(),
      reserveSteeringMessages: () => [],
      reserveFollowUpMessages: () => [],
      acknowledgeReservations: () => {},
      hasSteeringMessages: () => false,
      hasFollowUpMessages: () => false,
      toolExecutionMode: "sequential",
      maxToolConcurrency: 4,
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
        id: "assistant-done",
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
      id: "assistant-tool-call",
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
    [{ id: "user-run-tool", role: "user", content: "run tool", timestamp: 1 }],
    context,
    {
      stream: createSingleToolCallStream(toolCall),
      idGenerator: createIdGenerator(),
      reserveSteeringMessages: () => [],
      reserveFollowUpMessages: () => [],
      acknowledgeReservations: () => {},
      hasSteeringMessages: () => false,
      hasFollowUpMessages: () => false,
      toolExecutionMode: "sequential",
      maxToolConcurrency: 4,
    },
    async () => {},
    new AbortController().signal,
  );
  return context.messages;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createTwoToolCallStream(): StreamFn {
  return async function* (messages) {
    if (messages.at(-1)?.role === "toolResult") {
      const message: AssistantMessage = {
        id: "assistant-done",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        timestamp: 3,
      };
      yield { type: "start", message };
      yield { type: "end", message };
      return;
    }

    const calls: ToolCall[] = [
      { type: "toolCall", id: "a", name: "a", arguments: {} },
      { type: "toolCall", id: "b", name: "b", arguments: {} },
    ];
    const start: AssistantMessage = {
      id: "assistant-tool-calls",
      role: "assistant",
      content: [],
      stopReason: "toolUse",
      timestamp: 2,
    };
    const end: AssistantMessage = { ...start, content: calls };
    yield { type: "start", message: start };
    for (const toolCall of calls) {
      yield { type: "tool_call", toolCall, message: end };
    }
    yield { type: "end", message: end };
  };
}

function createDeferredTool(
  name: string,
  result: Promise<ToolExecutionResult>,
): Tool<unknown> {
  return {
    name,
    description: name,
    executionMode: "parallel",
    validate: () => ({ ok: true, value: {} }),
    async execute() {
      return result;
    },
  };
}

test("parallel tools emit completion order but commit model source order", async () => {
  const first = deferred<ToolExecutionResult>();
  const second = deferred<ToolExecutionResult>();
  const bothStarted = deferred<void>();
  const secondEnded = deferred<void>();
  const events: AgentEvent[] = [];
  const context = {
    messages: [] as AgentMessage[],
    tools: [
      createDeferredTool("a", first.promise),
      createDeferredTool("b", second.promise),
    ],
  };

  const running = runAgentLoop(
    [{ id: "user-run-both", role: "user", content: "run both", timestamp: 1 }],
    context,
    {
      stream: createTwoToolCallStream(),
      idGenerator: createIdGenerator(),
      reserveSteeringMessages: () => [],
      reserveFollowUpMessages: () => [],
      acknowledgeReservations: () => {},
      hasSteeringMessages: () => false,
      hasFollowUpMessages: () => false,
      toolExecutionMode: "parallel",
      maxToolConcurrency: 2,
    },
    async (event) => {
      events.push(event);
      if (
        events.filter((candidate) => candidate.type === "tool_execution_start")
          .length === 2
      ) {
        bothStarted.resolve();
      }
      if (
        event.type === "tool_execution_end" &&
        event.toolCallId === "b"
      ) {
        secondEnded.resolve();
      }
    },
    new AbortController().signal,
  );

  await bothStarted.promise;
  second.resolve({ content: "B" });
  await secondEnded.promise;
  first.resolve({ content: "A" });
  await running;

  assert.deepEqual(
    events
      .filter((event) => event.type === "tool_execution_end")
      .map((event) => event.toolCallId),
    ["b", "a"],
  );
  assert.deepEqual(
    context.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => message.toolCallId),
    ["a", "b"],
  );
  assert.deepEqual(
    events
      .filter(
        (event) =>
          event.type === "message_end" &&
          event.message.role === "toolResult",
      )
      .map((event) =>
        event.type === "message_end" && event.message.role === "toolResult"
          ? event.message.toolCallId
          : "",
      ),
    ["a", "b"],
  );
});

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
        id: "user-normal",
        role: "user",
        content: "普通消息",
        timestamp: 1,
      },
    ],
    context,
    {
      stream: createMockStream(),
      idGenerator: createIdGenerator(),
      reserveSteeringMessages: () => [],
      reserveFollowUpMessages: () => [],
      acknowledgeReservations: () => {},
      hasSteeringMessages: () => false,
      hasFollowUpMessages: () => false,
      toolExecutionMode: "sequential",
      maxToolConcurrency: 4,
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
    { id: "user-should-not-run", role: "user", content: "不应执行", timestamp: 2 },
  ];

  await runAgentLoop(
    [{ id: "user-normal", role: "user", content: "普通消息", timestamp: 1 }],
    context,
    {
      stream: createMockStream(),
      reserveSteeringMessages: () => [],
      reserveFollowUpMessages: () => {
        const [message] = followUps;
        return message ? [{ queue: "followUp" as const, message }] : [];
      },
      acknowledgeReservations: (reservations) => {
        for (const reservation of reservations) {
          const index = followUps.indexOf(reservation.message);
          if (index >= 0) followUps.splice(index, 1);
        }
      },
      hasSteeringMessages: () => false,
      hasFollowUpMessages: () => followUps.length > 0,
      idGenerator: createIdGenerator(),
      toolExecutionMode: "sequential",
      maxToolConcurrency: 4,
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

test("first Turn prepares and transforms request before streaming", async () => {
  const order: string[] = [];
  const received: AgentMessage[][] = [];
  const stream: StreamFn = async function* (messages) {
    order.push("stream");
    received.push(messages.slice());
    const message: AssistantMessage = {
      id: "assistant-done",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      timestamp: 3,
    };
    yield { type: "start", message };
    yield { type: "end", message };
  };
  const context = {
    messages: [{ id: "system-1", role: "system", content: "system", timestamp: 1 }] as AgentMessage[],
    tools: [],
  };
  await runAgentLoop(
    [{ id: "user-original", role: "user", content: "original", timestamp: 2 }],
    context,
    {
      stream,
      idGenerator: createIdGenerator(),
      reserveSteeringMessages: () => [],
      reserveFollowUpMessages: () => [],
      acknowledgeReservations: () => {},
      hasSteeringMessages: () => false,
      hasFollowUpMessages: () => false,
      toolExecutionMode: "sequential",
      maxToolConcurrency: 4,
      prepareRequest: async (snapshot) => {
        order.push("prepareRequest");
        return {
          messages: [
            ...snapshot.messages,
            { id: "user-prepared", role: "user", content: "prepared", timestamp: 20 },
          ],
        };
      },
      transformContext: async (messages) => {
        order.push("transformContext");
        return messages.filter(
          (message) =>
            message.role !== "user" || message.content !== "original",
        );
      },
    },
    async () => {},
    new AbortController().signal,
  );
  assert.deepEqual(order, ["prepareRequest", "transformContext", "stream"]);
  assert.equal(
    received[0]?.some(
      (message) => message.role === "user" && message.content === "original",
    ),
    false,
  );
  assert.equal(
    context.messages.some(
      (message) => message.role === "user" && message.content === "original",
    ),
    true,
  );
});

test("later Turn starts before prepareNextTurn", async () => {
  const order: string[] = [];
  let streamCount = 0;
  const stream: StreamFn = async function* () {
    streamCount += 1;
    order.push(`stream:${streamCount}`);
    const message: AssistantMessage = {
      id: "assistant-done",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      timestamp: streamCount,
    };
    yield { type: "start", message };
    yield { type: "end", message };
  };
  await runAgentLoop(
    [{ id: "user-start", role: "user", content: "start", timestamp: 1 }],
    { messages: [], tools: [] },
    {
      stream,
      idGenerator: createIdGenerator(),
      reserveSteeringMessages: () => [],
      reserveFollowUpMessages: () => [],
      acknowledgeReservations: () => {},
      hasSteeringMessages: () => false,
      hasFollowUpMessages: () => false,
      toolExecutionMode: "sequential",
      maxToolConcurrency: 4,
      prepareNextTurn: async () => {
        order.push("prepareNextTurn");
        return undefined;
      },
      finishTurn: async () =>
        streamCount === 1 ? { action: "continue" } : undefined,
    },
    async (event) => {
      if (event.type === "turn_start") order.push("turn_start");
    },
    new AbortController().signal,
  );
  assert.deepEqual(order, [
    "turn_start",
    "stream:1",
    "turn_start",
    "prepareNextTurn",
    "stream:2",
  ]);
});

test("CompletedTurn context remains stable after later replacement", async () => {
  const snapshots: Array<readonly AgentMessage[]> = [];
  let turns = 0;
  await runAgentLoop(
    [{ id: "user-start", role: "user", content: "start", timestamp: 1 }],
    { messages: [], tools: [] },
    {
      stream: createMockStream(),
      idGenerator: createIdGenerator(),
      reserveSteeringMessages: () => [],
      reserveFollowUpMessages: () => [],
      acknowledgeReservations: () => {},
      hasSteeringMessages: () => false,
      hasFollowUpMessages: () => false,
      toolExecutionMode: "sequential",
      maxToolConcurrency: 4,
      finishTurn: async (turn) => {
        snapshots.push(turn.context.messages);
        turns += 1;
        return turns === 1 ? { action: "continue" } : undefined;
      },
      prepareNextTurn: async () => ({
        messages: [{ id: "user-rebuilt", role: "user", content: "rebuilt", timestamp: 10 }],
      }),
    },
    async () => {},
    new AbortController().signal,
  );
  assert.deepEqual(
    snapshots[0]?.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.equal(
    snapshots[0]?.some(
      (message) => message.role === "user" && message.content === "rebuilt",
    ),
    false,
  );
});

function baseLoopConfig(stream: StreamFn) {
  return {
    stream,
    idGenerator: createIdGenerator(),
    reserveSteeringMessages: () => [],
    reserveFollowUpMessages: () => [],
    acknowledgeReservations: () => {},
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
      id: "assistant-done",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      timestamp: 3,
    };
    yield { type: "start", message: { ...message, content: [] } };
    yield { type: "end", message };
  };

  await runAgentLoop(
    [{ id: "user-hello", role: "user", content: "hello", timestamp: 1 }],
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
      [{ id: "user-hello", role: "user", content: "hello", timestamp: 1 }],
      context,
      baseLoopConfig(async function* () {
        yield {
          type: "start",
          message: {
            id: "assistant-incomplete",
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
    [{ id: "user-run", role: "user", content: "run", timestamp: 1 }],
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

test("first Turn falls back to follow-up reservation when prompts are empty and no steering is queued", async () => {
  const context = {
    messages: [
      systemMessage(),
      userMessage("user-1", "hello"),
      assistantMessage("assistant-1", "done"),
    ] as AgentMessage[],
    tools: [],
  };
  const followUps: AgentMessage[] = [userMessage("user-later", "later")];
  let streamCalls = 0;
  const stream: StreamFn = async function* () {
    streamCalls += 1;
    const message: AssistantMessage = {
      id: `assistant-next-${streamCalls}`,
      role: "assistant",
      content: [{ type: "text", text: `next-${streamCalls}` }],
      stopReason: "stop",
      timestamp: 10,
    };
    yield { type: "start", message };
    yield { type: "end", message };
  };

  await runAgentLoop(
    [],
    context,
    {
      ...baseLoopConfig(stream),
      reserveFollowUpMessages: () =>
        followUps.length > 0
          ? [{ queue: "followUp" as const, message: followUps[0]! }]
          : [],
      acknowledgeReservations: (reservations) => {
        for (const reservation of reservations) {
          const index = followUps.indexOf(reservation.message);
          if (index >= 0) followUps.splice(index, 1);
        }
      },
      hasFollowUpMessages: () => followUps.length > 0,
    },
    async () => {},
    new AbortController().signal,
  );

  // Without the fallback the loop would invoke the model once against its own
  // answer (assistant-assistant adjacency) before delivering the follow-up.
  assert.equal(streamCalls, 1);
  assert.deepEqual(
    context.messages.map((message) => `${message.role}:${message.id}`),
    [
      "system:system-1",
      "user:user-1",
      "assistant:assistant-1",
      "user:user-later",
      "assistant:assistant-next-1",
    ],
  );
});
