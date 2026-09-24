import { Button, Input, Tooltip } from "antd";
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
    <div className="border-t border-stone-200 p-3">
      <div className="mx-auto max-w-3xl">
        <Input.TextArea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={
            isStreaming
              ? "Agent 运行中：可以插话（Steer）或排队（FollowUp）…"
              : "输入消息…"
          }
          autoSize={{ minRows: 2, maxRows: 6 }}
          aria-label={
            isStreaming ? "插话（Steer）或排队（FollowUp）消息" : "输入消息"
          }
          onPressEnter={(event) => {
            const native = event.nativeEvent as KeyboardEvent;
            if (native.isComposing || native.keyCode === 229) return;
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
              <Tooltip title="立即打断当前输出，把这条消息插入正在运行的回合">
                <Button disabled={!ready} onClick={() => submit(onSteer)}>
                  插话 · Steer
                </Button>
              </Tooltip>
              <Tooltip title="不打断当前回合，排队等本轮结束后再发送">
                <Button
                  type="primary"
                  disabled={!ready}
                  onClick={() => submit(onFollowUp)}
                >
                  排队 · FollowUp
                </Button>
              </Tooltip>
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
    </div>
  );
}
