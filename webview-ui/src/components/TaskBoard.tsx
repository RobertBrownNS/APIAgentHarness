import { useState } from "react";
import { ChevronRight, CircleCheck, CircleDashed, Loader, Lock, type LucideIcon } from "lucide-react";
import type { AgentInfo, TaskStatus, TeamTask } from "@shared/protocol";
import { post } from "@/vscode";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { NewTaskDialog } from "@/components/NewTaskDialog";
import { cn } from "@/lib/utils";

const NO_OWNER = "__none";
const GROUPS: { status: TaskStatus; label: string; icon: LucideIcon; startOpen: boolean }[] = [
  { status: "in_progress", label: "In progress", icon: Loader, startOpen: true },
  { status: "pending", label: "Pending", icon: CircleDashed, startOpen: true },
  { status: "completed", label: "Completed", icon: CircleCheck, startOpen: false },
];

function TaskRow({ task, agents }: { task: TeamTask; agents: AgentInfo[] }) {
  const group = GROUPS.find((g) => g.status === task.status) ?? GROUPS[1];
  const Icon = group.icon;
  const owners = agents.filter((a) => a.status !== "stopped" || a.name === task.owner).map((a) => a.name);
  if (task.owner && !owners.includes(task.owner)) owners.push(task.owner);
  const blocked = task.blockedBy.length > 0;

  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status={task.status === "in_progress" ? "running" : task.status === "pending" ? "pending" : undefined}>
            <TraceIcon>
              <Icon />
            </TraceIcon>
            <TraceTitle className={cn("text-xs", task.status === "completed" && "line-through")}>
              <span className="font-mono opacity-70">#{task.id}</span> {task.subject}
            </TraceTitle>
            <TraceDescription className="text-xs">{task.owner ?? "unassigned"}</TraceDescription>
            {blocked && (
              <Lock className="size-3 shrink-0 text-warning" aria-label={`blocked by ${task.blockedBy.map((b) => "#" + b).join(", ")}`} />
            )}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="space-y-2 text-xs">
          {blocked && (
            <Badge variant="warning" title="Waiting for these tasks to complete">
              <Lock /> blocked by {task.blockedBy.map((b) => `#${b}`).join(", ")}
            </Badge>
          )}
          {task.description && <div className="whitespace-pre-wrap break-words text-foreground">{task.description}</div>}
          <div className="flex flex-wrap gap-2">
            <label className="flex items-center gap-1 text-[11px]">
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
            <label className="flex items-center gap-1 text-[11px]">
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
          <div className="text-[10px]">Created by {task.createdBy}</div>
          {task.notes.length > 0 && (
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wide">Notes</div>
              <ul className="space-y-1">
                {task.notes.map((n, i) => (
                  <li key={i}>
                    <span className="font-medium text-foreground">{n.by}:</span>{" "}
                    <span className="whitespace-pre-wrap break-words">{n.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

function Section({ group, tasks, agents }: { group: (typeof GROUPS)[number]; tasks: TeamTask[]; agents: AgentInfo[] }) {
  const [open, setOpen] = useState(group.startOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="mb-1 flex w-full cursor-pointer items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {group.label} ({tasks.length})
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="space-y-1.5 pl-1">
          {tasks.map((t) => (
            <li key={t.id}>
              <TaskRow task={t} agents={agents} />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
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
        return list.length === 0 ? null : <Section key={g.status} group={g} tasks={list} agents={agents} />;
      })}
    </div>
  );
}
