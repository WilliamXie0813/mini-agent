# Minimal Mock Agent Design

## Purpose

Build a zero-runtime-dependency TypeScript teaching project that implements the core behavior studied in `pi-agent-core` without importing Pi packages or calling a real AI API.

The first version must make the complete Agent flow observable and understandable:

```text
user message
→ mock model response
→ tool call
→ validated tool execution
→ tool result
→ next model turn
→ final answer
```

The implementation will live in `/Users/liqxie/Desktop/project/docs/mini-agent/` and remain outside the repository workspaces so it can be read and run as an isolated example.

## Scope

### Core version

The core version includes:

- Agent state and structured messages
- `prompt()` and `continue()`
- Turn-based Agent loop
- Deterministic streaming Mock LLM
- Tool lookup, argument validation, execution, and result messages
- Lifecycle and streaming events
- `steer` and `followUp` queues
- `abort()` and `waitForIdle()`
- `beforeToolCall`, `afterToolCall`, and `finishTurn` hooks
- Explicit error and aborted outcomes
- Node built-in tests

The core version excludes:

- Real model APIs
- Third-party runtime or validation libraries
- Parallel tool execution
- Automatic retry
- Persistent sessions
- Context compaction
- Dynamic model switching

### Extended version

The design must allow later addition of:

- Real model adapters
- Parallel and sequential tool strategies
- Retry policies
- Context transformation and request preparation hooks
- JSONL or SQLite session persistence

## Module Structure

```text
/Users/liqxie/Desktop/project/docs/mini-agent/
├── src/
│   ├── types.ts
│   ├── mock-llm.ts
│   ├── tools.ts
│   ├── agent-loop.ts
│   ├── agent.ts
│   └── demo.ts
├── test/
│   └── agent.test.ts
├── package.json
└── tsconfig.json
```

Dependencies flow in one direction:

```text
demo → agent → agent-loop → mock-llm/tools → types
```

### `types.ts`

Defines the public contracts:

- `SystemMessage`
- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`
- `ToolCall`
- `AgentMessage`
- `Tool`
- `ToolExecutionResult`
- `AgentEvent`
- `AgentState`
- `StreamFn`
- Hook input and result types

Messages use discriminated unions. The implementation avoids `any`; unknown tool arguments remain `unknown` until explicitly validated.

### `mock-llm.ts`

Implements a deterministic state machine behind the same streaming boundary a real model adapter would use.

The Mock LLM:

- receives message history and an `AbortSignal`;
- returns an async stream of assistant events;
- emits a `read` tool call when the user asks for `package.json` and no matching tool result exists;
- emits a final text response after seeing the `read` result;
- handles later user messages, including steering and follow-up messages;
- never executes tools or mutates Agent state.

### `tools.ts`

Defines a generic tool interface and a virtual-file `read` tool.

The tool reads from an in-memory map such as:

```ts
{
  "package.json": "{\"name\":\"mock-agent-demo\"}"
}
```

Argument validation is handwritten and returns an explicit validation result. Invalid arguments never reach the tool executor.

### `agent-loop.ts`

Owns orchestration:

- starts and ends Agent runs and Turns;
- inserts pending messages;
- invokes the streaming model;
- executes requested tools;
- creates tool-result messages;
- applies hooks;
- drains steering and follow-up queues at their defined boundaries;
- evaluates `finishTurn`;
- emits all lifecycle events.

The inner loop processes tool calls and steering messages. The outer loop processes follow-up messages after the task would otherwise stop.

### `agent.ts`

Provides the stateful public API:

```ts
prompt()
continue()
steer()
followUp()
abort()
waitForIdle()
subscribe()
reset()
```

It creates context snapshots and loop configuration, owns queues and the active `AbortController`, reduces loop events into `AgentState`, and notifies subscribers after state updates.

### `demo.ts`

Runs the virtual-file scenario and prints:

- event names;
- streamed text;
- tool start and completion;
- final message history.

The default prompt is:

```text
读取 package.json，并告诉我项目名称。
```

The expected final answer identifies `mock-agent-demo`.

## Data Flow

1. `Agent.prompt()` converts text to a `UserMessage`.
2. `Agent` creates an active run, context snapshot, loop configuration, and abort signal.
3. `agent-loop` emits `agent_start`, `turn_start`, and user message events.
4. The Mock LLM inspects history and streams an Assistant message containing a `read` tool call.
5. The loop locates the tool and validates `{ path: "package.json" }`.
6. `beforeToolCall` may block the call.
7. The tool reads the virtual file and returns content.
8. `afterToolCall` may replace the result.
9. The loop emits tool events and appends a `ToolResultMessage`.
10. The next Turn sends the updated history to the Mock LLM.
11. The Mock LLM streams the final text answer.
12. The loop applies `finishTurn`, drains steering, then checks follow-up messages.
13. With no remaining work, the loop emits `agent_end`.
14. `Agent` clears the active run and resolves `waitForIdle()`.

`continue()` starts a new loop from the current transcript without appending a new user message. It does not restore a suspended JavaScript stack.

## Event and State Semantics

The event set includes:

- `agent_start`
- `turn_start`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `turn_end`
- `agent_end`

`Agent.processEvent()` updates internal state before notifying subscribers:

- `message_start/update` updates `streamingMessage`;
- `message_end` clears `streamingMessage` and appends the final message;
- tool start/end updates `pendingToolCalls`;
- failed Turns update `errorMessage`;
- `agent_end` clears transient streaming state.

## Queue Semantics

`steer()` queues a user message for the next safe Turn boundary after the current assistant response and its tools finish.

`followUp()` queues a user message that is consumed only when the current task would naturally stop.

Both queues default to one-at-a-time delivery. Queue storage and delivery policy remain separate so an extended version can add an `"all"` mode without changing the loop structure.

## Error and Cancellation Semantics

- Unknown tools produce error tool results.
- Invalid arguments produce error tool results.
- Tool exceptions produce error tool results.
- Tool errors remain visible to the next model Turn.
- Model failures produce an Assistant message with `stopReason: "error"`.
- Cancellation produces an Assistant message with `stopReason: "aborted"`.
- The same `AbortSignal` is passed to the Mock LLM and tools.
- A second `prompt()` or `continue()` during an active run throws a state error.
- `continue()` normally requires a `user` or `toolResult` transcript tail.
- An Assistant tail may continue only by consuming queued steering or follow-up messages.
- The core version does not retry automatically.

## Hooks

`beforeToolCall` receives the tool call and validated arguments. It may block execution and provide a reason.

`afterToolCall` receives the result and may replace content, details, or error status.

`finishTurn` may return:

- `undefined` for normal scheduling;
- `{ action: "end" }` to stop after the current Turn;
- `{ action: "continue" }` to request one additional context-only Turn.

The implementation must prevent an accidental unconditional continuation in tests by demonstrating a guarded one-time continuation.

## Testing

Tests use `node:test` and `node:assert/strict`.

Required cases:

1. Basic user → tool call → tool result → final answer flow.
2. Exact lifecycle event ordering for the basic flow.
3. State is updated before subscribers run.
4. Steering is inserted at the next Turn boundary.
5. Follow-up is inserted only after natural completion.
6. `continue()` resumes from a user or tool-result tail without duplicating input.
7. `abort()` stops model streaming.
8. `abort()` stops a cooperative long-running tool.
9. `beforeToolCall` can block execution.
10. `afterToolCall` can replace a result.
11. `finishTurn` supports guarded end and continue decisions.
12. Unknown tools, invalid arguments, and tool exceptions produce explicit error results.

## Upgrade Path

### Real model adapter

Keep the `StreamFn` boundary and replace `MockLlm` with adapters that translate provider events into the same assistant stream.

### Parallel tools

Extract tool execution into a strategy:

```text
ToolExecutionStrategy
├── SequentialToolExecution
└── ParallelToolExecution
```

Persist tool results in assistant source order even when parallel completion order differs.

### Retry

Wrap model invocation with a `RetryPolicy` that decides whether and when to retry. Retries must not duplicate committed messages or tool effects.

### Context pipeline

Add independent hooks:

- `transformContext` for pruning or summarization;
- `prepareRequest` for final request synchronization;
- `prepareNextTurn` for changes derived from the previous Turn.

### Persistence

Introduce a `SessionStore` interface. The Agent loop continues to operate on messages, while JSONL or SQLite implementations load and atomically append durable records.

## Success Criteria

The design is successful when a learner can:

- trace one request through every Agent layer;
- explain why the model does not execute tools directly;
- distinguish Agent state from loop-local context;
- observe Turn boundaries and queue timing;
- see how cancellation and errors propagate;
- replace the Mock LLM or add persistence without rewriting the public Agent API.
