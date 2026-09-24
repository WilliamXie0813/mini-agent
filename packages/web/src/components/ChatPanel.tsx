import { Empty } from "antd";
import type { SerializableAgentState } from "@mini-agent/server";
import { MessageItem } from "./MessageItem";

export function ChatPanel({ state }: { state: SerializableAgentState }) {
  const visible = state.messages.filter(
    (message) => message.role !== "system",
  );

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="对话消息"
      className="flex-1 overflow-y-auto px-4 py-3"
    >
      {visible.length === 0 && !state.streamingMessage ? (
        <Empty description="发送消息开始对话" />
      ) : (
        <>
          {visible.map((message, index) => (
            <MessageItem
              key={index}
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
  );
}
