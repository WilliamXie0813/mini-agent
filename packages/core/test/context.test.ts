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
import { identifiedMessage } from "./helpers/messages.ts";

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
    identifiedMessage("system-root", {
      role: "system",
      content: "system",
      timestamp: 1,
    }),
    identifiedMessage("old-user", {
      role: "user",
      content: "old user",
      timestamp: 2,
    }),
    identifiedMessage("old-assistant", {
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
      stopReason: "stop",
      timestamp: 3,
    }),
    identifiedMessage("recent-user", {
      role: "user",
      content: "recent user",
      timestamp: 4,
    }),
    identifiedMessage("recent-assistant", {
      role: "assistant",
      content: [{ type: "text", text: "recent answer" }],
      stopReason: "stop",
      timestamp: 5,
    }),
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
  assert.equal(
    result[1]?.id,
    "context-summary:old-user:old-assistant",
  );
  const repeated = await transform(messages, new AbortController().signal);
  assert.equal(repeated[1]?.id, result[1]?.id);
  assert.match(
    result[1]?.role === "system" ? result[1].content : "",
    /Users: 1[\s\S]*Assistants: 1/,
  );
});

test("system messages split compacted segments without moving", async () => {
  const messages: AgentMessage[] = [
    identifiedMessage("initial-system", {
      role: "system",
      content: "initial",
      timestamp: 1,
    }),
    identifiedMessage("before-user", {
      role: "user",
      content: "before",
      timestamp: 2,
    }),
    identifiedMessage("before-assistant", {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      stopReason: "stop",
      timestamp: 3,
    }),
    identifiedMessage("update-system", {
      role: "system",
      content: "update",
      timestamp: 4,
    }),
    identifiedMessage("after-user", {
      role: "user",
      content: "after",
      timestamp: 5,
    }),
    identifiedMessage("after-assistant", {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      stopReason: "stop",
      timestamp: 6,
    }),
    identifiedMessage("tail-user", {
      role: "user",
      content: "tail",
      timestamp: 7,
    }),
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
    identifiedMessage("old-user", {
      role: "user",
      content: "old",
      timestamp: 1,
    }),
    identifiedMessage("tool-request", {
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
    }),
    identifiedMessage("missing-result", {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: "missing",
      isError: true,
      timestamp: 3,
    }),
    identifiedMessage("tail-user", {
      role: "user",
      content: "tail",
      timestamp: 4,
    }),
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
    identifiedMessage("estimator-system", {
      role: "system",
      content: "你好ab",
      timestamp: 1,
    }),
    identifiedMessage("estimator-user", {
      role: "user",
      content: "abcdefgh",
      timestamp: 2,
    }),
  ];
  assert.equal(estimator.estimate(messages), 13);
});

test("heuristic estimator serializes tool data with sorted keys", () => {
  const estimator = createHeuristicTokenEstimator();
  const createMessages = (argumentsValue: unknown): AgentMessage[] => [
    identifiedMessage("estimator-tool-request", {
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
    }),
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
    identifiedMessage("invalid-tool-request", {
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
    }),
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
