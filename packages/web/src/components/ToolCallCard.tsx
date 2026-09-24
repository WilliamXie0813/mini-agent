import { Tag } from "antd";
import type { ToolCall } from "@mini-agent/core";

export function ToolCallCard({
  toolCall,
  pending,
}: {
  toolCall: ToolCall;
  pending: boolean;
}) {
  return (
    <div className="my-1 rounded border border-purple-200 bg-purple-50 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span>🔧</span>
        <span className="font-mono">{toolCall.name}</span>
        {pending ? (
          <Tag color="processing">执行中</Tag>
        ) : (
          <Tag color="success">完成</Tag>
        )}
      </div>
      <pre className="mt-1 overflow-x-auto text-xs text-gray-600">
        {JSON.stringify(toolCall.arguments, null, 2)}
      </pre>
    </div>
  );
}
