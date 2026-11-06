import { memo, useContext } from "react";
import type { ChatItem } from "@shared/protocol";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import { Md } from "@/components/MessageBubble";
import { ThinkingBlock } from "@/components/ThinkingBlock";
import { ToolTrace } from "@/components/ToolTrace";
import { Notice } from "@/components/Notice";
import { AgentMessageGroup, Avatar, type AgentMessageItem } from "@/components/MessageCard";
import { PlanCard } from "@/components/PlanCard";
import { ModeMarker } from "@/components/ModeMarker";
import { ApprovalsContext } from "@/lib/ui-context";
import { post } from "@/vscode";

type PlanItem = Extract<ChatItem, { kind: "plan" }>;
type ToolItem = Extract<ChatItem, { kind: "tool" }>;

const MThinking = memo(ThinkingBlock);
const MTool = memo(function MTool({ item }: { item: ToolItem }) {
  return <ToolTrace item={item} />;
});
const MNotice = memo(Notice);
const MMode = memo(ModeMarker);
const MText = memo(Md);
const MPlan = memo(function MPlan({ item }: { item: PlanItem }) {
  const { inline } = useContext(ApprovalsContext);
  return <PlanCard item={item} actions={inline} />;
});

const EXAMPLES = [
  "Explain the structure of this project",
  "Find where errors are handled and summarize it",
  "Run the tests and fix any failures",
];

function Empty({ agent, isLead, disabled }: { agent: string; isLead: boolean; disabled: boolean }) {
  return (
    <div className="flex flex-col gap-2 px-3 py-6 text-center">
      <div className="text-sm font-medium">{isLead ? "NextAgent" : agent}</div>
      <div className="text-xs text-muted-foreground">
        {isLead
          ? "Ask main to read, search or change your workspace. It can spawn teammates for parallel work. Edits and commands ask for approval first, unless the mode says otherwise."
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

/** One row of the thread. */
type Block =
  | { kind: "user"; id: string; text: string }
  | { kind: "turn"; id: string; items: ChatItem[] } // consecutive thinking / tool / text / plan from the viewed agent
  | { kind: "agents"; id: string; items: AgentMessageItem[] } // consecutive messages from one sender
  | { kind: "marker"; id: string; item: ChatItem };

function toBlocks(items: ChatItem[]): Block[] {
  const blocks: Block[] = [];
  for (const it of items) {
    const prev = blocks[blocks.length - 1];
    switch (it.kind) {
      case "user":
        blocks.push({ kind: "user", id: it.id, text: it.text });
        break;
      case "message":
        // The user's own messages to an agent look like any user turn.
        if (it.from === "user") blocks.push({ kind: "user", id: it.id, text: it.text });
        else if (prev?.kind === "agents" && prev.items[0].from === it.from) prev.items.push(it);
        else blocks.push({ kind: "agents", id: it.id, items: [it] });
        break;
      case "notice":
      case "mode":
        blocks.push({ kind: "marker", id: it.id, item: it });
        break;
      default:
        if (prev?.kind === "turn") prev.items.push(it);
        else blocks.push({ kind: "turn", id: it.id, items: [it] });
    }
  }
  return blocks;
}

function Turn({ items, agent, showWho, streamingId }: { items: ChatItem[]; agent: string; showWho: boolean; streamingId?: string }) {
  return (
    <Message>
      {showWho && <Avatar name={agent} />}
      <MessageContent className="gap-2">
        {showWho && (
          <MessageHeader className="px-0">
            <span className="text-foreground">{agent}</span>
          </MessageHeader>
        )}
        {items.map((it) => {
          switch (it.kind) {
            case "thinking":
              return <MThinking key={it.id} text={it.text} streaming={it.id === streamingId} />;
            case "tool":
              return <MTool key={it.id} item={it} />;
            case "text":
              return <MText key={it.id} text={it.text} />;
            case "plan":
              return <MPlan key={it.id} item={it} />;
            default:
              return null;
          }
        })}
      </MessageContent>
    </Message>
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
  const { inline } = useContext(ApprovalsContext);
  if (items.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Empty agent={agent} isLead={isLead} disabled={disabled} />
      </div>
    );
  }
  const streamingId = busy ? items[items.length - 1].id : undefined;
  const blocks = toBlocks(items);

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label={`${agent} conversation`}>
          <MessageScrollerContent className="gap-4 p-2.5">
            {blocks.map((b) => (
              <MessageScrollerItem key={b.id} messageId={b.id} scrollAnchor={b.kind === "user"}>
                {b.kind === "user" ? (
                  <Message align="end">
                    <MessageContent>
                      <Bubble align="end" variant="muted">
                        <BubbleContent className="whitespace-pre-wrap">{b.text}</BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                ) : b.kind === "turn" ? (
                  <Turn items={b.items} agent={agent} showWho={!inline} streamingId={streamingId} />
                ) : b.kind === "agents" ? (
                  <AgentMessageGroup items={b.items} viewer={agent} />
                ) : b.item.kind === "notice" ? (
                  <MNotice level={b.item.level} text={b.item.text} />
                ) : b.item.kind === "mode" ? (
                  <MMode mode={b.item.mode} by={b.item.by} />
                ) : null}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

export const MessageList = memo(MessageListImpl);
