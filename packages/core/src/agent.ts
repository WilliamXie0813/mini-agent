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
import { randomUUID } from "node:crypto";
import { runAgentLoop } from "./agent-loop.ts";
import { defaultSleep } from "./retry.ts";
import type { RetryPolicy, SleepFn } from "./retry.ts";
import type {
  QueueName,
  QueuedMessageReservation,
  SessionCommitter,
  SessionSnapshot,
} from "./session.ts";
import type {
  AfterToolCall,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentState,
  BeforeToolCall,
  FinishTurn,
  IdGenerator,
  PrepareNextTurn,
  PrepareRequest,
  StreamFn,
  SystemMessage,
  Tool,
  ToolExecutionMode,
  TransformContext,
  UserMessage,
} from "./types.ts";

/** 构造 Agent 所需的全部依赖：系统提示词、模型入口、工具表和生命周期钩子 */
export interface AgentOptions {
  systemPrompt: string;
  stream: StreamFn;
  tools: Tool<unknown>[];
  toolExecutionMode?: ToolExecutionMode;
  maxToolConcurrency?: number;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  finishTurn?: FinishTurn;
  prepareNextTurn?: PrepareNextTurn;
  prepareRequest?: PrepareRequest;
  transformContext?: TransformContext;
  retryPolicy?: RetryPolicy;
  sleep?: SleepFn;
  idGenerator?: IdGenerator;
  /**
   * 恢复用的快照：与 sessionCommitter 必须同时提供（要么都配，要么都不配）。
   * 约束：同一 session id 同时只允许一个 live Agent；committer 必须属于
   * initialSession.metadata.id。若 Agent 存活期间 store 中的 session 被删除，
   * steer/reset 会以 SessionNotFoundError 拒绝，内存状态保持一致。
   */
  initialSession?: SessionSnapshot;
  /** 持久化提交入口：steer/followUp/reset 会先落盘再改内存。 */
  sessionCommitter?: SessionCommitter;
}

function normalizeMaxToolConcurrency(value: number | undefined): number {
  const normalized = value ?? 4;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error("maxToolConcurrency must be a positive integer");
  }
  return normalized;
}

/** 订阅者签名：收到事件和本次 run 的中止信号；允许异步，循环会 await 它 */
type Listener = (
  event: AgentEvent,
  signal: AbortSignal,
) => void | Promise<void>;

/**
 * 极简 FIFO 消息队列。
 * 存储与投递策略分离：reserveOne 一次只预留队首一条（默认策略），
 * 扩展版本可以加 "all" 模式（一次取全部）而不改动循环结构。
 * 预留（reserve）与确认（acknowledge）分离：消息在真正被消费时才出队，
 * 恢复时可通过 restore 整体回填。
 */
class MessageQueue {
  private messages: AgentMessage[] = [];

  enqueue(message: AgentMessage): void {
    this.messages.push(message);
  }

  reserveOne(queue: QueueName): QueuedMessageReservation[] {
    const first = this.messages[0];
    return first ? [{ queue, message: first }] : [];
  }

  acknowledge(messageId: string): void {
    if (this.messages[0]?.id !== messageId) {
      throw new Error(`Queue reservation is no longer at the head: ${messageId}`);
    }
    this.messages.shift();
  }

  hasMessages(): boolean {
    // 调度器用它判断是否需要下一 Turn；不能用 reserveOne() 试探，否则会丢消息。
    return this.messages.length > 0;
  }

  clear(): void {
    this.messages = [];
  }

  restore(messages: readonly AgentMessage[]): void {
    this.messages = messages.slice();
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
  /** 追加消息队列：仅当当前任务自然停止、且没有 steering/工具结果时才消费 */
  private readonly followUpQueue = new MessageQueue();
  /** 模型入口：循环用它把 messages 换成一段 assistant 响应流 */
  private readonly stream: StreamFn;
  private readonly retryPolicy?: RetryPolicy;
  private readonly sleep?: SleepFn;
  /** 消息 ID 来源：注入后可让测试用确定性身份，缺省用 randomUUID。 */
  private readonly idGenerator: IdGenerator;
  /** 持久化提交入口：配置后 steer/followUp/reset 先落盘再改内存。 */
  private readonly sessionCommitter?: SessionCommitter;
  /** 默认保持串行；只有调用者显式开启 parallel 才会尝试并行。 */
  private readonly toolExecutionMode: ToolExecutionMode;
  /** 限制完整 Tool Call 生命周期数量，而不只是 execute() Promise 数量。 */
  private readonly maxToolConcurrency: number;
  /** 工具执行前的拦截钩子：可返回 block 阻止执行 */
  private readonly beforeToolCall?: BeforeToolCall;
  /** 工具执行后的改写钩子：可整体替换执行结果 */
  private readonly afterToolCall?: AfterToolCall;
  /** Turn 结束后的调度钩子：决定 run 是结束、继续，还是走默认调度 */
  private readonly finishTurn?: FinishTurn;
  /** 下一 Turn 已确定开始后，用上一 Turn 快照重建工作消息 */
  private readonly prepareNextTurn?: PrepareNextTurn;
  /** 每次模型请求前同步本 Run 的工作上下文 */
  private readonly prepareRequest?: PrepareRequest;
  /** 生成仅供本次模型请求使用的临时消息投影 */
  private readonly transformContext?: TransformContext;
  /** 有值表示正在跑；所有会启动 run 的入口都先用 assertIdle 检查它 */
  private activeRun?: ActiveRun;
  /**
   * 有值表示 durable reset 正在等待提交完成。它与 activeRun 一样阻塞
   * prompt/continue/reset；区别是没有 AbortController——abort() 对它无效。
   */
  private pendingReset?: Promise<void>;
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
    if (!options.retryPolicy && options.sleep) {
      throw new Error("sleep requires retryPolicy");
    }
    if (Boolean(options.initialSession) !== Boolean(options.sessionCommitter)) {
      throw new Error(
        "initialSession and sessionCommitter must be configured together",
      );
    }
    this.retryPolicy = options.retryPolicy;
    this.sleep = options.retryPolicy
      ? options.sleep ?? defaultSleep
      : undefined;
    this.toolExecutionMode = options.toolExecutionMode ?? "sequential";
    this.maxToolConcurrency = normalizeMaxToolConcurrency(
      options.maxToolConcurrency,
    );
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
    this.finishTurn = options.finishTurn;
    this.prepareNextTurn = options.prepareNextTurn;
    this.prepareRequest = options.prepareRequest;
    this.transformContext = options.transformContext;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.sessionCommitter = options.sessionCommitter;
    // 恢复场景：消息与队列全部来自快照，不再插入新的 system 消息。
    if (options.initialSession) {
      this.steeringQueue.restore(options.initialSession.steeringQueue);
      this.followUpQueue.restore(options.initialSession.followUpQueue);
    }
    const messages = options.initialSession
      ? options.initialSession.messages.slice()
      : [
          {
            id: this.idGenerator(),
            role: "system" as const,
            content: options.systemPrompt,
            timestamp: Date.now(),
          },
        ];
    this.mutableState = {
      messages,
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
   * 配置了 sessionCommitter 时先落盘，append 失败则内存队列保持不变。
   */
  async steer(content: string): Promise<void> {
    const message = this.createUserMessage(content);
    await this.sessionCommitter?.enqueue("steering", message);
    this.steeringQueue.enqueue(message);
  }

  /**
   * 排队一条“追加”消息：仅当当前任务会自然停止时才被消费
   * （在内层循环退出、外层检查时才被看到）。
   */
  async followUp(content: string): Promise<void> {
    const message = this.createUserMessage(content);
    await this.sessionCommitter?.enqueue("followUp", message);
    this.followUpQueue.enqueue(message);
  }

  /** 中止当前 run：信号同时传给模型流和工具；无活动 run 时是空操作。
   *  pending 的 reset 没有可中止的 run，abort() 对它同样是空操作。 */
  abort(): void {
    this.activeRun?.controller.abort(new Error("Agent run aborted"));
  }

  /** 等待当前 run 结束；没有在跑的 run 时立即 resolve（pending 的 reset 也会阻塞它） */
  waitForIdle(): Promise<void> {
    return this.activeRun?.settled ?? this.pendingReset ?? Promise.resolve();
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
      if (
        !this.steeringQueue.hasMessages() &&
        !this.followUpQueue.hasMessages()
      ) {
        throw new Error("Cannot continue from message role: assistant");
      }
      await this.run([]);
      return;
    }

    await this.run([]);
  }

  /**
   * 清空历史与队列，回到只剩系统提示词的初始状态（要求当前空闲）。
   * 配置了 sessionCommitter 时先落盘 reset 记录，append 失败则内存保持不变。
   *
   * 互斥：提交窗口从首个 await 之前就开始占用 Agent——fire-and-forget 调用方
   * （如 server 的命令分发）在 reset 未落定时跟进 prompt/continue/reset，
   * 会拿到 "Agent is already processing"，而不会拿到 reset 前的历史切片。
   */
  async reset(): Promise<void> {
    this.assertIdle();
    this.pendingReset = this.performReset();
    try {
      await this.pendingReset;
    } finally {
      this.pendingReset = undefined;
    }
  }

  /** reset 的执行体；与并发入口的互斥由外层 pendingReset 负责。 */
  private async performReset(): Promise<void> {
    const existingSystem = this.mutableState.messages.find(
      (message): message is SystemMessage => message.role === "system",
    );
    const systemMessage: SystemMessage = {
      id: this.idGenerator(),
      role: "system",
      content: existingSystem?.content ?? "",
      timestamp: Date.now(),
    };
    await this.sessionCommitter?.reset(systemMessage);
    this.mutableState.messages = [systemMessage];
    this.mutableState.streamingMessage = undefined;
    this.mutableState.pendingToolCalls = new Set();
    this.mutableState.errorMessage = undefined;
    this.steeringQueue.clear();
    this.followUpQueue.clear();
  }

  private createUserMessage(content: string): UserMessage {
    return { id: this.idGenerator(), role: "user", content, timestamp: Date.now() };
  }

  /** 状态守卫：活动 run 或 pending reset 期间的第二次 prompt() / continue() / reset() 直接抛错 */
  private assertIdle(): void {
    if (this.activeRun || this.pendingReset) {
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

  /** 组装循环配置：模型入口、队列的 peek/drain 能力，以及全部生命周期钩子 */
  private createConfig(): AgentLoopConfig {
    return {
      stream: this.stream,
      idGenerator: this.idGenerator,
      retryPolicy: this.retryPolicy,
      sleep: this.sleep,
      reserveSteeringMessages: () =>
        this.steeringQueue.reserveOne("steering"),
      reserveFollowUpMessages: () =>
        this.followUpQueue.reserveOne("followUp"),
      acknowledgeReservations: (reservations) => {
        for (const reservation of reservations) {
          const queue =
            reservation.queue === "steering"
              ? this.steeringQueue
              : this.followUpQueue;
          queue.acknowledge(reservation.message.id);
        }
      },
      hasSteeringMessages: () => this.steeringQueue.hasMessages(),
      hasFollowUpMessages: () => this.followUpQueue.hasMessages(),
      sessionCommitter: this.sessionCommitter,
      toolExecutionMode: this.toolExecutionMode,
      maxToolConcurrency: this.maxToolConcurrency,
      beforeToolCall: this.beforeToolCall,
      afterToolCall: this.afterToolCall,
      finishTurn: this.finishTurn,
      prepareNextTurn: this.prepareNextTurn,
      prepareRequest: this.prepareRequest,
      transformContext: this.transformContext,
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
   *
   * 终态消息先尝试落盘；落盘失败时不能再走同一条事件通道重试——
   * 否则失败处理会递归产生另一条同样无法落盘的终态消息。此时只同步
   * errorMessage 并发出 agent_end，让 run 干净收尾。
   */
  private async emitFailure(
    error: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    const message = {
      id: this.idGenerator(),
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "" }],
      stopReason: signal.aborted ? ("aborted" as const) : ("error" as const),
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    try {
      await this.sessionCommitter?.commitMessages({ messages: [message] });
    } catch {
      this.mutableState.errorMessage = message.errorMessage;
      await this.processEvent(
        { type: "agent_end", messages: this.mutableState.messages.slice() },
        signal,
      );
      return;
    }
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
      case "tool_execution_end":
      case "tool_execution_cancelled": {
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
