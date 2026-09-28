# 真实 LLM 适配器设计：ai-sdk + DeepSeek

日期：2026-09-28
状态：已与用户确认；经两轮独立 subagent 校验后修订
对应学习阶段：`docs/extension/06-real-llm-adapter.md`（本设计用 ai-sdk 替代该文档中手写 OpenAI-compatible SSE 的方案）
关联文档：`2026-09-28-retry-policy-design-zh.md`（错误模型以该文档为唯一权威来源）

## 背景与目标

`packages/core/src/mock-llm.ts` 是确定性状态机，无法验证真实模型的鉴权、流式、Tool Call 与错误行为。本阶段接入真实模型，同时保持 Agent Runtime 与供应商解耦。

**关键取舍**：不手写 fetch/SSE 解析与增量 Tool Call 组装，改用当前锁定版本 `ai@5.0.267` + `@ai-sdk/deepseek@1.0.59`。这两个依赖目前只在 plugins 包用于 `jev-demo.ts`；实现时移动为新 Provider 包的直接、精确版本依赖，并从 plugins 移除不再需要的依赖。注意：`jev-demo.ts` 只验证过 `createDeepSeek` + `generateObject`；本阶段的核心路径 `streamText` / `fullStream` / 无 execute 的 tool 声明是首次使用（其 API 形状已对照 node_modules 类型定义核实）。`StreamFn` 仍是核心边界，适配器是核心与 ai-sdk 之间的防腐层。

**范围限定**：

- 只接入 DeepSeek 一个供应商；
- 不做 OAuth、模型目录、自动路由；
- 不在 Provider 内做自动重试：调用 `streamText` 时显式设置 `maxRetries: 0`，所有重试统一由 Runtime Retry Policy 控制；
- 不修改 web 客户端；
- assistant 消息不增加 usage / model 元数据字段（YAGNI，后续可补）。

## 架构与数据流

```text
Web Client ──WebSocket──> Server (session.ts)
                              │ 环境变量选择 Provider
                              ▼
                          Agent / AgentLoop
                              │ StreamFn(ModelRequest)
                              │ （本次改动：循环层调用点投影 tools、生成 requestId；
                              │   改完之后，切换 Provider 不再触碰循环层）
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
├── package.json          # 含 demo:deepseek 冒烟脚本
└── tsconfig.json
```

**workspace 配置**：`pnpm-workspace.yaml` 目前只匹配 `packages/*`（单层），必须新增 `packages/providers/*`，否则新包不会被识别、server 的 `workspace:*` 依赖无法解析。

依赖方向：`providers-deepseek → core`；`server → providers-deepseek`。`packages/core` 保持零供应商依赖。

## core 契约变更

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

- `agent-loop` 每次调用前从 `AgentContext.tools` 投影 `ToolDeclaration`（只取 name / description / parametersSchema，执行函数不外泄）。
- `requestId` 由可注入的 `RequestIdGenerator` 生成，默认 `crypto.randomUUID()`，测试注入确定性生成器。新的 Turn/模型请求生成新 ID；同一次逻辑请求的所有重试复用同一个 `ModelRequest` 和 `requestId`。
- `mock-llm` 同步改为新签名，忽略 tools。

```ts
export type RequestIdGenerator = () => string;
```

Retry Policy 的 `streamWithRetry` 使用与 StreamFn 参数无关的 `startAttempt` 闭包：

```ts
streamWithRetry({
  startAttempt: () => config.stream(request),
  // ...
});
```

因此阶段 3 与阶段 6 不需要维护两套重试实现。

**签名变更波及面（完整枚举）**：

- 实现/调用点：`agent-loop.ts`（stream 调用处）、`mock-llm.ts`（createMockStream）；
- 测试内联 StreamFn 实现：`test/agent-loop.test.ts`、`test/agent.test.ts` 中多处；`test/mock-llm.test.ts` 直接以 `(messages, signal)` 调用 mock；
- `queues.test.ts` / `context.test.ts` / `tool-execution.test.ts` 只经 `createMockStream` 间接使用，mock 内部适配后无需改动；`demo.ts` 经工厂间接使用，不受影响。

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

### 3. 错误模型：复用 retry-policy spec 的 ModelError

**本阶段不自定义错误形状**，直接采用 `2026-09-28-retry-policy-design-zh.md` 的错误模型（该文档为唯一权威来源）。若 retry 阶段尚未实施，本阶段按其定义先行落地 `packages/core/src/errors.ts`：

```ts
export type ModelErrorCode =
  | "rate_limit" | "timeout" | "network" | "server"
  | "authentication" | "invalid_request" | "context_overflow" | "unknown";

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly retryableOverride?: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: ModelErrorCode,
    message: string,
    options?: {
      retryableOverride?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    },
  );
}

export function isRetryableModelError(code: ModelErrorCode): boolean;

/** 已是 ModelError 则原样返回；否则包装成 code "unknown"。 */
export function toModelError(error: unknown): ModelError;
```

必须是 `Error` 子类：`Agent.emitFailure`（agent.ts）用 `error instanceof Error ? error.message : String(error)` 生成 errorMessage，非 Error 对象会变成 `"[object Object]"`。

**错误翻译的落点**：流中的错误并非在循环层被捕获——`agent-loop.ts` 的 `for await` 没有 try/catch，错误直接穿透到 `Agent.run` 的 catch → `emitFailure` 产出 `stopReason: "error" | "aborted"` 的 assistant 消息。因此"errorMessage 附带错误分类"的改动落点是 `agent.ts` 的 `emitFailure`：识别 `error instanceof ModelError` 时在 errorMessage 前冠以 `code`（如 `rate_limit: …`）。本阶段 `agent.ts` 列入改动文件。

## 适配器内部（packages/providers/deepseek）

### API 形状

```ts
export interface DeepSeekAdapterOptions {
  apiKey: string;
  baseURL?: string; // 默认 https://api.deepseek.com
  model?: string;   // 默认 deepseek-flash（与 jev-demo 一致；DeepSeekChatModelId 允许任意字符串）
  maxOutputTokens?: number;
}

export function createDeepSeekStream(options: DeepSeekAdapterOptions): StreamFn;
```

### 消息映射（messages.ts，纯函数）

```text
system      → { role: "system", content }
user        → { role: "user", content }
assistant   → { role: "assistant", content: [text 段…, tool-call 部分（参数字段名 input）…] }
toolResult  → { role: "tool", content: [{ type: "tool-result", toolCallId, toolName, output }] }
```

两处已核实的细节：

- assistant 的 `ToolCall.arguments: unknown` 作为 tool-call 部分的 **`input`** 字段回传（来自模型 JSON，保证可序列化）；
- tool-result 的 `output` **不是裸值**，必须包成判别联合：`isError` 为 false 用 `{ type: "text", value: content }`，为 true 用 `{ type: "error-text", value: content }`。

### 工具声明

core 的 `ToolDeclaration.parameters` 是裸 JSON Schema 对象，ai-sdk 的 `inputSchema` 需要 `FlexibleSchema`——用 ai 包导出的 **`jsonSchema()`** 包装。tool 只给 `description` + `inputSchema`，**不给 `execute`**（ai-sdk 对此有明确语义：无 execute 则不自动执行），模型发 tool-call 后停住，执行权回到 agent-loop——保持"模型只描述、循环层执行"的原则。

调用 `streamText` 时必须显式设置：

```ts
streamText({
  model,
  messages,
  tools,
  abortSignal: request.signal,
  maxRetries: 0,
  maxOutputTokens: options.maxOutputTokens,
});
```

ai-sdk v5 的 `streamText` 默认 `maxRetries` 为 2；不显式关闭会绕过 Runtime 的重试事件、预算和首事件锁定。

### 事件映射（adapter.ts）

消费 `streamText().fullStream`（已对照 ai@5 类型定义核实）：

```text
(开始)        → start       空 AssistantMessage
text-delta    → text_delta  取 part.text（注意：fullStream 层字段名是 text，不是 delta）+ 累计快照（与 mock 语义一致）
tool-call     → tool_call   part.input 已是按 inputSchema 解析校验后的对象，直接放入 ToolCall.arguments: unknown
finish        → end         stopReason 映射（见下）
error         → 映射为 ModelError 抛出（翻译落点见上节）
abort         → 显式抛出 request.signal.reason 或 AbortError
其余 part     → 显式忽略     text-start/end、reasoning-*、tool-input-*、start-step/finish-step、raw 等十余种
```

**tool-call 校验失败的分支**：ai-sdk 对 tool-call input 校验失败时不抛错，而是产出 `dynamic: true, invalid: true` 的 tool-call part。适配器检查 `part.invalid`，命中时抛 `ModelError{ code: "invalid_request" }`——对应 06 文档"非法 Tool JSON 产生明确错误，不能传入空对象"。

**stopReason 映射**（finish part 的 `finishReason`，取值为 `'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown'`）：

```text
"stop"          → "stop"
"tool-calls"    → "toolUse"
"length"        → "stop"，errorMessage 标注输出被截断
"content-filter"→ "error"，errorMessage 标注内容过滤
"error"         → 抛 ModelError("server", ...)
"other/unknown" → "error"，不能静默伪装成正常完成
```

**abort 不走 finish 事件**：当前 ai-sdk v5 的 `fullStream` 会产出 `{ type: "abort" }` 并关闭流，不保证以异常拒绝。适配器必须显式处理该 Part：

```ts
case "abort":
  request.signal.throwIfAborted();
  throw new DOMException("Model request aborted", "AbortError");
```

`Agent.emitFailure` 依据同一个 `request.signal.aborted` 生成 `stopReason: "aborted"`。不能把 Abort 当成“其余 Part”忽略，否则流会在没有 `end` 的情况下结束。

### 错误映射

ai-sdk v5 的错误形态（已核实）：HTTP 错误是 `APICallError`（`statusCode?: number`、`isRetryable: boolean`、`responseBody?: string`，从 `ai` 主入口再导出）；**网络异常没有独立类型**——fetch 失败被包装成 `statusCode === undefined`、`isRetryable: true` 的 `APICallError`。类型判断使用 `APICallError.isInstance(error)`，不依赖可能受重复依赖影响的 `instanceof`。

```text
APICallError statusCode 401 / 403 → authentication
APICallError statusCode 429       → rate_limit；提取 Retry-After → retryAfterMs
APICallError statusCode 408       → timeout
APICallError statusCode 5xx       → server
APICallError statusCode 400       → invalid_request
APICallError statusCode undefined → network
其他未知错误                       → toModelError() 兜底（unknown）
```

默认是否重试由 Retry Policy 的 `isRetryableModelError(code)` 决定，Adapter 不重复写 `retryableOverride`。只有 Provider 明确推翻默认分类时才使用 Override。

`Retry-After` 解析同时支持：

```text
Retry-After: 10
Retry-After: Wed, 21 Oct 2026 07:28:00 GMT
```

秒数转换为毫秒；HTTP Date 使用注入的 `now()` 计算非负差值；非法值或过去时间返回 `undefined`。errorMessage 截取限长（500 字符），显式移除 `apiKey`，并保留原 `APICallError` 为 `cause`。

## Server 集成

`packages/server/src/session.ts` 的 `createAgent()` 按环境变量选择（server 已有 `process.env.PORT/HOST` 的现成模式）：

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
- **环境变量加载**：server 的 dev 脚本参照 plugins 的现成模式加 `--env-file=.env`（`.env` 不入库）；也可直接用 shell 环境变量；
- `Agent` 构造签名不变，仅 stream 来源变化——"切换 Provider 不改 Agent Loop"的验收标准由此保证（本阶段对循环层的唯一改动是上文 ModelRequest 投影）；
- server 增加对 `@mini-agent/providers-deepseek` 的 workspace 依赖；
- 新 Provider 包使用精确依赖 `ai: "5.0.267"`、`@ai-sdk/deepseek: "1.0.59"`；修改 Manifest 后用 `pnpm install --lockfile-only --ignore-scripts` 刷新 Lockfile；
- server 现有测试（`session.test.ts` 直接调用 `createAgent()`）不设置 `MINI_AGENT_PROVIDER`，走 mock 分支，不受影响。

## 测试策略

原则：单元测试不打真实付费 API。

**providers-deepseek 包**（node:test；`MockLanguageModelV2` 来自 `ai/test` 子路径，`simulateReadableStream` 来自 `ai` 主入口——`ai/test` 里的同名导出已废弃）：

1. 流式 text-delta → 事件序列与累计快照正确（模拟层 chunk 是 `LanguageModelV2StreamPart`，字段名 `delta`；以 `{type:'stream-start', warnings:[]}` 开头，`finish` chunk 带 `usage` + `finishReason`）；
2. 完整 tool-call → 单个 `tool_call` 事件，arguments 为解析后的对象；
3. tool-call `invalid: true` → `ModelError{ code: "invalid_request" }`；
4. `finishReason: "tool-calls"` → `stopReason: "toolUse"`；`"error"` 不得映射成成功；`length/content-filter/unknown` 按表处理；
5. `streamText` 调用参数包含 `maxRetries: 0`；
6. 429 → `ModelError{ code: "rate_limit", retryAfterMs }`；401 → `authentication`；无 statusCode 的 APICallError → `network`，不重复保存默认 retryable 布尔值；
7. `Retry-After` 秒数、HTTP Date、非法值和过去时间均有确定性测试；
8. `fullStream` 的 `abort` Part 会抛取消错误，最终 Agent 状态为 aborted，且不产生 `end`；
9. 消息映射纯函数：四种角色（含 assistant 混合 content、tool-result 的 output 包装）→ 正确 ModelMessage；
10. API Key 不出现在映射后的 ModelError Message、Cause 摘要、事件或序列化输出；
11. 同一次 Runtime Retry 的所有 Attempt 收到同一个 ModelRequest/requestId；
12. 冒烟脚本 `pnpm demo:deepseek`（放在新包的 package.json，参照 plugins 用 `--env-file=.env`；手动运行，不进测试套件）：真实 API 跑"读 package.json"流程。

**core 包**：

- 上文枚举的签名波及面全部修复；
- 给 mock-llm 补一个"收到 tools 声明但不依赖它"的用例；
- `errors.ts`（ModelError / toModelError）若由本阶段先行落地，补归一化单测。

## 验收标准

- 切换 Provider 不修改 Agent Loop（仅环境变量 + server 一处分支）；
- Mock 模式仍可离线运行全部测试；
- 真实 DeepSeek 能调用现有 `read` 工具完成"读 package.json 并回答项目名称"；
- DeepSeek / ai-sdk 的类型不出现在 `packages/core` 公共 API；
- API Key 不出现在错误消息、事件流、WebSocket 状态与日志中；
- 适配器抛出的错误均为 `ModelError`（retry-policy spec 定义的 Error 子类），可被未来重试策略直接消费。

## 明确不做

- 多供应商；
- Provider 内部自动重试（`maxRetries: 0`）；Runtime Retry Policy 仍可在阶段 3 配置后统一重试；
- assistant 消息 usage / model / responseId 元数据（finish part 里是 `totalUsage`，本阶段忽略）；
- 手写 SSE 解析与增量 Tool Call 组装（由 ai-sdk 承担）；
- web 客户端改动。
