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
    expect(screen.getByPlaceholderText("输入消息…")).toHaveValue("");
  });

  it("emits onFollowUp while streaming", () => {
    const props = renderComposer(true);
    fireEvent.change(
      screen.getByPlaceholderText("Agent 运行中：可以 Steer 或 FollowUp…"),
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

  it("submits on Enter when idle", () => {
    const props = renderComposer(false);
    const textarea = screen.getByPlaceholderText("输入消息…");
    fireEvent.change(textarea, { target: { value: "回车发送" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(props.onPrompt).toHaveBeenCalledWith("回车发送");
  });

  it("does not submit on Shift+Enter", () => {
    const props = renderComposer(false);
    const textarea = screen.getByPlaceholderText("输入消息…");
    fireEvent.change(textarea, { target: { value: "换行" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(props.onPrompt).not.toHaveBeenCalled();
  });

  it("does not submit while IME composition is active", () => {
    const props = renderComposer(false);
    const textarea = screen.getByPlaceholderText("输入消息…");
    fireEvent.change(textarea, { target: { value: "nihao" } });
    fireEvent.keyDown(textarea, {
      key: "Enter",
      isComposing: true,
      keyCode: 229,
    });
    expect(props.onPrompt).not.toHaveBeenCalled();
  });

  it("routes Enter to onSteer while streaming", () => {
    const props = renderComposer(true);
    const textarea = screen.getByPlaceholderText(
      "Agent 运行中：可以 Steer 或 FollowUp…",
    );
    fireEvent.change(textarea, { target: { value: "纠正一下" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(props.onSteer).toHaveBeenCalledWith("纠正一下");
    expect(props.onPrompt).not.toHaveBeenCalled();
  });
});
