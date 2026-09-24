import { Button, Input } from "antd";
import { useState } from "react";

interface ComposerProps {
  isStreaming: boolean;
  onPrompt(content: string): void;
  onSteer(content: string): void;
  onFollowUp(content: string): void;
  onAbort(): void;
}

export function Composer({
  isStreaming,
  onPrompt,
  onSteer,
  onFollowUp,
  onAbort,
}: ComposerProps) {
  const [content, setContent] = useState("");
  const ready = content.trim().length > 0;

  const submit = (action: (text: string) => void) => {
    if (!ready) return;
    action(content.trim());
    setContent("");
  };

  return (
    <div className="border-t border-gray-200 p-3">
      <Input.TextArea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder={
          isStreaming
            ? "Agent 运行中：可以 steer 或 followUp…"
            : "输入消息…"
        }
        autoSize={{ minRows: 2, maxRows: 6 }}
        onPressEnter={(event) => {
          if (event.shiftKey || !ready) return;
          event.preventDefault();
          submit(isStreaming ? onSteer : onPrompt);
        }}
      />
      <div className="mt-2 flex justify-end gap-2">
        {isStreaming ? (
          <>
            <Button danger onClick={onAbort}>
              中止
            </Button>
            <Button disabled={!ready} onClick={() => submit(onSteer)}>
              Steer
            </Button>
            <Button
              type="primary"
              disabled={!ready}
              onClick={() => submit(onFollowUp)}
            >
              FollowUp
            </Button>
          </>
        ) : (
          <Button
            type="primary"
            disabled={!ready}
            onClick={() => submit(onPrompt)}
          >
            发送
          </Button>
        )}
      </div>
    </div>
  );
}
