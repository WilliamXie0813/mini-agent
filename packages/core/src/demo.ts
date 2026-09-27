/**
 * demo.ts — 可运行的演示脚本
 *
 * 组装一个最小 Agent（Mock 模型 + 虚拟 package.json 的 read 工具），
 * 订阅全部事件并打印，最后输出完整消息历史。
 *
 * 运行后应观察到的流程：
 *   agent_start → turn_start → 流式 assistant（含 read 工具调用）
 *   → 工具执行 → toolResult → 下一个 Turn → 流式最终答案 → agent_end
 *
 * 默认 prompt：「读取 package.json，并告诉我项目名称。」
 * 预期最终答案能识别出项目名称 mock-agent-demo。
 */
import { Agent } from "./agent.ts";
import { createMockStream } from "./mock-llm.ts";
import { createReadTool } from "./tools.ts";

const agent = new Agent({
  systemPrompt: "You are a deterministic teaching Agent.",
  // delayMs: 10 让流式输出逐字符可见，便于观察 message_update 事件
  stream: createMockStream({ delayMs: 10 }),
  tools: [
    createReadTool({
      "package.json":
        "{\"name\":\"mock-agent-demo\",\"version\":\"1.0.0\"}",
    }),
  ],
});

// 订阅者即“渲染层”：把生命周期事件打印成可观察的时间线
agent.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "agent_end":
      console.log(`\n[event] ${event.type}`);
      break;
    case "message_update":
      // 流式文本直接逐字符写到终端（不换行）
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

// run 结束后打印完整 transcript，对照检查每条消息的角色与内容
console.log("\n\nFinal transcript:");
for (const message of agent.state.messages) {
  console.log(JSON.stringify(message));
}
