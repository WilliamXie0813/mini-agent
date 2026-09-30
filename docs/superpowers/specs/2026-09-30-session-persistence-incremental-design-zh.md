# Session 持久化递进实现设计

日期：2026-09-30  
完整设计：[Session 持久化与恢复设计](./2026-09-28-session-persistence-design-zh.md)  
来源：[阶段 4：Session 持久化与恢复](../../extension/04-session-persistence.md)

## 目的

把完整的 Session 持久化与恢复需求拆分为一组可独立运行、独立测试、逐步学习的小需求。

本设计不改变完整设计的最终架构和语义，只调整实现顺序。每一步只引入一个主要概念，完成后代码仍可运行、测试仍可通过，并为下一步提供稳定接口。

## 拆分原则

1. 先建立数据基础，再接入 Agent 运行时，最后接入 Server。
2. 每个小需求都有可观察结果，而不只是新增未使用的类型。
3. 先实现成功路径，再用独立步骤集中验证失败语义。
4. 不为了阶段性演示引入最终会被删除的临时架构。
5. 每一步明确非目标，避免提前吸收后续复杂度。
6. 每一步独立提交，并运行 `pnpm test` 与 `pnpm check`。

## 总体路线

```text
稳定消息身份
    ↓
Session 领域模型与纯重放
    ↓
Memory / JSONL Store
    ↓
Transcript 持久化与恢复
    ↓
提交失败语义
    ↓
队列原子恢复
    ↓
工具副作用诊断
    ↓
生命周期补全
    ↓
Server 默认 Session
    ↓
Server 多 Session
```

前 3 步建立数据基础，第 4–8 步逐项完成 Core 语义，第 9–10 步接入 Server。

## 小需求 1：稳定消息身份

### 学习目标

理解持久化记录为什么不能依赖数组位置或对象引用，而需要跨进程稳定的身份。

### 范围

- 四种 `AgentMessage` 增加必填 `id: string`。
- 新增 `IdGenerator = () => string`，默认使用 `crypto.randomUUID`。
- System/User、Assistant、ToolResult 的实际构造点分别支持注入生成器。
- 测试统一使用确定性 ID helper。
- 在 `Tool` 接口补齐后续恢复需要的 `replay?: "safe" | "never"` 类型声明。

### 非目标

- 不增加 Session 类型。
- 不写文件。
- 不改变 Agent 的运行时行为和事件顺序。

### 验收

- 每条消息在创建时获得一次 ID。
- 流式 Assistant 的 start/update/end 使用同一个消息 ID。
- 工具结果 ID 与 `toolCallId` 相互独立。
- 现有测试通过，且测试断言不依赖随机值。

## 小需求 2：Session 领域模型与纯重放

### 学习目标

理解事件日志与当前状态的区别：JSONL 保存稳定状态转换，Snapshot 是重放后的派生状态。

### 范围

- 新增 `session.ts`，定义：
  - `JsonValue`
  - `SessionMetadata`
  - `PendingEffect`
  - `SessionOperation`
  - `SessionRecord`
  - `SessionSnapshot`
  - `SessionRecoveryWarning`
- Commit Envelope 包含统一递增的 `sequence`、`timestamp` 和 `operations`。
- 新增无 I/O 的纯重放逻辑，输入 Session Records，输出 Snapshot。
- 重放规则覆盖 message、queue、effect 和 reset。
- 加入 `toJsonValue()`，在副作用发生前拒绝不可序列化参数。

### 非目标

- 不实现 Store。
- 不接入 Agent。
- 不处理文件路径和 JSONL 文本。

### 验收

- 手工构造 Records 可以重放出 messages、两个队列、pending/cancelled effects 和 metadata。
- sequence 缺洞、倒退或重复时失败。
- dequeue 引用不存在的 enqueue 时失败。
- reset 清空消息与队列，但保留副作用审计状态。

## 小需求 3：可替换 Session Store

### 学习目标

理解存储接口、存储实现与领域重放逻辑的职责边界。

### 范围

- 定义 `SessionStore`：
  - `create()`
  - `load()`
  - `append()`
  - `list()`
- 实现 `MemorySessionStore`。
- 实现 `JsonlSessionStore`。
- 两个实现复用小需求 2 的重放逻辑。
- 建立两个实现共用的契约测试。
- Memory 实现提供 `failNextAppend()` 故障注入。
- JSONL 实现处理安全 sessionId、尾行截断和中间坏行。

### 非目标

- Store 不认识 Agent、事件或工具执行。
- 不实现多进程并发写。
- 不接入 Server。

### 验收

- 两个 Store 通过同一组契约测试。
- Session 之间数据隔离。
- 尾部不完整 JSON 行被整行丢弃并产生诊断。
- 中间损坏行、非法 sequence 和非法 sessionId 明确失败。
- 可以手工打开 JSONL 并按顺序解释 Header 与 Commit。

## 小需求 4：Transcript 持久化闭环

### 学习目标

建立第一条端到端链路：消息写入、进程重建、历史恢复和继续对话。

### 范围

- 定义 `SessionCommitter`，内部串行化 append。
- 实现 `openOrCreateSession()`。
- `AgentOptions` 支持成对传入 `initialSession` 与 `sessionCommitter`。
- 恢复 Agent 直接使用 Snapshot Messages，不重复创建 System Message。
- Agent Loop 只在完整消息边界提交消息，不保存流式增量。
- 未配置 Session 时维持原有运行时行为。

### 数据流

```text
非流式消息：
构造 → commit → message_start → message_end → 历史

流式 Assistant：
message_start → message_update × N → commit → message_end → 历史
```

### 非目标

- 暂不持久化 steering/follow-up 队列。
- 暂不记录工具副作用边界。
- 暂不接入 Server。

### 验收

- 新 Session 写入 Header 与初始 System Message。
- prompt 完成后重建 Store 和 Agent，可以恢复相同 Transcript。
- 恢复后可以继续发送新的 prompt，且历史不丢失、不重复。
- `initialSession` 与 `sessionCommitter` 半配置时构造失败。

## 小需求 5：提交失败语义

### 学习目标

理解“先持久化，后定稿”不是实现细节，而是防止幽灵消息的事务边界。

### 范围

- 使用 `failNextAppend()` 覆盖每类消息的失败路径。
- 持久化失败视为本次 Turn 失败。
- 失败终态 Assistant 仍尝试提交；若提交再次失败则丢弃，不递归处理。
- 内部 `errorMessage` 可以反映失败，但不能伪造已定稿消息。

### 验收

- User/ToolResult 提交失败时不发送任何消息事件，也不进入历史。
- Assistant 提交失败时不发送 `message_end`，也不进入历史。
- Store 中不存在未成功提交的消息。
- 失败不会产生无限递归或成功形状的回退结果。

## 小需求 6：队列持久化与原子恢复

### 学习目标

理解为什么“从队列删除”和“写入 Transcript”必须属于同一个逻辑提交。

### 范围

- `steer()` / `followUp()` 改为异步方法。
- enqueue 持久化成功后才进入内存队列。
- 队列读取从立即删除改为 Reservation。
- `queue_dequeued` 与对应 `message` 写入同一个 Commit Envelope。
- Commit 成功后 acknowledge；失败后释放 Reservation，消息仍留在队列。
- Agent Loop 配置改为 reserve/acknowledge 接口。

### 非目标

- 不改变 steering 与 follow-up 的调度策略。
- 不增加队列优先级和批量消费模式。

### 验收

- enqueue 失败时内存队列不变化。
- dequeue Commit 失败时消息仍可再次预留。
- 尾行截断后恢复结果要么同时包含队列消息，要么同时包含 Transcript 消息，不出现半提交。
- 原有“Assistant 尾部但队列非空可继续”路径仍可工作。

## 小需求 7：工具副作用边界

### 学习目标

理解外部副作用与普通状态不同：进程崩溃后可能无法判断工具到底有没有完成。

### 范围

- 工具执行前提交 `effect_started`。
- started 成功后才发送 `tool_execution_start` 并调用工具。
- Tool Result 成功提交后记录 `effect_finished`。
- abort 或控制面取消记录 `effect_cancelled`。
- Snapshot 区分 pending 与 cancelled effects。
- 恢复时生成稳定的 recovery warnings。

### 非目标

- 不自动重放 `safe` 工具。
- 不把 unknown 伪装成成功或失败。
- 工具和插件不直接访问 Store。

### 验收

- `effect_started` 无结局时恢复为 unknown 警告。
- cancelled effect 单独归类，不产生 unknown 警告。
- started 提交失败时工具不会执行。
- 并发工具的 Commit 不发生行内容交错。

## 小需求 8：生命周期补全

### 学习目标

把 reset、continue、恢复警告和日志校验统一成可解释的恢复状态机。

### 范围

- reset 作为追加式 Operation，提交成功后才更新内存和广播。
- reset 清空消息与队列，但不抹除副作用审计状态。
- `continue()` 先考虑可预留队列消息，再按最终尾部角色判断。
- Assistant 尾部且队列为空时拒绝 continue。
- 空 Transcript 或只有 System Message 时拒绝 continue。
- `updatedAt` 取最后一个有效 Commit timestamp。
- Snapshot 中稳定保存 recovery warnings。

### 验收

- reset 后重启仍只恢复新的 System Message 和 reset 后历史。
- reset 提交失败时内存状态不变。
- User/ToolResult 尾部可 continue。
- Assistant 尾部无队列时明确失败，但仍可使用 prompt 开启新对话。
- pending/cancelled effect 诊断不会因 reset 丢失。

## 小需求 9：Server 默认 Session

### 学习目标

先验证 Core 持久化能够接入真实 Server 生命周期，而不同时引入多 Session 协议。

### 范围

- Server 使用配置的数据目录创建 `JsonlSessionStore`。
- 启动时打开或创建 `default` Session。
- 使用恢复出的 Snapshot 和 Committer 构造现有 `AgentSession`。
- 保持现有客户端命令与消息协议不变。
- 连接后先发送恢复出的完整 State。

### 非目标

- 不增加 Session 列表 UI。
- 不支持客户端切换 Session。
- 不实现 `SessionManager` 缓存。

### 验收

- 现有 Web 客户端无需运行时代码修改即可连接。
- Server 重启后 `default` Session 的完成消息不丢失、不重复。
- 重启后的 Agent 处于空闲态，不恢复 Promise、AbortController 或 WebSocket 集合。

## 小需求 10：Server 多 Session

### 学习目标

在已验证的单 Session 集成之上，学习多实例生命周期、连接绑定和并发初始化去重。

### 范围

- 新增 `SessionManager`：
  - Store
  - AgentFactory
  - 活跃 AgentSession 缓存
  - in-flight open Promise 缓存
- 协议增加：
  - `list_sessions`
  - `create_session`
  - `open_session`
- 每个 WebSocket 绑定一个当前 Session。
- open 成功后从旧 Session 客户端集合迁移到新集合。
- 发送顺序固定为完整 State 在前，recovery warnings 在后。
- 非法 sessionId 和 Session 协议参数返回 `session_error`。

### 非目标

- 不调度同一 Session 的并发 prompt；继续使用 Agent 的 `assertIdle`。
- 不做权限、多用户隔离或 Session 分支。
- 不实现 Web Session 列表和警告展示。

### 验收

- 两个 Session 的 Transcript 和队列互不影响。
- 两个连接并发打开同一未缓存 Session 时只构造一个 AgentSession。
- 连接切换后只收到当前 Session 的事件。
- Recovery Warning 不会因 Agent 构造期间没有订阅者而丢失。

## 组件边界

| 组件 | 负责 | 不负责 |
|---|---|---|
| Session 重放器 | 从 Records 推导 Snapshot，校验领域不变量 | 文件 I/O、Agent 行为 |
| SessionStore | create/load/append/list 与存储格式 | 消息定稿、工具执行 |
| SessionCommitter | 串行逻辑提交，把稳定转换包装成 Commit | 解析 JSONL、恢复状态 |
| Agent | 持有历史和队列，发起持久化操作 | 直接读写文件 |
| Agent Loop | 在消息与工具边界调用 Committer | Session 文件管理 |
| SessionManager | 创建、缓存和切换 Server Session | 解析 JSONL、自动重放工具 |

## 错误处理原则

- 所有稳定状态都先持久化，成功后才修改内存或对外定稿。
- 不使用 broad catch 把损坏日志转换为空 Session。
- 尾行截断是可恢复崩溃形态；中间坏行是数据损坏，必须失败。
- 外部副作用结果未知时只报告事实，不猜测结果。
- 未配置持久化时保持现有运行时行为。
- Server 负责协议错误，Core 负责 Session 领域与存储错误。

## 测试与学习练习

每个小需求完成时运行：

```bash
pnpm test
pnpm check
```

对应的观察练习：

1. 打印确定性消息 ID，观察不同消息的身份关系。
2. 手工编写 Commit Records，并预测重放后的 Snapshot。
3. 打开 JSONL，逐行解释 Header、sequence 和 operations。
4. 完成一次“写入—重建—恢复—继续”。
5. 注入 append 失败，确认 UI 不会看到已定稿幽灵消息。
6. 截断 dequeue/message 所在的最后一行，确认队列消息仍可恢复。
7. 删除 `effect_finished`，观察 unknown 警告且工具不会重放。
8. reset 后检查旧记录仍在文件中，但 Snapshot 只反映新历史。
9. 重启 Server，确认默认 Session 自动恢复。
10. 打开两个 Session，确认消息和事件隔离。

## 最终非目标

- SQLite 存储。
- 多进程并发写同一 Session。
- 分支 Session。
- 自动重放任何工具。
- Web Session 列表和恢复警告 UI。
- 权限与多用户隔离。

## 完成定义

只有满足以下条件，一个小需求才算完成：

1. 本步范围内的行为已实现。
2. 针对性测试覆盖成功路径和本步引入的错误路径。
3. 全仓测试与类型检查通过。
4. 有一个可以手工观察或解释的学习练习。
5. 没有提前实现后续步骤，也没有引入下一步必须删除的临时接口。
6. 形成独立提交，提交内容只对应当前小需求。
