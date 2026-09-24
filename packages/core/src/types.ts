export type StopReason = "stop" | "toolUse" | "error" | "aborted";

export interface SystemMessage {
  role: "system";
  content: string;
  timestamp: number;
}

export interface UserMessage {
  role: "user";
  content: string;
  timestamp: number;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

export interface AssistantMessage {
  role: "assistant";
  content: Array<TextContent | ToolCall>;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string;
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface ToolExecutionResult {
  content: string;
  details?: unknown;
  isError?: boolean;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type ToolUpdate = (partial: ToolExecutionResult) => Promise<void>;

export interface Tool<TParameters> {
  name: string;
  description: string;
  validate(argumentsValue: unknown): ValidationResult<TParameters>;
  execute(
    toolCallId: string,
    parameters: TParameters,
    signal: AbortSignal,
    onUpdate: ToolUpdate,
  ): Promise<ToolExecutionResult>;
}

export interface ModelStartEvent {
  type: "start";
  message: AssistantMessage;
}

export interface ModelTextDeltaEvent {
  type: "text_delta";
  delta: string;
  message: AssistantMessage;
}

export interface ModelToolCallEvent {
  type: "tool_call";
  toolCall: ToolCall;
  message: AssistantMessage;
}

export interface ModelEndEvent {
  type: "end";
  message: AssistantMessage;
}

export type ModelStreamEvent =
  | ModelStartEvent
  | ModelTextDeltaEvent
  | ModelToolCallEvent
  | ModelEndEvent;

export type StreamFn = (
  messages: readonly AgentMessage[],
  signal: AbortSignal,
) => AsyncIterable<ModelStreamEvent>;

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update";
      message: AssistantMessage;
      modelEvent: ModelTextDeltaEvent | ModelToolCallEvent;
    }
  | { type: "message_end"; message: AgentMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      argumentsValue: unknown;
    }
  | {
      type: "tool_execution_update";
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
      type: "turn_end";
      message: AssistantMessage;
      toolResults: ToolResultMessage[];
    }
  | { type: "agent_end"; messages: AgentMessage[] };

export type EventSink = (event: AgentEvent) => Promise<void>;

export interface AgentContext {
  messages: AgentMessage[];
  tools: Tool<unknown>[];
}

export interface BeforeToolCallResult {
  block: true;
  reason: string;
}

export type BeforeToolCall = (
  toolCall: ToolCall,
  validatedArguments: unknown,
  signal: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

export type AfterToolCall = (
  toolCall: ToolCall,
  result: ToolExecutionResult,
  signal: AbortSignal,
) => Promise<ToolExecutionResult | undefined>;

export type FinishTurnDecision =
  | { action: "end" }
  | { action: "continue" }
  | undefined;

export interface CompletedTurn {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  context: AgentContext;
}

export type FinishTurn = (
  turn: CompletedTurn,
  signal: AbortSignal,
) => Promise<FinishTurnDecision>;

export interface AgentLoopConfig {
  stream: StreamFn;
  getSteeringMessages(): AgentMessage[];
  getFollowUpMessages(): AgentMessage[];
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  finishTurn?: FinishTurn;
}

export interface AgentState {
  messages: AgentMessage[];
  tools: Tool<unknown>[];
  isStreaming: boolean;
  streamingMessage?: AssistantMessage;
  pendingToolCalls: ReadonlySet<string>;
  errorMessage?: string;
}
