import type { ApprovalRequest } from "../shared/protocol";
import type { ApprovalQueue } from "./types";

interface Pending {
  req: ApprovalRequest;
  done: (r: { approved: boolean; reason?: string }) => void;
}

/** One queue for every agent. Rules match the old ApprovalBroker; "approve all edits" is per agent. */
export class ApprovalQueueImpl implements ApprovalQueue {
  private items = new Map<string, Pending>();
  private approveAllFor = new Set<string>();
  private listeners = new Set<(p: ApprovalRequest[]) => void>();

  request(req: ApprovalRequest, signal: AbortSignal): Promise<{ approved: boolean; reason?: string }> {
    if (signal.aborted) return Promise.resolve({ approved: false, reason: "stopped by user" });
    if (req.coverable && this.approveAllFor.has(req.agent)) return Promise.resolve({ approved: true });
    // A reused id would orphan the earlier promise; settle it first.
    this.settle(req.id, { approved: false, reason: "superseded" });
    return new Promise((resolve) => {
      const onAbort = () => this.settle(req.id, { approved: false, reason: "stopped by user" });
      signal.addEventListener("abort", onAbort, { once: true });
      this.items.set(req.id, {
        req,
        done: (r) => {
          signal.removeEventListener("abort", onAbort);
          resolve(r);
        },
      });
      this.emit();
    });
  }

  private settle(id: string, r: { approved: boolean; reason?: string }): Pending | undefined {
    const p = this.items.get(id);
    if (!p) return undefined;
    this.items.delete(id);
    p.done(r);
    this.emit();
    return p;
  }

  resolve(id: string, decision: "approve" | "approveAll" | "reject", reason?: string): void {
    const p = this.items.get(id);
    if (!p) return;
    // Anything other than an explicit approve counts as a rejection.
    const approve = decision === "approve" || decision === "approveAll";
    this.settle(id, approve ? { approved: true } : { approved: false, reason });
    if (decision === "approveAll" && p.req.coverable) {
      this.approveAllFor.add(p.req.agent);
      for (const [oid, o] of [...this.items]) {
        if (o.req.agent === p.req.agent && o.req.coverable) this.settle(oid, { approved: true });
      }
    }
  }

  cancelAgent(agent: string, reason: string): void {
    for (const [id, p] of [...this.items]) if (p.req.agent === agent) this.settle(id, { approved: false, reason });
  }

  cancelAll(reason: string): void {
    for (const id of [...this.items.keys()]) this.settle(id, { approved: false, reason });
  }

  /** Forget "approve all edits" for this agent (stop, remove). */
  forgetAgent(agent: string): void {
    this.approveAllFor.delete(agent);
  }

  /** Forget "approve all edits" for every agent (any mode change). */
  forgetAll(): void {
    this.approveAllFor.clear();
  }

  /** True if this agent's later edits are auto-approved. */
  isApproveAll(agent: string): boolean {
    return this.approveAllFor.has(agent);
  }

  pending(): ApprovalRequest[] {
    return [...this.items.values()].map((p) => p.req);
  }

  onChange(listener: (pending: ApprovalRequest[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.cancelAll("team was reset");
    this.approveAllFor.clear();
  }

  private emit(): void {
    const snap = this.pending();
    for (const l of [...this.listeners]) {
      try {
        l(snap);
      } catch {
        /* ignore */
      }
    }
  }
}
