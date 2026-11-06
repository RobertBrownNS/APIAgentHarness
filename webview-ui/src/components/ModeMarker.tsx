import type { Mode } from "@shared/protocol";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { cn } from "@/lib/utils";

export const MODE_LABEL: Record<Mode, string> = { plan: "Plan", normal: "Normal", auto: "Auto", ultra: "Ultra" };

export function ModeMarker({ mode, by }: { mode: Mode; by: string }) {
  return (
    <Marker variant="separator" className="text-xs">
      <MarkerContent className={cn(mode === "auto" && "text-warning", mode === "ultra" && "font-semibold text-destructive")}>
        Mode: {MODE_LABEL[mode]}
        {by ? ` (set by ${by})` : ""}
      </MarkerContent>
    </Marker>
  );
}
