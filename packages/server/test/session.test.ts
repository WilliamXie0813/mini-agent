import assert from "node:assert/strict";
import {
  MemorySessionStore,
  openOrCreateSession,
  type SessionStore,
} from "@mini-agent/core";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { SessionManager } from "../src/session-manager.ts";
import {
  SessionSocketServer,
  createAgent,
} from "../src/session.ts";
import type { ServerMessage } from "../src/protocol.ts";

interface SocketClient {
  socket: WebSocket;
  received: ServerMessage[];
}

interface TestContext extends SocketClient {
  server: Server;
  url: string;
  manager: SessionManager;
  router: SessionSocketServer;
  store: SessionStore;
}

async function openSocket(url: string): Promise<SocketClient> {
  const socket = new WebSocket(url);
  const received: ServerMessage[] = [];
  socket.on("message", (data) => {
    received.push(JSON.parse(data.toString()) as ServerMessage);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, received };
}

async function connect(
  store: SessionStore = new MemorySessionStore(),
): Promise<TestContext> {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: "/ws" });
  const manager = new SessionManager(store, (options) =>
    createAgent(options),
  );
  const router = new SessionSocketServer(manager);
  router.attach(wss);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  assert(address !== null && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const client = await openSocket(url);
  return {
    server,
    url,
    manager,
    router,
    store,
    ...client,
  };
}

async function cleanup(context: TestContext): Promise<void> {
  context.socket.close();
  context.router.dispose();
  context.manager.dispose();
  await new Promise<void>((resolve) => {
    context.server.close(() => resolve());
  });
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

test("two concurrent opens share one in-flight AgentSession", async () => {
  let factoryCalls = 0;
  const manager = new SessionManager(
    new MemorySessionStore(),
    (options) => {
      factoryCalls += 1;
      return createAgent(options);
    },
    (() => {
      let index = 0;
      return () => `session-id-${++index}`;
    })(),
  );
  const [left, right] = await Promise.all([
    manager.getOrOpen("same"),
    manager.getOrOpen("same"),
  ]);
  assert.equal(left, right);
  assert.equal(factoryCalls, 1);
  manager.dispose();
});

test("default session remains compatible without an explicit open command", async () => {
  const context = await connect();
  try {
    const state = await waitFor(
      context.received,
      (message) => message.type === "state",
    );
    assert.equal(state.type, "state");
    assert.equal(state.state.messages[0]?.role, "system");
    context.socket.send(
      JSON.stringify({ type: "prompt", content: "你好" }),
    );
    await waitFor(
      context.received,
      (message) =>
        message.type === "event" && message.event.type === "agent_end",
    );
  } finally {
    await cleanup(context);
  }
});

test("reconnect receives state before recovery warnings", async () => {
  const store = new MemorySessionStore();
  const opened = await openOrCreateSession({
    store,
    sessionId: "recovering",
    systemMessage: {
      id: "recovering-system",
      role: "system",
      content: "system",
      timestamp: 1,
    },
  });
  await opened.committer.startEffect({
    toolCallId: "call-unknown",
    toolName: "write",
    arguments: { path: "a" },
    replay: "never",
  });
  const context = await connect(store);
  try {
    await waitFor(
      context.received,
      (message) => message.type === "state",
    );
    context.received.length = 0;
    context.socket.send(
      JSON.stringify({
        type: "open_session",
        sessionId: "recovering",
      }),
    );
    await waitFor(
      context.received,
      (message) =>
        message.type === "event" &&
        message.event.type === "session_recovery_warning",
    );
    const stateIndex = context.received.findIndex(
      (message) => message.type === "state",
    );
    const warningIndex = context.received.findIndex(
      (message) =>
        message.type === "event" &&
        message.event.type === "session_recovery_warning",
    );
    assert.ok(stateIndex >= 0);
    assert.ok(warningIndex > stateIndex);
  } finally {
    await cleanup(context);
  }
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("closing a socket removes it from its AgentSession client set", async () => {
  const context = await connect();
  const session = await context.manager.getOrOpen("default");
  // 服务端 socket 与客户端 socket 是不同实例，无法直接比对；
  // 改为观察 close 处理器对 removeClient 的真实调用
  let removed = false;
  const originalRemove = session.removeClient.bind(session);
  session.removeClient = (socket: WebSocket) => {
    removed = true;
    originalRemove(socket);
  };
  try {
    context.socket.close();
    await waitUntil(() => removed);
    assert.equal(removed, true);
  } finally {
    await cleanup(context);
  }
});

test("opening another session isolates broadcasts", async () => {
  const context = await connect();
  const right = await openSocket(context.url);
  try {
    await waitFor(context.received, (m) => m.type === "state");
    await waitFor(right.received, (m) => m.type === "state");
    context.received.length = 0;
    right.received.length = 0;
    context.socket.send(
      JSON.stringify({ type: "open_session", sessionId: "left" }),
    );
    right.socket.send(
      JSON.stringify({ type: "open_session", sessionId: "right" }),
    );
    await waitFor(context.received, (m) => m.type === "session_opened");
    await waitFor(right.received, (m) => m.type === "session_opened");
    context.socket.send(
      JSON.stringify({ type: "prompt", content: "left only" }),
    );
    await waitFor(
      context.received,
      (m) => m.type === "event" && m.event.type === "agent_end",
    );
    assert.equal(
      right.received.some(
        (m) => m.type === "event" && m.event.type === "agent_start",
      ),
      false,
    );
  } finally {
    right.socket.close();
    await cleanup(context);
  }
});
