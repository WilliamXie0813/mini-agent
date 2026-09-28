# 阶段 4：Session 持久化与恢复

## 当前问题

当前 Agent 的全部状态位于内存：

```text
进程退出
→ messages、队列和运行状态全部丢失
```

`packages/server` 只把状态广播给 WebSocket 客户端，没有可靠保存 Session。真实 Agent 需要在重启后恢复历史，并区分“已经提交的结果”和“执行到一半但结果未知的工作”。

本阶段解决“**哪些状态需要持久化，以及进程崩溃后从哪里继续**”。

## 学习目标

- 区分 Transcript、运行时瞬态状态和持久化元数据。
- 建立追加式 Session Store。
- 理解原子提交和恢复边界。
- 从持久历史创建新的 Agent。

## 非目标

- 不做多进程并发写。
- 不实现分支 Session。
- 不自动恢复未知结果的副作用工具。
- 不先上 SQLite；第一版使用 JSONL。

## 方案比较

### 方案 A：每次覆盖一个 JSON 文件

读取简单，但写入中断可能损坏整个 Session，且无法观察历史演进。

### 方案 B：直接持久化所有 Agent Event

信息完整，但流式 `message_update` 数量巨大，恢复时还要重放大量瞬态事件。

### 方案 C：追加式持久记录，推荐

只持久化稳定状态转换：

- Session Header
- 完成的 Message
- 队列变更
- Run/Turn 关键边界
- 工具意图与最终结果

采用 JSONL，每行一个独立记录。

## 数据分类

### 必须持久化

- Session ID 和创建时间
- System/User/Assistant/Tool Result 完整消息
- steering/follow-up 队列内容
- 工具调用意图和最终结果
- 模型重试最终失败

### 不需要持久化

- `streamingMessage` 的每个字符快照
- `isStreaming`
- 当前 Promise
- AbortController
- WebSocket 客户端集合

### 需要特殊处理

- 已记录工具调用意图，但没有结果
- Assistant 流开始但没有最终消息
- 队列消息已取出但尚未写入 Transcript

## SessionStore 接口

```ts
export interface SessionMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSnapshot {
  metadata: SessionMetadata;
  messages: AgentMessage[];
  steeringQueue: AgentMessage[];
  followUpQueue: AgentMessage[];
  pendingEffects: PendingEffect[];
}

export interface SessionStore {
  create(metadata: SessionMetadata): Promise<void>;
  load(sessionId: string): Promise<SessionSnapshot>;
  append(sessionId: string, records: readonly SessionRecord[]): Promise<void>;
  list(): Promise<SessionMetadata[]>;
}
```

## JSONL 记录

```ts
export type SessionRecord =
  | { type: "session"; version: 1; metadata: SessionMetadata }
  | { type: "message"; sequence: number; message: AgentMessage }
  | { type: "queue_enqueued"; queue: "steering" | "followUp"; message: AgentMessage }
  | { type: "queue_dequeued"; queue: "steering" | "followUp"; messageId: string }
  | { type: "effect_started"; effect: PendingEffect }
  | { type: "effect_finished"; toolCallId: string };
```

为了引用队列记录，消息需要稳定 `id`。本阶段应为所有消息增加唯一 ID，而不是依赖数组位置。

## 写入边界

推荐顺序：

```text
生成完整 Message
    ↓
SessionStore.append(message)
    ↓ 成功
emit(message_end)
    ↓
更新 Agent.state
```

这意味着：

> 只有持久化成功的消息才对订阅者可见。

如果先 emit 再写磁盘，UI 会看到一个重启后不存在的“幽灵消息”。

## 工具副作用记录

工具执行前写入：

```ts
interface PendingEffect {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  replay: "safe" | "never";
}
```

执行完成并成功持久化 Tool Result 后，再写 `effect_finished`。

恢复时：

- `safe`：可以由用户或恢复策略决定是否重放。
- `never`：标记为 outcome unknown，必须人工处理。

第一版不自动重放任何工具，只显示恢复诊断。

## Agent 与存储边界

不要让工具直接写 Session。增加运行时提交接口：

```ts
export interface SessionCommitter {
  commitMessages(messages: readonly AgentMessage[]): Promise<void>;
  enqueue(queue: QueueName, message: AgentMessage): Promise<void>;
  dequeue(queue: QueueName, messageId: string): Promise<void>;
}
```

`Agent` 负责队列持久化，`AgentLoop` 负责消息和工具边界，Store 只负责数据。

## 恢复流程

```text
SessionStore.load(sessionId)
    ↓
重放 JSONL 记录
    ↓
得到 SessionSnapshot
    ↓
Agent.restore(snapshot)
    ↓
检查 pendingEffects
    ↓
允许 prompt / continue
```

如果尾部是 User 或 Tool Result，可以 `continue()`。如果尾部是完整 Assistant，则等待新输入。

## 对现有包的影响

### `packages/core`

- 新增 `session.ts` 和 `session-store.ts`。
- `AgentOptions` 可接收 Store 和 Session ID。
- Message 增加稳定 ID。
- 事件可增加 `session_committed` 和 `session_recovery_warning`。

### `packages/server`

- `AgentSession` 根据客户端选择的 Session ID 创建或恢复 Agent。
- 协议增加创建、列出、打开 Session 的命令。
- Server 不直接解析 JSONL。

### `packages/web`

- 增加 Session 列表和恢复警告。
- 页面重连时先接收完整 Snapshot，再接收增量事件。

### `packages/plugins`

插件不能直接访问 Store；未来通过受限 Session Service。

## 测试策略

1. 新 Session 写入 Header 和消息。
2. 重新创建 Store 后可以恢复相同 Transcript。
3. 截断最后半行时忽略未完成记录并报告诊断。
4. append 失败时不 emit `message_end`。
5. 队列 enqueue/dequeue 重放后状态正确。
6. `effect_started` 无 `effect_finished` 时产生恢复警告。
7. `continue()` 可以从恢复后的 User/Tool Result 尾部继续。
8. 两个 Session 文件互不影响。

## 验收标准

- Server 重启后能够打开已有 Session。
- 已完成消息不会丢失或重复。
- 未知工具结果不会被自动伪装成成功或失败。
- Store 可以替换为内存实现供单元测试使用。

## 学习练习

1. 手工打开 JSONL，按顺序解释每条记录。
2. 删除最后的 `effect_finished`，观察恢复诊断。
3. 模拟 append 抛错，确认 UI 看不到未持久化消息。
4. 实现 `MemorySessionStore` 与 `JsonlSessionStore` 的相同契约测试。

## 进入下一阶段前

你应该能够回答：

- 为什么不能持久化每个 `message_update`？
- 为什么要先写存储，再向订阅者发布完成消息？
- 工具 outcome unknown 与普通工具失败有什么不同？

