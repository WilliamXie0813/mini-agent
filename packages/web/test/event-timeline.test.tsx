import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EventTimeline } from "../src/components/EventTimeline";
import type { StoredEvent } from "../src/state/client";

let seq = 0;
function stored(type: string, receivedAt = 0): StoredEvent {
  return {
    event: { type },
    receivedAt,
    seq: seq++,
  } as StoredEvent;
}

describe("EventTimeline", () => {
  it("groups events between turn_start and turn_end into a turn block", () => {
    render(
      <EventTimeline
        events={[
          stored("turn_start", 1000),
          stored("message_start", 1010),
          stored("turn_end", 2000),
        ]}
      />,
    );
    expect(screen.getByText("轮次 1")).toBeInTheDocument();
    expect(screen.getByText("3 个事件")).toBeInTheDocument();
    expect(screen.getByText("1.0s")).toBeInTheDocument();
  });

  it("merges consecutive message_update events into a single counted row", () => {
    render(
      <EventTimeline
        events={[
          stored("turn_start", 1000),
          stored("message_update", 1010),
          stored("message_update", 1020),
          stored("message_update", 1030),
          stored("turn_end", 2000),
        ]}
      />,
    );
    expect(screen.getByText(/message_update ×3/)).toBeInTheDocument();
  });

  it("marks an unclosed turn block as in progress", () => {
    render(
      <EventTimeline
        events={[stored("turn_start", 1000), stored("message_start", 1010)]}
      />,
    );
    expect(screen.getByText("进行中")).toBeInTheDocument();
  });

  it("renders events outside turns as standalone rows", () => {
    render(<EventTimeline events={[stored("agent_start", 1000)]} />);
    expect(screen.getByText("agent_start")).toBeInTheDocument();
  });

  it("shows millisecond-precision timestamps", () => {
    const ts = new Date(2026, 0, 1, 12, 30, 45, 123).getTime();
    render(<EventTimeline events={[stored("agent_start", ts)]} />);
    expect(screen.getByText(/12:30:45\.123/)).toBeInTheDocument();
  });
});
