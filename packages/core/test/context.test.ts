import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeterministicCompactingTransform,
  createHeuristicTokenEstimator,
} from "../src/index.ts";
import type {
  AgentContextSnapshot,
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
