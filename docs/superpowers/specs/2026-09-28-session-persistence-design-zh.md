# Session 持久化与恢复设计

日期：2026-09-28  
来源：[阶段 4：Session 持久化与恢复](../../extension/04-session-persistence.md)

## 目的

为 `packages/core` 增加追加式 Session 持久化与崩溃恢复能力，让 Server 重启后可以打开已有 Session、恢复完整 Transcript 与队列状态，并区分"已提交的结果"与"执行到一半、结果未知的工具副作用"。

本设计解决四个问题：

1. 哪些状态需要持久化（稳定状态转换），哪些不需要（流式瞬态）。
2. 写入顺序如何保证"只有持久化成功的消息才定稿可见"。
3. 崩溃后从哪里继续（Transcript 尾部规则 + pendingEffects 诊断）。
4. Server 如何从"全局一个 Agent"演进为"多 Session 管理"。

## 范围

### 本阶段包含

- `packages/core` 新增 `session.ts`（纯类型）与 `session-store.ts`（接口 + 两个实现）。
- `SessionStore` 接口与 `JsonlSessionStore` / `MemorySessionStore` 两个可互换实现。
- `SessionCommitter` 运行时提交接口：一个逻辑提交序列化为一条 JSONL Commit Envelope，写盘成功是消息定稿、队列变更可见的前置条件。
- 四种 `AgentMessage` 全部增加必填 `id` 字段 + 各构造点可注入 `IdGenerator`。
- `PendingEffect` 副作用记录：工具执行前写 `effect_started`，结果落盘后写 `effect_finished`，被取消写 `effect_cancelled`。
- `reset` 记录：append-only 语义下的 Session 重置。
- 恢复语义：异步 `openOrCreateSession()` 先恢复或新建，再把稳定 Snapshot 与 Committer 传给同步 `Agent` 构造函数。
- `continue()` 尾部规则（先 drain 队列再判定，对恢复与非恢复场景统一生效）。
- `steer()` / `followUp()` 改为异步方法（队列变更落盘成功才可见）。
- 新事件 `session_recovery_warning`；诊断先作为 `SessionSnapshot.recoveryWarnings` 稳定返回，再由 Server 在客户端绑定完成后通过现有 Event 通道发送，不依赖构造期间的瞬态事件。
- `packages/server` 新增 `SessionManager` 与 `list_sessions` / `create_session` / `open_session` 协议命令。
- 完整的 core 单元测试（含两个 Store 实现的共享契约测试）与 server 集成测试。

### 本阶段不包含

- Web UI 的 Session 列表与恢复警告展示（后续阶段；本阶段保证现有前端**运行时**零改动可连接 `default` Session 工作，前端测试的消息字面量需补 id）。
- 多进程并发写同一 Session 文件。
- 分支 Session。
- 自动重放任何工具（`pendingEffects` 只诊断，不伪装成功或失败）。
- SQLite 存储（第一版只用 JSONL）。
- 权限与多用户隔离。

### 前置依赖

`PendingEffect.replay` 引用阶段 3 的 `Tool.replay?: "safe" | "never"` 元数据。阶段 3 的设计已定稿但尚未实现；实现计划中将"在 `Tool` 接口补齐 `replay` 字段（纯类型声明）"作为前置任务，不涉及阶段 3 其余实现。

源文档"必须持久化"清单中的"模型重试最终失败"不新增记录类型：它体现为一条 `stopReason: "error"` 的 Assistant 消息，由 `message` 记录覆盖。

## 核心不变量

| 不变量 | 说明 |
|---|---|
| 先持久化，后定稿 | `append` 成功才 emit `message_end` 并进入历史；非流式消息（User/ToolResult）commit 成功后才 emit `message_start` |
| 流式信号是瞬态的 | 流式 Assistant 的 `message_start`/`message_update` 本来就是未定稿信号，不承诺持久；不变量只管 `message_end` 与历史 |
| 只持久化稳定状态转换 | Session Header、完成的 Message、队列变更、工具意图与结局、reset；流式增量一律不落盘 |
| 追加式单写 | 每个逻辑提交序列化成一条完整 Commit Envelope 后单次 append；尾部截断时整批提交一起丢弃 |
| 工具永不自动重放 | `effect_started` 无配对结局记录 = outcome unknown，只发诊断事件；被 abort 的写 `effect_cancelled`，单独成类 |
| 队列确认与消息原子恢复 | `queue_dequeued` 与对应 `message` 位于同一 Commit Envelope；恢复时要么两者都存在，要么整行截断后两者都不存在 |
| 未配置 Store 时行为零变化 | 不传 `sessionStore` 时持久化路径不激活，**运行时行为**与现状完全一致（测试的消息字面量需补 id，属类型层连带） |
| Store 可替换 | `MemorySessionStore` 与 `JsonlSessionStore` 通过同一组契约测试 |

## 分层与职责边界

```text
packages/core
├── session.ts            ← SessionRecord / SessionMetadata / PendingEffect 等纯类型
├── session-store.ts      ← SessionStore 接口 + JsonlSessionStore + MemorySessionStore
└── （改动）types.ts / agent.ts / agent-loop.ts / tool-execution.ts / mock-llm.ts
```

| 层 | 职责 | 不做什么 |
|---|---|---|
| `SessionStore` | JSONL 追加、读取重放、截断容错 | 不认识 Agent 语义，纯数据层 |
| `SessionCommitter` | 把"写盘成功"作为消息定稿/队列变更可见的前置条件；内部串行写队列保证并发工具下 append 不交错 | 不解析、不重放 |
| `Agent` | 持有 Committer，负责队列（steering/followUp）的持久化与恢复 | 不写工具边界 |
| `AgentLoop` | 在消息定稿和工具边界调用 Committer | 不感知 JSONL |
| 工具 / 插件 | 不直接访问 Store（未来经受限 Session Service） | — |

### SessionCommitter 接口

```ts
export type QueueName = "steering" | "followUp";

export interface QueuedMessageReservation {
  queue: QueueName;
  message: AgentMessage;
}

export interface MessageCommit {
  messages: readonly AgentMessage[];
  dequeued?: readonly QueuedMessageReservation[];
}

export interface SessionCommitter {
  commitMessages(commit: MessageCommit): Promise<void>;
  enqueue(queue: QueueName, message: AgentMessage): Promise<void>;
  startEffect(effect: PendingEffect): Promise<void>;
  finishEffect(toolCallId: string): Promise<void>;
  cancelEffect(toolCallId: string): Promise<void>;
  reset(systemMessage: SystemMessage): Promise<void>;
}
```

- 内部维护**串行写队列**：parallel 模式下多个工具的 `effect_started` commit 来自并发任务，Committer 保证 append 逐条执行、记录顺序与提交顺序一致。
- 队列读取改为**预留但不删除**：Loop 取得 `QueuedMessageReservation` 后调用 `commitMessages({ dequeued, messages })`。只有 Commit Envelope 写入成功后，Agent 才确认并从内存 Queue 删除；失败则 Reservation 回滚，消息仍留在 Queue。
- `AgentLoopConfig` 的队列接口因此改成 `reserveSteeringMessages()` / `reserveFollowUpMessages()` 与 `acknowledgeReservations()`，不再使用会立即改变内存状态的同步 `drainOne()`。
- `Agent.continue()` 不再启动前先删除 Queue Message；它只验证存在可预留消息，实际提交仍走 Loop 的统一消息边界。

### 写入顺序（按消息类型）

```text
非流式消息（User / ToolResult）：
  构造 → commit 成功 → emit(message_start) → emit(message_end) → 进历史
                ↘ 失败 → 不 emit 任何消息事件，消息不进历史

流式消息（Assistant）：
  stream start → emit(message_start) → emit(message_update) × N   ← 瞬态，不落盘
  stream end   → commit 成功 → emit(message_end) → 进历史
                        ↘ 失败 → 不 emit message_end，消息不进历史，Turn 失败
```

**关键后果**：持久化失败视同本次 Turn 失败。UI 定稿区永远不会出现重启后消失的"幽灵消息"。

## 数据模型

### 消息 ID（types.ts 改动）

四种消息（System / User / Assistant / ToolResult）全部增加**必填** `id: string`。新增可注入生成器：

```ts
export type IdGenerator = () => string; // 默认 crypto.randomUUID
```

注入点按构造方分散，不集中补 id：

| 构造点 | 注入方式 |
|---|---|
| System / User 消息（agent.ts） | `AgentOptions.idGenerator?` |
| Assistant 消息（mock-llm.ts 流事件） | `createMockStream({ idGenerator? })`，流式 start/delta/end 共享同一 id |
| ToolResult 消息（tool-execution.ts） | `ToolExecutionBatchOptions.idGenerator?`，由 Agent 透传 |

测试注入确定性 id（如 `id-1, id-2, ...`）；全仓测试的消息字面量统一走带确定性 id 的构造 helper。

### JSON 值约束

Session 文件只能保存 JSON 值：

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
```

`PendingEffect.arguments` 必须在工具启动前通过 `toJsonValue()` 验证。循环引用、`bigint`、函数等不可序列化参数会让 Tool Call 在产生副作用前失败，不能等到 `JSON.stringify()` 时才意外抛错。

### SessionRecord（session.ts）

```ts
export interface SessionMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type SessionOperation =
  | { type: "message"; message: AgentMessage }
  | { type: "queue_enqueued"; queue: QueueName; message: AgentMessage }
  | { type: "queue_dequeued"; queue: QueueName; messageId: string }
  | { type: "effect_started"; effect: PendingEffect }
  | { type: "effect_finished"; toolCallId: string }
  | { type: "effect_cancelled"; toolCallId: string }
  | { type: "reset"; systemMessage: SystemMessage };

export type SessionRecord =
  | { type: "session"; version: 1; metadata: SessionMetadata }
  | {
      type: "commit";
      sequence: number;
      timestamp: string;
      operations: SessionOperation[];
    };
```

- `sequence` 是 Commit Envelope 的**单调递增提交序号**，覆盖 Message、Queue、Effect 和 Reset 的统一顺序；恢复时校验严格递增并检测缺洞。
- `updatedAt` 不需要重写 Header；加载时取最后一条有效 Commit 的 `timestamp`，没有 Commit 时使用 `createdAt`。
- 配对不变量：`queue_dequeued` 引用的 `messageId` 必须先有对应 `queue_enqueued` 记录。
- `reset` Operation：Header 始终保留；重放到 Reset 时，把 Messages 重置为该 Operation 中的 `systemMessage` 并清空 Queue。未结与已取消 Effect 属于外部副作用审计状态，不能因对话 Reset 被抹掉。
- `effect_cancelled`：工具被 abort 取消时的结局记录。取消是用户主动行为，与"崩溃导致 outcome unknown"区分开。

### PendingEffect

```ts
export interface PendingEffect {
  toolCallId: string;
  toolName: string;
  arguments: JsonValue;
  replay: "safe" | "never"; // 来自阶段 3 的 Tool.replay
}
```

写入时机与并发模型的对应关系：

- 工具 `execute` **之前**写 `effect_started`，落盘成功后**才** emit `tool_execution_start`。
- Tool Result 落盘成功后写 `effect_finished`。注意：现有批次模型在整批工具结算后才逐条提交 Tool Result，单个工具完成到其 `effect_finished` 之间隔着整批等待窗口——崩溃窗口略大于"execute 结束即收尾"，可接受。
- Run 取消 / 控制面错误导致已 start 的调用无结果（现有 `tool_execution_cancelled` 事件路径）→ 写 `effect_cancelled`。**正常 abort 不会留下 pendingEffects 告警噪音**。

### SessionStore 接口

```ts
export interface SessionRecoveryWarning {
  kind: "unknown" | "cancelled";
  effect: PendingEffect;
  message: string;
}

export interface SessionSnapshot {
  metadata: SessionMetadata;
  messages: AgentMessage[];
  steeringQueue: AgentMessage[];
  followUpQueue: AgentMessage[];
  pendingEffects: PendingEffect[];   // started 减去 finished/cancelled
  cancelledEffects: PendingEffect[]; // effect_cancelled 对应的记录，供诊断展示
  recoveryWarnings: SessionRecoveryWarning[];
}

export interface SessionStore {
  create(metadata: SessionMetadata): Promise<void>;
  load(sessionId: string): Promise<SessionSnapshot>;
  append(sessionId: string, records: readonly SessionRecord[]): Promise<void>;
  list(): Promise<SessionMetadata[]>;
}
```

对应的 AgentEvent 只负责传输已经稳定存在于 Snapshot 中的诊断：

```ts
type AgentEvent =
  | /* 现有事件 */
  | {
      type: "session_recovery_warning";
      warnings: readonly SessionRecoveryWarning[];
    };
```

该事件不改变 Transcript，也不由 Agent 构造函数自动发射。

`load` 对不存在的 sessionId 抛 `SessionNotFoundError`；`openOrCreateSession()` 捕获后走 Create 分支（“打开不存在 = 新建”），`Agent` 不直接处理 Store 错误。

### JSONL 目录约定

```text
<dataDir>/sessions/<sessionId>.jsonl     ← 一个 Session 一个文件
```

- `dataDir` 由 server 启动参数传入（默认 `./.mini-agent/`）；`JsonlSessionStore` 只收一个绝对目录路径，不关心默认值。
- sessionId 校验为安全文件名（`[A-Za-z0-9_-]`），防止路径穿越；非法 id 在 server 层拒绝。

## 恢复流程与 continue 语义

### 恢复入口

```ts
export interface OpenedSession {
  snapshot: SessionSnapshot;
  committer: SessionCommitter;
}

export async function openOrCreateSession(options: {
  store: SessionStore;
  sessionId: string;
  systemMessage: SystemMessage;
  now?: () => Date;
}): Promise<OpenedSession>;

interface AgentOptions {
  // ...现有字段
  initialSession?: SessionSnapshot;
  sessionCommitter?: SessionCommitter;
  idGenerator?: IdGenerator;
}
```

`openOrCreateSession()` 先异步执行 `load()`；不存在时写 Header 与初始 System Message Commit。完成后才同步构造 `Agent`。`initialSession` 与 `sessionCommitter` 必须同时存在或同时缺省，禁止半配置状态。

传入 `initialSession` 时，`Agent` 直接使用 Snapshot Messages，不能再根据 `systemPrompt` 额外创建第二条 System Message；未启用持久化时才沿用现有构造逻辑创建初始 System Message。

### 恢复重建什么

```text
SessionStore.load(sessionId)
    ↓ 逐行重放 Header 与 Commit Envelope
SessionSnapshot {
  messages,          ← 按 Commit sequence 和 operations 顺序重放
  steeringQueue,     ← enqueued 减 dequeued
  followUpQueue,     ← 同上
  pendingEffects,    ← started 减 finished 减 cancelled
  cancelledEffects,  ← cancelled 对应记录
  recoveryWarnings,
  metadata           ← updatedAt 取最后有效 Commit timestamp
}
    ↓
Agent.state.messages / 队列 = snapshot 内容
```

- **明确不重建**：`streamingMessage`、`isStreaming`、进行中的 Promise、AbortController、WebSocket 客户端集合——恢复后 Agent 一定处于空闲态。
- `pendingEffects` 和 `cancelledEffects` 被转换成 `recoveryWarnings` 稳定保存在 Snapshot。Server 在 Socket 已绑定并发送完整 State 后，再发送恢复警告；不会因为 Agent 构造期间尚无订阅者而丢失。
- 不增加 `session_committed` AgentEvent。由于 AgentEvent Listener 是可等待且可能抛错的，把“已持久化”事件放进同一失败通道会造成“磁盘已提交但调用方收到失败”的假象。需要保存指示时，由 Committer 或 Server 使用独立、非事务性的观察接口。

### continue() 尾部规则

`continue()` 先检查 steering/followUp 是否存在可预留消息，但不从 Queue 删除；然后根据“当前尾部 + 即将提交的 Reservation”判断：

| drain 后尾部 | 行为 |
|---|---|
| User / ToolResult（含 drain 出的队列消息） | ✅ 允许——模型还没回答过这条输入 |
| Assistant（完整定稿）且队列已空 | ⛔ 拒绝并抛错——模型已答完，继续会产生无输入的空 Turn |
| 空 Transcript | ⛔ 拒绝——空跑无意义 |

对恢复与非恢复场景统一生效。恢复后尾部是 Assistant（含 error 消息）不算卡死：`prompt()` 永远可用，继续对话走新输入。

### 失败消息的持久化

`emitFailure` 合成的 error/aborted Assistant 消息**照常尝试落盘**（它是已提交的终态）；若本次 Turn 失败的原因本身就是 append 失败，则该消息的 commit 大概率再次失败——**失败即丢弃，不再递归处理**，错误只进 `state.errorMessage`。

### 队列恢复的边界情况

`queue_dequeued` 与对应 `message` 位于同一条 Commit Envelope JSONL 行。崩溃导致该行尾部截断时，Loader 丢弃整个不完整 Envelope，因此 Queue Message 仍由之前的 `queue_enqueued` Commit 恢复，不会出现只 Dequeue、未 Message 的半提交状态。

## Server 协议与 Session 管理

### SessionManager（server 新增内部模块）

```text
SessionManager
├── JsonlSessionStore（dataDir 来自启动参数）
├── AgentFactory                   ← 现有 createAgent() 的参数化版本，
│                                    每个 session 用它装配 Agent（systemPrompt/stream/tools）
├── Map<sessionId, AgentSession>   ← 活跃 Agent 缓存，按需创建/恢复
└── getOrOpen(sessionId): Promise<AgentSession>
```

`open_session` 时：缓存命中直接用；未命中 → `await openOrCreateSession(...)` → `AgentFactory` 用返回的 Snapshot/Committer 同步构造 Agent → 挂进缓存。`SessionManager` 还要维护 `Map<sessionId, Promise<AgentSession>>` 的 in-flight Open，避免两个连接同时打开同一未缓存 Session 时创建两个 Agent。**Server 不解析 JSONL**，一切重放逻辑在 core。

### 协议扩展（protocol.ts）

```ts
export type ClientCommand =
  | /* 现有 prompt / steer / followUp / abort / reset */
  | { type: "list_sessions" }
  | { type: "create_session"; sessionId?: string }  // 缺省由 server 生成
  | { type: "open_session"; sessionId: string };

export type ServerMessage =
  | /* 现有 state / event / reset / error */
  | { type: "session_list"; sessions: SessionMetadata[] }   // 只回请求方
  | { type: "session_opened"; sessionId: string }           // 只回请求方
  | { type: "session_error"; message: string };
```

`parseCommand` 返回值加富为判别结果（合法命令 / 非法参数 / 不认识的命令），以区分"Unrecognized command"与"sessionId 非法 → `session_error`"。`session_recovery_warning` 使用现有 `{ type: "event"; event }` 通道，但由 Server 在连接已绑定、完整 State 已发送后根据 Snapshot 主动发布。

### 连接与 Session 的绑定

- 每个 WS 连接有"当前 sessionId"；`open_session` 成功后把 socket 从旧 Session 的客户端集合挪到新 Session。
- **兼容性默认值**：连接建立时自动绑定到 `default` Session——现有 web 前端运行时零改动继续工作。
- 未显式 `create_session` 直接 `open_session` 一个存在的 id 即为恢复；id 不存在则新建（与 core 语义一致）。
- 同一 session 的两个连接并发 `prompt` 会撞现有 `assertIdle` 抛错，错误沿现有 catch 回到发起方——行为可接受，测试钉死。

### reset 的持久化语义

`reset` 命令先构造新的 System Message，再把 `{ type: "reset", systemMessage }` 作为单个 Commit Envelope 写盘。成功后才把内存状态重置为该 System Message 并广播现有 `reset` 消息；失败则内存保持不变。**不删文件、不截断**，Header 和 Reset 前历史仍可审计。

## 错误处理

| 场景 | 行为 |
|---|---|
| `append` 失败（磁盘满等） | 非流式消息不 emit `message_start`；流式消息不 emit `message_end`；消息不进历史，Turn 以失败收场，`errorMessage` 进 state |
| emitFailure 的 error 消息落盘失败 | 丢弃该消息，不递归；Agent 通过非持久化的内部失败状态直接设置 `state.errorMessage`，等待 Server 的 State 重发，不伪造 `message_end` |
| `load` 时 sessionId 不存在 | 抛 `SessionNotFoundError` → Agent 走 create 分支写 session header |
| JSONL 最后一行截断 | 丢弃该行 + 记录诊断（崩溃写一半的正常形态） |
| JSONL 中间行损坏 | 抛错——非正常崩溃能造成，说明文件被手工破坏，不静默吞掉 |
| sessionId 含非法字符 | server 层拒绝，回 `session_error`（parseCommand 判别结果区分） |
| `effect_started` 无结局记录 | 恢复后发 `session_recovery_warning`（unknown 类），不自动重放、不伪装成败 |
| 工具被 abort 取消 | 写 `effect_cancelled`，恢复警告中单独列为 cancelled 类，不算 unknown |

JSONL 写入细节：每个逻辑提交先把全部 Operation 包装成一个 Commit Envelope，再序列化为一整行并执行一次 `appendFile`。文件句柄不常驻，每次 Commit 独立打开/关闭；并发工具提交由 Committer 内部串行队列排序。`appendFile` 仍不保证物理事务，但尾部部分写入只会形成一条不完整 JSON 行，恢复时整批丢弃。

## 测试策略

core 测试全部确定性：注入 `IdGenerator`（各构造点统一 helper）、`MemorySessionStore`（支持 `failNextAppend()` 故障注入）；Jsonl 实现用 `node:test` 临时目录。现有测试的消息字面量统一迁移到带确定性 id 的构造 helper。

1. **契约测试共享**：同一组用例跑 `MemorySessionStore` 与 `JsonlSessionStore` 两个实现。
2. 新 Session 写 header + 消息；重建 Store 后恢复相同 Transcript。
   恢复构造不得重复添加 System Message。
3. 截断最后半行 → 忽略整个 Commit Envelope + 诊断，不应用其中任何 Operation。
4. `failNextAppend()` → 非流式消息不 emit `message_start`，流式消息不 emit `message_end`，消息不进历史。
5. Queue Reservation 在 Commit 失败时保留于内存；成功时 Dequeue 与 Message 位于同一 Envelope 并一起重放。
6. `effect_started` 无结局 → 恢复警告 unknown 类含该 toolCallId；`effect_cancelled` → 归 cancelled 类，不产生 unknown 告警。
7. `continue()` 尾部规则：drain 后 User/ToolResult 尾部可继续；Assistant 尾部/空 Transcript 拒绝；现有"assistant 尾部 + 队列非空可继续"路径回归不破。
8. 两个 Session 文件互不影响。
9. `reset` Operation：恢复后保留新 System Message并清空 Queue；未结/已取消 Effect 继续保留诊断，Header Metadata 仍存在。
10. `updatedAt` 等于最后有效 Commit Timestamp；Sequence 缺洞或倒退时 Load 失败。
11. Recovery Warning 在客户端绑定后发送，不因构造期间无订阅者丢失。
12. server 集成：并发 `open_session` 复用同一个 in-flight Promise；断线重连先收完整 State，再收 Warning 和增量事件。

## 验收标准

- Server 重启后能够打开已有 Session，已完成消息不丢失、不重复。
- 未知工具结果不会被自动伪装成成功或失败；主动取消的工具不产生 unknown 告警。
- `MemorySessionStore` 可替换 `JsonlSessionStore` 供单元测试使用（同一契约测试通过）。
- 不传 `sessionStore` 的调用方**运行时行为**零变化（消息加必填 id 的类型层连带由构造 helper 统一消化）。
- 现有 web 前端不修改代码即可连接 `default` Session 正常工作。
