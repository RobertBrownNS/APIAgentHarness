import { useState } from "react";
import { KeyRound, MoreHorizontal, OctagonX, RotateCcw, UserPlus } from "lucide-react";
import type { SessionConfig } from "@shared/protocol";
import { post } from "@/vscode";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AddTeammateDialog } from "@/components/AddTeammateDialog";
import { MODE_LABEL } from "@/components/ModeMarker";
import { cn } from "@/lib/utils";

function fmt(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

export function Header({
  config,
  anyBusy,
  totalTokens,
  approvals,
  solo,
  agentNames,
  teamFull,
}: {
  config: SessionConfig;
  anyBusy: boolean;
  totalTokens: number;
  approvals: number;
  solo: boolean;
  agentNames: string[];
  teamFull: boolean;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="shrink-0 border-b bg-sidebar px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate text-xs font-semibold" title={config.workspaceName}>
          NextAgent{config.workspaceName ? ` · ${config.workspaceName}` : ""}
        </span>
        <Badge variant={config.mode === "ultra" ? "destructive" : config.mode === "auto" ? "warning" : "outline"} title="Team-wide mode">
          {MODE_LABEL[config.mode]} mode
        </Badge>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {approvals > 0 && <Badge variant="warning">{approvals} awaiting approval</Badge>}
          <span className="hidden text-[11px] text-muted-foreground sm:inline" title="Input + output tokens used by all agents">
            {fmt(totalTokens)} tok total
          </span>
          {/* Budgets are optional (0 = no limit, the default); show a meter only for limits the user turned on. */}
          {(config.maxAutoTurns > 0 || config.maxTeamOutputTokens > 0) && (
            <span
              className="hidden text-[11px] text-muted-foreground sm:inline"
              title="Limits you set in NextAgent settings. Agents pause when one runs out; both refill when you send a message."
            >
              {[
                config.maxAutoTurns > 0 ? `auto-turns ${config.autoTurnsLeft}/${config.maxAutoTurns}` : "",
                config.maxTeamOutputTokens > 0 ? `${fmt(config.teamOutputTokens)}/${fmt(config.maxTeamOutputTokens)} tok` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
          <Button variant="outline" size="sm" disabled={!anyBusy} onClick={() => post({ type: "stop" })} title="Stop every agent's current turn">
            <OctagonX /> Stop all
          </Button>
          <Button variant="secondary" size="sm" onClick={() => post({ type: "newTeam" })} title="Stop everything and start a fresh team">
            <RotateCcw /> New team
          </Button>
          {solo && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn("cursor-pointer rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground")}
                aria-label="More actions"
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem disabled={teamFull} onSelect={() => setAdding(true)}>
                  <UserPlus /> Add teammate…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {solo && (
        <AddTeammateDialog
          existing={agentNames}
          disabled={teamFull}
          defaultModel={config.teammateModel || config.model}
          localModels={config.localModels}
          open={adding}
          onOpenChange={setAdding}
          hideTrigger
        />
      )}
      {!config.hasCredentials && (
        <div className="mt-1.5 flex items-center justify-between gap-2 rounded-md border border-warning/60 px-2 py-1 text-xs">
          <span className="text-muted-foreground">No API key configured.</span>
          <Button size="sm" onClick={() => post({ type: "setApiKey" })}>
            <KeyRound /> Set API key
          </Button>
        </div>
      )}
    </div>
  );
}
