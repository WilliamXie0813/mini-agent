import { Badge, Button, Popconfirm, Tooltip } from "antd";

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
    <div className="flex w-56 shrink-0 flex-col gap-3 border-r border-stone-200 p-3">
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
      <Tooltip title="每向模型发起一轮请求计为一个 turn">
        <span className="text-xs text-stone-500">
          对话轮次（turn）：{turnCount}
        </span>
      </Tooltip>
      <Popconfirm
        title="重置会话？"
        description="将清空全部对话与事件记录，不可撤销。"
        okText="重置"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onConfirm={onReset}
      >
        <Button size="small" danger>
          重置会话
        </Button>
      </Popconfirm>
    </div>
  );
}
