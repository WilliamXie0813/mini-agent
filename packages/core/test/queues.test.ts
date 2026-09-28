import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.ts";
import { createMockStream } from "../src/mock-llm.ts";
import type { AgentMessage } from "../src/types.ts";

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

test("steering queued before prompt is included in the first Turn", async () => {
  const requests: AgentMessage[][] = [];
  const agent = new Agent({
    systemPrompt: "test",
    stream: async function* (messages) {
      requests.push(messages.slice());
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "done" }],
        stopReason: "stop" as const,
        timestamp: 1,
      };
      yield { type: "start", message };
      yield { type: "end", message };
    },
    tools: [],
  });
  agent.steer("queued steering");
  await agent.prompt("initial");
  assert.deepEqual(
    requests[0]
      ?.filter((message) => message.role === "user")
      .map((message) => message.content),
    ["initial", "queued steering"],
  );
});

test("steering during prepareNextTurn does not consume queued follow-up", async () => {
  let inserted = false;
  let agent: Agent;
  agent = new Agent({
    systemPrompt: "test",
    stream: createMockStream(),
    tools: [],
    prepareNextTurn: async () => {
      if (!inserted) {
        inserted = true;
        agent.steer("steering");
      }
      return undefined;
    },
  });
  agent.followUp("follow-up");
  await agent.prompt("initial");
  assert.deepEqual(
    agent.state.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    ["initial", "steering", "follow-up"],
  );
});
