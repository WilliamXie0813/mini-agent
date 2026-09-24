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
    <div className="flex w-96 shrink-0 flex-col border-l border-stone-200">
      <Tabs
        className="inspector-tabs flex-1 min-h-0 px-3"
        defaultActiveKey={defaultActiveKey}
        items={[
          {
            key: "events",
            label: `事件流 (${events.length})`,
            children: (
              <EventTimeline
                events={events}
                hasHistory={state.messages.length > 0}
              />
            ),
          },
          {
            key: "messages",
            label: `消息历史 (${state.messages.filter((m) => m.role !== "system").length})`,
            children: (
              <pre className="h-full overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(state.messages, null, 2)}
              </pre>
            ),
          },
          {
            key: "queues",
            label: "队列与状态",
            children: (
              <div className="h-full overflow-y-auto text-xs">
                <h4 className="mt-2 font-medium">steering 队列</h4>
                <pre>{JSON.stringify(state.queues.steering, null, 2)}</pre>
                <h4 className="mt-2 font-medium">followUp 队列</h4>
                <pre>{JSON.stringify(state.queues.followUp, null, 2)}</pre>
                <h4 className="mt-2 font-medium">pendingToolCalls</h4>
                {state.pendingToolCalls.length === 0 ? (
                  <p className="text-stone-400">无</p>
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
