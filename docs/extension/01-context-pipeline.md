# 阶段 1：上下文处理管线

## 当前问题

当前 `streamAssistantResponse()` 直接执行：

```text
context.messages
→ config.stream(...)
```

这在核心版中足够清晰，但真实 Agent 的历史会不断增长。模型不应该无条件看到全部消息：

- 历史可能超过上下文窗口。
- UI 消息或内部记录可能不适合发送给模型。
- Session 中的权威消息可能比内存快照更新。
- 不同 Turn 可能需要不同模型或推理等级。
- 工具产生的大段输出可能需要压缩。

本阶段解决“**每次模型请求到底应该使用什么上下文**”。

## 学习目标

- 区分持久状态、Loop 局部上下文和模型请求上下文。
- 理解三个准备时机：Turn 间、请求前、发送前。
- 实现可测试的上下文裁剪和简单 Token 估算。
- 在不丢失原始历史的前提下压缩模型输入。

## 非目标

- 不接真实模型。
- 不做精确 Provider Tokenizer。
- 不实现 Session 持久化。
- 不动态切换模型。

## 方案比较

### 方案 A：在 `streamAssistantResponse()` 内直接裁剪

优点是改动小。缺点是所有策略耦合在模型调用函数中，无法区分“同步状态”和“压缩消息”。

### 方案 B：一个万能 `prepareContext()` Hook

比方案 A 更可替换，但一个 Hook 同时承担同步、压缩和 Turn 决策，后续会越来越难理解。

### 方案 C：分阶段管线，推荐

```text
上一个 Turn 完成
    ↓ prepareNextTurn
请求即将开始
    ↓ prepareRequest
消息发送给模型前
    ↓ transformContext
StreamFn
```

每个 Hook 只解决一个时间点的问题，最接近真实 Agent Runtime。

## 目标接口

在 `packages/core/src/types.ts` 增加：

```ts
export interface RequestPreparation {
  context?: AgentContext;
}

export type PrepareRequest = (
  context: AgentContext,
  signal: AbortSignal,
) => Promise<RequestPreparation | undefined>;

export interface NextTurnPreparation {
  context?: AgentContext;
  messages?: AgentMessage[];
}

export type PrepareNextTurn = (
  turn: CompletedTurn,
  signal: AbortSignal,
) => Promise<NextTurnPreparation | undefined>;

export type TransformContext = (
  messages: readonly AgentMessage[],
  signal: AbortSignal,
) => Promise<AgentMessage[]>;
```

`AgentLoopConfig` 增加：

```ts
prepareNextTurn?: PrepareNextTurn;
prepareRequest?: PrepareRequest;
transformContext?: TransformContext;
```

职责必须保持：

| Hook | 输入时机 | 可以做什么 |
|---|---|---|
| `prepareNextTurn` | 上一 Turn 已完成 | 根据工具结果插入消息、压缩或重建上下文 |
| `prepareRequest` | 每次模型请求前 | 从权威来源同步最新消息 |
| `transformContext` | 调用 `StreamFn` 前 | 生成只供模型使用的临时消息数组 |

## Token 估算

先实现教学型估算器，不追求供应商精确值：

```ts
export interface TokenEstimator {
  estimate(messages: readonly AgentMessage[]): number;
}
```

推荐规则：

```text
中文字符：约 1 token
英文字符：约 1/4 token
工具参数和 JSON：按字符数 / 3 估算
每条消息增加固定开销
```

估算结果只用于触发压缩，不能用于计费。

## 简单压缩策略

增加：

```ts
export interface ContextCompactor {
  compact(
    messages: readonly AgentMessage[],
    signal: AbortSignal,
  ): Promise<AgentMessage[]>;
}
```

第一版不调用模型生成摘要，而是确定性压缩：

1. 始终保留 System Message。
2. 保留最近 N 个完整 Turn。
3. 将更早的用户、Assistant 和 Tool Result 转换成一条 `ContextSummaryMessage`。
4. 不修改 `Agent.state.messages`，只修改请求副本。

如果不希望增加新消息角色，可以将摘要表示为额外 System Message，但要明确它不是原始系统提示词。

## 调用链变化

```text
Turn 1 完成
    ↓
prepareNextTurn(completedTurn)
    ↓
插入准备消息或替换 Loop Context
    ↓
prepareRequest(context)
    ↓
同步请求前上下文
    ↓
transformContext(messages)
    ↓
估算 Token，必要时 compact
    ↓
StreamFn(transformedMessages)
```

## 状态语义

必须区分三份数据：

```text
Agent.state.messages
    原始、可观察历史

AgentContext.messages
    当前 Run 使用的工作快照

requestMessages
    transformContext 生成的模型临时输入
```

`transformContext` 不能偷偷删除 `Agent.state.messages` 中的历史，否则 UI 和恢复逻辑会丢数据。

## 错误与取消

- Hook 收到与模型相同的 `AbortSignal`。
- Hook 抛错时本次 Run 失败，生成明确的 error Assistant Message。
- 压缩失败不能静默回退到空上下文。
- 如果采用“回退到未压缩历史”，必须显式检查未压缩历史没有超过配置上限。
- `prepareNextTurn` 不应轮询 steering 队列；队列仍由 Loop 调度。

## 对现有包的影响

### `packages/core`

- `types.ts`：新增三个 Hook 和估算/压缩接口。
- `agent.ts`：接收并传递 Hook。
- `agent-loop.ts`：在明确时间点调用 Hook。
- 新增 `context.ts`：放置估算器和确定性压缩器。

### `packages/server`

暂无协议变化。Server 继续序列化原始 Agent 状态。

### `packages/web`

可以增加“原始历史 Token 估算”和“模型请求 Token 估算”展示，但不是本阶段必需。

### `packages/plugins`

暂不允许插件修改上下文，避免同时设计插件权限。

## 测试策略

必须覆盖：

1. Hook 调用顺序严格为 `prepareNextTurn → prepareRequest → transformContext → stream`。
2. 第一个 Turn 不调用 `prepareNextTurn`。
3. `transformContext` 删除旧消息后，`Agent.state.messages` 仍保留完整历史。
4. 超过阈值时触发压缩。
5. System Message 和最近完整 Turn 始终保留。
6. Hook 能响应中止。
7. Hook 抛错产生 error Assistant Message。
8. steering 在耗时 `prepareNextTurn` 期间入队时，下一 Turn 仍能收到。

## 验收标准

- Mock LLM 可以记录它实际收到的消息，并证明请求上下文已被转换。
- 原始 Transcript 不因压缩而变化。
- 上下文策略可替换，不需要修改 Agent Loop 主体。
- 所有现有核心版测试继续通过。

## 学习练习

1. 画出三份消息数组的所有权关系。
2. 实现“仅保留最近两个 Turn”的 `TransformContext`。
3. 让一个慢 `prepareNextTurn` 等待 100ms，并在期间调用 `steer()`，观察消息在哪个 Turn 出现。
4. 故意让压缩器抛错，确认错误没有被吞掉。

## 进入下一阶段前

你应该能够回答：

- 为什么压缩不能直接修改 `Agent.state.messages`？
- `prepareRequest` 和 `transformContext` 为什么不能合并？
- 哪些工作必须发生在 Turn 边界？

