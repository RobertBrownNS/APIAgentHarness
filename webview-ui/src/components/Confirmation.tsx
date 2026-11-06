import { useState } from "react";
import { Check, CheckCheck, ShieldAlert, X } from "lucide-react";
import type { ApprovalRequest } from "@shared/protocol";
import { post } from "@/vscode";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Textarea } from "@/components/ui/textarea";
import { ToolInput } from "@/components/ToolTrace";

/** Approval prompt for one tool call: who asked, why it still needs you, the full input, and the decision buttons. */
export function Confirmation({ request }: { request: ApprovalRequest }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [sent, setSent] = useState(false);

  const decide = (decision: "approve" | "approveAll" | "reject", why?: string) => {
    if (sent) return;
    setSent(true);
    post({ type: "approval", id: request.id, decision, reason: why });
  };

  return (
    <Item variant="outline" size="sm" className="border-warning/60">
      <ItemContent className="min-w-0 basis-full">
        <ItemTitle className="flex-wrap">
          <Badge variant="warning" className="text-xs">
            {request.agent}
          </Badge>
          <span className="font-mono text-xs">{request.tool}</span>
          <span className="text-xs font-normal text-muted-foreground">needs your approval</span>
        </ItemTitle>
        {request.askReason && (
          <ItemDescription className="line-clamp-none flex items-start gap-1 text-xs text-warning">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{request.askReason}</span>
          </ItemDescription>
        )}
        <ToolInput name={request.tool} input={request.input} />
        {rejecting ? (
          <div className="space-y-1.5">
            <Textarea
              autoFocus
              rows={2}
              value={reason}
              placeholder="Reason (optional): tell the agent what to do instead"
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  decide("reject", reason.trim() || undefined);
                }
              }}
            />
            <div className="flex gap-1.5">
              <Button variant="destructive" size="sm" disabled={sent} onClick={() => decide("reject", reason.trim() || undefined)}>
                <X /> Reject
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" disabled={sent} onClick={() => decide("approve")}>
              <Check /> Approve
            </Button>
            {request.coverable && (
              <Button
                variant="secondary"
                size="sm"
                disabled={sent}
                title={`Approve this and all further file edits by ${request.agent}. Commands always ask.`}
                onClick={() => decide("approveAll")}
              >
                <CheckCheck /> Approve all edits by {request.agent}
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={sent} onClick={() => setRejecting(true)}>
              <X /> Reject
            </Button>
          </div>
        )}
      </ItemContent>
    </Item>
  );
}
