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
  executionMode: "parallel" | "sequential" = "parallel",
): Tool<{ id: string }> {
  return {
    name,
    description: name,
    executionMode,
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function options(overrides: {
  tools?: Tool<unknown>[];
  events?: AgentEvent[];
  idGenerator?: () => string;
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
    idGenerator: overrides.idGenerator ?? (() => "tool-result-default"),
    signal: overrides.signal ?? new AbortController().signal,
    emit: async (event: AgentEvent) => {
      events.push(event);
    },
  };
}

test("tool results use the injected id generator", async () => {
  const batch = await executeToolCallBatch(
    [toolCall("a")],
    options({
      tools: [createTool("a", async () => ({ content: "ok" }))],
      idGenerator: () => "tool-result-fixed",
    }),
  );
  assert.equal(batch.messages[0]?.id, "tool-result-fixed");
});

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

test("parallel mode starts safe tools before either completes", async () => {
  const first = deferred<ToolExecutionResult>();
  const second = deferred<ToolExecutionResult>();
  const bothStarted = deferred<void>();
  const started: string[] = [];
  const events: AgentEvent[] = [];
  const running = executeToolCallBatch(
    [toolCall("a"), toolCall("b")],
    {
      ...options({
        tools: [
          createTool("a", async () => {
            started.push("a");
            if (started.length === 2) bothStarted.resolve();
            return first.promise;
          }),
          createTool("b", async () => {
            started.push("b");
            if (started.length === 2) bothStarted.resolve();
            return second.promise;
          }),
        ],
        events,
      }),
      toolExecutionMode: "parallel",
      maxConcurrency: 2,
    },
  );

  await bothStarted.promise;
  assert.deepEqual(started, ["a", "b"]);
  second.resolve({ content: "B" });
  await flushMicrotasks();
  first.resolve({ content: "A" });
  const batch = await running;

  assert.deepEqual(
    events
      .filter((event) => event.type === "tool_execution_end")
      .map((event) => event.toolCallId),
    ["b", "a"],
  );
  assert.deepEqual(
    batch.messages.map((message) => message.toolCallId),
    ["a", "b"],
  );
});

test("parallel mode enforces maxConcurrency", async () => {
  const gates = [
    deferred<ToolExecutionResult>(),
    deferred<ToolExecutionResult>(),
    deferred<ToolExecutionResult>(),
  ];
  let active = 0;
  let peak = 0;
  const twoStarted = deferred<void>();
  const thirdStarted = deferred<void>();
  const tools = gates.map((gate, index) =>
    createTool(String(index), async () => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) twoStarted.resolve();
      if (index === 2) thirdStarted.resolve();
      const result = await gate.promise;
      active -= 1;
      return result;
    }),
  );
  const running = executeToolCallBatch(
    [toolCall("0"), toolCall("1"), toolCall("2")],
    {
      ...options({ tools }),
      toolExecutionMode: "parallel",
      maxConcurrency: 2,
    },
  );

  await twoStarted.promise;
  assert.equal(active, 2);
  gates[0]?.resolve({ content: "0" });
  await thirdStarted.promise;
  assert.equal(active, 2);
  gates[1]?.resolve({ content: "1" });
  gates[2]?.resolve({ content: "2" });
  await running;
  assert.equal(peak, 2);
});

test("unsafe ready tools downgrade the whole batch", async () => {
  for (const mode of [undefined, "sequential"] as const) {
    const first = deferred<ToolExecutionResult>();
    let secondStarted = false;
    const secondTool: Tool<{ id: string }> = {
      ...createTool("b", async () => {
        secondStarted = true;
        return { content: "b" };
      }),
      executionMode: mode,
    };
    const running = executeToolCallBatch(
      [toolCall("a"), toolCall("b")],
      {
        ...options({
          tools: [createTool("a", () => first.promise), secondTool],
        }),
        toolExecutionMode: "parallel",
      },
    );

    await flushMicrotasks();
    assert.equal(secondStarted, false);
    first.resolve({ content: "a" });
    await running;
    assert.equal(secondStarted, true);
  }
});

test("immediate calls do not force a safe batch to downgrade", async () => {
  const first = deferred<ToolExecutionResult>();
  const second = deferred<ToolExecutionResult>();
  const bothStarted = deferred<void>();
  const started: string[] = [];
  const running = executeToolCallBatch(
    [
      toolCall("missing", "missing"),
      toolCall("a"),
      toolCall("b"),
    ],
    {
      ...options({
        tools: [
          createTool("a", async () => {
            started.push("a");
            if (started.length === 2) bothStarted.resolve();
            return first.promise;
          }),
          createTool("b", async () => {
            started.push("b");
            if (started.length === 2) bothStarted.resolve();
            return second.promise;
          }),
        ],
      }),
      toolExecutionMode: "parallel",
      maxConcurrency: 2,
    },
  );

  await bothStarted.promise;
  assert.deepEqual(started, ["a", "b"]);
  first.resolve({ content: "a" });
  second.resolve({ content: "b" });
  const batch = await running;
  assert.deepEqual(
    batch.messages.map((message) => message.toolCallId),
    ["missing", "a", "b"],
  );
});

test("parallel mode with maxConcurrency one does not overlap ready calls", async () => {
  const first = deferred<ToolExecutionResult>();
  const firstStarted = deferred<void>();
  let active = 0;
  let peak = 0;
  const running = executeToolCallBatch(
    [toolCall("a"), toolCall("b")],
    {
      ...options({
        tools: [
          createTool("a", async () => {
            active += 1;
            peak = Math.max(peak, active);
            firstStarted.resolve();
            const result = await first.promise;
            active -= 1;
            return result;
          }),
          createTool("b", async () => {
            active += 1;
            peak = Math.max(peak, active);
            active -= 1;
            return { content: "b" };
          }),
        ],
      }),
      toolExecutionMode: "parallel",
      maxConcurrency: 1,
    },
  );

  await firstStarted.promise;
  assert.equal(active, 1);
  first.resolve({ content: "a" });
  await running;
  assert.equal(peak, 1);
});

test("EventSink and afterToolCall remain serial", async () => {
  let activeEvents = 0;
  let peakEvents = 0;
  let activeHooks = 0;
  let peakHooks = 0;

  await executeToolCallBatch(
    [toolCall("a"), toolCall("b")],
    {
      ...options({
        tools: [
          createTool("a", async () => ({ content: "a" })),
          createTool("b", async () => ({ content: "b" })),
        ],
        afterToolCall: async (_call, result) => {
          activeHooks += 1;
          peakHooks = Math.max(peakHooks, activeHooks);
          await Promise.resolve();
          activeHooks -= 1;
          return result;
        },
      }),
      toolExecutionMode: "parallel",
      emit: async () => {
        activeEvents += 1;
        peakEvents = Math.max(peakEvents, activeEvents);
        await Promise.resolve();
        activeEvents -= 1;
      },
    },
  );

  assert.equal(peakEvents, 1);
  assert.equal(peakHooks, 1);
});

test("a ready slot stays occupied through finalization", async () => {
  const releaseHook = deferred<void>();
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const started: string[] = [];
  const running = executeToolCallBatch(
    [toolCall("a"), toolCall("b")],
    {
      ...options({
        tools: ["a", "b"].map((name) =>
          createTool(name, async () => {
            started.push(name);
            if (name === "a") firstStarted.resolve();
            if (name === "b") secondStarted.resolve();
            return { content: name };
          }),
        ),
        afterToolCall: async (call, result) => {
          if (call.id === "a") await releaseHook.promise;
          return result;
        },
      }),
      toolExecutionMode: "parallel",
      maxConcurrency: 1,
    },
  );

  await firstStarted.promise;
  assert.deepEqual(started, ["a"]);
  releaseHook.resolve();
  await secondStarted.promise;
  assert.deepEqual(started, ["a", "b"]);
  await running;
});

test("abort stops queued tools and emits cancelled for started tools", async () => {
  const controller = new AbortController();
  const first = deferred<ToolExecutionResult>();
  const second = deferred<ToolExecutionResult>();
  const bothStarted = deferred<void>();
  let thirdStarted = false;
  const events: AgentEvent[] = [];
  const running = executeToolCallBatch(
    [toolCall("a"), toolCall("b"), toolCall("c")],
    {
      ...options({
        tools: [
          createTool("a", async () => {
            if (
              events.filter(
                (event) => event.type === "tool_execution_start",
              ).length === 2
            ) {
              bothStarted.resolve();
            }
            return first.promise;
          }),
          createTool("b", async () => {
            if (
              events.filter(
                (event) => event.type === "tool_execution_start",
              ).length === 2
            ) {
              bothStarted.resolve();
            }
            return second.promise;
          }),
          createTool("c", async () => {
            thirdStarted = true;
            return { content: "c" };
          }),
        ],
        events,
        signal: controller.signal,
      }),
      toolExecutionMode: "parallel",
      maxConcurrency: 2,
    },
  );

  await bothStarted.promise;
  controller.abort();
  first.resolve({ content: "ignored" });
  second.resolve({ content: "ignored" });
  await assert.rejects(running, (error) => error === controller.signal.reason);

  assert.equal(thirdStarted, false);
  assert.deepEqual(
    events
      .filter((event) => event.type === "tool_execution_cancelled")
      .map((event) => event.toolCallId),
    ["a", "b"],
  );
});

test("a swallowed update dispatch failure still fails the batch", async () => {
  const sinkFailure = new Error("listener failed");
  let eventCalls = 0;
  const swallowingTool: Tool<{ id: string }> = {
    ...createTool("a", async () => ({ content: "unused" })),
    async execute(_toolCallId, _parameters, _signal, onUpdate) {
      try {
        await onUpdate({ content: "progress" });
      } catch {
        // Simulate a tool that incorrectly swallows callback failures.
      }
      return { content: "should not become a result" };
    },
  };

  await assert.rejects(
    executeToolCallBatch([toolCall("a")], {
      ...options({ tools: [swallowingTool] }),
      emit: async (event) => {
        eventCalls += 1;
        if (event.type === "tool_execution_update") throw sinkFailure;
      },
    }),
    (error) =>
      error instanceof Error &&
      error.message === "Tool event dispatch failed" &&
      "cause" in error &&
      error.cause === sinkFailure,
  );
  assert.equal(eventCalls, 2);
});

test("afterToolCall failure cancels other started calls", async () => {
  const second = deferred<ToolExecutionResult>();
  const events: AgentEvent[] = [];
  const failure = new Error("after failed");
  const running = executeToolCallBatch(
    [toolCall("a"), toolCall("b")],
    {
      ...options({
        tools: [
          createTool("a", async () => ({ content: "a" })),
          createTool("b", () => second.promise),
        ],
        events,
        afterToolCall: async (call, result) => {
          if (call.id === "a") throw failure;
          return result;
        },
      }),
      toolExecutionMode: "parallel",
      maxConcurrency: 2,
    },
  );

  await flushMicrotasks();
  second.resolve({ content: "b" });
  await assert.rejects(running, (error) => error === failure);
  assert.equal(
    events.some(
      (event) =>
        event.type === "tool_execution_cancelled" &&
        event.reason === "control_error",
    ),
    true,
  );
});
