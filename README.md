# Minimal Mock Agent

This project is a zero-runtime-dependency teaching implementation of a tool-using Agent.

## Run

```bash
npm run demo
npm test
npm run check
```

## Read in this order

1. `src/types.ts`
2. `src/mock-llm.ts`
3. `src/tools.ts`
4. `src/agent-loop.ts`
5. `src/agent.ts`
6. `src/demo.ts`

## Core flow

```text
prompt
→ user message
→ mock model tool call
→ argument validation
→ tool execution
→ tool result
→ next model Turn
→ final answer
```

## Upgrade path

### Real AI API

Keep the `StreamFn` contract. Add an adapter that converts provider streaming events into `ModelStreamEvent`.

### Parallel tools

Move tool execution behind a `ToolExecutionStrategy`. Add sequential and parallel implementations. Always append final tool-result messages in the model's original tool-call order.

### Retry

Wrap `StreamFn` invocation in a `RetryPolicy`. Retry only model requests known to be safe. Never blindly replay a tool with side effects.

### Context preparation

Add three separate hooks:

- `transformContext` for pruning or summarization;
- `prepareRequest` for last-moment state synchronization;
- `prepareNextTurn` for decisions based on the completed Turn.

### Persistence

Add a `SessionStore` interface with `load()` and atomic `append()` operations. Keep persistence outside the model adapter and tool implementations.
