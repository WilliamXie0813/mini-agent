import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@mini-agent/server";
import { AgentClient, type WebSocketLike } from "../src/state/client";

class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
  private readonly listeners = new Map<
    string,
    Array<(event: unknown) => void>
  >();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close", {});
  }

  addEventListener(
    type: string,
    listener: (event: unknown) => void,
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  receive(message: ServerMessage): void {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

function createClient() {
  const socket = new FakeSocket();
  const client = new AgentClient("ws://test/ws", () => socket);
  return { client, socket };
}

function createTrackedClient() {
  const sockets: FakeSocket[] = [];
  const factory = vi.fn(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const client = new AgentClient("ws://test/ws", factory);
  return { client, sockets, factory };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentClient", () => {
  it("applies state messages and reports connected on open", () => {
    const { client, socket } = createClient();
    client.connect();
    socket.emit("open", {});
    expect(client.getSnapshot().connected).toBe(true);

    socket.receive({
      type: "state",
      state: {
        messages: [{ role: "system", content: "s", timestamp: 1 }],
        isStreaming: false,
        pendingToolCalls: [],
        queues: { steering: [], followUp: [] },
      },
    });
    expect(client.getSnapshot().state.messages).toHaveLength(1);
    client.dispose();
  });

  it("reduces event messages into state and stores them in the log", () => {
    const { client, socket } = createClient();
    client.connect();
    socket.emit("open", {});
    socket.receive({ type: "event", event: { type: "agent_start" } });
    expect(client.getSnapshot().state.isStreaming).toBe(true);
    expect(client.getSnapshot().events).toHaveLength(1);
    client.dispose();
  });

  it("stores server error messages as lastError", () => {
    const { client, socket } = createClient();
    client.connect();
    socket.emit("open", {});
    socket.receive({ type: "error", message: "Agent is already processing" });
    expect(client.getSnapshot().lastError).toBe(
      "Agent is already processing",
    );
    client.dispose();
  });

  it("serializes commands as JSON", () => {
    const { client, socket } = createClient();
    client.connect();
    socket.emit("open", {});
    client.send({ type: "prompt", content: "你好" });
    expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
      type: "prompt",
      content: "你好",
    });
    client.dispose();
  });

  it("notifies subscribers on updates", () => {
    const { client, socket } = createClient();
    const listener = vi.fn();
    client.subscribe(listener);
    client.connect();
    socket.emit("open", {});
    expect(listener).toHaveBeenCalled();
    client.dispose();
  });
});

describe("AgentClient reconnect lifecycle", () => {
  it("reconnects once after close and ignores stale socket events", () => {
    vi.useFakeTimers();
    const { client, sockets, factory } = createTrackedClient();
    client.connect();
    const first = sockets[0]!;
    first.emit("open", {});
    first.emit("close", {});
    expect(factory).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(factory).toHaveBeenCalledTimes(2);
    const second = sockets[1]!;
    second.emit("open", {});
    expect(client.getSnapshot().connected).toBe(true);

    // Stale socket events must not touch state or schedule reconnects.
    const snapshot = client.getSnapshot();
    first.emit("close", {});
    first.receive({ type: "event", event: { type: "agent_start" } });
    expect(client.getSnapshot()).toBe(snapshot);
    vi.advanceTimersByTime(10_000);
    expect(factory).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("dispose cancels a pending reconnect", () => {
    vi.useFakeTimers();
    const { client, sockets, factory } = createTrackedClient();
    client.connect();
    sockets[0]!.emit("close", {});
    client.dispose();
    vi.advanceTimersByTime(10_000);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("connect after dispose revives the client", () => {
    const { client, sockets, factory } = createTrackedClient();
    client.connect();
    client.dispose();
    client.connect();
    expect(factory).toHaveBeenCalledTimes(2);
    sockets[1]!.emit("open", {});
    expect(client.getSnapshot().connected).toBe(true);
    client.dispose();
  });
});
