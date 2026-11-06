import type { ApprovalRequest, ChatItem } from "@shared/protocol";
import { Badge } from "@/components/ui/badge";
import { ApprovalCard } from "@/components/ApprovalCard";
import { ToolCallCard } from "@/components/ToolCallCard";

export function ApprovalQueue({
  approvals,
  onSelectAgent,
}: {
  approvals: ApprovalRequest[];
  onSelectAgent: (name: string) => void;
}) {
  if (approvals.length === 0) {
    return <div className="px-3 py-4 text-center text-xs text-muted-foreground">Nothing is waiting for approval.</div>;
  }
  return (
    <ul className="flex flex-col gap-2 p-2">
      {approvals.map((r) => {
        const item: Extract<ChatItem, { kind: "tool" }> = {
          kind: "tool",
          id: r.id,
          name: r.tool,
          input: r.input,
          status: "awaiting",
        };
        return (
          <li key={r.id} className="min-w-0 space-y-1">
            <button
              type="button"
              onClick={() => onSelectAgent(r.agent)}
              className="cursor-pointer text-left"
              title={`Open ${r.agent}'s chat`}
            >
              <Badge variant="warning" className="text-xs">{r.agent} wants to run {r.tool}</Badge>
            </button>
            <ToolCallCard item={item} footer={<ApprovalCard id={r.id} agent={r.agent} allowApproveAll={r.coverable} />} />
          </li>
        );
      })}
    </ul>
  );
}
