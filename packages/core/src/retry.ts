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
