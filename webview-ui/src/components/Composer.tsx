import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SendHorizontal, Square } from "lucide-react";
import { loadDraft, post, saveDraft } from "@/vscode";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** Remount with key={agent} so each agent keeps its own draft. */
export function Composer({ agent, busy, disabled, paused = false }: { agent: string; busy: boolean; disabled: boolean; paused?: boolean }) {
  const [text, setText] = useState(() => loadDraft(agent));
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => saveDraft(agent, text), [agent, text]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 200)}px`;
  }, [text]);

  // The draft is only cleared when a message is actually sent.
  const send = () => {
    const t = text.trim();
    if (!t || disabled) return;
    post({ type: "send", agent, text: t });
    setText("");
  };

  return (
    <div className="shrink-0 border-t p-2">
      <div className="flex items-end gap-1.5">
        <Textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={
            disabled ? `${agent} was removed from the team` : paused ? `Message ${agent} (this will resume it)` : `Message ${agent}… (Enter to send, Shift+Enter for newline)`
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          className="min-h-7 flex-1"
        />
        {busy && (
          <Button variant="destructive" size="icon" onClick={() => post({ type: "stop", agent })} title={`Stop ${agent}`}>
            <Square />
          </Button>
        )}
        <Button size="icon" onClick={send} disabled={disabled || !text.trim()} title={busy ? "Queue message" : "Send"}>
          <SendHorizontal />
        </Button>
      </div>
      {busy && !disabled && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {agent} is busy: a message you send is queued and delivered when the current turn ends.
        </div>
      )}
    </div>
  );
}
