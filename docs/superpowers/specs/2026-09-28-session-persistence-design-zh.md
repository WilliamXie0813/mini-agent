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
- `SessionCommitter` 运行时提交接口：写盘成功是消息定稿、队列变更可见的前置条件。
- 四种 `AgentMessage` 全部增加必填 `id` 字段 + 各构造点可注入 `IdGenerator`。
- `PendingEffect` 副作用记录：工具执行前写 `effect_started`，结果落盘后写 `effect_finished`，被取消写 `effect_cancelled`。
- `reset` 记录：append-only 语义下的 Session 重置。
- 恢复语义：`AgentOptions` 接收 `sessionStore` / `sessionId`，构造时恢复或新建。
- `continue()` 尾部规则（先 drain 队列再判定，对恢复与非恢复场景统一生效）。
- `steer()` / `followUp()` 改为异步方法（队列变更落盘成功才可见）。
- 新事件：`session_committed`、`session_recovery_warning`。
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
| 追加式单写 | 每条记录序列化为一整行后单次 append；尾部截断是可接受的正常崩溃形态 |
| 工具永不自动重放 | `effect_started` 无配对结局记录 = outcome unknown，只发诊断事件；被 abort 的写 `effect_cancelled`，单独成类 |
| dequeue 先于 message 落盘 | 同一批 append 中 `queue_dequeued` 记录排在 `message` 记录之前；宁可丢一条已取出的队列消息，也不允许恢复后重复投递 |
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

export interface SessionCommitter {
  commitMessages(messages: readonly AgentMessage[]): Promise<void>;
  enqueue(queue: QueueName, message: AgentMessage): Promise<void>;
  dequeue(queue: QueueName, messageId: string): Promise<void>;
}
```

- 内部维护**串行写队列**：parallel 模式下多个工具的 `effect_started` commit 来自并发任务，Committer 保证 append 逐条执行、记录顺序与提交顺序一致。
- 队列 drain 与消息定稿是同一批 append：drain 后 Committer 把 `queue_dequeued` 与 `message` 记录合并为一次调用，`dequeued` 在前——`AgentLoopConfig` 的同步 getter 签名保持不变，dequeue 落盘由 Loop 在 drain 之后、emit 之前完成。`Agent.continue()` 启动前的 drain 走同一挂点。

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
  | { type: "queue_enqueued"; queue: QueueName; message: AgentMessage }
  | { type: "queue_dequeued"; queue: QueueName; messageId: string }
  | { type: "effect_started"; effect: PendingEffect }
  | { type: "effect_finished"; toolCallId: string }
  | { type: "effect_cancelled"; toolCallId: string }
  | { type: "reset" };
```

- `sequence` 是**单调递增的提交序号**，由 Committer 维护；恢复时用它校验消息顺序、检测缺洞。
- 配对不变量：`queue_dequeued` 引用的 `messageId` 必须先有对应 `queue_enqueued` 记录。
- `reset` 记录：重放时**丢弃此前全部状态**，只取最后一次 `reset` 之后的记录——保持 append-only，历史可追溯。
- `effect_cancelled`：工具被 abort 取消时的结局记录。取消是用户主动行为，与"崩溃导致 outcome unknown"区分开。

### PendingEffect

```ts
export interface PendingEffect {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  replay: "safe" | "never"; // 来自阶段 3 的 Tool.replay
}
```

写入时机与并发模型的对应关系：

- 工具 `execute` **之前**写 `effect_started`，落盘成功后**才** emit `tool_execution_start`。
- Tool Result 落盘成功后写 `effect_finished`。注意：现有批次模型在整批工具结算后才逐条提交 Tool Result，单个工具完成到其 `effect_finished` 之间隔着整批等待窗口——崩溃窗口略大于"execute 结束即收尾"，可接受。
- Run 取消 / 控制面错误导致已 start 的调用无结果（现有 `tool_execution_cancelled` 事件路径）→ 写 `effect_cancelled`。**正常 abort 不会留下 pendingEffects 告警噪音**。

### SessionStore 接口

```ts
export interface SessionSnapshot {
  metadata: SessionMetadata;
  messages: AgentMessage[];
  steeringQueue: AgentMessage[];
  followUpQueue: AgentMessage[];
  pendingEffects: PendingEffect[];   // started 减去 finished/cancelled
  cancelledEffects: PendingEffect[]; // effect_cancelled 对应的记录，供诊断展示
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

构造时 `sessionStore.load(sessionId)` → 重放 JSONL（只取最后一次 `reset` 之后）→ 得到 `SessionSnapshot` → 填充 `Agent.state`。

### 恢复重建什么

```text
SessionStore.load(sessionId)
    ↓ 逐行重放 SessionRecord（从最后一次 reset 之后开始）
SessionSnapshot {
  messages,          ← message 记录按 sequence 排序
  steeringQueue,     ← enqueued 减 dequeued
  followUpQueue,     ← 同上
  pendingEffects,    ← started 减 finished 减 cancelled
  cancelledEffects,  ← cancelled 对应记录
  metadata
}
    ↓
Agent.state.messages / 队列 = snapshot 内容
```

- **明确不重建**：`streamingMessage`、`isStreaming`、进行中的 Promise、AbortController、WebSocket 客户端集合——恢复后 Agent 一定处于空闲态。
- `pendingEffects` 非空 → 恢复完成后发 `session_recovery_warning` 事件，携带两类清单：`unknown`（崩溃中断，outcome unknown）与 `cancelled`（主动取消，副作用可能部分发生）。**只诊断、不阻塞**，后续 prompt/continue 照常。
- 新增 `session_committed` 事件：每次成功落盘后发，供 server/web 做"已保存"指示。

### continue() 尾部规则

`continue()` 先 drain steering/followUp 队列（现有行为），**再看 drain 后的新尾部**：

| drain 后尾部 | 行为 |
|---|---|
| User / ToolResult（含 drain 出的队列消息） | ✅ 允许——模型还没回答过这条输入 |
| Assistant（完整定稿）且队列已空 | ⛔ 拒绝并抛错——模型已答完，继续会产生无输入的空 Turn |
| 空 Transcript | ⛔ 拒绝——空跑无意义 |

对恢复与非恢复场景统一生效。恢复后尾部是 Assistant（含 error 消息）不算卡死：`prompt()` 永远可用，继续对话走新输入。

### 失败消息的持久化

`emitFailure` 合成的 error/aborted Assistant 消息**照常尝试落盘**（它是已提交的终态）；若本次 Turn 失败的原因本身就是 append 失败，则该消息的 commit 大概率再次失败——**失败即丢弃，不再递归处理**，错误只进 `state.errorMessage`。

### 队列恢复的边界情况

崩溃发生在 dequeue 落盘后、message 落盘前：由于两者在同一批 append 中，该窗口极小；若仍发生（批内部分写入+截断），截断容错丢弃尾部不完整记录，消息恢复后既不在队列也不在历史——**接受丢失**，恢复诊断体现"dequeued 但无对应 message"。

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

`open_session` 时：缓存命中直接用；未命中 → `AgentFactory` 装配 `new Agent({ sessionStore, sessionId, ... })`（core 负责恢复）→ 挂进缓存。**Server 不解析 JSONL**，一切恢复逻辑在 core。教学项目的 mock stream 对恢复出的历史照常工作（它不依赖历史内容）。

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

`parseCommand` 返回值加富为判别结果（合法命令 / 非法参数 / 不认识的命令），以区分"Unrecognized command"与"sessionId 非法 → `session_error`"。新 core 事件 `session_committed` / `session_recovery_warning` **走现有 `event` 通道透传**，server 无需特判。

### 连接与 Session 的绑定

- 每个 WS 连接有"当前 sessionId"；`open_session` 成功后把 socket 从旧 Session 的客户端集合挪到新 Session。
- **兼容性默认值**：连接建立时自动绑定到 `default` Session——现有 web 前端运行时零改动继续工作。
- 未显式 `create_session` 直接 `open_session` 一个存在的 id 即为恢复；id 不存在则新建（与 core 语义一致）。
- 同一 session 的两个连接并发 `prompt` 会撞现有 `assertIdle` 抛错，错误沿现有 catch 回到发起方——行为可接受，测试钉死。

### reset 的持久化语义

`reset` 命令：Agent 清空内存状态并向 JSONL 追加 `{ type: "reset" }` 记录，随后广播现有 `reset` 消息。**不删文件、不截断**——重放时只取最后一次 reset 之后的内容，历史完整可追溯。

## 错误处理

| 场景 | 行为 |
|---|---|
| `append` 失败（磁盘满等） | 非流式消息不 emit `message_start`；流式消息不 emit `message_end`；消息不进历史，Turn 以失败收场，`errorMessage` 进 state |
| emitFailure 的 error 消息落盘失败 | 丢弃该消息，不递归；错误只进 state |
| `load` 时 sessionId 不存在 | 抛 `SessionNotFoundError` → Agent 走 create 分支写 session header |
| JSONL 最后一行截断 | 丢弃该行 + 记录诊断（崩溃写一半的正常形态） |
| JSONL 中间行损坏 | 抛错——非正常崩溃能造成，说明文件被手工破坏，不静默吞掉 |
| sessionId 含非法字符 | server 层拒绝，回 `session_error`（parseCommand 判别结果区分） |
| `effect_started` 无结局记录 | 恢复后发 `session_recovery_warning`（unknown 类），不自动重放、不伪装成败 |
| 工具被 abort 取消 | 写 `effect_cancelled`，恢复警告中单独列为 cancelled 类，不算 unknown |

JSONL 写入细节：每条记录序列化为一整行后单次 `appendFile` 调用，极小化写一半的窗口；文件句柄不常驻，每次 append 独立打开/关闭——教学项目用性能换简单可靠。并发工具的多次 append 由 Committer 内部串行写队列排序。

## 测试策略

core 测试全部确定性：注入 `IdGenerator`（各构造点统一 helper）、`MemorySessionStore`（支持 `failNextAppend()` 故障注入）；Jsonl 实现用 `node:test` 临时目录。现有测试的消息字面量统一迁移到带确定性 id 的构造 helper。

1. **契约测试共享**：同一组用例跑 `MemorySessionStore` 与 `JsonlSessionStore` 两个实现。
2. 新 Session 写 header + 消息；重建 Store 后恢复相同 Transcript。
3. 截断最后半行 → 忽略该记录 + 诊断。
4. `failNextAppend()` → 非流式消息不 emit `message_start`，流式消息不 emit `message_end`，消息不进历史。
5. 队列 enqueue/dequeue 重放后状态正确；dequeue 与 message 记录在同批 append 中且顺序正确。
6. `effect_started` 无结局 → 恢复警告 unknown 类含该 toolCallId；`effect_cancelled` → 归 cancelled 类，不产生 unknown 告警。
7. `continue()` 尾部规则：drain 后 User/ToolResult 尾部可继续；Assistant 尾部/空 Transcript 拒绝；现有"assistant 尾部 + 队列非空可继续"路径回归不破。
8. 两个 Session 文件互不影响。
9. `reset` 记录：重放只取最后一次 reset 之后；reset 前的历史仍在文件中。
10. server 集成：`open_session` 恢复历史；断线重连先收完整 state 再收增量事件；同 session 并发 prompt 第二个收到错误。

## 验收标准

- Server 重启后能够打开已有 Session，已完成消息不丢失、不重复。
- 未知工具结果不会被自动伪装成成功或失败；主动取消的工具不产生 unknown 告警。
- `MemorySessionStore` 可替换 `JsonlSessionStore` 供单元测试使用（同一契约测试通过）。
- 不传 `sessionStore` 的调用方**运行时行为**零变化（消息加必填 id 的类型层连带由构造 helper 统一消化）。
- 现有 web 前端不修改代码即可连接 `default` Session 正常工作。
