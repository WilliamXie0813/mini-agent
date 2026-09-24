import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InspectorPanel } from "../src/components/InspectorPanel";
import { emptyState } from "../src/state/reducer";

describe("InspectorPanel", () => {
  it("renders the three tabs", () => {
    render(<InspectorPanel state={emptyState()} events={[]} />);
    expect(screen.getByText(/事件流/)).toBeInTheDocument();
    expect(screen.getByText("消息历史")).toBeInTheDocument();
    expect(screen.getByText("队列与状态")).toBeInTheDocument();
  });

  it("shows queue contents on the queues tab", () => {
    const state = {
      ...emptyState(),
      queues: {
        steering: [{ role: "user" as const, content: "排队中的消息", timestamp: 1 }],
        followUp: [],
      },
    };
    render(
      <InspectorPanel state={state} events={[]} defaultActiveKey="queues" />,
    );
    expect(screen.getByText(/排队中的消息/)).toBeInTheDocument();
  });

  it("shows events on the timeline tab", () => {
    render(
      <InspectorPanel
        state={emptyState()}
        events={[{ event: { type: "agent_start" }, receivedAt: 1 }]}
      />,
    );
    expect(screen.getByText("agent_start")).toBeInTheDocument();
  });
});
