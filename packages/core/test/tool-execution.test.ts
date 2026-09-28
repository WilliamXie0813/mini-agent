import assert from "node:assert/strict";
import test from "node:test";
import { executeToolCallBatch } from "../src/tool-execution.ts";
import type {
  AgentEvent,
  Tool,
  ToolCall,
  ToolExecutionResult,
} from "../src/types.ts";

function toolCall(id: string, name = id): ToolCall {
  return { type: "toolCall", id, name, arguments: { id } };
}

function createTool(
  name: string,
  execute: () => Promise<ToolExecutionResult>,
): Tool<{ id: string }> {
  return {
    name,
    description: name,
    executionMode: "parallel",
    validate(value) {
      if (
        value === null ||
        typeof value !== "object" ||
        !("id" in value) ||
        typeof value.id !== "string"
      ) {
        return { ok: false, error: "invalid id" };
      }
      return { ok: true, value: { id: value.id } };
    },
    async execute() {
      return execute();
    },
  };
}

function options(overrides: {
  tools?: Tool<unknown>[];
  events?: AgentEvent[];
  beforeToolCall?: (
    call: ToolCall,
    parameters: unknown,
    signal: AbortSignal,
  ) => Promise<{ block: true; reason: string } | undefined>;
  afterToolCall?: (
    call: ToolCall,
    result: ToolExecutionResult,
    signal: AbortSignal,
  ) => Promise<ToolExecutionResult | undefined>;
  signal?: AbortSignal;
} = {}) {
  const events = overrides.events ?? [];
  return {
    tools: overrides.tools ?? [],
    toolExecutionMode: "sequential" as const,
    maxConcurrency: 4,
    beforeToolCall: overrides.beforeToolCall,
    afterToolCall: overrides.afterToolCall,
    signal: overrides.signal ?? new AbortController().signal,
    emit: async (event: AgentEvent) => {
      events.push(event);
    },
  };
}

test("rejects empty and duplicate tool call ids before hooks run", async () => {
  let hookCalls = 0;
  const batchOptions = options({
    beforeToolCall: async () => {
      hookCalls += 1;
      return undefined;
    },
  });

  await assert.rejects(
    executeToolCallBatch([toolCall("", "read")], batchOptions),
    /Tool Call ID must be non-empty/,
  );
  await assert.rejects(
    executeToolCallBatch(
      [toolCall("same", "read"), toolCall("same", "read")],
      batchOptions,
    ),
    /Duplicate Tool Call ID: same/,
  );
  assert.equal(hookCalls, 0);
});

test("preflights every call in source order before executing", async () => {
  const order: string[] = [];
  const tools = ["a", "b"].map((name) =>
    createTool(name, async () => {
      order.push(`execute:${name}`);
      return { content: name };
    }),
  );

  await executeToolCallBatch(
    [toolCall("a"), toolCall("b")],
    options({
      tools,
      beforeToolCall: async (call) => {
        order.push(`before:${call.id}`);
        return undefined;
      },
    }),
  );

  assert.deepEqual(order, [
    "before:a",
    "before:b",
    "execute:a",
    "execute:b",
  ]);
});

test("sequential execution produces complete immediate error lifecycles", async () => {
  const events: AgentEvent[] = [];
  const batch = await executeToolCallBatch(
    [toolCall("missing", "missing")],
    options({ events }),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["tool_execution_start", "tool_execution_end"],
  );
  assert.equal(batch.messages[0]?.toolCallId, "missing");
  assert.equal(batch.messages[0]?.isError, true);
  assert.equal(batch.messages[0]?.content, "Unknown tool: missing");
});

test("afterToolCall is applied before end and message creation", async () => {
  const events: AgentEvent[] = [];
  const batch = await executeToolCallBatch(
    [toolCall("read")],
    options({
      tools: [createTool("read", async () => ({ content: "original" }))],
      events,
      afterToolCall: async () => ({
        content: "replacement",
        isError: false,
      }),
    }),
  );

  const end = events.find((event) => event.type === "tool_execution_end");
  assert.equal(end?.type, "tool_execution_end");
  if (end?.type !== "tool_execution_end") return;
  assert.equal(end.result.content, "replacement");
  assert.equal(batch.messages[0]?.content, "replacement");
});
