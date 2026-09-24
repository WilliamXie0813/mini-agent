import { Tabs, Tag } from "antd";
import type { SerializableAgentState } from "@mini-agent/server";
import type { StoredEvent } from "../state/client";
import { EventTimeline } from "./EventTimeline";

interface InspectorPanelProps {
  state: SerializableAgentState;
  events: StoredEvent[];
  defaultActiveKey?: string;
}

export function InspectorPanel({
  state,
  events,
  defaultActiveKey = "events",
}: InspectorPanelProps) {
  return (
    <div className="flex w-96 shrink-0 flex-col border-l border-gray-200">
      <Tabs
        className="flex-1 px-3"
        defaultActiveKey={defaultActiveKey}
        items={[
          {
            key: "events",
            label: `事件流 (${events.length})`,
            children: <EventTimeline events={events} />,
          },
          {
            key: "messages",
            label: "消息历史",
            children: (
              <pre className="overflow-auto text-xs">
                {JSON.stringify(state.messages, null, 2)}
              </pre>
            ),
          },
          {
            key: "queues",
            label: "队列与状态",
            children: (
              <div className="text-xs">
                <h4 className="mt-2 font-medium">steering 队列</h4>
                <pre>{JSON.stringify(state.queues.steering, null, 2)}</pre>
                <h4 className="mt-2 font-medium">followUp 队列</h4>
                <pre>{JSON.stringify(state.queues.followUp, null, 2)}</pre>
                <h4 className="mt-2 font-medium">pendingToolCalls</h4>
                {state.pendingToolCalls.length === 0 ? (
                  <p className="text-gray-400">无</p>
                ) : (
                  state.pendingToolCalls.map((id) => <Tag key={id}>{id}</Tag>)
                )}
                <h4 className="mt-2 font-medium">errorMessage</h4>
                <p>{state.errorMessage ?? "无"}</p>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
