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
  readonly retryableOverride?: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: ModelErrorCode,
    message: string,
    options: {
      retryableOverride?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ModelError";
    this.code = code;
    this.retryableOverride = options.retryableOverride;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isRetryableModelError(code: ModelErrorCode): boolean {
  return (
    code === "rate_limit" ||
    code === "timeout" ||
    code === "network" ||
    code === "server"
  );
}

export function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  return new ModelError(
    "unknown",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}
