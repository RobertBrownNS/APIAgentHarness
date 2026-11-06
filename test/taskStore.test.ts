import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskError, TaskStoreImpl } from "../src/team/taskStore";

let s: TaskStoreImpl;
const mk = (subject = "t", blockedBy?: string[]) => s.create({ subject, description: "d", blockedBy, createdBy: "lead" });
beforeEach(() => {
  s = new TaskStoreImpl();
});

describe("create/get/list", () => {
  it("assigns sequential string ids and pending status", () => {
    const a = mk(),
      b = mk();
    expect([a.id, b.id]).toEqual(["1", "2"]);
    expect(a).toMatchObject({ status: "pending", blockedBy: [], notes: [], createdBy: "lead" });
    expect(a.owner).toBeUndefined();
  });
  it("returns copies, not live objects", () => {
    const a = mk();
    a.subject = "hacked";
    a.blockedBy.push("9");
    expect(s.get("1")!.subject).toBe("t");
    s.list()[0].notes.push({ by: "x", text: "y" });
    expect(s.get("1")!.notes).toEqual([]);
  });
  it("get unknown is undefined", () => expect(s.get("42")).toBeUndefined());
  it("create with unknown blockedBy throws TaskError and creates nothing", () => {
    expect(() => mk("x", ["7"])).toThrow(TaskError);
    expect(s.list()).toHaveLength(0);
  });
  it("blockedBy on a completed task is dropped; duplicates deduped", () => {
    mk();
    s.update("1", { status: "completed" }, "lead");
    expect(mk("b", ["1"]).blockedBy).toEqual([]);
    mk("c");
    expect(mk("d", ["3", "3"]).blockedBy).toEqual(["3"]);
  });
});

describe("claim rules", () => {
  it("claims an unowned task", () => {
    mk();
    const t = s.update("1", { owner: "bob", status: "in_progress" }, "bob");
    expect(t).toMatchObject({ owner: "bob", status: "in_progress" });
  });
  it("in_progress without owner assigns the caller", () => {
    mk();
    expect(s.update("1", { status: "in_progress" }, "bob").owner).toBe("bob");
  });
  it("rejects claiming a blocked task", () => {
    mk();
    mk("b", ["1"]);
    expect(() => s.update("2", { owner: "bob", status: "in_progress" }, "bob")).toThrow(TaskError);
    expect(s.get("2")!.status).toBe("pending");
    expect(s.get("2")!.owner).toBeUndefined();
  });
  it("rejects claiming a task owned by someone else", () => {
    mk();
    s.update("1", { owner: "bob", status: "in_progress" }, "bob");
    expect(() => s.update("1", { owner: "amy", status: "in_progress" }, "amy")).toThrow(TaskError);
    expect(() => s.update("1", { status: "in_progress" }, "amy")).toThrow(TaskError);
    expect(s.get("1")!.owner).toBe("bob");
  });
  it("a third party cannot steal by setting owner only", () => {
    mk();
    s.update("1", { owner: "bob" }, "lead");
    expect(() => s.update("1", { owner: "amy" }, "amy")).toThrow(TaskError);
    expect(s.get("1")!.owner).toBe("bob");
  });
  it("owner hands over to another name or null", () => {
    mk();
    s.update("1", { owner: "bob", status: "in_progress" }, "bob");
    expect(s.update("1", { owner: "amy" }, "bob").owner).toBe("amy");
    const released = s.update("1", { owner: null }, "amy");
    expect(released.owner).toBeUndefined();
    expect(released.status).toBe("pending");
  });
  it("user bypasses the owner check", () => {
    mk();
    s.update("1", { owner: "bob", status: "in_progress" }, "bob");
    expect(s.update("1", { owner: "amy" }, "user").owner).toBe("amy");
  });
  it("decision 7: lead bypasses the owner check", () => {
    mk();
    s.update("1", { owner: "bob", status: "in_progress" }, "bob");
    expect(s.update("1", { owner: "amy" }, "lead").owner).toBe("amy");
  });
  it("owner re-claiming own in-progress task is fine", () => {
    mk();
    s.update("1", { owner: "bob", status: "in_progress" }, "bob");
    expect(() => s.update("1", { owner: "bob", status: "in_progress" }, "bob")).not.toThrow();
  });
  it("a failed update changes nothing, including notes and deps", () => {
    mk();
    mk("b");
    s.update("2", { owner: "bob", status: "in_progress" }, "bob");
    expect(() => s.update("2", { owner: "amy", status: "in_progress", note: "n", addBlockedBy: ["1"] }, "amy")).toThrow();
    expect(s.get("2")).toMatchObject({ owner: "bob", blockedBy: [], notes: [] });
  });
  it("claiming fails when addBlockedBy (making it blocked) comes in the same patch", () => {
    mk();
    mk("b");
    expect(() => s.update("2", { addBlockedBy: ["1"], status: "in_progress" }, "bob")).toThrow(TaskError);
  });
  it("invalid status throws", () => {
    mk();
    expect(() => s.update("1", { status: "done" as never }, "bob")).toThrow(TaskError);
  });
  it("unknown id throws", () => expect(() => s.update("9", {}, "bob")).toThrow(TaskError));
});

describe("completion and dependencies", () => {
  it("completing removes the id from other tasks' blockedBy", () => {
    mk();
    mk("b", ["1"]);
    mk("c", ["1"]);
    s.update("1", { status: "completed" }, "lead");
    expect(s.get("2")!.blockedBy).toEqual([]);
    expect(s.get("3")!.blockedBy).toEqual([]);
  });
  it("a task stays blocked until all blockers are done", () => {
    mk();
    mk();
    mk("c", ["1", "2"]);
    s.update("1", { status: "completed" }, "lead");
    expect(s.get("3")!.blockedBy).toEqual(["2"]);
    s.update("2", { status: "completed" }, "lead");
    expect(s.get("3")!.blockedBy).toEqual([]);
  });
  it("unblocked task can then be claimed", () => {
    mk();
    mk("b", ["1"]);
    s.update("1", { status: "completed" }, "lead");
    expect(() => s.update("2", { owner: "bob", status: "in_progress" }, "bob")).not.toThrow();
  });
  it("addBlockedBy unknown id throws", () => {
    mk();
    expect(() => s.update("1", { addBlockedBy: ["5"] }, "bob")).toThrow(TaskError);
  });
  it("self dependency throws", () => {
    mk();
    expect(() => s.update("1", { addBlockedBy: ["1"] }, "bob")).toThrow(TaskError);
  });
  it("direct cycle throws", () => {
    mk();
    mk("b", ["1"]);
    expect(() => s.update("1", { addBlockedBy: ["2"] }, "bob")).toThrow(/cycle/);
  });
  it("transitive cycle throws and leaves state unchanged", () => {
    mk();
    mk("b", ["1"]);
    mk("c", ["2"]);
    expect(() => s.update("1", { addBlockedBy: ["3"] }, "bob")).toThrow(/cycle/);
    expect(s.get("1")!.blockedBy).toEqual([]);
  });
  it("adding a completed dependency is a no-op; duplicates deduped", () => {
    mk();
    mk();
    mk("c", ["1"]);
    s.update("2", { status: "completed" }, "lead");
    s.update("3", { addBlockedBy: ["2", "1"] }, "bob");
    expect(s.get("3")!.blockedBy).toEqual(["1"]);
  });
  it("diamond graph unblocks the join once all branches are done", () => {
    mk();
    mk("b", ["1"]);
    mk("c", ["1"]);
    mk("d", ["2", "3"]);
    for (const id of ["1", "2", "3"]) s.update(id, { status: "completed" }, "lead");
    expect(s.get("4")!.blockedBy).toEqual([]);
  });
});

describe("notes", () => {
  it("appends trimmed notes with author; ignores blank", () => {
    mk();
    s.update("1", { note: "  hi  " }, "bob");
    s.update("1", { note: "   " }, "bob");
    expect(s.get("1")!.notes).toEqual([{ by: "bob", text: "hi" }]);
  });
});

describe("releaseOwner", () => {
  it("unassigns non-completed tasks and resets them to pending", () => {
    mk();
    mk();
    mk();
    s.update("1", { owner: "bob", status: "in_progress" }, "bob");
    s.update("2", { owner: "bob", status: "in_progress" }, "bob");
    s.update("2", { status: "completed" }, "bob");
    s.update("3", { owner: "amy", status: "in_progress" }, "amy");
    s.releaseOwner("bob");
    expect(s.get("1")).toMatchObject({ owner: undefined, status: "pending" });
    expect(s.get("2")).toMatchObject({ owner: "bob", status: "completed" });
    expect(s.get("3")!.owner).toBe("amy");
  });
  it("emits only when something changed", () => {
    mk();
    const l = vi.fn();
    s.onChange(l);
    s.releaseOwner("nobody");
    expect(l).not.toHaveBeenCalled();
  });
  it("released task can be claimed by another", () => {
    mk();
    s.update("1", { owner: "bob", status: "in_progress" }, "bob");
    s.releaseOwner("bob");
    expect(s.update("1", { owner: "amy", status: "in_progress" }, "amy").owner).toBe("amy");
  });
});

describe("listeners and clear", () => {
  it("onChange fires on create/update/clear with a snapshot; unsubscribe works", () => {
    const l = vi.fn();
    const off = s.onChange(l);
    mk();
    s.update("1", { note: "x" }, "bob");
    expect(l).toHaveBeenCalledTimes(2);
    s.clear();
    expect(l).toHaveBeenCalledTimes(3);
    expect(l.mock.calls[2][0]).toEqual([]);
    off();
    mk();
    expect(l).toHaveBeenCalledTimes(3);
  });
  it("a throwing listener doesn't break the store or other listeners", () => {
    const l = vi.fn();
    s.onChange(() => {
      throw new Error("boom");
    });
    s.onChange(l);
    expect(() => mk()).not.toThrow();
    expect(l).toHaveBeenCalled();
  });
  it("listener snapshot cannot mutate the store", () => {
    s.onChange((t) => {
      t[0].subject = "evil";
    });
    mk();
    expect(s.get("1")!.subject).toBe("t");
  });
  it("clear resets id numbering", () => {
    mk();
    mk();
    s.clear();
    expect(mk().id).toBe("1");
  });
  it("failed update does not emit", () => {
    mk();
    const l = vi.fn();
    s.onChange(l);
    expect(() => s.update("9", {}, "x")).toThrow();
    expect(l).not.toHaveBeenCalled();
  });
});
