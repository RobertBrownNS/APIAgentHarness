import type { TaskStatus, TeamTask } from "../shared/protocol";
import type { TaskStore } from "./types";

/** Thrown with a message suitable for showing to the model. */
export class TaskError extends Error {}

const STATUSES: TaskStatus[] = ["pending", "in_progress", "completed"];
const USER = "user";
const LEAD = "lead";
/** The user and the lead may override ownership and reopen finished tasks. */
const privileged = (by: string): boolean => by === USER || by === LEAD;

const clone = (t: TeamTask): TeamTask => ({ ...t, blockedBy: [...t.blockedBy], notes: t.notes.map((n) => ({ ...n })) });

export class TaskStoreImpl implements TaskStore {
  private tasks = new Map<string, TeamTask>();
  private nextId = 1;
  private listeners = new Set<(t: TeamTask[]) => void>();

  create(input: { subject: string; description: string; blockedBy?: string[]; createdBy: string }): TeamTask {
    const blockedBy: string[] = [];
    for (const id of input.blockedBy ?? []) {
      const dep = this.tasks.get(id);
      if (!dep) throw new TaskError(`Unknown task id "${id}" in blocked_by.`);
      if (dep.status !== "completed" && !blockedBy.includes(id)) blockedBy.push(id);
    }
    const task: TeamTask = {
      id: String(this.nextId++),
      subject: input.subject,
      description: input.description,
      status: "pending",
      blockedBy,
      createdBy: input.createdBy,
      notes: [],
    };
    this.tasks.set(task.id, task);
    this.emit();
    return clone(task);
  }

  get(id: string): TeamTask | undefined {
    const t = this.tasks.get(id);
    return t && clone(t);
  }

  list(): TeamTask[] {
    return [...this.tasks.values()].map(clone);
  }

  update(
    id: string,
    patch: { status?: TaskStatus; owner?: string | null; addBlockedBy?: string[]; note?: string },
    by: string,
  ): TeamTask {
    const t = this.tasks.get(id);
    if (!t) throw new TaskError(`No task with id "${id}".`);
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) {
      throw new TaskError(`Invalid status "${String(patch.status)}".`);
    }

    // Validate everything first, then apply, so a failed update changes nothing.
    const newDeps = [...t.blockedBy];
    for (const dep of patch.addBlockedBy ?? []) {
      const d = this.tasks.get(dep);
      if (!d) throw new TaskError(`Unknown task id "${dep}" in add_blocked_by.`);
      if (dep === id) throw new TaskError(`Task ${id} cannot block itself.`);
      if (d.status === "completed" || newDeps.includes(dep)) continue;
      if (this.reaches(dep, id)) throw new TaskError(`Task ${id} blocked by ${dep} would create a dependency cycle.`);
      newDeps.push(dep);
    }

    // Releasing an in-progress task (owner: null) puts it back to pending unless a status is given.
    const nextStatus = patch.status ?? (patch.owner === null && t.status === "in_progress" ? "pending" : t.status);
    let nextOwner = patch.owner === undefined ? t.owner : (patch.owner ?? undefined);
    if (t.status === "completed" && nextStatus !== "completed" && !privileged(by)) {
      throw new TaskError(`Task ${id} is completed; only the lead or the user can reopen it.`);
    }
    const claiming = nextStatus === "in_progress" && (t.status !== "in_progress" || nextOwner !== t.owner);
    if (patch.owner !== undefined && nextOwner && t.owner && nextOwner !== t.owner && by !== t.owner && !privileged(by)) {
      throw new TaskError(`Task ${id} is owned by ${t.owner}; only ${t.owner} can hand it over.`);
    }
    if (t.owner && by !== t.owner && !privileged(by) && nextStatus !== t.status) {
      throw new TaskError(`Task ${id} is owned by ${t.owner}; only ${t.owner} can change its status.`);
    }
    if (nextStatus === "in_progress" && (patch.status !== undefined || patch.owner !== undefined) && t.owner && by !== t.owner && !privileged(by) && (nextOwner ?? t.owner) !== by) {
      throw new TaskError(`Task ${id} is owned by ${t.owner}.`);
    }
    if (claiming && newDeps.length > 0) {
      throw new TaskError(`Task ${id} is blocked by ${newDeps.join(", ")}; finish those first.`);
    }
    if (nextStatus === "in_progress" && !nextOwner && by !== USER) nextOwner = by;

    t.blockedBy = newDeps;
    t.status = nextStatus;
    t.owner = nextOwner;
    if (patch.note && patch.note.trim()) t.notes.push({ by, text: patch.note.trim() });
    if (nextStatus === "completed") {
      for (const o of this.tasks.values()) o.blockedBy = o.blockedBy.filter((b) => b !== id);
    }
    this.emit();
    return clone(t);
  }

  /** Does `from` depend (transitively) on `target`? */
  private reaches(from: string, target: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(this.tasks.get(cur)?.blockedBy ?? []));
    }
    return false;
  }

  releaseOwner(agent: string): void {
    let changed = false;
    for (const t of this.tasks.values()) {
      if (t.owner === agent && t.status !== "completed") {
        t.owner = undefined;
        t.status = "pending";
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  onChange(listener: (tasks: TeamTask[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.tasks.clear();
    this.nextId = 1;
    this.emit();
  }

  private emit(): void {
    const snap = this.list();
    for (const l of [...this.listeners]) {
      try {
        l(snap);
      } catch {
        /* ignore */
      }
    }
  }
}
