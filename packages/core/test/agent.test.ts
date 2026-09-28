import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.ts";
import { createMockStream } from "../src/mock-llm.ts";
import { createReadTool } from "../src/tools.ts";
import type { AgentEvent, AgentMessage, StreamFn, Tool } from "../src/types.ts";

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

test("continue resumes from an existing user tail without duplicating it", async () => {
  const agent = createAgent();
  agent.state.messages.push({
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
