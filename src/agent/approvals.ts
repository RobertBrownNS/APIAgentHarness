import type { ApprovalDecision } from "../shared/protocol";

export interface ApprovalResult {
  approved: boolean;
  reason?: string;
}

interface Pending {
  done: (r: ApprovalResult) => void;
  /** File edits/writes may be covered by "Approve all"; commands never are. */
  coverable: boolean;
}

/** Holds tool calls waiting for the user to approve or reject them in the chat panel. */
export class ApprovalBroker {
  private pending = new Map<string, Pending>();
  /** Set by "Approve all" on an edit card: skip prompts for further file edits in this chat. */
  approveAll = false;

  /**
   * `coverable` marks calls that "Approve all" may cover (file edits). Commands pass false and always ask.
   * Rejects at once if the signal is already aborted, and when it aborts later.
   */
  request(id: string, opts: { signal?: AbortSignal; coverable?: boolean } = {}): Promise<ApprovalResult> {
    const coverable = opts.coverable ?? false;
    if (opts.signal?.aborted) return Promise.resolve({ approved: false, reason: "stopped by user" });
    if (coverable && this.approveAll) return Promise.resolve({ approved: true });
    // A reused id would orphan the earlier promise; settle it first.
    this.resolve(id, "reject", "superseded");
    return new Promise((resolve) => {
      const onAbort = () => this.resolve(id, "reject", "stopped by user");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        coverable,
        done: (r) => {
          opts.signal?.removeEventListener("abort", onAbort);
          resolve(r);
        },
      });
    });
  }

  /** True if the call is waiting for an answer. */
  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  /** Approve every waiting file edit (used right after "Approve all"). */
  releaseCoverable(): void {
    for (const [id, p] of [...this.pending]) if (p.coverable) this.resolve(id, "approve");
  }

  resolve(id: string, decision: ApprovalDecision, reason?: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (decision === "approveAll" && p.coverable) this.approveAll = true;
    // Anything other than an explicit approve counts as a rejection.
    const approve = decision === "approve" || decision === "approveAll";
    p.done(approve ? { approved: true } : { approved: false, reason });
  }

  /** Reject everything still waiting (used when the user presses Stop). */
  cancelAll(reason: string): void {
    for (const id of [...this.pending.keys()]) this.resolve(id, "reject", reason);
  }

  reset(): void {
    this.cancelAll("chat was reset");
    this.approveAll = false;
  }
}
