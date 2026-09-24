# Minimal Mock Agent

This project is a zero-runtime-dependency teaching implementation of a tool-using Agent.

## Run

```bash
pnpm install
pnpm run demo
pnpm test
pnpm run check
```

## Read in this order

1. `packages/core/src/types.ts`
2. `packages/core/src/mock-llm.ts`
3. `packages/core/src/tools.ts`
4. `packages/core/src/agent-loop.ts`
5. `packages/core/src/agent.ts`
6. `packages/core/src/demo.ts`

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

## Web UI 开发

```bash
pnpm install
pnpm dev    # 同时启动 server (:3001) 与 web (:5173)
pnpm test   # 运行全部包的测试
pnpm check  # 全部包的类型检查
```

浏览器打开 http://localhost:5173 。生产模式下 `pnpm --filter @mini-agent/web run build` 后，server (:3001) 会直接托管 `packages/web/dist`。
