# Session 持久化与恢复设计

日期：2026-09-28  
来源：[阶段 4：Session 持久化与恢复](../../extension/04-session-persistence.md)

## 目的

为 `packages/core` 增加追加式 Session 持久化与崩溃恢复能力，让 Server 重启后可以打开已有 Session、恢复完整 Transcript 与队列状态，并区分"已提交的结果"与"执行到一半、结果未知的工具副作用"。

本设计解决四个问题：

1. 哪些状态需要持久化（稳定状态转换），哪些不需要（流式瞬态）。
2. 写入顺序如何保证"只有持久化成功的消息才对订阅者可见"。
3. 崩溃后从哪里继续（Transcript 尾部规则 + pendingEffects 诊断）。
4. Server 如何从"全局一个 Agent"演进为"多 Session 管理"。

## 范围

### 本阶段包含

- `packages/core` 新增 `session.ts`（纯类型）与 `session-store.ts`（接口 + 两个实现）。
- `SessionStore` 接口与 `JsonlSessionStore` / `MemorySessionStore` 两个可互换实现。
- `SessionCommitter` 运行时提交接口：写盘成功是消息/队列变更可见的前置条件。
- 四种 `AgentMessage` 全部增加必填 `id` 字段 + 可注入 `IdGenerator`。
- `PendingEffect` 副作用记录：工具执行前写 `effect_started`，结果落盘后写 `effect_finished`。
- 恢复语义：`AgentOptions` 接收 `sessionStore` / `sessionId`，构造时恢复或新建。
- `continue()` 尾部规则（对恢复与非恢复场景统一生效）。
- 新事件：`session_committed`、`session_recovery_warning`。
- `packages/server` 新增 `SessionManager` 与 `list_sessions` / `create_session` / `open_session` 协议命令。
- 完整的 core 单元测试（含两个 Store 实现的共享契约测试）与 server 集成测试。

### 本阶段不包含

- Web UI 的 Session 列表与恢复警告展示（后续阶段；本阶段保证现有前端零改动可运行）。
- 多进程并发写同一 Session 文件。
- 分支 Session。
- 自动重放任何工具（`pendingEffects` 只诊断，不伪装成功或失败）。
- SQLite 存储（第一版只用 JSONL）。
- 权限与多用户隔离。

### 前置依赖

`PendingEffect.replay` 引用阶段 3 的 `Tool.replay?: "safe" | "never"` 元数据。阶段 3 的设计已定稿但尚未实现；实现计划中将"在 `Tool` 接口补齐 `replay` 字段（纯类型声明）"作为前置任务，不涉及阶段 3 其余实现。

## 核心不变量

| 不变量 | 说明 |
|---|---|
| 先持久化，后可见 | `append` 成功才 emit `message_end`；失败的消息不进历史、不对订阅者出现 |
| 只持久化稳定状态转换 | Session Header、完成的 Message、队列变更、工具意图与最终结果；流式增量一律不落盘 |
| 追加式单写 | 每条记录序列化为一整行后单次 append；尾部截断是可接受的正常崩溃形态 |
| 工具永不自动重放 | `effect_started` 无配对 `effect_finished` = outcome unknown，只发诊断事件 |
| dequeue 先于 message 落盘 | 宁可丢一条已取出的队列消息，也不允许恢复后重复投递 |
| 未配置 Store 时行为零变化 | 不传 `sessionStore` 时整个持久化路径不激活，现有测试与调用方不受影响 |
| Store 可替换 | `MemorySessionStore` 与 `JsonlSessionStore` 通过同一组契约测试 |

## 分层与职责边界

```text
packages/core
├── session.ts            ← SessionRecord / SessionMetadata / PendingEffect 等纯类型
├── session-store.ts      ← SessionStore 接口 + JsonlSessionStore + MemorySessionStore
└── （改动）types.ts / agent.ts / agent-loop.ts
```

| 层 | 职责 | 不做什么 |
|---|---|---|
| `SessionStore` | JSONL 追加、读取重放、截断容错 | 不认识 Agent 语义，纯数据层 |
| `SessionCommitter` | 把"写盘成功"作为消息/队列变更可见的前置条件 | 不解析、不重放 |
| `Agent` | 持有 Committer，负责队列（steering/followUp）的持久化与恢复 | 不写工具边界 |
| `AgentLoop` | 在消息定稿和工具边界调用 Committer | 不感知 JSONL |
| 工具 / 插件 | 不直接访问 Store（未来经受限 Session Service） | — |

写入顺序（核心流程）：

```text
消息定稿 → Committer.commitMessages() 成功 → emit(message_end) → 更新 Agent.state
                ↘ 失败 → 不 emit，消息不进历史，错误沿 Turn 传播
```

**关键后果**：持久化失败视同本次 Turn 失败。UI 永远不会看到重启后消失的"幽灵消息"。

## 数据模型

### 消息 ID（types.ts 改动）

四种消息（System / User / Assistant / ToolResult）全部增加**必填** `id: string`。新增可注入生成器：

```ts
export type IdGenerator = () => string; // 默认 crypto.randomUUID
```

挂在 `AgentOptions.idGenerator?`，测试注入确定性 id（如 `id-1, id-2, ...`）。

### SessionRecord（session.ts）

```ts
export interface SessionMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type SessionRecord =
  | { type: "session"; version: 1; metadata: SessionMetadata }
  | { type: "message"; sequence: number; message: AgentMessage }
  | { type: "queue_enqueued"; queue: "steering" | "followUp"; message: AgentMessage }
  | { type: "queue_dequeued"; queue: "steering" | "followUp"; messageId: string }
  | { type: "effect_started"; effect: PendingEffect }
  | { type: "effect_finished"; toolCallId: string };
```

- `sequence` 是**单调递增的提交序号**，由 Committer 维护；恢复时用它校验消息顺序、检测缺洞。
- 配对不变量：`queue_dequeued` 引用的 `messageId` 必须先有对应 `queue_enqueued` 记录。

### PendingEffect

```ts
export interface PendingEffect {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  replay: "safe" | "never"; // 来自阶段 3 的 Tool.replay
}
```

工具 `execute` **之前**写 `effect_started`；Tool Result 落盘成功后写 `effect_finished`。

### SessionStore 接口

```ts
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

`load` 对不存在的 sessionId 抛 `SessionNotFoundError`；`Agent` 捕获后走 create 分支（"打开不存在 = 新建"）。

### JSONL 目录约定

```text
<dataDir>/sessions/<sessionId>.jsonl     ← 一个 Session 一个文件
```

- `dataDir` 由 server 启动参数传入（默认 `./.mini-agent/`）；`JsonlSessionStore` 只收一个绝对目录路径，不关心默认值。
- sessionId 校验为安全文件名（`[A-Za-z0-9_-]`），防止路径穿越；非法 id 在 server 层拒绝。

## 恢复流程与 continue 语义

### 恢复入口

```ts
interface AgentOptions {
  // ...现有字段
  sessionStore?: SessionStore;   // 不传 = 纯内存，行为零变化
  sessionId?: string;            // 传了 = 从 store 恢复；store 里不存在则新建
  idGenerator?: IdGenerator;
}
```

构造时 `sessionStore.load(sessionId)` → 重放 JSONL → 得到 `SessionSnapshot` → 填充 `Agent.state`。

### 恢复重建什么

```text
SessionStore.load(sessionId)
    ↓ 逐行重放 SessionRecord
SessionSnapshot {
  messages,          ← message 记录按 sequence 排序
  steeringQueue,     ← enqueued 减 dequeued
  followUpQueue,     ← 同上
  pendingEffects,    ← started 减 finished
  metadata
}
    ↓
Agent.state.messages / 队列 = snapshot 内容
```

- **明确不重建**：`streamingMessage`、`isStreaming`、进行中的 Promise、AbortController——恢复后 Agent 一定处于空闲态。
- `pendingEffects` 非空 → 恢复完成后发一个 `session_recovery_warning` 事件（携带 outcome unknown 的工具列表），**只诊断、不阻塞**，后续 prompt/continue 照常。
- 新增 `session_committed` 事件：每次成功落盘后发，供 server/web 做"已保存"指示。

### continue() 尾部规则

恢复后能否 `continue()`，看 Transcript 尾部；**对非恢复场景同样生效**（统一语义）：

| 尾部消息 | 行为 |
|---|---|
| User / ToolResult | ✅ 允许——模型还没回答过这条输入 |
| Assistant（完整定稿） | ⛔ 拒绝并抛错——模型已答完，继续会产生无输入的空 Turn |
| 空 Transcript | ⛔ 拒绝——空跑无意义 |

### 队列恢复的边界情况

崩溃发生在 dequeue 落盘后、message 落盘前：该消息恢复后既不在队列也不在历史——**接受丢失**。dequeue 先于 message 落盘是正确顺序：宁可丢一条用户输入，也不能让同一条消息恢复后既在队列里又被投递过。恢复诊断会体现"dequeued 但无对应 message"的情况。

## Server 协议与 Session 管理

### SessionManager（server 新增内部模块）

```text
SessionManager
├── JsonlSessionStore（dataDir 来自启动参数）
├── Map<sessionId, AgentSession>   ← 活跃 Agent 缓存，按需创建/恢复
└── getOrOpen(sessionId): Promise<AgentSession>
```

`open_session` 时：缓存命中直接用；未命中 → `new Agent({ sessionStore, sessionId, ... })`（core 负责恢复）→ 挂进缓存。**Server 不解析 JSONL**，一切恢复逻辑在 core。

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

`parseCommand` 同步扩展校验。新 core 事件 `session_committed` / `session_recovery_warning` **走现有 `event` 通道透传**，server 无需特判。

### 连接与 Session 的绑定

- 每个 WS 连接有"当前 sessionId"；`open_session` 成功后把 socket 从旧 Session 的客户端集合挪到新 Session。
- **兼容性默认值**：连接建立时自动绑定到 `default` Session——现有 web 前端零改动继续运行。
- 未显式 `create_session` 直接 `open_session` 一个存在的 id 即为恢复；id 不存在则新建（与 core 语义一致）。

## 错误处理

| 场景 | 行为 |
|---|---|
| `append` 失败（磁盘满等） | 不 emit `message_end`，消息不进历史；该 Turn 以失败收场，`errorMessage` 进 state |
| `load` 时 sessionId 不存在 | 抛 `SessionNotFoundError` → Agent 走 create 分支写 session header |
| JSONL 最后一行截断 | 丢弃该行 + 记录诊断（崩溃写一半的正常形态） |
| JSONL 中间行损坏 | 抛错——非正常崩溃能造成，说明文件被手工破坏，不静默吞掉 |
| sessionId 含非法字符 | server 层拒绝，回 `session_error` |
| `effect_started` 无 `effect_finished` | 恢复后发 `session_recovery_warning`，不自动重放、不伪装成败 |

JSONL 写入细节：每条记录序列化为一整行后单次 `appendFile` 调用，极小化写一半的窗口；文件句柄不常驻，每次 append 独立打开/关闭——教学项目用性能换简单可靠。

## 测试策略

core 测试全部确定性：注入 `IdGenerator`、`MemorySessionStore`（支持 `failNextAppend()` 故障注入）；Jsonl 实现用 `node:test` 临时目录。

1. **契约测试共享**：同一组用例跑 `MemorySessionStore` 与 `JsonlSessionStore` 两个实现。
2. 新 Session 写 header + 消息；重建 Store 后恢复相同 Transcript。
3. 截断最后半行 → 忽略该记录 + 诊断。
4. `failNextAppend()` → 不 emit `message_end`，消息不进历史。
5. 队列 enqueue/dequeue 重放后状态正确。
6. `effect_started` 无 `effect_finished` → 恢复警告含该 toolCallId。
7. `continue()` 尾部规则：User/ToolResult 尾部可继续；Assistant 尾部/空 Transcript 拒绝。
8. 两个 Session 文件互不影响。
9. server 集成：`open_session` 恢复历史；断线重连先收完整 state 再收增量事件。

## 验收标准

- Server 重启后能够打开已有 Session，已完成消息不丢失、不重复。
- 未知工具结果不会被自动伪装成成功或失败。
- `MemorySessionStore` 可替换 `JsonlSessionStore` 供单元测试使用（同一契约测试通过）。
- 不传 `sessionStore` 的现有调用方与测试零影响。
- 现有 web 前端不修改代码即可连接 `default` Session 正常工作。
