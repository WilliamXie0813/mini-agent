# 真实 LLM 适配器设计：ai-sdk + DeepSeek

日期：2026-09-28
状态：已与用户确认
对应学习阶段：`docs/extension/06-real-llm-adapter.md`（本设计用 ai-sdk 替代该文档中手写 OpenAI-compatible SSE 的方案）

## 背景与目标

`packages/core/src/mock-llm.ts` 是确定性状态机，无法验证真实模型的鉴权、流式、Tool Call 与错误行为。本阶段接入真实模型，同时保持 Agent Runtime 与供应商解耦。

**关键取舍**：不手写 fetch/SSE 解析与增量 Tool Call 组装，改用 ai-sdk v5（`ai` + `@ai-sdk/deepseek`）——`jev-demo.ts` 已验证该库的接入方式。`StreamFn` 仍是核心边界，适配器是核心与 ai-sdk 之间的防腐层。

**范围限定**：

- 只接入 DeepSeek 一个供应商；
- 不做 OAuth、模型目录、自动路由；
- 不做自动重试（retry policy 另有设计文档，本阶段只留 `retryable` 接口）；
- 不修改 web 客户端；
- assistant 消息不增加 usage / model 元数据字段（YAGNI，后续可补）。

## 架构与数据流

```text
Web Client ──WebSocket──> Server (session.ts)
                              │ 环境变量选择 Provider
                              ▼
                          Agent / AgentLoop ──（不变）
                              │ StreamFn(ModelRequest)
                              ▼
              @mini-agent/providers-deepseek（新包，防腐层）
                              │ streamText().fullStream
                              ▼
                    ai-sdk + @ai-sdk/deepseek ──HTTPS──> DeepSeek API
```

新包：

```text
packages/providers/deepseek/
├── src/
│   ├── index.ts          # 导出 createDeepSeekStream 与选项类型
│   ├── adapter.ts        # StreamFn 实现：事件映射、错误映射
│   └── messages.ts       # AgentMessage → ai-sdk ModelMessage 映射（纯函数）
├── test/
│   ├── adapter.test.ts
│   └── messages.test.ts
├── package.json
└── tsconfig.json
```

依赖方向：`providers-deepseek → core`；`server → providers-deepseek`。`packages/core` 保持零供应商依赖。

## core 契约变更（3 处）

### 1. StreamFn 升级为 ModelRequest

`packages/core/src/types.ts`：

```ts
export type JsonSchema = Record<string, unknown>;

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ModelRequest {
  messages: readonly AgentMessage[];
  tools: readonly ToolDeclaration[];
  signal: AbortSignal;
  requestId: string;
}

export type StreamFn = (request: ModelRequest) => AsyncIterable<ModelStreamEvent>;
```

- `agent-loop` 每次调用前从 `AgentContext.tools` 投影 `ToolDeclaration`（只取 name / description / parametersSchema，执行函数不外泄）；`requestId` 由循环层生成（如 `req-<turn>-<seq>`）。
- `mock-llm` 同步改为新签名，忽略 tools。
- 现有 core 测试因签名变更同步修复（调用处包一层 ModelRequest）。

### 2. Tool 接口加可选 JSON Schema 字段

```ts
export interface Tool<TParameters> {
  // …现有字段不变
  /** 给模型看的 JSON Schema；缺省时该工具不出现在 ToolDeclaration 中 */
  parametersSchema?: JsonSchema;
}
```

`createReadTool` 补上：

```json
{ "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
```

手写 `validate()` 保留为本地最终防线：Provider 侧 Schema 是提示，validate 是防线。

### 3. ModelError 错误分类

新增（只定义类型，循环层只消费 kind，不加重试逻辑）：

```ts
export type ModelErrorKind =
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "server"
  | "network"
  | "invalid_request"
  | "unknown";

export interface ModelError {
  kind: ModelErrorKind;
  message: string;
  retryable: boolean; // rate_limit / timeout / server / network 为 true
  statusCode?: number;
}
```

循环层捕获流中的错误后产出 `stopReason: "error"` 的 assistant 消息（现有行为），`errorMessage` 附带 kind。`retryable` 供下一阶段的重试策略消费。

## 适配器内部（packages/providers/deepseek）

### API 形状

```ts
export interface DeepSeekAdapterOptions {
  apiKey: string;
  baseURL?: string; // 默认 https://api.deepseek.com
  model?: string;   // 默认 deepseek-chat
  maxOutputTokens?: number;
}

export function createDeepSeekStream(options: DeepSeekAdapterOptions): StreamFn;
```

### 消息映射（messages.ts，纯函数）

```text
system      → { role: "system", content }
user        → { role: "user", content }
assistant   → { role: "assistant", content: [text 段…, tool-call 部分…] }
toolResult  → { role: "tool", content: [{ type: "tool-result", toolCallId, toolName, output }] }
```

assistant 的 `ToolCall.arguments: unknown` 直接作为 tool-call 的 input 回传（来自模型 JSON，保证可序列化）。

### 事件映射（adapter.ts）

消费 `streamText().fullStream`：

```text
(开始)      → start       空 AssistantMessage
text-delta  → text_delta  delta + 累计快照（与 mock 语义一致）
tool-call   → tool_call   ai-sdk 已按 inputSchema 解析参数，直接放入 ToolCall.arguments: unknown
finish      → end         stopReason 映射（见下）
error       → 抛 ModelError，由循环层统一转 stopReason: "error"
```

stopReason 映射：

```text
"stop"        → "stop"
"tool-calls"  → "toolUse"
abort         → "aborted"
length / content-filter 等其他值 → "stop"，errorMessage 注明原始 finishReason
```

### 两个设计要点

1. **工具只声明、不执行**：传给 ai-sdk 的 tool 只有 `description` + `inputSchema`，不给 `execute`。模型发 tool-call 后 ai-sdk 停住，执行权回到 agent-loop——保持"模型只描述、循环层执行"的原则。
2. **AbortSignal 透传**：`streamText({ abortSignal: request.signal })`，取消语义与 mock 一致。

### 错误映射

ai-sdk 的 `APICallError` 带 `statusCode`：

```text
401 / 403 → authentication（retryable: false）
429       → rate_limit（retryable: true）
408       → timeout（retryable: true）
5xx       → server（retryable: true）
400       → invalid_request（retryable: false）
网络异常   → network（retryable: true）
其他       → unknown（retryable: false）
```

错误 message 截取限长（如 500 字符），且不得包含 apiKey。

## Server 集成

`packages/server/src/session.ts` 的 `createAgent()` 按环境变量选择：

```text
MINI_AGENT_PROVIDER
  ├─ 未设置 / "mock"  → createMockStream()（默认，离线开发与测试）
  └─ "deepseek"       → createDeepSeekStream({
                          apiKey: DEEPSEEK_API_KEY,   // 缺失则启动时报明确错误
                          baseURL: DEEPSEEK_BASE_URL, // 可选
                          model: DEEPSEEK_MODEL,      // 可选
                        })
```

- API Key 只存在于 server 进程环境，不进入消息、事件、WebSocket 状态与任何序列化输出；
- `Agent` 构造签名不变，仅 stream 来源变化——"切换 Provider 不改 Agent Loop"的验收标准由此保证；
- server 增加对 `@mini-agent/providers-deepseek` 的 workspace 依赖。

## 测试策略

原则：单元测试不打真实付费 API。

**providers-deepseek 包**（node:test + ai 包的 `MockLanguageModelV2` / `simulateReadableStream`）：

1. 流式 text-delta → 事件序列与累计快照正确（与 mock 语义一致）；
2. 完整 tool-call → 单个 `tool_call` 事件，arguments 为解析后的对象；
3. `finishReason: "tool-calls"` → `stopReason: "toolUse"`；
4. 429 → `ModelError{ kind: "rate_limit", retryable: true }`；401 → `authentication, retryable: false`；
5. 消息映射纯函数：四种角色（含 assistant 混合 content、toolResult）→ 正确 ModelMessage；
6. abort → 流终止；
7. 冒烟脚本 `pnpm demo:deepseek`（手动运行，不进测试套件）：真实 API 跑"读 package.json"流程。

**core 包**：

- 现有测试适配新 StreamFn 签名；
- 给 mock-llm 补一个"收到 tools 声明但不依赖它"的用例。

## 验收标准

- 切换 Provider 不修改 Agent Loop（仅环境变量 + server 一处分支）；
- Mock 模式仍可离线运行全部测试；
- 真实 DeepSeek 能调用现有 `read` 工具完成"读 package.json 并回答项目名称"；
- DeepSeek / ai-sdk 的类型不出现在 `packages/core` 公共 API；
- API Key 不出现在错误消息、事件流、WebSocket 状态与日志中。

## 明确不做

- 多供应商；
- 自动重试（仅留 `retryable` 字段）；
- assistant 消息 usage / model / responseId 元数据；
- 手写 SSE 解析与增量 Tool Call 组装（由 ai-sdk 承担）；
- web 客户端改动。
