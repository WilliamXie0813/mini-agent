/**
 * types.ts — 公共契约层
 *
 * 定义整个 Agent 系统共享的类型：消息、工具、模型流事件、生命周期事件、
 * 钩子与循环配置。其他所有模块（mock-llm / tools / agent-loop / agent）
 * 都只依赖这里的类型，依赖单向流动：agent → agent-loop → mock-llm/tools → types。
 *
 * 设计要点：
 * - 消息使用可辨识联合（discriminated union），靠 role / type 字段区分；
 * - 不使用 any：模型给出的工具参数在校验通过之前一律保持为 unknown；
 * - 所有时间相关的可选项（钩子等）都以可选函数形式挂在配置上，默认关闭。
 */
import type { ModelErrorCode } from "./errors.ts";
import type { RetryPolicy, SleepFn } from "./retry.ts";
import type {
  QueuedMessageReservation,
  SessionCommitter,
  SessionRecoveryWarning,
} from "./session.ts";

/** 一条 assistant 消息为什么停下：正常结束 / 请求调工具 / 出错 / 被中止 */
export type StopReason = "stop" | "toolUse" | "error" | "aborted";

/** 系统提示词，始终位于消息历史开头 */
export interface SystemMessage {
  id: string;
  role: "system";
  content: string;
  timestamp: number;
}

/** 用户输入（包括正常 prompt、steer 插队消息、followUp 追加消息） */
export interface UserMessage {
  id: string;
  role: "user";
  content: string;
  timestamp: number;
}

/** assistant 消息中的一段纯文本 */
export interface TextContent {
  type: "text";
  text: string;
}

/** assistant 消息中的一次工具调用请求。arguments 是模型给的原始参数，校验前为 unknown */
export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

/**
 * assistant 消息：content 是文本段和工具调用的混合数组。
 * stopReason 为 "toolUse" 时表示模型请求继续（还有工具要跑）；
 * "error" / "aborted" 时 errorMessage 携带原因。
 */
export interface AssistantMessage {
  id: string;
  role: "assistant";
  content: Array<TextContent | ToolCall>;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

/** 工具执行完毕后的结果消息，通过 toolCallId 与 assistant 的 ToolCall 配对 */
export interface ToolResultMessage {
  id: string;
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string;
  details?: unknown; // 给 UI / 调试用的结构化附加信息
  isError: boolean;
  timestamp: number;
}

/** 消息 ID 生成器：Agent / Mock 模型 / 工具执行器共用的可注入身份来源 */
export type IdGenerator = () => string;

/** 消息历史的可辨识联合：用 role 字段区分四种消息 */
export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

/** 工具执行器的返回约定：content 是喂回给模型的文本，details 留给上层展示 */
export interface ToolExecutionResult {
  content: string;
  details?: unknown;
  isError?: boolean;
}

/** 参数校验结果：要么返回收窄后的强类型参数，要么返回错误文案，不抛异常 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** 工具执行过程中的进度回调，循环层会把它转成 tool_execution_update 事件 */
export type ToolUpdate = (partial: ToolExecutionResult) => Promise<void>;

/** 工具是否允许与同一模型响应中的其他工具并发执行。 */
export type ToolExecutionMode = "parallel" | "sequential";

export type ReplayPolicy = "safe" | "never";

/**
 * 工具接口。职责分离：
 * - validate：手写校验，把 unknown 的原始参数收窄为 TParameters；非法参数永远到不了 execute；
 * - execute：真正的执行体，收到与模型同一个 AbortSignal（协作式取消），
 *   执行中可通过 onUpdate 上报进度。
 */
export interface Tool<TParameters> {
  name: string;
  description: string;
  /** 缺省按 sequential 处理；工具作者必须显式确认并发安全。 */
  executionMode?: ToolExecutionMode;
  /** Future recovery metadata only; the current runtime never replays tools. */
  replay?: ReplayPolicy;
  validate(argumentsValue: unknown): ValidationResult<TParameters>;
  execute(
    toolCallId: string,
    parameters: TParameters,
    signal: AbortSignal,
    onUpdate: ToolUpdate,
  ): Promise<ToolExecutionResult>;
}

// ---------- 模型流事件（StreamFn 的输出，Mock LLM 与真实模型适配器共用这条边界） ----------

/** 流开始：携带一条初始（通常为空）assistant 消息 */
export interface ModelStartEvent {
  type: "start";
  message: AssistantMessage;
}

/** 增量文本：delta 是本次新增的字符，message 是累计快照 */
export interface ModelTextDeltaEvent {
  type: "text_delta";
  delta: string;
  message: AssistantMessage;
}

/** 模型请求调用一个工具 */
export interface ModelToolCallEvent {
  type: "tool_call";
  toolCall: ToolCall;
  message: AssistantMessage;
}

/** 流结束：message 是最终完整的 assistant 消息 */
export interface ModelEndEvent {
  type: "end";
  message: AssistantMessage;
}

export type ModelStreamEvent =
  | ModelStartEvent
  | ModelTextDeltaEvent
  | ModelToolCallEvent
  | ModelEndEvent;

/**
 * 模型的抽象边界：吃消息历史 + AbortSignal，吐出 assistant 事件的异步流。
 * 关键约束：模型只“描述”要做什么（发 tool_call 事件），从不亲自执行工具、
 * 也不修改 Agent 状态 —— 执行权始终在循环层手里。
 */
export type StreamFn = (
  messages: readonly AgentMessage[],
  signal: AbortSignal,
) => AsyncIterable<ModelStreamEvent>;

// ---------- Agent 生命周期事件（循环层对外广播，订阅者据此渲染 UI / 更新状态） ----------

export type AgentEvent =
  | { type: "agent_start" } // 一次 run 开始（prompt / continue 触发）
  | { type: "turn_start" } // 一个 Turn 开始（一次“模型响应 + 工具执行”）
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update"; // 流式更新，message 是累计快照
      message: AssistantMessage;
      modelEvent: ModelTextDeltaEvent | ModelToolCallEvent;
    }
  | { type: "message_end"; message: AgentMessage } // 消息定稿，进入历史
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      argumentsValue: unknown;
    }
  | {
      type: "tool_execution_update"; // 工具主动上报的进度
      toolCallId: string;
      toolName: string;
      partial: ToolExecutionResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: ToolExecutionResult;
      isError: boolean;
    }
  | {
      /** 已 start 的调用因 Run 取消或控制面错误而未产生可提交结果。 */
      type: "tool_execution_cancelled";
      toolCallId: string;
      toolName: string;
      reason: "aborted" | "control_error";
    }
  | {
      type: "model_retry_scheduled";
      attempt: number;
      delayMs: number;
      code: ModelErrorCode;
    }
  | {
      type: "model_retry_started";
      attempt: number;
    }
  | {
      type: "turn_end"; // 一个 Turn 结束：assistant 消息 + 本 Turn 全部工具结果
      message: AssistantMessage;
      toolResults: ToolResultMessage[];
    }
  | {
      /**
       * 观察性事件：恢复 session 时产生的诊断警告，仅透传，不改变状态。
       * Agent/Loop 永远不会发出它；由 server 根据 SessionSnapshot.recoveryWarnings 合成。
       */
      type: "session_recovery_warning";
      warnings: readonly SessionRecoveryWarning[];
    }
  | { type: "agent_end"; messages: AgentMessage[] }; // run 结束，携带完整 transcript

/** 事件回调的签名：所有 emit 都是 await 的，慢订阅者会自然背压到循环 */
export type EventSink = (event: AgentEvent) => Promise<void>;

/** 传给循环的上下文快照：消息历史（循环会往里 push）+ 可用工具表 */
export interface AgentContext {
  messages: AgentMessage[];
  tools: Tool<unknown>[];
}

export interface AgentContextSnapshot {
  /** Hook 只能读取快照；若要替换消息，必须通过 ContextPreparation 显式返回。 */
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly Tool<unknown>[];
}

/** prepare Hook 的返回值；当前阶段只允许替换消息，不开放动态工具修改。 */
export interface ContextPreparation {
  messages?: readonly AgentMessage[];
}

export type PrepareRequest = (
  context: AgentContextSnapshot,
  signal: AbortSignal,
) => Promise<ContextPreparation | undefined>;

/** 最后一层请求投影：返回值只传给 StreamFn，不写回 Agent 历史。 */
export type TransformContext = (
  messages: readonly AgentMessage[],
  signal: AbortSignal,
) => Promise<readonly AgentMessage[]>;

export interface TokenEstimator {
  /** 教学型近似值，只用于触发压缩和验证预算。 */
  estimate(messages: readonly AgentMessage[]): number;
}

export interface DeterministicCompactingTransformOptions {
  /** 模型请求允许的近似 Token 上限。 */
  maxInputTokens: number;
  /** 无论多长都原样保留的最近完整 Turn 数。 */
  preserveRecentTurns: number;
  /** 每种角色写入确定性摘要的最大 Unicode Code Point 数。 */
  maxExcerptCharacters?: number;
  /** 可替换估算策略；默认使用教学型启发式估算器。 */
  estimator?: TokenEstimator;
}

/** beforeToolCall 钩子要阻止执行时的返回形状 */
export interface BeforeToolCallResult {
  block: true;
  reason: string;
}

/**
 * 工具执行前的拦截钩子：拿到工具调用和已校验参数，
 * 返回 { block: true, reason } 可以阻止执行（reason 会作为错误结果喂回模型）。
 */
export type BeforeToolCall = (
  toolCall: ToolCall,
  validatedArguments: unknown,
  signal: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

/**
 * 工具执行后的改写钩子：拿到原始结果，
 * 返回一个新的 ToolExecutionResult 即可整体替换（含 isError 状态）。
 */
export type AfterToolCall = (
  toolCall: ToolCall,
  result: ToolExecutionResult,
  signal: AbortSignal,
) => Promise<ToolExecutionResult | undefined>;

/**
 * finishTurn 钩子的决策：
 * - undefined：交给默认调度（有工具结果或有 steering 就继续，否则结束）；
 * - "end"：强制在当前 Turn 后结束整个 run；
 * - "continue"：强制再来一个只带上下文的额外 Turn（必须自己加守卫，防止死循环）。
 */
export type FinishTurnDecision =
  | { action: "end" }
  | { action: "continue" }
  | undefined;

/** finishTurn 钩子的输入：刚结束的 Turn 的完整快照 */
export interface CompletedTurn {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  context: AgentContextSnapshot;
}

/** 已确认存在下一 Turn 后执行，可依据上一 Turn 的稳定快照重建工作消息。 */
export type PrepareNextTurn = (
  turn: CompletedTurn,
  signal: AbortSignal,
) => Promise<ContextPreparation | undefined>;

/** Turn 结束时的调度钩子：返回决策，告诉循环这个 run 接下来怎么走 */
export type FinishTurn = (
  turn: CompletedTurn,
  signal: AbortSignal,
) => Promise<FinishTurnDecision>;

/**
 * 循环配置：stream 是模型入口，reserve/acknowledge 方法让循环在 Turn 边界
 * 预留并确认排队消息（存储与投递策略分离），sessionCommitter 仅随配置透传，
 * 三个钩子按生命周期挂载。
 */
export interface AgentLoopConfig {
  stream: StreamFn;
  idGenerator: IdGenerator;
  retryPolicy?: RetryPolicy;
  sleep?: SleepFn;
  reserveSteeringMessages(): QueuedMessageReservation[];
  reserveFollowUpMessages(): QueuedMessageReservation[];
  acknowledgeReservations(
    reservations: readonly QueuedMessageReservation[],
  ): void;
  hasSteeringMessages(): boolean;
  hasFollowUpMessages(): boolean;
  /** 持久化入口（可选）：Loop 层暂不直接调用，仅随配置透传。 */
  sessionCommitter?: SessionCommitter;
  /** Agent 已填充默认值，Loop 和执行器不再自行推断。 */
  toolExecutionMode: ToolExecutionMode;
  /** ready Tool Call 的最大并发生命周期数量。 */
  maxToolConcurrency: number;
  prepareNextTurn?: PrepareNextTurn;
  prepareRequest?: PrepareRequest;
  transformContext?: TransformContext;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  finishTurn?: FinishTurn;
}

/**
 * Agent 对外的可观察状态（由 Agent.processEvent 从事件流归约而来）：
 * - streamingMessage：正在流式生成的 assistant 消息（未定稿）；
 * - pendingToolCalls：正在执行中的工具调用 id 集合；
 * - errorMessage：最近一个失败 Turn 的错误文案。
 */
export interface AgentState {
  messages: AgentMessage[];
  tools: Tool<unknown>[];
  isStreaming: boolean;
  streamingMessage?: AssistantMessage;
  pendingToolCalls: ReadonlySet<string>;
  errorMessage?: string;
}
