# 阶段 7：动态工具与模型切换

## 当前问题

当前 `Agent` 构造后：

- `stream` 是只读字段。
- 工具表只在初始化时传入。
- System Message 不记录工具变化。
- Turn 执行过程中没有安全的配置切换点。

真实 Agent 可能需要：

- 用户切换模型。
- 根据任务启用或禁用工具。
- 插件注册新工具。
- 在长上下文时切换大窗口模型。

本阶段解决“**运行时能力如何变化，同时保持 Transcript 可解释和执行安全**”。

## 学习目标

- 将模型与工具从静态构造参数变为可版本化运行时状态。
- 只在安全边界应用配置变化。
- 让模型看到的工具声明与 Runtime 可执行工具一致。
- 保证 Session 恢复后可以重放能力变化。

## 非目标

- 不实现模型自动评分和路由。
- 不动态安装 npm 插件。
- 不允许任意远程代码注册工具。
- 不在 Tool 执行中途切换其实现。

## 方案比较

### 方案 A：直接公开 `agent.state.tools`

调用简单，但运行中的批次可能突然找不到工具，且无法审计变化。

### 方案 B：每次 Prompt 新建 Agent

隔离清晰，但会丢失队列、订阅者和运行状态。

### 方案 C：版本化 Registry + Turn 边界切换，推荐

模型和工具都有稳定引用，变更先排队，在下一安全边界生效。

## ModelRuntime

```ts
export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface ModelDefinition {
  ref: ModelRef;
  stream: StreamFn;
  contextWindow: number;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
}

export interface ModelRegistry {
  get(ref: ModelRef): ModelDefinition | undefined;
  list(): readonly ModelDefinition[];
}
```

`AgentState` 增加当前 `modelRef`，而不是直接暴露 Provider Secret。

## ToolRegistry

```ts
export interface ToolRegistrySnapshot {
  version: number;
  tools: readonly Tool<unknown>[];
}

export interface ToolRegistry {
  snapshot(): ToolRegistrySnapshot;
  register(tool: Tool<unknown>): void;
  remove(name: string): void;
}
```

每个 Turn 使用固定 Snapshot：

```text
Turn 开始
→ 捕获 toolRegistry version 4
→ 该 Turn 全程使用 version 4
→ Turn 结束后才应用 version 5
```

这样工具执行过程中不会被替换。

## 变更请求

`Agent` 提供：

```ts
agent.requestModelChange(modelRef);
agent.requestToolChange({
  enable: ["read", "grep"],
  disable: ["write"],
});
```

如果 Agent 空闲，可以立即应用；如果正在运行，则进入配置队列，在下一 Turn 前应用。

不要让 `steer()` 承担配置变更。用户消息和 Runtime 控制命令是不同协议。

## Transcript 中的能力变化

模型需要知道工具集合变化。增加 System Update Message：

```ts
export interface SystemUpdateMessage {
  role: "system";
  content: string;
  toolsAdded?: ToolDeclaration[];
  toolsRemoved?: string[];
  modelChanged?: ModelRef;
  timestamp: number;
}
```

在变更生效时写入 Transcript：

```text
system update: remove write, add grep
```

恢复 Session 时重放 System Update，才能得到相同工具状态。

## 安全边界

以下时机不能直接切换：

- 模型流正在生成。
- 工具批次正在执行。
- `beforeToolCall` 已通过但 Tool 尚未开始。
- Session Commit 尚未完成。

推荐应用点：

```text
prepareNextTurn
→ 持久化 System Update
→ 更新 Model/Tool Snapshot
→ turn_start
```

## 插件关系

当前 `packages/plugins` 为空壳。本阶段只定义插件可以贡献的声明：

```ts
export interface AgentPlugin {
  id: string;
  tools?: readonly Tool<unknown>[];
  models?: readonly ModelDefinition[];
}
```

插件加载、隔离和权限不在本阶段实现。Registry 只接收已经由宿主信任并实例化的对象。

## Server 协议

增加控制命令：

```ts
type ClientCommand =
  | { type: "setModel"; model: ModelRef }
  | { type: "setTools"; enabled: string[] };
```

Server 必须验证目标存在，不允许 Web 客户端传入可执行代码或 Provider Secret。

状态增加：

```ts
model: ModelRef;
availableModels: ModelSummary[];
enabledTools: string[];
availableTools: ToolSummary[];
```

## 模型切换与上下文兼容

切换模型前检查：

- 新模型上下文窗口是否足够。
- 新模型是否支持工具调用。
- 当前历史中的 Tool Call ID 和消息格式是否可转换。
- 结构化输出模式是否受支持。

不兼容时应拒绝切换或先触发上下文压缩，不能静默丢历史。

## 测试策略

1. 空闲时切换模型立即生效。
2. 运行中请求切换，在下一 Turn 才生效。
3. 当前 Tool Batch 始终使用同一 Registry Snapshot。
4. 禁用工具后模型声明与可执行工具一致。
5. Session 恢复能重放模型和工具变化。
6. 不存在的模型/工具产生明确错误。
7. 不支持工具的模型不能在启用工具时被选中。
8. Server 命令不能注入函数或 Secret。

## 验收标准

- 每个 Turn 使用明确的模型和工具版本。
- 能力变化可观察、可持久化、可恢复。
- Agent Loop 不依赖某个具体 Model Registry 实现。
- Plugin 贡献不会绕过宿主验证。

## 学习练习

1. 在第一个 Tool Result 后请求切换模型，记录生效 Turn。
2. 运行中禁用 `read`，确认当前调用完成、下一 Turn 才不可用。
3. 恢复包含两次模型切换的 Session。
4. 尝试切换到不支持工具的模型，设计错误信息。

## 进入下一阶段前

你应该能够回答：

- 为什么模型切换不是普通 User Message？
- 为什么工具表需要版本化 Snapshot？
- 为什么能力变化必须写进可恢复历史？

