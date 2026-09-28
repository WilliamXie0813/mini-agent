# 上下文处理管线设计

日期：2026-09-28  
来源：[阶段 1：上下文处理管线](../../extension/01-context-pipeline.md)

## 目的

为 `packages/core` 增加可替换、可测试的上下文处理管线，明确每次模型请求使用哪些消息，同时保留完整、可观察的 Agent transcript。

本设计解决三个问题：

1. 在 Turn 边界和模型请求前同步或重建工作上下文。
2. 在不修改原始历史的前提下转换模型输入。
3. 当输入超过预算时，通过独立摘要请求压缩旧历史。

## 范围

### 本阶段包含

- `prepareNextTurn`、`prepareRequest`、`transformContext` 三个生命周期 Hook。
- 只作用于模型输入的上下文转换。
- 教学型 Token 估算器。
- 基于独立摘要请求的上下文压缩器。
- 最近完整 Turn 保留策略。
- 当前 Run 内的增量摘要缓存。
- Mock 摘要器及完整的 core 单元测试。

### 本阶段不包含

- 真实 LLM Provider 或真实摘要模型接入。
- Session 持久化和跨 Run 摘要复用。
- Server/Web 协议或界面变化。
- 动态模型、动态工具和插件上下文权限。
- Provider 精确 Tokenizer。
- 多轮递归摘要。

## 核心不变量

系统中必须始终区分三份消息：

| 数据 | 所有者 | 用途 | 是否允许压缩 |
|---|---|---|---|
| `Agent.state.messages` | `Agent` | 完整、可观察的原始 transcript | 否 |
| `AgentContext.messages` | 当前 Run | Loop 使用的工作副本 | Hook 可替换 |
| `requestMessages` | 单次模型请求 | 实际传给 `StreamFn` 的临时输入 | 是 |

以下约束不可破坏：

- `transformContext` 的结果不写回 `AgentContext` 或 `Agent.state`。
- 摘要消息不进入事件流，不触发 `message_start` 或 `message_end`。
- Hook 只能替换消息，不能替换工具。
- `StreamFn` 返回的 Assistant 消息仍写入工作上下文，并通过现有事件归约进入原始 transcript。
- 未配置 Hook 时，现有行为和事件顺序保持不变。

## 公共接口

在 `packages/core/src/types.ts` 增加以下类型：

```ts
export interface ContextPreparation {
  messages?: AgentMessage[];
}

export type PrepareRequest = (
  context: AgentContext,
  signal: AbortSignal,
) => Promise<ContextPreparation | undefined>;

export type PrepareNextTurn = (
  turn: CompletedTurn,
  signal: AbortSignal,
) => Promise<ContextPreparation | undefined>;

export type TransformContext = (
  messages: readonly AgentMessage[],
  signal: AbortSignal,
) => Promise<AgentMessage[]>;

export interface TokenEstimator {
  estimate(messages: readonly AgentMessage[]): number;
}

export interface ContextSummaryRequest {
  previousSummary?: string;
  messages: readonly AgentMessage[];
  maxSummaryTokens: number;
}

export type SummarizeContext = (
  request: ContextSummaryRequest,
  signal: AbortSignal,
) => Promise<string>;

export interface CompactingTransformOptions {
  maxInputTokens: number;
  maxSummaryTokens: number;
  preserveRecentTurns: number;
  summarize: SummarizeContext;
  estimator?: TokenEstimator;
}
```

`AgentLoopConfig` 和 `AgentOptions` 增加：

```ts
prepareNextTurn?: PrepareNextTurn;
prepareRequest?: PrepareRequest;
transformContext?: TransformContext;
```

Hook 输入中的 `AgentContext` 是浅复制快照。Hook 不应依赖原地修改输入；只有显式返回的 `messages` 才会替换当前 Run 的工作消息。Loop 应再次复制返回数组，避免调用方后续通过数组引用修改上下文。

`packages/core/src/context.ts` 导出：

```ts
export function createHeuristicTokenEstimator(): TokenEstimator;

export function createCompactingTransform(
  options: CompactingTransformOptions,
): TransformContext;
```

`packages/core/src/index.ts` 公开导出新增类型和工厂。

## 生命周期与调用顺序

### 第一个 Turn

第一个 Turn 没有已完成的前序 Turn，因此不得调用 `prepareNextTurn`：

```text
agent_start
turn_start
追加并发布初始 prompt
prepareRequest
transformContext
stream
执行工具
finishTurn
turn_end
```

### 后续 Turn

只有调度器已经确认需要下一 Turn 时，才调用 `prepareNextTurn`。确认依据沿用现有优先级：

1. 工具结果需要反馈给模型。
2. steering 队列有消息。
3. 当前任务自然结束后存在 follow-up。
4. `finishTurn` 返回 `continue`。

后续 Turn 的顺序为：

```text
上一 Turn 的 finishTurn
上一 Turn 的 turn_end
调度器确认需要下一 Turn
prepareNextTurn
再次读取 steering 队列
turn_start
发布并追加本 Turn 的 steering/follow-up 消息
prepareRequest
transformContext
stream
```

`prepareNextTurn` 位于 `turn_start` 之前，因此准备耗时不属于下一 Turn。Hook 执行期间新进入 steering 队列的消息，必须在 Hook 返回后再次读取，并投递到紧接着的 Turn。

`prepareNextTurn` 返回的消息替换工作上下文后，再追加本 Turn 已排队的用户消息。这样 Hook 不会意外覆盖在其执行期间到达的 steering。

### 请求前处理

每次调用模型前都按以下顺序执行：

1. 用当前工作上下文的快照调用 `prepareRequest`。
2. 若 Hook 返回 `messages`，复制后替换 `AgentContext.messages`。
3. 用只读消息视图调用 `transformContext`。
4. 将 transform 返回数组的副本作为 `requestMessages`。
5. 调用 `config.stream(requestMessages, signal)`。
6. 将最终 Assistant 消息追加到 `AgentContext.messages`，而不是 `requestMessages`。

如果未配置 `transformContext`，使用 `context.messages.slice()` 作为请求输入。

## Turn 分组

压缩器以模型交互为边界识别 Turn。一个完整 Turn 包含：

1. 位于 Assistant 消息之前、尚未归属其他 Turn 的 user/steering/follow-up 消息。
2. 一条 Assistant 消息。
3. 紧随该 Assistant 消息、由其工具调用产生的 Tool Result 消息。

特殊情况：

- 没有前置用户消息的 Assistant Turn 仍是完整 Turn，例如工具结果后的最终回答。
- transcript 尾部尚未得到 Assistant 响应的输入视为未完成 Turn，必须保留。
- 所有原始 System Message 独立于 Turn 分组，始终保留并维持原顺序。
- `preserveRecentTurns` 必须是非负整数。

压缩时，最近 `preserveRecentTurns` 个完整 Turn 和所有未完成尾部消息原样保留。更早的非 System 消息构成“旧区”，交给摘要器处理。

## Token 估算

`createHeuristicTokenEstimator()` 使用确定性规则，仅用于触发压缩和验证压缩结果：

- 每条消息增加固定 4 Token 开销。
- 中日韩统一表意文字、平假名、片假名和韩文字符按每字符 1 Token。
- 普通用户文本和 Assistant 文本中的其他字符按每 4 个字符 1 Token，向上取整。
- Tool Call 的名称和序列化参数按每 3 个字符 1 Token，向上取整。
- Tool Result 的名称、正文和可序列化 `details` 按每 3 个字符 1 Token，向上取整。
- 时间戳、`stopReason` 和 `isError` 等控制字段不计入正文 Token。

估算器不得用于计费，也不承诺与任何 Provider 的 Tokenizer 一致。无法序列化的工具数据必须抛出明确错误，不能按零 Token 处理。

## 摘要压缩

### 触发条件

`createCompactingTransform()` 首先估算完整请求：

- `estimate <= maxInputTokens`：返回消息数组浅拷贝，不调用摘要器。
- `estimate > maxInputTokens`：执行 Turn 分组和摘要。

`maxInputTokens`、`maxSummaryTokens` 必须是正整数；非法配置在创建 transform 时立即抛错。

### 摘要请求

首次压缩时，摘要器收到全部旧区：

```ts
{
  messages: oldMessages,
  maxSummaryTokens
}
```

摘要器只返回摘要正文。压缩器负责将正文包装成临时 System Message：

```text
[Runtime context summary]
<summary>
```

摘要消息插入到全部原始 System Message 之后、最近保留 Turn 之前。其 `timestamp` 使用旧区最后一条消息的时间戳，使 Mock 测试输出稳定。

摘要器返回空字符串或纯空白时视为失败。

### Run 内增量缓存

压缩器使用传入的 `AbortSignal` 作为当前 Run 的缓存键。`AbortSignal` 生命周期与一次 `Agent.run()` 一致，因此不需要公开 `runId` 或增加清理 Hook；缓存使用 `WeakMap`，Run 结束后可以被垃圾回收。

每份缓存记录：

- 上次已摘要的旧区消息引用序列。
- 上次摘要正文。

下一次压缩时：

- 旧区与缓存完全相同：直接复用摘要，不发请求。
- 缓存旧区是当前旧区的引用相等前缀：调用摘要器，传入 `previousSummary` 和新增旧区消息。
- 前缀不匹配：认为 Hook 重建了上下文，丢弃缓存并对当前旧区做完整摘要。

增量请求不会把全部旧历史再次发送给摘要模型。

### 压缩后验证

压缩器组装最终请求后必须再次估算：

- 不超过 `maxInputTokens`：返回请求消息。
- 仍然超过上限：抛出明确错误。

第一版不递归摘要、不裁剪最近 Turn，也不回退到原始历史。如果没有可摘要旧区但完整输入已经超限，同样失败。

## 状态和事件语义

Hook 返回的工作消息、临时摘要和 `requestMessages` 都不进入 Agent 事件流。UI 和 Server 继续只观察真实输入、Assistant 输出和 Tool Result。

`CompletedTurn.context` 应保存 Turn 完成时的浅复制快照，避免后续 Hook 替换工作消息后改变已经交给 `finishTurn` 或 `prepareNextTurn` 的历史视图。

如果 `prepareNextTurn` 在下一次 `turn_start` 前失败，Agent 必须先补发一次 `turn_start`，再生成现有格式的失败 Assistant 消息和 `turn_end`。这样所有 `turn_end` 都有对应的 `turn_start`。

## 错误与取消

- 所有 Hook、摘要器和模型流使用同一个 Run `AbortSignal`。
- Hook 或摘要器应在开始耗时工作前检查中止状态。
- 中止产生 `stopReason: "aborted"` 的 Assistant 消息。
- 其他异常产生 `stopReason: "error"` 的 Assistant 消息，`errorMessage` 保留原始错误文案。
- 摘要失败不回退到未压缩历史。
- Transform 不得吞掉 Token 估算、序列化或摘要错误。
- 如果失败发生在活动 Turn 内，沿用现有失败事件序列。
- 如果失败发生在 `prepareNextTurn`，先建立合成失败 Turn，再发失败事件，保持生命周期事件配对。

## 文件改动

### `packages/core/src/types.ts`

- 增加上下文准备、转换、估算和摘要公共类型。
- 扩展 `AgentLoopConfig`。

### `packages/core/src/context.ts`

- 实现启发式 Token 估算器。
- 实现 Turn 分组。
- 实现压缩 Transform、摘要包装、结果验证和 Run 内增量缓存。

Turn 分组可以保持为模块内部函数，除非测试证明公开它能显著简化行为验证。

### `packages/core/src/agent-loop.ts`

- 在精确生命周期点调用三个 Hook。
- 使用临时 `requestMessages` 调用模型。
- 保持原始工作上下文和请求上下文分离。
- 在 `prepareNextTurn` 后再次读取 steering。
- 为 `CompletedTurn` 创建稳定快照。

### `packages/core/src/agent.ts`

- `AgentOptions` 接收三个 Hook。
- 保存并传递 Hook 到 `AgentLoopConfig`。
- 跟踪 Turn 是否已开始，保证准备阶段失败时事件配对。

### `packages/core/src/index.ts`

- 导出上下文工厂和新增公共类型。

### `packages/core/test`

- 新增 `context.test.ts`。
- 扩展 `agent-loop.test.ts` 和 `agent.test.ts`。
- Mock 摘要器直接写在测试中或作为测试辅助函数，不增加生产 Provider。

## 测试要求

### Hook 时序

1. 首 Turn 顺序严格为 `prepareRequest → transformContext → stream`。
2. 后续 Turn 顺序严格为 `prepareNextTurn → prepareRequest → transformContext → stream`。
3. 第一个 Turn 不调用 `prepareNextTurn`。
4. 不存在下一 Turn 时不调用 `prepareNextTurn`。
5. `prepareNextTurn` 期间入队的 steering 在紧接着的 Turn 可见。

### 所有权

6. `transformContext` 删除旧消息后，`Agent.state.messages` 仍保留完整历史。
7. `prepareRequest` 替换工作消息不会直接改写 Agent transcript。
8. Hook 返回数组在调用后被外部修改时，不影响 Loop 工作上下文。
9. 摘要 System Message 不产生消息生命周期事件。
10. `CompletedTurn.context` 不随后续 Turn 变化。

### 压缩

11. 未超过阈值时不调用摘要器。
12. 超过阈值时触发摘要。
13. 全部原始 System Message、最近完整 Turn 和未完成尾部消息始终保留。
14. 摘要位于原始 System Message 和最近 Turn 之间。
15. 同一旧区在同一 Run 内复用缓存。
16. 旧区向后扩展时只发送新增消息和上次摘要。
17. 消息前缀变化时执行完整重摘要。
18. 不同 Run 不共享摘要缓存。

### 错误与取消

19. 三个 Hook 和摘要器都能响应中止。
20. Hook 或摘要器抛错会产生明确的 error Assistant Message。
21. 空摘要导致 Run 失败。
22. 没有可压缩旧区时超限会失败。
23. 摘要后仍超限会失败。
24. `turn_start` 与 `turn_end` 在准备阶段失败时仍然配对。

### 回归

25. 现有 core 测试全部通过。
26. 未配置新 Hook 时，现有模型输入、队列优先级和事件顺序不变。
27. 新增接口和工厂可从 `@mini-agent/core` 公共入口导入。

## 验收标准

- Mock Stream 能记录每次实际收到的 `requestMessages`，并证明它与原始 transcript 相互独立。
- 超预算历史通过独立 Mock 摘要请求缩短，摘要器能接收上次摘要和新增旧消息。
- `Agent.state.messages` 在任意压缩后仍包含完整原始对话。
- 所有新旧 core 测试通过。
- `pnpm --filter @mini-agent/core run check` 通过。
- `pnpm --filter @mini-agent/core run test` 通过。
- Server 和 Web 无需修改即可继续构建和运行。
