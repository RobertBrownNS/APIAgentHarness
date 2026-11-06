import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SendHorizontal, Square } from "lucide-react";
import { loadDraft, post, saveDraft } from "@/vscode";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function Composer({ busy }: { busy: boolean }) {
  const [text, setText] = useState(loadDraft);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => saveDraft(text), [text]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 200)}px`;
  }, [text]);

  // The draft is only cleared when a message is actually sent.
  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    post({ type: "send", text: t });
    setText("");
  };

  return (
    <div className="shrink-0 border-t p-2">
      <div className="flex items-end gap-1.5">
        <Textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder="Ask the agent… (Enter to send, Shift+Enter for newline)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          className="min-h-7 flex-1"
        />
        {busy ? (
          <Button variant="destructive" size="icon" onClick={() => post({ type: "stop" })} title="Stop">
            <Square />
          </Button>
        ) : (
          <Button size="icon" onClick={send} disabled={!text.trim()} title="Send">
            <SendHorizontal />
          </Button>
        )}
      </div>
    </div>
  );
}
