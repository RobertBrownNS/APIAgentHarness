import { useState } from "react";
import { Check, CheckCheck, X } from "lucide-react";
import { post } from "@/vscode";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ApprovalCard({ id, agent, allowApproveAll = false }: { id: string; agent: string; allowApproveAll?: boolean }) {
  const [sent, setSent] = useState(false);
  const decide = (decision: "approve" | "approveAll" | "reject", reason?: string) => {
    if (sent) return;
    setSent(true);
    post({ type: "approval", id, decision, reason });
  };
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const reject = () => decide("reject", reason.trim() || undefined);

  if (rejecting) {
    return (
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
              reject();
            }
          }}
        />
        <div className="flex gap-1.5">
          <Button variant="destructive" size="sm" disabled={sent} onClick={reject}>
            <X /> Reject
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      <Button size="sm" disabled={sent} onClick={() => decide("approve")}>
        <Check /> Approve
      </Button>
      {allowApproveAll && (
      <Button
        variant="secondary"
        size="sm"
        disabled={sent}
        title={`Approve this and all further file edits by ${agent}. Commands always ask.`}
        onClick={() => decide("approveAll")}
      >
        <CheckCheck /> Approve all edits by {agent}
      </Button>
      )}
      <Button variant="outline" size="sm" disabled={sent} onClick={() => setRejecting(true)}>
        <X /> Reject
      </Button>
    </div>
  );
}
