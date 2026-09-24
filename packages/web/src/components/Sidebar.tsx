import { Badge, Button } from "antd";

interface SidebarProps {
  connected: boolean;
  isStreaming: boolean;
  turnCount: number;
  onReset(): void;
}

export function Sidebar({
  connected,
  isStreaming,
  turnCount,
  onReset,
}: SidebarProps) {
  return (
    <div className="flex w-56 shrink-0 flex-col gap-3 border-r border-gray-200 p-3">
      <div className="text-sm font-medium">Mini Agent</div>
      <div className="text-xs">
        <Badge
          status={connected ? "success" : "error"}
          text={connected ? "已连接" : "未连接"}
        />
      </div>
      <div className="text-xs">
        <Badge
          status={isStreaming ? "processing" : "default"}
          text={isStreaming ? "运行中" : "空闲"}
        />
      </div>
      <div className="text-xs text-gray-500">
        turn_start 事件数：{turnCount}
      </div>
      <Button size="small" onClick={onReset}>
        重置会话
      </Button>
    </div>
  );
}
