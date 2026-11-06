import { useEffect, useRef, useState } from "react";
import { SendHorizontal, Square } from "lucide-react";
import { MODES, type AgentInfo, type Mode, type SessionConfig } from "@shared/protocol";
import { loadDraft, post, saveDraft } from "@/vscode";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EffortSelect, ModelSelect } from "@/components/ModelEffortSelects";
import { MODE_LABEL } from "@/components/ModeMarker";
import { cn } from "@/lib/utils";

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function ModeSwitcher({ mode, onPickRisky }: { mode: Mode; onPickRisky: (m: "auto" | "ultra") => void }) {
  return (
    <Select
      value={mode}
      onValueChange={(m) => {
        // Auto and Ultra skip approvals: confirm before sending.
        if ((m === "auto" || m === "ultra") && m !== mode) onPickRisky(m);
        else post({ type: "setMode", mode: m as Mode });
      }}
    >
      <SelectTrigger
        className={cn("w-24", mode === "auto" && "border-warning/70 text-warning", mode === "ultra" && "border-destructive/70 text-destructive")}
        aria-label="Mode (applies to the whole team)"
        title="Mode for the whole team: Plan is read-only, Normal asks for edits and commands, Auto runs edits and safe commands, Ultra runs almost everything without asking"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MODES.map((m) => (
          <SelectItem key={m} value={m} className={m === "auto" ? "text-warning" : m === "ultra" ? "text-destructive" : undefined}>
            {MODE_LABEL[m]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** How full the agent's context window is, with in/out totals on hover. */
function ContextMeter({ agent, contextWindow }: { agent: AgentInfo; contextWindow: number }) {
  const pct = contextWindow > 0 ? Math.min(100, Math.round((agent.contextTokens / contextWindow) * 100)) : 0;
  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="flex cursor-default items-center gap-1.5 rounded-md px-1 text-[11px] text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={`Context ${pct}% full`}
        >
          <Progress value={pct} className="h-1.5 w-12" />
          {pct}%
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-56 space-y-1 text-xs" side="top">
        <div className="font-medium">Context window ({agent.name})</div>
        <Progress value={pct} className="h-1.5" />
        <div className="text-muted-foreground">
          {fmt(agent.contextTokens)} of {contextWindow > 0 ? fmt(contextWindow) : "?"} tokens
        </div>
        <div className="border-t pt-1 text-muted-foreground">
          Total used: {fmt(agent.inputTokens)} in / {fmt(agent.outputTokens)} out
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** Prompt input. Remount with key={agent} so each agent keeps its own draft. */
export function Composer({ agent, config }: { agent: AgentInfo; config: SessionConfig }) {
  const name = agent.name;
  const stopped = agent.status === "stopped";
  const paused = agent.status === "paused";
  const busy = agent.status === "running" || agent.status === "awaiting";
  const [text, setText] = useState(() => loadDraft(name));
  const ref = useRef<HTMLTextAreaElement>(null);
  const [confirm, setConfirm] = useState<"auto" | "ultra" | null>(null);

  useEffect(() => saveDraft(name, text), [name, text]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 200)}px`;
  }, [text]);

  // The draft is only cleared when a message is actually sent.
  const send = () => {
    const t = text.trim();
    if (!t || stopped) return;
    post({ type: "send", agent: name, text: t });
    setText("");
  };

  return (
    <div className="shrink-0 border-t p-2">
      {confirm && config.mode !== confirm && (
        <div
          className={cn(
            "mb-1.5 flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
            confirm === "ultra" ? "border-destructive/70" : "border-warning/60",
          )}
        >
          <span className={cn("min-w-0 flex-1", confirm === "ultra" ? "text-destructive" : "text-warning")}>
            {confirm === "ultra"
              ? "Ultra runs everything without asking and without a safety check, for the whole team. Only a small backstop still asks: deleting, moving or writing outside the project, force-push or deleting remote git history, destroying cloud or remote resources (terraform destroy, kubectl delete, gh repo delete…), disk and OS-level commands, and reading secret files. Not stopped: publishing packages, piping downloads into a shell, scripts the agent writes, and deletes or history rewrites inside the project. It is not a sandbox; do not use it on untrusted work."
              : "Auto runs edits without asking and commands unless a rule or check stops them. Tests and builds run project code, so use Normal for untrusted work."}
          </span>
          <Button
            size="sm"
            variant={confirm === "ultra" ? "destructive" : "default"}
            onClick={() => {
              post({ type: "setMode", mode: confirm });
              setConfirm(null);
            }}
          >
            Switch to {MODE_LABEL[confirm]}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        </div>
      )}
      <InputGroup>
        <InputGroupTextarea
          ref={ref}
          rows={1}
          value={text}
          disabled={stopped}
          placeholder={
            stopped
              ? `${name} was removed from the team`
              : paused
                ? `Message ${name} (this will resume it)`
                : `Message ${name}… (Enter to send, Shift+Enter for newline)`
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          className="min-h-7"
        />
        <InputGroupAddon align="block-end" className="flex-wrap gap-1.5">
          <ModeSwitcher mode={config.mode} onPickRisky={setConfirm} />
          <ModelSelect
            className="w-36"
            value={agent.model}
            disabled={stopped}
            onChange={(model) => post({ type: "setAgentModel", agent: name, model })}
          />
          <EffortSelect
            className="w-20"
            value={agent.effort}
            disabled={stopped}
            onChange={(effort) => post({ type: "setAgentEffort", agent: name, effort })}
          />
          <ContextMeter agent={agent} contextWindow={config.contextWindow} />
          <div className="ml-auto flex items-center gap-1">
            {busy && (
              <Button variant="destructive" size="icon-sm" onClick={() => post({ type: "stop", agent: name })} title={`Stop ${name}`}>
                <Square />
              </Button>
            )}
            <InputGroupButton
              size="icon-xs"
              variant="default"
              onClick={send}
              disabled={stopped || !text.trim()}
              title={busy ? "Queue message" : "Send"}
              aria-label="Send"
            >
              <SendHorizontal />
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
      {config.mode === "ultra" && (
        <div
          role="alert"
          className="mt-1 flex items-center gap-1 rounded-md border border-destructive/70 px-2 py-0.5 text-[11px] font-medium text-destructive"
        >
          Ultra: runs without asking except catastrophic actions.
          <HoverCard openDelay={100}>
            <HoverCardTrigger asChild>
              <button type="button" className="cursor-help underline underline-offset-2">
                Details
              </button>
            </HoverCardTrigger>
            <HoverCardContent side="top" className="w-80 space-y-1 text-xs font-normal">
              <div>
                <span className="font-medium">Still asks:</span> deleting, moving or writing outside the project; force-push or
                deleting remote git history; destroying cloud or remote resources (terraform destroy, kubectl delete, gh repo
                delete…); disk and OS-level commands; reading secret files.
              </div>
              <div>
                <span className="font-medium">Not stopped:</span> publishing packages, piping downloads into a shell, scripts
                the agent writes, and deletes or history rewrites inside the project.
              </div>
              <div className="text-muted-foreground">Not a sandbox. Switch to Normal for untrusted work.</div>
            </HoverCardContent>
          </HoverCard>
        </div>
      )}
      {config.mode === "auto" && (
        <div className="mt-1 text-[11px] text-warning">
          Auto runs edits without asking and commands unless a rule or check stops them. Tests and builds run project code, so use Normal for untrusted work. Auto is not a sandbox.
        </div>
      )}
      {busy && !stopped && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {name} is busy: a message you send is queued and delivered when the current turn ends.
        </div>
      )}
    </div>
  );
}
