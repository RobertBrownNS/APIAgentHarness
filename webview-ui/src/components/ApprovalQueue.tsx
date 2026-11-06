import type { ApprovalRequest, ChatItem } from "@shared/protocol";
import { Button } from "@/components/ui/button";
import { Confirmation } from "@/components/Confirmation";
import { PlanCard } from "@/components/PlanCard";

export function ApprovalQueue({
  approvals,
  transcripts,
  onSelectAgent,
}: {
  approvals: ApprovalRequest[];
  transcripts: Record<string, ChatItem[]>;
  onSelectAgent: (name: string) => void;
}) {
  if (approvals.length === 0) {
    return <div className="px-3 py-4 text-center text-xs text-muted-foreground">Nothing is waiting for approval.</div>;
  }
  return (
    <ul className="flex flex-col gap-2 p-2">
      {approvals.map((r) => {
        const plan =
          r.kind === "plan"
            ? (transcripts[r.agent] ?? []).find((it): it is Extract<ChatItem, { kind: "plan" }> => it.kind === "plan" && it.id === r.id)
            : undefined;
        return (
          <li key={r.id} className="min-w-0 space-y-1">
            {plan ? <PlanCard item={plan} /> : <Confirmation request={r} />}
            <Button variant="link" size="xs" className="h-auto p-0" onClick={() => onSelectAgent(r.agent)}>
              Open {r.agent}&apos;s chat
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
