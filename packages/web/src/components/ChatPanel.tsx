import { useEffect, useRef } from "react";
import type { SerializableAgentState } from "@mini-agent/server";
import { MessageItem } from "./MessageItem";

/** Distance from the bottom (px) within which the view still counts as pinned. */
const PIN_THRESHOLD = 48;

const EXAMPLE_PROMPTS = [
  "读取 package.json，告诉我项目名称",
  "你好，介绍一下你自己",
];

interface ChatPanelProps {
  state: SerializableAgentState;
  /** 点击空状态示例 prompt 时触发（用作首条消息）。 */
  onExample?(content: string): void;
}

export function ChatPanel({ state, onExample }: ChatPanelProps) {
  const visible = state.messages.filter(
    (message) => message.role !== "system",
  );

  // 流式输出时自动跟随到底部；用户主动上翻（离开底部）后暂停跟随，
  // 回到底部附近时恢复。pinned 用 ref 而不是 state：滚动监听高频触发，
  // 且这个值只影响行为不影响渲染。
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.messages, state.streamingMessage]);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      role="log"
      aria-live="polite"
      aria-label="对话消息"
      className="flex-1 overflow-y-auto px-4 py-3"
    >
      <div className="mx-auto min-h-full max-w-3xl">
        {visible.length === 0 && !state.streamingMessage ? (
          <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-sm bg-brand-700"
            />
            <div>
              <p className="text-base font-medium text-stone-800">
                一个会调用工具的教学 Agent
              </p>
              <p className="mt-1 text-sm text-stone-500">
                发消息即可开始；打开检查器能看到 agent 每一步的内部事件。
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-sm text-brand-700 hover:bg-brand-100"
                  onClick={() => onExample?.(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {visible.map((message) => (
              <MessageItem
                key={message.timestamp}
                message={message}
                pendingToolCalls={state.pendingToolCalls}
              />
            ))}
            {state.streamingMessage ? (
              <MessageItem
                message={state.streamingMessage}
                streaming
                pendingToolCalls={state.pendingToolCalls}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
