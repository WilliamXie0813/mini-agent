import { runAgentLoop } from "./agent-loop.ts";
import type {
  AfterToolCall,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentState,
  BeforeToolCall,
  FinishTurn,
  StreamFn,
  Tool,
  UserMessage,
} from "./types.ts";

export interface AgentOptions {
  systemPrompt: string;
  stream: StreamFn;
  tools: Tool<unknown>[];
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  finishTurn?: FinishTurn;
}

type Listener = (event: AgentEvent, signal: AbortSignal) => void | Promise<void>;

class MessageQueue {
  private messages: AgentMessage[] = [];

  enqueue(message: AgentMessage): void {
    this.messages.push(message);
  }

  drainOne(): AgentMessage[] {
    const first = this.messages.shift();
    return first ? [first] : [];
  }

  clear(): void {
    this.messages = [];
  }

  snapshot(): AgentMessage[] {
    return this.messages.slice();
  }
}

interface ActiveRun {
  controller: AbortController;
  settled: Promise<void>;
  resolveSettled(): void;
}

export class Agent {
  private readonly listeners = new Set<Listener>();
  private readonly steeringQueue = new MessageQueue();
  private readonly followUpQueue = new MessageQueue();
  private readonly stream: StreamFn;
  private readonly beforeToolCall?: BeforeToolCall;
  private readonly afterToolCall?: AfterToolCall;
  private readonly finishTurn?: FinishTurn;
  private activeRun?: ActiveRun;
  private mutableState: {
    messages: AgentMessage[];
    tools: Tool<unknown>[];
    isStreaming: boolean;
    streamingMessage?: AgentState["streamingMessage"];
    pendingToolCalls: Set<string>;
    errorMessage?: string;
  };

  constructor(options: AgentOptions) {
    this.stream = options.stream;
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
    this.finishTurn = options.finishTurn;
    this.mutableState = {
      messages: [
        {
          role: "system",
          content: options.systemPrompt,
          timestamp: Date.now(),
        },
      ],
      tools: options.tools.slice(),
      isStreaming: false,
      pendingToolCalls: new Set(),
    };
  }

  get state(): AgentState {
    return this.mutableState;
  }

  get queuedMessages(): {
    steering: AgentMessage[];
    followUp: AgentMessage[];
  } {
    return {
      steering: this.steeringQueue.snapshot(),
      followUp: this.followUpQueue.snapshot(),
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  steer(content: string): void {
    this.steeringQueue.enqueue(this.createUserMessage(content));
  }

  followUp(content: string): void {
    this.followUpQueue.enqueue(this.createUserMessage(content));
  }

  abort(): void {
    this.activeRun?.controller.abort(
      new Error("Agent run aborted"),
    );
  }

  waitForIdle(): Promise<void> {
    return this.activeRun?.settled ?? Promise.resolve();
  }

  async prompt(content: string): Promise<void> {
    this.assertIdle();
    await this.run([this.createUserMessage(content)]);
  }

  async continue(): Promise<void> {
    this.assertIdle();
    const messages = this.mutableState.messages;
    const lastMessage = messages.at(-1);

    if (!lastMessage || messages.every((message) => message.role === "system")) {
      throw new Error("No messages to continue from");
    }

    if (lastMessage.role === "assistant") {
      const steering = this.steeringQueue.drainOne();
      if (steering.length > 0) {
        await this.run(steering);
        return;
      }
      const followUps = this.followUpQueue.drainOne();
      if (followUps.length > 0) {
        await this.run(followUps);
        return;
      }
      throw new Error("Cannot continue from message role: assistant");
    }

    await this.run([]);
  }

  reset(): void {
    this.assertIdle();
    const system = this.mutableState.messages.find(
      (message) => message.role === "system",
    );
    this.mutableState.messages = system ? [system] : [];
    this.mutableState.streamingMessage = undefined;
    this.mutableState.pendingToolCalls = new Set();
    this.mutableState.errorMessage = undefined;
    this.steeringQueue.clear();
    this.followUpQueue.clear();
  }

  private createUserMessage(content: string): UserMessage {
    return { role: "user", content, timestamp: Date.now() };
  }

  private assertIdle(): void {
    if (this.activeRun) {
      throw new Error("Agent is already processing");
    }
  }

  private createContext(): AgentContext {
    return {
      messages: this.mutableState.messages.slice(),
      tools: this.mutableState.tools.slice(),
    };
  }

  private createConfig(): AgentLoopConfig {
    return {
      stream: this.stream,
      getSteeringMessages: () => this.steeringQueue.drainOne(),
      getFollowUpMessages: () => this.followUpQueue.drainOne(),
      beforeToolCall: this.beforeToolCall,
      afterToolCall: this.afterToolCall,
      finishTurn: this.finishTurn,
    };
  }

  private async run(prompts: AgentMessage[]): Promise<void> {
    const controller = new AbortController();
    let resolveSettled = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const activeRun: ActiveRun = { controller, settled, resolveSettled };
    this.activeRun = activeRun;
    this.mutableState.isStreaming = true;
    this.mutableState.errorMessage = undefined;

    try {
      await runAgentLoop(
        prompts,
        this.createContext(),
        this.createConfig(),
        (event) => this.processEvent(event, controller.signal),
        controller.signal,
      );
    } catch (error) {
      await this.emitFailure(error, controller.signal);
    } finally {
      this.mutableState.isStreaming = false;
      this.mutableState.streamingMessage = undefined;
      this.mutableState.pendingToolCalls = new Set();
      activeRun.resolveSettled();
      if (this.activeRun === activeRun) {
        this.activeRun = undefined;
      }
    }
  }

  private async emitFailure(
    error: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "" }],
      stopReason: signal.aborted ? ("aborted" as const) : ("error" as const),
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    await this.processEvent({ type: "message_start", message }, signal);
    await this.processEvent({ type: "message_end", message }, signal);
    await this.processEvent(
      { type: "turn_end", message, toolResults: [] },
      signal,
    );
    await this.processEvent(
      { type: "agent_end", messages: [message] },
      signal,
    );
  }

  private async processEvent(
    event: AgentEvent,
    signal: AbortSignal,
  ): Promise<void> {
    switch (event.type) {
      case "message_start":
      case "message_update":
        if (event.message.role === "assistant") {
          this.mutableState.streamingMessage = event.message;
        }
        break;
      case "message_end":
        this.mutableState.streamingMessage = undefined;
        this.mutableState.messages.push(event.message);
        break;
      case "tool_execution_start": {
        const next = new Set(this.mutableState.pendingToolCalls);
        next.add(event.toolCallId);
        this.mutableState.pendingToolCalls = next;
        break;
      }
      case "tool_execution_end": {
        const next = new Set(this.mutableState.pendingToolCalls);
        next.delete(event.toolCallId);
        this.mutableState.pendingToolCalls = next;
        break;
      }
      case "turn_end":
        this.mutableState.errorMessage = event.message.errorMessage;
        break;
      case "agent_end":
        this.mutableState.streamingMessage = undefined;
        break;
    }

    for (const listener of this.listeners) {
      await listener(event, signal);
    }
  }
}
