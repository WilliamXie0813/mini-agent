# 阶段 10：自动上下文压缩

## 当前基线与问题

阶段 1 已经区分：

```text
Agent.state.messages  原始可观察历史
AgentContext.messages 当前 Run 工作快照
requestMessages       本次模型请求输入
```

阶段 4 又增加了持久化 Session。即使消息可以永久保存，真实模型的上下文窗口仍然有限。

例如模型窗口是 32,000 Token：

```text
System Prompt       2,000
历史对话           23,000
工具结果             4,000
下一次模型输出预留    6,000
总需求              35,000
```

此时不能把完整历史继续发送给模型，也不能简单删除最老消息，因为其中可能包含：

- 用户原始目标
- 已经确认的约束
- 修改过的文件
- 重要设计决策
- 尚未完成的任务

本阶段解决“**怎样压缩模型上下文，同时保留完整 Session 历史和继续任务所需的信息**”。

## 学习目标

- 区分 Transcript、Context Projection 和 Compaction Entry。
- 使用 Provider Usage 与本地估算共同判断 Token 水位。
- 在安全切点生成结构化摘要并保留近期消息。
- 支持多次增量压缩，而不是每次重新总结全部历史。
- 正确处理超长单个 Turn、取消、失败和恢复。

## 非目标

- 不实现向量数据库或长期记忆。
- 不删除 Session Store 中的原始消息。
- 不要求摘要恢复每句话的原文。
- 不让压缩请求执行工具。
- 不在字符级流式生成过程中启动压缩。

## Pi 中值得学习的设计

Pi 的压缩实现包含几个重要原则：

1. `shouldCompact()` 根据上下文窗口减去预留 Token 判断。
2. 优先使用模型返回的 Usage，再估算 Usage 后新增的消息。
3. `findCutPoint()` 尽量在 Turn 边界切分。
4. 如果单个 Turn 太大，可以分别总结 Turn Prefix 并保留 Suffix。
5. `CompactionEntry` 同时保存 Summary 和 `retainedTail`。
6. 后续压缩基于前一次 Summary 增量更新。
7. 文件读取和修改记录被保存在摘要元数据中。

教学版不必复制所有复杂度，但应保留这些边界。

## 方案比较

### 方案 A：删除最老的消息

优点是简单；缺点是丢失目标、约束和已完成工作，而且无法解释模型为什么“失忆”。

### 方案 B：每次请求都重新总结完整历史

摘要质量可能较好，但成本随 Session 增长，压缩请求本身最终也会超过窗口。

### 方案 C：持久化 Compaction Entry 并增量更新，推荐

```text
原始 Session 历史保持不变
       ↓
Summary + Retained Tail
       ↓
成为后续 Model Context Projection
```

后续压缩只需要处理：

```text
Previous Summary
+ 上次压缩后新增的较早消息
+ 最新 Retained Tail
```

## 数据模型

```ts
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string | null;
  summary: string;
  retainedTail: AgentMessage[];
  tokensBefore: number;
  createdAt: number;
  reason: "threshold" | "overflow" | "manual";
  previousCompactionId?: string;
  details?: {
    readResources: string[];
    modifiedResources: string[];
  };
}
```

`CompactionEntry` 是 Session 记录，不是普通 Assistant Message。

`summary` 和 `retainedTail` 会被投影到模型上下文；原始消息继续留在 Session Store。

## Token 使用估算

优先级：

```text
最近一次有效 Assistant Usage
    ↓
加上其后新增消息的本地估算
    ↓
若没有 Usage，估算全部 Context Messages
```

接口：

```ts
export interface ContextUsageEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageMessageIndex: number | null;
}

export function estimateContextUsage(
  messages: readonly AgentMessage[],
): ContextUsageEstimate;
```

教学版估算规则可以保持确定性：

```text
文本字符数 / 4
Tool Call 名称 + JSON 参数字符数
图片使用固定估算值
```

本地估算只用于阈值决策，不用于计费。

## 压缩触发条件

```ts
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  return (
    settings.enabled &&
    contextTokens > contextWindow - settings.reserveTokens
  );
}
```

三种触发原因：

### `threshold`

在下一次模型请求前发现已超过安全水位。

### `overflow`

Provider 明确返回 Context Overflow。阶段 3 的错误分类需要增加：

```text
context_overflow
```

只允许一次 Overflow Recovery：

```text
模型请求 overflow
→ 压缩
→ 重试一次
→ 再次 overflow 则终止
```

### `manual`

用户或 Extension 主动请求压缩，用于调试和控制成本。

## 安全切点

压缩不能把 Assistant Tool Call 和对应 Tool Result 拆开。

推荐切点：

```text
User Message
→ Assistant Message
→ 全部 Tool Result
```

优先保留最近 `keepRecentTokens`，然后向前找到完整 Turn 起点。

```ts
export interface CompactionCutPoint {
  firstKeptMessageIndex: number;
  turnStartIndex: number;
  splitsTurn: boolean;
}
```

## 超长单个 Turn

某次工具返回大量内容时，一个 Turn 本身可能超过 `keepRecentTokens`。

处理方式：

```text
Turn Prefix：较早部分，单独生成简短 Turn Summary
Turn Suffix：近期部分，作为 retainedTail 原样保留
```

Turn Summary 至少包含：

- 原始请求
- Prefix 已完成的工作
- 理解 Suffix 所需的信息

不能为了保持完整 Turn 而让压缩完全失效。

## 摘要契约

推荐固定结构：

```text
## Goal
## Constraints
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Files and Resources
## Next Steps
```

这不是给用户看的最终回答，而是给后续模型继续工作的 Context Checkpoint。

摘要请求必须：

- 使用独立 System Prompt。
- 禁止工具调用。
- 不写入普通 Assistant Transcript。
- 使用原 Run 的 AbortSignal。
- 使用阶段 3 的模型重试策略。
- 通过阶段 5 的 Telemetry 记录独立 Span。

## 压缩准备与执行分离

```ts
export interface CompactionPreparation {
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  retainedTail: AgentMessage[];
  previousSummary?: string;
  tokensBefore: number;
  splitsTurn: boolean;
}

export interface CompactionRuntime {
  prepare(
    messages: readonly AgentMessage[],
    settings: CompactionSettings,
  ): CompactionPreparation | undefined;

  generate(
    preparation: CompactionPreparation,
    signal: AbortSignal,
  ): Promise<CompactionEntry>;
}
```

`prepare()` 保持纯函数，便于针对切点写确定性测试。

`generate()` 是外部模型副作用边界。

## 完整数据流

```text
prepareRequest
    ↓
估算 Context Token
    ↓
是否超过阈值？
    ├── 否 → 正常调用模型
    └── 是
         ↓
       prepareCompaction
         ↓
       生成 Summary
         ↓
       SessionStore append CompactionEntry
         ↓
       ContextPipeline 投影 Summary + Retained Tail
         ↓
       调用模型
```

必须先持久化 Compaction Entry，再使用它继续模型请求。

## 多次压缩

第二次压缩时：

```text
Previous Summary
+ 第一次压缩后的新增历史
→ Updated Summary
```

不要把第一次已经总结过的所有原始消息再次发送给模型。

`previousCompactionId` 让恢复流程能够检查摘要链是否完整。

## 失败与取消

### 摘要模型失败

- 不写入不完整 Compaction Entry。
- 原始历史保持不变。
- `threshold` 触发时终止当前 Run，并暴露明确错误。
- 不静默删除消息继续请求。

### 用户 Abort

- 摘要请求使用同一个 AbortSignal。
- 不提交半成品摘要。
- Run 以 aborted 结束。

### 持久化失败

- 不使用尚未持久化的摘要继续运行。
- 返回 Session Commit Error。

### Summary 仍然过大

- 检查 `summary + retainedTail + reserveTokens`。
- 如果仍超过窗口，减少 Retained Tail。
- 如果单条不可压缩消息仍超过窗口，返回明确的 `context_unrecoverable`。

## 对各包的影响

### `packages/core`

- 新增 `compaction.ts`。
- `AgentLoopConfig` 接收 `CompactionRuntime` 和设置。
- `ContextPipeline` 能投影 Compaction Entry。
- Model Error 增加 `context_overflow`。

### `packages/server`

- 增加手动 Compact 命令。
- 状态中暴露当前 Token 估算和最近压缩信息。
- 压缩时广播可观察状态，但不发送内部摘要 Prompt。

### `packages/web`

- 显示“正在压缩上下文”状态。
- Transcript 中可折叠展示 Compaction Checkpoint。
- 显示压缩前 Token 和保留消息数量。

### `packages/plugins`

- 阶段 12 可以提供 `before_compact` 和 `after_compact` Hook。
- 本阶段只预留接口，不提前实现 Extension Host。

## 测试与验收

### 必测场景

1. 未超过阈值时不压缩。
2. 超过阈值时生成并持久化 Compaction Entry。
3. 原始 Session 消息没有被删除。
4. 新模型 Context 使用 Summary 和 Retained Tail。
5. Tool Call 与 Tool Result 不会被切开。
6. 超长 Turn 会生成 Prefix Summary。
7. 第二次压缩使用 Previous Summary。
8. 摘要失败不会提交 Entry。
9. Abort 不留下半成品摘要。
10. Overflow 最多只触发一次恢复。

### 验收标准

- 长 Session 可以在有限 Context Window 中继续。
- Session Export 仍可看到完整原始历史。
- 同一输入和设置产生确定的切点。
- 摘要失败不会被伪装成正常模型响应。
- Telemetry 能区分普通模型请求和摘要请求。

## 学习练习

1. 用 200 字符等于 50 Token 的简化规则实现估算器。
2. 构造三轮含工具调用的历史，找出合法切点。
3. 创建一个单 Turn 超长 Tool Result，观察 Prefix/Suffix 切分。
4. 连续执行两次压缩，画出 Summary 链。
5. 思考摘要遗漏“修改过的文件”会造成什么后果。

## 与下一阶段连接

阶段 11 会把 Session 从线性列表升级为树。

压缩发生在一条具体分支上，因此下一阶段必须回答：

- Compaction Entry 属于哪条分支？
- 从旧节点 Fork 时应保留哪个摘要？
- 离开一条分支时是否需要生成 Branch Summary？

