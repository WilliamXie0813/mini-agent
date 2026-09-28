import {
  ModelError,
  isRetryableModelError,
  toModelError,
} from "./errors.ts";
import type {
  EventSink,
  ModelStreamEvent,
} from "./types.ts";

export interface RetryContext {
  attempt: number;
  error: ModelError;
  totalDelayMs: number;
}

export type RetryDecision =
  | { retry: false }
  | { retry: true; delayMs: number };

export interface RetryPolicy {
  decide(context: RetryContext): RetryDecision;
}

export type SleepFn = (
  ms: number,
  signal: AbortSignal,
) => Promise<void>;

export interface DefaultRetryPolicyOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  maxTotalDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be greater than 0`);
  }
  return value;
}

export function createDefaultRetryPolicy(
  options: DefaultRetryPolicyOptions = {},
): RetryPolicy {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = positive("baseDelayMs", options.baseDelayMs ?? 2_000);
  const factor = positive("factor", options.factor ?? 2);
  const maxDelayMs = positive("maxDelayMs", options.maxDelayMs ?? 10_000);
  const maxTotalDelayMs = options.maxTotalDelayMs ?? 30_000;
  const jitterRatio = options.jitterRatio ?? 0.1;
  const random = options.random ?? Math.random;

  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("maxRetries must be a non-negative integer");
  }
  if (!Number.isFinite(maxTotalDelayMs) || maxTotalDelayMs < 0) {
    throw new Error("maxTotalDelayMs must be greater than or equal to 0");
  }
  if (
    !Number.isFinite(jitterRatio) ||
    jitterRatio < 0 ||
    jitterRatio > 1
  ) {
    throw new Error("jitterRatio must be between 0 and 1");
  }

  return {
    decide({ attempt, error, totalDelayMs }) {
      const retryable =
        error.retryableOverride ??
        isRetryableModelError(error.code);
      if (!retryable || attempt > maxRetries) return { retry: false };

      const candidateDelay =
        error.retryAfterMs ??
        baseDelayMs *
          factor ** (attempt - 1) *
          (1 + jitterRatio * (2 * random() - 1));
      const delayMs = Math.min(candidateDelay, maxDelayMs);

      if (totalDelayMs + delayMs > maxTotalDelayMs) {
        return { retry: false };
      }
      return { retry: true, delayMs };
    },
  };
}

export const defaultSleep: SleepFn = async (ms, signal) => {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

export interface StreamRetryOptions {
  startAttempt: () => AsyncIterable<ModelStreamEvent>;
  policy: RetryPolicy;
  sleep: SleepFn;
  signal: AbortSignal;
  emit: EventSink;
}

function finalAttemptError(error: ModelError, attempt: number): ModelError {
  if (attempt === 1) return error;
  return new ModelError(
    error.code,
    `${error.code} error after ${attempt} attempts: ${error.message}`,
    {
      retryableOverride: error.retryableOverride,
      retryAfterMs: error.retryAfterMs,
      cause: error,
    },
  );
}

export async function* streamWithRetry({
  startAttempt,
  policy,
  sleep,
  signal,
  emit,
}: StreamRetryOptions): AsyncIterable<ModelStreamEvent> {
  let attempt = 1;
  let totalDelayMs = 0;

  while (true) {
    let locked = false;
    let receivedEnd = false;

    try {
      signal.throwIfAborted();
      for await (const event of startAttempt()) {
        locked = true;
        if (event.type === "end") receivedEnd = true;
        yield event;
      }
      if (receivedEnd) return;
      throw new ModelError(
        "network",
        "Model stream ended before end event",
      );
    } catch (thrown) {
      if (signal.aborted) throw thrown;
      const error = toModelError(thrown);
      if (locked) throw finalAttemptError(error, attempt);

      const decision = policy.decide({
        attempt,
        error,
        totalDelayMs,
      });
      if (!decision.retry) {
        throw finalAttemptError(error, attempt);
      }

      const nextAttempt = attempt + 1;
      await emit({
        type: "model_retry_scheduled",
        attempt: nextAttempt,
        delayMs: decision.delayMs,
        code: error.code,
      });
      await sleep(decision.delayMs, signal);
      totalDelayMs += decision.delayMs;
      signal.throwIfAborted();
      await emit({
        type: "model_retry_started",
        attempt: nextAttempt,
      });
      attempt = nextAttempt;
    }
  }
}
