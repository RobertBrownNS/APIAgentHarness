import { describe, expect, it, vi } from "vitest";
import { ApprovalQueueImpl } from "../src/team/approvalQueue";
import type { ApprovalDecision, ApprovalRequest } from "../src/shared/protocol";

const sig = () => new AbortController();
const req = (id: string, agent = "lead", coverable = false): ApprovalRequest => ({
  id,
  kind: "tool",
  agent,
  tool: coverable ? "edit_file" : "run_command",
  input: {},
  coverable,
});
const edit = (id: string, agent = "lead") => req(id, agent, true);

async function settled<T>(p: Promise<T>): Promise<T | "pending"> {
  return Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), 20))]);
}
const ids = (q: ApprovalQueueImpl) => q.pending().map((r) => r.id);

describe("basics (ported from ApprovalBroker)", () => {
  it("stays pending until resolved, then approves", async () => {
    const q = new ApprovalQueueImpl();
    const p = q.request(req("1"), sig().signal);
    expect(ids(q)).toEqual(["1"]);
    expect(await settled(p)).toBe("pending");
    q.resolve("1", "approve");
    expect(await p).toEqual({ approved: true });
    expect(ids(q)).toEqual([]);
  });
  it("rejects with the reason given / without a reason", async () => {
    const q = new ApprovalQueueImpl();
    const p = q.request(req("1"), sig().signal);
    q.resolve("1", "reject", "not now");
    expect(await p).toEqual({ approved: false, reason: "not now" });
    const p2 = q.request(req("2"), sig().signal);
    q.resolve("2", "reject");
    expect(await p2).toEqual({ approved: false, reason: undefined });
  });
  it("ignores resolve for unknown ids and second resolves", async () => {
    const q = new ApprovalQueueImpl();
    expect(() => q.resolve("nope", "approve")).not.toThrow();
    const p = q.request(req("1"), sig().signal);
    q.resolve("1", "approve");
    q.resolve("1", "reject", "late");
    expect(await p).toEqual({ approved: true });
  });
  it("keeps requests independent and ordered oldest first", async () => {
    const q = new ApprovalQueueImpl();
    const a = q.request(req("a"), sig().signal);
    const c = q.request(req("c", "bob"), sig().signal);
    expect(ids(q)).toEqual(["a", "c"]);
    q.resolve("c", "reject", "no");
    expect(await c).toEqual({ approved: false, reason: "no" });
    expect(ids(q)).toEqual(["a"]);
    q.resolve("a", "approve");
    expect(await a).toEqual({ approved: true });
  });
});

describe("unknown decisions are rejections", () => {
  it.each(["", "APPROVE", "yes", "true", "approve ", "approve_all", "__proto__", undefined, null, 1])(
    "treats %j as a rejection",
    async (d) => {
      const q = new ApprovalQueueImpl();
      const p = q.request(edit("1"), sig().signal);
      q.resolve("1", d as unknown as ApprovalDecision);
      expect((await p).approved).toBe(false);
      expect(q.isApproveAll("lead")).toBe(false);
    },
  );
});

describe("approve all edits (per agent)", () => {
  it("approveAll on an edit approves it, sets the flag for that agent only", async () => {
    const q = new ApprovalQueueImpl();
    const p = q.request(edit("1", "bob"), sig().signal);
    q.resolve("1", "approveAll");
    expect(await p).toEqual({ approved: true });
    expect(q.isApproveAll("bob")).toBe(true);
    expect(q.isApproveAll("lead")).toBe(false);
  });
  it("later edits of that agent are approved at once and never queued", async () => {
    const q = new ApprovalQueueImpl();
    const p0 = q.request(edit("0", "bob"), sig().signal);
    q.resolve("0", "approveAll");
    await p0;
    expect(await q.request(edit("2", "bob"), sig().signal)).toEqual({ approved: true });
    expect(ids(q)).toEqual([]);
  });
  it("another agent's edits still ask", async () => {
    const q = new ApprovalQueueImpl();
    const p0 = q.request(edit("0", "bob"), sig().signal);
    q.resolve("0", "approveAll");
    await p0;
    const p = q.request(edit("3", "amy"), sig().signal);
    expect(ids(q)).toEqual(["3"]);
    expect(await settled(p)).toBe("pending");
  });
  it("commands always ask, even for an approve-all agent", async () => {
    const q = new ApprovalQueueImpl();
    const p0 = q.request(edit("0"), sig().signal);
    q.resolve("0", "approveAll");
    await p0;
    const p = q.request(req("cmd"), sig().signal);
    expect(ids(q)).toEqual(["cmd"]);
    expect(await settled(p)).toBe("pending");
    q.resolve("cmd", "reject", "no");
    expect((await p).approved).toBe(false);
  });
  it("approveAll on a command approves that call but sets no flag", async () => {
    const q = new ApprovalQueueImpl();
    const p = q.request(req("cmd"), sig().signal);
    q.resolve("cmd", "approveAll");
    expect(await p).toEqual({ approved: true });
    expect(q.isApproveAll("lead")).toBe(false);
    q.request(req("cmd2"), sig().signal);
    expect(ids(q)).toEqual(["cmd2"]);
  });
  it("plain approve and reject do not set the flag", async () => {
    const q = new ApprovalQueueImpl();
    const a = q.request(edit("1"), sig().signal);
    q.resolve("1", "approve");
    await a;
    const b = q.request(edit("2"), sig().signal);
    q.resolve("2", "reject");
    await b;
    expect(q.isApproveAll("lead")).toBe(false);
  });
  it("approving all releases that agent's other waiting edits, not its commands nor other agents'", async () => {
    const q = new ApprovalQueueImpl();
    const e1 = q.request(edit("e1", "bob"), sig().signal);
    const e2 = q.request(edit("e2", "bob"), sig().signal);
    const c = q.request(req("c", "bob"), sig().signal);
    const o = q.request(edit("o", "amy"), sig().signal);
    q.resolve("e1", "approveAll");
    expect(await e1).toEqual({ approved: true });
    expect(await e2).toEqual({ approved: true });
    expect(await settled(c)).toBe("pending");
    expect(await settled(o)).toBe("pending");
    expect(ids(q)).toEqual(["c", "o"]);
  });
  it("reject of one edit does not touch the others", async () => {
    const q = new ApprovalQueueImpl();
    q.request(edit("e1", "bob"), sig().signal);
    q.request(edit("e2", "bob"), sig().signal);
    q.resolve("e1", "reject");
    expect(ids(q)).toEqual(["e2"]);
  });
  it("approve-all stays after cancelAgent / cancelAll (only reset clears it)", async () => {
    const q = new ApprovalQueueImpl();
    const p = q.request(edit("1", "bob"), sig().signal);
    q.resolve("1", "approveAll");
    await p;
    q.cancelAgent("bob", "x");
    q.cancelAll("x");
    expect(q.isApproveAll("bob")).toBe(true);
    q.reset();
    expect(q.isApproveAll("bob")).toBe(false);
  });
});

describe("abort signal", () => {
  it("rejects at once when already aborted, even for an approve-all agent", async () => {
    const q = new ApprovalQueueImpl();
    const p0 = q.request(edit("0"), sig().signal);
    q.resolve("0", "approveAll");
    await p0;
    const ac = sig();
    ac.abort();
    expect(await q.request(edit("1"), ac.signal)).toEqual({ approved: false, reason: "stopped by user" });
    expect(ids(q)).toEqual([]);
  });
  it("rejects a waiting request when the signal aborts later; others remain", async () => {
    const q = new ApprovalQueueImpl();
    const ac = sig();
    const p = q.request(req("1"), ac.signal);
    q.request(req("2"), sig().signal);
    ac.abort();
    expect(await p).toEqual({ approved: false, reason: "stopped by user" });
    expect(ids(q)).toEqual(["2"]);
  });
  it("aborting does not set approve-all", async () => {
    const q = new ApprovalQueueImpl();
    const ac = sig();
    const p = q.request(edit("1"), ac.signal);
    ac.abort();
    await p;
    expect(q.isApproveAll("lead")).toBe(false);
  });
  it("removes the abort listener once answered; later abort changes nothing", async () => {
    const q = new ApprovalQueueImpl();
    const ac = sig();
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    const p = q.request(req("1"), ac.signal);
    q.resolve("1", "approve");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    ac.abort();
    expect(await p).toEqual({ approved: true });
  });
  it("an abort of an old superseded request must not reject its replacement (same id)", async () => {
    const q = new ApprovalQueueImpl();
    const ac1 = sig();
    const first = q.request(req("dup"), ac1.signal);
    const second = q.request(req("dup"), sig().signal);
    expect(await first).toEqual({ approved: false, reason: "superseded" });
    ac1.abort();
    expect(ids(q)).toEqual(["dup"]);
    q.resolve("dup", "approve");
    expect(await second).toEqual({ approved: true });
  });
});

describe("cancelAgent / cancelAll / reset", () => {
  it("cancelAgent rejects only that agent's requests with the reason", async () => {
    const q = new ApprovalQueueImpl();
    const a = q.request(edit("a", "bob"), sig().signal);
    const b = q.request(req("b", "bob"), sig().signal);
    const c = q.request(req("c", "amy"), sig().signal);
    q.cancelAgent("bob", "removed");
    expect(await a).toEqual({ approved: false, reason: "removed" });
    expect(await b).toEqual({ approved: false, reason: "removed" });
    expect(await settled(c)).toBe("pending");
    expect(ids(q)).toEqual(["c"]);
  });
  it("cancelAgent for an agent with nothing pending is a no-op (no emit)", () => {
    const q = new ApprovalQueueImpl();
    const l = vi.fn();
    q.onChange(l);
    q.cancelAgent("nobody", "x");
    expect(l).not.toHaveBeenCalled();
  });
  it("cancelAll rejects everything", async () => {
    const q = new ApprovalQueueImpl();
    const a = q.request(edit("a"), sig().signal);
    const c = q.request(req("c", "bob"), sig().signal);
    q.cancelAll("stopped");
    expect(await a).toEqual({ approved: false, reason: "stopped" });
    expect(await c).toEqual({ approved: false, reason: "stopped" });
    expect(ids(q)).toEqual([]);
  });
  it("reset rejects pending and clears every agent's approve-all; edits ask again", async () => {
    const q = new ApprovalQueueImpl();
    const p0 = q.request(edit("0", "bob"), sig().signal);
    q.resolve("0", "approveAll");
    await p0;
    const p = q.request(req("cmd"), sig().signal);
    q.reset();
    expect((await p).approved).toBe(false);
    q.request(edit("e", "bob"), sig().signal);
    expect(ids(q)).toEqual(["e"]);
  });
});

describe("duplicate ids", () => {
  it("a reused id settles the first request as superseded", async () => {
    const q = new ApprovalQueueImpl();
    const first = q.request(req("dup"), sig().signal);
    q.request(req("dup", "bob"), sig().signal);
    expect(await first).toEqual({ approved: false, reason: "superseded" });
    expect(q.pending()).toHaveLength(1);
    expect(q.pending()[0].agent).toBe("bob");
  });
});

describe("onChange", () => {
  it("emits the full queue on every change and unsubscribes", async () => {
    const q = new ApprovalQueueImpl();
    const l = vi.fn();
    const off = q.onChange(l);
    const p = q.request(req("1"), sig().signal);
    expect(l).toHaveBeenLastCalledWith([expect.objectContaining({ id: "1" })]);
    q.resolve("1", "approve");
    await p;
    expect(l).toHaveBeenLastCalledWith([]);
    off();
    const n = l.mock.calls.length;
    q.request(req("2"), sig().signal);
    expect(l).toHaveBeenCalledTimes(n);
  });
  it("a throwing listener doesn't break the queue", async () => {
    const q = new ApprovalQueueImpl();
    q.onChange(() => {
      throw new Error("x");
    });
    const p = q.request(req("1"), sig().signal);
    q.resolve("1", "approve");
    expect(await p).toEqual({ approved: true });
  });
  it("pending() returns a fresh array each time", () => {
    const q = new ApprovalQueueImpl();
    q.request(req("1"), sig().signal);
    q.pending().pop();
    expect(q.pending()).toHaveLength(1);
  });
  it("auto-approved edits do not emit or appear in the queue", async () => {
    const q = new ApprovalQueueImpl();
    const p0 = q.request(edit("0"), sig().signal);
    q.resolve("0", "approveAll");
    await p0;
    const l = vi.fn();
    q.onChange(l);
    await q.request(edit("1"), sig().signal);
    expect(l).not.toHaveBeenCalled();
  });
});
