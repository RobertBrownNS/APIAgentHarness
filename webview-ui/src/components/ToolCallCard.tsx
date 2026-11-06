import { useContext, useState } from "react";
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronRight,
  FilePen,
  FilePlus,
  FileText,
  FolderTree,
  Loader2,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ChatItem, ToolStatus } from "@shared/protocol";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ShowQueueContext } from "@/lib/ui-context";
import { cn } from "@/lib/utils";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

const ICONS: Record<string, LucideIcon> = {
  read_file: FileText,
  list_files: FolderTree,
  search_text: Search,
  edit_file: FilePen,
  write_file: FilePlus,
  run_command: Terminal,
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function summarize(name: string, input: unknown): string {
  const i = asRecord(input);
  switch (name) {
    case "read_file":
    case "edit_file":
    case "write_file":
      return str(i.path) ?? "";
    case "list_files":
      return str(i.glob) ?? "**/*";
    case "search_text":
      return `${str(i.pattern) ?? ""}${str(i.glob) ? `  in ${str(i.glob)}` : ""}`;
    default:
      return "";
  }
}

function StatusBadge({ status, chars, queued }: { status: ToolStatus; chars?: number; queued?: boolean }) {
  switch (status) {
    case "streaming":
      if (queued) return <Badge>queued</Badge>;
      return (
        <Badge>
          <Loader2 className="animate-spin" />
          writing…{chars ? ` ${chars} chars` : ""}
        </Badge>
      );
    case "awaiting":
      return <Badge variant="warning">awaiting approval</Badge>;
    case "running":
      return (
        <Badge variant="secondary">
          <Loader2 className="animate-spin" /> running
        </Badge>
      );
    case "done":
      return (
        <Badge variant="success">
          <CheckCircle2 /> done
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive">
          <AlertCircle /> error
        </Badge>
      );
    case "rejected":
      return (
        <Badge>
          <Ban /> rejected
        </Badge>
      );
  }
}

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "max-h-60 overflow-auto whitespace-pre rounded-md border bg-muted px-2 py-1 font-mono text-[11px] leading-snug",
        className,
      )}
    >
      {children}
    </pre>
  );
}

function DiffBlock({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const lines = (s: string) => (s === "" ? [] : s.split("\n"));
  return (
    <pre className="max-h-60 overflow-auto rounded-md border bg-muted py-1 font-mono text-[11px] leading-snug">
      <div className="w-max min-w-full">
        {lines(oldStr).map((l, i) => (
          <div key={`o${i}`} className="whitespace-pre bg-diff-del px-2">
            {"- " + l}
          </div>
        ))}
        {lines(newStr).map((l, i) => (
          <div key={`n${i}`} className="whitespace-pre bg-diff-add px-2">
            {"+ " + l}
          </div>
        ))}
      </div>
    </pre>
  );
}

function Details({ item, skipInput }: { item: ToolItem; skipInput: boolean }) {
  const i = asRecord(item.input);
  let input: React.ReactNode = null;
  if (!skipInput && item.input !== undefined) {
    if (item.name === "edit_file" && typeof i.old_str === "string" && typeof i.new_str === "string") {
      input = <DiffBlock oldStr={i.old_str} newStr={i.new_str} />;
    } else if (item.name === "write_file" && typeof i.contents === "string") {
      input = <Mono>{i.contents}</Mono>;
    } else {
      input = <Mono>{JSON.stringify(item.input, null, 2)}</Mono>;
    }
  }
  return (
    <div className="space-y-1.5">
      {input}
      {item.output ? (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Output</div>
          <Mono className={item.status === "error" ? "text-destructive" : undefined}>{item.output}</Mono>
        </div>
      ) : null}
    </div>
  );
}

export function ToolCallCard({ item, footer }: { item: ToolItem; footer?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const showQueue = useContext(ShowQueueContext);
  const Icon = ICONS[item.name] ?? Wrench;
  const input = asRecord(item.input);
  const summary = summarize(item.name, item.input);
  const awaiting = item.status === "awaiting";
  const command = item.name === "run_command" ? str(input.command) : undefined;
  const hasDetails = (item.input !== undefined && command === undefined) || !!item.output;
  // While awaiting approval, always show what is being approved.
  const showDetails = open || awaiting;

  return (
    <Card className={cn("min-w-0 overflow-hidden", awaiting && "border-warning/70")}>
      <Collapsible open={showDetails} onOpenChange={setOpen}>
        <CardHeader>
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-mono text-xs">{item.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={summary}>
            {summary}
          </span>
          <StatusBadge status={item.status} chars={item.inputChars} queued={item.status === "streaming" && item.input !== undefined} />
          {hasDetails && !awaiting && (
            <CollapsibleTrigger
              className="cursor-pointer text-muted-foreground hover:text-foreground"
              aria-label="Toggle details"
            >
              <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            </CollapsibleTrigger>
          )}
        </CardHeader>
        {command !== undefined && (
          <CardContent className="pb-1.5">
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted px-2 py-1 font-mono text-xs">
              <span className="select-none text-muted-foreground">$ </span>
              {command}
            </pre>
            {str(input.cwd) && <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">in {str(input.cwd)}</div>}
          </CardContent>
        )}
        <CollapsibleContent>
          <CardContent>
            <Details item={item} skipInput={command !== undefined} />
          </CardContent>
        </CollapsibleContent>
        {awaiting && (
          <CardContent>
            {footer ?? (
              <button
                type="button"
                onClick={showQueue}
                className="cursor-pointer text-xs text-warning underline-offset-2 hover:underline"
              >
                Waiting in the approval queue
              </button>
            )}
          </CardContent>
        )}
      </Collapsible>
    </Card>
  );
}
