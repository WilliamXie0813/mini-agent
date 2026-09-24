import { render, screen } from "@testing-library/react";
import { notification } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyState } from "../src/state/reducer";

vi.mock("antd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("antd")>();
  return {
    ...actual,
    notification: {
      error: vi.fn(),
      warning: vi.fn(),
    },
  };
});

const binding = {
  state: emptyState(),
  events: [],
  connected: true,
  send: vi.fn(),
};

vi.mock("../src/hooks/useAgentClient", () => ({
  useAgentClient: () => binding,
}));

import App from "../src/App";

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    binding.connected = true;
  });

  it("renders the top bar title", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Mini Agent" }),
    ).toBeInTheDocument();
  });

  it("warns when an established connection drops", () => {
    const { rerender } = render(<App />);
    binding.connected = false;
    rerender(<App />);
    expect(notification.warning).toHaveBeenCalledWith(
      expect.objectContaining({ message: "连接已断开" }),
    );
  });

  it("does not warn when starting disconnected", () => {
    binding.connected = false;
    render(<App />);
    expect(notification.warning).not.toHaveBeenCalled();
  });
});
