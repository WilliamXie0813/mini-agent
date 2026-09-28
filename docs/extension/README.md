# Mini Agent 扩展版学习路线

本目录基于当前仓库的 `packages/core` 实现，按十三个阶段把教学型 Agent 逐步扩展为更可靠、更接近生产环境的 Agent Runtime。

这些文档是**技术方案和学习材料**，不是一次性实施计划。建议每次只学习、讨论和实现一个阶段，通过验收后再进入下一阶段。

## 当前基线

核心版已经具备：

- `Agent` 公共 API 与状态管理
- Turn 循环
- Mock LLM 流式事件
- 顺序工具执行
- 参数验证
- `steer` / `followUp`
- `continue` / `abort` / `waitForIdle`
- `beforeToolCall` / `afterToolCall` / `finishTurn`
- Server、Web UI 和初步 Plugins 包

主要代码：

```text
packages/core/src/types.ts
packages/core/src/agent.ts
packages/core/src/agent-loop.ts
packages/core/src/mock-llm.ts
packages/core/src/tools.ts
```

## 学习顺序

| 阶段 | 文档 | 核心问题 |
|---|---|---|
| 1 | [上下文处理管线](01-context-pipeline.md) | 每次模型请求应该看到哪些消息？ |
| 2 | [并行与串行工具](02-tool-execution.md) | 多个工具怎样安全并发？ |
| 3 | [重试与错误分类](03-retry-policy.md) | 哪些失败可以安全重试？ |
| 4 | [Session 持久化与恢复](04-session-persistence.md) | 进程退出后怎样恢复任务？ |
| 5 | [Telemetry](05-telemetry.md) | 怎样观察一次 Agent Run？ |
| 6 | [真实 LLM 适配器](06-real-llm-adapter.md) | 怎样接入真实模型但不污染 Runtime？ |
| 7 | [动态工具与模型切换](07-dynamic-runtime.md) | 运行中怎样安全改变能力？ |
| 8 | [结构化输出](08-structured-output.md) | 怎样获得可验证的模型结果？ |
| 9 | [子 Agent](09-subagents.md) | 怎样隔离并调度多个 Agent？ |
| 10 | [自动上下文压缩](10-auto-compaction.md) | 长任务超过模型窗口后怎样继续？ |
| 11 | [Session 分支与时间旅行](11-session-branching.md) | 怎样从历史节点探索另一条路径？ |
| 12 | [Extension 插件系统](12-extension-system.md) | 怎样扩展 Agent 而不修改核心代码？ |
| 13 | [Skills 系统](13-skills-system.md) | 怎样按需向模型加载专业工作方法？ |

## 每阶段的学习方式

1. 先阅读“当前问题”，确认为什么需要这个能力。
2. 比较可选方案，不直接接受推荐答案。
3. 画出该阶段的新调用链。
4. 对照现有源码，找出最小修改面。
5. 先写验收测试，再实现。
6. 完成文档中的练习和检查题。
7. 确认没有提前实现下一阶段内容。

## 总体架构目标

十三个阶段结束后，核心架构应形成以下边界：

```text
Agent
├── 公共 API、状态、队列、生命周期
│
AgentLoop
├── Turn 调度
│
ContextPipeline
├── 上下文准备与压缩
│
CompactionRuntime
├── Token 水位、摘要生成与近期消息保留
│
ModelRuntime / StreamFn
├── 模型选择、真实 Provider、重试
│
ToolExecutionStrategy
├── 工具预检、串行与并行执行
│
SessionStore
├── 消息、运行状态、分支树与恢复
│
TelemetryContext
├── Run、Turn、模型和工具观测
│
OutputContract
├── 结构化结果验证
│
SubagentRuntime
├── 子 Agent 隔离、预算和结果回传
│
ExtensionHost
├── 插件注册、生命周期与受限宿主能力
│
SkillRegistry
└── Skill 发现、元数据索引与按需内容注入
```

## 约束

- 每个阶段必须保持 `packages/core` 可以独立测试。
- 不把 Server、Web UI 或插件产品逻辑塞入 Agent Loop。
- 不因为接入真实模型而让核心包依赖某个供应商 SDK。
- 不把失败静默转换成成功结果。
- 不自动重放可能产生副作用的工具。
- 子 Agent 阶段之前不引入多 Agent 协作。
- 压缩只改变模型上下文投影，不删除原始 Session 历史。
- 分支切换必须通过 Session Tree 表达，不能直接覆盖当前消息数组。
- Extension 只能通过受限 Host API 扩展能力。
- Skill 默认只把名称和描述放进 System Prompt，正文按需加载。
