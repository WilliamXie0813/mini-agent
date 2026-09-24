# Web UI 设计：聊天 + 内部状态可视化

日期：2026-09-24
前置设计：[2026-09-23-minimal-mock-agent-design-zh.md](./2026-09-23-minimal-mock-agent-design-zh.md)

## 目的

为现有的最小化 Mock Agent 构建一个浏览器图形界面，延续项目的教学定位：**既是一个可用的聊天界面，又让 agent 的内部运行过程（事件流、turn 边界、队列、工具调用）完全可见**。

Agent 运行在 Node 服务端，浏览器通过 WebSocket 连接——刻意选择贴近真实产品（如 Claude Code Web）的架构，而不是把 agent 直接跑在浏览器里。

## 范围

### v1 包含

- 基本对话：输入 prompt、流式渲染回复
- 运行控制：abort、reset、空闲/运行中状态指示
- steer / followUp：运行中插入 steering 消息、排队 followUp，队列状态可见
- 内部状态面板：事件流时间线、完整消息历史、pendingToolCalls
- 工具调用可视化：参数、校验结果、执行结果以卡片形式嵌入对话流
- pnpm workspaces monorepo 改造（core / server / web 三包）

### v1 不包含

- 多会话管理与持久化（依赖 core 未来的 SessionStore 扩展）
- 真实模型适配器
- 断线断点续传（重连后重新拉取全量快照）
- E2E 测试（Playwright 等）
- 移动端适配

## Monorepo 结构

工具：**pnpm workspaces**（不加 Turborepo/Nx，规模不需要）。

```text
mini-agent-v2/
├── package.json              # 根：私有，仅编排脚本（dev/test/check）
├── pnpm-workspace.yaml
├── tsconfig.base.json        # 共享 TS 配置
├── packages/
│   ├── core/                 # 现有 agent 原样搬入，保持零依赖
│   │   ├── src/ (types / mock-llm / tools / agent-loop / agent)
│   │   └── test/             # 现有 node:test 测试原样保留
│   ├── server/               # Node 服务端
│   │   └── src/
│   │       ├── index.ts      # 启动 HTTP + WebSocket 服务
│   │       ├── session.ts    # 持有 Agent 实例，桥接事件与命令
│   │       └── protocol.ts   # 消息编解码与类型（web 共用）
│   └── web/                  # React + Vite + antd + Tailwind v3
│       └── src/
│           ├── components/   # Sidebar / ChatPanel / Composer / InspectorPanel
│           └── hooks/        # useAgentClient（WS 连接 + 状态归约）
└── docs/
```

依赖方向：`server → core`；`web → core`（仅类型）。协议消息类型定义在 `server/protocol.ts`，`web` 通过 workspace 以 **type-only import** 引用这些类型——不产生运行时依赖，前后端唯一的运行时耦合就是 WebSocket 上的 JSON 消息。

关键决策：

1. **`core` 保持零依赖**，原测试全部保留，搬包后全部通过即证明搬迁无损。
2. **服务端依赖**：`ws`（WebSocket 库，最小经典选择）；HTTP 静态服务用 `node:http`，生产模式托管 `web` 构建产物。
3. **v1 单会话**：服务端启动时创建一个 `Agent` 实例，所有连接的客户端共享。

## WebSocket 协议与数据流

原则：复用 core 已有的事件模型，不发明第二套词汇。

### 客户端 → 服务端（命令）

```ts
type ClientCommand =
  | { type: "prompt"; content: string }
  | { type: "steer"; content: string }
  | { type: "followUp"; content: string }
  | { type: "abort" }
  | { type: "reset" };
```

### 服务端 → 客户端

```ts
type ServerMessage =
  // 事件直通：agent.subscribe() 的每个事件原样转发
  | { type: "event"; event: AgentEvent }
  // 状态快照：新客户端连接时下发一次全量状态
  | { type: "snapshot"; state: SerializableAgentState }
  // 命令执行错误（如运行中重复 prompt）
  | { type: "error"; message: string };
```

`SerializableAgentState` 与 `AgentState` 的唯一区别是 `pendingToolCalls: string[]`（`Set` 无法 JSON 序列化，转成数组）。

### 数据流

1. 浏览器连接 WS → 服务端立即发 `snapshot`（当前消息历史 + isStreaming 等），客户端渲染初始界面。
2. `Agent` 每发出一个事件，`session.ts` 包装成 `event` 消息广播给所有客户端。
3. 前端 `useAgentClient` hook 内运行一个与 `Agent.processEvent` **同构的归约器**，把事件流增量还原为 `AgentState`——事件溯源在前后端分离场景的教学演示。
4. UI 操作（发送 / steer / followUp / abort / reset）翻译成命令消息，`session.ts` 调用对应 `Agent` 方法；方法抛错则回发 `error` 消息。
5. 断线重连：客户端指数退避自动重连，重连成功后重新收 snapshot 覆盖本地状态。不做消息序号与断点续传。

## 前端 UI

布局：**三栏**，检查器默认隐藏，顶栏按钮切换（两栏 ⇄ 三栏）。

```text
┌──────────┬───────────────────────────┬────────────────────┐
│ Sidebar  │      ChatPanel            │  InspectorPanel    │
│          │                           │  （默认隐藏）        │
│ · 连接状态│  · MessageList            │  Tabs:             │
│ · agent  │    - 用户/助手气泡          │   · 事件流时间线     │
│   状态摘要│    - 工具调用卡片（嵌入流中）│   · 消息历史(JSON)  │
│ · Reset  │    - 流式中消息（打字效果）  │   · 队列与          │
│   按钮    │  · Composer               │     pendingToolCalls│
│          │    - 输入框 + 发送          │                    │
│          │    - 运行中变为 steer/      │                    │
│          │      followUp + abort      │                    │
└──────────┴───────────────────────────┴────────────────────┘
```

### 组件职责

- **`ChatPanel`** — 对话流。assistant 消息流式渲染；工具调用以卡片嵌入消息流（工具名、参数、校验/执行状态、可折叠的结果）。
- **`Composer`** — 输入区，随 agent 状态变形：空闲时主按钮为「发送」；运行中变为「Steer」「FollowUp」两个按钮 + 红色「Abort」。让队列语义在 UI 上可感知。
- **`InspectorPanel`** — antd `Tabs` 三页：
  - 事件流时间线：每个事件一行，类型着色 + 时间戳，可展开查看 payload；
  - 消息历史：完整 transcript 的 JSON 树（含 system / toolResult）；
  - 队列与状态：steering / followUp 队列内容、pendingToolCalls、isStreaming、errorMessage。
- **`Sidebar`** — 连接状态指示灯、agent 流式状态、当前 turn 数、Reset 按钮。v1 内容从简，为未来多会话导航预留位置。

### 状态管理

不引入 Redux/Zustand。`useAgentClient` hook 持有 WS 连接与归约后的 `AgentState`，通过 `useSyncExternalStore` 暴露给组件——与 core 的 `subscribe()` 模式呼应。

### 样式

- 组件骨架：**Ant Design v5**（成熟度优先）。
- 布局与细节：**Tailwind CSS v3**（明确不用 v4）。
- 集成：关闭 Tailwind 的 preflight（`corePlugins: { preflight: false }`），避免与 antd 自带 reset 冲突。

## 错误处理

- **服务端**：`Agent` 方法抛错（状态错误如运行中重复 `prompt`）→ 捕获并回发 `{ type: "error", message }`；agent 内部的工具/模型错误本就以事件表达，原样直通。WS 消息解析失败 → 记日志、不断连。
- **前端**：WS 断开 → 连接指示灯变红 + antd notification + 指数退避自动重连；收到 `error` 消息 → 在对话流中以错误提示展示。
- **core 不变**：`stopReason: "error" | "aborted"` 语义沿事件流原样到达 UI。

## 测试

| 层 | 工具 | 内容 |
|---|---|---|
| `core` | `node:test`（现有） | 原测试不动，搬包后全部通过 |
| `server` | `node:test` + `ws` 客户端 | 协议层：连接收 snapshot；prompt 命令触发事件广播；abort / steer / followUp / reset 命令到达 Agent；错误消息格式 |
| `web` | Vitest + Testing Library | 归约器：喂事件序列断言 `AgentState`；组件冒烟：Composer 随状态变形、Inspector 折叠展开 |

不做 E2E；手工 `pnpm dev` 验证完整流程。

## 成功标准

`pnpm dev` 一条命令同时启动 server 与 web；在 UI 中发送「读取 package.json，并告诉我项目名称」，能够：

- 看到 assistant 回复流式出现；
- 看到 `read` 工具调用卡片（参数、执行状态、结果）嵌入对话流；
- 展开检查器看到事件时间线同步滚动（`agent_start` → `turn_start` → `message_*` → `tool_execution_*` → … → `agent_end`）；
- 运行中使用 steer / followUp / abort，队列与状态面板如实反映；
- 最终答案包含 `mock-agent-demo`。
