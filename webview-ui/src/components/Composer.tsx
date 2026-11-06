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

function ModeSwitcher({ mode, onPickAuto }: { mode: Mode; onPickAuto: () => void }) {
  return (
    <Select
      value={mode}
      onValueChange={(m) => {
        // Auto is the riskiest mode: confirm before sending.
        if (m === "auto" && mode !== "auto") onPickAuto();
        else post({ type: "setMode", mode: m as Mode });
      }}
    >
      <SelectTrigger
        className={cn("w-24", mode === "auto" && "border-warning/70 text-warning")}
        aria-label="Mode (applies to the whole team)"
        title="Mode for the whole team: Plan is read-only, Normal asks for edits and commands, Auto runs edits and safe commands"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MODES.map((m) => (
          <SelectItem key={m} value={m} className={m === "auto" ? "text-warning" : undefined}>
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
  const [confirmAuto, setConfirmAuto] = useState(false);

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
      {confirmAuto && config.mode !== "auto" && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5 rounded-md border border-warning/60 px-2 py-1 text-xs">
          <span className="min-w-0 flex-1 text-warning">
            Auto runs edits without asking and commands unless a rule or check stops them. Tests and builds run project code, so use Normal for untrusted work.
          </span>
          <Button
            size="sm"
            onClick={() => {
              post({ type: "setMode", mode: "auto" });
              setConfirmAuto(false);
            }}
          >
            Switch to Auto
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmAuto(false)}>
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
          <ModeSwitcher mode={config.mode} onPickAuto={() => setConfirmAuto(true)} />
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
