import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@mini-agent/core";
import { ChatPanel } from "../src/components/ChatPanel";
import { emptyState } from "../src/state/reducer";

describe("ChatPanel", () => {
  it("shows an empty hint when there are no messages", () => {
    render(<ChatPanel state={emptyState()} />);
    expect(screen.getByText("发送消息开始对话")).toBeInTheDocument();
  });

  it("renders user and assistant messages plus tool call cards", () => {
    const state = {
      ...emptyState(),
      messages: [
        { role: "user" as const, content: "读取 package.json", timestamp: 1 },
        {
          role: "assistant" as const,
          content: [
            {
              type: "toolCall" as const,
              id: "call-1",
              name: "read",
              arguments: { path: "package.json" },
            },
          ],
          stopReason: "toolUse" as const,
          timestamp: 2,
        },
        {
          role: "toolResult" as const,
          toolCallId: "call-1",
          toolName: "read",
          content: "{\"name\":\"mock-agent-demo\"}",
          isError: false,
          timestamp: 3,
        },
      ],
      pendingToolCalls: ["call-1"],
    };
    render(<ChatPanel state={state} />);
    expect(screen.getByText("读取 package.json")).toBeInTheDocument();
    expect(screen.getByText("read")).toBeInTheDocument();
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(screen.getByText(/工具结果/)).toBeInTheDocument();
  });

  it("renders the streaming message with a cursor", () => {
    const streaming: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "正在回答" }],
      stopReason: "stop",
      timestamp: 1,
    };
    render(<ChatPanel state={{ ...emptyState(), streamingMessage: streaming }} />);
    expect(screen.getByText(/正在回答/)).toBeInTheDocument();
  });
});
