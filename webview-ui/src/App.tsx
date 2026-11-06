import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { HostMessage } from "@shared/protocol";
import { LEAD } from "@shared/protocol";
import { post } from "@/vscode";
import { initialState, reducer } from "@/lib/state";
import { ApprovalsContext } from "@/lib/ui-context";
import { Header } from "@/components/Header";
import { Roster } from "@/components/Roster";
import { ChatPane } from "@/components/ChatPane";
import { ApprovalQueue } from "@/components/ApprovalQueue";
import { TaskBoard } from "@/components/TaskBoard";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const NARROW = 700;
type Tab = "team" | "chat" | "work";

function SectionTitle({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
      {count ? <Badge variant="warning">{count}</Badge> : null}
    </div>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [tab, setTab] = useState<Tab>("chat");
  const [narrow, setNarrow] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent<HostMessage>) => {
      if (e.data && typeof e.data === "object" && "type" in e.data) dispatch(e.data);
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < NARROW));
    ro.observe(el);
    setNarrow(el.clientWidth < NARROW);
    return () => ro.disconnect();
  }, []);

  const select = useCallback((agent: string) => {
    dispatch({ type: "select", agent });
    setTab("chat");
  }, []);
  const showQueue = useCallback(() => setTab("work"), []);

  const { agents, selected, approvals, tasks, config } = state;
  const current = agents.find((a) => a.name === selected) ?? agents.find((a) => a.name === LEAD);
  const anyBusy = agents.some((a) => a.status === "running" || a.status === "awaiting");
  const teammateCount = agents.filter((a) => !a.isLead && a.status !== "stopped").length;
  const solo = agents.length <= 1;
  const ctx = useMemo(
    () => ({ inline: solo, byId: Object.fromEntries(approvals.map((r) => [r.id, r])), showQueue }),
    [solo, approvals, showQueue],
  );
  // Once the right column has appeared it stays for the session, so the layout does not jump.
  const [rightSticky, setRightSticky] = useState(false);
  const wantRight = !solo || tasks.length > 0;
  useEffect(() => {
    if (wantRight) setRightSticky(true);
  }, [wantRight]);
  const showRight = wantRight || rightSticky;
  const unreadTotal = useMemo(
    () => Object.entries(state.unread).reduce((n, [k, v]) => (k === selected ? n : n + v), 0),
    [state.unread, selected],
  );

  const roster = (
    <Roster
      agents={agents}
      selected={selected}
      unread={state.unread}
      teammateCount={teammateCount}
      maxTeammates={config.maxTeammates}
      defaultModel={config.teammateModel || config.model}
      onSelect={select}
    />
  );
  const chat = current ? (
    <ChatPane agent={current} items={state.transcripts[current.name] ?? []} config={config} />
  ) : (
    <div className="p-4 text-center text-xs text-muted-foreground">{state.loaded ? "No agents." : "Starting…"}</div>
  );
  const queue = <ApprovalQueue approvals={approvals} transcripts={state.transcripts} onSelectAgent={select} />;
  const board = <TaskBoard tasks={tasks} agents={agents} />;

  return (
    <ApprovalsContext.Provider value={ctx}>
      <div ref={root} className="flex h-full min-w-0 flex-col">
        <Header
          config={config}
          anyBusy={anyBusy}
          totalTokens={agents.reduce((n, a) => n + a.inputTokens + a.outputTokens, 0)}
          approvals={approvals.length}
          solo={solo}
          agentNames={agents.map((a) => a.name)}
          teamFull={config.maxTeammates > 0 && teammateCount >= config.maxTeammates}
        />
        {narrow && (!solo || tasks.length > 0) ? (
          <>
            <div role="tablist" className="flex shrink-0 border-b bg-sidebar">
              {(
                [
                  ...(solo ? [] : [["team", "Team", unreadTotal, "default"] as const]),
                  ["chat", "Chat", 0, "default"] as const,
                  ["work", solo ? "Tasks" : "Approvals & tasks", approvals.length, "warning"] as const,
                ]
              ).map(([id, label, n, variant]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={cn(
                    "flex flex-1 cursor-pointer items-center justify-center gap-1 border-b-2 border-transparent px-2 py-1.5 text-xs hover:bg-accent",
                    tab === id && "border-ring font-semibold",
                  )}
                >
                  {label}
                  {n > 0 && <Badge variant={variant}>{n}</Badge>}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 bg-sidebar/0">
              {tab === "team" && !solo && <div className="h-full bg-sidebar">{roster}</div>}
              {tab === "chat" && chat}
              {tab === "work" && (
                <ScrollArea className="h-full">
                  {!solo && (
                    <>
                      <SectionTitle count={approvals.length}>Approvals</SectionTitle>
                      {queue}
                    </>
                  )}
                  <SectionTitle>Tasks</SectionTitle>
                  {board}
                </ScrollArea>
              )}
            </div>
          </>
        ) : (
          <div className="flex min-h-0 flex-1">
            {!solo && (
              <aside className="flex w-[220px] shrink-0 flex-col border-r bg-sidebar">
                <SectionTitle>Team</SectionTitle>
                <div className="min-h-0 flex-1">{roster}</div>
              </aside>
            )}
            <main className="min-w-0 flex-1">{chat}</main>
            {showRight && (
            <aside className="flex w-[340px] shrink-0 flex-col border-l bg-sidebar">
              {!solo && (
                <div className="flex min-h-0 basis-1/2 flex-col border-b">
                  <SectionTitle count={approvals.length}>Approvals</SectionTitle>
                  <ScrollArea className="min-h-0 flex-1">{queue}</ScrollArea>
                </div>
              )}
              <div className="flex min-h-0 flex-1 basis-1/2 flex-col">
                <SectionTitle>Tasks</SectionTitle>
                <ScrollArea className="min-h-0 flex-1">{board}</ScrollArea>
              </div>
            </aside>
            )}
          </div>
        )}
      </div>
    </ApprovalsContext.Provider>
  );
}
