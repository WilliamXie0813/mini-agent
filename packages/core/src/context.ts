/**
 * context.ts — 模型请求上下文的纯转换层
 *
 * 这里的函数只接收消息并返回新的消息数组，不修改 Agent 的原始 transcript。
 * 因此压缩后的临时 System Message 只会被模型看到，UI、Session 和事件订阅者
 * 仍然看到完整历史。
 */
import type {
  AgentMessage,
  DeterministicCompactingTransformOptions,
  TokenEstimator,
  TransformContext,
} from "./types.ts";

const CJK_CHARACTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const UNDEFINED_SENTINEL = "[undefined]";

/**
 * 将 unknown 工具数据转成稳定字符串。
 * 对象键排序保证相同数据不会因为属性插入顺序不同而产生不同估算或摘要；
 * ancestors 只跟踪当前递归路径，因此共享引用允许出现，真正的循环引用才报错。
 */
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
  // Array.from 按 Unicode Code Point 迭代，避免把 emoji 的代理对算成两个字符。
  return Array.from(value).length;
}

/** 教学型自然语言估算：中日韩字符约 1 token，其他字符约 4 个 1 token。 */
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
  // JSON、工具名和工具结果通常比自然语言更密集，因此使用更保守的 3:1。
  return Math.ceil(codePointLength(value) / 3);
}

/** 每条消息先计固定协议开销，再按不同消息结构估算正文。 */
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

interface Turn {
  indices: number[];
}

/**
 * 从线性 transcript 中恢复“完整 Turn”。
 * System Message 不属于任何 Turn；尾部尚未等到 Assistant 的消息标记为 incomplete，
 * 后续选择压缩范围时必须保留它们。
 */
function findTurns(messages: readonly AgentMessage[]): {
  turns: Turn[];
  incompleteIndices: number[];
} {
  const turns: Turn[] = [];
  let pendingUsers: number[] = [];
  let activeTurn: Turn | undefined;
  const incomplete = new Set<number>();
  const finish = () => {
    if (activeTurn) turns.push(activeTurn);
    activeTurn = undefined;
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role === "system") continue;
    if (message.role === "user") {
      finish();
      pendingUsers.push(index);
    } else if (message.role === "assistant") {
      finish();
      activeTurn = { indices: [...pendingUsers, index] };
      pendingUsers = [];
    } else if (activeTurn) {
      activeTurn.indices.push(index);
    } else {
      incomplete.add(index);
    }
  }
  finish();
  for (const index of pendingUsers) incomplete.add(index);
  return { turns, incompleteIndices: [...incomplete] };
}

/** 只选出可压缩的旧消息；System、最近 Turn 和未完成尾部永远不入选。 */
function selectOldIndices(
  messages: readonly AgentMessage[],
  preserveRecentTurns: number,
): Set<number> {
  const { turns, incompleteIndices } = findTurns(messages);
  const preserved = new Set(incompleteIndices);
  const recentTurns =
    preserveRecentTurns === 0 ? [] : turns.slice(-preserveRecentTurns);
  for (const turn of recentTurns) {
    for (const index of turn.indices) preserved.add(index);
  }
  const old = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role !== "system" && !preserved.has(index)) {
      old.add(index);
    }
  }
  return old;
}

function uniqueInOrder(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function truncateExcerpt(value: string, maximum: number): string {
  const normalized = value.replace(/[\r\n]+/g, " ");
  const codePoints = Array.from(normalized);
  return codePoints.length <= maximum
    ? normalized
    : `${codePoints.slice(0, maximum).join("")}...`;
}

function assistantExcerpt(
  message: Extract<AgentMessage, { role: "assistant" }>,
): string {
  return message.content
    .map((content) =>
      content.type === "text"
        ? content.text
        : `${content.name}(${stableSerialize(content.arguments)})`,
    )
    .join(" ");
}

/** 把一个连续旧消息分段压成一条确定性的临时 System Message。 */
function createCompactionMessage(
  segmentMessages: readonly AgentMessage[],
  maxExcerptCharacters: number,
): AgentMessage {
  const users = segmentMessages.filter((message) => message.role === "user");
  const assistants = segmentMessages.filter(
    (message) => message.role === "assistant",
  );
  const toolResults = segmentMessages.filter(
    (message) => message.role === "toolResult",
  );
  const tools = uniqueInOrder([
    ...assistants.flatMap((message) =>
      message.content.flatMap((content) =>
        content.type === "toolCall" ? [content.name] : [],
      ),
    ),
    ...toolResults.map((message) => message.toolName),
  ]);
  const errors = uniqueInOrder(
    toolResults
      .filter((message) => message.isError)
      .map((message) => message.toolName),
  );
  const excerpts: string[] = [];
  const user = users.at(-1);
  const assistant = assistants.at(-1);
  const toolResult = toolResults.at(-1);
  if (user) {
    excerpts.push(
      `- user: ${truncateExcerpt(user.content, maxExcerptCharacters)}`,
    );
  }
  if (assistant) {
    excerpts.push(
      `- assistant: ${truncateExcerpt(
        assistantExcerpt(assistant),
        maxExcerptCharacters,
      )}`,
    );
  }
  if (toolResult) {
    excerpts.push(
      `- toolResult(${toolResult.toolName}): ${truncateExcerpt(
        toolResult.content,
        maxExcerptCharacters,
      )}`,
    );
  }
  return {
    role: "system",
    content: [
      "[Earlier context compacted]",
      `Messages: ${segmentMessages.length}`,
      `Users: ${users.length}`,
      `Assistants: ${assistants.length}`,
      `Tool results: ${toolResults.length}`,
      `Tools used: ${tools.join(", ") || "none"}`,
      `Errors: ${errors.join(", ") || "none"}`,
      "Recent excerpts:",
      ...excerpts,
    ].join("\n"),
    timestamp: segmentMessages.at(-1)?.timestamp ?? 0,
  };
}

/**
 * 在原位置替换连续旧消息。遇到 System 或需要保留的消息就 flush，
 * 所以摘要不会跨过中途的系统指令，避免改变因果顺序。
 */
function replaceOldSegments(
  messages: readonly AgentMessage[],
  oldIndices: ReadonlySet<number>,
  maxExcerptCharacters: number,
): AgentMessage[] {
  const result: AgentMessage[] = [];
  let segment: AgentMessage[] = [];
  const flush = () => {
    if (segment.length === 0) return;
    result.push(createCompactionMessage(segment, maxExcerptCharacters));
    segment = [];
  };
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (oldIndices.has(index)) segment.push(message);
    else {
      flush();
      result.push(message);
    }
  }
  flush();
  return result;
}

/** 创建无状态估算器；估算结果只用于预算判断，不用于计费。 */
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

/**
 * 创建确定性压缩 Transform。
 * 它先估算完整请求，超预算时只替换较早的完整 Turn，最后再次验证预算；
 * 整个过程不调用模型，也不会修改传入数组。
 */
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
  const estimator = options.estimator ?? createHeuristicTokenEstimator();

  return async (messages, signal) => {
    signal.throwIfAborted();
    // 先复制，确保即使无需压缩也不会把调用方持有的数组直接传出去。
    const original = messages.slice();
    if (estimator.estimate(original) <= options.maxInputTokens) return original;
    const oldIndices = selectOldIndices(original, options.preserveRecentTurns);
    if (oldIndices.size === 0) {
      throw new Error("No context messages can be compacted");
    }
    const compacted = replaceOldSegments(
      original,
      oldIndices,
      maxExcerptCharacters,
    );
    // 压缩不是“尽力而为”：结果仍超预算时明确失败，避免模型收到无效请求。
    if (estimator.estimate(compacted) > options.maxInputTokens) {
      throw new Error(
        "Context remains over budget after deterministic compaction",
      );
    }
    return compacted;
  };
}
