import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { ChatItem } from "@shared/protocol";
import { ScrollArea } from "@/components/ui/scroll-area";
import { UserBubble, AssistantText } from "@/components/MessageBubble";
import { ThinkingBlock } from "@/components/ThinkingBlock";
import { ToolCallCard } from "@/components/ToolCallCard";
import { Notice } from "@/components/Notice";
import { post } from "@/vscode";

const EXAMPLES = [
  "Explain the structure of this project",
  "Find where errors are handled and summarize it",
  "Run the tests and fix any failures",
];

function Empty() {
  return (
    <div className="flex flex-col gap-2 px-3 py-6 text-center">
      <div className="text-sm font-medium">Agent Harness</div>
      <div className="text-xs text-muted-foreground">
        Ask the agent to read, search or change your workspace. Edits and commands ask for approval first.
      </div>
      <div className="mt-2 flex flex-col gap-1.5">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => post({ type: "send", text: ex })}
            className="cursor-pointer rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

export function MessageList({ items, busy }: { items: ChatItem[]; busy: boolean }) {
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
        <Empty />
      ) : (
        <div className="flex min-w-0 flex-col gap-2.5 p-2.5">
          {items.map((it) => {
            switch (it.kind) {
              case "user":
                return <UserBubble key={it.id} text={it.text} />;
              case "text":
                return <AssistantText key={it.id} text={it.text} />;
              case "thinking":
                return <ThinkingBlock key={it.id} text={it.text} streaming={busy && it === last} />;
              case "tool":
                return <ToolCallCard key={it.id} item={it} />;
              case "notice":
                return <Notice key={it.id} level={it.level} text={it.text} />;
            }
          })}
        </div>
      )}
    </ScrollArea>
  );
}
