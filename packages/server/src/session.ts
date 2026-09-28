import {
  Agent,
  createMockStream,
  createReadTool,
  type AgentOptions,
} from "@mini-agent/core";
import type { SessionSnapshot } from "@mini-agent/core";
import type { WebSocket, WebSocketServer } from "ws";
import { encodeMessage, parseCommand, serializeState } from "./protocol.ts";
import type { ClientCommand, ServerMessage } from "./protocol.ts";
import type { SessionManager } from "./session-manager.ts";

export function createAgent(
  persistence: Pick<
    AgentOptions,
    "initialSession" | "sessionCommitter" | "idGenerator"
  > = {},
): Agent {
  return new Agent({
    systemPrompt: "You are a deterministic teaching Agent.",
    stream: createMockStream({
      delayMs: 30,
      idGenerator: persistence.idGenerator,
    }),
    tools: [
      createReadTool({
        "package.json":
          "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
      }),
    ],
    ...persistence,
  });
}

/** 只操作 Agent 本体的命令；会话管理命令由 SessionSocketServer 处理。 */
export type AgentCommand = Exclude<
  ClientCommand,
  { type: "open_session" } | { type: "create_session" } | { type: "list_sessions" }
>;

function assertNever(value: never): never {
  throw new Error(`Unhandled command variant: ${JSON.stringify(value)}`);
}

export class AgentSession {
  private readonly clients = new Set<WebSocket>();
  private readonly agent: Agent;
  private readonly unsubscribe: () => void;
  readonly sessionId: string;
  private readonly snapshot: SessionSnapshot;

  constructor(sessionId: string, agent: Agent, snapshot: SessionSnapshot) {
    this.sessionId = sessionId;
    this.snapshot = snapshot;
    this.agent = agent;
    this.unsubscribe = this.agent.subscribe((event) => {
      this.broadcast({ type: "event", event });
      // 低频状态重发：保证队列/pendingToolCalls 等面板数据实时
      if (event.type === "turn_end" || event.type === "agent_end") {
        this.broadcastState();
      }
      return undefined;
    });
  }

  addClient(socket: WebSocket): void {
    this.clients.add(socket);
  }

  removeClient(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  sendInitialState(socket: WebSocket): void {
    this.sendState(socket);
    if (this.snapshot.recoveryWarnings.length > 0) {
      this.send(socket, {
        type: "event",
        event: {
          type: "session_recovery_warning",
          warnings: this.snapshot.recoveryWarnings,
        },
      });
    }
  }

  async execute(command: AgentCommand): Promise<void> {
    switch (command.type) {
      case "prompt":
        await this.agent.prompt(command.content);
        return;
      case "steer":
        await this.agent.steer(command.content);
        return;
      case "followUp":
        await this.agent.followUp(command.content);
        return;
      case "abort":
        this.agent.abort();
        return;
      case "reset":
        await this.agent.reset();
        this.broadcast({ type: "reset" });
        return;
      default:
        assertNever(command);
    }
  }

  broadcastState(): void {
    this.broadcast({
      type: "state",
      state: serializeState(this.agent.state, this.agent.queuedMessages),
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.clients.clear();
  }

  private sendState(socket: WebSocket): void {
    this.send(socket, {
      type: "state",
      state: serializeState(this.agent.state, this.agent.queuedMessages),
    });
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients) {
      this.send(client, message);
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(encodeMessage(message));
    }
  }
}

type SessionCommand = Extract<
  ClientCommand,
  { type: "open_session" } | { type: "create_session" }
>;

export class SessionSocketServer {
  private readonly bindings = new Map<WebSocket, AgentSession>();
  private readonly manager: SessionManager;

  constructor(manager: SessionManager) {
    this.manager = manager;
  }

  attach(wss: WebSocketServer): void {
    wss.on("connection", (socket) => {
      void this.handleConnection(socket);
    });
  }

  dispose(): void {
    this.bindings.clear();
  }

  private async handleConnection(socket: WebSocket): Promise<void> {
    // 会话打开是异步的（持久化 store 可能涉及磁盘 I/O），而客户端可能在
    // 连接建立后立刻发命令；先同步挂 message 监听并把早到的命令缓存起来，
    // 绑定完成后再按序补发，否则这些命令会被静默丢弃。
    const pending: string[] = [];
    let bound = false;
    socket.on("message", (data) => {
      if (bound) {
        this.handleMessage(socket, data.toString());
      } else {
        pending.push(data.toString());
      }
    });
    socket.on("error", () => {});
    let session: AgentSession;
    try {
      session = await this.manager.getOrOpen("default");
    } catch (error) {
      this.send(socket, {
        type: "session_error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    // 打开期间 socket 可能已关闭：此时绝不能把它登记进 clients/bindings
    if (socket.readyState !== socket.OPEN) return;
    session.addClient(socket);
    this.bindings.set(socket, session);
    bound = true;
    socket.on("close", () => {
      this.bindings.get(socket)?.removeClient(socket);
      this.bindings.delete(socket);
    });
    session.sendInitialState(socket);
    for (const raw of pending) {
      this.handleMessage(socket, raw);
    }
    pending.length = 0;
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    const result = parseCommand(raw);
    if (!result.ok) {
      this.send(socket, {
        type: result.kind === "session" ? "session_error" : "error",
        message: result.message,
      });
      return;
    }
    const command = result.command;
    const refreshState = !isSessionCommand(command);
    void this.dispatch(socket, command)
      .catch((error: unknown) => {
        this.send(socket, {
          type: isSessionCommand(command) ? "session_error" : "error",
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        // 仅 Agent 命令需要事后状态重发；会话命令在 rebind 时已对目标
        // socket 发过 sendInitialState，无需再向整个 session 广播
        if (refreshState) {
          this.bindings.get(socket)?.broadcastState();
        }
      });
  }

  private async dispatch(
    socket: WebSocket,
    command: ClientCommand,
  ): Promise<void> {
    switch (command.type) {
      case "open_session":
      case "create_session":
        await this.switchSession(socket, command);
        return;
      case "list_sessions":
        this.send(socket, {
          type: "session_list",
          sessions: await this.manager.list(),
        });
        return;
      case "prompt":
      case "steer":
      case "followUp":
      case "abort":
      case "reset": {
        const session = this.bindings.get(socket);
        if (!session) {
          throw new Error("No session bound to this connection");
        }
        await session.execute(command);
        return;
      }
      default:
        assertNever(command);
    }
  }

  private async switchSession(
    socket: WebSocket,
    command: SessionCommand,
  ): Promise<void> {
    const sessionId =
      command.type === "create_session"
        ? (command.sessionId ?? this.manager.createId())
        : command.sessionId;
    const session = await this.manager.getOrOpen(sessionId);
    // 打开期间 socket 可能已关闭：保留旧绑定（close 处理器已清理），
    // 绝不把死 socket 加进新 session
    if (socket.readyState !== socket.OPEN) return;
    const previous = this.bindings.get(socket);
    if (previous && previous !== session) {
      previous.removeClient(socket);
    }
    session.addClient(socket);
    this.bindings.set(socket, session);
    this.send(socket, { type: "session_opened", sessionId });
    session.sendInitialState(socket);
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(encodeMessage(message));
    }
  }
}

function isSessionCommand(
  command: ClientCommand,
): command is Extract<
  ClientCommand,
  { type: "open_session" } | { type: "create_session" } | { type: "list_sessions" }
> {
  return (
    command.type === "open_session" ||
    command.type === "create_session" ||
    command.type === "list_sessions"
  );
}
