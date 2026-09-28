# 重试与错误分类设计

日期：2026-09-28  
来源：[阶段 3：重试与错误分类](../../extension/03-retry-policy.md)

## 目的

为 `packages/core` 增加规范化模型错误与可替换的重试策略，让临时性模型失败（限流、超时、网络、服务端故障）可以自动恢复，同时保证不可重试错误立即失败、工具永不自动重放、Transcript 不出现重复 Assistant Message。

本设计解决三个问题：

1. 失败是否可重试（错误分类与重试决策分离）。
2. 何时重试（仅在第一个模型流事件之前的失败可重试）。
3. 重试如何可观察、可取消、可在测试中替换（重试事件 + 注入 sleep 与随机源）。

## 范围

### 本阶段包含

- `ModelError` 规范化错误模型与 `toModelError` 归一化辅助函数。
- `RetryPolicy` 纯决策接口与 `createDefaultRetryPolicy` 默认策略工厂。
- `streamWithRetry`：把多次尝试、首事件锁定、重试事件发射收敛在一个异步生成器中。
- `AgentEvent` 新增 `model_retry_scheduled` / `model_retry_started`。
- `SleepFn` 注入，退避等待可取消、可在测试中替换。
- `Tool` 增加 `replay?: "safe" | "never"` 元数据（只声明，不消费）。
- 完整的 core 单元测试（假 sleep + 确定性随机源）。

### 本阶段不包含

- 自动重试工具（`replay` 元数据只记录，Runtime 永不自动重放）。
- 已产生流事件后的透明重试（`attemptId` / 临时流事件属于进阶方案）。
- 跨进程任务恢复。
- 熔断器。
- 真实供应商错误映射（属于[阶段 6：真实模型适配器](../../extension/06-real-llm-adapter.md)；本阶段由 Mock Stream 直接抛 `ModelError`）。
- Web 必须的重试 UI（可选加分项）。

## 核心不变量

| 不变量 | 说明 |
|---|---|
| 一次模型请求最多贡献一条 Assistant Message | 要么成功尝试的 `end` 消息，要么失败/中止消息 |
| 首事件锁定 | 异步迭代器产出过任何事件（含 `start`）后，失败一律不重试 |
| 边界规则优先于 retryable | 已锁定后即使错误可重试也不重试 |
| 策略是纯决策 | `RetryPolicy.decide()` 不 sleep、不发事件、不感知 Loop |
| 重试复用同一请求 | prepare/transform 跑一次，每次尝试使用同一份 `requestMessages` |
| 重试事件不进 Transcript | `model_retry_*` 只是观察信号，不产生消息生命周期事件 |
| 未配置策略时行为零变化 | 未传 `retryPolicy` 时单次尝试，现有测试与调用方全部不受影响 |

## 错误模型

在 `packages/core/src/errors.ts` 新增：

```ts
export type ModelErrorCode =
  | "rate_limit"
  | "timeout"
  | "network"
  | "server"
  | "authentication"
  | "invalid_request"
  | "context_overflow"
  | "unknown";

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;
  /** 供应商建议的等待时间（如 429 的 Retry-After），单位毫秒。 */
  readonly retryAfterMs?: number;
}
```

默认重试分类：

| 错误 | 默认重试 |
|---|---|
| `rate_limit` | 是 |
| `timeout` | 是 |
| `network` | 是 |
| `server` | 是（受次数与总预算限制） |
| `authentication` | 否 |
| `invalid_request` | 否 |
| `context_overflow` | 否（交给上下文管线） |
| `unknown` | 否 |

归一化辅助函数：

```ts
/** 已是 ModelError 则原样返回；否则包装成 code "unknown"、retryable false。 */
export function toModelError(error: unknown): ModelError;
```

策略接口因此永远只看到 `ModelError`，自定义策略不需要重复写归一化逻辑。错误分类的责任在 StreamFn 实现一侧：Mock Stream 直接抛 `ModelError`，真实适配器（阶段 6）负责把供应商 HTTP 错误映射成对应 code。

## RetryPolicy 接口

```ts
export interface RetryContext {
  /** 已完成的尝试次数：第一次失败时 attempt 为 1。 */
  attempt: number;
  error: ModelError;
  /** 从首次尝试开始累计的墙钟毫秒数。 */
  elapsedMs: number;
}

export type RetryDecision =
  | { retry: false }
  | { retry: true; delayMs: number };

export interface RetryPolicy {
  decide(context: RetryContext): RetryDecision;
}

/** 退避等待：必须在 signal 中止时 reject（AbortError）。 */
export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;
```

`RetryPolicy` 是纯决策：不 sleep、不发射事件、不知道自己在 Loop 的哪个 Turn。可测试性来自两个注入点：假 `sleep`（零真实等待）和确定性 `random`（消除 jitter 随机性）。

## 默认策略

`packages/core/src/retry.ts` 导出：

```ts
export interface DefaultRetryPolicyOptions {
  /** 含首次尝试在内的最大尝试次数，默认 3。 */
  maxAttempts?: number;
  /** 退避基数，默认 250ms。 */
  baseDelayMs?: number;
  /** 指数因子，默认 2（得到 250 / 500 / 1000）。 */
  factor?: number;
  /** 单次延迟上限，默认 10_000ms。 */
  maxDelayMs?: number;
  /** 累计等待预算，默认 30_000ms；超出则拒绝重试。 */
  maxTotalDelayMs?: number;
  /** 抖动比例，默认 0.1，即 delay × (1 ± 10%)。 */
  jitterRatio?: number;
  /** 随机源，默认 Math.random；测试注入确定性函数。 */
  random?: () => number;
}

export function createDefaultRetryPolicy(
  options?: DefaultRetryPolicyOptions,
): RetryPolicy;
```

决策规则按顺序短路：

1. `error.retryable === false` → `{ retry: false }`；
2. `attempt + 1 > maxAttempts` → `{ retry: false }`；
3. `delay = min(error.retryAfterMs ?? baseDelayMs × factor^(attempt-1), maxDelayMs)`；
4. 乘上 jitter：`delay × (1 + jitterRatio × (2 × random() - 1))`；
5. `elapsedMs + delay > maxTotalDelayMs` → `{ retry: false }`；
6. 否则 `{ retry: true, delayMs }`。

`retryAfterMs` 覆盖指数退避结果，但仍受 `maxDelayMs` 与总预算约束——供应商不能单方面撑爆等待预算。

策略未配置时不重试（opt-in）：`AgentOptions.retryPolicy` 缺省为 `undefined`，模型调用退化为单次尝试，行为与现状逐字节一致。需要重试的调用方显式传入 `createDefaultRetryPolicy()` 或自定义策略。

## streamWithRetry 与首事件锁定

`retry.ts` 导出核心包装器：

```ts
export interface StreamRetryOptions {
  stream: StreamFn;
  /** 每次尝试复用同一份请求消息（prepare/transform 只跑一次）。 */
  messages: readonly AgentMessage[];
  policy: RetryPolicy;
  sleep: SleepFn;
  signal: AbortSignal;
  /** 直接复用 Loop 的 emit，保证重试事件与其他 AgentEvent 的顺序。 */
  emit: EventSink;
}

export async function* streamWithRetry(
  options: StreamRetryOptions,
): AsyncIterable<ModelStreamEvent>;
```

语义：

1. `attempt` 从 1 开始递增；`startedAt` 记录首次尝试的墙钟起点。
2. 每次尝试内部维护 `locked = false`；迭代器每 yield 一个事件后置为 `true`。
3. 尝试抛错（调用即抛或迭代中抛）时：
   - 先 `toModelError(error)` 归一化；
   - `signal.aborted` → 原样向上抛（abort 不走重试决策）；
   - `locked === true` → 直接向上抛，**不询问策略**；
   - 未锁定 → `policy.decide({ attempt, error, elapsedMs })`；
     - 拒绝 → 向上抛；
     - 接受 → `emit(model_retry_scheduled)` → `await sleep(delayMs, signal)` → `emit(model_retry_started)` → 进入下一次尝试。
4. `sleep` 因 abort reject 时原样向上抛。
5. 成功尝试的事件原样 yield 给消费端。

`agent-loop.ts` 的 `streamAssistantResponse` 只改模型调用一处：

```ts
const stream =
  config.retryPolicy && config.sleep
    ? streamWithRetry({
        stream: config.stream,
        messages: requestMessages,
        policy: config.retryPolicy,
        sleep: config.sleep,
        signal,
        emit,
      })
    : config.stream(requestMessages, signal);

for await (const modelEvent of stream) { /* 现有逻辑不变 */ }
```

策略与 sleep 必须同时配置才启用重试；`Agent` 在构造时校验两者同有或同无（只给一个直接抛配置错误）。

### 为什么首事件锁定

`start` 事件已被 Loop 转译成 `message_start` 发给订阅者，`text_delta` / `tool_call` 已变成 `message_update`。这些事件不能装作没发生：UI 已经开始渲染这条消息，Web 客户端可能已经转发。教学版因此不重试已锁定的尝试，失败直接进入现有的 `emitFailure` 通道，产生一条 `stopReason: "error"` 的 Assistant Message。带 `attemptId` 的透明重试是进阶方案，本阶段明确不做。

## 新事件

```ts
type AgentEvent =
  | /* ... 现有事件 ... */
  | {
      type: "model_retry_scheduled";
      /** 即将开始的尝试次数（2 表示第一次重试）。 */
      attempt: number;
      delayMs: number;
      code: ModelErrorCode;
    }
  | {
      type: "model_retry_started";
      attempt: number;
    };
```

语义约束：

- `attempt` 统一指**即将开始**的尝试，`model_retry_scheduled { attempt: 2 }` 读作「将在 delayMs 后进行第 2 次尝试」。
- 两个事件成对出现且顺序固定：`scheduled → sleep → started`。等待期间 abort 时只会有 `scheduled` 没有 `started`。
- 重试成功时，这些事件之前**不存在**任何 `message_start` / `message_update`（首事件锁定保证）。
- 事件只供观察：不写入 Transcript，不触发消息生命周期。

### Agent 归约

`Agent.processEvent` 不为两个新事件增加 case：switch 自然落空，状态不变，仅通知订阅者。这与 `tool_execution_update` 之外瞬态信号的处理方式一致。

### Server 与 Web

Server 把事件作为 `{ type: "event"; event: AgentEvent }` 泛化转发，新联合成员无需改动代码，类型随 core 自动更新。

Web 的 reducer 对新事件不做状态变更；EventTimeline 现有 `eventColors[type] ?? "default"` 会自然展示。可选加分项：把 `model_retry_scheduled` 渲染成「网络错误，等待 500ms 后进行第 2 次尝试」的提示，不是本阶段必需。

## 取消语义

- 退避等待、模型流、Hook 共享同一个 Run `AbortSignal`。
- `sleep` 的默认实现：真实 `setTimeout`，signal 中止时以 `AbortError` reject；**signal 已中止时立即 reject，不启动定时器**。
- abort 后不能开始下一次尝试：sleep reject 或 `signal.throwIfAborted()` 都会让异常向上抛到 `Agent.emitFailure`，依据 `signal.aborted` 产出 `stopReason: "aborted"`（不是 `"error"`）。
- `RetryPolicy` 本身不 sleep，因此策略决策不可被取消也不需要取消。

## 工具为什么不自动重试

`send_email` / `create_order` / `write_file` / `charge_payment` 这类工具可能已经成功、只是响应丢失，自动重试会执行两次。本阶段只为未来恢复做准备：

```ts
export type ReplayPolicy = "safe" | "never";

export interface Tool<TParameters> {
  // ...现有字段
  /** 为未来跨进程恢复预留的元数据；当前 Runtime 永不自动重放工具。 */
  replay?: ReplayPolicy;
}
```

工具抛错仍然走现有通道：成为 `isError: true` 的 Tool Result Message 喂回模型，不进入 `streamWithRetry` 的决策范围（重试只包在模型调用一层）。

## 错误信息

策略拒绝或达到上限后抛出的 `ModelError` 由 `emitFailure` 变成 error Assistant Message。为了让 UI 直接可读，`streamWithRetry` 在确实尝试过多次后放弃时（`attempt > 1`）重写错误文案：

```text
network error after 3 attempts: connection reset
```

首次尝试即失败时（不可重试错误，或首次失败就被预算拒绝）保持原文案，不加 "after 1 attempt" 噪音。

## 文件改动

### `packages/core/src/errors.ts`（新增）

- `ModelErrorCode`、`ModelError`、`toModelError`。

### `packages/core/src/retry.ts`（新增）

- `RetryContext`、`RetryDecision`、`RetryPolicy`、`SleepFn`。
- `createDefaultRetryPolicy` 与选项校验（次数/延迟必须是正数，`jitterRatio` 在 `[0, 1]`）。
- 默认 `sleep` 实现（`setTimeout` + abort reject）。
- `streamWithRetry`。

### `packages/core/src/types.ts`

- `AgentEvent` 增加 `model_retry_scheduled` / `model_retry_started`。
- `Tool` 增加 `replay?: ReplayPolicy`，新增 `ReplayPolicy` 类型。
- `AgentLoopConfig` 增加 `retryPolicy?: RetryPolicy`、`sleep?: SleepFn`。

### `packages/core/src/agent-loop.ts`

- `streamAssistantResponse` 的模型调用经 `streamWithRetry`（仅当 `retryPolicy` 与 `sleep` 都非空；`Agent` 会为配置了策略的调用方填充默认 sleep）。
- 消费端 `for await` 逻辑不变。

### `packages/core/src/agent.ts`

- `AgentOptions` 增加 `retryPolicy?: RetryPolicy`、`sleep?: SleepFn`。
- `sleep` 缺省时填充默认实现（真实 `setTimeout` + abort reject）。
- 校验：只允许单独缺省 `sleep`；只传 `sleep` 而不传 `retryPolicy` 是配置错误，构造时直接抛错。
- 透传到 `AgentLoopConfig`；`processEvent` 对新事件不做状态变更。

### `packages/core/src/index.ts`

- 公开导出错误模型、策略接口、工厂与 `streamWithRetry`。

### `packages/server`

- 无代码改动；事件泛化转发，类型随 core 更新。

### `packages/web`

- 无必需改动；可选在 EventTimeline 中优化重试事件的展示文案。

### `packages/core/test`

- 新增 `retry.test.ts`（策略单元测试 + `streamWithRetry` 行为测试）。
- 扩展 `agent-loop.test.ts`（重试与 Loop 生命周期、队列、事件的集成）。

## 测试要求

### 策略单元测试（确定性）

1. 默认参数（`maxAttempts: 3`）下实际退避为 250 / 500；配置 `maxAttempts: 4` 时序列为 250 / 500 / 1000（注入 `random: () => 0.5` 使 jitter 恒为 1，断言精确值）。
2. `retryable: false` 的错误一律拒绝。
3. `attempt + 1 > maxAttempts` 拒绝。
4. `retryAfterMs` 覆盖指数退避，但不超过 `maxDelayMs`。
5. 累计延迟超过 `maxTotalDelayMs` 拒绝。
6. jitter 比例生效：`random()` 两端值分别给出 ±10% 的延迟。

### streamWithRetry 行为测试（假 sleep）

7. 第一次在首事件前抛 `network`，第二次成功：产出 `scheduled(2) → started(2)`，最终只有成功流的事件。
8. 已产出 `text_delta` 后失败：即使错误可重试也直接抛，无重试事件。
9. 产出 `start` 后即抛错也视为锁定，不重试。
10. 非 ModelError 异常包装为 `unknown` 且不重试。
11. 等待期间 abort：sleep reject，不发射 `model_retry_started`，不开始下一尝试。
12. 达到 `maxAttempts` 后抛出的错误文案含尝试次数。
13. 每次尝试收到的 `messages` 是同一份请求（引用相等）。

### Loop 集成测试

14. 重试成功后 Transcript 只含一条成功 Assistant Message，无重复。
15. 重试事件序列与 `message_start` 的相对顺序正确（重试事件之前没有任何消息事件）。
16. 不可重试错误立即产生 `stopReason: "error"` 的 Assistant Message。
17. abort 期间产出 `stopReason: "aborted"`。
18. 工具抛错仍是 `isError: true` 的 Tool Result，不触发模型重试策略。
19. 只配置 `sleep` 而不配置 `retryPolicy` 时构造抛配置错误；只配置 `retryPolicy` 时使用默认 sleep 正常重试。

### 回归

20. 未配置 `retryPolicy` 时现有全部 core 测试通过，模型输入、事件顺序、队列优先级不变。
21. 新类型与工厂可从 `@mini-agent/core` 公共入口导入。
22. Server 和 Web 无需修改即可构建和运行。

## 验收标准

- 相同输入在临时网络失败后可以完成，且 Transcript 无重复 Assistant Message。
- 不可重试错误立即失败。
- 所有等待可取消、可在测试中用假 sleep 替换。
- 工具不被自动重放；`replay` 元数据只被记录。
- 未配置策略时行为与现状完全一致（opt-in）。
- `pnpm --filter @mini-agent/core run check` 通过。
- `pnpm --filter @mini-agent/core run test` 通过。
- Server 和 Web 无需修改即可继续构建和运行。
