# 阶段 5：Telemetry

## 当前问题

当前系统有 `AgentEvent`，Server 会把事件转发给 Web UI。但事件流主要服务于状态更新和界面渲染，无法完整回答：

- 一次 Run 花了多长时间？
- 时间消耗在模型、重试还是工具？
- 哪个工具失败最多？
- 上下文压缩前后大小是多少？
- Session 恢复后是否发生异常？

本阶段解决“**怎样观察 Agent，而不让观测逻辑改变业务行为**”。

## 学习目标

- 区分领域事件和 Telemetry。
- 使用显式 Context 建立 Run、Turn、模型和工具 Span。
- 记录耗时、状态、事件和属性。
- 保证 Telemetry 失败不影响 Agent。

## 非目标

- 不直接接 OpenTelemetry 或云平台。
- 不建立日志搜索系统。
- 不采集用户 Prompt、文件内容或凭证。
- 不实现分布式追踪后端。

## AgentEvent 与 Telemetry 的区别

`AgentEvent` 是业务协议：

```text
message_end
tool_execution_start
turn_end
```

它驱动 Agent State 和 Web UI。

Telemetry 是诊断数据：

```text
agent.run duration=1300ms
model.request retry_count=1
tool.execute tool=read duration=8ms
```

不能用 Telemetry 代替 AgentEvent，也不应把每个 Telemetry Span 写入 Transcript。

## 方案比较

### 方案 A：到处 `console.log`

简单但无法组合、测试和关闭，还容易泄露内容。

### 方案 B：全局当前 Span

调用方便，但异步并发时上下文容易混乱，测试也相互污染。

### 方案 C：显式 `TelemetryContext`，推荐

Context 作为依赖沿调用链传递，不使用全局变量。

## 目标接口

```ts
export type TelemetryAttribute =
  | string
  | number
  | boolean
  | undefined;

export interface SpanStatus {
  status: "ok" | "error";
  message?: string;
}

export interface TelemetrySpan {
  setAttributes(attributes: Record<string, TelemetryAttribute>): void;
  addEvent(
    name: string,
    attributes?: Record<string, TelemetryAttribute>,
  ): void;
  setStatus(status: SpanStatus): void;
  startSpan<T>(
    name: string,
    attributes: Record<string, TelemetryAttribute>,
    operation: (span: TelemetrySpan) => Promise<T>,
  ): Promise<T>;
}

export interface TelemetryContext {
  startSpan<T>(
    name: string,
    attributes: Record<string, TelemetryAttribute>,
    operation: (span: TelemetrySpan) => Promise<T>,
  ): Promise<T>;
}
```

`startSpan()` 自己管理结束时间，调用者不手动 `end()`，减少忘记收尾的风险。

## Span 层级

```text
agent.run
├── agent.turn
│   ├── context.prepare_next_turn
│   ├── context.prepare_request
│   ├── context.transform
│   ├── model.request
│   │   └── model.retry_wait
│   └── tool.batch
│       ├── tool.execute read
│       └── tool.execute grep
└── session.commit
```

建议命名稳定，不把模型 ID 或工具名拼进 Span 名称，而是作为属性。

## 推荐属性

### `agent.run`

```text
agent.session_id
agent.prompt_count
agent.result
```

### `agent.turn`

```text
agent.turn_index
agent.tool_call_count
agent.stop_reason
```

### `model.request`

```text
model.provider
model.id
model.attempt
model.input_estimated_tokens
model.output_characters
```

### `tool.execute`

```text
tool.name
tool.call_id
tool.execution_mode
tool.result
```

禁止默认记录：

- Prompt 原文
- Tool 参数全文
- Tool Result 全文
- API Key
- 文件内容

## 参考实现

先提供两个实现：

```text
NoopTelemetryContext
InMemoryTelemetryContext
```

`Noop` 用于默认运行，必须几乎零开销。

`InMemory` 用于测试和学习，记录：

```ts
interface RecordedSpan {
  id: number;
  parentId?: number;
  name: string;
  attributes: Record<string, TelemetryAttribute>;
  events: RecordedSpanEvent[];
  status: SpanStatus;
  startedAt: number;
  endedAt: number;
}
```

时间来源注入 `Clock`，测试不依赖真实时间。

## 被动原则

Telemetry 必须满足：

1. 不能改变业务返回值。
2. 后端记录失败不能让 Agent 失败。
3. Span Callback 只执行一次。
4. 异步 Callback 完成前 Span 保持打开。
5. 敏感数据默认不记录。
6. 关闭 Telemetry 不改变事件顺序。

## 对现有包的影响

### `packages/core`

- 新增 `telemetry.ts`。
- `AgentOptions` 接收 `TelemetryContext`，默认 Noop。
- `agent.ts` 创建 Run Span。
- `agent-loop.ts` 创建 Turn、模型和工具 Span。
- Retry、Context、Session 模块接收父 Span。

### `packages/server`

- 可以增加诊断端点读取聚合数据。
- 不通过现有 WebSocket 广播每个 Span，避免协议噪声。

### `packages/web`

- 可选增加开发者诊断页。
- 普通聊天 UI 不依赖 Telemetry。

### `packages/plugins`

- 插件将来接收受限 Span Context，而不是整个 Telemetry 后端。

## 测试策略

1. Run 包含两个 Turn Span。
2. Tool Span 是对应 Turn 的子 Span。
3. Retry Wait 是 Model Request 的子 Span。
4. Callback 抛错时 Span 状态为 error，原错误继续抛出。
5. Noop 保持返回值和错误身份。
6. Telemetry 后端记录失败时业务仍正常完成。
7. 不记录 Prompt 和 Tool Result 原文。
8. 并行工具 Span 可以重叠且父级正确。

## 验收标准

- 能从 InMemory Span 树解释一次完整 Run 的耗时。
- 开启或关闭 Telemetry 不改变 Agent 测试结果。
- 敏感内容不进入默认属性。
- 后续可通过 Adapter 接入 OpenTelemetry，而无需修改 Agent Loop。

## 学习练习

1. 打印一次 Run 的 Span 树。
2. 人为增加慢工具，确认耗时归属正确。
3. 让 Telemetry Adapter 的 `addEvent()` 抛错，确认 Agent 不受影响。
4. 比较 AgentEvent 时间线和 Span 树，解释两者用途差异。

## 进入下一阶段前

你应该能够回答：

- 为什么已有 AgentEvent 还需要 Telemetry？
- 为什么 Telemetry Context 应显式传递？
- 哪些数据绝不能默认放入 Span 属性？

