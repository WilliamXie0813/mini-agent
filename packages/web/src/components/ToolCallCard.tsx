import { Tag } from "antd";
import type { ToolCall } from "@mini-agent/core";

function WrenchIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 fill-teal-700"
    >
      <path d="M10.7 1.6a3.4 3.4 0 0 0-4.3 4.3L1.7 10.6a1.8 1.8 0 1 0 2.5 2.5l4.7-4.7a3.4 3.4 0 0 0 4.3-4.3L10.6 6.7 9.3 5.4l1.4-3.8Z" />
    </svg>
  );
}

export function ToolCallCard({
  toolCall,
  pending,
}: {
  toolCall: ToolCall;
  pending: boolean;
}) {
  return (
    <div className="my-1 rounded border border-teal-200 bg-teal-50 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <WrenchIcon />
        <span className="font-mono">{toolCall.name}</span>
        {pending ? (
          <Tag color="processing">执行中</Tag>
        ) : (
          <Tag color="success">完成</Tag>
        )}
      </div>
      <pre className="mt-1 overflow-x-auto text-xs text-stone-600">
        {JSON.stringify(toolCall.arguments, null, 2)}
      </pre>
    </div>
  );
}
