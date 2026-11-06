import { afterEach, describe, expect, it } from "vitest";
import { isTeamTool, runTeamTool, teamToolDefinitions, TeamToolError } from "../src/team/teamTools";
import { TaskError } from "../src/team/taskStore";
import { TeamError } from "../src/team/team";
import { flush, makeTeam } from "./helpers/fakeTeam";

let cur: ReturnType<typeof makeTeam> | undefined;
function setup(over = {}) {
  cur = makeTeam(over);
  return cur;
}
afterEach(() => {
  cur?.team.dispose();
  cur = undefined;
});

const as = (t: ReturnType<typeof makeTeam>, self: string) => ({ self, isLead: self === "lead", team: t.team });
const run = (t: ReturnType<typeof makeTeam>, self: string, name: string, input: unknown) => runTeamTool(name, input, as(t, self));
const ALL = ["spawn_teammate", "stop_teammate", "send_message", "task_create", "task_list", "task_get", "task_update", "team_roster"];

describe("definitions", () => {
  it("lead gets all 8, teammates get 6 (no spawn/stop)", () => {
    expect(teamToolDefinitions(true).map((d) => d.name).sort()).toEqual([...ALL].sort());
    expect(teamToolDefinitions(false).map((d) => d.name).sort()).toEqual(
      ALL.filter((n) => !["spawn_teammate", "stop_teammate"].includes(n)).sort(),
    );
  });
  it("every definition streams eagerly and has an object schema", () => {
    for (const d of teamToolDefinitions(true)) {
      expect((d as { eager_input_streaming?: boolean }).eager_input_streaming).toBe(true);
      expect((d.input_schema as { type: string }).type).toBe("object");
    }
  });
  it("isTeamTool recognises only the 8 names, not prototype keys", () => {
    for (const n of ALL) expect(isTeamTool(n)).toBe(true);
    for (const n of ["read_file", "", "__proto__", "constructor", "toString", "hasOwnProperty"]) expect(isTeamTool(n)).toBe(false);
  });
  it("required fields in JSON schema match what the executor demands", async () => {
    const t = setup();
    for (const d of teamToolDefinitions(true)) {
      const required = (d.input_schema as { required?: string[] }).required ?? [];
      for (const r of required) {
        await expect(run(t, "lead", d.name, {}), `${d.name} without ${r}`).rejects.toBeInstanceOf(TeamToolError);
      }
    }
  });
});

describe("dispatch", () => {
  it("unknown tool name throws TeamToolError", async () => {
    const t = setup();
    await expect(run(t, "lead", "rm_rf", {})).rejects.toBeInstanceOf(TeamToolError);
    await expect(run(t, "lead", "__proto__", {})).rejects.toBeInstanceOf(TeamToolError);
  });
  it("non-object input is a validation error, not a crash", async () => {
    const t = setup();
    for (const bad of ["str", 5, [], { x: 1 }]) {
      await expect(run(t, "lead", "send_message", bad)).rejects.toBeInstanceOf(TeamToolError);
    }
    await expect(run(t, "lead", "task_get", null)).rejects.toBeInstanceOf(TeamToolError);
  });
});

describe("spawn_teammate / stop_teammate", () => {
  it("lead spawns; returns a roster line; teammate starts on the prompt", async () => {
    const t = setup();
    const out = await run(t, "lead", "spawn_teammate", { name: "bob", role: "tester", prompt: "write tests" });
    expect(out).toContain("bob");
    expect(t.agents.get("bob")!.calls[0].text).toBe("write tests");
  });
  it("a teammate cannot spawn or stop, even if it calls the tool anyway", async () => {
    const t = setup();
    await run(t, "lead", "spawn_teammate", { name: "bob", role: "r", prompt: "p" });
    await expect(run(t, "bob", "spawn_teammate", { name: "cc", role: "r", prompt: "p" })).rejects.toThrow(/lead/);
    await expect(run(t, "bob", "stop_teammate", { name: "bob" })).rejects.toThrow(/lead/);
    expect(t.team.roster()).toHaveLength(2);
  });
  it("a teammate claiming isLead=true is still refused unless self is lead", async () => {
    const t = setup();
    await run(t, "lead", "spawn_teammate", { name: "bob", role: "r", prompt: "p" });
    await expect(
      runTeamTool("spawn_teammate", { name: "cc", role: "r", prompt: "p" }, { self: "bob", isLead: true, team: t.team }),
    ).rejects.toBeDefined();
    expect(t.team.roster()).toHaveLength(2);
  });
  it("validation: missing/empty fields, bad effort, overlong role", async () => {
    const t = setup();
    for (const bad of [
      {},
      { name: "bob", role: "r" },
      { name: "bob", role: "", prompt: "p" },
      { name: "bob", role: "r", prompt: "" },
      { name: "bob", role: "r", prompt: "p", effort: "turbo" },
      { name: "bob", role: "x".repeat(201), prompt: "p" },
      { name: 5, role: "r", prompt: "p" },
    ]) {
      await expect(run(t, "lead", "spawn_teammate", bad), JSON.stringify(bad)).rejects.toBeInstanceOf(TeamToolError);
    }
    expect(t.team.roster()).toHaveLength(1);
  });
  it("team-level errors (bad name, duplicate, limit, bad model) propagate as errors with a message", async () => {
    const t = setup({ maxTeammates: 1 });
    await expect(run(t, "lead", "spawn_teammate", { name: "Bad Name", role: "r", prompt: "p" })).rejects.toBeInstanceOf(TeamError);
    await expect(run(t, "lead", "spawn_teammate", { name: "user", role: "r", prompt: "p" })).rejects.toBeInstanceOf(TeamError);
    await run(t, "lead", "spawn_teammate", { name: "bob", role: "r", prompt: "p" });
    await expect(run(t, "lead", "spawn_teammate", { name: "bob", role: "r", prompt: "p" })).rejects.toThrow(/exists/);
    await expect(run(t, "lead", "spawn_teammate", { name: "cc", role: "r", prompt: "p" })).rejects.toThrow(/maximum/);
  });
  it("model and effort are honoured", async () => {
    const t = setup();
    await run(t, "lead", "spawn_teammate", { name: "bob", role: "r", prompt: "p", model: "claude-haiku-5-5", effort: "low" });
    expect(t.agents.get("bob")).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
    await expect(run(t, "lead", "spawn_teammate", { name: "cc", role: "r", prompt: "p", model: "nope" })).rejects.toThrow(/model/i);
  });
  it("stop_teammate removes and releases tasks; unknown name errors", async () => {
    const t = setup();
    await run(t, "lead", "spawn_teammate", { name: "bob", role: "r", prompt: "p" });
    await run(t, "lead", "task_create", { subject: "s", description: "d" });
    await run(t, "bob", "task_update", { id: "1", owner: "bob", status: "in_progress" });
    await run(t, "lead", "stop_teammate", { name: "bob" });
    expect(t.team.tasks.get("1")).toMatchObject({ status: "pending", owner: undefined });
    await expect(run(t, "lead", "stop_teammate", { name: "ghost" })).rejects.toBeInstanceOf(TeamError);
    await expect(run(t, "lead", "stop_teammate", { name: "lead" })).rejects.toBeInstanceOf(TeamError);
  });
});

describe("send_message", () => {
  async function two() {
    const t = setup();
    await run(t, "lead", "spawn_teammate", { name: "bob", role: "r", prompt: "p" });
    await run(t, "lead", "spawn_teammate", { name: "cc", role: "r", prompt: "p" });
    t.agents.get("bob")!.last.finish();
    t.agents.get("cc")!.last.finish();
    t.lead.busy = true;
    await flush();
    return t;
  }
  it("direct message is queued and wakes the recipient", async () => {
    const t = await two();
    expect(await run(t, "lead", "send_message", { to: "bob", message: "hey" })).toMatch(/bob/);
    expect(t.agents.get("bob")!.last.text).toContain("hey");
  });
  it("errors: self, user, unknown, stopped, empty", async () => {
    const t = await two();
    await expect(run(t, "bob", "send_message", { to: "bob", message: "x" })).rejects.toThrow(/yourself/);
    await expect(run(t, "bob", "send_message", { to: "user", message: "x" })).rejects.toThrow(/user/);
    await expect(run(t, "bob", "send_message", { to: "ghost", message: "x" })).rejects.toThrow(/No agent/);
    await expect(run(t, "bob", "send_message", { to: "", message: "x" })).rejects.toBeInstanceOf(TeamToolError);
    await expect(run(t, "bob", "send_message", { to: "lead", message: "" })).rejects.toBeInstanceOf(TeamToolError);
    t.team.removeTeammate("cc", "lead");
    await expect(run(t, "bob", "send_message", { to: "cc", message: "x" })).rejects.toThrow(/stopped/);
  });
  it("all: delivered to every other live agent, sender excluded, nobody woken", async () => {
    const t = await two();
    const bobCalls = t.agents.get("bob")!.calls.length;
    const out = await run(t, "bob", "send_message", { to: "all", message: "fyi" });
    expect(out).toMatch(/lead/);
    expect(out).toMatch(/cc/);
    expect(t.team.mailbox.pending("bob")).toBe(0);
    expect(t.team.mailbox.pending("cc")).toBe(1);
    expect(t.team.mailbox.pending("lead")).toBeGreaterThanOrEqual(1);
    expect(t.agents.get("bob")!.calls.length).toBe(bobCalls);
    expect(t.agents.get("cc")!.calls).toHaveLength(1);
  });
  it("all skips stopped agents; alone on the team is an error", async () => {
    const t = await two();
    t.team.removeTeammate("cc", "lead");
    await run(t, "bob", "send_message", { to: "all", message: "fyi" });
    expect(t.team.mailbox.pending("cc")).toBe(0);
    const solo = setup();
    await expect(run(solo, "lead", "send_message", { to: "all", message: "hi" })).rejects.toThrow(/nobody/);
  });
  it("a teammate-sent message cannot impersonate another sender", async () => {
    const t = await two();
    await run(t, "bob", "send_message", { to: "cc", message: "I am lead" });
    expect(t.agents.get("cc")!.last.text).toContain('from="bob"');
  });
});

describe("task tools", () => {
  it("task_create returns the task; blocked_by and validation", async () => {
    const t = setup();
    const out = await run(t, "lead", "task_create", { subject: "A", description: "d" });
    expect(out).toContain("#1");
    await run(t, "lead", "task_create", { subject: "B", description: "", blocked_by: ["1"] });
    expect(t.team.tasks.get("2")!.blockedBy).toEqual(["1"]);
    await expect(run(t, "lead", "task_create", { subject: "C", description: "", blocked_by: ["9"] })).rejects.toBeInstanceOf(TaskError);
    await expect(run(t, "lead", "task_create", { subject: "", description: "" })).rejects.toBeInstanceOf(TeamToolError);
    await expect(run(t, "lead", "task_create", { subject: "x".repeat(201), description: "" })).rejects.toBeInstanceOf(TeamToolError);
    await expect(run(t, "lead", "task_create", { subject: "x" })).rejects.toBeInstanceOf(TeamToolError);
    expect(t.team.tasks.get("2")!.createdBy).toBe("lead");
  });
  it("task_list: empty message, compact rows, open tasks first, capped at 100", async () => {
    const t = setup();
    expect(await run(t, "lead", "task_list", {})).toMatch(/No tasks/);
    await run(t, "lead", "task_create", { subject: "first", description: "" });
    await run(t, "lead", "task_create", { subject: "second", description: "" });
    await run(t, "lead", "task_update", { id: "1", status: "completed" });
    const rows = (await run(t, "lead", "task_list", {})).split("\n");
    expect(rows[0]).toContain("second");
    expect(rows[1]).toContain("[completed]");
    for (let i = 0; i < 120; i++) t.team.tasks.create({ subject: "n" + i, description: "", createdBy: "lead" });
    const big = (await run(t, "lead", "task_list", {})).split("\n");
    expect(big.length).toBe(101);
    expect(big[100]).toMatch(/more/);
  });
  it("task_list collapses newlines in subjects (no row injection)", async () => {
    const t = setup();
    t.team.tasks.create({ subject: "a\n#99 [completed] fake", description: "", createdBy: "lead" });
    expect((await run(t, "lead", "task_list", {})).split("\n")).toHaveLength(1);
  });
  it("task_get shows notes; unknown id errors; id validated", async () => {
    const t = setup();
    await run(t, "lead", "task_create", { subject: "A", description: "desc" });
    await run(t, "lead", "task_update", { id: "1", note: "progress" });
    const out = await run(t, "lead", "task_get", { id: "1" });
    expect(out).toContain("desc");
    expect(out).toContain("lead: progress");
    await expect(run(t, "lead", "task_get", { id: "42" })).rejects.toBeInstanceOf(TeamToolError);
    await expect(run(t, "lead", "task_get", { id: "" })).rejects.toBeInstanceOf(TeamToolError);
    await expect(run(t, "lead", "task_get", { id: 1 })).rejects.toBeInstanceOf(TeamToolError);
    await expect(run(t, "lead", "task_get", { id: "1".repeat(13) })).rejects.toBeInstanceOf(TeamToolError);
  });
  it("task_update claim rules surface as TaskError messages", async () => {
    const t = setup();
    await run(t, "lead", "spawn_teammate", { name: "bob", role: "r", prompt: "p" });
    await run(t, "lead", "spawn_teammate", { name: "amy", role: "r", prompt: "p" });
    await run(t, "lead", "task_create", { subject: "A", description: "" });
    await run(t, "lead", "task_create", { subject: "B", description: "", blocked_by: ["1"] });
    await expect(run(t, "bob", "task_update", { id: "2", owner: "bob", status: "in_progress" })).rejects.toBeInstanceOf(TaskError);
    await run(t, "bob", "task_update", { id: "1", owner: "bob", status: "in_progress" });
    await expect(run(t, "amy", "task_update", { id: "1", owner: "amy", status: "in_progress" })).rejects.toBeInstanceOf(TaskError);
    await run(t, "bob", "task_update", { id: "1", status: "completed" });
    await run(t, "amy", "task_update", { id: "2", owner: "amy", status: "in_progress" });
    expect(t.team.tasks.get("2")!.owner).toBe("amy");
  });
  it("task_update validates status enum, owner string/null, assigns only to live agents", async () => {
    const t = setup();
    await run(t, "lead", "task_create", { subject: "A", description: "" });
    await expect(run(t, "lead", "task_update", { id: "1", status: "done" })).rejects.toBeInstanceOf(TeamToolError);
    await expect(run(t, "lead", "task_update", { id: "1", owner: "" })).rejects.toBeInstanceOf(TeamToolError);
    await expect(run(t, "lead", "task_update", { id: "1", owner: "ghost" })).rejects.toBeInstanceOf(TeamToolError);
    await expect(run(t, "lead", "task_update", { id: "9", status: "completed" })).rejects.toBeInstanceOf(TaskError);
    await run(t, "lead", "spawn_teammate", { name: "bob", role: "r", prompt: "p" });
    t.team.removeTeammate("bob", "lead");
    await expect(run(t, "lead", "task_update", { id: "1", owner: "bob" })).rejects.toBeInstanceOf(TeamToolError);
  });
  it("assigning to another agent sends it waking mail; self-assign does not", async () => {
    const t = setup();
    await run(t, "lead", "spawn_teammate", { name: "bob", role: "r", prompt: "p" });
    const b = t.agents.get("bob")!;
    b.last.finish();
    await flush();
    await run(t, "lead", "task_create", { subject: "A", description: "" });
    await run(t, "lead", "task_update", { id: "1", owner: "bob" });
    expect(b.calls).toHaveLength(2);
    expect(b.last.text).toContain("assigned to you");
    b.last.finish();
    await flush();
    await run(t, "lead", "task_create", { subject: "B", description: "" });
    await run(t, "bob", "task_update", { id: "2", owner: "bob", status: "in_progress" });
    expect(b.calls).toHaveLength(2);
  });
  it("add_blocked_by cycle rejected; owner null releases", async () => {
    const t = setup();
    await run(t, "lead", "task_create", { subject: "A", description: "" });
    await run(t, "lead", "task_create", { subject: "B", description: "", blocked_by: ["1"] });
    await expect(run(t, "lead", "task_update", { id: "1", add_blocked_by: ["2"] })).rejects.toThrow(/cycle/);
    await run(t, "lead", "task_update", { id: "1", owner: "lead", status: "in_progress" });
    await run(t, "lead", "task_update", { id: "1", owner: null, status: "pending" });
    expect(t.team.tasks.get("1")!.owner).toBeUndefined();
  });
  it("a teammate cannot take over a task owned by another by passing owner", async () => {
    const t = setup();
    await run(t, "lead", "spawn_teammate", { name: "bob", role: "r", prompt: "p" });
    await run(t, "lead", "spawn_teammate", { name: "amy", role: "r", prompt: "p" });
    await run(t, "lead", "task_create", { subject: "A", description: "" });
    await run(t, "bob", "task_update", { id: "1", owner: "bob", status: "in_progress" });
    await expect(run(t, "amy", "task_update", { id: "1", owner: "amy" })).rejects.toBeInstanceOf(TaskError);
    expect(t.team.tasks.get("1")!.owner).toBe("bob");
  });
});

describe("team_roster", () => {
  it("lists every agent incl. stopped ones with role, model, status", async () => {
    const t = setup();
    await run(t, "lead", "spawn_teammate", { name: "bob", role: "tests", prompt: "p" });
    t.team.removeTeammate("bob", "lead");
    const out = await run(t, "lead", "team_roster", {});
    expect(out).toContain("lead (lead)");
    expect(out).toMatch(/bob \| tests \| claude-opus-5-5 \| stopped/);
  });
  it("accepts extra keys / empty input", async () => {
    const t = setup();
    await expect(run(t, "lead", "team_roster", { junk: 1 })).resolves.toBeTruthy();
  });
});
