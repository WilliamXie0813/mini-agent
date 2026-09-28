# Telemetry 设计方案

**日期：** 2026-09-28  
**状态：** 已批准  
**阶段：** 扩展版阶段 5

## 1. 背景

当前 Core 已经提供 `AgentEvent`：

```text
agent_start
turn_start
message_start
message_update
tool_execution_start
tool_execution_end
turn_end
agent_end
```

这些事件属于 Agent 的业务协议。`Agent` 使用它们归约 `AgentState`，Server 和
Web UI 可以使用它们更新界面。

但 `AgentEvent` 无法完整回答诊断问题：

- 一次 Run 总共花了多长时间？
- 每个 Turn 的时间分别消耗在 Context Hook、模型还是工具？
- 并行工具是否真的重叠执行？
- 哪类工具调用失败最多？
- Retry、Session Commit 和未来的 Compaction 各自消耗了多少时间？
- Telemetry 后端失败时，Agent 的行为是否保持不变？

本设计增加独立的 Telemetry 通道。Telemetry 只观察 Agent，不参与状态归约、
Transcript 提交或业务调度。

## 2. 目标

第一版必须实现：

1. 在 Core 中记录 Run、Turn、Context Hook、模型请求、工具批次和单个工具调用。
2. 使用显式父 Span 传递上下文，不依赖全局变量或 `AsyncLocalStorage`。
3. 自动管理 Span 结束时间，业务代码不能忘记 `end()`。
4. 保证每个 Span Callback 恰好执行一次。
5. 保证 Telemetry 记录失败不改变业务返回值、错误身份、AgentEvent 顺序或 Transcript。
6. 默认使用近乎零记录开销的 Noop 实现。
7. 提供可测试的 InMemory 实现、只读 Snapshot 和 Span 树格式化。
8. 默认不记录 Prompt、工具参数、工具结果、文件内容、API Key 或错误 Cause。
9. 为 Retry、Session、Provider 和 Compaction 定义稳定接入点，但不在本阶段实现这些模块的内部 Telemetry。

## 3. 非目标

第一版不实现：

- OpenTelemetry SDK 或云端追踪平台接入。
- 日志搜索、指标数据库或长期存储。
- Server Telemetry HTTP 端点。
- Web 诊断页面。
- 跨进程 Trace Context 传播。
- Span Sampling、批量导出或网络重试。
- 从 `AgentEvent` 反向重建 Span。
- 对 Prompt、工具参数或结果正文的可选采集开关。

第一版只提供 Core 内存快照。后续 Adapter 可以消费相同的
`TelemetryRecord`，不需要修改 Agent Loop。

## 4. AgentEvent 与 Telemetry 的边界

`AgentEvent` 和 Telemetry 不能互相替代：

| 维度 | AgentEvent | Telemetry |
|---|---|---|
| 用途 | 状态归约、UI、业务生命周期 | 耗时、层级、失败分类、诊断 |
| 是否影响业务 | Listener 可以背压并使 Run 失败 | 失败必须被隔离 |
| 是否进入 Transcript | 部分事件对应 Message 提交 | 永不进入 |
| 顺序语义 | 属于 Agent 对外协议 | 只观察，不增加调度点 |
| 数据内容 | 可携带 Message、Tool Result | 只允许安全属性 |

禁止把 Telemetry Span 转换成 `AgentEvent`。否则 Telemetry Sink 失败可能通过
现有 `EventSink` 进入 `emitFailure()`，把观测故障伪装成 Agent 业务失败。

## 5. 方案选择

### 5.1 方案 A：从 AgentEvent 推导 Span

优点是对 Runtime 改动少。

缺点：

- 看不到 `prepareRequest`、`transformContext` 等内部阶段。
- 看不到模型首事件之前的等待和失败。
- 并行工具的父子关系需要依赖事件重建，容易出现不完整 Span。
- Event Listener 与 Telemetry 的失败语义冲突。

不采用。

### 5.2 方案 B：通用生命周期拦截器

为所有 Runtime 阶段增加可注册 Hook。

优点是扩展能力强。

缺点是第一版需要定义 Hook 注册、优先级、错误处理和组合规则，复杂度超过当前教学目标。

不采用。

### 5.3 方案 C：显式嵌套 Span

`Agent` 创建 Run Span，并把它显式传给 Loop；Loop 创建 Turn、Context 和 Model
Span；Tool Executor 从 Turn Span 创建 Batch 和 Tool Call Span。

优点：

- 父子关系由调用结构直接决定。
- 并行工具不会串错父级。
- 内部阶段具有准确边界。
- 测试不依赖全局上下文。

本设计采用方案 C。

## 6. 总体架构

Telemetry 分为两层：

```text
Agent Runtime
    ↓ 只依赖
SafeTelemetryContext / TelemetrySpan
    ↓ 输出生命周期记录
TelemetrySink
```

### 6.1 Runtime-facing Context

负责：

- 创建 Span ID 和父子关系。
- 执行业务 Callback。
- 自动设置默认状态和结束时间。
- 保留业务错误对象身份。
- 捕获 `TelemetrySink` 异常。
- 在根 Span 创建失败时把整棵子树降级为 Noop。

### 6.2 TelemetrySink

Sink 只接收同步 `TelemetryRecord`，不能获得或执行业务 Callback。

该限制解决一个关键问题：如果第三方 Adapter 直接实现
`startSpan(callback)`，它可能漏调、重复调用或替换 Callback 错误。Sink 模型把业务执行权留在 Core。

### 6.3 默认实现

第一版提供：

```text
NoopTelemetryContext
InMemoryTelemetryContext
```

- Noop：直接执行 Callback，不创建 ID、Record 或 Snapshot。
- InMemory：通过安全 Context 和内存 Sink 记录完整 Span。

## 7. 公共类型

### 7.1 属性和状态

```ts
export type TelemetryAttribute =
  | string
  | number
  | boolean
  | undefined;

export type TelemetryAttributes = Readonly<
  Record<string, TelemetryAttribute>
>;

export interface TelemetrySpanStatus {
  status: "ok" | "error";
  message?: string;
}
```

规则：

- `undefined` 属性不会写入 Record。
- `message` 只能保存稳定、安全的错误分类或固定说明。
- 禁止把原始异常消息、Prompt、参数、结果正文或 Cause 放入 `message`。

### 7.2 Clock

```ts
export interface TelemetryClock {
  now(): number;
}
```

`now()` 返回同一单调时间轴上的毫秒值：

- 用于计算持续时间和测试。
- 不解释为 Unix Timestamp。
- 不写入 Session 持久化。
- 默认实现使用单调时钟。

### 7.3 Record

```ts
export interface SpanStartRecord {
  type: "span_start";
  spanId: number;
  parentSpanId?: number;
  name: string;
  attributes: Readonly<Record<string, string | number | boolean>>;
  timestamp: number;
}

export interface SpanAttributesRecord {
  type: "span_attributes";
  spanId: number;
  attributes: Readonly<Record<string, string | number | boolean>>;
  timestamp: number;
}

export interface SpanEventRecord {
  type: "span_event";
  spanId: number;
  name: string;
  attributes: Readonly<Record<string, string | number | boolean>>;
  timestamp: number;
}

export interface SpanStatusRecord {
  type: "span_status";
  spanId: number;
  status: TelemetrySpanStatus;
  timestamp: number;
}

export interface SpanEndRecord {
  type: "span_end";
  spanId: number;
  timestamp: number;
}

export type TelemetryRecord =
  | SpanStartRecord
  | SpanAttributesRecord
  | SpanEventRecord
  | SpanStatusRecord
  | SpanEndRecord;
```

Span ID 是单个 `TelemetryContext` 内的递增整数。第一版不把它设计成分布式 Trace ID。

### 7.4 Sink 与错误报告

```ts
export interface TelemetrySink {
  record(record: TelemetryRecord): void;
}

export type TelemetryOperation =
  | "span_start"
  | "span_attributes"
  | "span_event"
  | "span_status"
  | "span_end";

export interface TelemetryFailure {
  operation: TelemetryOperation;
  spanName: string;
  error: unknown;
}

export type TelemetryErrorHandler = (
  failure: TelemetryFailure,
) => void;
```

`TelemetryErrorHandler` 是独立诊断通道：

- 缺省为空操作。
- 不能通过 AgentEvent 广播。
- 自身抛错时必须被吞掉。
- 不把 `TelemetryRecord` 整体传给 Handler，避免 Handler 意外复制全部属性。

### 7.5 Context 与 Span

```ts
export interface TelemetryContext {
  startSpan<T>(
    name: string,
    attributes: TelemetryAttributes,
    operation: (span: TelemetrySpan) => Promise<T>,
  ): Promise<T>;
}

export interface TelemetrySpan {
  setAttributes(attributes: TelemetryAttributes): void;
  addEvent(name: string, attributes?: TelemetryAttributes): void;
  setStatus(status: TelemetrySpanStatus): void;
  startSpan<T>(
    name: string,
    attributes: TelemetryAttributes,
    operation: (span: TelemetrySpan) => Promise<T>,
  ): Promise<T>;
}
```

Runtime 使用固定 Span 名称。工具名、模型 ID 和其他动态值只能作为属性，不能拼进名称。

### 7.6 创建 API

```ts
export interface TelemetryContextOptions {
  sink: TelemetrySink;
  clock?: TelemetryClock;
  onTelemetryError?: TelemetryErrorHandler;
}

export function createTelemetryContext(
  options: TelemetryContextOptions,
): TelemetryContext;

export interface InMemoryTelemetryOptions {
  clock?: TelemetryClock;
  onTelemetryError?: TelemetryErrorHandler;
}

export function createInMemoryTelemetryContext(
  options?: InMemoryTelemetryOptions,
): InMemoryTelemetryContext;

export const noopTelemetry: TelemetryContext;
```

默认 Clock 使用 `performance.now()`。Core 不导出可变的全局 Sink 或默认
InMemory 实例；每个 InMemory Context 拥有独立 ID 空间和记录集合。

## 8. Span Callback 语义

`startSpan()` 必须满足：

1. `operation` 恰好执行一次。
2. `operation` resolve 时：
   - 如果没有显式状态，写入 `status: "ok"`；
   - 写入 `span_end`；
   - 返回原始结果。
3. `operation` reject 时：
   - 如果没有显式状态，尝试写入 `status: "error"`；
   - 尝试写入 `span_end`；
   - 重新抛出同一个错误对象。
4. Sink 在任何阶段抛错都不能替换业务结果或错误。
5. `span_start` 写入失败时：
   - 调用 `onTelemetryError`；
   - 当前 Span 及所有子 Span 退化为 Noop；
   - 仍然执行 `operation`；
   - 不再写入 update/status/end，避免产生没有 start 的孤儿记录。
6. start 成功、后续 Record 失败时：
   - 分别报告失败；
   - 继续尝试后续 Record；
   - 不影响 Callback。
7. 显式 `setStatus()` 后，自动结束不能覆盖该状态。
8. 多次 `setStatus()` 使用最后一次成功写入的状态。

## 9. Span 层级与边界

第一版 Core Span 树：

```text
agent.run
└── agent.turn
    ├── context.prepare_next_turn
    ├── context.prepare_request
    ├── context.transform
    ├── model.request
    └── tool.batch
        ├── tool.call
        └── tool.call
```

### 9.1 `agent.run`

边界：

- Agent 获得本次运行权并设置 `activeRun` 后打开。
- 在 `agent_start` 之前已经处于打开状态。
- 正常路径在 `agent_end` 和瞬态状态清理完成后关闭。
- 错误路径在 `emitFailure()` 和瞬态状态清理完成后关闭。
- Span 关闭后才 resolve `activeRun.settled` 并释放 `activeRun`，因此
  `prompt()`、`continue()` 和 `waitForIdle()` resolve 时 Snapshot 已包含完整 Run Span。

属性：

```text
agent.prompt_count
agent.result = success | error | aborted
```

错误或 Abort 已被 `Agent.run()` 捕获并转换成失败 Message，因此必须显式设置 Run Span：

```text
status = error
agent.result = error | aborted
```

不能因为外层 Callback 最终 resolve 就自动记为成功。

`runAgentLoop()` 正常 resolve 后，Agent 检查本次 Run 最后一条 Assistant Message：

- `stopReason: "error"` → `agent.result=error`，Span status 为 error。
- `stopReason: "aborted"` → `agent.result=aborted`，Span status 为 error。
- 其他终态 → `agent.result=success`，Span status 为 ok。

### 9.2 `agent.turn`

边界：

- 紧接在对应 `turn_start` 发射前打开。
- 紧接在对应 `turn_end` 发射后关闭。
- 中途抛错时由 Callback Wrapper 自动标记 error 并关闭。

属性：

```text
agent.turn_index       // 从 1 开始
agent.tool_call_count
agent.stop_reason
```

如果 Turn 在得到最终 Assistant Message 前失败，则不写
`agent.stop_reason`。

Turn 得到最终 Assistant Message 后按 `stopReason` 设置状态：

- `stop` / `toolUse` → ok。
- `error` / `aborted` → error。

### 9.3 Context Span

仅在对应 Hook 已配置时创建：

```text
context.prepare_next_turn
context.prepare_request
context.transform
```

属性：

```text
context.input_message_count
context.output_message_count
```

规则：

- 未配置 Hook 时不创建空 Span。
- `prepareNextTurn` 只在第二个及后续 Turn 出现。
- 不记录 Message Role、正文或完整 Message 对象。
- Token 数留给未来 Compaction 接入点，本阶段不增加额外估算。

### 9.4 `model.request`

边界：

- 在创建模型异步流之前打开。
- 覆盖完整 `for await` 消费。
- 收到并处理 `end` 后关闭。
- 不包含 Context Hook 或工具执行。

属性：

```text
model.provider          // 可选
model.id                // 可选
model.output_characters
model.stop_reason
```

`model.output_characters` 是所有 `text_delta.delta` 的 Unicode Code Point
数量之和，不保存文本。

模型信息通过可选配置传入：

```ts
export interface ModelTelemetryInfo {
  provider?: string;
  modelId?: string;
}
```

`AgentOptions.modelTelemetryInfo` 缺省时省略对应属性，不使用 `"unknown"` 占位。

### 9.5 `tool.batch`

仅当 Assistant Message 包含至少一个 Tool Call 时创建。

边界覆盖：

- Tool Call ID 校验。
- 全批次预检。
- 串行或并行调度。
- Tool Finalization。
- 结果排序与 `ToolResultMessage` 创建。

属性：

```text
tool.call_count
tool.execution_mode
tool.result = success | partial_error | error | aborted | control_error
```

`partial_error` 表示 Batch 正常返回，但至少一个 Tool Result 的
`isError` 为 true。

### 9.6 `tool.call`

每个 Tool Call 都创建一个 Span，包括：

- 真实工具执行。
- 未知工具。
- 参数校验失败。
- `beforeToolCall` 阻止。

属性：

```text
tool.name
tool.call_id
tool.executed
tool.result
```

`tool.result` 是稳定枚举：

```text
success
error
blocked
invalid_arguments
unknown_tool
aborted
control_error
```

规则：

- `tool.call` 在预检完成后、`tool_execution_start` 之前打开，在该调用的
  执行/Finalization Promise settle 后关闭。批次随后补发的
  `tool_execution_cancelled` 不延长已经 settle 的 Span。
- 参数校验和 `beforeToolCall` 的耗时属于 `tool.batch`；第一版不为每次预检增加额外 Span。
- 未知工具、非法参数和 Block 的 `tool.executed=false`。
- 真实调用进入 `Tool.execute()` 前设置为 `true`。
- Tool 抛错并被转换为 Error Result 时使用 `error`。
- 并行 `tool.call` 可以重叠，完成顺序不影响 Transcript 源顺序。
- 不记录 Tool Arguments、Result Content、Details 或异常 Cause。

状态映射：

- `tool.result=success` → Span status 为 ok。
- 其他 `tool.result` → Span status 为 error。
- `tool.batch=success` → Span status 为 ok。
- `partial_error | error | aborted | control_error` → Batch Span status 为 error。

## 10. Runtime 接入

### 10.1 AgentOptions

```ts
export interface AgentOptions {
  // 现有字段
  telemetry?: TelemetryContext;
  modelTelemetryInfo?: ModelTelemetryInfo;
}
```

构造函数规则：

- `telemetry` 缺省时使用共享 `NoopTelemetryContext`。
- `modelTelemetryInfo` 复制到 Agent 内部，不能保留调用者可变对象引用。

### 10.2 Agent

`Agent.run()` 创建根 Span：

```text
activeRun 建立
  ↓
agent.run Span 打开
  ↓
runAgentLoop()
  ↓
正常 agent_end 或 emitFailure()
  ↓
清理 streamingMessage / pendingToolCalls
  ↓
agent.run Span 关闭
  ↓
resolve settled 并释放 activeRun
```

Telemetry Sink 的同步记录不能被 `await`，因此不会向现有业务流增加异步调度点。

### 10.3 Agent Loop

`runAgentLoop()` 增加显式参数：

```ts
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EventSink,
  signal: AbortSignal,
  runSpan: TelemetrySpan,
): Promise<void>;
```

`runSpan` 属于单次 Run，不能放入可长期复用的 `AgentLoopConfig`。

Loop 将单个 Turn 的主体放入：

```ts
runSpan.startSpan("agent.turn", attributes, async (turnSpan) => {
  // 当前 Turn 的 Context、Model 和 Tool 生命周期
});
```

该结构需要提取一个内部 Turn 执行函数，避免把整个 `while` 循环包成单个 Span。

### 10.4 Model

`streamAssistantResponse()` 接收当前 `turnSpan` 并创建 `model.request`。

模型流事件到 AgentEvent 的转换顺序保持不变：

```text
start      → message_start
text/tool  → message_update
end        → message_end
```

Telemetry 只在相同同步调用栈中更新属性，不插入 Event。

### 10.5 Tool Executor

`ToolExecutionBatchOptions` 增加：

```ts
telemetry: TelemetrySpan;
```

这里传入当前 Turn Span。`executeToolCallBatch()` 创建 `tool.batch`，并把 Batch
Span传给 `executeReady()` 和 `executeImmediate()` 创建 `tool.call`。

Telemetry 不能复用 `ToolEventDispatcher`：

- Dispatcher 失败属于控制面错误，应使 Batch 失败。
- Telemetry 失败必须被隔离。
- 两者具有不同失败语义。

## 11. InMemory 实现

### 11.1 RecordedSpan

```ts
export interface RecordedSpanEvent {
  name: string;
  attributes: Readonly<Record<string, string | number | boolean>>;
  timestamp: number;
}

export interface RecordedSpan {
  id: number;
  parentId?: number;
  name: string;
  attributes: Readonly<Record<string, string | number | boolean>>;
  events: readonly RecordedSpanEvent[];
  status: TelemetrySpanStatus;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}
```

只有已经收到 `span_end` 的 Span 才进入公共 Snapshot。测试可通过独立内部检查确认没有未结束 Span，但调用者不能读取可变的进行中记录。

### 11.2 Snapshot

```ts
export interface InMemoryTelemetryContext extends TelemetryContext {
  snapshot(): readonly RecordedSpan[];
  formatTree(): string;
}
```

规则：

- `snapshot()` 按 Span ID 升序返回。
- 返回新的数组、属性对象、Event 数组和 Status 对象。
- 调用者修改返回值不能影响后续 Snapshot。
- `formatTree()` 按父子层级和 Span ID 稳定输出。
- 格式化内容只包含名称、持续时间、状态和已记录的安全属性。

格式化规则：

```text
agent.run 12.00ms [ok] agent.prompt_count=1 agent.result="success"
  agent.turn 10.00ms [ok] agent.turn_index=1
    model.request 6.00ms [ok] model.output_characters=8
```

- 每个 Span 一行，子级缩进两个空格。
- 根 Span 和同级 Span 按 ID 升序。
- 持续时间固定保留两位小数。
- 属性按 key 字典序排列。
- string 使用 JSON 字符串表示；number 和 boolean 使用普通字面量。
- 没有属性时省略行尾属性区。
- 第一版不把 Span Event 展开到树文本；Event 仍可通过 Snapshot 查看。

### 11.3 并发记录

JavaScript 同一线程中的同步 `record()` 调用不会在单次调用中交错。

并行工具可以按以下顺序记录：

```text
start tool A
start tool B
end tool B
end tool A
```

InMemory Sink 必须按 Span ID 保存父子关系，不能根据结束顺序推断层级。

## 12. Noop 实现

Noop 使用共享单例：

```ts
export const noopTelemetry: TelemetryContext;
```

语义：

- 不创建 ID。
- 不读取 Clock。
- 不分配 Record。
- `startSpan()` 只创建或复用一个共享 Noop Span，然后执行 Callback。
- Callback 返回值和错误对象原样保留。
- 嵌套 Span 继续使用同一个 Noop Span。

Noop 仍然会产生业务 Callback 本身必需的 Promise 开销，但不产生诊断记录开销。

## 13. 隐私与数据最小化

默认禁止记录：

- System Prompt 和 User Prompt。
- Assistant Text。
- Tool Arguments。
- Tool Result Content 和 Details。
- 文件内容和路径全文。
- API Key、Authorization Header 和 Cookie。
- 原始 HTTP Body。
- Error Cause、Stack 和未经分类的错误消息。
- 完整 `AgentMessage` 或 `ModelRequest`。

允许记录：

- 固定 Span 名称。
- 消息数量、字符数量和未来的 Token 估算数量。
- Provider 和 Model ID。
- Tool Name 和 Tool Call ID。
- 稳定结果枚举。
- Retry Attempt、Delay 等数值。
- Session ID；仅在未来 Session 模块明确启用时记录。

Telemetry API 不提供“记录任意对象”的重载。属性只能是
string、number、boolean 或 undefined。

## 14. 未来阶段接入点

### 14.1 Retry

Retry Wrapper 接收当前 `model.request` Span：

```text
model.request
└── model.retry_wait
```

`model.retry_wait` 属性：

```text
model.attempt
retry.delay_ms
error.code
```

Retry 不创建第二个 `model.request` 根 Span。同一次逻辑请求的 Attempt 通过属性和 Event
区分。

### 14.2 Session Persistence

- Run 内提交：`session.commit` 是触发提交的 Run 或 Turn Span 子级。
- Session 恢复：没有活动 Run，直接从 `TelemetryContext` 创建根
  `session.restore` Span。
- Telemetry 失败不能改变 Commit 结果。
- Commit 失败属于业务错误，应正常传播并让 Span 标记 error。

### 14.3 DeepSeek Provider

Provider 不接收 `TelemetrySpan`，也不创建自己的模型 Span。Loop 在调用
`StreamFn(ModelRequest)` 前已经打开 `model.request`，并使用自己掌握的请求数据增加属性：

- `model.provider` 和 `model.id` 来自 `AgentOptions.modelTelemetryInfo`。
- `model.request_id` 来自未来 `ModelRequest.requestId`。
- Provider 抛出的 `ModelError.code` 可以由 Loop 或 Retry Wrapper
  记录为安全分类。
- 不创建重复模型 Span。
- 不记录 API Key、请求正文、响应正文或原始 Header。
- ai-sdk 内置重试保持 `maxRetries: 0`，Retry Span 仍由 Core 控制。

### 14.4 Compaction

Compaction 创建自己的子 Span：

```text
context.compaction
```

属性：

```text
context.input_estimated_tokens
context.output_estimated_tokens
context.removed_turn_count
```

本阶段不提前实现 Token Estimator 或 Compaction Span。

## 15. 文件边界

### 新增

```text
packages/core/src/telemetry.ts
packages/core/src/in-memory-telemetry.ts
packages/core/test/telemetry.test.ts
packages/core/test/agent-telemetry.test.ts
```

职责：

- `telemetry.ts`：公共类型、安全 Context、Noop、Clock、Record。
- `in-memory-telemetry.ts`：内存 Sink、Snapshot、树格式化。
- `telemetry.test.ts`：Telemetry 引擎独立契约。
- `agent-telemetry.test.ts`：Runtime Span 树、失败隔离和隐私。

### 修改

```text
packages/core/src/types.ts
packages/core/src/agent.ts
packages/core/src/agent-loop.ts
packages/core/src/tool-execution.ts
packages/core/src/index.ts
packages/core/test/tool-execution.test.ts
```

不修改 Server、Web、Plugins、Retry、Session 或 DeepSeek 源码。

## 16. 测试策略

### 16.1 Telemetry 引擎

必须覆盖：

1. Noop Callback resolve 时只执行一次并返回原值。
2. Noop Callback reject 时只执行一次并保留错误对象身份。
3. InMemory 正常顺序为 start → status ok → end。
4. 显式状态不会被自动状态覆盖。
5. Callback reject 记录 error 和 end，并重新抛出同一对象。
6. Fake Clock 精确控制 `startedAt`、`endedAt` 和 `durationMs`。
7. start 失败时 Callback 仍执行，子树不产生 Record。
8. attributes/event/status/end 失败时业务结果不变。
9. `onTelemetryError` 抛错时业务结果仍不变。
10. undefined 属性被删除。
11. Snapshot 修改不影响内部状态。
12. `formatTree()` 对并行完成顺序产生稳定父子输出。

### 16.2 Runtime 集成

必须覆盖：

1. 单 Turn 无工具生成 Run → Turn → Model。
2. 两个 Turn 分别生成独立 Turn Span。
3. 未配置 Context Hook 时不生成 Context Span。
4. 配置 Hook 后记录正确的输入输出消息数。
5. Tool Call 生成 Batch 和 Call Span。
6. 未知工具、非法参数和 Block 使用正确结果枚举。
7. Tool Exception 使用 `error`，Agent 仍得到 Error Tool Result。
8. 并行工具 Span 共享 Batch 父级且时间区间可重叠。
9. Abort 关闭所有已开始 Span，并把 Run 标为 aborted。
10. 故意抛错的 Sink 不改变 Transcript、AgentState 或 AgentEvent 序列。

### 16.3 隐私回归

测试分别把唯一 Canary 字符串放入：

- Prompt。
- Tool Arguments。
- Tool Result Content。
- Tool Result Details。
- Error Cause。
- API Key 风格字符串。

序列化完整 Snapshot 后，所有 Canary 都不得出现。

## 17. 验收标准

设计实现完成后必须满足：

- 能用 InMemory Span 树解释一次完整 Run 的耗时分布。
- 每个已开始 Span 都有终态，不存在悬空 Span。
- 两个并行工具具有正确父级并显示时间重叠。
- Telemetry Sink 全面故障时 Agent 的业务行为保持不变。
- Noop 和 InMemory 下的 AgentEvent 类型与顺序一致。
- 默认 Snapshot 不包含 Prompt、工具参数、工具结果或凭证。
- Runtime 不使用全局 Current Span。
- 后续 Retry、Session、Provider 和 Compaction 可以通过现有
  Context/Span 接口接入，不需要修改 AgentEvent 或 Transcript。

## 18. 关键设计结论

1. Telemetry 是独立诊断通道，不是 AgentEvent 的扩展。
2. Runtime 控制 Callback，Adapter 只能记录，才能可靠保证被动原则。
3. 父 Span 显式传递，避免异步并发中的隐式上下文混乱。
4. Span 名称稳定，动态信息只放入属性。
5. 错误分类可记录，原始敏感内容默认不记录。
6. 第一版只落地 Core 和 InMemory 查看能力，其他阶段只保留接入点。
