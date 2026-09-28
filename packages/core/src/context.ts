import type {
  AgentMessage,
  DeterministicCompactingTransformOptions,
  TokenEstimator,
  TransformContext,
} from "./types.ts";

const CJK_CHARACTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const UNDEFINED_SENTINEL = "[undefined]";

function stableSerialize(value: unknown): string {
  const ancestors = new Set<object>();

  function normalize(current: unknown): unknown {
    if (current === undefined) return UNDEFINED_SENTINEL;
    if (typeof current === "bigint") {
      throw new Error("Cannot serialize bigint tool data");
    }
    if (typeof current === "function" || typeof current === "symbol") {
      throw new Error(`Cannot serialize ${typeof current} tool data`);
    }
    if (current === null || typeof current !== "object") return current;
    if (ancestors.has(current)) {
      throw new Error("Cannot serialize circular tool data");
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((item) => normalize(item));
      }
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(current).sort()) {
        normalized[key] = normalize(
          (current as Record<string, unknown>)[key],
        );
      }
      return normalized;
    } finally {
      ancestors.delete(current);
    }
  }

  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) {
    throw new Error("Cannot serialize tool data");
  }
  return serialized;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function estimateNaturalText(value: string): number {
  let cjk = 0;
  let other = 0;
  for (const character of value) {
    if (CJK_CHARACTER.test(character)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function estimateStructuredText(value: string): number {
  return Math.ceil(codePointLength(value) / 3);
}

function estimateMessage(message: AgentMessage): number {
  let tokens = 4;
  if (message.role === "system" || message.role === "user") {
    return tokens + estimateNaturalText(message.content);
  }
  if (message.role === "toolResult") {
    tokens += estimateStructuredText(message.toolName);
    tokens += estimateStructuredText(message.content);
    if ("details" in message) {
      tokens += estimateStructuredText(stableSerialize(message.details));
    }
    return tokens;
  }
  for (const content of message.content) {
    if (content.type === "text") {
      tokens += estimateNaturalText(content.text);
    } else {
      tokens += estimateStructuredText(content.name);
      tokens += estimateStructuredText(stableSerialize(content.arguments));
    }
  }
  return tokens;
}

export function createHeuristicTokenEstimator(): TokenEstimator {
  return {
    estimate(messages) {
      return messages.reduce(
        (total, message) => total + estimateMessage(message),
        0,
      );
    },
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
  const maxExcerptCharacters = options.maxExcerptCharacters ?? 120;
  if (
    !Number.isInteger(maxExcerptCharacters) ||
    maxExcerptCharacters <= 0
  ) {
    throw new Error("maxExcerptCharacters must be a positive integer");
  }

  return async (messages) => messages.slice();
}
