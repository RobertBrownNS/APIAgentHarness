import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { EFFORTS, LEAD, type TeamTask } from "../shared/protocol";
import type { TeamContext } from "./types";

/** Thrown for bad input or a refused action; the message goes back to the model. */
export class TeamToolError extends Error {}

const MAX_TASK_ROWS = 100;
const taskId =z.string().min(1).max(12);

const schemas = {
  spawn_teammate: z.object({
    name: z.string().min(1),
    role: z.string().min(1).max(200),
    prompt: z.string().min(1).max(16000),
    model: z.string().min(1).optional(),
    effort: z.enum(EFFORTS as [string, ...string[]]).optional(),
  }),
  stop_teammate: z.object({ name: z.string().min(1) }),
  send_message: z.object({ to: z.string().min(1), message: z.string().min(1).max(8000) }),
  task_create: z.object({
    subject: z.string().min(1).max(200),
    description: z.string().max(16000),
    blocked_by: z.array(taskId).optional(),
  }),
  task_list: z.object({}),
  task_get: z.object({ id: taskId }),
  task_update: z.object({
    id: taskId,
    status: z.enum(["pending", "in_progress", "completed"]).optional(),
    owner: z.string().min(1).nullable().optional(),
    add_blocked_by: z.array(taskId).optional(),
    note: z.string().max(2000).optional(),
  }),
  team_roster: z.object({}),
  present_plan: z.object({
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(4000),
    steps: z
      .array(z.object({ title: z.string().min(1).max(300), detail: z.string().max(2000).optional() }))
      .min(1)
      .max(30),
  }),
};

type TeamToolName = keyof typeof schemas;

const LEAD_ONLY: ReadonlySet<string> = new Set(["spawn_teammate", "stop_teammate", "present_plan"]);

export interface TeamToolContext {
  self: string;
  isLead: boolean;
  team: TeamContext;
  /** The tool_use id of this call (used as the plan's id). */
  toolUseId?: string;
  /** Aborts when the agent's turn is stopped (present_plan waits on the user). */
  signal?: AbortSignal;
}

export function isTeamTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(schemas, name);
}

const defs: Anthropic.Beta.BetaTool[] = [
  {
    name: "spawn_teammate",
    description:
      "Main only. Create a teammate that runs its own agent loop and starts working immediately on `prompt`. Teammates cannot see your conversation, so put everything they need in the prompt. Each teammate costs tokens: spawn only when parallel work pays off.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lowercase letters, digits and dashes, 2-24 chars, starting with a letter. Not main/lead/user/all/system." },
        role: { type: "string", description: "One line, e.g. 'Writes unit tests'" },
        prompt: { type: "string", description: "Full instructions for the teammate's first turn" },
        model: { type: "string", description: "Optional model id (default: the configured teammate model)" },
        effort: { type: "string", enum: [...EFFORTS], description: "Optional thinking effort" },
      },
      required: ["name", "role", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_teammate",
    description: "Main only. Stop a teammate and release its unfinished tasks. It stays in the roster as stopped.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      "Send a short message to a teammate (or main) by name, or to every other agent with to='all'. The recipient reads it when its current turn ends. You cannot message the user: reply in your own chat.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Agent name, or 'all'" },
        message: { type: "string" },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "task_create",
    description: "Add a task to the shared task list.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Short title" },
        description: { type: "string", description: "What needs to be done and how to know it is done" },
        blocked_by: { type: "array", items: { type: "string" }, description: "Ids of tasks that must finish first" },
      },
      required: ["subject", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "task_list",
    description: "List all tasks: id, status, owner, blockedBy, subject.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "task_get",
    description: "Show one task in full, including its notes.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "task_update",
    description:
      "Update a task. Claim it with owner=<your name> and status='in_progress' (fails if it is blocked or owned by someone else). Mark status='completed' only when the work is really done. Set owner to null to release it.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        owner: { type: ["string", "null"], description: "Agent name, or null to unassign" },
        add_blocked_by: { type: "array", items: { type: "string" } },
        note: { type: "string", description: "Progress note appended to the task" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "present_plan",
    description:
      "Main only, Plan mode only. Present a concrete plan for the user to approve. Blocks until the user decides: if approved the team leaves Plan mode (Normal or Auto) and you carry out the plan; if not, you get the user's feedback and stay in Plan mode. Teammates cannot call this; they report findings to main by message.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short plan title" },
        summary: { type: "string", description: "What will be done and why (a few sentences)" },
        steps: {
          type: "array",
          description: "Ordered steps, at most 30",
          items: {
            type: "object",
            properties: { title: { type: "string" }, detail: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "summary", "steps"],
      additionalProperties: false,
    },
  },
  {
    name: "team_roster",
    description: "List every agent on the team: name, role, model, status.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
].map((t) => ({ ...t, eager_input_streaming: true }) as Anthropic.Beta.BetaTool);

/** Tool definitions for an agent. Main-only tools are left out for teammates (and refused again in the executor). */
export function teamToolDefinitions(isLead: boolean): Anthropic.Beta.BetaTool[] {
  return defs.filter((d) => isLead || !LEAD_ONLY.has(d.name));
}

function parse<N extends TeamToolName>(name: N, input: unknown): z.infer<(typeof schemas)[N]> {
  const r = schemas[name].safeParse(input ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new TeamToolError(`Invalid input for ${name}: ${issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "bad input"}`);
  }
  return r.data as z.infer<(typeof schemas)[N]>;
}

const oneLine = (s: string, max = 200): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};

function taskLine(t: TeamTask): string {
  return `#${t.id} [${t.status}] owner=${t.owner ?? "-"} blockedBy=${t.blockedBy.length ? t.blockedBy.join(",") : "-"} ${oneLine(t.subject)}`;
}

function taskFull(t: TeamTask): string {
  const lines = [
    `#${t.id} ${t.subject}`,
    `status: ${t.status}`,
    `owner: ${t.owner ?? "-"}`,
    `blockedBy: ${t.blockedBy.length ? t.blockedBy.join(", ") : "-"}`,
    `createdBy: ${t.createdBy}`,
    `description: ${t.description || "(none)"}`,
  ];
  if (t.notes.length) lines.push("notes:", ...t.notes.map((n) => `- ${n.by}: ${n.text}`));
  return lines.join("\n");
}

function requireLead(name: string, ctx: TeamToolContext): void {
  if (LEAD_ONLY.has(name) && (!ctx.isLead || ctx.self !== LEAD)) {
    throw new TeamToolError(`${name} is only available to main.`);
  }
}

export async function runTeamTool(name: string, input: unknown, ctx: TeamToolContext): Promise<string> {
  if (!isTeamTool(name)) throw new TeamToolError(`Unknown team tool: ${name}`);
  // Enforce here, not just in the definition list: a model can call a tool it was not offered.
  requireLead(name, ctx);
  const { team, self } = ctx;

  switch (name as TeamToolName) {
    case "spawn_teammate": {
      const a = parse("spawn_teammate", input);
      const info = team.spawnTeammate(
        { name: a.name, role: a.role, prompt: a.prompt, model: a.model, effort: a.effort as never },
        self,
      );
      return `Spawned ${info.name} (${info.role}) on ${info.model}. It is working on your prompt now and will message you when its turn ends.`;
    }
    case "stop_teammate": {
      const a = parse("stop_teammate", input);
      team.removeTeammate(a.name, self);
      return `Stopped ${a.name}; its unfinished tasks were released.`;
    }
    case "send_message": {
      const a = parse("send_message", input);
      const live = team.roster().filter((r) => r.status !== "stopped" && r.name !== self);
      let targets: string[];
      if (a.to === "all") {
        targets = live.map((r) => r.name);
        if (!targets.length) throw new TeamToolError("There is nobody else on the team to message.");
      } else {
        if (a.to === self) throw new TeamToolError("You cannot message yourself.");
        if (a.to === "user") throw new TeamToolError("You cannot message the user; write your reply in your own chat.");
        const target = team.roster().find((r) => r.name === a.to);
        if (!target) throw new TeamToolError(`No agent named "${a.to}". Use team_roster to see who is on the team.`);
        if (target.status === "stopped") throw new TeamToolError(`${a.to} has been stopped and cannot receive messages.`);
        targets = [a.to];
      }
      const broadcast = a.to === "all";
      for (const to of targets) team.mailbox.send({ from: self, to, text: a.message, ...(broadcast ? { broadcast: true } : {}) });
      return broadcast
        ? `Broadcast delivered to ${targets.join(", ")}. Broadcasts do not wake idle agents; they read it on their next turn.`
        : `Message sent to ${targets.join(", ")}.`;
    }
    case "task_create": {
      const a = parse("task_create", input);
      const t = team.tasks.create({
        subject: a.subject,
        description: a.description,
        blockedBy: a.blocked_by,
        createdBy: self,
      });
      return `Created task.\n${taskFull(t)}`;
    }
    case "task_list": {
      parse("task_list", input);
      const ts = team.tasks.list();
      if (!ts.length) return "No tasks yet.";
      // Show open tasks first and cap the output so a long list can't flood the context.
      const rank = (t: TeamTask) => (t.status === "completed" ? 1 : 0);
      const sorted = [...ts].sort((x, y) => rank(x) - rank(y));
      const lines = sorted.slice(0, MAX_TASK_ROWS).map(taskLine);
      if (sorted.length > MAX_TASK_ROWS) lines.push(`... ${sorted.length - MAX_TASK_ROWS} more (use task_get)`);
      return lines.join("\n");
    }
    case "task_get": {
      const a = parse("task_get", input);
      const t = team.tasks.get(a.id);
      if (!t) throw new TeamToolError(`No task with id "${a.id}".`);
      return taskFull(t);
    }
    case "task_update": {
      const a = parse("task_update", input);
      if (a.owner) {
        const o = team.roster().find((r) => r.name === a.owner);
        if (!o || o.status === "stopped") throw new TeamToolError(`"${a.owner}" is not an active agent. Use team_roster to see who is on the team.`);
      }
      const before = team.tasks.get(a.id);
      const t = team.tasks.update(
        a.id,
        { status: a.status, owner: a.owner, addBlockedBy: a.add_blocked_by, note: a.note },
        self,
      );
      // Tell an agent when someone else hands it a task, otherwise it would never find out.
      if (t.owner && t.owner !== self && t.owner !== before?.owner) {
        const target = team.roster().find((r) => r.name === t.owner);
        if (target && target.status !== "stopped") {
          team.mailbox.send({ from: self, to: t.owner, text: `Task #${t.id} "${oneLine(t.subject, 80)}" was assigned to you.` });
        }
      }
      return `Updated.\n${taskFull(t)}`;
    }
    case "present_plan": {
      const a = parse("present_plan", input);
      if (team.mode !== "plan") {
        throw new TeamToolError(`present_plan is only available in Plan mode; the team is in ${team.mode} mode.`);
      }
      const res = await team.presentPlan(
        { id: ctx.toolUseId ?? `plan-${Date.now()}`, agent: self, title: a.title, summary: a.summary, steps: a.steps },
        ctx.signal ?? new AbortController().signal,
      );
      if (res.approved) return `Plan approved. Mode is now ${res.mode ?? "normal"}. Carry out the plan.`;
      return `Plan not approved. User feedback: ${res.feedback || "(none given)"}`;
    }
    case "team_roster": {
      parse("team_roster", input);
      return team
        .roster()
        .map((r) => `${r.name}${r.isLead ? " (main)" : ""} | ${r.role || "-"} | ${r.model} | ${r.status}`)
        .join("\n");
    }
  }
}
