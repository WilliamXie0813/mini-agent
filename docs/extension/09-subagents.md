# 阶段 9：子 Agent

## 当前问题

单个 Agent 可以连续调用工具，但复杂任务可能包含相对独立的工作：

```text
主 Agent
├── 分析 API
├── 检查测试
└── 总结文档
```

如果所有工作共享同一 Transcript，上下文会迅速膨胀，职责和权限也难以隔离。

本阶段解决“**主 Agent 怎样委派有边界的子任务，并安全收集结果**”。

## 学习目标

- 将子 Agent 视为独立 Session，而不是函数递归。
- 设计委派、预算、取消和结果回传协议。
- 隔离消息、工具和权限。
- 防止无限递归和失控并发。

## 非目标

- 不实现 Agent 自由组网。
- 不允许子 Agent 任意创建更多子 Agent。
- 不共享可变 Transcript。
- 不让多个 Agent 同时编辑同一资源。
- 不实现长期自治团队。

## 方案比较

### 方案 A：主 Agent 直接多调用几次模型

没有隔离，上下文和工具权限仍然混在一起。

### 方案 B：子 Agent 共享主 Agent 对象

实现简单，但队列、AbortController、状态和事件会冲突。

### 方案 C：独立 Child Agent + 受控 Delegate Tool，推荐

主 Agent 通过特殊工具创建独立子 Session，子 Agent 返回经过约束的结果。

## 核心模型

```ts
export interface SubagentRequest {
  task: string;
  context: AgentMessage[];
  allowedTools: string[];
  model?: ModelRef;
  budget: SubagentBudget;
}

export interface SubagentBudget {
  maxTurns: number;
  maxToolCalls: number;
  timeoutMs: number;
}

export interface SubagentResult {
  status: "completed" | "failed" | "aborted" | "budget_exceeded";
  summary: string;
  output?: unknown;
  usage: {
    turns: number;
    toolCalls: number;
  };
}

export interface SubagentRuntime {
  run(
    request: SubagentRequest,
    signal: AbortSignal,
  ): Promise<SubagentResult>;
}
```

## Delegate Tool

主 Agent 看到的是一个普通工具声明：

```text
delegate_task({
  task,
  allowedTools,
  expectedOutput
})
```

Runtime 截获该工具并：

1. 验证任务边界。
2. 创建新的 Session ID。
3. 选择允许的模型和工具 Snapshot。
4. 创建独立 Child Agent。
5. 传递父级 AbortSignal。
6. 等待结果。
7. 将 `SubagentResult.summary` 作为 Tool Result 返回主 Agent。

子 Agent 的完整 Transcript 不直接塞进主 Agent Context。

## 隔离原则

### 消息隔离

子 Agent 只接收显式选择的上下文：

```text
任务说明
必要文件摘要
输出契约
```

不默认复制主 Agent 全部历史。

### 工具隔离

子 Agent 工具是 Allowlist：

```text
研究 Agent：read、grep
验证 Agent：read、test
写入 Agent：需要额外批准
```

### 模型隔离

子 Agent 可以使用不同模型，但必须来自 Model Registry。

### Session 隔离

父子 Session 分开持久化，通过：

```ts
parentSessionId
parentToolCallId
```

建立关系。

## 深度与并发限制

第一版只允许一层：

```text
主 Agent → 子 Agent
```

Child Agent 不拥有 `delegate_task` 工具。

配置：

```ts
interface SubagentLimits {
  maxDepth: 1;
  maxConcurrentChildren: 2;
  maxChildrenPerRun: 4;
}
```

这比任意递归更容易理解和测试。

## 取消语义

```text
主 Run abort
→ 所有 Child Signal abort
→ 等待 Child 清理
→ Delegate Tool 返回 aborted
→ 主 Run 结束
```

单个 Child 失败不一定终止主 Agent。Delegate Tool 将失败作为明确 Tool Result，主 Agent 决定下一步。

## 结果回传

推荐子 Agent 使用阶段 8 的 `OutputContract`：

```ts
interface ResearchResult {
  summary: string;
  findings: Array<{
    file: string;
    observation: string;
  }>;
}
```

主 Agent 只收到：

- 状态
- 简洁 Summary
- 已验证结构化结果
- Usage

不要回传全部子 Transcript，避免上下文爆炸。

## 事件命名空间

现有 `AgentEvent` 增加来源：

```ts
interface EventEnvelope {
  sessionId: string;
  parentSessionId?: string;
  event: AgentEvent;
}
```

Server 可以将 Child Event 转发给 Web UI，但主 Agent 的状态 Reducer 只处理自己的事件。

Web UI 展示：

```text
Main Agent
└── Child: inspect tests
    ├── running
    └── completed
```

## 资源冲突

第一版子 Agent 默认只读。写工具需要宿主提供资源锁：

```ts
interface ResourceLease {
  resource: string;
  release(): Promise<void>;
}
```

不要让两个 Agent 无协调地修改同一文件。文件写入和合并属于更后续的产品能力。

## 对现有包的影响

### `packages/core`

- 新增 `subagents.ts`。
- 提供 `SubagentRuntime` 契约，不包含具体多进程实现。
- `Agent` 可创建受限 Child Agent Factory。
- Run 增加 Turn 和 Tool Call Budget。

### `packages/server`

- 管理父子 Session。
- 限制并发 Child 数量。
- 广播带 Session ID 的事件。

### `packages/web`

- 增加父子任务树和独立状态。
- 默认折叠 Child Transcript。

### `packages/plugins`

- 插件可以声明一个受信任的 Child Agent Profile。
- 插件不能绕过全局预算和工具 Allowlist。

## 测试策略

1. Delegate Tool 创建独立 Child Agent。
2. Child 消息不会进入父 Transcript，只有 Summary Tool Result 进入。
3. Child 只能看到 Allowlist 工具。
4. Child 无法再次 delegate。
5. 父 abort 会取消所有 Child。
6. Child 超过 Turn/Tool/Timeout Budget 后停止。
7. 两个 Child 的事件通过 Session ID 区分。
8. Child 失败作为 Tool Result 返回，主 Agent 可以继续。
9. Session Store 能恢复父子关系。
10. 最大并发数得到严格执行。

## 验收标准

- 主 Agent 可以委派一个只读研究任务并获得结构化结果。
- 父子 Agent 的状态、消息和工具权限互不污染。
- 取消和预算可以阻止失控执行。
- 不存在无限递归创建 Agent 的路径。

## 学习练习

1. 创建一个只能使用 `read` 的 Child Agent。
2. 比较“复制全部主历史”和“只传任务摘要”的 Token 用量。
3. 让 Child 超过 `maxTurns`，观察返回状态。
4. 同时启动两个 Child，确认事件不会串线。

## 完成基础扩展九阶段后

你应该能够解释：

- Agent Runtime 与 Agent 产品功能的边界。
- 单 Agent 调度与多 Agent 调度的本质差异。
- 为什么持久化、Telemetry、预算和结构化输出是子 Agent 的前置条件。
- 为什么可靠的多 Agent 系统不是简单的 `Promise.all(agent.prompt())`。
