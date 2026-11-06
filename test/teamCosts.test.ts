import { afterEach, describe, expect, it } from "vitest";
import { TaskError } from "../src/team/taskStore";
import { runTeamTool, TeamToolError } from "../src/team/teamTools";
import type { AgentInfo } from "../src/shared/protocol";
import { flush, makeTeam } from "./helpers/fakeTeam";

type T = ReturnType<typeof makeTeam>;
let cur: T | undefined;
function setup(over = {}): T {
  cur = makeTeam(over);
  return cur;
}
afterEach(() => {
  cur?.team.dispose();
  cur = undefined;
});

const u = (output: number, uncachedInput = 0, cacheRead = 0, cacheWrite = 0) => ({
  input: uncachedInput + cacheRead + cacheWrite,
  output,
  uncachedInput,
  cacheRead,
  cacheWrite,
});
const spawn = (t: T, name: string, prompt = "go") => t.team.spawnTeammate({ name, role: "r", prompt }, "main");
const mail = (t: T, from: string, to: string, text = "hi") => t.team.mailbox.send({ from, to, text });
const info = (t: T, n: string): AgentInfo => t.team.roster().find((r) => r.name === n)!;
const used = (t: T) => t.team.config().teamOutputTokens;
const ctx = (t: T, self = "main") => ({ self, isLead: self === "main", team: t.team });

describe("cost-weighted budget (task #32)", () => {
  it("output counts 1:1", () => {
    const t = setup();
    t.team.recordUsage("main", u(1000));
    expect(used(t)).toBe(1000);
  });
  it("uncached input counts 0.2x", () => {
    const t = setup();
    t.team.recordUsage("main", u(0, 1000));
    expect(used(t)).toBe(200);
  });
  it("cache writes count 0.2 x 1.25 = 0.25x", () => {
    const t = setup();
    t.team.recordUsage("main", u(0, 0, 0, 1000));
    expect(used(t)).toBe(250);
  });
  it("cache reads count 0.01x", () => {
    const t = setup();
    t.team.recordUsage("main", u(0, 0, 1000));
    expect(used(t)).toBe(10);
  });
  it("combines all four terms and rounds", () => {
    const t = setup();
    t.team.recordUsage("main", u(100, 500, 20000, 800));
    expect(used(t)).toBe(Math.round(100 + 0.2 * (500 + 1.25 * 800) + 0.01 * 20000));
    expect(used(t)).toBe(600);
    t.team.recordUsage("main", u(0, 1, 0, 0)); // 0.2 rounds to 0
    expect(used(t)).toBe(600);
  });
  it("accumulates across agents and calls", () => {
    const t = setup();
    spawn(t, "bob");
    t.team.recordUsage("main", u(100));
    t.team.recordUsage("bob", u(50, 100));
    expect(used(t)).toBe(170);
  });
  it("negative and NaN components are ignored", () => {
    const t = setup();
    t.team.recordUsage("main", { input: 0, output: -5, uncachedInput: NaN, cacheRead: -1, cacheWrite: NaN });
    expect(used(t)).toBe(0);
  });
  it("heavy cache reads cross the cap and pause everyone with reason budget", () => {
    const t = setup({ maxTeamOutputTokens: 1000 });
    spawn(t, "bob");
    expect(t.team.recordUsage("bob", u(0, 0, 90_000))).toBe(true); // 900
    expect(info(t, "bob").pausedReason).toBeUndefined();
    expect(t.team.recordUsage("bob", u(0, 0, 10_000))).toBe(false); // 1000
    for (const n of ["main", "bob"]) expect(info(t, n).pausedReason).toBe("budget");
    expect(t.team.allowModelCall("main")).toBe(false);
  });
  it("uncached input alone can cross the cap", () => {
    const t = setup({ maxTeamOutputTokens: 1000 });
    expect(t.team.recordUsage("main", u(0, 4990))).toBe(true);
    expect(t.team.recordUsage("main", u(0, 10))).toBe(false);
    expect(info(t, "main").pausedReason).toBe("budget");
  });
  it("the raw input field is not what counts", () => {
    const t = setup({ maxTeamOutputTokens: 1000 });
    expect(t.team.recordUsage("main", { input: 10_000_000, output: 1, uncachedInput: 0, cacheRead: 0, cacheWrite: 0 })).toBe(true);
    expect(used(t)).toBe(1);
  });
  it("a user send after the cap refills the weighted counter and unpauses", () => {
    const t = setup({ maxTeamOutputTokens: 100 });
    t.team.recordUsage("main", u(0, 0, 100_000));
    expect(info(t, "main").pausedReason).toBe("budget");
    t.team.send("main", "go on");
    expect(used(t)).toBe(0);
    expect(info(t, "main").pausedReason).toBeUndefined();
  });
});

describe("removed agent rule", () => {
  it("emits exactly one final stopped agent event at removal, then nothing from the agent", () => {
    const t = setup();
    spawn(t, "bob");
    const b = t.agents.get("bob")!;
    const n = t.emitted.length;
    t.team.removeTeammate("bob", "main");
    const after = t.emitted.slice(n).filter((m) => m.type === "agent" && m.agent.name === "bob");
    expect(after).toHaveLength(1);
    expect((after[0] as { agent: AgentInfo }).agent.status).toBe("stopped");
    const m = t.emitted.length;
    b.opts.events.item({ kind: "notice", id: "q", level: "info", text: "late" });
    b.opts.events.append("q", "x");
    b.opts.events.info({ ...b.info(), status: "running" });
    expect(t.emitted.length).toBe(m);
  });
  it("late events never resurrect a removed agent's status", () => {
    const t = setup();
    spawn(t, "bob");
    const b = t.agents.get("bob")!;
    t.team.removeTeammate("bob", "main");
    b.opts.events.info({ ...b.info(), status: "running" });
    expect(info(t, "bob").status).toBe("stopped");
  });
});

describe("passive idle reports from user-started turns (task #32)", () => {
  it("a spawn-prompt turn's idle report wakes the lead", async () => {
    const t = setup();
    spawn(t, "bob");
    t.agents.get("bob")!.last.finish({ lastText: "built it" });
    await flush();
    expect(t.lead.calls).toHaveLength(1);
    expect(t.lead.last.text).toContain("built it");
  });
  it("a turn the user started with a direct send reports to the lead without waking it", async () => {
    const t = setup();
    spawn(t, "bob");
    const b = t.agents.get("bob")!;
    b.last.finish();
    await flush();
    t.lead.last.finish();
    await flush();
    const before = t.lead.calls.length;
    t.team.send("bob", "do X");
    b.last.finish({ lastText: "did X" });
    await flush();
    expect(t.lead.calls.length).toBe(before);
    const waiting = t.team.mailbox.drain("main");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ idle: true, passive: true });
    expect(waiting[0].text).toContain("did X");
  });
  it("a mail-triggered turn's idle report is not passive", async () => {
    const t = setup();
    t.lead.busy = true;
    spawn(t, "bob");
    const b = t.agents.get("bob")!;
    b.last.finish();
    await flush();
    t.team.mailbox.drain("main");
    mail(t, "main", "bob", "work");
    b.last.finish({ lastText: "ok" });
    await flush();
    const r = t.team.mailbox.drain("main").filter((m) => m.idle);
    expect(r).toHaveLength(1);
    expect(r[0].passive).toBeUndefined();
  });
  it("an errored user-started turn is still reported", async () => {
    const t = setup();
    t.lead.busy = true;
    spawn(t, "bob");
    const b = t.agents.get("bob")!;
    b.last.finish();
    await flush();
    t.team.mailbox.drain("main");
    t.team.send("bob", "x");
    b.last.finish({ ended: "error", error: "boom" });
    await flush();
    const r = t.team.mailbox.drain("main").filter((m) => m.idle);
    expect(r[0].text).toMatch(/boom/);
  });
});

describe("task ownership status guard", () => {
  const mk = (t: T) => {
    t.team.tasks.create({ subject: "s", description: "", createdBy: "main" });
    t.team.tasks.update("1", { owner: "bob", status: "in_progress" }, "bob");
  };
  it("a non-owner cannot change the status of someone else's task", () => {
    const t = setup();
    mk(t);
    for (const status of ["completed", "pending"] as const) {
      expect(() => t.team.tasks.update("1", { status }, "amy")).toThrow(TaskError);
    }
    expect(t.team.tasks.get("1")).toMatchObject({ owner: "bob", status: "in_progress" });
  });
  it("the owner and privileged callers (user, lead) can", () => {
    const t = setup();
    mk(t);
    expect(t.team.tasks.update("1", { status: "completed" }, "bob").status).toBe("completed");
    expect(t.team.tasks.update("1", { status: "pending" }, "user").status).toBe("pending");
    t.team.tasks.update("1", { owner: "bob", status: "in_progress" }, "main");
    expect(t.team.tasks.update("1", { status: "completed" }, "main").status).toBe("completed");
  });
  it("a non-owner can still add a note without changing status", () => {
    const t = setup();
    mk(t);
    expect(() => t.team.tasks.update("1", { note: "fyi" }, "amy")).not.toThrow();
    expect(t.team.tasks.get("1")!.notes).toHaveLength(1);
  });
  it("is enforced through the task_update tool", async () => {
    const t = setup();
    spawn(t, "bob");
    spawn(t, "amy");
    mk(t);
    await expect(runTeamTool("task_update", { id: "1", status: "completed" }, ctx(t, "amy"))).rejects.toBeInstanceOf(TaskError);
  });
});

describe("tool input caps (task #32)", () => {
  it("send_message: 8000 ok, 8001 rejected", async () => {
    const t = setup();
    spawn(t, "bob");
    await expect(runTeamTool("send_message", { to: "bob", message: "x".repeat(8000) }, ctx(t))).resolves.toBeTruthy();
    await expect(runTeamTool("send_message", { to: "bob", message: "x".repeat(8001) }, ctx(t))).rejects.toBeInstanceOf(TeamToolError);
  });
  it("task_create description: 16000 ok, 16001 rejected", async () => {
    const t = setup();
    await expect(runTeamTool("task_create", { subject: "s", description: "x".repeat(16000) }, ctx(t))).resolves.toBeTruthy();
    await expect(runTeamTool("task_create", { subject: "s", description: "x".repeat(16001) }, ctx(t))).rejects.toBeInstanceOf(TeamToolError);
  });
  it("spawn prompt: 16000 ok, 16001 rejected without creating the agent", async () => {
    const t = setup();
    await expect(runTeamTool("spawn_teammate", { name: "aa", role: "r", prompt: "x".repeat(16000) }, ctx(t))).resolves.toBeTruthy();
    await expect(runTeamTool("spawn_teammate", { name: "bb", role: "r", prompt: "x".repeat(16001) }, ctx(t))).rejects.toBeInstanceOf(TeamToolError);
    expect(t.agents.has("bb")).toBe(false);
  });
  it("task_update note: 2000 ok, 2001 rejected", async () => {
    const t = setup();
    t.team.tasks.create({ subject: "s", description: "", createdBy: "main" });
    await expect(runTeamTool("task_update", { id: "1", note: "x".repeat(2000) }, ctx(t))).resolves.toBeTruthy();
    await expect(runTeamTool("task_update", { id: "1", note: "x".repeat(2001) }, ctx(t))).rejects.toBeInstanceOf(TeamToolError);
  });
});

describe("weighted budget worked example", () => {
  it("1000 out + 10000 uncached + 4000 write + 100000 read = 5000 output-equivalent; crossing pauses all", () => {
    const t = setup({ maxTeamOutputTokens: 5000 });
    spawn(t, "bob");
    expect(t.team.recordUsage("bob", u(1000, 10000, 100000, 4000))).toBe(false);
    expect(used(t)).toBe(5000);
    for (const n of ["main", "bob"]) expect(info(t, n).pausedReason).toBe("budget");
  });
  it("just under the cap (4999) does not pause", () => {
    const t = setup({ maxTeamOutputTokens: 5000 });
    spawn(t, "bob");
    expect(t.team.recordUsage("bob", u(999, 10000, 100000, 4000))).toBe(true);
    expect(used(t)).toBe(4999);
    expect(info(t, "bob").pausedReason).toBeUndefined();
  });
});
