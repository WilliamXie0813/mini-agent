# CLAUDE.md

Teaching-oriented implementation of a tool-using agent. TypeScript pnpm monorepo; `core`/`server`/`plugins` run TS directly via `node --experimental-strip-types` (no build step).

## Project map

- `packages/core/` — agent loop, `StreamFn` contract, tools, retry policy, context preparation. `src/tool-execution/` holds the phased tool-execution modules. Zero runtime dependencies.
- `packages/plugins/` — real LLM adapters (ai-sdk/deepseek, zod); `jev-demo.ts` needs `.env`
- `packages/server/` — WebSocket server (:3001); serves `packages/web/dist` in production
- `packages/web/` — React 18 + antd + tailwind UI, Vite dev server (:5173)
- `docs/` — dated design docs and code walkthroughs

<important if="you need to run commands to build, test, type-check, or demo">

Run from repo root unless noted.

| Command | What it does |
|---|---|
| `pnpm install` | Install workspace dependencies |
| `pnpm dev` | Start server (:3001) and web (:5173) in parallel |
| `pnpm test` | Run all package tests |
| `pnpm check` | Type-check all packages (`tsc --noEmit`) |
| `pnpm demo` | Run the core mock-agent demo |
| `pnpm --filter @mini-agent/plugins run demo:jev` | Real-LLM demo (requires `.env`) |
| `pnpm --filter @mini-agent/web run build` | Build web for production |
</important>

<important if="you are writing or modifying code in packages/core, packages/server, or packages/plugins">
- These packages run via `node --experimental-strip-types`: only erasable TypeScript syntax is allowed (no enums, no parameter properties, no namespaces). Use `import type` for type-only imports.
</important>

<important if="you are modifying the agent loop, model streaming, or adding a real LLM adapter">
- Keep the `StreamFn` contract; adapters convert provider streaming events into `ModelStreamEvent`.
- Append final tool-result messages in the model's original tool-call order.
</important>

<important if="you are adding or modifying retry logic">
- Wrap `StreamFn` invocation in a `RetryPolicy`. Retry only model requests known to be safe. Never blindly replay a tool with side effects.
</important>

<important if="you are working on context preparation">
- Keep three separate hooks: `transformContext` (pruning/summarization), `prepareRequest` (last-moment state sync), `prepareNextTurn` (decisions based on the completed Turn).
</important>

<important if="you are working on session persistence">
- Implement `SessionStore` with `load()` and atomic `append()`. Keep persistence outside the model adapter and tool implementations.
</important>

<important if="you are writing or modifying tests">
- core/server/plugins: Node's built-in runner, files in `test/*.test.ts`
- web: Vitest + Testing Library
</important>
