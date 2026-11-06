import { Loader2 } from "lucide-react";
import type { AgentStatus } from "@shared/protocol";
import { cn } from "@/lib/utils";

const LABEL: Record<AgentStatus, string> = {
  idle: "idle",
  running: "running",
  awaiting: "awaiting approval",
  paused: "paused (auto-turn budget spent)",
  stopped: "stopped",
};

export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  if (status === "running")
    return <Loader2 className={cn("size-3 shrink-0 animate-spin text-primary", className)} aria-label={LABEL[status]} />;
  const color =
    status === "awaiting"
      ? "bg-warning"
      : status === "paused"
        ? "border border-warning bg-transparent"
        : status === "stopped"
          ? "bg-muted-foreground/40"
          : "bg-success";
  return (
    <span
      role="img"
      aria-label={LABEL[status]}
      title={LABEL[status]}
      className={cn("inline-block size-2 shrink-0 rounded-full", color, className)}
    />
  );
}

export function statusLabel(s: AgentStatus): string {
  return LABEL[s];
}
