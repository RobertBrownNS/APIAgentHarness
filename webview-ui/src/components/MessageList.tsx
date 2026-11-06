import { memo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { ChatItem } from "@shared/protocol";
import { ScrollArea } from "@/components/ui/scroll-area";
import { UserBubble, AssistantText } from "@/components/MessageBubble";
import { ThinkingBlock } from "@/components/ThinkingBlock";
import { ToolCallCard } from "@/components/ToolCallCard";
import { Notice } from "@/components/Notice";
import { MessageCard } from "@/components/MessageCard";
import { post } from "@/vscode";

const EXAMPLES = [
  "Explain the structure of this project",
  "Find where errors are handled and summarize it",
  "Run the tests and fix any failures",
];

const MUser = memo(UserBubble);
const MText = memo(AssistantText);
const MThinking = memo(ThinkingBlock);
const MTool = memo(ToolCallCard);
const MNotice = memo(Notice);
const MMessage = memo(MessageCard);

function Empty({ agent, isLead, disabled }: { agent: string; isLead: boolean; disabled: boolean }) {
  return (
    <div className="flex flex-col gap-2 px-3 py-6 text-center">
      <div className="text-sm font-medium">{isLead ? "Agent Harness" : agent}</div>
      <div className="text-xs text-muted-foreground">
        {isLead
          ? "Ask the lead to read, search or change your workspace. It can spawn teammates for parallel work. Edits and commands ask for approval first."
          : "This teammate has no messages yet. Send it one below."}
      </div>
      {isLead && !disabled && (
      <div className="mt-2 flex flex-col gap-1.5">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => post({ type: "send", agent, text: ex })}
            className="cursor-pointer rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent"
          >
            {ex}
          </button>
        ))}
      </div>
      )}
    </div>
  );
}

function MessageListImpl({
  items,
  busy,
  agent,
  isLead,
  disabled,
}: {
  items: ChatItem[];
  busy: boolean;
  agent: string;
  isLead: boolean;
  disabled: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const onScroll = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  // Follow the bottom after every update unless the user scrolled up.
  useLayoutEffect(() => {
    const el = viewport.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  // Content can also grow without a React update (e.g. a card expanding).
  useEffect(() => {
    const el = viewport.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [items.length === 0]);

  const last = items[items.length - 1];

  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={viewport} onViewportScroll={onScroll}>
      {items.length === 0 ? (
        <Empty agent={agent} isLead={isLead} disabled={disabled} />
      ) : (
        <div className="flex min-w-0 flex-col gap-2.5 p-2.5">
          {items.map((it) => {
            switch (it.kind) {
              case "user":
                return <MUser key={it.id} text={it.text} />;
              case "text":
                return <MText key={it.id} text={it.text} />;
              case "thinking":
                return <MThinking key={it.id} text={it.text} streaming={busy && it === last} />;
              case "tool":
                return <MTool key={it.id} item={it} />;
              case "notice":
                return <MNotice key={it.id} level={it.level} text={it.text} />;
              case "message":
                return <MMessage key={it.id} item={it} viewer={agent} />;
            }
          })}
        </div>
      )}
    </ScrollArea>
  );
}

export const MessageList = memo(MessageListImpl);
