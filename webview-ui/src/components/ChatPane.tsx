import { memo } from "react";
import { Play, Square } from "lucide-react";
import type { AgentInfo, ChatItem } from "@shared/protocol";
import { post } from "@/vscode";
import { Button } from "@/components/ui/button";
import { StatusDot, statusLabel } from "@/components/StatusDot";
import { EffortSelect, ModelSelect } from "@/components/ModelEffortSelects";
import { MessageList } from "@/components/MessageList";
import { Composer } from "@/components/Composer";

function ChatPaneImpl({ agent, items }: { agent: AgentInfo; items: ChatItem[] }) {
  const stopped = agent.status === "stopped";
  const busy = agent.status === "running" || agent.status === "awaiting";
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
        <StatusDot status={agent.status} />
        <span className="text-xs font-semibold">{agent.name}</span>
        <span className="text-xs text-muted-foreground">
          {agent.status === "paused"
            ? agent.pausedReason === "budget"
              ? "paused: team budget used up (your next message refills it)"
              : "paused: stopped by you"
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
          <ModelSelect
            className="w-40"
            value={agent.model}
            disabled={stopped}
            onChange={(model) => post({ type: "setAgentModel", agent: agent.name, model })}
          />
          <EffortSelect
            className="w-20"
            value={agent.effort}
            disabled={stopped}
            onChange={(effort) => post({ type: "setAgentEffort", agent: agent.name, effort })}
          />
        </div>
      </div>
      <MessageList items={items} busy={agent.status === "running"} agent={agent.name} isLead={agent.isLead} disabled={stopped} />
      <Composer key={agent.name} agent={agent.name} busy={busy} disabled={stopped} paused={agent.status === "paused"} />
    </div>
  );
}

/** Skips re-render unless this agent or its transcript changed. */
export const ChatPane = memo(ChatPaneImpl);
