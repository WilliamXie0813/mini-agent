# 阶段 3：重试与错误分类

## 当前问题

核心版把模型异常转换为：

```text
stopReason: "error"
```

真实网络调用会出现短暂失败，例如限流、连接重置和服务端故障。如果所有失败都立即终止，Agent 可靠性不足；如果所有失败都重试，又可能重复副作用。

本阶段解决“**失败是否可重试、何时重试、重试是否会重复已提交工作**”。

## 学习目标

- 将错误分类与重试调度分离。
- 理解模型请求重试与工具重试的风险差异。
- 实现可测试的退避、次数上限和取消。
- 明确消息提交边界，避免重复 Assistant Message。

## 非目标

- 不自动重试工具。
- 不做跨进程任务恢复。
- 不实现熔断器。
- 不绑定某个供应商错误类型。

## 方案比较

### 方案 A：在 Provider 内部固定重试

Provider 最了解 HTTP 错误，但 Runtime 无法观察尝试次数，也不能统一控制预算。

### 方案 B：Agent Loop 捕获所有错误并重试

统一但危险，Loop 不知道流是否已经产生内容，也不知道失败是否可恢复。

### 方案 C：规范化模型错误 + `RetryPolicy`，推荐

Provider 将供应商错误转换成统一错误，Runtime 使用策略决定是否重试。

## 错误模型

增加：

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
  readonly retryAfterMs?: number;
}
```

分类建议：

| 错误 | 默认重试 |
|---|---|
| `rate_limit` | 是 |
| `timeout` | 是 |
| `network` | 是 |
| `server` | 是，限制次数 |
| `authentication` | 否 |
| `invalid_request` | 否 |
| `context_overflow` | 否，应交给上下文管线 |
| `unknown` | 否 |

## RetryPolicy

```ts
export interface RetryContext {
  attempt: number;
  error: ModelError;
  elapsedMs: number;
}

export type RetryDecision =
  | { retry: false }
  | { retry: true; delayMs: number };

export interface RetryPolicy {
  decide(context: RetryContext): RetryDecision;
}
```

推荐默认策略：

```text
最多 3 次尝试
指数退避：250ms、500ms、1000ms
加入少量 jitter
尊重 retryAfterMs
总延迟不超过配置上限
```

测试时注入确定性随机数和 `sleep()`，避免真实等待。

## 关键提交边界

一次模型尝试只有在收到最终 `end` 事件后，Assistant Message 才进入正式历史。

如果尝试在任何内容产生前失败：

```text
安全丢弃该尝试
→ 等待
→ 重新调用 StreamFn
```

如果已经向外发出 `message_start` 或 `message_update`：

- 不能假装这些事件没发生。
- 教学版推荐不自动重试，直接产生 error Message。
- 进阶方案可以增加 `attemptId` 和“临时流事件”，但会显著增加 UI 复杂度。

因此第一版重试边界为：

> 仅重试在第一个模型流事件之前发生的可重试失败。

## 工具为什么不自动重试

以下工具可能已经成功，只是响应丢失：

```text
send_email
create_order
write_file
charge_payment
```

自动重试可能执行两次。工具接口先增加元数据，为未来恢复做准备：

```ts
export type ReplayPolicy = "safe" | "never";

export interface Tool<T> {
  replay?: ReplayPolicy;
}
```

本阶段只记录该属性，不进行自动重放。

## 新事件

增加模型尝试事件：

```ts
type AgentEvent =
  | {
      type: "model_retry_scheduled";
      attempt: number;
      delayMs: number;
      code: ModelErrorCode;
    }
  | {
      type: "model_retry_started";
      attempt: number;
    };
```

这些事件供日志、Web UI 和后续 Telemetry 使用，但不写入 Transcript。

## 调用链变化

```text
prepare request
    ↓
attempt 1
    ├── 首事件前可重试错误
    │       ↓ RetryPolicy
    │     wait
    │       ↓
    │   attempt 2
    └── 已产生流事件后失败
            ↓
         error Assistant Message
```

## 取消语义

- 退避等待必须接受 `AbortSignal`。
- abort 后不能开始下一次尝试。
- `RetryPolicy` 本身应为纯决策，不负责 sleep。
- 如果 Signal 已中止，错误结果是 `aborted`，不是 `error`。

## 对现有包的影响

### `packages/core`

- 新增 `errors.ts` 和 `retry.ts`。
- `StreamFn` 可以抛 `ModelError`。
- `AgentOptions` 接收 `RetryPolicy`、`sleep` 和最大总延迟。
- `agent-loop.ts` 的模型调用通过 `streamWithRetry()`。

### `packages/server`

协议需要允许新的 retry 事件通过现有 `AgentEvent` 联合。

### `packages/web`

可以展示“将在 500ms 后进行第 2 次尝试”，但不应把重试事件添加到消息历史。

## 测试策略

1. 第一次在首事件前抛 `network`，第二次成功。
2. `authentication` 不重试。
3. 达到最大次数后产生 error Assistant Message。
4. `retryAfterMs` 覆盖指数退避。
5. abort 发生在等待期间，不启动下一尝试。
6. 已产生 `text_delta` 后失败时不自动重试。
7. retry 事件顺序正确。
8. 工具抛错仍然成为 Tool Result，不进入模型 RetryPolicy。

## 验收标准

- 相同输入在临时网络失败后可以完成。
- 不可重试错误立即失败。
- Transcript 不包含重复 Assistant Message。
- 工具不会被自动重放。
- 所有等待都可以取消并可在测试中替换。

## 学习练习

1. 写一个前两次失败、第三次成功的 Mock Stream。
2. 修改策略为固定延迟，比较与指数退避的差异。
3. 在第一个 `text_delta` 后抛错，观察为什么不能透明重试。
4. 为 `read` 标记 `replay: "safe"`，但确认 Runtime 仍不自动重试它。

## 进入下一阶段前

你应该能够回答：

- 为什么首事件前失败和流式输出后失败不同？
- 为什么模型重试相对安全，而工具重试通常不安全？
- RetryPolicy 为什么不应该自己等待？

