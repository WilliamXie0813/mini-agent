import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer";

function renderComposer(isStreaming: boolean, overrides = {}) {
  const props = {
    isStreaming,
    onPrompt: vi.fn(),
    onSteer: vi.fn(),
    onFollowUp: vi.fn(),
    onAbort: vi.fn(),
    ...overrides,
  };
  render(<Composer {...props} />);
  return props;
}

describe("Composer", () => {
  it("shows only the send button when idle", () => {
    renderComposer(false);
    expect(
      screen.getByRole("button", { name: /发\s*送/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /中\s*止/ })).toBeNull();
  });

  it("shows steer / followUp / abort controls while streaming", () => {
    renderComposer(true);
    expect(screen.getByRole("button", { name: /中\s*止/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Steer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "FollowUp" })).toBeInTheDocument();
  });

  it("emits onPrompt with trimmed content and clears the input", () => {
    const props = renderComposer(false);
    fireEvent.change(screen.getByPlaceholderText("输入消息…"), {
      target: { value: "  你好  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /发\s*送/ }));
    expect(props.onPrompt).toHaveBeenCalledWith("你好");
  });

  it("emits onFollowUp while streaming", () => {
    const props = renderComposer(true);
    fireEvent.change(
      screen.getByPlaceholderText("Agent 运行中：可以 steer 或 followUp…"),
      { target: { value: "稍后继续" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "FollowUp" }));
    expect(props.onFollowUp).toHaveBeenCalledWith("稍后继续");
  });

  it("emits onAbort without requiring input", () => {
    const props = renderComposer(true);
    fireEvent.click(screen.getByRole("button", { name: /中\s*止/ }));
    expect(props.onAbort).toHaveBeenCalled();
  });
});
