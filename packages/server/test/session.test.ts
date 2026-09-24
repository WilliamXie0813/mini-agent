import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { AgentSession, createAgent } from "../src/session.ts";
import type { ServerMessage } from "../src/protocol.ts";

interface TestContext {
  server: Server;
  socket: WebSocket;
  received: ServerMessage[];
}

async function connect(): Promise<TestContext> {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: "/ws" });
  new AgentSession(createAgent()).attach(wss);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  assert(address !== null && typeof address === "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const received: ServerMessage[] = [];
  socket.on("message", (data) => {
    received.push(JSON.parse(data.toString()) as ServerMessage);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { server, socket, received };
}

function waitFor(
  received: ServerMessage[],
  predicate: (message: ServerMessage) => boolean,
  timeoutMs = 5000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = received.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for expected message"));
      }
    }, 10);
  });
}

async function cleanup(context: TestContext): Promise<void> {
  context.socket.close();
  await new Promise<void>((resolve) => {
    context.server.close(() => resolve());
  });
}

test("connection receives a state message with the system prompt", async () => {
  const context = await connect();
  try {
    const message = await waitFor(
      context.received,
      (m) => m.type === "state",
    );
    assert.equal(message.type, "state");
    assert.equal(message.state.messages[0]?.role, "system");
    assert.deepEqual(message.state.queues, { steering: [], followUp: [] });
    assert.equal(message.state.isStreaming, false);
  } finally {
    await cleanup(context);
  }
});

test("prompt command produces a full event stream and final answer", async () => {
  const context = await connect();
  try {
    context.socket.send(
      JSON.stringify({
        type: "prompt",
        content: "读取 package.json，并告诉我项目名称。",
      }),
    );
    await waitFor(
      context.received,
      (m) => m.type === "event" && m.event.type === "agent_end",
    );
    const toolStart = context.received.find(
      (m) => m.type === "event" && m.event.type === "tool_execution_start",
    );
    assert.ok(toolStart, "expected a tool_execution_start event");

    const finalState = [...context.received]
      .reverse()
      .find((m) => m.type === "state");
    assert.ok(finalState && finalState.type === "state");
    const lastMessage = finalState.state.messages.at(-1);
    assert.equal(lastMessage?.role, "assistant");
    if (lastMessage?.role === "assistant") {
      const text = lastMessage.content.find((part) => part.type === "text");
      assert.ok(text && text.type === "text");
      assert.ok(text.text.includes("mock-agent-demo"));
    }
  } finally {
    await cleanup(context);
  }
});

test("a second prompt while busy yields an error message", async () => {
  const context = await connect();
  try {
    context.socket.send(
      JSON.stringify({
        type: "prompt",
        content: "读取 package.json，并告诉我项目名称。",
      }),
    );
    await waitFor(
      context.received,
      (m) => m.type === "event" && m.event.type === "agent_start",
    );
    // Relies on the first run still streaming (mock answer ~16 chars × 30ms delay).
    context.socket.send(
      JSON.stringify({ type: "prompt", content: "又来一次" }),
    );
    const error = await waitFor(
      context.received,
      (m) => m.type === "error",
    );
    assert.equal(error.type, "error");
    assert.match(error.message, /already processing/);
    await waitFor(
      context.received,
      (m) => m.type === "event" && m.event.type === "agent_end",
    );
  } finally {
    await cleanup(context);
  }
});

test("steer command is visible in the queue state while running", async () => {
  const context = await connect();
  try {
    context.socket.send(
      JSON.stringify({
        type: "prompt",
        content: "读取 package.json，并告诉我项目名称。",
      }),
    );
    await waitFor(
      context.received,
      (m) => m.type === "event" && m.event.type === "message_update",
    );
    context.socket.send(
      JSON.stringify({ type: "steer", content: "只回答项目名称" }),
    );
    const state = await waitFor(
      context.received,
      (m) => m.type === "state" && m.state.queues.steering.length > 0,
    );
    assert.equal(state.type, "state");
    assert.equal(state.state.queues.steering[0]?.content, "只回答项目名称");
    await waitFor(
      context.received,
      (m) => m.type === "event" && m.event.type === "agent_end",
    );
  } finally {
    await cleanup(context);
  }
});

test("reset command clears the transcript back to the system message", async () => {
  const context = await connect();
  try {
    context.socket.send(
      JSON.stringify({ type: "prompt", content: "你好" }),
    );
    await waitFor(
      context.received,
      (m) => m.type === "event" && m.event.type === "agent_end",
    );
    context.socket.send(JSON.stringify({ type: "reset" }));
    await waitFor(context.received, (m) => m.type === "reset");
    const state = await waitFor(
      context.received,
      (m) => m.type === "state" && m.state.messages.length === 1,
    );
    assert.equal(state.type, "state");
    assert.equal(state.state.messages[0]?.role, "system");
  } finally {
    await cleanup(context);
  }
});
