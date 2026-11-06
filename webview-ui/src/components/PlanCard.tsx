import { useState } from "react";
import { CheckCheck, ClipboardList, Pencil } from "lucide-react";
import type { ChatItem } from "@shared/protocol";
import { post } from "@/vscode";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Textarea } from "@/components/ui/textarea";
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { cn } from "@/lib/utils";

type PlanItem = Extract<ChatItem, { kind: "plan" }>;

/** main's plan. While awaiting, the user approves it into Normal or Auto mode, or sends feedback and stays in Plan. */
export function PlanCard({ item, actions = true }: { item: PlanItem; actions?: boolean }) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [sent, setSent] = useState(false);
  const awaiting = item.status === "awaiting";

  const approve = (mode: "normal" | "auto") => {
    if (sent) return;
    setSent(true);
    post({ type: "planDecision", id: item.id, approve: true, mode });
  };
  const reject = () => {
    if (sent) return;
    setSent(true);
    post({ type: "planDecision", id: item.id, approve: false, feedback: feedback.trim() || undefined });
  };

  return (
    <Item variant="outline" size="sm" className={cn(awaiting && "border-warning/60")}>
      <ItemContent className="min-w-0 basis-full">
        <ItemTitle className="flex-wrap">
          <ClipboardList className="size-4" />
          <span>{item.title}</span>
          {item.status === "approved" && (
            <Badge variant="success">approved{item.approvedMode ? ` · ${item.approvedMode}` : ""}</Badge>
          )}
          {item.status === "rejected" && <Badge variant="destructive">not approved</Badge>}
          {awaiting && <Badge variant="warning">awaiting your decision</Badge>}
        </ItemTitle>
        {item.summary && <ItemDescription className="line-clamp-none whitespace-pre-wrap">{item.summary}</ItemDescription>}
        <Trace className="gap-1 py-1">
          {item.steps.map((s, n) => (
            <div key={n} className="min-w-0">
              <TraceLine status={awaiting ? "pending" : undefined} className="text-xs">
                <TraceIcon>
                  <span className="font-mono text-[10px]">{n + 1}</span>
                </TraceIcon>
                <TraceTitle className="whitespace-normal text-foreground">{s.title}</TraceTitle>
              </TraceLine>
              {s.detail && <div className="ml-6 text-[11px] text-muted-foreground">{s.detail}</div>}
            </div>
          ))}
        </Trace>
        {item.status === "rejected" && item.feedback && (
          <ItemDescription className="line-clamp-none text-xs">Your feedback: {item.feedback}</ItemDescription>
        )}
        {awaiting && !actions && (
          <ItemDescription className="line-clamp-none text-xs text-warning">Decide in the approval queue.</ItemDescription>
        )}
        {awaiting &&
          actions &&
          (feedbackOpen ? (
            <div className="space-y-1.5">
              <Textarea
                autoFocus
                rows={3}
                value={feedback}
                placeholder="What should change? main stays in Plan mode and revises the plan."
                onChange={(e) => setFeedback(e.target.value)}
              />
              <div className="flex gap-1.5">
                <Button size="sm" disabled={sent} onClick={reject}>
                  Send feedback
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setFeedbackOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" disabled={sent} onClick={() => approve("normal")} title="Run the plan; edits and commands still ask">
                <CheckCheck /> Approve → Normal
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={sent}
                onClick={() => approve("auto")}
                title="Run the plan in Auto mode: edits run, commands run unless a safety rule asks"
              >
                <CheckCheck /> Approve → Auto
              </Button>
              <span className="basis-full text-[11px] text-warning">
                Auto runs edits without asking and commands unless a rule or check stops them. Tests and builds run project code, so use Normal for untrusted work.
              </span>
              <Button size="sm" variant="outline" disabled={sent} onClick={() => setFeedbackOpen(true)}>
                <Pencil /> Keep planning
              </Button>
            </div>
          ))}
      </ItemContent>
    </Item>
  );
}
