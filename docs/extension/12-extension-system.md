# 阶段 12：Extension 插件系统

## 当前基线与问题

前十一阶段已经提供大量能力，但每增加一个产品功能都直接修改 `packages/core` 会产生问题：

- Agent Loop 越来越复杂。
- 第三方能力与核心版本强耦合。
- 工具、命令、Hook 和 UI 扩展没有统一生命周期。
- 插件可能捕获已经失效的 Session 引用。
- 一个插件失败可能拖垮整个 Agent。

当前仓库已经有 `packages/plugins`，但尚未形成完整宿主协议。

本阶段解决“**怎样让受信任模块扩展 Agent，同时保持核心边界、生命周期和错误隔离**”。

## 学习目标

- 区分 Extension Factory、Extension Instance、Host API 和 Runtime Actions。
- 设计注册阶段与运行阶段。
- 支持工具、事件 Hook 和命令扩展。
- 在 Reload 或 Session Replacement 后使旧 Context 失效。
- 对插件冲突、加载失败和 Hook 错误给出明确诊断。

## 非目标

- 不把 Extension 当作安全沙箱。
- 不从网络自动下载并执行未知代码。
- 不允许插件直接修改 Agent 私有状态。
- 不在第一版实现自定义 TUI Component。
- 不保证任意 npm 包都能在 Extension 环境运行。

## Pi 中值得学习的设计

Pi 的 Extension 系统提供：

- 生命周期事件订阅。
- 工具、命令、快捷键、Provider 和资源注册。
- 受控 UI 与 Session Action。
- Loader、Runner 与 Extension 类型分离。
- 加载阶段先收集注册项，再统一 Commit。
- Session 切换或 Reload 后使旧 Context 变为 Stale。
- 单独记录 Extension Error，而不是让所有错误混入 Agent Error。

教学版先实现最小但完整的子集：

```text
注册工具
注册命令
订阅生命周期事件
调用受限 Agent Actions
Reload
```

## 方案比较

### 方案 A：插件直接拿到 Agent 实例

能力最强，但插件可以修改任意字段、绕过事件和持久化。

### 方案 B：只允许配置文件

安全简单，但无法实现动态行为和 Hook。

### 方案 C：Extension Host + Capability API，推荐

```text
Extension Factory
      ↓ register
Extension Definition
      ↓ validate/commit
Extension Runner
      ↓ events/actions
Agent Runtime
```

插件只能使用 Host 明确暴露的能力。

## 模块边界

```text
packages/plugins/src/
├── types.ts
├── loader.ts
├── host.ts
├── runner.ts
├── registry.ts
└── diagnostics.ts
```

### `loader.ts`

找到并加载 Extension Factory。

### `registry.ts`

收集工具、命令和事件处理器，检测冲突。

### `host.ts`

提供受限操作能力。

### `runner.ts`

按顺序分发事件，管理错误和生命周期。

## Extension 定义

```ts
export interface ExtensionManifest {
  id: string;
  version: string;
  description?: string;
}

export interface ExtensionFactory {
  (
    api: ExtensionRegistrationAPI,
  ): void | Promise<void>;
}

export interface LoadedExtension {
  manifest: ExtensionManifest;
  sourcePath: string;
  dispose?: () => void | Promise<void>;
}
```

第一版只加载宿主显式配置的本地模块，不自动扫描全部项目文件。

## 注册 API

```ts
export interface ExtensionRegistrationAPI {
  registerTool(tool: Tool<unknown>): void;
  registerCommand(command: ExtensionCommand): void;
  on<TEvent extends ExtensionEvent["type"]>(
    type: TEvent,
    handler: ExtensionEventHandler<TEvent>,
  ): () => void;
}
```

注册阶段不能：

- 发送 Prompt。
- 修改 Session。
- 切换模型。
- 执行工具。

这些动作需要 Runtime Context，必须等 Extension Commit 后才能调用。

## 两阶段加载

```text
创建临时 Registry
    ↓
执行 Extension Factory
    ↓
验证所有注册项
    ├── ID/名称冲突
    ├── 非法工具
    ├── 非法命令
    └── 未知事件
    ↓
全部成功 → Commit
任一失败 → Discard
```

这样不会出现插件加载到一半，只注册了部分工具的状态。

## Host Actions

```ts
export interface ExtensionContext {
  readonly extensionId: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;

  sendUserMessage(content: string): Promise<void>;
  appendCustomEntry(type: string, data: JsonValue): Promise<void>;
  getActiveToolNames(): readonly string[];
  setActiveToolNames(names: readonly string[]): Promise<void>;
  requestCompaction(instructions?: string): Promise<void>;
  notify(message: string): void;
}
```

Extension 不能访问：

- API Key。
- Session Store 内部 Transaction。
- Agent 私有队列。
- Tool Registry 可变 Map。
- WebSocket 原始连接。

## Extension 事件

第一版事件集合：

```ts
export type ExtensionEvent =
  | { type: "agent_before_start"; prompt: string }
  | { type: "turn_end"; turn: CompletedTurn }
  | { type: "tool_before_execute"; call: ToolCall }
  | { type: "tool_after_execute"; result: ToolResultMessage }
  | { type: "session_before_compact"; reason: string }
  | { type: "session_after_compact"; entry: CompactionEntry }
  | { type: "session_before_fork"; entryId: string }
  | { type: "session_branch_changed"; branch: string }
  | { type: "session_shutdown" };
```

## 可取消事件与观察事件

需要明确区分。

### 可取消事件

```ts
interface BlockingEventResult {
  cancel: true;
  reason: string;
}
```

例如：

- `tool_before_execute`
- `session_before_fork`
- `session_before_compact`

### 观察事件

返回值被忽略：

- `turn_end`
- `tool_after_execute`
- `session_shutdown`

不能让所有 Hook 都能修改控制流。

## 事件顺序

事件按 Extension 加载顺序执行，确保确定性：

```text
extension A handler
→ extension B handler
→ extension C handler
```

第一版不并行执行 Hook，因为：

- 难以定义多个修改结果如何合并。
- 错误顺序不稳定。
- Extension 可能依赖前一个 Handler 的决策。

## 命令系统

```ts
export interface ExtensionCommand {
  name: string;
  description: string;
  execute(
    argumentsText: string,
    context: ExtensionContext,
  ): Promise<void>;
}
```

命令与模型工具不同：

| 类型 | 发起者 | 是否进入模型上下文 |
|---|---|---|
| Tool | 模型 | Tool Call 和 Result 会进入 |
| Command | 用户/宿主 | 默认不进入 |

命令名称必须唯一，冲突时拒绝后加载的 Extension。

## Context 失效

Extension Handler 可能捕获 Context：

```ts
const savedContext = context;
await context.switchSession(...);
await savedContext.sendUserMessage(...);
```

切换 Session 后，旧 Context 必须失效：

```ts
export interface ExtensionContextLease {
  assertActive(): void;
  invalidate(reason: string): void;
}
```

以下操作会使旧 Context 失效：

- New Session
- Session Fork
- Switch Session
- Reload Extensions
- Shutdown

失效后调用 Action 应抛出明确的 `stale_extension_context`。

## Reload 生命周期

```text
停止接收新 Extension Command
      ↓
等待当前 Handler 完成或取消
      ↓
调用 dispose
      ↓
使旧 Context 失效
      ↓
清空 Extension Registry
      ↓
重新加载并原子 Commit
```

Reload 不应重建 Agent Session，也不能删除 Transcript。

## 错误隔离

```ts
export interface ExtensionDiagnostic {
  extensionId?: string;
  sourcePath: string;
  phase: "load" | "register" | "event" | "command" | "dispose";
  message: string;
}
```

策略：

- 加载失败：该 Extension 不启用，其他 Extension 继续。
- 可取消 Hook 抛错：当前业务操作失败，错误明确归属插件。
- 观察 Hook 抛错：记录诊断，默认不改变已经完成的业务结果。
- Tool 本身失败：沿普通 Tool Result 管线处理。

不能广泛 Catch 后完全忽略。

## 信任边界

Extension 是本地可执行代码，不是安全沙箱。

第一版必须：

- 只加载用户显式配置路径。
- 显示 Extension 来源。
- 不自动执行项目中的未知 Extension。
- Server 模式下由服务端配置，客户端不能提交模块路径。

真正的项目信任和 Sandbox 属于阶段 14。

## 对各包的影响

### `packages/plugins`

- 实现 Loader、Registry、Host、Runner 和 Diagnostics。
- 提供 Extension Author 公共类型。

### `packages/core`

- 只暴露稳定 Hook Boundary 和受限 Action。
- 不依赖具体 Extension Loader。
- Agent Loop 不加载文件系统模块。

### `packages/server`

- 在启动时加载可信 Extension。
- 增加 Reload 和 Extension Diagnostic 协议。
- 不接受浏览器提供的任意代码路径。

### `packages/web`

- 展示已加载 Extension 和诊断。
- 可以调用已注册命令。
- 第一版不允许插件注入任意前端代码。

## 测试与验收

### 必测场景

1. Extension 可以注册工具和命令。
2. 重名工具或命令被确定性拒绝。
3. Factory 失败不会留下部分注册项。
4. Hook 按加载顺序执行。
5. Blocking Hook 可以取消操作并提供原因。
6. Observer Hook 失败不改变已完成业务结果。
7. Reload 会调用 Dispose。
8. Reload 后旧 Context 不能再调用 Action。
9. 一个 Extension 加载失败不影响其他 Extension。
10. Server 客户端不能注入 Extension 路径。

### 验收标准

- 新工具和命令不需要修改 `packages/core` 源码。
- 插件注册和 Reload 都是原子的。
- 所有插件错误带有 Extension ID 和 Phase。
- Extension 无法绕过 Session Store 和 Tool Execution 管线。
- 关闭所有 Extension 后 Agent 原行为不变。

## 学习练习

1. 创建一个注册 `echo` Tool 的最小 Extension。
2. 创建一个 `/compact-now` Command。
3. 编写两个 `tool_before_execute` Handler，观察确定顺序。
4. 让 Factory 在注册 Tool 后抛错，确认 Tool 没有生效。
5. Reload 后尝试使用旧 Context，检查错误。

## 与下一阶段连接

阶段 13 的 Skill 也是可扩展资源，但它与 Extension 不同：

- Extension 是可执行代码。
- Skill 是提供给模型的知识和工作流程文本。

Extension 可以贡献 Skill 路径，但 Skill Loader 必须独立验证和索引这些资源。

