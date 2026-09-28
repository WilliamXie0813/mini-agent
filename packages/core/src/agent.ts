/**
 * agent.ts — 有状态的公共 API 层
 *
 * 对 agent-loop 的包装，给外部使用者（demo、Web UI、测试）一个稳定入口：
 *
 *   prompt() / continue()  —— 启动一个 run
 *   steer() / followUp()   —— 往两个队列里塞消息（由循环在各自边界消费）
 *   abort() / waitForIdle() —— 取消与等待
 *   subscribe() / state    —— 事件订阅与状态查询
 *   reset()                —— 清空历史回到初始状态
 *
 * 核心职责：
 * 1. 持有“当前活动 run”（AbortController + settled Promise），保证同一时刻只有一个 run；
 * 2. 把循环发出的事件流归约（reduce）成 AgentState，并保证“状态先更新，订阅者后收到通知”；
 * 3. 把循环抛出的异常翻译成一条 error/aborted 的 assistant 消息，让失败也走正常事件通道。
 */
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

/** 构造 Agent 所需的全部依赖：系统提示词、模型入口、工具表、三个可选钩子 */
export interface AgentOptions {
  systemPrompt: string;
  stream: StreamFn;
  tools: Tool<unknown>[];
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  finishTurn?: FinishTurn;
}

/** 订阅者签名：收到事件和本次 run 的中止信号；允许异步，循环会 await 它 */
type Listener = (
  event: AgentEvent,
  signal: AbortSignal,
) => void | Promise<void>;

/**
 * 极简 FIFO 消息队列。
 * 存储与投递策略分离：drainOne 一次只取一条（默认策略），
 * 扩展版本可以加 "all" 模式（一次取全部）而不改动循环结构。
 */
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

/** 一个正在进行的 run 的句柄：中止控制器 + “已结束”信号（供 waitForIdle 等待） */
interface ActiveRun {
  controller: AbortController;
  settled: Promise<void>;
  resolveSettled(): void;
}

export class Agent {
  /** 事件订阅者集合；每次 processEvent 都会依次通知它们 */
  private readonly listeners = new Set<Listener>();
  /** 插队消息队列：在下一个 Turn 边界立即消费，不等任务自然停止 */
  private readonly steeringQueue = new MessageQueue();
  /** 追加消息队列：仅当当前任务自然停止（内层循环跑干）后才被消费 */
  private readonly followUpQueue = new MessageQueue();
  /** 模型入口：循环用它把 messages 换成一段 assistant 响应流 */
  private readonly stream: StreamFn;
  /** 工具执行前的拦截钩子：可返回 block 阻止执行 */
  private readonly beforeToolCall?: BeforeToolCall;
  /** 工具执行后的改写钩子：可整体替换执行结果 */
  private readonly afterToolCall?: AfterToolCall;
  /** Turn 结束后的调度钩子：决定 run 是结束、继续，还是走默认调度 */
  private readonly finishTurn?: FinishTurn;
  /** 有值表示正在跑；所有会启动 run 的入口都先用 assertIdle 检查它 */
  private activeRun?: ActiveRun;
  /**
   * 内部可变状态。getter state 直接暴露它（类型上收窄为只读的 AgentState），
   * 事件到达时在 processEvent 里就地更新。
   */
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
      // 消息历史以系统提示词开头
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

  /** 当前可观察状态（messages / pendingToolCalls 等在类型上是只读的） */
  get state(): AgentState {
    return this.mutableState;
  }

  /** 两个队列的只读快照（供 UI 展示“排队中”的消息） */
  get queuedMessages(): {
    steering: AgentMessage[];
    followUp: AgentMessage[];
  } {
    return {
      steering: this.steeringQueue.snapshot(),
      followUp: this.followUpQueue.snapshot(),
    };
  }

  /** 订阅事件流；返回退订函数 */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 排队一条“插队”消息：在当前 assistant 响应及其工具完成后的
   * 下一个安全 Turn 边界投递。随时可调用（包括 run 进行中）。
   */
  steer(content: string): void {
    this.steeringQueue.enqueue(this.createUserMessage(content));
  }

  /**
   * 排队一条“追加”消息：仅当当前任务会自然停止时才被消费
   * （在内层循环退出、外层检查时才被看到）。
   */
  followUp(content: string): void {
    this.followUpQueue.enqueue(this.createUserMessage(content));
  }

  /** 中止当前 run：信号同时传给模型流和工具；无活动 run 时是空操作 */
  abort(): void {
    this.activeRun?.controller.abort(new Error("Agent run aborted"));
  }

  /** 等待当前 run 结束；没有在跑的 run 时立即 resolve */
  waitForIdle(): Promise<void> {
    return this.activeRun?.settled ?? Promise.resolve();
  }

  /** 启动一个新 run，输入是一条新的用户消息 */
  async prompt(content: string): Promise<void> {
    this.assertIdle();
    await this.run([this.createUserMessage(content)]);
  }

  /**
   * 从当前 transcript 继续，不追加新的用户消息。
   * 三种情况：
   * - 尾部是 user / toolResult → 直接开跑（空 prompts）；
   * - 尾部是 assistant → 只有在队列里还有 steering / followUp 可消费时才能继续，
   *   否则模型没有新输入，继续没有意义；
   * - 空历史 → 抛错。
   */
  async continue(): Promise<void> {
    this.assertIdle();
    const messages = this.mutableState.messages;
    const lastMessage = messages.at(-1);

    if (
      !lastMessage ||
      messages.every((message) => message.role === "system")
    ) {
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

  /** 清空历史与队列，回到只剩系统提示词的初始状态（要求当前空闲） */
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

  /** 状态守卫：活动 run 期间的第二次 prompt() / continue() / reset() 直接抛错 */
  private assertIdle(): void {
    if (this.activeRun) {
      throw new Error("Agent is already processing");
    }
  }

  /**
   * 为本次 run 创建上下文快照。
   * messages 是浅拷贝的数组——循环往里 push 会先经过 processEvent，
   * 由 message_end 事件把消息同步回 mutableState.messages，两边保持一致。
   */
  private createContext(): AgentContext {
    return {
      messages: this.mutableState.messages.slice(),
      tools: this.mutableState.tools.slice(),
    };
  }

  /** 组装循环配置：模型入口 + 队列拉取器（循环在边界处主动 drainOne）+ 三个钩子 */
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

  /**
   * 启动并跟踪一个 run 的完整生命周期：
   * 建立 AbortController 与 settled Promise → 跑循环 →
   * 异常翻译为 error/aborted 消息 → 清理瞬态状态并放行 waitForIdle。
   */
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
      // 模型失败、工具 abort 等异常统一走这里：变成一条带 stopReason 的 assistant 消息
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

  /**
   * 把一次 run 级失败翻译成正常的事件序列（message_start → message_end →
   * turn_end → agent_end），消息带 stopReason: "aborted" | "error"。
   * 这样订阅者不需要单独处理“循环炸了”的特殊通道。
   */
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
    await this.processEvent({ type: "agent_end", messages: [message] }, signal);
  }

  /**
   * 事件归约器：先把事件反映到内部状态，再通知所有订阅者。
   * “状态先于订阅者更新”是设计文档明确要求的语义（测试第 3 条会验证）。
   *
   * 状态映射规则：
   * - message_start / update → 更新 streamingMessage（流式中的 assistant 消息）
   * - message_end → 清除 streamingMessage，消息定稿进历史
   * - tool_execution_start / end → 维护 pendingToolCalls 集合
   * - turn_end → 同步 errorMessage
   * - agent_end → 清除瞬态流式状态
   */
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
        // 用新 Set 替换而不是原地 add，保持引用变化便于 UI 框架检测更新
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
