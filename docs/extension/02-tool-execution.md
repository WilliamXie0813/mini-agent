# 阶段 2：并行与串行工具执行

正式实施契约见：[并行与串行工具执行设计](../superpowers/specs/2026-09-28-tool-execution-design-zh.md)。

## 当前问题

当前 `agent-loop.ts` 使用：

```ts
for (const toolCall of toolCalls) {
  toolResults.push(await executeToolCall(...));
}
```

所有工具严格串行。这能保证简单和安全，但两个互不依赖的读取操作会浪费时间。

本阶段解决“**多个工具调用如何在保持确定性和安全性的同时并发执行**”。

## 学习目标

- 区分工具的逻辑顺序、完成顺序和持久化顺序。
- 理解并发工具的预检、取消和事件语义。
- 为有副作用的工具保留串行能力。
- 将执行策略从 Agent Loop 中抽离。

## 非目标

- 不实现自动工具重试。
- 不做工具依赖图。
- 不让模型直接指定任意并发级别。
- 不引入 Worker Thread。

## 方案比较

### 方案 A：直接 `Promise.all`

代码少，但参数错误、Hook 阻止、事件顺序、取消和结果排序都会混在一起。

### 方案 B：所有工具始终并行

读取类工具很快，但编辑、删除、支付等副作用工具可能互相冲突。

### 方案 C：执行策略 + 工具级约束，推荐

```text
ToolExecutionStrategy
├── SequentialToolExecution
└── ParallelToolExecution
```

Agent 配置决定默认策略，单个工具可以要求串行。

## 目标接口

扩展工具定义：

```ts
export type ToolExecutionMode = "parallel" | "sequential";

export interface Tool<TParameters> {
  name: string;
  description: string;
  executionMode?: ToolExecutionMode;
  validate(value: unknown): ValidationResult<TParameters>;
  execute(...): Promise<ToolExecutionResult>;
}
```

`executionMode` 采用保守默认：

- `"parallel"`：明确允许并行。
- `"sequential"`：要求整批串行。
- `undefined`：等价于 `"sequential"`，避免旧工具在没有并发安全声明时被意外并行。

增加批次执行接口：

```ts
export interface ToolExecutionContext {
  agentContext: AgentContext;
  assistantMessage: AssistantMessage;
  config: AgentLoopConfig;
  emit: EventSink;
  signal: AbortSignal;
}

export interface ToolExecutionBatch {
  messages: ToolResultMessage[];
}

export interface ToolExecutionStrategy {
  execute(
    toolCalls: readonly ToolCall[],
    context: ToolExecutionContext,
  ): Promise<ToolExecutionBatch>;
}
```

## 预检与执行分离

并行执行前先顺序完成预检：

```text
查找工具
→ 参数校验
→ beforeToolCall
→ 得到 PreparedToolCall
```

预检完成后才启动真实执行：

```ts
type PreparedToolCall =
  | { kind: "ready"; toolCall: ToolCall; tool: Tool<unknown>; parameters: unknown }
  | { kind: "immediate"; toolCall: ToolCall; result: ToolExecutionResult };
```

未知工具、参数错误和被阻止调用属于 `immediate`，不进入并发执行。

## 三种顺序

### 模型源顺序

```text
call-1 read(a)
call-2 read(b)
call-3 read(c)
```

### 完成顺序

```text
call-2
call-3
call-1
```

### 消息写入顺序

必须恢复为模型源顺序：

```text
toolResult(call-1)
toolResult(call-2)
toolResult(call-3)
```

事件 `tool_execution_end` 可以按真实完成顺序发出，但 Transcript 中的 Tool Result 必须稳定排序。

## 策略选择

推荐规则：

```text
Agent 默认 sequential
    ↓
用户显式配置 parallel
    ↓
检查所有 ready 工具是否都显式声明 executionMode: parallel
    ↓
是 → 并行
否 → 整批串行
```

整批降级比部分并行更容易解释，也更适合教学版。

## 并发限制

不要直接无限 `Promise.all`。增加：

```ts
export interface ParallelToolOptions {
  maxConcurrency: number;
}
```

默认建议为 4。实现一个简单工作队列，不引入第三方库。

## 取消语义

- 所有工具共享当前 Run 的 `AbortSignal`。
- `abort()` 后不再启动尚未开始的任务。
- 已启动工具必须协作式响应 Signal。
- Agent 必须等待已启动 Promise 结算，避免悬空任务继续修改外部状态。
- Event Dispatcher 可用时，每个已发出 start 的工具最终必须发出 end 或 cancelled，确保 pending 状态可以被事件消费者清理；EventSink 自身失败时由 Run 收尾清理内部状态。
- 中止不转换成普通错误 Tool Result，而是终止整个 Run。

并行工具的 start、update、end 和 cancelled 事件必须经过串行 Dispatcher；`afterToolCall` 也串行执行，避免订阅者和已有 Hook 被并发调用。

## 调用链变化

```text
Assistant toolCalls
    ↓
顺序预检全部调用
    ↓
选择执行策略
    ├── sequential
    └── parallel(maxConcurrency)
    ↓
按完成顺序发 tool_execution_end
    ↓
按模型源顺序创建 ToolResultMessage
    ↓
进入下一 Turn
```

## 对现有包的影响

### `packages/core`

- 新增 `tool-execution.ts`。
- `agent-loop.ts` 只调用策略，不包含并发细节。
- `types.ts` 增加执行模式和策略接口。
- `AgentOptions` 增加默认执行模式和最大并发数。

### `packages/server`

协议不变，但 Web UI 会看到多个同时存在的 `pendingToolCalls`。

### `packages/web`

确认 Reducer 可以正确维护多个并发工具 ID，且完成顺序任意。

### `packages/plugins`

插件工具将来必须能声明 `executionMode`。本阶段只定义字段，不扩展插件加载。

## 测试策略

必须使用可控 Promise，而不是依赖真实时间：

1. 三个并行工具都在第一个工具完成前启动。
2. `tool_execution_end` 按真实完成顺序出现。
3. Tool Result Message 按模型源顺序进入历史。
4. 一个 sequential 工具让整批降级为串行。
5. `maxConcurrency: 2` 时最多两个工具同时运行。
6. 参数非法工具不调用 `execute()`。
7. `beforeToolCall` 仍按模型源顺序执行。
8. 重复 Tool Call ID 在任何工具启动前被拒绝。
9. EventSink 和 `afterToolCall` 不会并发执行。
10. abort 后未启动任务不再启动，已启动任务被等待，并在 Event Dispatcher 可用时产生 cancelled 终止事件。

## 验收标准

- 读取型工具能并行缩短总耗时。
- 串行模式保持核心版行为。
- Transcript 顺序确定，不受机器调度影响。
- Server/Web 能展示多个 pending 工具。

## 学习练习

1. 写三个手动控制完成时机的工具，观察事件顺序和消息顺序。
2. 将第二个工具标记为 sequential，验证整批降级。
3. 将最大并发设为 1，证明它等价于串行。
4. 中止一个并行批次，记录哪些工具已经启动。

## 进入下一阶段前

你应该能够回答：

- 为什么事件完成顺序可以不同，但 Tool Result 顺序必须稳定？
- 为什么参数验证应在并行执行前完成？
- 为什么工具重试不能简单复用模型重试逻辑？
