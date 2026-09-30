# Stable Message Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every `AgentMessage` a required stable ID and make every production message constructor accept deterministic ID generation without changing Agent runtime behavior.

**Architecture:** Add the public `IdGenerator` contract to `types.ts` and keep the default UUID implementation in a focused runtime module. Message IDs are assigned by the component that creates the message: Agent for System/User/failure messages, model adapters for Assistant messages, tool execution for ToolResult messages, and the context transform for transient compaction summaries. Tests use deterministic generators and identified fixture helpers so later Session persistence work can reference messages reliably.

**Tech Stack:** TypeScript 5.9, Node.js 22 built-in test runner, `node --experimental-strip-types`, pnpm workspace, Vitest for the React package.

---

## Scope

This plan implements only small requirement 1 from `docs/superpowers/specs/2026-09-30-session-persistence-incremental-design-zh.md`.

Included:

- Required `id: string` on all four message interfaces.
- Public `IdGenerator` type.
- Default UUID generation with zero new dependencies.
- Injection through `AgentOptions`, `createMockStream()`, and `ToolExecutionBatchOptions`.
- Stable IDs across Assistant start/update/end events.
- Deterministic ID for transient context-compaction messages.
- Deterministic test fixtures across Core and Web.
- Verification that `Tool.replay?: "safe" | "never"` remains available; it already exists and needs no implementation change.

Excluded:

- Session records, stores, committers, JSONL, recovery, queue persistence, and Server Session management.
- Message ID validation or persistence semantics.
- Changes to tool-call IDs; `ToolCall.id` remains a separate provider-supplied identity.

## File Structure

### New files

- `packages/core/src/id.ts` — default runtime `IdGenerator` implementation using `crypto.randomUUID()`.
- `packages/core/test/helpers/messages.ts` — Core test fixture helper that adds explicit deterministic message IDs.
- `packages/web/test/helpers/messages.ts` — Web test fixture helper for serialized Core messages.
- `packages/core/test/message-ids.test.ts` — focused behavior tests for default and injected message identity.

### Production files to modify

- `packages/core/src/types.ts` — required message IDs, public `IdGenerator`, and `AgentLoopConfig.idGenerator`.
- `packages/core/src/agent.ts` — Agent-owned ID generator for System/User/failure/ToolResult creation paths.
- `packages/core/src/mock-llm.ts` — one Assistant ID per streamed response.
- `packages/core/src/tool-execution/batch.ts` — one generated ID per ToolResult message.
- `packages/core/src/agent-loop.ts` — pass the configured generator into tool execution.
- `packages/core/src/context.ts` — deterministic derived ID for transient compaction summaries.

### Test fixtures to migrate

- `packages/core/test/agent-loop.test.ts`
- `packages/core/test/agent.test.ts`
- `packages/core/test/context.test.ts`
- `packages/core/test/mock-llm.test.ts`
- `packages/core/test/retry.test.ts`
- `packages/core/test/queues.test.ts`
- `packages/web/test/chat-panel.test.tsx`
- `packages/web/test/client.test.ts`
- `packages/web/test/inspector.test.tsx`
- `packages/web/test/reducer.test.ts`

No Server or Plugins test currently constructs an `AgentMessage` literal.

## Task 1: Establish the Required Message ID Contract

**Files:**

- Create: `packages/core/src/id.ts`
- Create: `packages/core/test/helpers/messages.ts`
- Create: `packages/web/test/helpers/messages.ts`
- Create: `packages/core/test/message-ids.test.ts`
- Modify: `packages/core/src/types.ts:18-66`
- Modify: `packages/core/src/context.ts:198-258`
- Modify: the ten test fixture files listed above

- [ ] **Step 1: Add a failing end-to-end test for non-empty unique message IDs**

Create `packages/core/test/message-ids.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.ts";
import { createMockStream } from "../src/mock-llm.ts";
import { createReadTool } from "../src/tools.ts";

test("a completed tool flow gives every message a unique non-empty id", async () => {
  const agent = new Agent({
    systemPrompt: "test",
    stream: createMockStream(),
    tools: [
      createReadTool({
        "package.json": "{\"name\":\"mini-agent\",\"version\":\"1.0.0\"}",
      }),
    ],
  });

  await agent.prompt("读取 package.json，并告诉我项目名称。");

  const ids = agent.state.messages.map((message) => message.id);
  assert.equal(ids.length, 5);
  assert.equal(ids.every((id) => typeof id === "string" && id.length > 0), true);
  assert.equal(new Set(ids).size, ids.length);
});
```

- [ ] **Step 2: Run the focused test and confirm the missing contract**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/message-ids.test.ts
```

Expected: FAIL at type-check/runtime access because current messages do not define `id`.

- [ ] **Step 3: Add the public type and default generator**

In `packages/core/src/types.ts`, add the generator contract after imports:

```ts
export type IdGenerator = () => string;
```

Add `id: string` as the first property of every message interface:

```ts
export interface SystemMessage {
  id: string;
  role: "system";
  content: string;
  timestamp: number;
}

export interface UserMessage {
  id: string;
  role: "user";
  content: string;
  timestamp: number;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  content: Array<TextContent | ToolCall>;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  id: string;
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string;
  details?: unknown;
  isError: boolean;
  timestamp: number;
}
```

Create `packages/core/src/id.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { IdGenerator } from "./types.ts";

export const defaultIdGenerator: IdGenerator = () => randomUUID();
```

Do not add a dependency or export `defaultIdGenerator` from the package root. It is an internal runtime default; only the `IdGenerator` type is public through the existing `export * from "./types.ts"`.

- [ ] **Step 4: Give the transient context summary a deterministic derived ID**

In `packages/core/src/context.ts`, add this guard immediately after the `createCompactionMessage()` opening brace:

```ts
const firstMessage = segmentMessages[0];
const lastMessage = segmentMessages.at(-1);
if (!firstMessage || !lastMessage) {
  throw new Error("Cannot compact an empty message segment");
}
```

Add this property as the first field of the returned System message:

```ts
id: `context-summary:${firstMessage.id}:${lastMessage.id}`,
```

Replace:

```ts
timestamp: segmentMessages.at(-1)?.timestamp ?? 0,
```

with:

```ts
timestamp: lastMessage.timestamp,
```

- [ ] **Step 5: Create deterministic identified-message helpers for Core tests**

Create `packages/core/test/helpers/messages.ts`:

```ts
import type {
  AgentMessage,
  AssistantMessage,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from "../../src/types.ts";

type MessageWithoutId =
  | Omit<SystemMessage, "id">
  | Omit<UserMessage, "id">
  | Omit<AssistantMessage, "id">
  | Omit<ToolResultMessage, "id">;

export function identifiedMessage<T extends MessageWithoutId>(
  id: string,
  message: T,
): T & Pick<AgentMessage, "id"> {
  return { id, ...message };
}

export function createTestIdGenerator(
  prefix = "id",
): () => string {
  let next = 1;
  return () => `${prefix}-${next++}`;
}
```

Create `packages/web/test/helpers/messages.ts`:

```ts
import type {
  AgentMessage,
  AssistantMessage,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from "@mini-agent/core";

type MessageWithoutId =
  | Omit<SystemMessage, "id">
  | Omit<UserMessage, "id">
  | Omit<AssistantMessage, "id">
  | Omit<ToolResultMessage, "id">;

export function identifiedMessage<T extends MessageWithoutId>(
  id: string,
  message: T,
): T & Pick<AgentMessage, "id"> {
  return { id, ...message };
}
```

- [ ] **Step 6: Migrate Core test message literals**

In each Core test file that constructs a message literal, import:

```ts
import { identifiedMessage } from "./helpers/messages.ts";
```

Replace every bare message literal with an explicit deterministic ID. Use semantic names instead of counters so failures remain readable:

```ts
identifiedMessage("user-package-request", {
  role: "user",
  content: "读取 package.json，并告诉我项目名称。",
  timestamp: 1,
})
```

```ts
identifiedMessage("assistant-tool-request", {
  role: "assistant",
  content: [toolCall],
  stopReason: "toolUse",
  timestamp: 2,
})
```

```ts
identifiedMessage("tool-result-package", {
  role: "toolResult",
  toolCallId: "call-read-package",
  toolName: "read",
  content: "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
  isError: false,
  timestamp: 3,
})
```

Apply this pattern to every `role: "system"`, `role: "user"`, `role: "assistant"`, and `role: "toolResult"` literal in:

```text
packages/core/test/agent-loop.test.ts
packages/core/test/agent.test.ts
packages/core/test/context.test.ts
packages/core/test/mock-llm.test.ts
packages/core/test/retry.test.ts
packages/core/test/queues.test.ts
```

For stream fixtures where one Assistant object is emitted as both start and end, construct it once with `identifiedMessage()` and reuse the same object or spreads of that object. Never generate a second ID for updates of the same Assistant response.

- [ ] **Step 7: Migrate Web test message literals**

In each Web test file that constructs Core messages, import:

```ts
import { identifiedMessage } from "./helpers/messages";
```

Wrap every serialized message literal with a semantic deterministic ID:

```ts
identifiedMessage("chat-user-1", {
  role: "user",
  content: "读取 package.json",
  timestamp: 1,
})
```

Apply the pattern to:

```text
packages/web/test/chat-panel.test.tsx
packages/web/test/client.test.ts
packages/web/test/inspector.test.tsx
packages/web/test/reducer.test.ts
```

IDs are data-only in the Web package. Do not render them or use them as React keys in this requirement.

- [ ] **Step 8: Add temporary default IDs to every production constructor**

Use `defaultIdGenerator()` directly at all current construction points so the repository compiles before injection is added in later tasks:

```ts
import { defaultIdGenerator } from "./id.ts";
```

Add `id: defaultIdGenerator()` to:

- Initial System, User, and failure Assistant messages in `packages/core/src/agent.ts`.
- Assistant messages created by `streamText()` and the tool-call branch in `packages/core/src/mock-llm.ts`.
- ToolResult messages returned by `toMessage()` in `packages/core/src/tool-execution/batch.ts`.

These calls are the permanent defaults, not a temporary fallback. Later tasks replace direct access with injected generators where required.

- [ ] **Step 9: Run Core and Web validation**

Run:

```bash
pnpm --filter @mini-agent/core test
pnpm --filter @mini-agent/core check
pnpm --filter @mini-agent/web test
pnpm --filter @mini-agent/web check
```

Expected: all commands PASS. The new end-to-end test observes five unique non-empty IDs.

## Task 2: Inject IDs for Agent-Owned Messages

**Files:**

- Modify: `packages/core/src/agent.ts:25-47,70-180,280-390`
- Modify: `packages/core/src/types.ts:326-344`
- Modify: `packages/core/test/message-ids.test.ts`
- Modify: `packages/core/test/agent.test.ts`

- [ ] **Step 1: Write failing tests for deterministic Agent IDs**

Append to `packages/core/test/message-ids.test.ts`:

```ts
import type { AssistantMessage, StreamFn } from "../src/types.ts";
import { createTestIdGenerator } from "./helpers/messages.ts";

test("Agent uses its injected generator for System and User messages", async () => {
  const assistant: AssistantMessage = {
    id: "model-answer",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    timestamp: 3,
  };
  const stream: StreamFn = async function* () {
    yield { type: "start", message: assistant };
    yield { type: "end", message: assistant };
  };
  const agent = new Agent({
    systemPrompt: "test",
    stream,
    tools: [],
    idGenerator: createTestIdGenerator("agent"),
  });

  await agent.prompt("hello");

  assert.deepEqual(
    agent.state.messages.map((message) => message.id),
    ["agent-1", "agent-2", "model-answer"],
  );
});

test("Agent uses its injected generator for a failure message", async () => {
  const stream: StreamFn = async function* () {
    throw new Error("model failed");
  };
  const agent = new Agent({
    systemPrompt: "test",
    stream,
    tools: [],
    idGenerator: createTestIdGenerator("failure"),
  });

  await agent.prompt("hello");

  assert.deepEqual(
    agent.state.messages.map((message) => message.id),
    ["failure-1", "failure-2", "failure-3"],
  );
  assert.equal(agent.state.messages.at(-1)?.role, "assistant");
});
```

- [ ] **Step 2: Run the focused tests and verify the option is missing**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/message-ids.test.ts
```

Expected: FAIL because `AgentOptions` does not accept `idGenerator`, and generated IDs do not match the deterministic sequence.

- [ ] **Step 3: Store and use the Agent generator**

In `packages/core/src/agent.ts`:

```ts
import { defaultIdGenerator } from "./id.ts";
```

Add `IdGenerator` to the type imports and to `AgentOptions`:

```ts
export interface AgentOptions {
  systemPrompt: string;
  stream: StreamFn;
  tools: Tool<unknown>[];
  idGenerator?: IdGenerator;
}
```

Insert `idGenerator?: IdGenerator` immediately after `tools`; do not reorder or alter the existing execution, hook, retry, or sleep options.

Add the field:

```ts
private readonly idGenerator: IdGenerator;
```

Initialize it before constructing `mutableState`:

```ts
this.idGenerator = options.idGenerator ?? defaultIdGenerator;
```

Use it for all Agent-owned messages:

```ts
messages: [
  {
    id: this.idGenerator(),
    role: "system",
    content: options.systemPrompt,
    timestamp: Date.now(),
  },
],
```

```ts
private createUserMessage(content: string): UserMessage {
  return {
    id: this.idGenerator(),
    role: "user",
    content,
    timestamp: Date.now(),
  };
}
```

```ts
const message = {
  id: this.idGenerator(),
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "" }],
  stopReason: signal.aborted ? ("aborted" as const) : ("error" as const),
  errorMessage: error instanceof Error ? error.message : String(error),
  timestamp: Date.now(),
};
```

Remove direct `defaultIdGenerator()` calls from these three construction paths.

- [ ] **Step 4: Put the generator into AgentLoopConfig**

In `packages/core/src/types.ts`, add the required normalized generator:

```ts
export interface AgentLoopConfig {
  stream: StreamFn;
  idGenerator: IdGenerator;
}
```

Insert `idGenerator` immediately after `stream`; leave the existing retry, queue, execution, and hook fields in their current order.

In `Agent.createConfig()` return:

```ts
return {
  stream: this.stream,
  idGenerator: this.idGenerator,
};
```

Insert `idGenerator` immediately after `stream` in the existing returned object; retain every current configuration property.

Update direct `runAgentLoop()` test configs in `packages/core/test/agent-loop.test.ts` to include:

```ts
idGenerator: createTestIdGenerator("loop"),
```

Import `createTestIdGenerator` from `./helpers/messages.ts`. Create a fresh generator for each test so IDs do not depend on test execution order.

- [ ] **Step 5: Run focused Agent tests**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test \
  test/message-ids.test.ts \
  test/agent.test.ts \
  test/agent-loop.test.ts
pnpm --filter @mini-agent/core check
```

Expected: PASS. Existing Agent behavior is unchanged, and deterministic Agent IDs match the asserted order.

## Task 3: Keep One Assistant ID Across the Entire Model Stream

**Files:**

- Modify: `packages/core/src/mock-llm.ts:1-205`
- Modify: `packages/core/test/mock-llm.test.ts`
- Modify: `packages/core/test/message-ids.test.ts`

- [ ] **Step 1: Write failing tests for text and tool-call streams**

Append to `packages/core/test/message-ids.test.ts`:

```ts
test("mock text stream reuses one injected Assistant id", async () => {
  const idGenerator = createTestIdGenerator("model");
  const stream = createMockStream({ idGenerator });
  const events = [];

  for await (const event of stream(
    [
      identifiedMessage("user-plain", {
        role: "user",
        content: "hello",
        timestamp: 1,
      }),
    ],
    new AbortController().signal,
  )) {
    events.push(event);
  }

  assert.equal(events.length > 2, true);
  assert.deepEqual(
    [...new Set(events.map((event) => event.message.id))],
    ["model-1"],
  );
});

test("mock tool-call stream reuses one injected Assistant id", async () => {
  const stream = createMockStream({
    idGenerator: createTestIdGenerator("tool-request"),
  });
  const events = [];

  for await (const event of stream(
    [
      identifiedMessage("user-tool", {
        role: "user",
        content: "读取 package.json",
        timestamp: 1,
      }),
    ],
    new AbortController().signal,
  )) {
    events.push(event);
  }

  assert.deepEqual(
    [...new Set(events.map((event) => event.message.id))],
    ["tool-request-1"],
  );
});
```

Also import `identifiedMessage` beside `createTestIdGenerator`.

- [ ] **Step 2: Run the focused test and confirm injection is unsupported**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/message-ids.test.ts
```

Expected: FAIL because `createMockStream()` does not accept `idGenerator`.

- [ ] **Step 3: Extend the Mock stream options**

In `packages/core/src/mock-llm.ts`, import:

```ts
import { defaultIdGenerator } from "./id.ts";
import type { IdGenerator } from "./types.ts";
```

Change `streamText()` to accept a preallocated ID:

```ts
async function* streamText(
  id: string,
  text: string,
  signal: AbortSignal,
  delayMs: number,
): AsyncGenerator<ModelStreamEvent> {
  let message: AssistantMessage = {
    id,
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
```

Only replace the function signature and add the `id` field shown above. Retain the current yields and character-accumulation loop verbatim.

Change the public factory signature:

```ts
export function createMockStream(
  options: {
    delayMs?: number;
    idGenerator?: IdGenerator;
  } = {},
): StreamFn {
  const delayMs = options.delayMs ?? 0;
  const idGenerator = options.idGenerator ?? defaultIdGenerator;
```

At the start of each response branch, allocate exactly one ID and pass it through:

```ts
yield* streamText(
  idGenerator(),
  responseText,
  signal,
  delayMs,
);
```

For the tool-call branch:

```ts
const startMessage: AssistantMessage = {
  id: idGenerator(),
  role: "assistant",
  content: [],
  stopReason: "toolUse",
  timestamp: Date.now(),
};
const toolMessage: AssistantMessage = {
  ...startMessage,
  content: [toolCall],
};
```

Do not call the generator in delta iterations or when spreading `startMessage`.

- [ ] **Step 4: Make existing Mock tests deterministic**

In `packages/core/test/mock-llm.test.ts`, update `collect()`:

```ts
async function collect(
  messages: AgentMessage[],
  signal = new AbortController().signal,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  const stream = createMockStream({
    idGenerator: createTestIdGenerator("mock"),
  });
  for await (const event of stream(messages, signal)) {
    events.push(event);
  }
  return events;
}
```

Import `createTestIdGenerator` from `./helpers/messages.ts`.

- [ ] **Step 5: Run Mock and ID tests**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/message-ids.test.ts test/mock-llm.test.ts
pnpm --filter @mini-agent/core check
```

Expected: PASS. Every event belonging to one Assistant response has the same deterministic ID.

## Task 4: Inject IDs for ToolResult Messages

**Files:**

- Modify: `packages/core/src/tool-execution/batch.ts:1-57,86-150`
- Modify: `packages/core/src/agent-loop.ts:198-214`
- Modify: `packages/core/test/tool-execution.test.ts`
- Modify: `packages/core/test/message-ids.test.ts`

- [ ] **Step 1: Write a failing batch-level ToolResult ID test**

Append to `packages/core/test/tool-execution.test.ts`:

```ts
import { createTestIdGenerator } from "./helpers/messages.ts";

test("tool result messages use the injected id generator in source order", async () => {
  const batch = await executeToolCallBatch(
    [toolCall("a", "missing"), toolCall("b", "missing")],
    {
      ...options(),
      idGenerator: createTestIdGenerator("result"),
    },
  );

  assert.deepEqual(
    batch.messages.map((message) => ({
      id: message.id,
      toolCallId: message.toolCallId,
    })),
    [
      { id: "result-1", toolCallId: "a" },
      { id: "result-2", toolCallId: "b" },
    ],
  );
});
```

- [ ] **Step 2: Run the focused test and verify injection is unsupported**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/tool-execution.test.ts
```

Expected: FAIL because `ToolExecutionBatchOptions` does not accept `idGenerator`.

- [ ] **Step 3: Add the normalized ToolResult generator**

In `packages/core/src/tool-execution/batch.ts`, import:

```ts
import { defaultIdGenerator } from "../id.ts";
import type { IdGenerator } from "../types.ts";
```

Add the optional direct-call option:

```ts
export interface ToolExecutionBatchOptions {
  tools: readonly Tool<unknown>[];
  toolExecutionMode: ToolExecutionMode;
  maxConcurrency: number;
  idGenerator?: IdGenerator;
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  emit: EventSink;
  signal: AbortSignal;
}
```

Change the mapper:

```ts
function toMessage(
  completed: CompletedToolCall,
  idGenerator: IdGenerator,
): ToolResultMessage {
  return {
    id: idGenerator(),
    role: "toolResult",
    toolCallId: completed.toolCall.id,
    toolName: completed.toolCall.name,
    content: completed.result.content,
    details: completed.result.details,
    isError: completed.result.isError === true,
    timestamp: Date.now(),
  };
}
```

At the start of `executeToolCallBatch()` normalize once:

```ts
const idGenerator = options.idGenerator ?? defaultIdGenerator;
```

Return source-ordered messages with:

```ts
completed.sort((left, right) => left.index - right.index);
return {
  messages: completed.map((item) => toMessage(item, idGenerator)),
};
```

This deliberately allocates ToolResult IDs after sorting, so deterministic IDs follow model tool-call order rather than parallel completion order.

- [ ] **Step 4: Pass the Agent generator through the loop**

In `packages/core/src/agent-loop.ts`, update the batch call:

```ts
const batch = await executeToolCallBatch(toolCalls, {
  tools: context.tools,
  toolExecutionMode: config.toolExecutionMode,
  maxConcurrency: config.maxToolConcurrency,
  idGenerator: config.idGenerator,
  beforeToolCall: config.beforeToolCall,
  afterToolCall: config.afterToolCall,
  emit,
  signal,
});
```

This keeps ToolResult IDs in the same Agent-owned sequence as System, User, and failure messages.

- [ ] **Step 5: Add an Agent-level ToolResult sequence assertion**

Append to `packages/core/test/message-ids.test.ts`:

```ts
test("Agent passes its generator to ToolResult creation", async () => {
  const agent = new Agent({
    systemPrompt: "test",
    stream: createMockStream({
      idGenerator: createTestIdGenerator("assistant"),
    }),
    tools: [
      createReadTool({
        "package.json": "{\"name\":\"mini-agent\",\"version\":\"1.0.0\"}",
      }),
    ],
    idGenerator: createTestIdGenerator("agent"),
  });

  await agent.prompt("读取 package.json，并告诉我项目名称。");

  assert.deepEqual(
    agent.state.messages.map((message) => message.id),
    [
      "agent-1",
      "agent-2",
      "assistant-1",
      "agent-3",
      "assistant-2",
    ],
  );
});
```

- [ ] **Step 6: Run Tool execution and end-to-end tests**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test \
  test/tool-execution.test.ts \
  test/message-ids.test.ts \
  test/agent-loop.test.ts
pnpm --filter @mini-agent/core check
```

Expected: PASS. Parallel completion order remains unchanged, Transcript order remains model source order, and generated ToolResult IDs follow Transcript order.

## Task 5: Verify Deterministic Context IDs and Full Workspace Compatibility

**Files:**

- Modify: `packages/core/test/context.test.ts`

- [ ] **Step 1: Add a focused compaction identity assertion**

In the existing `compacting transform replaces old turns and preserves recent turns` test, after the role assertion add:

```ts
assert.equal(
  result[1]?.id,
  "context-summary:old-user:old-assistant",
);
```

Construct the source fixture array with these exact identified messages:

```ts
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
```

Then invoke the same transform a second time with the same input and assert:

```ts
const repeated = await transform(messages, new AbortController().signal);
assert.equal(repeated[1]?.id, result[1]?.id);
```

- [ ] **Step 2: Run the focused context test**

Run:

```bash
pnpm --filter @mini-agent/core exec node \
  --experimental-strip-types \
  --test test/context.test.ts
```

Expected: PASS. The synthetic message ID is deterministic and derived only from stable source IDs.

- [ ] **Step 3: Search for remaining unidentified message literals**

Run:

```bash
rg -n 'role:\s*"(system|user|assistant|toolResult)"' packages \
  --glob '*.{ts,tsx}'
```

Expected:

- Production matches are only known constructors in `agent.ts`, `mock-llm.ts`, `tool-execution/batch.ts`, and `context.ts`, each with an adjacent `id`.
- Test matches occur inside `identifiedMessage(...)` calls or objects that already include an explicit `id`.
- No bare message literal remains without an ID.

- [ ] **Step 4: Run the full workspace validation**

Run:

```bash
pnpm test
pnpm check
pnpm demo
```

Expected:

- All package tests PASS.
- All package type checks PASS.
- The deterministic Core demo completes normally and prints the same conversation behavior as before; message objects now include UUID IDs.

- [ ] **Step 5: Commit the completed small requirement**

```bash
git add \
  packages/core/src/id.ts \
  packages/core/src/types.ts \
  packages/core/src/agent.ts \
  packages/core/src/mock-llm.ts \
  packages/core/src/agent-loop.ts \
  packages/core/src/context.ts \
  packages/core/src/tool-execution/batch.ts \
  packages/core/test/helpers/messages.ts \
  packages/core/test/message-ids.test.ts \
  packages/core/test/agent-loop.test.ts \
  packages/core/test/agent.test.ts \
  packages/core/test/context.test.ts \
  packages/core/test/mock-llm.test.ts \
  packages/core/test/retry.test.ts \
  packages/core/test/queues.test.ts \
  packages/core/test/tool-execution.test.ts \
  packages/web/test/helpers/messages.ts \
  packages/web/test/chat-panel.test.tsx \
  packages/web/test/client.test.ts \
  packages/web/test/inspector.test.tsx \
  packages/web/test/reducer.test.ts
git commit -m "feat(core): add stable message identities" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: one focused implementation commit for small requirement 1, with no Session persistence code included.

## Completion Criteria

- All four `AgentMessage` variants require `id: string`.
- Default production IDs use `crypto.randomUUID()`.
- Agent-owned messages use `AgentOptions.idGenerator`.
- Mock Assistant events share one ID for the complete streamed response.
- ToolResult messages use the Agent generator and preserve model source order.
- Context summaries have deterministic derived IDs.
- Tool-call IDs remain unchanged and distinct from message IDs.
- Tests use deterministic IDs without depending on random UUID values.
- `pnpm test`, `pnpm check`, and `pnpm demo` pass.
- No Session Store, JSONL, queue persistence, or recovery code is introduced.
