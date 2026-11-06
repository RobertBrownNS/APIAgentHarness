import { useState } from "react";
import { Check, CheckCheck, X } from "lucide-react";
import { post } from "@/vscode";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ApprovalCard({ id, allowApproveAll = false }: { id: string; allowApproveAll?: boolean }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const reject = () => post({ type: "approval", id, decision: "reject", reason: reason.trim() || undefined });

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
          <Button variant="destructive" size="sm" onClick={reject}>
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
      <Button size="sm" onClick={() => post({ type: "approval", id, decision: "approve" })}>
        <Check /> Approve
      </Button>
      {allowApproveAll && (
      <Button
        variant="secondary"
        size="sm"
        title="Approve this and all further file edits in this chat. Commands always ask."
        onClick={() => post({ type: "approval", id, decision: "approveAll" })}
      >
        <CheckCheck /> Approve all edits
      </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => setRejecting(true)}>
        <X /> Reject
      </Button>
    </div>
  );
}
