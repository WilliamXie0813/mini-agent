# 阶段 6：接入真实 LLM

## 当前问题

`packages/core/src/mock-llm.ts` 是确定性状态机。它很好地展示 Agent Loop，但不能验证：

- HTTP 鉴权和网络错误
- SSE 流式解析
- 增量 Tool Call 参数
- Provider Stop Reason
- Usage 和模型元数据

本阶段解决“**怎样接入一个真实模型，同时保持 Agent Runtime 与供应商解耦**”。

## 学习目标

- 保持 `StreamFn` 作为核心边界。
- 将供应商请求和响应转换成内部消息协议。
- 正确组装流式文本与 Tool Call。
- 将供应商错误规范化为 `ModelError`。
- 支持 Mock 和真实 Provider 使用同一套 Agent Loop 测试。

## 非目标

- 不一次支持多个供应商。
- 不实现 OAuth。
- 不维护模型目录。
- 不做自动模型路由。
- 不在浏览器直接保存 API Key。

## Provider 选择

推荐第一版实现“OpenAI-compatible SSE Adapter”，原因：

- Node 22 原生 `fetch` 足够，不需要运行时 SDK。
- 很多本地和云端模型提供兼容接口。
- 可以配置 `baseUrl`，便于用本地测试服务器。

注意：兼容接口之间仍可能有字段差异。本阶段只支持明确文档化的子集。

## 方案比较

### 方案 A：直接在 Agent Loop 中调用 `fetch`

实现快，但核心层会知道 HTTP、Headers 和 Provider 格式。

### 方案 B：依赖官方 SDK 并直接返回 SDK 类型

减少协议代码，但核心类型被供应商 SDK 污染。

### 方案 C：独立 Provider Adapter，推荐

```text
AgentLoop
    ↓ StreamFn
OpenAICompatibleAdapter
    ↓ fetch/SSE
Provider
```

Adapter 是唯一了解外部协议的模块。

## 目录建议

```text
packages/
├── core/
└── providers/
    └── openai-compatible/
        ├── src/index.ts
        ├── src/adapter.ts
        ├── src/sse.ts
        ├── test/adapter.test.ts
        └── package.json
```

不要把真实 Provider 放进 `packages/core`，保持核心零供应商依赖。

## 配置接口

```ts
export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export function createOpenAICompatibleStream(
  options: OpenAICompatibleOptions,
): StreamFn;
```

API Key 由 Server 环境注入，不进入 Agent Message、WebSocket State 或 Telemetry。

## 请求转换

内部消息需要映射为 Provider 消息：

```text
SystemMessage    → system
UserMessage      → user
AssistantMessage → assistant
ToolResult       → tool
```

Tool 定义从当前 Agent Context 传给 Provider。现有 `StreamFn` 只接收 messages，因此需要扩展请求：

```ts
export interface ModelRequest {
  messages: readonly AgentMessage[];
  tools: readonly ToolDeclaration[];
  signal: AbortSignal;
  requestId: string;
}

export type StreamFn = (
  request: ModelRequest,
) => AsyncIterable<ModelStreamEvent>;
```

工具执行函数不能传给 Provider，只传 JSON 安全声明：

```ts
interface ToolDeclaration {
  name: string;
  description: string;
  parameters: JsonSchema;
}
```

现有手写 `validate()` 仍是本地执行前的最终防线。

## SSE 解析

SSE Parser 负责：

```text
任意网络 chunk
→ 按行缓冲
→ 提取 data:
→ 识别 [DONE]
→ JSON.parse
→ Provider Delta
```

它必须处理：

- 一个 Event 被拆成多个网络 Chunk
- 一个 Chunk 包含多个 Event
- 空行
- 非法 JSON
- 流在 `[DONE]` 前断开

SSE Parser 不理解 Agent Message，只负责传输格式。

## Tool Call 参数组装

真实模型可能分段返回：

```text
delta 1: {"path":
delta 2: "package
delta 3: .json"}
```

Adapter 按 Tool Call Index 或 ID 保存：

```ts
interface PartialToolCall {
  id?: string;
  name: string;
  argumentsText: string;
}
```

流结束时：

1. 拼接参数文本。
2. `JSON.parse` 为 `unknown`。
3. 创建内部 `ToolCall`。
4. 本地 Tool 的 `validate()` 再验证具体结构。

解析失败要产生明确 Model Error，不能传入空对象。

## 流事件转换

```text
Provider response created
    → ModelStartEvent

text delta
    → ModelTextDeltaEvent

完整 tool call
    → ModelToolCallEvent

provider done
    → ModelEndEvent
```

`AssistantMessage` 还应增加：

```ts
provider?: string;
model?: string;
responseId?: string;
usage?: ModelUsage;
rawStopReason?: string;
```

内部 `stopReason` 仍统一为：

```text
stop
toolUse
error
aborted
```

## 错误转换

Adapter 将 HTTP/协议错误转换成阶段 3 的 `ModelError`：

```text
401/403 → authentication
429     → rate_limit
408     → timeout
5xx     → server
网络异常 → network
400     → invalid_request
```

响应 Body 需要限制长度，避免错误页面占用大量内存或泄露敏感信息。

## Server 集成

真实 API Key 只存在于 `packages/server`：

```text
环境变量
→ Provider Factory
→ AgentSession.createAgent()
```

Web 客户端只发送 Prompt，不发送 Provider Secret。

推荐配置：

```text
MINI_AGENT_PROVIDER=openai-compatible
MINI_AGENT_BASE_URL=...
MINI_AGENT_MODEL=...
MINI_AGENT_API_KEY=...
```

Mock Provider 继续作为默认开发模式和测试替身。

## 测试策略

禁止单元测试调用真实付费 API。使用本地 HTTP 测试服务器：

1. 文本 SSE 被转换成累计 Assistant Message。
2. 网络 Chunk 任意分割仍可解析。
3. Tool Call 参数分片可以正确组装。
4. 非法 Tool JSON 产生明确错误。
5. 429 转成 retryable `rate_limit`。
6. 401 不可重试。
7. abort 关闭 Fetch Stream。
8. API Key 不出现在错误、事件和序列化状态中。
9. Mock 与真实 Adapter 通过共同的 StreamFn 契约测试。

## 验收标准

- 切换 Provider 不修改 Agent Loop。
- Mock 模式仍可离线运行全部测试。
- 真实模型能够调用现有 `read` 工具。
- Provider 原始格式不泄露到 `packages/core` 公共 API。
- Secret 不进入浏览器和 Session 文件。

## 学习练习

1. 写一个本地 SSE Server，分三次返回文本。
2. 把 Tool Call JSON 故意拆在字符中间。
3. 模拟 429 后成功，观察 RetryPolicy。
4. 搜索日志和 Session，确认 API Key 不存在。

## 进入下一阶段前

你应该能够回答：

- 为什么 Provider Adapter 不应该直接执行工具？
- 为什么 Provider Tool Schema 和本地 `validate()` 都需要？
- 为什么真实 LLM 应在持久化和 Telemetry 之后接入？

