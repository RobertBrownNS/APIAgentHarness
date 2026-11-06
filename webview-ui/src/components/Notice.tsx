import { cn } from "@/lib/utils";

export function Notice({ level, text }: { level: "info" | "error"; text: string }) {
  return (
    <div
      className={cn(
        "whitespace-pre-wrap break-words rounded-md px-2 py-1 text-xs",
        level === "error" ? "border border-destructive/60 text-destructive" : "text-muted-foreground",
      )}
    >
      {text}
    </div>
  );
}
