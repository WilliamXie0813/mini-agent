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
