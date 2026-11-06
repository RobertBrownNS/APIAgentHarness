import { memo } from "react";
import { Play, Square } from "lucide-react";
import type { AgentInfo, ChatItem, SessionConfig } from "@shared/protocol";
import { post } from "@/vscode";
import { Button } from "@/components/ui/button";
import { StatusDot, statusLabel } from "@/components/StatusDot";
import { MessageList } from "@/components/MessageList";
import { Composer } from "@/components/Composer";

function ChatPaneImpl({ agent, items, config }: { agent: AgentInfo; items: ChatItem[]; config: SessionConfig }) {
  const stopped = agent.status === "stopped";
  const busy = agent.status === "running" || agent.status === "awaiting";
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
        <StatusDot status={agent.status} />
        <span className="text-xs font-semibold">{agent.name}</span>
        <span className="text-xs text-muted-foreground">
          {agent.status === "paused"
            ? agent.pausedReason === "budget"
              ? "Paused: budget used up (your next message refills it)"
              : "Paused by you"
            : statusLabel(agent.status)}
          {agent.pendingMail > 0 ? ` · ${agent.pendingMail} queued message${agent.pendingMail > 1 ? "s" : ""}` : ""}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {agent.status === "paused" && (
            <Button size="sm" variant="secondary" onClick={() => post({ type: "resume", agent: agent.name })}>
              <Play /> Resume
            </Button>
          )}
          {busy && (
            <Button size="sm" variant="outline" onClick={() => post({ type: "stop", agent: agent.name })}>
              <Square /> Stop turn
            </Button>
          )}
        </div>
      </div>
      <MessageList items={items} busy={agent.status === "running"} agent={agent.name} isLead={agent.isLead} disabled={stopped} />
      <Composer key={agent.name} agent={agent} config={config} />
    </div>
  );
}

/** Skips re-render unless this agent, its transcript or the config changed. */
export const ChatPane = memo(ChatPaneImpl);
