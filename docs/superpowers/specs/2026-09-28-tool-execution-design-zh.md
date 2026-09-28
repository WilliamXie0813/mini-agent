# 并行与串行工具执行设计

日期：2026-09-28
来源：[阶段 2：并行与串行工具执行](../../extension/02-tool-execution.md)

## 目的

为 `packages/core` 增加确定、可取消、受并发上限约束的批次工具执行能力，使同一 Assistant Message 中互不依赖的工具调用可以并行执行，同时保持工具结果历史稳定，并保留默认串行行为。

本设计解决四个问题：

1. 将工具预检、执行调度和结果提交从 Agent Loop 中拆分。
2. 在工具完成顺序不确定时，保持 Transcript 中的 Tool Result 顺序确定。
3. 允许单个工具要求串行执行，避免有副作用的工具在同一批次中并发。
4. 在取消 Run 时停止启动新工具，并等待已经启动的工具结算。

## 范围

### 本阶段包含

- 将同一 Assistant Message 中的全部 Tool Call 作为一个执行批次。
- 顺序预检工具查找、参数校验和 `beforeToolCall`。
- 默认串行和显式启用的受限并行执行模式。
- 工具级 `executionMode: "sequential"` 约束。
- 整批串行降级。
- 可配置的最大并发数。
- 完成顺序事件和模型源顺序 Transcript。
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
- 批次中只要存在一个声明为 sequential 的 ready 工具，整个批次就必须串行。
- parallel 模式下同时执行的 ready 工具数不得超过 `maxToolConcurrency`。
- `tool_execution_end` 描述真实完成顺序，可以与模型源顺序不同。
- Tool Result Message、`turn_end.toolResults` 和 `CompletedTurn.toolResults` 必须保持模型源顺序。
- 任何 Tool Result Message 都只能在整个批次成功结算后写入 Transcript。
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
- `undefined`：等价于 `"parallel"`。

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
  emit: EventSink;
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
- Strategy 拥有 start/update/end 事件和 ready 工具的调度。
- 批次执行器拥有完成结果排序与 Tool Result Message 构造。
- Agent Loop 拥有将 Tool Result Message 发布并写入 `AgentContext.messages` 的提交动作。
- Agent 继续通过事件归约维护 `pendingToolCalls`。

## 预检阶段

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
    → prepared ready 调用中存在 executionMode === sequential ?
        ├── 是：SequentialToolExecution
        └── 否：ParallelToolExecution(maxConcurrency)
```

只有 ready 调用参与降级判断。未知工具、非法参数和被阻止调用不会因为同名工具声明而改变批次策略。

空批次不调用任何策略，直接返回空结果。

## 串行执行

串行策略按模型源顺序处理全部 Prepared Tool Call：

1. 发出 `tool_execution_start`。
2. immediate 调用直接使用预检结果。
3. ready 调用执行工具，并转发其 update 事件。
4. 对结果调用 `afterToolCall`。
5. 发出使用最终结果的 `tool_execution_end`。
6. 记录 `CompletedToolCall`。
7. 前一个调用完全结束后才处理下一个调用。

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
- 当任一运行任务完成时，调度器可以启动下一个尚未开始的 ready 调用。
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

## 事件、结果与 Transcript 顺序

### start

`tool_execution_start` 表示调用已经完成预检并进入结果处理或真实执行阶段。

- ready 调用只有获得并发槽位时才发 start。
- immediate 调用在调度器处理到它时发 start。
- start 后必须最终出现对应 end，除非 Run 因取消或控制面失败终止。

该语义让 `pendingToolCalls` 表示正在处理的调用，而不是尚未获得执行机会的整个批次。

### update

只有 ready 工具可以发 `tool_execution_update`。同一工具内部 update 顺序必须保持；不同工具之间的 update 可以交错。

### end

`afterToolCall` 返回替换结果后，才能发 `tool_execution_end`。事件中的 `result` 和 `isError` 必须与最终 Tool Result Message 一致。

并行模式下，end 按真实完成顺序发出。

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

如果并行执行期间发生控制面失败，调度器必须停止启动新调用并等待已经启动的调用 settle，然后再向上抛出原始失败。

### 取消

所有预检 Hook、工具和策略共享当前 Run 的 `AbortSignal`。

收到 abort 后：

1. 不再启动尚未开始的 ready 调用。
2. 不再处理尚未进入 start 的 immediate 调用。
3. 已启动工具通过共享 Signal 协作式取消。
4. 调度器等待所有已启动 Promise settle。
5. 批次抛出取消。
6. 本批次不构造或提交任何 Tool Result Message。

已完成调用可能已经发出 end 事件。这些事件描述取消前发生的实时事实，不代表结果已经提交到 Transcript。

取消和控制面失败时，尚未 end 的 pending 调用由 Run 收尾统一清理。Server 的最终状态同步必须展示空的 `pendingToolCalls`。

## Server、Web 与 Plugins 集成边界

### `packages/server`

Wire Protocol 不增加字段。现有 `pendingToolCalls: string[]` 已能表达多个并发调用。

Server 必须验证：

- 状态序列化可同时包含多个 pending ID。
- end 事件可以按任意顺序移除对应 ID。
- Run 结束后的最终状态中 pending 集合为空。

### `packages/web`

Reducer 数据结构不变。

必须增加交错事件测试：

```text
start A
start B
end B
end A
```

每一步都只增删对应 ID，最终集合为空。Reducer 不得假设 FIFO 完成。

### `packages/plugins`

插件实现的 Tool 类型自然获得可选 `executionMode` 字段。

本阶段：

- 不修改插件 Manifest。
- 不修改插件加载协议。
- 不允许插件动态指定 Agent 级并发数。
- 未声明执行模式的插件工具按 parallel-capable 处理，但 Agent 默认串行仍保证兼容。

## 文件改动

### `packages/core/src/types.ts`

- 增加 `ToolExecutionMode`。
- 扩展 `Tool`。
- 扩展 `AgentLoopConfig`。
- 保持内部 Prepared 和 Strategy 类型不公开。

### `packages/core/src/agent.ts`

- 扩展 `AgentOptions`。
- 校验并规范化 `toolExecutionMode` 和 `maxToolConcurrency`。
- 将规范化配置传给 Agent Loop。
- 不在 Agent 类中实现工作队列。

### `packages/core/src/tool-execution.ts`

- 实现错误 Tool Result 辅助函数。
- 实现顺序预检。
- 实现策略选择。
- 实现串行策略。
- 实现受限并行策略。
- 实现执行事件、update 转发、取消结算和完成结果排序。
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

- 扩展协议或 Session 测试，覆盖多个 pending 工具和最终清理。

### `packages/web/test`

- 扩展 Reducer 测试，覆盖乱序 end。

## 测试要求

所有并发测试必须使用 deferred Promise、显式 barrier 或可控 thenable，不得依赖真实延时和 `sleep` 判断顺序。

### 配置与兼容性

1. 未配置执行选项时，多个工具严格串行。
2. `toolExecutionMode: "sequential"` 忽略并行机会。
3. `toolExecutionMode: "parallel"` 启用受限并行。
4. `maxToolConcurrency` 默认值为 4。
5. `maxToolConcurrency` 为零、负数、非整数或非有限数时，Agent 构造失败。
6. `ToolExecutionMode` 可从 `@mini-agent/core` 导入。

### 预检

7. 工具查找、参数校验和 `beforeToolCall` 按模型源顺序发生。
8. 全部预检完成前，没有工具开始执行。
9. 未知工具产生 immediate error，不调用任何 Tool。
10. 参数非法工具不调用 `execute`。
11. 被阻止工具不调用 `execute`。
12. `beforeToolCall` 抛错时没有工具启动，Run 明确失败。

### 策略选择

13. parallel 模式且全部 ready 工具允许并行时选择并行策略。
14. 任一 ready 工具声明 sequential 时，整批降级为串行。
15. immediate 调用不触发整批降级。
16. `maxToolConcurrency: 1` 的并行策略在执行重叠上等价于串行。

### 并发限制

17. 多个 ready 工具能在第一个工具完成前启动。
18. `maxToolConcurrency: 2` 时活动 ready 工具峰值严格为 2。
19. immediate 调用不消耗并发槽位。
20. 槽位释放后，下一个 ready 工具按源顺序启动。
21. 每个 ready 工具最多启动一次。

### 事件与提交顺序

22. ready 调用只在获得槽位后发 start。
23. immediate 调用产生相邻的 start/end。
24. 同一工具的 update 保持原顺序，不同工具的 update 允许交错。
25. `afterToolCall` 完成后才发 end。
26. end 事件按真实最终完成顺序出现。
27. Tool Result Message 按模型源顺序发布和写入历史。
28. `turn_end.toolResults` 按模型源顺序。
29. `CompletedTurn.toolResults` 按模型源顺序。
30. end 事件结果与最终 Tool Result Message 内容一致。
31. 多个 Tool Result 连续提交，中间没有队列消息插入。

### 错误与取消

32. 工具普通异常转换为错误结果，并允许后续调用继续。
33. `afterToolCall` 可以替换成功或失败结果。
34. `afterToolCall` 抛错会停止启动新工具、等待已启动工具并终止 Run。
35. abort 后排队中的 ready 工具不再启动。
36. abort 后尚未处理的 immediate 调用不发 start。
37. abort 会等待所有已启动工具 settle。
38. abort 批次不向 Transcript 提交部分 Tool Result。
39. 取消前已经发出的 end 事件不会被重复发送。
40. Run 收尾后 `pendingToolCalls` 为空。

### Server/Web 集成

41. Server 可序列化多个 pending Tool Call ID。
42. Web Reducer 在 start A/B、end B/A 后正确维护集合。
43. Server 最终状态同步清除取消或失败批次遗留的 pending ID。

### 回归

44. 现有 core、server 和 web 测试全部通过。
45. 单工具调用的成功、失败、阻止和取消行为保持兼容。
46. steering、follow-up、`finishTurn` 和上下文处理管线的顺序不变。

## 验收标准

- 默认配置下，工具执行与当前核心版一样严格串行。
- parallel 模式下，至少两个允许并行的工具存在可观测的执行重叠。
- 任意时刻活动 ready 工具数不超过配置上限。
- 包含 sequential 工具的批次不存在执行重叠。
- 无论工具以何种顺序完成，Transcript、`turn_end` 和 `CompletedTurn` 的 Tool Result 始终按模型源顺序排列。
- pending 状态只包含已经进入调度的调用，并能正确处理乱序完成。
- abort 后没有新工具启动，所有已启动 Promise 已 settle，且批次没有部分写入 Transcript。
- `packages/core`、`packages/server` 和 `packages/web` 的相关测试通过。
- `pnpm --filter @mini-agent/core run check` 通过。
- `pnpm --filter @mini-agent/core run test` 通过。
- Server 和 Web 的最小相关测试通过。

## 后续扩展边界

本阶段最终形成：

```text
Assistant Tool Calls
    ↓
顺序预检
    ↓
串行或受限并行调度
    ↓
真实完成顺序事件
    ↓
模型源顺序 Transcript
```

后续如果引入工具依赖图，应在 Prepared Tool Call 之上增加显式依赖关系和分波调度，不得通过工具名称或参数内容猜测依赖。

后续如果公开自定义 Strategy，必须继续满足本设计中的预检顺序、并发上限、取消结算和稳定提交不变量。

工具自动重试不属于本执行策略。任何可能产生副作用的工具重试都必须先定义幂等性、提交边界和重复执行风险。
