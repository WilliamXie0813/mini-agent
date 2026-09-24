import type { AgentEvent } from "@mini-agent/core";
import type {
  ClientCommand,
  SerializableAgentState,
  ServerMessage,
} from "@mini-agent/server";
import { emptyState, reduceEvent } from "./reducer";

export interface StoredEvent {
  event: AgentEvent;
  receivedAt: number;
}

export interface ClientSnapshot {
  state: SerializableAgentState;
  events: StoredEvent[];
  connected: boolean;
  lastError?: string;
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: string,
    listener: (event: unknown) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const MAX_STORED_EVENTS = 500;

export class AgentClient {
  private snapshot: ClientSnapshot = {
    state: emptyState(),
    events: [],
    connected: false,
  };
  private readonly listeners = new Set<() => void>();
  private readonly createSocket: WebSocketFactory;
  private readonly url: string;
  private socket?: WebSocketLike;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private disposed = false;

  constructor(url: string, createSocket?: WebSocketFactory) {
    this.url = url;
    this.createSocket =
      createSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
  }

  connect(): void {
    if (this.disposed) return;
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.update({ connected: true });
    });
    socket.addEventListener("message", (event) => {
      const data = (event as { data?: unknown }).data;
      if (typeof data === "string") this.handleMessage(data);
    });
    socket.addEventListener("close", () => {
      this.update({ connected: false });
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {});
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
    }
    this.socket?.close();
  }

  send(command: ClientCommand): void {
    this.socket?.send(JSON.stringify(command));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): ClientSnapshot {
    return this.snapshot;
  }

  private handleMessage(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case "state":
        this.update({ state: message.state });
        return;
      case "event": {
        const events = [
          ...this.snapshot.events,
          { event: message.event, receivedAt: Date.now() },
        ].slice(-MAX_STORED_EVENTS);
        this.update({
          state: reduceEvent(this.snapshot.state, message.event),
          events,
        });
        return;
      }
      case "error":
        this.update({ lastError: message.message });
        return;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private update(partial: Partial<ClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) listener();
  }
}
