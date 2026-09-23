# 最小化 Mock Agent 设计

## 目的

构建一个零运行时依赖的 TypeScript 教学项目，实现 `pi-agent-core` 中研究的核心行为，但不导入任何 Pi 包，也不调用真实的 AI API。

第一个版本必须让完整的 Agent 流程可被观察和理解：

```text
user message
→ mock model response
→ tool call
→ validated tool execution
→ tool result
→ next model turn
→ final answer
```

实现将放在 `/Users/liqxie/Desktop/project/docs/mini-agent/`，保持在仓库工作区之外，以便作为一个独立示例被阅读和运行。

## 范围

### 核心版本

核心版本包含：

- Agent 状态与结构化消息
- `prompt()` 和 `continue()`
- 基于 Turn 的 Agent 循环
- 确定性的流式 Mock LLM
- 工具查找、参数校验、执行以及结果消息
- 生命周期与流式事件
- `steer` 和 `followUp` 队列
- `abort()` 和 `waitForIdle()`
- `beforeToolCall`、`afterToolCall` 和 `finishTurn` 钩子
- 显式的错误与中止结果
- Node 内置测试

核心版本不包含：

- 真实模型 API
- 第三方运行时或校验库
- 并行工具执行
- 自动重试
- 持久化会话
- 上下文压缩
- 动态模型切换

### 扩展版本

设计必须允许后续添加：

- 真实模型适配器
- 并行与串行工具策略
- 重试策略
- 上下文转换与请求准备钩子
- JSONL 或 SQLite 会话持久化

## 模块结构

```text
/Users/liqxie/Desktop/project/docs/mini-agent/
├── src/
│   ├── types.ts
│   ├── mock-llm.ts
│   ├── tools.ts
│   ├── agent-loop.ts
│   ├── agent.ts
│   └── demo.ts
├── test/
│   └── agent.test.ts
├── package.json
└── tsconfig.json
```

依赖单向流动：

```text
demo → agent → agent-loop → mock-llm/tools → types
```

### `types.ts`

定义公共契约：

- `SystemMessage`
- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`
- `ToolCall`
- `AgentMessage`
- `Tool`
- `ToolExecutionResult`
- `AgentEvent`
- `AgentState`
- `StreamFn`
- 钩子的输入与结果类型

消息使用可辨识联合（discriminated unions）。实现避免使用 `any`；未知的工具参数在显式校验之前保持为 `unknown`。

### `mock-llm.ts`

在真实模型适配器将使用的同一条流式边界背后，实现一个确定性的状态机。

Mock LLM：

- 接收消息历史和一个 `AbortSignal`；
- 返回一个 assistant 事件的异步流；
- 当用户请求 `package.json` 且不存在匹配的 tool result 时，发出一次 `read` 工具调用；
- 在看到 `read` 结果后，发出最终的文本响应；
- 处理后续的用户消息，包括 steering 和 follow-up 消息；
- 从不执行工具，也从不修改 Agent 状态。

### `tools.ts`

定义通用工具接口和一个虚拟文件 `read` 工具。

该工具从内存 map 中读取，例如：

```ts
{
  "package.json": "{\"name\":\"mock-agent-demo\"}"
}
```

参数校验是手写的，并返回显式的校验结果。非法参数永远不会到达工具执行器。

### `agent-loop.ts`

负责编排：

- 启动和结束 Agent run 与 Turn；
- 插入待处理消息；
- 调用流式模型；
- 执行被请求的工具；
- 创建 tool-result 消息；
- 应用钩子；
- 在各自定义的边界处排空 steering 和 follow-up 队列；
- 评估 `finishTurn`；
- 发出所有生命周期事件。

内层循环处理工具调用和 steering 消息。外层循环在任务本应停止之后处理 follow-up 消息。

### `agent.ts`

提供有状态的公共 API：

```ts
prompt()
continue()
steer()
followUp()
abort()
waitForIdle()
subscribe()
reset()
```

它创建上下文快照和循环配置，持有队列和当前活动的 `AbortController`，把循环事件归约（reduce）为 `AgentState`，并在状态更新后通知订阅者。

### `demo.ts`

运行虚拟文件场景并打印：

- 事件名称；
- 流式文本；
- 工具开始与完成；
- 最终的消息历史。

默认 prompt 是：

```text
读取 package.json，并告诉我项目名称。
```

预期的最终答案应识别出 `mock-agent-demo`。

## 数据流

1. `Agent.prompt()` 把文本转换为 `UserMessage`。
2. `Agent` 创建一个活动 run、上下文快照、循环配置和 abort 信号。
3. `agent-loop` 发出 `agent_start`、`turn_start` 和 user message 事件。
4. Mock LLM 检查历史，并流式输出一条包含 `read` 工具调用的 Assistant 消息。
5. 循环找到工具并校验 `{ path: "package.json" }`。
6. `beforeToolCall` 可以阻止这次调用。
7. 工具读取虚拟文件并返回内容。
8. `afterToolCall` 可以替换结果。
9. 循环发出工具事件并追加一条 `ToolResultMessage`。
10. 下一个 Turn 把更新后的历史发送给 Mock LLM。
11. Mock LLM 流式输出最终文本答案。
12. 循环应用 `finishTurn`，排空 steering，然后检查 follow-up 消息。
13. 没有剩余工作时，循环发出 `agent_end`。
14. `Agent` 清除活动 run 并使 `waitForIdle()` 完成（resolve）。

`continue()` 从当前 transcript 启动一个新循环，不追加新的用户消息。它不会恢复被挂起的 JavaScript 调用栈。

## 事件与状态语义

事件集合包括：

- `agent_start`
- `turn_start`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `turn_end`
- `agent_end`

`Agent.processEvent()` 在通知订阅者之前更新内部状态：

- `message_start/update` 更新 `streamingMessage`；
- `message_end` 清除 `streamingMessage` 并追加最终消息；
- 工具的 start/end 更新 `pendingToolCalls`；
- 失败的 Turn 更新 `errorMessage`；
- `agent_end` 清除瞬态的流式状态。

## 队列语义

`steer()` 将一条用户消息排队，在当前 assistant 响应及其工具完成后的下一个安全 Turn 边界投递。

`followUp()` 将一条用户消息排队，仅当当前任务会自然停止时才被消费。

两个队列默认一次投递一条。队列存储与投递策略保持分离，以便扩展版本可以在不改变循环结构的情况下添加 `"all"` 模式。

## 错误与取消语义

- 未知工具产生 error tool result。
- 非法参数产生 error tool result。
- 工具异常产生 error tool result。
- 工具错误对下一个模型 Turn 保持可见。
- 模型失败产生一条 `stopReason: "error"` 的 Assistant 消息。
- 取消产生一条 `stopReason: "aborted"` 的 Assistant 消息。
- 同一个 `AbortSignal` 被传给 Mock LLM 和工具。
- 活动 run 期间的第二次 `prompt()` 或 `continue()` 抛出状态错误。
- `continue()` 通常要求 transcript 尾部是 `user` 或 `toolResult`。
- Assistant 尾部只有通过消费排队的 steering 或 follow-up 消息才能继续。
- 核心版本不做自动重试。

## 钩子

`beforeToolCall` 接收工具调用和已校验的参数。它可以阻止执行并给出原因。

`afterToolCall` 接收结果，并可以替换 content、details 或 error 状态。

`finishTurn` 可以返回：

- `undefined`，表示正常调度；
- `{ action: "end" }`，在当前 Turn 之后停止；
- `{ action: "continue" }`，请求额外的一个仅携带上下文的 Turn。

实现必须通过演示一次有守卫的一次性 continuation，防止测试中意外出现无条件 continuation。

## 测试

测试使用 `node:test` 和 `node:assert/strict`。

必需用例：

1. 基本的 用户 → 工具调用 → 工具结果 → 最终答案 流程。
2. 基本流程的精确生命周期事件顺序。
3. 状态先于订阅者执行被更新。
4. Steering 在下一个 Turn 边界插入。
5. Follow-up 仅在自然完成后插入。
6. `continue()` 从 user 或 tool-result 尾部恢复，且不重复输入。
7. `abort()` 停止模型流式输出。
8. `abort()` 停止一个协作式长时间运行的工具。
9. `beforeToolCall` 可以阻止执行。
10. `afterToolCall` 可以替换结果。
11. `finishTurn` 支持有守卫的 end 和 continue 决策。
12. 未知工具、非法参数和工具异常产生显式的错误结果。

## 升级路径

### 真实模型适配器

保留 `StreamFn` 边界，用适配器替换 `MockLlm`，把提供商事件翻译成相同的 assistant 流。

### 并行工具

把工具执行抽取为一种策略：

```text
ToolExecutionStrategy
├── SequentialToolExecution
└── ParallelToolExecution
```

即使并行完成顺序不同，也要按 assistant 中的原始顺序持久化工具结果。

### 重试

用 `RetryPolicy` 包裹模型调用，由其决定是否以及何时重试。重试不得重复已提交的消息或工具副作用。

### 上下文管线

添加独立的钩子：

- `transformContext`，用于剪枝或摘要；
- `prepareRequest`，用于最终的请求同步；
- `prepareNextTurn`，用于基于上一个 Turn 得出的变更。

### 持久化

引入 `SessionStore` 接口。Agent 循环继续在消息上操作，而 JSONL 或 SQLite 实现负责加载并以原子方式追加持久记录。

## 成功标准

当学习者能够做到以下各点时，设计即为成功：

- 追踪一个请求穿过 Agent 的每一层；
- 解释为什么模型不直接执行工具；
- 区分 Agent 状态与循环局部上下文；
- 观察 Turn 边界和队列时序；
- 看清取消与错误如何传播；
- 无需重写公共 Agent API 即可替换 Mock LLM 或添加持久化。
