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
