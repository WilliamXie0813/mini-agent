# 上下文处理管线设计

日期：2026-09-28  
来源：[阶段 1：上下文处理管线](../../extension/01-context-pipeline.md)

## 目的

为 `packages/core` 增加可替换、可测试的上下文处理管线，明确每次模型请求使用哪些消息，同时保留完整、可观察的 Agent transcript。

本设计解决三个问题：

1. 在 Turn 边界和模型请求前同步或重建工作上下文。
2. 在不修改原始历史的前提下转换模型输入。
3. 当输入超过教学预算时，使用确定性策略压缩较早历史。

## 范围

### 本阶段包含

- `prepareNextTurn`、`prepareRequest`、`transformContext` 三个生命周期 Hook。
- 只作用于模型输入的上下文转换。
- 教学型 Token 估算器。
- 确定性上下文压缩器。
- 最近完整 Turn 保留策略。
- 下一 Turn 的非破坏性队列检查。
- 完整的 core 单元测试。

### 本阶段不包含

- 真实 LLM Provider。
- 使用模型生成摘要。
- 摘要缓存、增量摘要和递归摘要。
- Context Overflow 自动恢复。
- Compaction Entry 和 Session 持久化。
- 跨 Run 压缩结果复用。
- Server/Web 协议或界面变化。
- 动态模型、动态工具和插件上下文权限。
- Provider 精确 Tokenizer。

使用模型生成结构化摘要、保留 `retainedTail`、持久化 Compaction Entry 和 Overflow Recovery 属于[阶段 10：自动上下文压缩](../../extension/10-auto-compaction.md)。

## 核心不变量

系统中必须始终区分三份消息：

| 数据 | 所有者 | 用途 | 是否允许压缩 |
|---|---|---|---|
| `Agent.state.messages` | `Agent` | 完整、可观察的原始 transcript | 否 |
| `AgentContext.messages` | 当前 Run | Loop 使用的工作副本 | Hook 可替换 |
| `requestMessages` | 单次模型请求 | 实际传给 `StreamFn` 的临时输入 | 是 |

以下约束不可破坏：

- `transformContext` 的结果不写回 `AgentContext` 或 `Agent.state`。
- 确定性压缩消息不进入事件流，不触发 `message_start` 或 `message_end`。
- Hook 只能替换消息，不能替换工具。
- `StreamFn` 返回的 Assistant 消息仍写入工作上下文，并通过现有事件归约进入原始 transcript。
- 未配置 Hook 时，现有行为、队列优先级和事件顺序保持不变。
- Agent Message 在一次 Run 中按不可变值使用；需要修改时必须创建新消息对象。

## 公共接口

在 `packages/core/src/types.ts` 增加：

```ts
export interface AgentContextSnapshot {
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly Tool<unknown>[];
}

export interface ContextPreparation {
  messages?: readonly AgentMessage[];
}

export type PrepareRequest = (
  context: AgentContextSnapshot,
  signal: AbortSignal,
) => Promise<ContextPreparation | undefined>;

export type PrepareNextTurn = (
  turn: CompletedTurn,
  signal: AbortSignal,
) => Promise<ContextPreparation | undefined>;

export type TransformContext = (
  messages: readonly AgentMessage[],
  signal: AbortSignal,
) => Promise<readonly AgentMessage[]>;

export interface TokenEstimator {
  estimate(messages: readonly AgentMessage[]): number;
}

export interface DeterministicCompactingTransformOptions {
  maxInputTokens: number;
  preserveRecentTurns: number;
  maxExcerptCharacters?: number;
  estimator?: TokenEstimator;
}
```

`CompletedTurn.context` 改为只读快照：

```ts
export interface CompletedTurn {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  context: AgentContextSnapshot;
}
```

`AgentLoopConfig` 和 `AgentOptions` 增加：

```ts
prepareNextTurn?: PrepareNextTurn;
prepareRequest?: PrepareRequest;
transformContext?: TransformContext;
```

为避免用破坏性 `drain` 判断是否存在下一 Turn，`AgentLoopConfig` 还增加：

```ts
hasSteeringMessages(): boolean;
hasFollowUpMessages(): boolean;
```

现有方法继续负责真正消费消息：

```ts
getSteeringMessages(): AgentMessage[];
getFollowUpMessages(): AgentMessage[];
```

`packages/core/src/context.ts` 导出：

```ts
export function createHeuristicTokenEstimator(): TokenEstimator;

export function createDeterministicCompactingTransform(
  options: DeterministicCompactingTransformOptions,
): TransformContext;
```

`packages/core/src/index.ts` 公开导出新增类型和工厂。

## 快照和所有权

传给 Hook 的 `AgentContextSnapshot` 必须由 Loop 创建：

```ts
function snapshotContext(context: AgentContext): AgentContextSnapshot {
  return {
    messages: context.messages.slice(),
    tools: context.tools.slice(),
  };
}
```

Hook 不应原地修改消息、数组或工具。

当 Hook 返回 `messages` 时，Loop 必须再次复制：

```ts
context.messages = preparation.messages.slice();
```

这样 Hook 在返回后修改自己的数组，不会改变当前 Run。

`CompletedTurn.context` 使用 Turn 完成时的独立数组快照，后续 Turn 对工作上下文的 `push` 或整体替换都不会改变已经交给 `finishTurn` 和 `prepareNextTurn` 的视图。

## 生命周期与调用顺序

### 第一个 Turn

第一个 Turn 没有已完成的前序 Turn，因此不得调用 `prepareNextTurn`：

```text
agent_start
turn_start
追加并发布初始 prompt
读取、发布并追加 Run 启动前已排队的 steering
prepareRequest
transformContext
stream
执行工具
finishTurn
turn_end
```

首 Turn 只消费启动前已经存在的 steering，不消费 follow-up。首 Turn 开始后新进入队列的 steering 仍在下一个安全 Turn 边界消费。

### 后续 Turn

调度器必须先通过非破坏性检查确认存在下一 Turn。确认依据沿用当前优先级：

1. 工具结果需要反馈给模型。
2. steering 队列非空。
3. 当前任务自然结束后 follow-up 队列非空。
4. `finishTurn` 返回 `continue`。

确认后，下一 Turn 的顺序是：

```text
调度器确认存在下一 Turn
turn_start
prepareNextTurn
读取 steering 队列
必要时读取 follow-up 队列
发布并追加本 Turn 的用户消息
prepareRequest
transformContext
stream
```

`turn_start` 由 Agent Loop 发出，`Agent` 不额外跟踪或推测 Turn 是否已经开始。

这样如果 `prepareNextTurn` 失败，现有 `Agent.emitFailure()` 可以自然生成：

```text
message_start(error)
message_end(error)
turn_end(error)
agent_end
```

且 `turn_end` 已有对应的 `turn_start`。

准备耗时属于即将执行的下一 Turn。这比在 Agent 层补发合成事件更容易保持生命周期单一所有权。

## 下一 Turn 队列规则

### 非破坏性确认

调度器不得调用 `getSteeringMessages()` 或 `getFollowUpMessages()` 来判断下一 Turn 是否存在。

只能使用：

```text
hasSteeringMessages()
hasFollowUpMessages()
```

真正进入新 Turn 后才消费队列。

### Hook 期间到达 steering

`turn_start` 后执行 `prepareNextTurn`。Hook 返回后再 drain steering，因此 Hook 执行期间到达的 steering 会进入紧接着的 Turn。

### steering 与 follow-up 优先级

进入下一 Turn 后：

1. 先 drain steering。
2. 如果存在 steering，本 Turn 不消费 follow-up。
3. 只有任务已经自然结束、没有 steering、没有工具结果需要反馈时，才 drain follow-up。

因此下面的场景不会丢消息：

```text
发现 follow-up 等待处理
→ 开始下一 Turn
→ prepareNextTurn 期间收到 steering
→ 本 Turn 消费 steering
→ follow-up 仍留在队列
→ 任务再次自然结束后再消费 follow-up
```

工具结果和 `finishTurn: continue` 只决定是否需要下一 Turn，不会提前消费任何队列消息。

## 请求前处理

每次调用模型前按以下顺序执行：

1. 创建当前工作上下文的只读快照。
2. 调用 `prepareRequest`。
3. 若 Hook 返回 `messages`，复制后替换 `AgentContext.messages`。
4. 用只读消息数组调用 `transformContext`。
5. 复制 Transform 返回数组，得到 `requestMessages`。
6. 调用 `config.stream(requestMessages, signal)`。
7. 将最终 Assistant 消息追加到 `AgentContext.messages`，而不是 `requestMessages`。

如果未配置 `transformContext`：

```ts
const requestMessages = context.messages.slice();
```

## Turn 分组

确定性压缩器以模型交互为边界识别 Turn。

一个完整 Turn 包含：

1. 位于 Assistant 消息之前、尚未归属其他 Turn 的 User Message。
2. 一条 Assistant Message。
3. 紧随该 Assistant Message、由其 Tool Call 产生的 Tool Result Message。

特殊情况：

- 没有前置 User Message 的 Assistant Turn 仍是完整 Turn，例如工具结果后的最终回答。
- transcript 尾部尚未得到 Assistant 响应的输入视为未完成 Turn，必须保留。
- `preserveRecentTurns` 必须是非负整数。

System Message 不参与 Turn 计数，也永远不会被压缩。

System Message 必须保留在原始位置，不能为了插入压缩消息而移动。可压缩旧消息如果被 System Message 分隔，必须拆成多个连续分段分别压缩，摘要不能跨越 System Message 聚合前后信息。

## Token 估算

`createHeuristicTokenEstimator()` 使用确定性规则，仅用于触发压缩和验证压缩结果：

- 每条消息增加固定 4 Token 开销。
- 中日韩统一表意文字、平假名、片假名和韩文字符按每字符 1 Token。
- 普通 User 文本和 Assistant 文本中的其他字符按每 4 个字符 1 Token，向上取整。
- Tool Call 的名称和可序列化参数按每 3 个字符 1 Token，向上取整。
- Tool Result 的名称、正文和可序列化 `details` 按每 3 个字符 1 Token，向上取整。
- 时间戳、`stopReason` 和 `isError` 等控制字段不计入正文 Token。

Tool Call 参数或 Tool Result Details 无法序列化时必须抛出明确错误，不能按零 Token 处理。

为确保行为稳定，序列化器必须：

- 对对象键排序。
- 明确拒绝循环引用和 `bigint`。
- 将顶层 `undefined` 计为固定占位文本，而不是静默忽略。

估算器不得用于计费，也不承诺与任何 Provider Tokenizer 一致。

## 确定性压缩

### 触发条件

`createDeterministicCompactingTransform()` 首先估算完整请求：

- `estimate <= maxInputTokens`：返回消息数组浅拷贝。
- `estimate > maxInputTokens`：执行 Turn 分组和确定性压缩。

创建 Transform 时立即验证：

- `maxInputTokens` 是正整数。
- `preserveRecentTurns` 是非负整数。
- `maxExcerptCharacters` 是正整数；默认值为 120。

### 保留区域

始终原样保留：

- 所有 System Message，并保持原始位置。
- 最近 `preserveRecentTurns` 个完整 Turn。
- transcript 尾部所有未完成消息。

更早的非 System Message 构成旧区。旧区按原始位置切分为连续分段；System Message 或任何需要原样保留的消息都会结束当前分段。

如果没有可压缩旧区但完整输入已超限，Transform 必须失败。

### 确定性摘要格式

本阶段不调用模型生成摘要。压缩器为旧区的每个连续分段分别提取确定信息：

```text
[Earlier context compacted]
Messages: 8
Users: 2
Assistants: 3
Tool results: 3
Tools used: read, grep
Errors: read
Recent excerpts:
- user: 请检查 package.json...
- assistant: 我先读取项目配置...
- toolResult(read): {"name":"mini-agent"...}
```

每条压缩消息只描述其对应分段。规则：

- 计数来自当前分段消息。
- Tool 名称去重后按首次出现顺序排列。
- Error Tool 名称单独列出。
- 每种角色最多保留最后一条摘录。
- 摘录最多 `maxExcerptCharacters` 个 Unicode Code Point。
- 摘录中的换行转换为空格。
- 不包含时间戳或不可序列化 Details。

压缩器将上述文本包装成临时 System Message：

```ts
{
  role: "system",
  content: deterministicSummary,
  timestamp: segmentMessages.at(-1)?.timestamp ?? 0,
}
```

### 插入位置

每条压缩消息插入到对应分段第一条被移除消息的位置。

这保证：

- 开头 System Prompt 仍在最前面。
- 中途出现的 System Update 保持原始位置。
- System Update 之后发生的信息不会被摘要提前到该 System Message 之前。
- 最近保留 Turn 的顺序不变。

如果旧区包含中途 System Message，System Message 前后的非 System Message 分别生成压缩消息；System Message 原地保留。

### 压缩后验证

组装最终请求后再次估算：

- 不超过 `maxInputTokens`：返回请求消息。
- 仍然超过上限：抛出 `Context remains over budget after deterministic compaction`。

第一版不执行以下回退：

- 不递归压缩。
- 不裁剪最近完整 Turn。
- 不删除 System Message。
- 不静默发送超预算原始历史。

这些能力留到阶段 10。

## 状态和事件语义

Hook 返回的工作消息、临时压缩消息和 `requestMessages` 都不进入 Agent 事件流。

UI 和 Server 继续只观察：

- 真实 User Message。
- Assistant Message。
- Tool Result Message。

确定性压缩是模型请求投影，不是发生在用户对话中的新消息。

`Agent.state.messages` 在任意压缩后仍保持完整原始 transcript。

## 错误与取消

- 所有 Hook 和模型流使用同一个 Run `AbortSignal`。
- Hook 在耗时工作前应调用 `signal.throwIfAborted()`。
- 中止产生 `stopReason: "aborted"` 的 Assistant Message。
- 其他异常产生 `stopReason: "error"` 的 Assistant Message。
- `errorMessage` 保留原始错误文案。
- Transform 不得吞掉 Token 估算、序列化或预算错误。
- 确定性压缩失败不回退到空上下文。
- `prepareNextTurn` 发生在已经开始的下一 Turn 内，因此失败时无需 Agent 补发 `turn_start`。

## 文件改动

### `packages/core/src/types.ts`

- 增加上下文快照、准备、转换和估算类型。
- 将 `CompletedTurn.context` 改为只读快照。
- 扩展 `AgentLoopConfig`。

### `packages/core/src/context.ts`

- 实现启发式 Token 估算器。
- 实现稳定 JSON 序列化辅助函数。
- 实现 Turn 分组。
- 实现确定性摘要和压缩后预算验证。

Turn 分组保持为模块内部函数；测试通过公共 Transform 验证行为。

### `packages/core/src/agent-loop.ts`

- 在精确生命周期点调用三个 Hook。
- 使用临时 `requestMessages` 调用模型。
- 保持原始工作上下文和请求上下文分离。
- 使用非破坏性方法确认下一 Turn。
- 在 `prepareNextTurn` 后消费 steering。
- 为 `CompletedTurn` 创建稳定数组快照。
- 继续独占 `turn_start` 和 `turn_end` 生命周期。

### `packages/core/src/agent.ts`

- `AgentOptions` 接收三个 Hook。
- 保存并传递 Hook 到 `AgentLoopConfig`。
- `MessageQueue` 增加 `hasMessages()`。
- 不增加 Turn 生命周期跟踪状态。

### `packages/core/src/index.ts`

- 导出上下文工厂和新增公共类型。

### `packages/core/test`

- 新增 `context.test.ts`。
- 扩展 `agent-loop.test.ts` 和 `agent.test.ts`。
- 不增加生产 Provider 或摘要模型。

## 测试要求

### Hook 时序

1. 首 Turn 顺序严格为 `prepareRequest → transformContext → stream`。
2. 后续 Turn 顺序严格为 `turn_start → prepareNextTurn → prepareRequest → transformContext → stream`。
3. 第一个 Turn 不调用 `prepareNextTurn`。
4. 不存在下一 Turn 时不调用 `prepareNextTurn`。
5. `prepareNextTurn` 期间入队的 steering 在紧接着的 Turn 可见。

### 队列调度

6. 判断是否存在下一 Turn 不会消费 steering 或 follow-up。
7. `prepareNextTurn` 期间到达 steering 时，等待中的 follow-up 保持排队。
8. steering 被消费后，follow-up 只在任务再次自然结束时消费。
9. Run 启动前已排队的 steering 进入首 Turn，且工具结果、steering、follow-up、显式 continue 的优先级保持不变。

### 所有权

10. `transformContext` 删除旧消息后，`Agent.state.messages` 仍保留完整历史。
11. `prepareRequest` 替换工作消息不会直接改写 Agent transcript。
12. Hook 返回数组在调用后被外部修改时，不影响 Loop 工作上下文。
13. 临时压缩 System Message 不产生消息生命周期事件。
14. `CompletedTurn.context.messages` 不随后续 Turn 的 push 或替换变化。

### 确定性压缩

15. 未超过阈值时返回副本，不产生压缩消息。
16. 超过阈值时为每个连续旧区分段生成固定格式压缩消息。
17. 最近完整 Turn 和未完成尾部消息始终保留。
18. 所有 System Message 保持原始位置。
19. 每条压缩消息位于对应分段第一条被移除消息的位置。
20. 中途 System Message 会切分压缩分段，摘要不会跨越它聚合信息。
21. Tool 名称、Error Tool 和消息计数稳定。
22. 摘录按 Unicode Code Point 截断，不切断代理对。
23. 没有可压缩旧区时超限会失败。
24. 压缩后仍超限会失败。
25. 无法稳定序列化的工具参数会产生明确错误。

### 错误与取消

26. 三个 Hook 都能响应中止。
27. Hook 抛错会产生明确的 Error Assistant Message。
28. `prepareNextTurn` 失败时 `turn_start` 与 `turn_end` 保持配对。
29. Transform 的预算和序列化错误不会被吞掉。

### 回归

30. 现有 core 测试全部通过。
31. 未配置新 Hook 时，现有模型输入、队列优先级和事件顺序不变。
32. 新增接口和工厂可从 `@mini-agent/core` 公共入口导入。
33. Server 和 Web 无需修改即可继续构建和运行。

## 验收标准

- Mock Stream 能记录每次实际收到的 `requestMessages`，并证明它与原始 transcript 相互独立。
- 超预算历史通过确定性压缩缩短，不调用任何模型摘要器。
- `Agent.state.messages` 在任意压缩后仍包含完整原始对话。
- Hook 期间进入的 steering 不会导致 follow-up 丢失或提前消费。
- Turn 生命周期只由 Agent Loop 调度。
- 所有新旧 core 测试通过。
- `pnpm --filter @mini-agent/core run check` 通过。
- `pnpm --filter @mini-agent/core run test` 通过。
- Server 和 Web 无需修改即可继续构建和运行。

## 与阶段 10 的边界

本阶段最终得到：

```text
完整 Transcript
    ↓
Context Pipeline
    ↓
确定性请求投影
    ↓
StreamFn
```

阶段 10 再替换压缩策略：

```text
Token 水位
    ↓
独立模型摘要请求
    ↓
Previous Summary + Retained Tail
    ↓
持久化 Compaction Entry
    ↓
Overflow Recovery
```

阶段 10 不需要重新设计三个 Hook，只需要在已有 `TransformContext` 和 Session 边界上增加正式的 `CompactionRuntime`。
