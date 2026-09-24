import type { AgentMessage } from "@mini-agent/core";
import { ToolCallCard } from "./ToolCallCard";

interface MessageItemProps {
  message: AgentMessage;
  streaming?: boolean;
  pendingToolCalls: string[];
}

export function MessageItem({
  message,
  streaming = false,
  pendingToolCalls,
}: MessageItemProps) {
  switch (message.role) {
    case "system":
      return null;
    case "user":
      return (
        <div className="my-2 flex justify-end">
          <div className="max-w-[70%] rounded-lg bg-blue-500 px-3 py-2 text-sm text-white">
            {message.content}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="my-2 flex justify-start">
          <div className="max-w-[70%] rounded-lg bg-gray-100 px-3 py-2 text-sm">
            {message.content.map((part, index) =>
              part.type === "text" ? (
                <p key={index} className="whitespace-pre-wrap">
                  {part.text}
                  {streaming && index === message.content.length - 1
                    ? "▍"
                    : ""}
                </p>
              ) : (
                <ToolCallCard
                  key={part.id}
                  toolCall={part}
                  pending={pendingToolCalls.includes(part.id)}
                />
              ),
            )}
            {message.errorMessage ? (
              <p className="mt-1 text-xs text-red-500">
                {message.stopReason}: {message.errorMessage}
              </p>
            ) : null}
          </div>
        </div>
      );
    case "toolResult":
      return (
        <div className="my-1 flex justify-start">
          <details
            className={`max-w-[70%] rounded border px-3 py-1 text-xs ${
              message.isError
                ? "border-red-300 bg-red-50"
                : "border-gray-200 bg-gray-50"
            }`}
          >
            <summary className="cursor-pointer">
              工具结果 · {message.toolName}
              {message.isError ? "（错误）" : ""}
            </summary>
            <pre className="mt-1 overflow-x-auto">{message.content}</pre>
          </details>
        </div>
      );
  }
}
