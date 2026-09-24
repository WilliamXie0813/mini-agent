import { Button, ConfigProvider, notification } from "antd";
import { useEffect, useRef, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { Composer } from "./components/Composer";
import { InspectorPanel } from "./components/InspectorPanel";
import { Sidebar } from "./components/Sidebar";
import { useAgentClient } from "./hooks/useAgentClient";

export default function App() {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const { state, events, connected, lastError, send } = useAgentClient();

  useEffect(() => {
    if (lastError) {
      notification.error({ message: "服务端错误", description: lastError });
    }
  }, [lastError]);

  // 只在"曾经连上过然后断开"时提醒，避免首屏未连接就误报
  const wasConnected = useRef(false);

  useEffect(() => {
    if (connected) {
      wasConnected.current = true;
      return;
    }
    if (wasConnected.current) {
      notification.warning({
        message: "连接已断开",
        description: "正在尝试自动重连…",
      });
    }
  }, [connected]);

  const turnCount = events.filter(
    (stored) => stored.event.type === "turn_start",
  ).length;

  return (
    <ConfigProvider button={{ autoInsertSpace: false }}>
      <div className="flex h-screen">
        <Sidebar
          connected={connected}
          isStreaming={state.isStreaming}
          turnCount={turnCount}
          onReset={() => send({ type: "reset" })}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
            <h1 className="text-base font-medium">Mini Agent</h1>
            <Button size="small" onClick={() => setInspectorOpen((v) => !v)}>
              {inspectorOpen ? "隐藏检查器" : "显示检查器"}
            </Button>
          </header>
          <ChatPanel state={state} />
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
