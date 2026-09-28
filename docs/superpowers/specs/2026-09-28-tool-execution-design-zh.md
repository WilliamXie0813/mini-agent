# 并行与串行工具执行设计

日期：2026-09-28
来源：[阶段 2：并行与串行工具执行](../../extension/02-tool-execution.md)

## 目的

为 `packages/core` 增加确定、可取消、受并发上限约束的批次工具执行能力，使同一 Assistant Message 中明确允许并行的工具调用可以并行执行，同时保持事件串行分发、工具结果历史稳定，并保留默认串行行为。

本设计解决五个问题：

1. 将工具预检、执行调度和结果提交从 Agent Loop 中拆分。
2. 在工具完成顺序不确定时，保持 Transcript 中的 Tool Result 顺序确定。
3. 允许单个工具要求串行执行，避免有副作用的工具在同一批次中并发。
4. 在取消 Run 时停止启动新工具，并等待已经启动的工具结算。
5. 在工具并行执行时保持 EventSink 和 Tool Hook 的串行调用契约。

## 范围

### 本阶段包含

- 将同一 Assistant Message 中的全部 Tool Call 作为一个执行批次。
- 顺序预检工具查找、参数校验和 `beforeToolCall`。
- 默认串行和显式启用的受限并行执行模式。
- 工具级 `executionMode: "sequential"` 约束。
- 整批串行降级。
- 可配置的最大并发数。
- 完成顺序事件和模型源顺序 Transcript。
- 批次级 Tool Call ID 唯一性验证。
- Tool Event 串行分发和 `afterToolCall` 串行 Finalization。
- start/end/cancelled 完整终止事件配对。
- 批次级取消与已启动任务结算。
- `packages/core` 的完整实现和单元测试。
- `packages/server` 与 `packages/web` 对多个 pending 工具的集成验证。
- 插件工具类型对可选执行模式字段的兼容。

### 本阶段不包含

- 工具依赖图或按依赖关系分波执行。
- 同一批次内混合串行组和并行组。
- 模型直接指定执行模式或并发数。
- 调用者注入自定义 Tool Execution Strategy。
- 自动重试工具。
- Worker Thread 或多进程执行。
- 工具超时策略。
- 插件清单或插件加载协议扩展。
- 跨 Run 恢复未完成工具。

## 核心不变量

以下约束不可破坏：

- 未配置新选项时，工具调用保持严格串行。
- 每个批次必须先完成全部预检，之后才能启动任何工具。
- `beforeToolCall` 必须按模型源顺序调用，不得并发。
- Tool Call ID 必须非空且在当前批次内唯一。
- 只有显式声明 `executionMode: "parallel"` 的工具才允许参加并行批次。
- 批次中只要存在一个未显式允许并行的 ready 工具，整个批次就必须串行。
- parallel 模式下同时执行的 ready 工具数不得超过 `maxToolConcurrency`。
- 所有 Tool Event 必须通过批次级串行 Dispatcher 发布，EventSink 和 Listener 不得被并发调用。
- `afterToolCall` 必须通过串行 Finalization Queue 调用，不得并发执行。
- `tool_execution_end` 描述真实完成顺序，可以与模型源顺序不同。
- Tool Result Message、`turn_end.toolResults` 和 `CompletedTurn.toolResults` 必须保持模型源顺序。
- 任何 Tool Result Message 都只能在整个批次成功结算后写入 Transcript。
- Event Dispatcher 可用时，每个成功发出的 `tool_execution_start` 最终必须对应一个 `tool_execution_end` 或 `tool_execution_cancelled`。
- abort 后不得启动尚未开始的工具。
- abort 后必须等待已经启动的工具 settle，不能留下继续修改外部状态的悬空任务。
- 普通工具失败对模型可见，但取消和控制面失败必须终止当前 Run。

## 设计决策

### 批次执行属于 Agent Loop 的下层能力

Agent Loop 负责 Turn 调度，不应同时承担参数预检、并发工作队列、顺序恢复和取消结算。

新增内部工具执行模块：

```text
AgentLoop
    ↓ executeToolCallBatch
ToolExecutionRuntime
    ├── prepareToolCalls
    ├── selectExecutionStrategy
    ├── SequentialToolExecution
    └── ParallelToolExecution
```

Loop 只收集当前 Assistant Message 中的 Tool Call，调用批次执行器，并提交已经按源顺序排列的 Tool Result Message。

### 公共配置保持最小

本阶段只公开串行、并行和最大并发数，不公开自定义 `ToolExecutionStrategy` 注入。

内部仍使用统一策略边界，以隔离调度实现。未来出现优先级、资源池或依赖图需求时，可以在不重写 Agent Loop 的前提下扩展或公开该边界。

### 整批降级而不是部分并行

当批次中存在强制串行工具时，整个批次按模型源顺序串行执行。

这会牺牲一部分并行机会，但避免引入隐式分组规则，也避免无法判断一个并行工具是否会影响后续串行工具。部分并行和工具依赖图留到后续阶段。

### 执行事件与 Transcript 不具有相同顺序

执行事件描述实时事实，Transcript 描述提交给下一次模型请求的稳定历史。

因此：

- start 事件按实际获得执行机会的时间发出。
- update 事件按工具真实上报顺序发出。
- end 事件按工具得到最终结果的时间发出。
- Tool Result Message 在批次结算后按模型源顺序发出并写入历史。

消费者不得通过 `tool_execution_end` 的顺序推断 Transcript 顺序。

### 并行工具不等于并行事件和 Hook

工具主体可以并发，但事件订阅者和全局 Hook 仍共享 Agent Runtime 状态。

因此本阶段采用：

```text
并行 Tool.execute
    ↓
串行 Finalization Queue
    ├── afterToolCall
    └── terminal event
    ↓
串行 Event Dispatcher
    ↓
Agent.processEvent / Server / Web / Listener
```

这保留了现有“一个事件处理完成后才处理下一个事件”的契约，也避免已有 `afterToolCall` Hook 因开启并行模式而突然被并发调用。

## 公共接口

在 `packages/core/src/types.ts` 增加：

```ts
export type ToolExecutionMode = "parallel" | "sequential";
```

扩展工具定义：

```ts
export interface Tool<TParameters> {
  name: string;
  description: string;
  executionMode?: ToolExecutionMode;
  validate(value: unknown): ValidationResult<TParameters>;
  execute(
    toolCallId: string,
    parameters: TParameters,
    signal: AbortSignal,
    onUpdate: ToolUpdate,
  ): Promise<ToolExecutionResult>;
}
```

`executionMode` 的语义：

- `"parallel"`：工具允许参加并行批次。
- `"sequential"`：包含该 ready 工具的整个批次必须串行。
- `undefined`：等价于 `"sequential"`。

这是保守兼容策略。已有工具只有在作者明确确认可以安全并行后，才增加：

```ts
executionMode: "parallel"
```

内置只读工具可以显式标记为 parallel；写入、删除或未知插件工具默认保持串行。

扩展 Agent Event：

```ts
export interface ToolExecutionCancelledEvent {
  type: "tool_execution_cancelled";
  toolCallId: string;
  toolName: string;
  reason: "aborted" | "control_error";
}
```

`tool_execution_cancelled` 是执行状态终止事件：

- 它会从 `pendingToolCalls` 移除对应 ID。
- 它不包含普通 Tool Result。
- 它不会创建 `ToolResultMessage`。
- 它不会写入 Transcript。

扩展 `AgentOptions`：

```ts
export interface AgentOptions {
  // existing fields...
  toolExecutionMode?: ToolExecutionMode;
  maxToolConcurrency?: number;
}
```

配置语义：

- `toolExecutionMode` 默认值为 `"sequential"`。
- `maxToolConcurrency` 默认值为 `4`。
- `maxToolConcurrency` 必须是正整数。
- 即使 Agent 使用 sequential 模式，也要在构造时校验显式传入的 `maxToolConcurrency`，避免同一配置在切换模式后才暴露错误。

`packages/core/src/index.ts` 必须导出 `ToolExecutionMode`。本阶段不导出内部策略、Prepared 类型或工作队列实现。

## 内部组件与所有权

`packages/core/src/tool-execution.ts` 内部定义：

```ts
interface ToolExecutionContext {
  agentContext: AgentContext;
  config: AgentLoopConfig;
  events: ToolEventDispatcher;
  finalization: ToolFinalizationQueue;
  signal: AbortSignal;
  maxConcurrency: number;
}

interface ToolExecutionBatch {
  messages: ToolResultMessage[];
}

interface ToolExecutionStrategy {
  execute(
    preparedCalls: readonly PreparedToolCall[],
    context: ToolExecutionContext,
  ): Promise<readonly CompletedToolCall[]>;
}

interface ToolEventDispatcher {
  emit(event: AgentEvent): Promise<void>;
}

interface ToolFinalizationQueue {
  finalize(
    prepared: PreparedToolCall,
    result: ToolExecutionResult,
  ): Promise<CompletedToolCall>;
}
```

内部准备结果使用判别联合：

```ts
type PreparedToolCall =
  | {
      kind: "ready";
      index: number;
      toolCall: ToolCall;
      tool: Tool<unknown>;
      parameters: unknown;
    }
  | {
      kind: "immediate";
      index: number;
      toolCall: ToolCall;
      result: ToolExecutionResult;
    };
```

内部完成结果至少包含：

```ts
interface CompletedToolCall {
  index: number;
  toolCall: ToolCall;
  result: ToolExecutionResult;
}
```

所有权规则：

- `prepareToolCalls` 拥有预检顺序。
- Strategy 拥有 ready 工具的并发调度和槽位。
- `ToolEventDispatcher` 拥有 start/update/end/cancelled 事件的全局串行分发。
- `ToolFinalizationQueue` 拥有串行 `afterToolCall` 和 terminal event。
- 批次执行器拥有完成结果排序与 Tool Result Message 构造。
- Agent Loop 拥有将 Tool Result Message 发布并写入 `AgentContext.messages` 的提交动作。
- Agent 继续通过事件归约维护 `pendingToolCalls`。

## 预检阶段

在调用任何 Tool Hook 前，先执行批次协议验证：

```text
Tool Call ID 非空
→ Tool Call ID 在当前批次内唯一
```

重复 ID 属于模型协议错误。批次立即失败，不调用 `beforeToolCall`、不执行任何工具，也不生成两个无法区分的 Tool Result。

每个批次必须严格按 Tool Call 在 Assistant Message 中的顺序执行：

```text
查找工具
→ 参数校验
→ beforeToolCall
→ 生成 PreparedToolCall
```

预检阶段不得调用任何工具的 `execute`，也不得发出 `tool_execution_start`。

结果分类：

| 场景 | Prepared 结果 | 是否调用 `execute` |
|---|---|---|
| 未知工具 | immediate error | 否 |
| 参数非法 | immediate error | 否 |
| `beforeToolCall` 阻止 | immediate error | 否 |
| 预检通过 | ready | 是 |

所有 Tool Call 都完成预检后，才允许选择执行策略并进入调度阶段。

`beforeToolCall` 自身抛出异常属于控制面失败。批次立即失败，因为此时尚未启动任何工具，所以不会产生部分外部副作用。

预检循环在每个调用前、每次 await `beforeToolCall` 后执行 `signal.throwIfAborted()`。Abort 后不继续查找、验证或调用剩余 Hook。

## 策略选择与整批降级

Agent 构造时将公共选项规范化为：

```ts
interface AgentLoopConfig {
  // existing fields...
  toolExecutionMode: ToolExecutionMode;
  maxToolConcurrency: number;
}
```

批次策略选择规则：

```text
Agent mode === sequential
    → SequentialToolExecution

Agent mode === parallel
    → 所有 prepared ready 调用都显式 executionMode === parallel ?
        ├── 是：ParallelToolExecution(maxConcurrency)
        └── 否：SequentialToolExecution
```

只有 ready 调用参与降级判断。未知工具、非法参数和被阻止调用不会改变批次策略。

空批次不调用任何策略，直接返回空结果。

## 串行执行

串行策略按模型源顺序处理全部 Prepared Tool Call：

1. 发出 `tool_execution_start`。
2. immediate 调用直接使用预检结果。
3. ready 调用执行工具，并转发其 update 事件。
4. 将结果交给 Finalization Queue。
5. Finalization Queue 调用 `afterToolCall`。
6. 发出使用最终结果的 `tool_execution_end`。
7. 记录 `CompletedToolCall`。
8. 前一个调用完全结束后才处理下一个调用。

串行模式下：

- start、end 和完成结果顺序都与模型源顺序一致。
- `maxToolConcurrency` 不改变运行行为。
- 未配置新选项的调用者保持当前核心版行为，但 start 事件从“预检前”调整为“预检完成并进入调度时”。

## 受限并行执行

并行策略使用内部工作队列，不引入第三方并发库。

调度器必须满足：

- 同时运行的 ready 调用数量不超过 `maxConcurrency`。
- ready 调用按模型源顺序竞争空闲槽位。
- immediate 调用不占用并发槽位。
- 每个调用只允许被启动一次。
- ready 调用的并发槽位从 start 保持到 Finalization 和 terminal event 完成。
- 当任一 ready 调用完成 terminal event 并释放槽位时，调度器可以启动下一个尚未开始的 ready 调用。
- 结果写入独立索引槽位，不依赖 Promise 返回顺序。

不得直接对任意长度批次使用无限制的 `Promise.all`。

一种满足要求的内部模型是：

```text
nextIndex = 0
activeReady = 0

while 仍有 prepared 调用:
  按源顺序处理 immediate
  ready 获得槽位后启动
  activeReady 达到上限时等待任一已启动任务 settle
  释放槽位后继续
```

具体实现可以使用固定数量 worker，也可以使用显式调度循环，但测试必须验证相同的不变量。

## 串行事件分发

并行 Tool 不得直接调用原始 `EventSink`。

`ToolEventDispatcher` 在内部维护一条 Promise Tail：

```text
emit(event A)
    ↓
等待之前的事件完成
    ↓
调用原始 EventSink(A)
    ↓
允许 event B 开始
```

它必须满足：

- 任意时刻最多一个 EventSink 调用处于活动状态。
- 事件按照进入 Dispatcher 的顺序分发。
- start、update、end、cancelled 都经过同一 Dispatcher。
- 第一个 EventSink 异常成为批次控制面失败。
- EventSink 异常不能被转换成普通 Tool Error。
- Dispatcher 失败后拒绝新的事件。Runtime 仍须结算已启动工具并清理内部状态，但不承诺外部观察者能收到 terminal event。

工具的 `onUpdate` 使用内部标记错误：

```ts
class ToolEventDispatchError extends Error {
  readonly cause: unknown;
}
```

如果 `onUpdate` 因事件分发失败而 reject，Tool Execute 外层必须重新抛出 `ToolEventDispatchError`，不能把它包装成 `isError: true` Tool Result。

## 串行 Finalization

ready Tool 主体可以并行完成，但所有结果按“进入 Finalization Queue 的顺序”逐个处理：

```text
Tool body settled
    ↓
等待 Finalization Queue
    ↓
afterToolCall
    ↓
tool_execution_end
    ↓
释放并发槽位
```

`afterToolCall` 因此不会并发执行。

如果多个 Tool 几乎同时完成，谁先进入 Finalization Queue 由实际 Promise settle 顺序决定。这里的 `tool_execution_end` 顺序表示“完成 after Hook 后的最终完成顺序”，不是原始 Tool Promise 单独 resolve 的顺序。

immediate 调用也通过 Finalization Queue，但不占用 ready Tool 并发槽位。它的 start 必须早于 end，且不会产生 update；两者之间允许出现其他并行 Tool 的事件，不要求相邻。

## 事件、结果与 Transcript 顺序

### start

`tool_execution_start` 表示调用已经完成预检并进入结果处理或真实执行阶段。

- ready 调用只有获得并发槽位时才发 start。
- immediate 调用在调度器处理到它时发 start。
- start 后必须最终出现对应 end 或 cancelled。

该语义让 `pendingToolCalls` 表示正在处理的调用，而不是尚未获得执行机会的整个批次。

### update

只有 ready 工具可以发 `tool_execution_update`。同一工具内部 update 顺序必须保持；不同工具之间的 update 可以交错。

### end

`afterToolCall` 返回替换结果后，才能发 `tool_execution_end`。事件中的 `result` 和 `isError` 必须与最终 Tool Result Message 一致。

并行模式下，end 按进入 Finalization Queue 后的最终完成顺序发出。

上述“一致”只适用于批次最终成功提交的调用。批次后来因其他调用取消或控制面失败而整体放弃时，已经发生的 end 仍描述真实执行事实，但不会单独产生 Transcript Tool Result。

### cancelled

已经发出 start、但尚未发出 end 的调用，在批次因 abort 或非 EventSink 控制面失败终止时必须发：

```text
tool_execution_cancelled
```

取消事件按模型源顺序处理剩余 started 调用，并通过串行 Event Dispatcher 发布。

如果失败源就是 EventSink，Dispatcher 已不可用，Runtime 只能完成工具结算和内部 pending 清理，不承诺 cancelled 能送达外部观察者。

取消事件只关闭执行状态，不表示工具副作用已经回滚。

### Transcript 提交

Strategy 返回全部 `CompletedToolCall` 后，批次执行器按 `index` 升序恢复模型源顺序并构造 Tool Result Message。

Agent Loop 随后按该顺序：

```text
message_start(toolResult)
→ message_end(toolResult)
→ context.messages.push(toolResult)
```

批次中的所有 Tool Result 必须连续提交，不允许 steering 或 follow-up 消息插入其中。

`ToolExecutionBatch.messages`、本 Turn 的 `toolResults`、`turn_end.toolResults` 和 `CompletedTurn.toolResults` 使用同一稳定顺序。

## 错误与取消

### 调用级失败

以下失败转换为 `isError: true` 的 Tool Result，并继续当前 Run：

- 未知工具。
- 参数校验失败。
- `beforeToolCall` 明确阻止调用。
- 工具 `execute` 抛出普通异常。

工具抛出的普通异常沿用当前规则：

```ts
error instanceof Error ? error.message : String(error)
```

调用级失败仍经过 `afterToolCall`，允许 Hook 统一补充 details、改写文案或调整错误状态。

### 控制面失败

以下失败不得伪装成 Tool Result：

- `beforeToolCall` 自身抛出异常。
- `afterToolCall` 自身抛出异常。
- 非法执行配置。
- 调度器内部不变量失败。

控制面失败终止当前 Run，由现有 Agent 失败路径生成错误 Assistant Message 和生命周期收尾事件。

EventSink 或 Listener 分发失败同样属于控制面失败，不能转换成 Tool Result。

如果并行执行期间发生控制面失败，调度器必须：

1. 记录第一个观察到的控制面错误作为主错误。
2. 停止启动新调用。
3. 等待已经启动的调用 settle。
4. 如果 Event Dispatcher 仍可用，为所有已 start 但未 end 的调用发布 `tool_execution_cancelled`。
5. 向上抛出主错误。

其他并发任务随后产生的错误可以作为诊断附加信息记录，但不得替换主错误，使同一次调度的失败原因保持稳定。

### 取消

所有预检 Hook、工具和策略共享当前 Run 的 `AbortSignal`。

收到 abort 后：

1. 不再启动尚未开始的 ready 调用。
2. 不再处理尚未进入 start 的 immediate 调用。
3. 已启动工具通过共享 Signal 协作式取消。
4. 调度器等待所有已启动 Promise settle。
5. 为所有已 start 但未 end 的调用发布 `tool_execution_cancelled`。
6. 批次抛出取消。
7. 本批次不构造或提交任何 Tool Result Message。

已完成调用可能已经发出 end 事件。这些事件描述取消前发生的实时事实，不代表结果已经提交到 Transcript。

取消和非 EventSink 控制面失败时，Reducer 通过 `tool_execution_cancelled` 清理尚未 end 的 pending 调用。Agent Run 的 `finally` 始终负责最终清理内部 pending 状态；当 EventSink 自身失败时，它也是唯一可保证执行的清理机制。

工具取消是协作式的。如果已启动工具忽略 `AbortSignal` 且 Promise 永不 settle，Run 会继续等待。本阶段不提供强制终止或工具超时；Tool Author 必须正确响应 Signal。

## Server、Web 与 Plugins 集成边界

### `packages/server`

状态快照 schema 不增加字段，现有 `pendingToolCalls: string[]` 已能表达多个并发调用。事件协议新增 `tool_execution_cancelled` 变体，由 Server 透传给 Web。

Server 必须验证：

- 状态序列化可同时包含多个 pending ID。
- end 和 cancelled 事件可以按任意顺序移除对应 ID。
- Run 结束后的最终状态中 pending 集合为空。

### `packages/web`

Reducer 数据结构不变。

必须增加交错事件测试：

```text
start A
start B
cancelled B
end A
```

每一步都只增删对应 ID，最终集合为空。Reducer 不得假设 FIFO 完成。

### `packages/plugins`

插件实现的 Tool 类型自然获得可选 `executionMode` 字段。

本阶段：

- 不修改插件 Manifest。
- 不修改插件加载协议。
- 不允许插件动态指定 Agent 级并发数。
- 未声明执行模式的插件工具按 sequential 处理。
- 插件必须显式声明 `executionMode: "parallel"` 才能参加并行批次。
- Plugin Tool Author 必须保证显式 parallel 工具在同一批次多次调用时也能安全并发。

## 文件改动

### `packages/core/src/types.ts`

- 增加 `ToolExecutionMode`。
- 扩展 `Tool`。
- 增加 `tool_execution_cancelled` Agent Event。
- 扩展 `AgentLoopConfig`。
- 保持内部 Prepared 和 Strategy 类型不公开。

### `packages/core/src/agent.ts`

- 扩展 `AgentOptions`。
- 校验并规范化 `toolExecutionMode` 和 `maxToolConcurrency`。
- 将规范化配置传给 Agent Loop。
- 在状态归约器中让 end 和 cancelled 都移除对应 `pendingToolCalls` ID。
- 不在 Agent 类中实现工作队列。

### `packages/core/src/tool-execution.ts`

- 实现错误 Tool Result 辅助函数。
- 实现顺序预检。
- 验证 Tool Call ID 非空且批次内唯一。
- 实现策略选择。
- 实现串行策略。
- 实现受限并行策略。
- 实现串行 Event Dispatcher。
- 实现串行 Finalization Queue。
- 实现执行事件、update 转发、cancelled 终止、取消结算和完成结果排序。
- 构造按源顺序排列的 Tool Result Message。

### `packages/core/src/agent-loop.ts`

- 移除单调用执行流水线。
- 将当前 Assistant Message 的 Tool Call 交给批次执行器。
- 按批次返回顺序发布并提交 Tool Result Message。
- 保持 Turn 调度、`finishTurn` 和下一 Turn 判断逻辑不变。

### `packages/core/src/index.ts`

- 导出 `ToolExecutionMode`。
- 不导出内部 Strategy 和 Prepared 类型。

### `packages/core/test`

- 新增 `tool-execution.test.ts`，覆盖调度器和批次语义。
- 扩展 `agent-loop.test.ts`，覆盖稳定提交和 Turn 集成。
- 扩展 `agent.test.ts`，覆盖公共配置、状态和取消收尾。

### `packages/server/test`

- 扩展协议或 Session 测试，覆盖多个 pending 工具、cancelled 事件和最终清理。

### `packages/web/test`

- 扩展 Reducer 测试，覆盖乱序 end/cancelled。

## 测试要求

所有并发测试必须使用 deferred Promise、显式 barrier 或可控 thenable，不得依赖真实延时和 `sleep` 判断顺序。

### 配置与兼容性

1. 未配置执行选项时，多个工具严格串行。
2. `toolExecutionMode: "sequential"` 忽略并行机会。
3. `toolExecutionMode: "parallel"` 启用受限并行。
4. `maxToolConcurrency` 默认值为 4。
5. `maxToolConcurrency` 为零、负数、非整数或非有限数时，Agent 构造失败。
6. `ToolExecutionMode` 可从 `@mini-agent/core` 导入。
7. 未声明 `executionMode` 的工具在 parallel Agent 中仍使整批串行。
8. 只有显式声明 parallel 的工具可以产生执行重叠。

### 预检

9. 空 Tool Call ID 在任何 Hook 或 Tool 启动前使批次失败。
10. 重复 Tool Call ID 在任何 Hook 或 Tool 启动前使批次失败。
11. 工具查找、参数校验和 `beforeToolCall` 按模型源顺序发生。
12. 全部预检完成前，没有工具开始执行。
13. 未知工具产生 immediate error，不调用任何 Tool。
14. 参数非法工具不调用 `execute`。
15. 被阻止工具不调用 `execute`。
16. `beforeToolCall` 抛错时没有工具启动，Run 明确失败。
17. Abort 后预检循环不再处理后续调用。

### 策略选择

18. parallel 模式且全部 ready 工具显式允许并行时选择并行策略。
19. 任一 ready 工具声明 sequential 时，整批降级为串行。
20. 任一 ready 工具未声明模式时，整批降级为串行。
21. immediate 调用不触发整批降级。
22. `maxToolConcurrency: 1` 的并行策略在执行重叠上等价于串行。

### 并发限制

23. 多个 ready 工具能在第一个工具完成前启动。
24. `maxToolConcurrency: 2` 时活动 ready 工具峰值严格为 2。
25. immediate 调用不消耗并发槽位。
26. ready 工具完成 Finalization 和 terminal event 后才释放槽位。
27. 槽位释放后，下一个 ready 工具按源顺序启动。
28. 每个 ready 工具最多启动一次。

### 事件与提交顺序

29. ready 调用只在获得槽位后发 start。
30. immediate 调用的 start 早于 end，且不产生 update。
31. immediate 的 start/end 之间允许出现其他 Tool Event。
32. 同一工具的 update 保持原顺序，不同工具的 update 允许交错。
33. EventSink 任意时刻最多有一个活动调用。
34. 慢 Listener 会对整个 Tool Event Dispatcher 形成背压。
35. `afterToolCall` 不会并发执行。
36. `afterToolCall` 完成后才发 end。
37. end 事件按 Finalization 最终完成顺序出现。
38. Event Dispatcher 可用时，每个 start 最终对应一个 end 或 cancelled。
39. Tool Result Message 按模型源顺序发布和写入历史。
40. `turn_end.toolResults` 按模型源顺序。
41. `CompletedTurn.toolResults` 按模型源顺序。
42. 成功提交批次的 end 结果与最终 Tool Result Message 内容一致。
43. 多个 Tool Result 连续提交，中间没有队列消息插入。

### 错误与取消

44. 工具普通异常转换为错误结果，并允许后续调用继续。
45. `afterToolCall` 可以替换成功或失败结果。
46. `afterToolCall` 抛错会停止启动新工具、等待已启动工具并终止 Run。
47. `onUpdate` 的 EventSink 错误属于控制面失败，不转换成 Tool Result。
48. 多个并发控制面错误发生时，第一个观察到的错误保持为主错误。
49. abort 后排队中的 ready 工具不再启动。
50. abort 后尚未处理的 immediate 调用不发 start。
51. abort 会等待所有已启动工具 settle。
52. abort 或非 EventSink 控制面失败为所有未终止 started 调用发 cancelled。
53. cancelled 不创建 Tool Result Message。
54. abort 批次不向 Transcript 提交部分 Tool Result。
55. 取消前已经发出的 end 事件不会被重复发送。
56. Run 收尾后 `pendingToolCalls` 为空。

### Server/Web 集成

57. Server 可序列化多个 pending Tool Call ID。
58. Web Reducer 在 start A/B、cancelled B、end A 后正确维护集合。
59. Server 能广播 `tool_execution_cancelled`。
60. Server 最终状态同步不包含取消或失败批次遗留的 pending ID。

### 回归

61. 现有 core、server 和 web 测试全部通过。
62. 单工具调用的成功、失败、阻止和取消行为保持兼容。
63. steering、follow-up、`finishTurn` 和上下文处理管线的顺序不变。

## 验收标准

- 默认配置下，工具执行与当前核心版一样严格串行。
- parallel 模式下，至少两个显式允许并行的工具存在可观测的执行重叠。
- 任意时刻活动 ready 工具数不超过配置上限。
- 包含 sequential 或未声明模式工具的批次不存在执行重叠。
- Tool Event 和 `afterToolCall` 始终串行，不会并发调用订阅者或 Hook。
- 无论工具以何种顺序完成，Transcript、`turn_end` 和 `CompletedTurn` 的 Tool Result 始终按模型源顺序排列。
- pending 状态只包含已经进入调度的调用，并能通过 end 或 cancelled 正确终止。
- abort 后没有新工具启动，所有已启动 Promise 已 settle；Event Dispatcher 可用时所有 started 调用都有 terminal event，且批次没有部分写入 Transcript。
- `packages/core`、`packages/server` 和 `packages/web` 的相关测试通过。
- `pnpm --filter @mini-agent/core run check` 通过。
- `pnpm --filter @mini-agent/core run test` 通过。
- Server 和 Web 的最小相关测试通过。

## 后续扩展边界

本阶段最终形成：

```text
Assistant Tool Calls
    ↓
批次 ID 验证 + 顺序预检
    ↓
串行或受限并行调度
    ↓
串行 Finalization + 串行 Event Dispatcher
    ↓
end/cancelled 终止状态
    ↓
模型源顺序 Transcript
```

后续如果引入工具依赖图，应在 Prepared Tool Call 之上增加显式依赖关系和分波调度，不得通过工具名称或参数内容猜测依赖。

后续如果公开自定义 Strategy，必须继续满足本设计中的预检顺序、并发上限、取消结算和稳定提交不变量。

工具自动重试不属于本执行策略。任何可能产生副作用的工具重试都必须先定义幂等性、提交边界和重复执行风险。
