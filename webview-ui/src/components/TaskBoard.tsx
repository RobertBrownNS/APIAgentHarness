import { useState } from "react";
import { ChevronRight, Lock } from "lucide-react";
import type { AgentInfo, TaskStatus, TeamTask } from "@shared/protocol";
import { post } from "@/vscode";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NewTaskDialog } from "@/components/NewTaskDialog";
import { cn } from "@/lib/utils";

const NO_OWNER = "__none";
const GROUPS: { status: TaskStatus; label: string }[] = [
  { status: "in_progress", label: "In progress" },
  { status: "pending", label: "Pending" },
  { status: "completed", label: "Completed" },
];

function TaskRow({ task, agents }: { task: TeamTask; agents: AgentInfo[] }) {
  const [open, setOpen] = useState(false);
  const owners = agents.filter((a) => a.status !== "stopped" || a.name === task.owner).map((a) => a.name);
  if (task.owner && !owners.includes(task.owner)) owners.push(task.owner);
  const blocked = task.blockedBy.length > 0;

  return (
    <li className="rounded-md border bg-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full cursor-pointer items-start gap-1 px-2 py-1.5 text-left">
          <ChevronRight className={cn("mt-0.5 size-3 shrink-0 transition-transform", open && "rotate-90")} />
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">#{task.id}</span>
          <span className={cn("min-w-0 flex-1 break-words text-xs", task.status === "completed" && "text-muted-foreground line-through")}>
            {task.subject}
          </span>
        </CollapsibleTrigger>
        <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5 pl-6">
          {task.owner ? <Badge variant="secondary">{task.owner}</Badge> : <Badge>unassigned</Badge>}
          {blocked && (
            <Badge variant="warning" title="Waiting for these tasks to complete">
              <Lock /> blocked by {task.blockedBy.map((b) => `#${b}`).join(", ")}
            </Badge>
          )}
        </div>
        <CollapsibleContent>
          <div className="space-y-2 border-t px-2 py-1.5 pl-6">
            {task.description && <div className="whitespace-pre-wrap break-words text-xs">{task.description}</div>}
            <div className="flex flex-wrap gap-2">
              <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                Owner
                <Select
                  value={task.owner ?? NO_OWNER}
                  onValueChange={(v) => post({ type: "updateTask", id: task.id, owner: v === NO_OWNER ? null : v })}
                >
                  <SelectTrigger className="w-28" aria-label="Owner">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_OWNER}>unassigned</SelectItem>
                    {owners.map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                Status
                <Select value={task.status} onValueChange={(v) => post({ type: "updateTask", id: task.id, status: v as TaskStatus })}>
                  <SelectTrigger className="w-28" aria-label="Status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GROUPS.map((g) => (
                      <SelectItem key={g.status} value={g.status}>
                        {g.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>
            <div className="text-[10px] text-muted-foreground">Created by {task.createdBy}</div>
            {task.notes.length > 0 && (
              <div>
                <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Notes</div>
                <ul className="space-y-1">
                  {task.notes.map((n, i) => (
                    <li key={i} className="text-xs">
                      <span className="font-medium">{n.by}:</span>{" "}
                      <span className="whitespace-pre-wrap break-words">{n.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

export function TaskBoard({ tasks, agents }: { tasks: TeamTask[]; agents: AgentInfo[] }) {
  return (
    <div className="space-y-2 p-2">
      <div className="flex justify-end">
        <NewTaskDialog tasks={tasks} />
      </div>
      {tasks.length === 0 && <div className="px-1 py-3 text-center text-xs text-muted-foreground">No tasks yet.</div>}
      {GROUPS.map((g) => {
        const list = tasks.filter((t) => t.status === g.status);
        if (list.length === 0) return null;
        return (
          <section key={g.status}>
            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {g.label} ({list.length})
            </h3>
            <ul className="space-y-1">
              {list.map((t) => (
                <TaskRow key={t.id} task={t} agents={agents} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
