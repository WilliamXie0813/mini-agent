import { Agent, createMockStream, createReadTool } from "@mini-agent/core";
import type { WebSocket, WebSocketServer } from "ws";
import { encodeMessage, parseCommand, serializeState } from "./protocol.ts";
import type { ClientCommand, ServerMessage } from "./protocol.ts";

export function createAgent(): Agent {
  return new Agent({
    systemPrompt: "You are a deterministic teaching Agent.",
    stream: createMockStream({ delayMs: 30 }),
    tools: [
      createReadTool({
        "package.json":
          "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
      }),
    ],
  });
}

export class AgentSession {
  private readonly clients = new Set<WebSocket>();
  private readonly agent: Agent;
  private readonly unsubscribe: () => void;

  constructor(agent: Agent) {
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

  attach(wss: WebSocketServer): void {
    wss.on("connection", (socket) => {
      this.clients.add(socket);
      this.sendState(socket);
      socket.on("message", (data) => {
        this.handleMessage(socket, data.toString());
      });
      socket.on("close", () => {
        this.clients.delete(socket);
      });
      socket.on("error", () => {});
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.clients.clear();
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    const command = parseCommand(raw);
    if (!command) {
      this.send(socket, { type: "error", message: "Unrecognized command" });
      return;
    }
    void this.execute(command)
      .catch((error: unknown) => {
        this.send(socket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.broadcastState();
      });
  }

  private async execute(command: ClientCommand): Promise<void> {
    switch (command.type) {
      case "prompt":
        await this.agent.prompt(command.content);
        return;
      case "steer":
        this.agent.steer(command.content);
        return;
      case "followUp":
        this.agent.followUp(command.content);
        return;
      case "abort":
        this.agent.abort();
        return;
      case "reset":
        this.agent.reset();
        this.broadcast({ type: "reset" });
        return;
    }
  }

  private broadcastState(): void {
    this.broadcast({
      type: "state",
      state: serializeState(this.agent.state, this.agent.queuedMessages),
    });
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
