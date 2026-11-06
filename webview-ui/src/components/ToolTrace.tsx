import { useContext, useState } from "react";
import { FilePen, FilePlus, FileText, FolderTree, Search, Terminal, Wrench, type LucideIcon } from "lucide-react";
import type { ChatItem, ToolStatus } from "@shared/protocol";
import { Badge } from "@/components/ui/badge";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { Confirmation } from "@/components/Confirmation";
import { ApprovalsContext } from "@/lib/ui-context";

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

export function summarize(name: string, input: unknown): string {
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
    case "run_command":
      return (str(i.command) ?? "").split("\n")[0];
    default:
      return "";
  }
}

const lines = (s: string) => (s === "" ? [] : s.split("\n"));

/** Full, untruncated view of what a tool call does: diff, file contents, command or raw input. Defensive about unknown input shapes. */
export function ToolInput({ name, input }: { name: string; input: unknown }) {
  const i = asRecord(input);
  if (input === undefined) return null;
  if (name === "edit_file" && typeof i.old_str === "string" && typeof i.new_str === "string") {
    return (
      <CodeBlock size="sm">
        <CodeBlockHeader>
          <CodeBlockTitle>{str(i.path) ?? "edit_file"}</CodeBlockTitle>
        </CodeBlockHeader>
        <CodeBlockContent className="max-h-60">
          {lines(i.old_str).map((l, n) => (
            <CodeBlockLine key={`o${n}`} variant="removed">
              {l}
            </CodeBlockLine>
          ))}
          {lines(i.new_str).map((l, n) => (
            <CodeBlockLine key={`n${n}`} variant="added">
              {l}
            </CodeBlockLine>
          ))}
        </CodeBlockContent>
      </CodeBlock>
    );
  }
  if (name === "write_file" && typeof i.contents === "string") {
    return (
      <CodeBlock size="sm">
        <CodeBlockHeader>
          <CodeBlockTitle>{str(i.path) ?? "write_file"}</CodeBlockTitle>
        </CodeBlockHeader>
        <CodeBlockContent className="max-h-60">{i.contents}</CodeBlockContent>
      </CodeBlock>
    );
  }
  if (name === "run_command" && typeof i.command === "string") {
    return (
      <CodeBlock size="sm">
        <CodeBlockContent wrap className="max-h-48">
          <span className="select-none text-muted-foreground">$ </span>
          {i.command}
        </CodeBlockContent>
        {str(i.cwd) && <CodeBlockFooter className="font-mono text-[10px]">in {str(i.cwd)}</CodeBlockFooter>}
      </CodeBlock>
    );
  }
  let json: string;
  try {
    json = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    json = String(input);
  }
  return (
    <CodeBlock size="sm">
      <CodeBlockContent className="max-h-48">{json.length > 4000 ? json.slice(0, 4000) + "\n…" : json}</CodeBlockContent>
    </CodeBlock>
  );
}

function traceStatus(s: ToolStatus, queued: boolean): "running" | "error" | "pending" | undefined {
  switch (s) {
    case "streaming":
      return queued ? "pending" : "running";
    case "running":
      return "running";
    case "awaiting":
      return "pending";
    case "error":
    case "rejected":
      return "error";
    default:
      return undefined;
  }
}

function statusText(item: ToolItem): string {
  switch (item.status) {
    case "streaming":
      return item.input !== undefined ? "queued" : `writing…${item.inputChars ? ` ${item.inputChars} chars` : ""}`;
    case "awaiting":
      return "awaiting approval";
    case "running":
      return "running";
    case "error":
      return "error";
    case "rejected":
      return "rejected";
    default:
      return "";
  }
}

export function ToolTrace({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const ctx = useContext(ApprovalsContext);
  const Icon = ICONS[item.name] ?? Wrench;
  const summary = summarize(item.name, item.input);
  const awaiting = item.status === "awaiting";
  const request = awaiting ? ctx.byId[item.id] : undefined;
  const inlineApproval = awaiting && ctx.inline && request;
  const hasDetails = item.input !== undefined || !!item.output;
  const showDetails = open || !!inlineApproval;

  return (
    <Trace>
      <TraceCollapsible open={showDetails} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger disabled={!hasDetails || !!inlineApproval}>
          <TraceLine status={traceStatus(item.status, item.status === "streaming" && item.input !== undefined)}>
            <TraceIcon>
              <Icon />
            </TraceIcon>
            <TraceTitle>
              <span className="font-mono">{item.name}</span>
              {summary && <span className="ml-2 font-mono opacity-70">{summary}</span>}
            </TraceTitle>
            {statusText(item) && <TraceDescription>{statusText(item)}</TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="space-y-1.5">
          {item.blockedByMode && <Badge variant="warning">Blocked: {item.blockedByMode} mode does not allow this</Badge>}
          {item.autoApproved && (
            <Badge variant="secondary" className="max-w-full whitespace-normal" title={item.autoApproved}>
              Auto-approved: {item.autoApproved}
            </Badge>
          )}
          {inlineApproval && request ? <Confirmation request={request} /> : <ToolInput name={item.name} input={item.input} />}
          {item.output ? (
            <CodeBlock size="sm" variant={item.status === "error" ? "destructive" : "default"}>
              <CodeBlockHeader>
                <CodeBlockTitle>Output</CodeBlockTitle>
              </CodeBlockHeader>
              <CodeBlockContent className="max-h-60">{item.output}</CodeBlockContent>
            </CodeBlock>
          ) : null}
        </TraceCollapsibleContent>
      </TraceCollapsible>
      {awaiting && !inlineApproval && (
        <button
          type="button"
          onClick={ctx.showQueue}
          className="w-fit cursor-pointer text-xs text-warning underline-offset-2 hover:underline"
        >
          Waiting in the approval queue
        </button>
      )}
    </Trace>
  );
}
