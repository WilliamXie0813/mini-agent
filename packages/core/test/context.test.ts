import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeterministicCompactingTransform,
  createHeuristicTokenEstimator,
} from "../src/index.ts";
import type {
  AgentContextSnapshot,
  AgentMessage,
  ContextPreparation,
  DeterministicCompactingTransformOptions,
  PrepareNextTurn,
  PrepareRequest,
  TokenEstimator,
  TransformContext,
} from "../src/index.ts";

test("context pipeline contracts are publicly available", () => {
  const snapshot: AgentContextSnapshot = {
    messages: [],
    tools: [],
  };
  const preparation: ContextPreparation = { messages: snapshot.messages };
  const prepareRequest: PrepareRequest = async () => preparation;
  const prepareNextTurn: PrepareNextTurn = async () => preparation;
  const transform: TransformContext = async (messages) => messages.slice();
  const options: DeterministicCompactingTransformOptions = {
    maxInputTokens: 100,
    preserveRecentTurns: 1,
  };

  assert.equal(typeof prepareRequest, "function");
  assert.equal(typeof prepareNextTurn, "function");
  assert.equal(typeof transform, "function");
  assert.equal(typeof createHeuristicTokenEstimator(), "object");
  assert.equal(
    typeof createDeterministicCompactingTransform(options),
    "function",
  );
});

function messageCountEstimator(): TokenEstimator {
  return { estimate: (messages) => messages.length };
}

test("compacting transform replaces old turns and preserves recent turns", async () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "system", timestamp: 1 },
    { role: "user", content: "old user", timestamp: 2 },
    {
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
      stopReason: "stop",
      timestamp: 3,
    },
    { role: "user", content: "recent user", timestamp: 4 },
    {
      role: "assistant",
      content: [{ type: "text", text: "recent answer" }],
      stopReason: "stop",
      timestamp: 5,
    },
  ];
  const transform = createDeterministicCompactingTransform({
    maxInputTokens: 4,
    preserveRecentTurns: 1,
    estimator: messageCountEstimator(),
  });
  const result = await transform(messages, new AbortController().signal);
  assert.deepEqual(
    result.map((message) => message.role),
    ["system", "system", "user", "assistant"],
  );
  assert.match(
    result[1]?.role === "system" ? result[1].content : "",
    /Users: 1[\s\S]*Assistants: 1/,
  );
});

test("system messages split compacted segments without moving", async () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "initial", timestamp: 1 },
    { role: "user", content: "before", timestamp: 2 },
    {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      stopReason: "stop",
      timestamp: 3,
    },
    { role: "system", content: "update", timestamp: 4 },
    { role: "user", content: "after", timestamp: 5 },
    {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      stopReason: "stop",
      timestamp: 6,
    },
    { role: "user", content: "tail", timestamp: 7 },
  ];
  const transform = createDeterministicCompactingTransform({
    maxInputTokens: 5,
    preserveRecentTurns: 0,
    estimator: messageCountEstimator(),
  });
  const result = await transform(messages, new AbortController().signal);
  assert.deepEqual(
    result.map((message) =>
      message.role === "system" ? message.content.split("\n")[0] : message.role,
    ),
    [
      "initial",
      "[Earlier context compacted]",
      "update",
      "[Earlier context compacted]",
      "user",
    ],
  );
});

test("compaction reports tools and rejects impossible budgets", async () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "old", timestamp: 1 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call",
          name: "read",
          arguments: { z: 1, a: 2 },
        },
      ],
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: "missing",
      isError: true,
      timestamp: 3,
    },
    { role: "user", content: "tail", timestamp: 4 },
  ];
  const transform = createDeterministicCompactingTransform({
    maxInputTokens: 2,
    preserveRecentTurns: 0,
    estimator: messageCountEstimator(),
  });
  const result = await transform(messages, new AbortController().signal);
  assert.equal(result[0]?.role, "system");
  if (result[0]?.role === "system") {
    assert.match(result[0].content, /Tools used: read/);
    assert.match(result[0].content, /Errors: read/);
    assert.match(result[0].content, /read\(\{"a":2,"z":1\}\)/);
  }

  const impossible = createDeterministicCompactingTransform({
    maxInputTokens: 1,
    preserveRecentTurns: 1,
    estimator: messageCountEstimator(),
  });
  await assert.rejects(
    impossible(messages.slice(-2), new AbortController().signal),
    /No context messages can be compacted/,
  );
});

test("heuristic estimator counts natural text and message overhead", () => {
  const estimator = createHeuristicTokenEstimator();
  const messages: AgentMessage[] = [
    { role: "system", content: "你好ab", timestamp: 1 },
    { role: "user", content: "abcdefgh", timestamp: 2 },
  ];
  assert.equal(estimator.estimate(messages), 13);
});

test("heuristic estimator serializes tool data with sorted keys", () => {
  const estimator = createHeuristicTokenEstimator();
  const createMessages = (argumentsValue: unknown): AgentMessage[] => [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: argumentsValue,
        },
      ],
      stopReason: "toolUse",
      timestamp: 1,
    },
  ];
  assert.equal(
    estimator.estimate(createMessages({ z: 1, a: 2 })),
    estimator.estimate(createMessages({ a: 2, z: 1 })),
  );
});

test("heuristic estimator rejects circular values and bigint", () => {
  const estimator = createHeuristicTokenEstimator();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const createMessages = (argumentsValue: unknown): AgentMessage[] => [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call",
          name: "tool",
          arguments: argumentsValue,
        },
      ],
      stopReason: "toolUse",
      timestamp: 1,
    },
  ];
  assert.throws(
    () => estimator.estimate(createMessages(circular)),
    /Cannot serialize circular tool data/,
  );
  assert.throws(
    () => estimator.estimate(createMessages(1n)),
    /Cannot serialize bigint tool data/,
  );
});

test("compacting transform validates all numeric options", () => {
  const invalidOptions: DeterministicCompactingTransformOptions[] = [
    { maxInputTokens: 0, preserveRecentTurns: 1 },
    { maxInputTokens: 10, preserveRecentTurns: -1 },
    {
      maxInputTokens: 10,
      preserveRecentTurns: 1,
      maxExcerptCharacters: 0,
    },
  ];
  for (const options of invalidOptions) {
    assert.throws(() => createDeterministicCompactingTransform(options));
  }
});
