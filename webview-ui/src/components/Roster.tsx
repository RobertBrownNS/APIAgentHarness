import { useState } from "react";
import { modelLabel } from "@/components/ModelEffortSelects";
import { MoreHorizontal, Play, Square, Trash2 } from "lucide-react";
import type { AgentInfo } from "@shared/protocol";
import { post } from "@/vscode";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StatusDot } from "@/components/StatusDot";
import { ConfirmRemove } from "@/components/ConfirmRemove";
import { AddTeammateDialog } from "@/components/AddTeammateDialog";
import { cn } from "@/lib/utils";

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

function AgentMenu({ agent }: { agent: AgentInfo }) {
  const [confirming, setConfirming] = useState(false);
  const busy = agent.status === "running" || agent.status === "awaiting";
  if (agent.status === "stopped") return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="cursor-pointer rounded-sm p-0.5 text-muted-foreground opacity-70 hover:bg-accent hover:opacity-100 focus-visible:opacity-100"
        aria-label={`Actions for ${agent.name}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <MoreHorizontal className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem disabled={!busy} onSelect={() => post({ type: "stop", agent: agent.name })}>
          <Square /> Stop turn
        </DropdownMenuItem>
        {agent.status === "paused" && (
          <DropdownMenuItem onSelect={() => post({ type: "resume", agent: agent.name })}>
            <Play /> Resume
          </DropdownMenuItem>
        )}
        {!agent.isLead && (
          <DropdownMenuItem onSelect={() => setConfirming(true)}>
            <Trash2 /> Remove teammate
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
      <ConfirmRemove open={confirming} onOpenChange={setConfirming} name={agent.name} />
    </DropdownMenu>
  );
}

export function Roster({
  agents,
  selected,
  unread,
  teammateCount,
  maxTeammates,
  defaultModel,
  localModels,
  onSelect,
}: {
  agents: AgentInfo[];
  selected: string;
  unread: Record<string, number>;
  teammateCount: number;
  maxTeammates: number;
  defaultModel: string;
  localModels?: readonly string[];
  onSelect: (name: string) => void;
}) {
  const full = maxTeammates > 0 && teammateCount >= maxTeammates;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-0.5 p-1.5" role="listbox" aria-label="Agents">
          {agents.map((a) => {
            const n = unread[a.name] ?? 0;
            const active = a.name === selected;
            return (
              <li
                key={a.name}
                role="option"
                aria-selected={active}
                tabIndex={0}
                onClick={() => onSelect(a.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(a.name);
                  }
                }}
                className={cn(
                  "cursor-pointer rounded-md border border-transparent px-2 py-1.5 outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring",
                  active && "border-ring/60 bg-accent",
                  a.status === "stopped" && "opacity-60",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <StatusDot status={a.status} />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold">{a.name}</span>
                  {n > 0 && (
                    <Badge variant={a.status === "awaiting" ? "warning" : "default"} aria-label={`${n} unread`}>
                      {n > 99 ? "99+" : n}
                    </Badge>
                  )}
                  <AgentMenu agent={a} />
                </div>
                {(a.status === "paused" || a.pendingMail > 0) && (
                  <div className="flex flex-wrap gap-1 pl-4 pt-0.5">
                    {a.status === "paused" && <Badge variant="warning">{a.pausedReason === "budget" ? "Paused: budget used up" : "Paused by you"}</Badge>}
                    {a.pendingMail > 0 && <Badge title="Messages queued for this agent">{a.pendingMail} mail</Badge>}
                  </div>
                )}
                {a.role && (
                  <div className="truncate pl-4 text-[11px] text-muted-foreground" title={a.role}>
                    {a.role}
                  </div>
                )}
                <div className="flex items-center gap-1 pl-4 text-[10px] text-muted-foreground">
                  <span className="min-w-0 truncate" title={a.model}>
                    {modelLabel(a.model)}
                  </span>
                  <span className="shrink-0" title="input / output tokens">· {fmtTokens(a.inputTokens)} in / {fmtTokens(a.outputTokens)} out</span>
                </div>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
      <div className="shrink-0 border-t p-1.5">
        <AddTeammateDialog
          existing={agents.map((a) => a.name)}
          disabled={full}
          disabledReason={full ? `Team is full (${maxTeammates} teammates)` : undefined}
          defaultModel={defaultModel}
          localModels={localModels}
        />
      </div>
    </div>
  );
}
