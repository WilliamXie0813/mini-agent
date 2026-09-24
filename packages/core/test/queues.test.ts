import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.ts";
import { createMockStream } from "../src/mock-llm.ts";

test("queuedMessages exposes queued steering and followUp messages", () => {
  const agent = new Agent({
    systemPrompt: "test",
    stream: createMockStream(),
    tools: [],
  });

  agent.steer("hello");
  agent.followUp("later");

  assert.deepEqual(
    agent.queuedMessages.steering.map((message) => message.content),
    ["hello"],
  );
  assert.deepEqual(
    agent.queuedMessages.followUp.map((message) => message.content),
    ["later"],
  );
});
