import { Button, ConfigProvider, notification } from "antd";
import { useEffect, useRef, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { Composer } from "./components/Composer";
import { InspectorPanel } from "./components/InspectorPanel";
import { Sidebar } from "./components/Sidebar";
import { useAgentClient } from "./hooks/useAgentClient";

export default function App() {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const { state, events, connected, lastError, resetCount, send } =
    useAgentClient();

  useEffect(() => {
    if (lastError) {
      notification.error({
        // Same-error repeats replace instead of stacking.
        key: `server-error:${lastError}`,
        message: "服务端错误",
        description: `${lastError}。若问题持续，可尝试重置会话或刷新页面。`,
      });
    }
  }, [lastError]);

  // 只在"曾经连上过然后断开"时提醒，避免首屏未连接就误报。
  // 断开与重连共用同一个 notification key，抖动时互相替换而不是叠加。
  const wasConnected = useRef(false);
  const disconnectNotified = useRef(false);

  useEffect(() => {
    if (connected) {
      if (disconnectNotified.current) {
        notification.success({
          key: "ws-status",
          message: "已重新连接",
          duration: 3,
        });
        disconnectNotified.current = false;
      }
      wasConnected.current = true;
      return;
    }
    if (wasConnected.current) {
      notification.warning({
        key: "ws-status",
        message: "连接已断开",
        description: "正在尝试自动重连…",
        duration: 0,
      });
      disconnectNotified.current = true;
    }
  }, [connected]);

  // 服务端确认重置后才反馈，所有连接中的客户端都会收到
  const seenResetCount = useRef(resetCount);

  useEffect(() => {
    if (resetCount === seenResetCount.current) return;
    seenResetCount.current = resetCount;
    notification.success({
      message: "会话已重置",
      description: "对话与事件记录已清空，状态机归零。",
    });
  }, [resetCount]);

  const turnCount = events.filter(
    (stored) => stored.event.type === "turn_start",
  ).length;

  return (
    <ConfigProvider
      button={{ autoInsertSpace: false }}
      theme={{
        token: {
          colorPrimary: "#C2410C",
          colorText: "#1C1917",
          borderRadius: 8,
        },
      }}
    >
      <div className="flex h-screen">
        <Sidebar
          connected={connected}
          isStreaming={state.isStreaming}
          turnCount={turnCount}
          onReset={() => send({ type: "reset" })}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-stone-200 px-4 py-2">
            <h1 className="flex items-center gap-2 text-base font-medium">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-sm bg-brand-700"
              />
              Mini Agent
            </h1>
            <Button size="small" onClick={() => setInspectorOpen((v) => !v)}>
              {inspectorOpen ? "隐藏检查器" : "显示检查器"}
            </Button>
          </header>
          <ChatPanel
            state={state}
            onExample={(content) => send({ type: "prompt", content })}
          />
          <Composer
            isStreaming={state.isStreaming}
            onPrompt={(content) => send({ type: "prompt", content })}
            onSteer={(content) => send({ type: "steer", content })}
            onFollowUp={(content) => send({ type: "followUp", content })}
            onAbort={() => send({ type: "abort" })}
          />
        </div>
        {inspectorOpen ? (
          <InspectorPanel state={state} events={events} />
        ) : null}
      </div>
    </ConfigProvider>
  );
}
