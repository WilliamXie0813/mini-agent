import {
  Agent,
  openOrCreateSession,
  type IdGenerator,
  type SessionStore,
  type SystemMessage,
} from "@mini-agent/core";
import { randomUUID } from "node:crypto";
import { AgentSession, createAgent } from "./session.ts";

export type AgentFactory = (options: {
  initialSession: Awaited<
    ReturnType<typeof openOrCreateSession>
  >["snapshot"];
  sessionCommitter: Awaited<
    ReturnType<typeof openOrCreateSession>
  >["committer"];
  idGenerator: IdGenerator;
}) => Agent;

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly opening = new Map<string, Promise<AgentSession>>();
  private readonly store: SessionStore;
  private readonly agentFactory: AgentFactory;
  private readonly idGenerator: IdGenerator;

  constructor(
    store: SessionStore,
    agentFactory: AgentFactory = (options) => createAgent(options),
    idGenerator: IdGenerator = randomUUID,
  ) {
    this.store = store;
    this.agentFactory = agentFactory;
    this.idGenerator = idGenerator;
  }

  async getOrOpen(sessionId: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const inFlight = this.opening.get(sessionId);
    if (inFlight) return inFlight;

    const opening = this.open(sessionId).finally(() => {
      this.opening.delete(sessionId);
    });
    this.opening.set(sessionId, opening);
    return opening;
  }

  async list() {
    return this.store.list();
  }

  createId(): string {
    return this.idGenerator();
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  private async open(sessionId: string): Promise<AgentSession> {
    const systemMessage: SystemMessage = {
      id: this.idGenerator(),
      role: "system",
      content: "You are a deterministic teaching Agent.",
      timestamp: Date.now(),
    };
    const opened = await openOrCreateSession({
      store: this.store,
      sessionId,
      systemMessage,
    });
    const session = new AgentSession(
      sessionId,
      this.agentFactory({
        initialSession: opened.snapshot,
        sessionCommitter: opened.committer,
        idGenerator: this.idGenerator,
      }),
      opened.snapshot,
    );
    this.sessions.set(sessionId, session);
    return session;
  }
}
