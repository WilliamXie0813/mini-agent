import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.ts";
import { ModelError } from "../src/errors.ts";
import { createMockStream } from "../src/mock-llm.ts";
import { createDefaultRetryPolicy } from "../src/retry.ts";
import { createReadTool } from "../src/tools.ts";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  StreamFn,
  Tool,
  ToolCall,
} from "../src/types.ts";

function createAgent(options: { delayMs?: number } = {}): Agent {
  return new Agent({
    systemPrompt: "You are a deterministic teaching Agent.",
    stream: createMockStream({ delayMs: options.delayMs }),
    tools: [
      createReadTool({
        "package.json":
          "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
      }),
    ],
  });
}

function createAgentWithExecutionOptions(
  overrides: Partial<ConstructorParameters<typeof Agent>[0]> = {},
): Agent {
  return new Agent({
    systemPrompt: "test",
    stream: createMockStream(),
    tools: [],
    ...overrides,
  });
}

function createNamedToolCallStream(names: readonly string[]): StreamFn {
  return async function* (messages) {
    if (messages.at(-1)?.role === "toolResult") {
      const done: AssistantMessage = {
        id: "assistant-done",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        timestamp: Date.now(),
      };
      yield { type: "start", message: done };
      yield { type: "end", message: done };
      return;
    }

    const calls: ToolCall[] = names.map((name) => ({
      type: "toolCall",
      id: `call-${name}`,
      name,
      arguments: {},
    }));
    const start: AssistantMessage = {
      id: "assistant-tool-calls",
      role: "assistant",
      content: [],
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    const end: AssistantMessage = { ...start, content: calls };
    yield { type: "start", message: start };
    for (const toolCall of calls) {
      yield { type: "tool_call", toolCall, message: end };
    }
    yield { type: "end", message: end };
  };
}

test("Agent accepts valid tool execution options", () => {
  assert.doesNotThrow(() =>
    createAgentWithExecutionOptions({
      toolExecutionMode: "parallel",
      maxToolConcurrency: 2,
    }),
  );
});

test("Agent rejects invalid maxToolConcurrency", () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createAgentWithExecutionOptions({ maxToolConcurrency: value }),
      /maxToolConcurrency must be a positive integer/,
    );
  }
});

test("Agent stores complete messages and exposes updated state to subscribers", async () => {
  const agent = createAgent();
  const observedRoles: string[][] = [];

  agent.subscribe((event) => {
    if (event.type === "message_end") {
      observedRoles.push(agent.state.messages.map((message) => message.role));
    }
  });

  await agent.prompt("读取 package.json，并告诉我项目名称。");

  assert.deepEqual(
    agent.state.messages.map((message) => message.role),
    ["system", "user", "assistant", "toolResult", "assistant"],
  );
  assert.deepEqual(observedRoles.at(-1), [
    "system",
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  assert.equal(agent.state.isStreaming, false);
});

test("Agent rejects a second prompt while active", async () => {
  const agent = createAgent({ delayMs: 20 });
  const running = agent.prompt("读取 package.json，并告诉我项目名称。");

  await assert.rejects(
    agent.prompt("第二个请求"),
    /Agent is already processing/,
  );

  await running;
});

test("steer is delivered at the next Turn boundary", async () => {
  const agent = createAgent({ delayMs: 1 });
  let steered = false;

  agent.subscribe((event) => {
    if (event.type === "tool_execution_end" && !steered) {
      steered = true;
      agent.steer("只回答项目名称。");
    }
  });

  await agent.prompt("读取 package.json，并告诉我项目名称。");

  const users = agent.state.messages.filter(
    (message) => message.role === "user",
  );
  assert.deepEqual(
    users.map((message) => message.content),
    ["读取 package.json，并告诉我项目名称。", "只回答项目名称。"],
  );
});

test("followUp is delivered after the first task naturally completes", async () => {
  const agent = createAgent();
  agent.followUp("再告诉我版本号。");

  await agent.prompt("读取 package.json，并告诉我项目名称。");

  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.deepEqual(finalMessage.content, [
    { type: "text", text: "项目版本是 1.0.0。" },
  ]);
});

test("continue consumes a queued follow-up after an Assistant tail", async () => {
  const agent = createAgent();
  await agent.prompt("普通消息");
  agent.followUp("再告诉我版本号。");

  await agent.continue();

  const users = agent.state.messages.filter(
    (message) => message.role === "user",
  );
  assert.equal(users.at(-1)?.content, "再告诉我版本号。");
});

test("abort produces an aborted Assistant message", async () => {
  const agent = createAgent({ delayMs: 20 });
  const running = agent.prompt("普通消息");

  setTimeout(() => agent.abort(), 5);
  await running;

  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.equal(finalMessage.stopReason, "aborted");
  assert.equal(agent.state.isStreaming, false);
});

test("Agent abort clears pending parallel tools through cancelled events", async () => {
  const tools: Tool<unknown>[] = ["a", "b"].map((name) => ({
    name,
    description: name,
    executionMode: "parallel",
    validate: () => ({ ok: true, value: {} }),
    async execute(_id, _parameters, signal) {
      signal.throwIfAborted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return { content: "unreachable" };
    },
  }));
  const agent = new Agent({
    systemPrompt: "test",
    stream: createNamedToolCallStream(["a", "b"]),
    tools,
    toolExecutionMode: "parallel",
    maxToolConcurrency: 2,
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
    if (
      events.filter((candidate) => candidate.type === "tool_execution_start")
        .length === 2
    ) {
      agent.abort();
    }
  });

  await agent.prompt("run");

  assert.equal(
    events.filter((event) => event.type === "tool_execution_cancelled").length,
    2,
  );
  assert.deepEqual([...agent.state.pendingToolCalls], []);
  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.equal(finalMessage.stopReason, "aborted");
});

test("Agent finally clears pending state when a listener fails", async () => {
  const agent = new Agent({
    systemPrompt: "test",
    stream: createNamedToolCallStream(["a"]),
    tools: [
      {
        name: "a",
        description: "a",
        executionMode: "parallel",
        validate: () => ({ ok: true, value: {} }),
        async execute() {
          return { content: "a" };
        },
      },
    ],
    toolExecutionMode: "parallel",
  });
  let failed = false;
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start" && !failed) {
      failed = true;
      throw new Error("listener failed");
    }
  });

  await agent.prompt("run");

  assert.equal(failed, true);
  assert.deepEqual([...agent.state.pendingToolCalls], []);
  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.equal(finalMessage.stopReason, "error");
  assert.equal(finalMessage.errorMessage, "Tool event dispatch failed");
});

test("continue resumes from an existing user tail without duplicating it", async () => {
  const agent = createAgent();
  agent.state.messages.push({
    id: "user-package",
    role: "user",
    content: "读取 package.json，并告诉我项目名称。",
    timestamp: 1,
  });

  await agent.continue();

  const users = agent.state.messages.filter(
    (message) => message.role === "user",
  );
  assert.equal(users.length, 1);
  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.deepEqual(finalMessage.content, [
    { type: "text", text: "项目名称是 mock-agent-demo。" },
  ]);
});

test("continue resumes directly from a tool-result tail", async () => {
  const agent = createAgent();
  agent.state.messages.push({
    id: "tool-result-read",
    role: "toolResult",
    toolCallId: "call-read-package",
    toolName: "read",
    content: "{\"name\":\"from-tool-result\",\"version\":\"3.0.0\"}",
    isError: false,
    timestamp: 1,
  });

  await agent.continue();

  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.deepEqual(finalMessage.content, [
    { type: "text", text: "项目名称是 from-tool-result。" },
  ]);
});

test("waitForIdle settles after the active run finishes", async () => {
  const agent = createAgent({ delayMs: 2 });
  const running = agent.prompt("普通消息");
  const idle = agent.waitForIdle();

  await idle;
  await running;

  assert.equal(agent.state.isStreaming, false);
});

test("reset preserves only the System message and clears queued work", async () => {
  const agent = createAgent();
  await agent.prompt("普通消息");
  agent.followUp("再告诉我版本号。");

  agent.reset();

  assert.deepEqual(
    agent.state.messages.map((message) => message.role),
    ["system"],
  );
  await agent.prompt("新的普通消息");
  assert.equal(
    agent.state.messages.some(
      (message) =>
        message.role === "user" && message.content === "再告诉我版本号。",
    ),
    false,
  );
});

test("abort stops a cooperative long-running tool", async () => {
  const stream: StreamFn = async function* (messages) {
    const last = messages.at(-1);
    if (last?.role === "toolResult") {
      const message = {
        id: "assistant-finished",
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "finished" }],
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      yield { type: "start", message };
      yield { type: "end", message };
      return;
    }

    const toolCall = {
      type: "toolCall" as const,
      id: "call-slow",
      name: "slow",
      arguments: {},
    };
    const start = {
      id: "assistant-tool-call",
      role: "assistant" as const,
      content: [],
      stopReason: "toolUse" as const,
      timestamp: Date.now(),
    };
    const end = { ...start, content: [toolCall] };
    yield { type: "start", message: start };
    yield { type: "tool_call", toolCall, message: end };
    yield { type: "end", message: end };
  };

  const slowTool: Tool<unknown> = {
    name: "slow",
    description: "Wait until aborted",
    validate: () => ({ ok: true, value: {} }),
    async execute(_id, _parameters, signal) {
      signal.throwIfAborted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return { content: "unreachable" };
    },
  };

  const agent = new Agent({
    systemPrompt: "Test",
    stream,
    tools: [slowTool],
  });
  const running = agent.prompt("run slow tool");
  setTimeout(() => agent.abort(), 5);
  await running;

  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.equal(finalMessage.stopReason, "aborted");
});

test("model failure becomes an error Assistant message", async () => {
  const failingStream: StreamFn = async function* () {
    throw new Error("model exploded");
  };
  const agent = new Agent({
    systemPrompt: "Test",
    stream: failingStream,
    tools: [],
  });

  await agent.prompt("trigger failure");

  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.equal(finalMessage.stopReason, "error");
  assert.equal(finalMessage.errorMessage, "model exploded");
});

  test("Agent transform changes model input without changing transcript", async () => {
    const requests: AgentMessage[][] = [];
    const agent = new Agent({
      systemPrompt: "system",
      stream: async function* (messages) {
        requests.push(messages.slice());
        const message = {
          id: "assistant-done",
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "done" }],
          stopReason: "stop" as const,
          timestamp: 3,
        };
        yield { type: "start", message };
        yield { type: "end", message };
      },
      tools: [],
      transformContext: async (messages) =>
        messages.filter((message) => message.role !== "system"),
    });
    await agent.prompt("hello");
    assert.deepEqual(requests[0]?.map((message) => message.role), ["user"]);
    assert.deepEqual(
      agent.state.messages.map((message) => message.role),
      ["system", "user", "assistant"],
    );
  });

  test("prepareRequest errors become error Assistant messages", async () => {
    const agent = new Agent({
      systemPrompt: "system",
      stream: createMockStream(),
      tools: [],
      prepareRequest: async () => {
        throw new Error("prepare request exploded");
      },
    });
    await agent.prompt("hello");
    const final = agent.state.messages.at(-1);
    assert.equal(final?.role, "assistant");
    if (final?.role !== "assistant") return;
    assert.equal(final.stopReason, "error");
    assert.equal(final.errorMessage, "prepare request exploded");
  });

  test("aborting a slow context Hook produces an aborted Assistant message", async () => {
    const agent = new Agent({
      systemPrompt: "system",
      stream: createMockStream(),
      tools: [],
      prepareRequest: async (_context, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return undefined;
      },
    });
    const running = agent.prompt("hello");
    setTimeout(() => agent.abort(), 5);
    await running;
    const final = agent.state.messages.at(-1);
    assert.equal(final?.role, "assistant");
    if (final?.role !== "assistant") return;
    assert.equal(final.stopReason, "aborted");
  });

  test("prepareNextTurn failure remains paired with a started Turn", async () => {
    const events: AgentEvent[] = [];
    let turns = 0;
    const agent = new Agent({
      systemPrompt: "system",
      stream: createMockStream(),
      tools: [],
      finishTurn: async () => {
        turns += 1;
        return turns === 1 ? { action: "continue" } : undefined;
      },
      prepareNextTurn: async () => {
        throw new Error("next Turn preparation failed");
      },
    });
    agent.subscribe((event) => {
      events.push(event);
    });
    await agent.prompt("hello");
    assert.equal(
      events.filter((event) => event.type === "turn_start").length,
      2,
    );
    assert.equal(events.filter((event) => event.type === "turn_end").length, 2);
    const final = agent.state.messages.at(-1);
    assert.equal(final?.role, "assistant");
    if (final?.role !== "assistant") return;
    assert.equal(final.stopReason, "error");
  });

test("Agent rejects sleep without retryPolicy", () => {
  assert.throws(
    () =>
      createAgentWithExecutionOptions({
        sleep: async () => {},
      }),
    /sleep requires retryPolicy/,
  );
});

test("Agent accepts retryPolicy without a custom sleep", () => {
  assert.doesNotThrow(() =>
    createAgentWithExecutionOptions({
      retryPolicy: createDefaultRetryPolicy(),
    }),
  );
});

test("Agent retries a pre-event failure without duplicate Assistant messages", async () => {
  let attempts = 0;
  const events: AgentEvent[] = [];
  const agent = new Agent({
    systemPrompt: "test",
    tools: [],
    retryPolicy: createDefaultRetryPolicy({ random: () => 0.5 }),
    sleep: async () => {},
    stream: async function* () {
      attempts += 1;
      if (attempts === 1) {
        throw new ModelError("network", "offline");
      }
      const message: AssistantMessage = {
        id: "assistant-recovered",
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
        stopReason: "stop",
        timestamp: 2,
      };
      yield { type: "start", message: { ...message, content: [] } };
      yield { type: "end", message };
    },
  });
  agent.subscribe((event) => {
    events.push(event);
  });

  await agent.prompt("hello");

  assert.equal(attempts, 2);
  assert.equal(
    agent.state.messages.filter((message) => message.role === "assistant")
      .length,
    1,
  );
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith("model_retry_"))
      .map((event) => event.type),
    ["model_retry_scheduled", "model_retry_started"],
  );
});

test("Agent turns non-retryable model errors into one error message", async () => {
  let attempts = 0;
  const agent = new Agent({
    systemPrompt: "test",
    tools: [],
    retryPolicy: createDefaultRetryPolicy(),
    stream: async function* () {
      attempts += 1;
      throw new ModelError("authentication", "invalid token");
    },
  });

  await agent.prompt("hello");

  assert.equal(attempts, 1);
  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  if (final?.role !== "assistant") return;
  assert.equal(final.stopReason, "error");
  assert.equal(final.errorMessage, "invalid token");
});

test("Agent aborts during retry sleep without starting another attempt", async () => {
  let attempts = 0;
  let agent!: Agent;
  agent = new Agent({
    systemPrompt: "test",
    tools: [],
    retryPolicy: createDefaultRetryPolicy({ random: () => 0.5 }),
    stream: async function* () {
      attempts += 1;
      throw new ModelError("network", "offline");
    },
  });
  agent.subscribe((event) => {
    if (event.type === "model_retry_scheduled") agent.abort();
  });

  await agent.prompt("hello");

  assert.equal(attempts, 1);
  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  if (final?.role !== "assistant") return;
  assert.equal(final.stopReason, "aborted");
});

test("Agent converts an incomplete non-retried stream into an error message", async () => {
  const agent = new Agent({
    systemPrompt: "test",
    tools: [],
    stream: async function* () {
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
    },
  });

  await agent.prompt("hello");

  const assistants = agent.state.messages.filter(
    (message) => message.role === "assistant",
  );
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0]?.stopReason, "error");
  assert.equal(
    assistants[0]?.errorMessage,
    "Model stream ended before end event",
  );
});
