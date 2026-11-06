import { useState } from "react";
import { ArrowRight, ChevronRight, Mail } from "lucide-react";
import type { ChatItem } from "@shared/protocol";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AssistantText } from "@/components/MessageBubble";
import { cn } from "@/lib/utils";

type MessageItem = Extract<ChatItem, { kind: "message" }>;

/** A message between agents (or user -> agent). Idle reports are muted and collapsed. */
export function MessageCard({ item, viewer }: { item: MessageItem; viewer: string }) {
  const [open, setOpen] = useState(false);
  const incoming = item.to === viewer || item.to === "all";
  const label = (
    <span className="flex min-w-0 items-center gap-1 text-xs">
      <Mail className="size-3 shrink-0" />
      <span className="font-medium">{item.from}</span>
      <ArrowRight className="size-3 shrink-0" />
      <span className="font-medium">{item.to === "all" ? "all (broadcast)" : item.to}</span>
      {item.idle && <span className="text-muted-foreground">(idle report)</span>}
    </span>
  );

  if (item.idle) {
    return (
      <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border border-dashed px-2 py-1 text-muted-foreground">
        <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1 text-left hover:text-foreground">
          <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
          {label}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 max-h-60 overflow-y-auto border-t pt-1 text-xs">
            <AssistantText text={item.text} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <div className={cn("rounded-md border px-2 py-1.5", incoming ? "border-primary/50" : "")}>
      <div className="mb-1 text-muted-foreground">{label}</div>
      <div className="whitespace-pre-wrap break-words text-xs">{item.text}</div>
    </div>
  );
}
