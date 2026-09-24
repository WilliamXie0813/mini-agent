import { Tag } from "antd";
import { useEffect, useRef } from "react";
import type { StoredEvent } from "../state/client";

const eventColors: Record<string, string> = {
  agent_start: "green",
  agent_end: "green",
  turn_start: "blue",
  turn_end: "blue",
  message_start: "default",
  message_update: "default",
  message_end: "default",
  tool_execution_start: "cyan",
  tool_execution_update: "cyan",
  tool_execution_end: "cyan",
};

/** Distance from the bottom (px) within which the view still counts as pinned. */
const PIN_THRESHOLD = 48;

/** 毫秒级时间戳：流式事件同秒密集发生，秒级无法区分顺序。 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const base = date.toLocaleTimeString("zh-CN", { hour12: false });
  return `${base}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

interface TurnBlock {
  kind: "turn";
  index: number;
  events: StoredEvent[];
}

interface SingleBlock {
  kind: "single";
  stored: StoredEvent;
}

type Block = TurnBlock | SingleBlock;

/** 把扁平事件流按 turn_start → turn_end 折叠成轮次叙事块。 */
function groupBlocks(events: StoredEvent[]): Block[] {
  const blocks: Block[] = [];
  let current: TurnBlock | null = null;
  let turnIndex = 0;
  for (const stored of events) {
    if (stored.event.type === "turn_start") {
      turnIndex += 1;
      current = { kind: "turn", index: turnIndex, events: [stored] };
      blocks.push(current);
      continue;
    }
    if (current) {
      current.events.push(stored);
      if (stored.event.type === "turn_end") current = null;
      continue;
    }
    blocks.push({ kind: "single", stored });
  }
  return blocks;
}

interface Row {
  stored: StoredEvent;
  /** 连续的 message_update 逐字事件合并为一行，repeat 记录合并条数。 */
  repeat: number;
}

function mergeRows(events: StoredEvent[]): Row[] {
  const rows: Row[] = [];
  for (const stored of events) {
    const last = rows[rows.length - 1];
    if (
      stored.event.type === "message_update" &&
      last &&
      last.stored.event.type === "message_update"
    ) {
      last.repeat += 1;
      // 保留最新一条的 payload，展开详情时看到的是最终状态
      last.stored = stored;
    } else {
      rows.push({ stored, repeat: 1 });
    }
  }
  return rows;
}

function EventRow({ row }: { row: Row }) {
  const { stored, repeat } = row;
  return (
    <details className="rounded px-1 py-0.5">
      <summary className="flex cursor-pointer items-center gap-2">
        <span aria-hidden="true" className="disclosure-marker">
          ▸
        </span>
        <Tag
          color={eventColors[stored.event.type] ?? "default"}
          className="m-0"
        >
          {stored.event.type}
          {repeat > 1 ? ` ×${repeat}` : ""}
        </Tag>
        <span className="text-stone-400">{formatTime(stored.receivedAt)}</span>
      </summary>
      <pre className="mt-1 overflow-x-auto">
        {JSON.stringify(stored.event, null, 2)}
      </pre>
    </details>
  );
}

function TurnGroup({
  block,
  defaultOpen,
}: {
  block: TurnBlock;
  defaultOpen: boolean;
}) {
  const closed = block.events.some(
    (stored) => stored.event.type === "turn_end",
  );
  const durationMs =
    block.events[block.events.length - 1]!.receivedAt -
    block.events[0]!.receivedAt;

  return (
    <details
      open={defaultOpen}
      className="rounded border border-stone-200 text-xs"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1.5">
        <span aria-hidden="true" className="disclosure-marker">
          ▸
        </span>
        <span className="font-medium text-stone-700">轮次 {block.index}</span>
        <span className="text-stone-400">{block.events.length} 个事件</span>
        {!closed ? <Tag color="processing">进行中</Tag> : null}
        <span className="ml-auto text-stone-400">
          {(durationMs / 1000).toFixed(1)}s
        </span>
      </summary>
      <div className="flex flex-col gap-1 border-t border-stone-100 px-1 py-1">
        {mergeRows(block.events).map((row) => (
          <EventRow key={row.stored.seq} row={row} />
        ))}
      </div>
    </details>
  );
}

interface EventTimelineProps {
  events: StoredEvent[];
  /** 服务端有历史消息但本次连接尚未收到事件（如刷新后）时为 true。 */
  hasHistory?: boolean;
}

export function EventTimeline({ events, hasHistory }: EventTimelineProps) {
  const blocks = groupBlocks(events);
  // 最新轮次块默认展开。注意不能按展示序取第一个：agent_end 等独立
  // 事件排在轮次块之后，正序展示时最新轮次不在最顶/最底。
  const lastTurn = [...blocks]
    .reverse()
    .find((block): block is TurnBlock => block.kind === "turn");

  // 新事件钉底跟随（与聊天区行为一致）；用户上翻离开底部时暂停跟随。
  // hooks 必须在空态 early return 之前声明。
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
  }, [events]);

  if (events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-stone-400">
        {hasHistory
          ? "事件流仅记录本次连接期间的事件；此前的历史请看「消息历史」标签页。"
          : "还没有事件。发一条消息，这里会实时显示 agent 的每一步。"}
      </div>
    );
  }

  // 正序排列，从上往下讲故事
  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex h-full flex-col gap-1 overflow-y-auto py-2"
    >
      {blocks.map((block) =>
        block.kind === "turn" ? (
          <TurnGroup
            key={block.events[0]!.seq}
            block={block}
            defaultOpen={block === lastTurn}
          />
        ) : (
          <EventRow
            key={block.stored.seq}
            row={{ stored: block.stored, repeat: 1 }}
          />
        ),
      )}
    </div>
  );
}
