import { KeyRound, Plus } from "lucide-react";
import { EFFORTS, MODELS, type Effort, type SessionConfig } from "@shared/protocol";
import { post } from "@/vscode";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function Header({ config }: { config: SessionConfig }) {
  const models: string[] = [...MODELS];
  if (config.model && !models.includes(config.model)) models.unshift(config.model);

  return (
    <div className="shrink-0 border-b px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <Select value={config.model || undefined} onValueChange={(model) => post({ type: "setModel", model })}>
          <SelectTrigger className="min-w-0 flex-1" aria-label="Model">
            <SelectValue placeholder="Model" />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={config.effort} onValueChange={(effort) => post({ type: "setEffort", effort: effort as Effort })}>
          <SelectTrigger className="w-20 shrink-0" aria-label="Effort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EFFORTS.map((e) => (
              <SelectItem key={e} value={e}>
                {e}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="secondary" size="sm" onClick={() => post({ type: "newChat" })} title="Start a new chat">
          <Plus /> New
        </Button>
      </div>
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
