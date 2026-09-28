import type {
  DeterministicCompactingTransformOptions,
  TokenEstimator,
  TransformContext,
} from "./types.ts";

export function createHeuristicTokenEstimator(): TokenEstimator {
  return {
    estimate: () => 0,
  };
}

export function createDeterministicCompactingTransform(
  options: DeterministicCompactingTransformOptions,
): TransformContext {
  if (!Number.isInteger(options.maxInputTokens) || options.maxInputTokens <= 0) {
    throw new Error("maxInputTokens must be a positive integer");
  }
  if (
    !Number.isInteger(options.preserveRecentTurns) ||
    options.preserveRecentTurns < 0
  ) {
    throw new Error("preserveRecentTurns must be a non-negative integer");
  }

  return async (messages) => messages.slice();
}
