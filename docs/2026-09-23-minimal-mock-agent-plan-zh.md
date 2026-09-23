# 最小化 Mock Agent 实现计划

> **致 agentic 执行者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 构建一个零运行时依赖的 TypeScript 教学 Agent，演示结构化消息、流式 Mock LLM 响应、工具执行、事件、队列、continuation、取消和钩子。

**架构：** 让有状态的公共 `Agent` 与无状态的编排循环保持分离。向循环注入一个确定性的 `StreamFn` 和一个工具注册表，使第一个版本使用 Mock 数据，同时为真实模型适配器、并行工具、重试、上下文准备和持久化保留升级边界。

**技术栈：** Node.js 22.19+，使用 Node strip-types 兼容语法的 TypeScript，ESM，`node:test`，`node:assert/strict`，零运行时依赖。

---

## 文件地图

创建以下文件：

```text
/Users/liqxie/Desktop/project/docs/mini-agent/
├── package.json
├── package-lock.json  # 由 npm install --ignore-scripts 生成
├── tsconfig.json
├── src/
│   ├── types.ts       # 共享的消息、事件、工具、钩子、流和状态契约
│   ├── tools.ts       # 通用工具辅助函数和虚拟文件 read 工具
│   ├── mock-llm.ts    # 确定性的流式模型状态机
│   ├── agent-loop.ts  # Turn 调度、模型流式输出、工具、队列和钩子
│   ├── agent.ts       # 有状态的公共 Agent API 和事件归约器
│   └── demo.ts        # 可观察的端到端示例
└── test/
    ├── tools.test.ts
    ├── mock-llm.test.ts
    ├── agent-loop.test.ts
    └── agent.test.ts
```

无需修改任何现有源文件。该学习项目保持在根工作区之外。

## 验证命令

在 `/Users/liqxie/Desktop/project/docs/mini-agent/` 下运行：

```bash
npm install --ignore-scripts
npm test
npm run check
npm run demo
```

预期的最终结果：

- `npm test`：所有 Node 测试通过。
- `npm run check`：TypeScript 以退出码 0 结束。
- `npm run demo`：打印一次 `read` 工具调用和最终项目名称 `mock-agent-demo`。

当前目录不是 Git 仓库，用户也没有要求提交。在本计划执行期间不要运行 commit 命令。

### 任务 1：搭建独立教学项目

**文件：**
- 创建：`/Users/liqxie/Desktop/project/docs/mini-agent/package.json`
- 生成：`/Users/liqxie/Desktop/project/docs/mini-agent/package-lock.json`
- 创建：`/Users/liqxie/Desktop/project/docs/mini-agent/tsconfig.json`
- 创建：`/Users/liqxie/Desktop/project/docs/mini-agent/src/types.ts`

- [ ] **步骤 1：创建 package 清单**

创建 `/Users/liqxie/Desktop/project/docs/mini-agent/package.json`：

```json
{
  "name": "minimal-mock-agent",
  "private": true,
  "type": "module",
  "scripts": {
    "demo": "node --experimental-strip-types src/demo.ts",
    "test": "node --experimental-strip-types --test test/*.test.ts",
    "check": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "22.19.19",
    "typescript": "5.9.3"
  }
}
```

- [ ] **步骤 2：创建 TypeScript 配置**

创建 `/Users/liqxie/Desktop/project/docs/mini-agent/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **步骤 3：安装开发依赖（不运行生命周期脚本）**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && npm install --ignore-scripts
```

预期：`node_modules/` 和 `package-lock.json` 被创建；不运行任何生命周期脚本。

- [ ] **步骤 4：定义完整的共享类型面**

创建 `/Users/liqxie/Desktop/project/docs/mini-agent/src/types.ts`：

```ts
export type StopReason = "stop" | "toolUse" | "error" | "aborted";

export interface SystemMessage {
  role: "system";
  content: string;
  timestamp: number;
}

export interface UserMessage {
  role: "user";
  content: string;
  timestamp: number;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

export interface AssistantMessage {
  role: "assistant";
  content: Array<TextContent | ToolCall>;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string;
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface ToolExecutionResult {
  content: string;
  details?: unknown;
  isError?: boolean;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type ToolUpdate = (partial: ToolExecutionResult) => Promise<void>;

export interface Tool<TParameters> {
  name: string;
  description: string;
  validate(argumentsValue: unknown): ValidationResult<TParameters>;
  execute(
    toolCallId: string,
    parameters: TParameters,
    signal: AbortSignal,
    onUpdate: ToolUpdate,
  ): Promise<ToolExecutionResult>;
}

export interface ModelStartEvent {
  type: "start";
  message: AssistantMessage;
}

export interface ModelTextDeltaEvent {
  type: "text_delta";
  delta: string;
  message: AssistantMessage;
}

export interface ModelToolCallEvent {
  type: "tool_call";
  toolCall: ToolCall;
  message: AssistantMessage;
}

export interface ModelEndEvent {
  type: "end";
  message: AssistantMessage;
}

export type ModelStreamEvent =
  | ModelStartEvent
  | ModelTextDeltaEvent
  | ModelToolCallEvent
  | ModelEndEvent;

export type StreamFn = (
  messages: readonly AgentMessage[],
  signal: AbortSignal,
) => AsyncIterable<ModelStreamEvent>;

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update";
      message: AssistantMessage;
      modelEvent: ModelTextDeltaEvent | ModelToolCallEvent;
    }
  | { type: "message_end"; message: AgentMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      argumentsValue: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      partial: ToolExecutionResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: ToolExecutionResult;
      isError: boolean;
    }
  | {
      type: "turn_end";
      message: AssistantMessage;
      toolResults: ToolResultMessage[];
    }
  | { type: "agent_end"; messages: AgentMessage[] };

export type EventSink = (event: AgentEvent) => Promise<void>;

export interface AgentContext {
  messages: AgentMessage[];
  tools: Tool<unknown>[];
}

export interface BeforeToolCallResult {
  block: true;
  reason: string;
}

export type BeforeToolCall = (
  toolCall: ToolCall,
  validatedArguments: unknown,
  signal: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

export type AfterToolCall = (
  toolCall: ToolCall,
  result: ToolExecutionResult,
  signal: AbortSignal,
) => Promise<ToolExecutionResult | undefined>;

export type FinishTurnDecision =
  | { action: "end" }
  | { action: "continue" }
  | undefined;

export interface CompletedTurn {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  context: AgentContext;
}

export type FinishTurn = (
  turn: CompletedTurn,
  signal: AbortSignal,
) => Promise<FinishTurnDecision>;

export interface AgentLoopConfig {
  stream: StreamFn;
  getSteeringMessages(): AgentMessage[];
  getFollowUpMessages(): AgentMessage[];
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  finishTurn?: FinishTurn;
}

export interface AgentState {
  messages: AgentMessage[];
  tools: Tool<unknown>[];
  isStreaming: boolean;
  streamingMessage?: AssistantMessage;
  pendingToolCalls: ReadonlySet<string>;
  errorMessage?: string;
}
```

- [ ] **步骤 5：运行类型检查器**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && npm run check
```

预期：退出码 0，无任何诊断信息。

### 任务 2：实现并测试虚拟文件工具

**文件：**
- 创建：`/Users/liqxie/Desktop/project/docs/mini-agent/test/tools.test.ts`
- 创建：`/Users/liqxie/Desktop/project/docs/mini-agent/src/tools.ts`

- [ ] **步骤 1：编写失败的校验与执行测试**

创建 `/Users/liqxie/Desktop/project/docs/mini-agent/test/tools.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createReadTool } from "../src/tools.ts";

test("read tool validates and reads a virtual file", async () => {
  const tool = createReadTool({
    "package.json": "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
  });

  const validation = tool.validate({ path: "package.json" });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const result = await tool.execute(
    "call-1",
    validation.value,
    new AbortController().signal,
    async () => {},
  );

  assert.equal(result.isError, false);
  assert.match(result.content, /mock-agent-demo/);
});

test("read tool rejects invalid arguments", () => {
  const tool = createReadTool({});
  assert.deepEqual(tool.validate({ path: 42 }), {
    ok: false,
    error: 'read requires an object with a string "path"',
  });
});

test("read tool returns an explicit missing-file error", async () => {
  const tool = createReadTool({});
  const validation = tool.validate({ path: "missing.txt" });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const result = await tool.execute(
    "call-1",
    validation.value,
    new AbortController().signal,
    async () => {},
  );

  assert.equal(result.isError, true);
  assert.equal(result.content, "File not found: missing.txt");
});
```

- [ ] **步骤 2：运行测试并验证因模块缺失而失败**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && node --experimental-strip-types --test test/tools.test.ts
```

预期：FAIL，因为 `../src/tools.ts` 不存在。

- [ ] **步骤 3：实现虚拟 read 工具**

创建 `/Users/liqxie/Desktop/project/docs/mini-agent/src/tools.ts`：

```ts
import type { Tool, ValidationResult } from "./types.ts";

export interface ReadParameters {
  path: string;
}

function validateReadArguments(value: unknown): ValidationResult<ReadParameters> {
  if (
    value === null ||
    typeof value !== "object" ||
    !("path" in value) ||
    typeof value.path !== "string"
  ) {
    return {
      ok: false,
      error: 'read requires an object with a string "path"',
    };
  }

  return { ok: true, value: { path: value.path } };
}

export function createReadTool(files: Readonly<Record<string, string>>): Tool<ReadParameters> {
  return {
    name: "read",
    description: "Read a UTF-8 file from the virtual file system",
    validate: validateReadArguments,
    async execute(_toolCallId, parameters, signal, onUpdate) {
      signal.throwIfAborted();
      await onUpdate({ content: `Reading ${parameters.path}` });
      signal.throwIfAborted();

      const content = files[parameters.path];
      if (content === undefined) {
        return {
          content: `File not found: ${parameters.path}`,
          details: { path: parameters.path },
          isError: true,
        };
      }

      return {
        content,
        details: { path: parameters.path },
        isError: false,
      };
    },
  };
}
```

- [ ] **步骤 4：运行工具测试**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && node --experimental-strip-types --test test/tools.test.ts
```

预期：3 个测试通过。

### 任务 3：实现并测试确定性的 Mock LLM

**文件：**
- 创建：`/Users/liqxie/Desktop/project/docs/mini-agent/test/mock-llm.test.ts`
- 创建：`/Users/liqxie/Desktop/project/docs/mini-agent/src/mock-llm.ts`

- [ ] **步骤 1：编写失败的 Mock LLM 行为测试**

创建 `/Users/liqxie/Desktop/project/docs/mini-agent/test/mock-llm.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createMockStream } from "../src/mock-llm.ts";
import type { AgentMessage, ModelStreamEvent } from "../src/types.ts";

async function collect(
  messages: AgentMessage[],
  signal = new AbortController().signal,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of createMockStream()(messages, signal)) {
    events.push(event);
  }
  return events;
}

test("mock model requests package.json when no read result exists", async () => {
  const events = await collect([
    {
      role: "user",
      content: "读取 package.json，并告诉我项目名称。",
      timestamp: 1,
    },
  ]);

  const toolEvent = events.find((event) => event.type === "tool_call");
  assert.equal(toolEvent?.type, "tool_call");
  if (toolEvent?.type !== "tool_call") return;
  assert.deepEqual(toolEvent.toolCall.arguments, { path: "package.json" });
});

test("mock model answers from a read tool result", async () => {
  const events = await collect([
    {
      role: "user",
      content: "读取 package.json，并告诉我项目名称。",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "call-read-package",
      toolName: "read",
      content: "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
      isError: false,
      timestamp: 2,
    },
  ]);

  const end = events.at(-1);
  assert.equal(end?.type, "end");
  if (end?.type !== "end") return;
  assert.deepEqual(end.message.content, [
    { type: "text", text: "项目名称是 mock-agent-demo。" },
  ]);
  assert.equal(end.message.stopReason, "stop");
});

test("mock model answers a version follow-up from existing tool history", async () => {
  const events = await collect([
    {
      role: "toolResult",
      toolCallId: "call-read-package",
      toolName: "read",
      content: "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
      isError: false,
      timestamp: 1,
    },
    {
      role: "user",
      content: "再告诉我版本号。",
      timestamp: 2,
    },
  ]);

  const end = events.at(-1);
  assert.equal(end?.type, "end");
  if (end?.type !== "end") return;
  assert.deepEqual(end.message.content, [
    { type: "text", text: "项目版本是 1.0.0。" },
  ]);
});
```

- [ ] **步骤 2：运行测试并验证因模块缺失而失败**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && node --experimental-strip-types --test test/mock-llm.test.ts
```

预期：FAIL，因为 `../src/mock-llm.ts` 不存在。

- [ ] **步骤 3：实现流式状态机**

创建 `/Users/liqxie/Desktop/project/docs/mini-agent/src/mock-llm.ts`：

```ts
import type {
  AgentMessage,
  AssistantMessage,
  ModelStreamEvent,
  StreamFn,
  ToolResultMessage,
} from "./types.ts";

function latestReadResult(messages: readonly AgentMessage[]): ToolResultMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "toolResult" &&
      message.toolName === "read" &&
      !message.isError
    ) {
      return message;
    }
  }
  return undefined;
}

function parsePackage(result: ToolResultMessage): {
  name?: string;
  version?: string;
} {
  try {
    const parsed: unknown = JSON.parse(result.content);
    if (parsed === null || typeof parsed !== "object") return {};
    return {
      name:
        "name" in parsed && typeof parsed.name === "string"
          ? parsed.name
          : undefined,
      version:
        "version" in parsed && typeof parsed.version === "string"
          ? parsed.version
          : undefined,
    };
  } catch {
    return {};
  }
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs === 0) {
    signal.throwIfAborted();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function* streamText(
  text: string,
  signal: AbortSignal,
  delayMs: number,
): AsyncGenerator<ModelStreamEvent> {
  let message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "stop",
    timestamp: Date.now(),
  };
  yield { type: "start", message };

  for (const character of text) {
    await wait(delayMs, signal);
    const current = message.content[0];
    if (current?.type !== "text") throw new Error("Invalid text stream state");
    message = {
      ...message,
      content: [{ type: "text", text: current.text + character }],
    };
    yield { type: "text_delta", delta: character, message };
  }

  yield { type: "end", message };
}

export function createMockStream(options: { delayMs?: number } = {}): StreamFn {
  const delayMs = options.delayMs ?? 0;

  return async function* mockStream(messages, signal) {
    signal.throwIfAborted();
    const lastMessage = messages.at(-1);
    const readResult = latestReadResult(messages);

    if (lastMessage?.role === "toolResult") {
      if (lastMessage.isError) {
        yield* streamText(
          `工具执行失败：${lastMessage.content}`,
          signal,
          delayMs,
        );
        return;
      }

      const packageData = parsePackage(lastMessage);
      yield* streamText(
        packageData.name
          ? `项目名称是 ${packageData.name}。`
          : "package.json 中没有有效的 name。",
        signal,
        delayMs,
      );
      return;
    }

    if (
      lastMessage?.role === "user" &&
      lastMessage.content.includes("只回答项目名称")
    ) {
      const packageData = readResult ? parsePackage(readResult) : {};
      yield* streamText(
        packageData.name ?? "当前上下文中没有项目名称。",
        signal,
        delayMs,
      );
      return;
    }

    if (lastMessage?.role === "user" && lastMessage.content.includes("版本号")) {
      const packageData = readResult ? parsePackage(readResult) : {};
      yield* streamText(
        packageData.version
          ? `项目版本是 ${packageData.version}。`
          : "当前上下文中没有项目版本信息。",
        signal,
        delayMs,
      );
      return;
    }

    if (
      lastMessage?.role === "user" &&
      lastMessage.content.includes("package.json")
    ) {
      const toolCall = {
        type: "toolCall" as const,
        id: "call-read-package",
        name: "read",
        arguments: { path: "package.json" },
      };
      const startMessage: AssistantMessage = {
        role: "assistant",
        content: [],
        stopReason: "toolUse",
        timestamp: Date.now(),
      };
      const toolMessage: AssistantMessage = {
        ...startMessage,
        content: [toolCall],
      };
      yield { type: "start", message: startMessage };
      yield { type: "tool_call", toolCall, message: toolMessage };
      yield { type: "end", message: toolMessage };
      return;
    }

    yield* streamText(
      lastMessage?.role === "user"
        ? `你说的是：${lastMessage.content}`
        : "没有可处理的用户消息。",
      signal,
      delayMs,
    );
  };
}
```

- [ ] **步骤 4：运行 Mock LLM 测试**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && node --experimental-strip-types --test test/mock-llm.test.ts
```

预期：3 个测试通过。

### 任务 4：实现基本的 Agent 循环

**文件：**
- 创建：`/Users/liqxie/Desktop/project/docs/mini-agent/test/agent-loop.test.ts`
- 创建：`/Users/liqxie/Desktop/project/docs/mini-agent/src/agent-loop.ts`

- [ ] **步骤 1：编写失败的端到端循环测试**

创建 `/Users/liqxie/Desktop/project/docs/mini-agent/test/agent-loop.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/agent-loop.ts";
import { createMockStream } from "../src/mock-llm.ts";
import { createReadTool } from "../src/tools.ts";
import type { AgentEvent, AgentMessage } from "../src/types.ts";

test("loop completes user to tool to final answer flow", async () => {
  const events: AgentEvent[] = [];
  const context = {
    messages: [] as AgentMessage[],
    tools: [
      createReadTool({
        "package.json":
          "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
      }),
    ],
  };

  await runAgentLoop(
    [
      {
        role: "user",
        content: "读取 package.json，并告诉我项目名称。",
        timestamp: 1,
      },
    ],
    context,
    {
      stream: createMockStream(),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
    },
    async (event) => {
      events.push(event);
    },
    new AbortController().signal,
  );

  const roles = context.messages.map((message) => message.role);
  assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant"]);

  const finalMessage = context.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.deepEqual(finalMessage.content, [
    { type: "text", text: "项目名称是 mock-agent-demo。" },
  ]);

  assert.deepEqual(
    events
      .filter((event) =>
        [
          "agent_start",
          "turn_start",
          "tool_execution_start",
          "tool_execution_end",
          "turn_end",
          "agent_end",
        ].includes(event.type),
      )
      .map((event) => event.type),
    [
      "agent_start",
      "turn_start",
      "tool_execution_start",
      "tool_execution_end",
      "turn_end",
      "turn_start",
      "turn_end",
      "agent_end",
    ],
  );
});
```

- [ ] **步骤 2：运行测试并验证因模块缺失而失败**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && node --experimental-strip-types --test test/agent-loop.test.ts
```

预期：FAIL，因为 `../src/agent-loop.ts` 不存在。

- [ ] **步骤 3：实现流式响应归约与串行工具执行**

创建 `/Users/liqxie/Desktop/project/docs/mini-agent/src/agent-loop.ts`：

```ts
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AssistantMessage,
  CompletedTurn,
  EventSink,
  ToolCall,
  ToolExecutionResult,
  ToolResultMessage,
} from "./types.ts";

function cloneAssistant(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((content) => ({ ...content })),
  };
}

async function emitMessage(message: AgentMessage, emit: EventSink): Promise<void> {
  await emit({ type: "message_start", message });
  await emit({ type: "message_end", message });
}

async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EventSink,
  signal: AbortSignal,
): Promise<AssistantMessage> {
  let finalMessage: AssistantMessage | undefined;

  for await (const modelEvent of config.stream(context.messages, signal)) {
    finalMessage = modelEvent.message;

    if (modelEvent.type === "start") {
      await emit({
        type: "message_start",
        message: cloneAssistant(modelEvent.message),
      });
      continue;
    }

    if (
      modelEvent.type === "text_delta" ||
      modelEvent.type === "tool_call"
    ) {
      await emit({
        type: "message_update",
        message: cloneAssistant(modelEvent.message),
        modelEvent,
      });
      continue;
    }

    await emit({ type: "message_end", message: modelEvent.message });
  }

  if (!finalMessage) {
    throw new Error("Model stream ended without an Assistant message");
  }

  context.messages.push(finalMessage);
  return finalMessage;
}

function errorResult(content: string): ToolExecutionResult {
  return { content, isError: true };
}

async function executeToolCall(
  context: AgentContext,
  toolCall: ToolCall,
  config: AgentLoopConfig,
  emit: EventSink,
  signal: AbortSignal,
): Promise<ToolResultMessage> {
  await emit({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    argumentsValue: toolCall.arguments,
  });

  const tool = context.tools.find((candidate) => candidate.name === toolCall.name);
  let result: ToolExecutionResult;

  if (!tool) {
    result = errorResult(`Unknown tool: ${toolCall.name}`);
  } else {
    const validation = tool.validate(toolCall.arguments);
    if (!validation.ok) {
      result = errorResult(validation.error);
    } else {
      const blocked = await config.beforeToolCall?.(
        toolCall,
        validation.value,
        signal,
      );

      if (blocked) {
        result = errorResult(blocked.reason);
      } else {
        try {
          result = await tool.execute(
            toolCall.id,
            validation.value,
            signal,
            async (partial) => {
              await emit({
                type: "tool_execution_update",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                partial,
              });
            },
          );
        } catch (error) {
          if (signal.aborted) throw error;
          result = errorResult(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
  }

  const replacement = await config.afterToolCall?.(toolCall, result, signal);
  const finalResult = replacement ?? result;
  const isError = finalResult.isError === true;

  await emit({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result: finalResult,
    isError,
  });

  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: finalResult.content,
    details: finalResult.details,
    isError,
    timestamp: Date.now(),
  };
  await emitMessage(message, emit);
  context.messages.push(message);
  return message;
}

export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: EventSink,
  signal: AbortSignal,
): Promise<void> {
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  for (const prompt of prompts) {
    await emitMessage(prompt, emit);
    context.messages.push(prompt);
  }

  let pendingMessages = config.getSteeringMessages();
  let completedTurn: CompletedTurn | undefined;
  let explicitContinuation = false;
  let firstTurn = true;

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) await emit({ type: "turn_start" });
      firstTurn = false;

      for (const message of pendingMessages) {
        await emitMessage(message, emit);
        context.messages.push(message);
      }
      pendingMessages = [];

      const assistant = await streamAssistantResponse(
        context,
        config,
        emit,
        signal,
      );
      const toolCalls = assistant.content.filter(
        (content): content is ToolCall => content.type === "toolCall",
      );
      const toolResults: ToolResultMessage[] = [];

      for (const toolCall of toolCalls) {
        toolResults.push(
          await executeToolCall(context, toolCall, config, emit, signal),
        );
      }

      completedTurn = {
        message: assistant,
        toolResults,
        context,
      };
      const decision = await config.finishTurn?.(completedTurn, signal);
      await emit({ type: "turn_end", message: assistant, toolResults });

      if (decision?.action === "end") {
        await emit({ type: "agent_end", messages: context.messages.slice() });
        return;
      }

      explicitContinuation = decision?.action === "continue";
      hasMoreToolCalls = toolResults.length > 0;
      pendingMessages = config.getSteeringMessages();
      if (hasMoreToolCalls || pendingMessages.length > 0) {
        explicitContinuation = false;
      }
    }

    const followUps = config.getFollowUpMessages();
    if (followUps.length > 0) {
      pendingMessages = followUps;
      explicitContinuation = false;
      continue;
    }

    if (explicitContinuation) {
      explicitContinuation = false;
      continue;
    }

    break;
  }

  void completedTurn;
  await emit({ type: "agent_end", messages: context.messages.slice() });
}
```

- [ ] **步骤 4：运行循环测试**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && node --experimental-strip-types --test test/agent-loop.test.ts
```

预期：1 个测试通过。

### 任务 5：实现有状态的 Agent 和事件归约器

**文件：**
- 创建：`/Users/liqxie/Desktop/project/docs/mini-agent/test/agent.test.ts`
- 创建：`/Users/liqxie/Desktop/project/docs/mini-agent/src/agent.ts`

- [ ] **步骤 1：编写失败的状态与订阅者测试**

创建 `/Users/liqxie/Desktop/project/docs/mini-agent/test/agent.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent.ts";
import { createMockStream } from "../src/mock-llm.ts";
import { createReadTool } from "../src/tools.ts";

function createAgent(options: { delayMs?: number } = {}): Agent {
  return new Agent({
    systemPrompt: "You are a deterministic teaching Agent.",
    stream: createMockStream({ delayMs: options.delayMs }),
    tools: [
      createReadTool({
        "package.json":
          "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
      }),
    ],
  });
}

test("Agent stores complete messages and exposes updated state to subscribers", async () => {
  const agent = createAgent();
  const observedRoles: string[][] = [];

  agent.subscribe((event) => {
    if (event.type === "message_end") {
      observedRoles.push(agent.state.messages.map((message) => message.role));
    }
  });

  await agent.prompt("读取 package.json，并告诉我项目名称。");

  assert.deepEqual(
    agent.state.messages.map((message) => message.role),
    ["system", "user", "assistant", "toolResult", "assistant"],
  );
  assert.deepEqual(observedRoles.at(-1), [
    "system",
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  assert.equal(agent.state.isStreaming, false);
});

test("Agent rejects a second prompt while active", async () => {
  const agent = createAgent({ delayMs: 20 });
  const running = agent.prompt("读取 package.json，并告诉我项目名称。");

  await assert.rejects(
    agent.prompt("第二个请求"),
    /Agent is already processing/,
  );

  await running;
});
```

- [ ] **步骤 2：运行测试并验证因模块缺失而失败**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && node --experimental-strip-types --test test/agent.test.ts
```

预期：FAIL，因为 `../src/agent.ts` 不存在。

- [ ] **步骤 3：实现 `Agent`、队列、生命周期与事件归约**

创建 `/Users/liqxie/Desktop/project/docs/mini-agent/src/agent.ts`：

```ts
import { runAgentLoop } from "./agent-loop.ts";
import type {
  AfterToolCall,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentState,
  BeforeToolCall,
  FinishTurn,
  StreamFn,
  Tool,
  UserMessage,
} from "./types.ts";

export interface AgentOptions {
  systemPrompt: string;
  stream: StreamFn;
  tools: Tool<unknown>[];
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  finishTurn?: FinishTurn;
}

type Listener = (event: AgentEvent, signal: AbortSignal) => void | Promise<void>;

class MessageQueue {
  private messages: AgentMessage[] = [];

  enqueue(message: AgentMessage): void {
    this.messages.push(message);
  }

  drainOne(): AgentMessage[] {
    const first = this.messages.shift();
    return first ? [first] : [];
  }

  clear(): void {
    this.messages = [];
  }
}

interface ActiveRun {
  controller: AbortController;
  settled: Promise<void>;
  resolveSettled(): void;
}

export class Agent {
  private readonly listeners = new Set<Listener>();
  private readonly steeringQueue = new MessageQueue();
  private readonly followUpQueue = new MessageQueue();
  private readonly stream: StreamFn;
  private readonly beforeToolCall?: BeforeToolCall;
  private readonly afterToolCall?: AfterToolCall;
  private readonly finishTurn?: FinishTurn;
  private activeRun?: ActiveRun;
  private mutableState: {
    messages: AgentMessage[];
    tools: Tool<unknown>[];
    isStreaming: boolean;
    streamingMessage?: AgentState["streamingMessage"];
    pendingToolCalls: Set<string>;
    errorMessage?: string;
  };

  constructor(options: AgentOptions) {
    this.stream = options.stream;
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
    this.finishTurn = options.finishTurn;
    this.mutableState = {
      messages: [
        {
          role: "system",
          content: options.systemPrompt,
          timestamp: Date.now(),
        },
      ],
      tools: options.tools.slice(),
      isStreaming: false,
      pendingToolCalls: new Set(),
    };
  }

  get state(): AgentState {
    return this.mutableState;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  steer(content: string): void {
    this.steeringQueue.enqueue(this.createUserMessage(content));
  }

  followUp(content: string): void {
    this.followUpQueue.enqueue(this.createUserMessage(content));
  }

  abort(): void {
    this.activeRun?.controller.abort(
      new Error("Agent run aborted"),
    );
  }

  waitForIdle(): Promise<void> {
    return this.activeRun?.settled ?? Promise.resolve();
  }

  async prompt(content: string): Promise<void> {
    this.assertIdle();
    await this.run([this.createUserMessage(content)]);
  }

  async continue(): Promise<void> {
    this.assertIdle();
    const messages = this.mutableState.messages;
    const lastMessage = messages.at(-1);

    if (!lastMessage || messages.every((message) => message.role === "system")) {
      throw new Error("No messages to continue from");
    }

    if (lastMessage.role === "assistant") {
      const steering = this.steeringQueue.drainOne();
      if (steering.length > 0) {
        await this.run(steering);
        return;
      }
      const followUps = this.followUpQueue.drainOne();
      if (followUps.length > 0) {
        await this.run(followUps);
        return;
      }
      throw new Error("Cannot continue from message role: assistant");
    }

    await this.run([]);
  }

  reset(): void {
    this.assertIdle();
    const system = this.mutableState.messages.find(
      (message) => message.role === "system",
    );
    this.mutableState.messages = system ? [system] : [];
    this.mutableState.streamingMessage = undefined;
    this.mutableState.pendingToolCalls = new Set();
    this.mutableState.errorMessage = undefined;
    this.steeringQueue.clear();
    this.followUpQueue.clear();
  }

  private createUserMessage(content: string): UserMessage {
    return { role: "user", content, timestamp: Date.now() };
  }

  private assertIdle(): void {
    if (this.activeRun) {
      throw new Error("Agent is already processing");
    }
  }

  private createContext(): AgentContext {
    return {
      messages: this.mutableState.messages.slice(),
      tools: this.mutableState.tools.slice(),
    };
  }

  private createConfig(): AgentLoopConfig {
    return {
      stream: this.stream,
      getSteeringMessages: () => this.steeringQueue.drainOne(),
      getFollowUpMessages: () => this.followUpQueue.drainOne(),
      beforeToolCall: this.beforeToolCall,
      afterToolCall: this.afterToolCall,
      finishTurn: this.finishTurn,
    };
  }

  private async run(prompts: AgentMessage[]): Promise<void> {
    const controller = new AbortController();
    let resolveSettled = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const activeRun: ActiveRun = { controller, settled, resolveSettled };
    this.activeRun = activeRun;
    this.mutableState.isStreaming = true;
    this.mutableState.errorMessage = undefined;

    try {
      await runAgentLoop(
        prompts,
        this.createContext(),
        this.createConfig(),
        (event) => this.processEvent(event, controller.signal),
        controller.signal,
      );
    } catch (error) {
      await this.emitFailure(error, controller.signal);
    } finally {
      this.mutableState.isStreaming = false;
      this.mutableState.streamingMessage = undefined;
      this.mutableState.pendingToolCalls = new Set();
      activeRun.resolveSettled();
      if (this.activeRun === activeRun) {
        this.activeRun = undefined;
      }
    }
  }

  private async emitFailure(
    error: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "" }],
      stopReason: signal.aborted ? ("aborted" as const) : ("error" as const),
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    await this.processEvent({ type: "message_start", message }, signal);
    await this.processEvent({ type: "message_end", message }, signal);
    await this.processEvent(
      { type: "turn_end", message, toolResults: [] },
      signal,
    );
    await this.processEvent(
      { type: "agent_end", messages: [message] },
      signal,
    );
  }

  private async processEvent(
    event: AgentEvent,
    signal: AbortSignal,
  ): Promise<void> {
    switch (event.type) {
      case "message_start":
      case "message_update":
        if (event.message.role === "assistant") {
          this.mutableState.streamingMessage = event.message;
        }
        break;
      case "message_end":
        this.mutableState.streamingMessage = undefined;
        this.mutableState.messages.push(event.message);
        break;
      case "tool_execution_start": {
        const next = new Set(this.mutableState.pendingToolCalls);
        next.add(event.toolCallId);
        this.mutableState.pendingToolCalls = next;
        break;
      }
      case "tool_execution_end": {
        const next = new Set(this.mutableState.pendingToolCalls);
        next.delete(event.toolCallId);
        this.mutableState.pendingToolCalls = next;
        break;
      }
      case "turn_end":
        this.mutableState.errorMessage = event.message.errorMessage;
        break;
      case "agent_end":
        this.mutableState.streamingMessage = undefined;
        break;
    }

    for (const listener of this.listeners) {
      await listener(event, signal);
    }
  }
}
```

- [ ] **步骤 4：运行 Agent 测试**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && node --experimental-strip-types --test test/agent.test.ts
```

预期：2 个测试通过。

### 任务 6：补充队列、continuation、取消、钩子和错误覆盖

**文件：**
- 修改：`/Users/liqxie/Desktop/project/docs/mini-agent/test/agent.test.ts`
- 修改：`/Users/liqxie/Desktop/project/docs/mini-agent/test/agent-loop.test.ts`

- [ ] **步骤 1：扩展仅测试用的类型导入**

在 `/Users/liqxie/Desktop/project/docs/mini-agent/test/agent.test.ts` 中添加此导入：

```ts
import type { StreamFn, Tool } from "../src/types.ts";
```

将 `/Users/liqxie/Desktop/project/docs/mini-agent/test/agent-loop.test.ts` 中的类型导入替换为：

```ts
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  StreamFn,
  Tool,
  ToolCall,
} from "../src/types.ts";
```

- [ ] **步骤 2：添加 steering 和 follow-up 测试**

追加到 `/Users/liqxie/Desktop/project/docs/mini-agent/test/agent.test.ts`：

```ts
test("steer is delivered at the next Turn boundary", async () => {
  const agent = createAgent({ delayMs: 1 });
  let steered = false;

  agent.subscribe((event) => {
    if (event.type === "tool_execution_end" && !steered) {
      steered = true;
      agent.steer("只回答项目名称。");
    }
  });

  await agent.prompt("读取 package.json，并告诉我项目名称。");

  const users = agent.state.messages.filter(
    (message) => message.role === "user",
  );
  assert.deepEqual(
    users.map((message) => message.content),
    ["读取 package.json，并告诉我项目名称。", "只回答项目名称。"],
  );
});

test("followUp is delivered after the first task naturally completes", async () => {
  const agent = createAgent();
  agent.followUp("再告诉我版本号。");

  await agent.prompt("读取 package.json，并告诉我项目名称。");

  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.deepEqual(finalMessage.content, [
    { type: "text", text: "项目版本是 1.0.0。" },
  ]);
});
```

- [ ] **步骤 3：添加 continuation 和模型取消测试**

追加到 `/Users/liqxie/Desktop/project/docs/mini-agent/test/agent.test.ts`：

```ts
test("continue consumes a queued follow-up after an Assistant tail", async () => {
  const agent = createAgent();
  await agent.prompt("普通消息");
  agent.followUp("再告诉我版本号。");

  await agent.continue();

  const users = agent.state.messages.filter(
    (message) => message.role === "user",
  );
  assert.equal(users.at(-1)?.content, "再告诉我版本号。");
});

test("abort produces an aborted Assistant message", async () => {
  const agent = createAgent({ delayMs: 20 });
  const running = agent.prompt("普通消息");

  setTimeout(() => agent.abort(), 5);
  await running;

  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.equal(finalMessage.stopReason, "aborted");
  assert.equal(agent.state.isStreaming, false);
});

test("continue resumes from an existing user tail without duplicating it", async () => {
  const agent = createAgent();
  agent.state.messages.push({
    role: "user",
    content: "读取 package.json，并告诉我项目名称。",
    timestamp: 1,
  });

  await agent.continue();

  const users = agent.state.messages.filter(
    (message) => message.role === "user",
  );
  assert.equal(users.length, 1);
  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.deepEqual(finalMessage.content, [
    { type: "text", text: "项目名称是 mock-agent-demo。" },
  ]);
});

test("continue resumes directly from a tool-result tail", async () => {
  const agent = createAgent();
  agent.state.messages.push({
    role: "toolResult",
    toolCallId: "call-read-package",
    toolName: "read",
    content: "{\"name\":\"from-tool-result\",\"version\":\"3.0.0\"}",
    isError: false,
    timestamp: 1,
  });

  await agent.continue();

  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.deepEqual(finalMessage.content, [
    { type: "text", text: "项目名称是 from-tool-result。" },
  ]);
});

test("waitForIdle settles after the active run finishes", async () => {
  const agent = createAgent({ delayMs: 2 });
  const running = agent.prompt("普通消息");
  const idle = agent.waitForIdle();

  await idle;
  await running;

  assert.equal(agent.state.isStreaming, false);
});

test("reset preserves only the System message and clears queued work", async () => {
  const agent = createAgent();
  await agent.prompt("普通消息");
  agent.followUp("再告诉我版本号。");

  agent.reset();

  assert.deepEqual(
    agent.state.messages.map((message) => message.role),
    ["system"],
  );
  await agent.prompt("新的普通消息");
  assert.equal(
    agent.state.messages.some(
      (message) =>
        message.role === "user" && message.content === "再告诉我版本号。",
    ),
    false,
  );
});
```

- [ ] **步骤 4：添加协作式工具取消与模型失败测试**

追加到 `/Users/liqxie/Desktop/project/docs/mini-agent/test/agent.test.ts`：

```ts
test("abort stops a cooperative long-running tool", async () => {
  const stream: StreamFn = async function* (messages) {
    const last = messages.at(-1);
    if (last?.role === "toolResult") {
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "finished" }],
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      yield { type: "start", message };
      yield { type: "end", message };
      return;
    }

    const toolCall = {
      type: "toolCall" as const,
      id: "call-slow",
      name: "slow",
      arguments: {},
    };
    const start = {
      role: "assistant" as const,
      content: [],
      stopReason: "toolUse" as const,
      timestamp: Date.now(),
    };
    const end = { ...start, content: [toolCall] };
    yield { type: "start", message: start };
    yield { type: "tool_call", toolCall, message: end };
    yield { type: "end", message: end };
  };

  const slowTool: Tool<unknown> = {
    name: "slow",
    description: "Wait until aborted",
    validate: () => ({ ok: true, value: {} }),
    async execute(_id, _parameters, signal) {
      signal.throwIfAborted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return { content: "unreachable" };
    },
  };

  const agent = new Agent({
    systemPrompt: "Test",
    stream,
    tools: [slowTool],
  });
  const running = agent.prompt("run slow tool");
  setTimeout(() => agent.abort(), 5);
  await running;

  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.equal(finalMessage.stopReason, "aborted");
});

test("model failure becomes an error Assistant message", async () => {
  const failingStream: StreamFn = async function* () {
    throw new Error("model exploded");
  };
  const agent = new Agent({
    systemPrompt: "Test",
    stream: failingStream,
    tools: [],
  });

  await agent.prompt("trigger failure");

  const finalMessage = agent.state.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.equal(finalMessage.stopReason, "error");
  assert.equal(finalMessage.errorMessage, "model exploded");
});
```

- [ ] **步骤 5：添加钩子测试**

追加到 `/Users/liqxie/Desktop/project/docs/mini-agent/test/agent-loop.test.ts`：

```ts
test("beforeToolCall can block execution", async () => {
  const context = {
    messages: [] as AgentMessage[],
    tools: [createReadTool({ "package.json": "{}" })],
  };

  await runAgentLoop(
    [
      {
        role: "user",
        content: "读取 package.json。",
        timestamp: 1,
      },
    ],
    context,
    {
      stream: createMockStream(),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      beforeToolCall: async () => ({
        block: true,
        reason: "Reading files is blocked",
      }),
    },
    async () => {},
    new AbortController().signal,
  );

  const result = context.messages.find(
    (message) => message.role === "toolResult",
  );
  assert.equal(result?.role, "toolResult");
  if (result?.role !== "toolResult") return;
  assert.equal(result.isError, true);
  assert.equal(result.content, "Reading files is blocked");
});

test("afterToolCall can replace a successful result", async () => {
  const context = {
    messages: [] as AgentMessage[],
    tools: [
      createReadTool({
        "package.json": "{\"name\":\"original\",\"version\":\"1.0.0\"}",
      }),
    ],
  };

  await runAgentLoop(
    [
      {
        role: "user",
        content: "读取 package.json。",
        timestamp: 1,
      },
    ],
    context,
    {
      stream: createMockStream(),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      afterToolCall: async () => ({
        content: "{\"name\":\"replaced\",\"version\":\"2.0.0\"}",
        isError: false,
      }),
    },
    async () => {},
    new AbortController().signal,
  );

  const finalMessage = context.messages.at(-1);
  assert.equal(finalMessage?.role, "assistant");
  if (finalMessage?.role !== "assistant") return;
  assert.deepEqual(finalMessage.content, [
    { type: "text", text: "项目名称是 replaced。" },
  ]);
});
```

- [ ] **步骤 6：添加显式工具错误测试**

追加到 `/Users/liqxie/Desktop/project/docs/mini-agent/test/agent-loop.test.ts`：

```ts
function createSingleToolCallStream(toolCall: ToolCall): StreamFn {
  return async function* (messages) {
    if (messages.at(-1)?.role === "toolResult") {
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Tool result observed." }],
        stopReason: "stop",
        timestamp: Date.now(),
      };
      yield { type: "start", message };
      yield { type: "end", message };
      return;
    }

    const start: AssistantMessage = {
      role: "assistant",
      content: [],
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    const end: AssistantMessage = { ...start, content: [toolCall] };
    yield { type: "start", message: start };
    yield { type: "tool_call", toolCall, message: end };
    yield { type: "end", message: end };
  };
}

async function runSingleToolCall(
  toolCall: ToolCall,
  tools: Tool<unknown>[],
): Promise<AgentMessage[]> {
  const context = { messages: [] as AgentMessage[], tools };
  await runAgentLoop(
    [{ role: "user", content: "run tool", timestamp: 1 }],
    context,
    {
      stream: createSingleToolCallStream(toolCall),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
    },
    async () => {},
    new AbortController().signal,
  );
  return context.messages;
}

test("unknown tool becomes an explicit error tool result", async () => {
  const messages = await runSingleToolCall(
    {
      type: "toolCall",
      id: "call-missing",
      name: "missing",
      arguments: {},
    },
    [],
  );

  const result = messages.find((message) => message.role === "toolResult");
  assert.equal(result?.role, "toolResult");
  if (result?.role !== "toolResult") return;
  assert.equal(result.isError, true);
  assert.equal(result.content, "Unknown tool: missing");
});

test("invalid tool arguments become an explicit error tool result", async () => {
  const messages = await runSingleToolCall(
    {
      type: "toolCall",
      id: "call-invalid",
      name: "read",
      arguments: { path: 42 },
    },
    [createReadTool({})],
  );

  const result = messages.find((message) => message.role === "toolResult");
  assert.equal(result?.role, "toolResult");
  if (result?.role !== "toolResult") return;
  assert.equal(result.isError, true);
  assert.equal(
    result.content,
    'read requires an object with a string "path"',
  );
});

test("tool exceptions become explicit error tool results", async () => {
  const explodingTool: Tool<unknown> = {
    name: "explode",
    description: "Throw a test error",
    validate: () => ({ ok: true, value: {} }),
    async execute() {
      throw new Error("boom");
    },
  };
  const messages = await runSingleToolCall(
    {
      type: "toolCall",
      id: "call-explode",
      name: "explode",
      arguments: {},
    },
    [explodingTool],
  );

  const result = messages.find((message) => message.role === "toolResult");
  assert.equal(result?.role, "toolResult");
  if (result?.role !== "toolResult") return;
  assert.equal(result.isError, true);
  assert.equal(result.content, "boom");
});
```

- [ ] **步骤 7：添加有守卫的 `finishTurn` 测试**

追加到 `/Users/liqxie/Desktop/project/docs/mini-agent/test/agent-loop.test.ts`：

```ts
test("finishTurn can request exactly one extra context-only Turn", async () => {
  const context = {
    messages: [] as AgentMessage[],
    tools: [],
  };
  let requested = false;
  let turnCount = 0;

  await runAgentLoop(
    [
      {
        role: "user",
        content: "普通消息",
        timestamp: 1,
      },
    ],
    context,
    {
      stream: createMockStream(),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      finishTurn: async () => {
        turnCount += 1;
        if (!requested) {
          requested = true;
          return { action: "continue" };
        }
        return undefined;
      },
    },
    async () => {},
    new AbortController().signal,
  );

  assert.equal(turnCount, 2);
});

test("finishTurn can stop before a queued follow-up", async () => {
  const context = {
    messages: [] as AgentMessage[],
    tools: [],
  };
  const followUps: AgentMessage[] = [
    { role: "user", content: "不应执行", timestamp: 2 },
  ];

  await runAgentLoop(
    [{ role: "user", content: "普通消息", timestamp: 1 }],
    context,
    {
      stream: createMockStream(),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => followUps.splice(0),
      finishTurn: async () => ({ action: "end" }),
    },
    async () => {},
    new AbortController().signal,
  );

  assert.equal(
    context.messages.some(
      (message) => message.role === "user" && message.content === "不应执行",
    ),
    false,
  );
});
```

- [ ] **步骤 8：运行全部测试**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && npm test
```

预期：所有测试通过。

### 任务 7：添加可观察的 Demo

**文件：**
- 创建：`/Users/liqxie/Desktop/project/docs/mini-agent/src/demo.ts`

- [ ] **步骤 1：创建完整演示**

创建 `/Users/liqxie/Desktop/project/docs/mini-agent/src/demo.ts`：

```ts
import { Agent } from "./agent.ts";
import { createMockStream } from "./mock-llm.ts";
import { createReadTool } from "./tools.ts";

const agent = new Agent({
  systemPrompt: "You are a deterministic teaching Agent.",
  stream: createMockStream({ delayMs: 10 }),
  tools: [
    createReadTool({
      "package.json":
        "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
    }),
  ],
});

agent.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "agent_end":
      console.log(`\n[event] ${event.type}`);
      break;
    case "message_update":
      if (event.modelEvent.type === "text_delta") {
        process.stdout.write(event.modelEvent.delta);
      }
      break;
    case "tool_execution_start":
      console.log(
        `\n[tool:start] ${event.toolName} ${JSON.stringify(event.argumentsValue)}`,
      );
      break;
    case "tool_execution_update":
      console.log(`\n[tool:update] ${event.partial.content}`);
      break;
    case "tool_execution_end":
      console.log(
        `\n[tool:end] ${event.toolName} error=${String(event.isError)}`,
      );
      break;
  }
});

await agent.prompt("读取 package.json，并告诉我项目名称。");

console.log("\n\nFinal transcript:");
for (const message of agent.state.messages) {
  console.log(JSON.stringify(message));
}
```

- [ ] **步骤 2：运行 demo**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && npm run demo
```

预期输出包含：

```text
[event] agent_start
[tool:start] read {"path":"package.json"}
[tool:end] read error=false
项目名称是 mock-agent-demo。
[event] agent_end
```

- [ ] **步骤 3：运行完整类型检查**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && npm run check
```

预期：退出码 0，无任何诊断信息。

- [ ] **步骤 4：运行完整测试套件**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && npm test
```

预期：所有测试通过。

### 任务 8：撰写扩展版本升级边界文档

**文件：**
- 创建：`/Users/liqxie/Desktop/project/docs/mini-agent/README.md`

- [ ] **步骤 1：编写学习与升级指南**

创建 `/Users/liqxie/Desktop/project/docs/mini-agent/README.md`：

````md
# Minimal Mock Agent

本项目是一个零运行时依赖的、使用工具的 Agent 教学实现。

## 运行

```bash
npm run demo
npm test
npm run check
```

## 按此顺序阅读

1. `src/types.ts`
2. `src/mock-llm.ts`
3. `src/tools.ts`
4. `src/agent-loop.ts`
5. `src/agent.ts`
6. `src/demo.ts`

## 核心流程

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

## 升级路径

### 真实 AI API

保留 `StreamFn` 契约。添加一个适配器，把提供商的流式事件转换为 `ModelStreamEvent`。

### 并行工具

把工具执行移到 `ToolExecutionStrategy` 之后。添加串行与并行实现。无论完成顺序如何，最终 tool-result 消息始终按模型原始工具调用顺序追加。

### 重试

用 `RetryPolicy` 包裹 `StreamFn` 调用。只重试已知安全的模型请求。绝不要盲重放有副作用的工具。

### 上下文准备

添加三个独立的钩子：

- `transformContext`，用于剪枝或摘要；
- `prepareRequest`，用于最后时刻的状态同步；
- `prepareNextTurn`，用于基于已完成 Turn 的决策。

### 持久化

添加一个带有 `load()` 和原子 `append()` 操作的 `SessionStore` 接口。让持久化保持在模型适配器和工具实现之外。
````

- [ ] **步骤 2：运行最终验证**

运行：

```bash
cd /Users/liqxie/Desktop/project/docs/mini-agent && npm run check && npm test && npm run demo
```

预期：

- 类型检查成功；
- 所有测试通过；
- demo 到达 `agent_end`；
- 最终 transcript 包含用户消息、assistant 工具调用、工具结果和最终 Assistant 答案。

## 计划完成检查

在宣布实现完成之前，验证：

- 设计中核心版本的每一项要求都有一个通过的测试。
- `/Users/liqxie/Desktop/project/docs/mini-agent/` 下任何地方都没有导入 Pi 包。
- `package.json` 不含运行时依赖。
- TypeScript 源码中没有出现 `any`。
- Mock 模型逻辑与工具执行保持分离。
- 事件订阅者在归约器更新状态之后才观察到状态。
- README 解释了扩展版本路径，但没有提前实现它。
