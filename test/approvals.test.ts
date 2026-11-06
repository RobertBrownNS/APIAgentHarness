import { describe, expect, it, vi } from "vitest";
import { ApprovalBroker } from "../src/agent/approvals";
import type { ApprovalDecision } from "../src/shared/protocol";

/** Resolves to "pending" if the promise has not settled yet. */
async function settled<T>(p: Promise<T>): Promise<T | "pending"> {
  return Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), 20))]);
}

describe("ApprovalBroker basics", () => {
  it("stays pending until resolved, then approves", async () => {
    const b = new ApprovalBroker();
    const p = b.request("1");
    expect(b.isPending("1")).toBe(true);
    expect(await settled(p)).toBe("pending");
    b.resolve("1", "approve");
    expect(await p).toEqual({ approved: true });
    expect(b.isPending("1")).toBe(false);
  });

  it("rejects with the reason given", async () => {
    const b = new ApprovalBroker();
    const p = b.request("1");
    b.resolve("1", "reject", "not now");
    expect(await p).toEqual({ approved: false, reason: "not now" });
  });

  it("rejects without a reason", async () => {
    const b = new ApprovalBroker();
    const p = b.request("1");
    b.resolve("1", "reject");
    expect(await p).toEqual({ approved: false, reason: undefined });
  });

  it("ignores resolve for unknown ids", () => {
    const b = new ApprovalBroker();
    expect(() => b.resolve("nope", "approve")).not.toThrow();
  });

  it("ignores a second resolve for the same id", async () => {
    const b = new ApprovalBroker();
    const p = b.request("1");
    b.resolve("1", "approve");
    b.resolve("1", "reject", "late");
    expect(await p).toEqual({ approved: true });
  });

  it("keeps separate requests independent", async () => {
    const b = new ApprovalBroker();
    const a = b.request("a");
    const c = b.request("c");
    b.resolve("c", "reject", "no");
    expect(await c).toEqual({ approved: false, reason: "no" });
    expect(b.isPending("a")).toBe(true);
    b.resolve("a", "approve");
    expect(await a).toEqual({ approved: true });
  });
});

describe("unknown decisions", () => {
  it.each(["", "APPROVE", "yes", "true", "approve ", "approve_all", "__proto__", undefined, null, 1])(
    "treats %j as a rejection",
    async (d) => {
      const b = new ApprovalBroker();
      const p = b.request("1", { coverable: true });
      b.resolve("1", d as unknown as ApprovalDecision);
      expect((await p).approved).toBe(false);
      expect(b.approveAll).toBe(false);
    },
  );
});

describe("approve all", () => {
  it("approveAll on a coverable request approves it and sets the flag", async () => {
    const b = new ApprovalBroker();
    const p = b.request("1", { coverable: true });
    b.resolve("1", "approveAll");
    expect(await p).toEqual({ approved: true });
    expect(b.approveAll).toBe(true);
  });

  it("later coverable requests are approved immediately without becoming pending", async () => {
    const b = new ApprovalBroker();
    b.approveAll = true;
    const p = b.request("2", { coverable: true });
    expect(await p).toEqual({ approved: true });
    expect(b.isPending("2")).toBe(false);
  });

  it("commands (non-coverable) still ask while approveAll is on", async () => {
    const b = new ApprovalBroker();
    b.approveAll = true;
    const p = b.request("cmd");
    expect(b.isPending("cmd")).toBe(true);
    expect(await settled(p)).toBe("pending");
    b.resolve("cmd", "reject", "no");
    expect((await p).approved).toBe(false);
  });

  it("default is non-coverable", async () => {
    const b = new ApprovalBroker();
    b.approveAll = true;
    b.request("x");
    expect(b.isPending("x")).toBe(true);
  });

  it("approveAll on a command approves that call but does not set the flag", async () => {
    const b = new ApprovalBroker();
    const p = b.request("cmd", { coverable: false });
    b.resolve("cmd", "approveAll");
    expect(await p).toEqual({ approved: true });
    expect(b.approveAll).toBe(false);
    // and the next command still has to ask
    b.request("cmd2");
    expect(b.isPending("cmd2")).toBe(true);
  });

  it("a plain approve does not set the flag", async () => {
    const b = new ApprovalBroker();
    const p = b.request("1", { coverable: true });
    b.resolve("1", "approve");
    await p;
    expect(b.approveAll).toBe(false);
  });

  it("a rejected approveAll-flagged card does not set the flag", async () => {
    const b = new ApprovalBroker();
    const p = b.request("1", { coverable: true });
    b.resolve("1", "reject");
    await p;
    expect(b.approveAll).toBe(false);
  });
});

describe("releaseCoverable", () => {
  it("approves waiting edits and leaves commands waiting", async () => {
    const b = new ApprovalBroker();
    const e1 = b.request("e1", { coverable: true });
    const e2 = b.request("e2", { coverable: true });
    const cmd = b.request("cmd");
    b.releaseCoverable();
    expect(await e1).toEqual({ approved: true });
    expect(await e2).toEqual({ approved: true });
    expect(await settled(cmd)).toBe("pending");
    expect(b.isPending("cmd")).toBe(true);
    expect(b.isPending("e1")).toBe(false);
  });

  it("is a no-op with nothing pending", () => {
    expect(() => new ApprovalBroker().releaseCoverable()).not.toThrow();
  });

  it("does not set approveAll by itself", () => {
    const b = new ApprovalBroker();
    b.request("e", { coverable: true });
    b.releaseCoverable();
    expect(b.approveAll).toBe(false);
  });
});

describe("abort signal", () => {
  it("rejects at once when already aborted, even if approveAll is on", async () => {
    const b = new ApprovalBroker();
    b.approveAll = true;
    const ac = new AbortController();
    ac.abort();
    expect(await b.request("1", { signal: ac.signal, coverable: true })).toEqual({
      approved: false,
      reason: "stopped by user",
    });
    expect(b.isPending("1")).toBe(false);
  });

  it("rejects a waiting request when the signal aborts later", async () => {
    const b = new ApprovalBroker();
    const ac = new AbortController();
    const p = b.request("1", { signal: ac.signal });
    expect(await settled(p)).toBe("pending");
    ac.abort();
    expect(await p).toEqual({ approved: false, reason: "stopped by user" });
    expect(b.isPending("1")).toBe(false);
  });

  it("aborting does not set approveAll", async () => {
    const b = new ApprovalBroker();
    const ac = new AbortController();
    const p = b.request("1", { signal: ac.signal, coverable: true });
    ac.abort();
    await p;
    expect(b.approveAll).toBe(false);
  });

  it("removes the abort listener once answered", async () => {
    const b = new ApprovalBroker();
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    const p = b.request("1", { signal: ac.signal });
    b.resolve("1", "approve");
    await p;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("a later abort after approval changes nothing", async () => {
    const b = new ApprovalBroker();
    const ac = new AbortController();
    const p = b.request("1", { signal: ac.signal });
    b.resolve("1", "approve");
    ac.abort();
    expect(await p).toEqual({ approved: true });
  });

  it("abort of one request leaves others waiting", async () => {
    const b = new ApprovalBroker();
    const ac = new AbortController();
    b.request("a", { signal: ac.signal });
    b.request("b");
    ac.abort();
    expect(b.isPending("a")).toBe(false);
    expect(b.isPending("b")).toBe(true);
  });
});

describe("cancelAll and reset", () => {
  it("cancelAll rejects everything with the reason", async () => {
    const b = new ApprovalBroker();
    const a = b.request("a", { coverable: true });
    const c = b.request("c");
    b.cancelAll("stopped");
    expect(await a).toEqual({ approved: false, reason: "stopped" });
    expect(await c).toEqual({ approved: false, reason: "stopped" });
    expect(b.isPending("a") || b.isPending("c")).toBe(false);
  });

  it("cancelAll keeps approveAll as it was", () => {
    const b = new ApprovalBroker();
    b.approveAll = true;
    b.cancelAll("x");
    expect(b.approveAll).toBe(true);
  });

  it("reset rejects pending requests and clears approveAll", async () => {
    const b = new ApprovalBroker();
    b.approveAll = true;
    const p = b.request("cmd");
    b.reset();
    expect(await p).toEqual({ approved: false, reason: "chat was reset" });
    expect(b.approveAll).toBe(false);
  });

  it("after reset, coverable requests ask again", async () => {
    const b = new ApprovalBroker();
    b.approveAll = true;
    b.reset();
    b.request("e", { coverable: true });
    expect(b.isPending("e")).toBe(true);
  });
});

describe("duplicate ids", () => {
  // [tests -> host] request() overwrites the map entry for a reused id, so the first promise can never settle
  // (and its abort listener leaks). Ids come from the model's tool_use ids and should be unique, but a
  // reject-or-reuse policy is safer than a promise that hangs the loop.
  it("does not leave the first request hanging when an id is reused", async () => {
    const b = new ApprovalBroker();
    const first = b.request("dup");
    b.request("dup");
    b.resolve("dup", "approve");
    expect(await settled(first)).not.toBe("pending");
  });
});
