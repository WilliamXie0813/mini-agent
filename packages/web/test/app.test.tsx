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
      success: vi.fn(),
    },
  };
});

const binding = {
  state: emptyState(),
  events: [],
  connected: true,
  resetCount: 0,
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
    binding.resetCount = 0;
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

  it("confirms reconnection after an established connection drops", () => {
    const { rerender } = render(<App />);
    binding.connected = false;
    rerender(<App />);
    binding.connected = true;
    rerender(<App />);
    expect(notification.success).toHaveBeenCalledWith(
      expect.objectContaining({ message: "已重新连接" }),
    );
  });

  it("confirms when the server applies a session reset", () => {
    const { rerender } = render(<App />);
    binding.resetCount = 1;
    rerender(<App />);
    expect(notification.success).toHaveBeenCalledWith(
      expect.objectContaining({ message: "会话已重置" }),
    );
  });
});
