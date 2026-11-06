import { ArrowRight, Bot } from "lucide-react";
import type { ChatItem } from "@shared/protocol";
import { Md } from "@/components/MessageBubble";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageAvatar, MessageContent, MessageGroup, MessageHeader } from "@/components/ui/message";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

export type AgentMessageItem = Extract<ChatItem, { kind: "message" }>;

export function initials(name: string): string {
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return s.toUpperCase();
}

export function Avatar({ name }: { name: string }) {
  return (
    <MessageAvatar className="size-8 text-[11px] font-semibold text-muted-foreground" title={name} aria-label={name}>
      {initials(name)}
    </MessageAvatar>
  );
}

function IdleReport({ item }: { item: AgentMessageItem }) {
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <Bot />
            </TraceIcon>
            <TraceTitle>{item.from} finished a turn</TraceTitle>
            <TraceDescription>idle report</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div className="max-h-60 overflow-y-auto text-xs">
            <Md text={item.text} />
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

/**
 * Consecutive messages from one sender, shown as Messages from that sender (avatar, "name -> to" header, tinted Bubble).
 * Text is plain text, never HTML. Idle reports are collapsed Subagent-style Trace lines.
 */
export function AgentMessageGroup({ items, viewer }: { items: AgentMessageItem[]; viewer: string }) {
  const from = items[0].from;
  const mine = from === viewer;
  return (
    <Message>
      {!mine && <Avatar name={from} />}
      <MessageContent>
        <MessageGroup>
          {items.map((item) => {
            const to = item.to === "all" ? "all (broadcast)" : item.to;
            return (
              <div key={item.id} className="flex min-w-0 flex-col gap-1">
                <MessageHeader className="gap-1 px-0">
                  <span className="text-foreground">{from}</span>
                  <ArrowRight className="size-3" />
                  <span>{to}</span>
                </MessageHeader>
                {item.idle ? (
                  <IdleReport item={item} />
                ) : (
                  <Bubble variant={mine ? "outline" : "tinted"}>
                    <BubbleContent className="whitespace-pre-wrap text-xs">{item.text}</BubbleContent>
                  </Bubble>
                )}
              </div>
            );
          })}
        </MessageGroup>
      </MessageContent>
    </Message>
  );
}
