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
  /** Monotonic per-client id so reversed live lists keep stable React keys. */
  seq: number;
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
  private nextSeq = 0;

  constructor(url: string, createSocket?: WebSocketFactory) {
    this.url = url;
    this.createSocket =
      createSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
  }

  connect(): void {
    // Cancel a pending reconnect and drop the previous socket (if any)
    // before opening a new one. Detaching this.socket first makes the old
    // socket's close event hit the stale-socket guard below, so it cannot
    // schedule a duplicate reconnect.
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const previous = this.socket;
    this.socket = undefined;
    previous?.close();

    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectAttempts = 0;
      this.update({ connected: true, lastError: undefined });
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      const data = (event as { data?: unknown }).data;
      if (typeof data === "string") this.handleMessage(data);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.update({ connected: false });
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {});
  }

  /**
   * Closes the socket and cancels any pending reconnect timer. The client
   * is not permanently dead: connect() revives it. This matters for React
   * 18 StrictMode, which runs effect cleanup then setup again with the
   * same instance (dispose → connect must be a working restart sequence).
   */
  dispose(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    // Detach before closing so the close event is ignored as stale and no
    // reconnect is scheduled.
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
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
          {
            event: message.event,
            receivedAt: Date.now(),
            seq: this.nextSeq++,
          },
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
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private update(partial: Partial<ClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) listener();
  }
}
