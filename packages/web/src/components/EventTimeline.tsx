import { Tag } from "antd";
import type { StoredEvent } from "../state/client";

const eventColors: Record<string, string> = {
  agent_start: "green",
  agent_end: "green",
  turn_start: "blue",
  turn_end: "blue",
  message_start: "default",
  message_update: "default",
  message_end: "default",
  tool_execution_start: "purple",
  tool_execution_update: "purple",
  tool_execution_end: "purple",
};

export function EventTimeline({ events }: { events: StoredEvent[] }) {
  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto py-2">
      {[...events].reverse().map((stored) => (
        <details
          key={stored.seq}
          className="rounded border border-gray-200 px-2 py-1 text-xs"
        >
          <summary className="flex cursor-pointer items-center gap-2">
            <span aria-hidden="true" className="disclosure-marker">
              ▸
            </span>
            <Tag
              color={eventColors[stored.event.type] ?? "default"}
              className="m-0"
            >
              {stored.event.type}
            </Tag>
            <span className="text-gray-400">
              {new Date(stored.receivedAt).toLocaleTimeString()}
            </span>
          </summary>
          <pre className="mt-1 overflow-x-auto">
            {JSON.stringify(stored.event, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}
