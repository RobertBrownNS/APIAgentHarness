# Agent Teams + full-editor panel: design (branch `agent-teams`)

Baseline: commit `b96a45c` (working sidebar chat, single agent). This round:
1. The chat moves from the sidebar into a **full editor tab** (WebviewPanel).
2. The extension supports **agent teams**: a lead agent plus teammates that each run their own Claude loop,
   share a task list, message each other, and send all edit/command approvals to **one shared queue**.

User decisions (fixed): the lead spawns teammates via tools **and** the user can add/remove them in the UI;
one shared approval queue; **nothing persists** (team lives as long as the editor tab / window).

Contract files (owner: manager, read-only for everyone else): `src/shared/protocol.ts` (v2), `src/team/types.ts`.
Need a change? Message `manager` with the exact diff and why; I update the file and tell everyone.

## Decisions after design review (manager; these override anything below)
1. **Cost caps:** `agentHarness.maxTurnIterations` (40): loop ends a turn with a notice after N model calls.
   `agentHarness.maxTeamOutputTokens` (1_500_000): `recordUsage` returns false past it → the agent ends its turn cleanly and
   Team pauses every agent (`pausedReason: "budget"`) with a notice. `allowModelCall` is checked before each request.
2. **Budgets in config:** SessionConfig carries autoTurnsLeft/maxAutoTurns/teamOutputTokens/maxTeamOutputTokens (throttled re-send).
3. **AgentInfo** carries inputTokens (input + cache read + cache write) and pendingMail.
4. **Broadcast** (`to: "all"`, any agent): delivered to every other agent, **never wakes** anyone. Passive mail (unblocked
   notices) doesn't wake either. Direct mail, assignment mail and idle reports do wake.
5. **Errors:** send() returns `error?`; Team reports a teammate's failed turn to the lead ("turn ended with an error: …").
6. **Stop = pause:** `stop {agent}` → status `paused`, `pausedReason: "user"`. A user send to agent X unpauses **only X**.
   Every user send (and `resume`) refills the budgets; refilling unpauses agents with `pausedReason: "budget"` only.
   **User sends to a busy agent are queued, never dropped** (see below), and go ahead of queued mail.
7. **Tasks:** `by` "user"/"lead" bypasses the owner check. Assigning to another agent sends it waking mail; completion sends
   passive "unblocked" mail to owners of newly unblocked tasks.
8. **newTeam** = dispose the Team and construct a **new** one (fresh stores); Team ignores callbacks after dispose (epoch).
9. **Pending approvals** show as `Agent Harness (N)` in the tab title and a status-bar count.
10. **Spawn cost:** model/effort optional, default teammateModel (or lead's model) at effort `medium`. The lead may choose any
    model in MODELS; every spawn adds a visible notice naming the model (lead's chat + roster).
11. `withFileLock` takes the caller's AbortSignal; an aborted waiter leaves the queue.
12. **Cost-weighted budget:** `maxTeamOutputTokens` counts *output-equivalent* tokens:
    `output + 0.2 × (uncachedInput + cacheWrite × 1.25) + 0.01 × cacheRead` (Opus/Sonnet price ratios). `teamOutputTokens`
    in SessionConfig reports this weighted total. Setting description says so.
13. An idle report from a turn the **user** started (user chatting directly with a teammate) is passive (doesn't wake the lead).
    A spawned teammate's first turn takes an auto-turn. Only the owner, the lead or the user can complete or reopen a task.
    Team tool inputs are length-capped (message 8k, description/prompt 16k, note 2k, subject 200 chars).

## How a team behaves
- Opening the panel creates a team with one agent, `lead` (model/effort from settings). The user chats with any agent by
  selecting it; `send {agent, text}` appears in that agent's chat as a `user` item and starts a turn.
- **Spawning:** the lead's `spawn_teammate` tool, or the user's "Add teammate" form. Teammate names: `^[a-z][a-z0-9-]{1,23}$`,
  unique, not `lead`/`user`/`all`. Max `agentHarness.maxTeammates` (default 5). Teammates cannot spawn teammates (no nesting).
  A spawned teammate starts immediately with its `prompt` as the first user message.
- **Messaging:** `send_message {to, message}` (to an agent name, or `all` for every other agent). The message is shown as a
  `message` item in sender's and recipient's chats and queued in the recipient's inbox.
  - When an agent is **idle** and has mail, Team starts a turn whose user message is the drained mail, formatted
    `<teammate-message from="x">…</teammate-message>` per message (user input goes through `send`, not the mailbox).
    Mail arriving **during** a turn waits until the turn ends, then starts the next turn.
  - When a **teammate** finishes a turn (end of loop, not stopped), Team sends the lead an automatic idle message
    (`idle: true`) with the last assistant text, clipped to 1500 chars. The lead's idle messages don't go anywhere.
- **Auto-turn budget** (stops runaway ping-pong spend): every mail-triggered turn calls `takeAutoTurn`. Budget
  `agentHarness.maxAutoTurns` (default 40) per team, refilled to full whenever the user sends any message. When spent,
  the agent goes `paused` instead of starting a turn; its mail stays queued. `resume {agent}` or any user send unpauses.
- **User sends to a busy agent** (decision, manager): never dropped. Team shows it at once as a `user` item, queues it,
  and starts the next turn with it as soon as the current turn ends, ahead of any queued mail (user text first, then
  `<teammate-message>` blocks, in one user message). AgentSession itself still ignores `send` while busy; queueing is Team's job.
  Team ignores events from a disposed/removed AgentSession so an unwinding run can't touch the UI of a new team.
- **Runtime services** (decision, manager): `configureAgentRuntime({secrets, output})` exported by loop.ts is called once in
  `activate()` before any session sends.
- **Stop** (`stop {agent}`): aborts that agent's turn and rejects its pending approvals; it becomes idle (mail stays queued,
  but no auto-turn starts until the user sends or resumes). `stop {}` does this for every agent.
- **Remove teammate** (lead tool `stop_teammate`, or UI): stop it, release its non-completed tasks, status `stopped`.
  Stopped agents stay in the roster and transcripts (greyed) for the rest of the team's life.
- **New team** (`newTeam`): stop everything, clear tasks/mail/approvals, fresh lead, snapshot.
- Closing the editor tab disposes the team (stops all agents). `retainContextWhenHidden` keeps it alive while the tab is hidden.

## Team tools (Claude tool definitions, all with `eager_input_streaming: true` + zod validation, like `tools.ts`)
Read-only/team tools never need approval (they only touch in-memory team state).
| Tool | Who | Input | Result |
|---|---|---|---|
| `spawn_teammate` | lead | name, role (one line), prompt (full instructions), model?, effort? | roster line or error |
| `stop_teammate` | lead | name | ok or error |
| `send_message` | all | to (name or `all`), message | "sent" or error (unknown/stopped agent) |
| `task_create` | all | subject, description, blocked_by? (ids) | the task |
| `task_list` | all | — | compact table: id, status, owner, blockedBy, subject |
| `task_get` | all | id | full task incl. notes |
| `task_update` | all | id, status?, owner? (name or null), add_blocked_by?, note? | the task or a TaskError message |
| `team_roster` | all | — | name, role, model, status of every agent |
Existing file/command tools (`read_file` … `run_command`) are available to every agent unchanged, except that
`edit_file`/`write_file` run inside `withFileLock(path)`.

Claiming rule: an agent claims a task by `task_update {id, owner: <self>, status: "in_progress"}`. TaskStore rejects claiming a
blocked task or one owned by someone else (the owner can hand it over by setting owner to another name or null).

## System prompts
- `buildSystemPrompt(root)` stays the base (stable → cacheable). `buildLeadPrompt` and `buildTeammatePrompt({name, role})`
  append a fixed team section. **Never put the roster or task list in the system prompt** (changes would break prompt caching);
  agents call `team_roster` / `task_list`.
- Lead section: you coordinate; break work into tasks; spawn teammates only when parallel work pays off (cost); keep the team
  small; teammates can't see your conversation, so put everything they need in `prompt`; you get idle messages when teammates
  finish a turn; stop teammates you no longer need.
- Teammate section: your name and role; claim tasks before working, update them when done (completed only when it really is),
  message the lead (or a teammate) for help or to challenge a design, keep messages short; you can't spawn teammates.

## Approvals
`ApprovalQueue` replaces `ApprovalBroker` (same rules: unknown decision = reject; abort rejects; duplicate id supersedes).
"Approve all edits" is **per agent**: it covers that agent's later `edit_file`/`write_file`; `run_command` always asks.
Approving-all releases that agent's other waiting edit requests. Every change emits `approvals` (full queue) so the
UI's queue is always the source of truth; the tool item in the agent's chat still shows status `awaiting`.

## Editor panel (host)
- Remove the sidebar view (`viewsContainers` / `views` / `agentHarness.chat`). Add command `agentHarness.open`
  ("Agent Harness: Open", also bound to a status-bar item `$(hubot) Agent Harness`), plus `newTeam`, `stopAll`, `setApiKey`,
  `clearApiKey`. Singleton `WebviewPanel` (`agentHarness.panel`) opened in `ViewColumn.Active`, `retainContextWhenHidden`,
  same CSP/nonce/assets as today; `localResourceRoots` = `webview-ui/dist`; icon `media/icon.svg`.
- No `WebviewPanelSerializer` (nothing persists). Disposing the panel disposes the Team.
- New settings: `agentHarness.teammateModel` (default `""` = same as lead), `agentHarness.maxTeammates` (5),
  `agentHarness.maxAutoTurns` (40). Existing settings stay.
- Validate every incoming WebviewMessage (zod), as now.

## Webview layout (full editor width)
Three areas, resizable or fixed widths, collapsing to a single column under ~700px:
- **Left: Team roster.** One row per agent: status dot (idle / running spinner / awaiting amber / paused / stopped grey),
  name, role, model, output tokens, unread badge (new items since last viewed). Click to select. "Add teammate" button →
  form (name, role, model select, effort select; first message optional). Per-agent menu: stop turn, resume, remove (teammates).
  Header: workspace name, New team, Stop all, Set API key (when no credentials).
- **Center: selected agent's chat.** Reuse MessageList/MessageBubble/ThinkingBlock/ToolCallCard/Notice/Composer.
  New `message` item renders as a compact card "from → to" (idle messages muted, collapsible). Composer sends to the
  selected agent; per-agent model/effort selects in the chat header.
- **Right: Approval queue (top) + Task board (bottom).** Queue: every pending request, oldest first, agent badge, the same
  diff/command rendering as ToolCallCard, Approve / Approve all edits (edit/write only) / Reject (+reason). Badge count on the
  area header; clicking a request selects that agent. Task board: grouped by status, each with id, subject, owner, blocked-by;
  expand for description + notes; "New task" form; owner select and status select per task (`updateTask`).
- State: one reducer over HostMessage v2 (`snapshot` replaces all; `item`/`append` per agent; `agent`, `tasks`,
  `approvals`, `config` replace). Draft per agent kept in `vscode.setState`.

## File ownership this round
| Area | Owner | Files |
|---|---|---|
| Team core | `core` | `src/team/team.ts`, `taskStore.ts`, `mailbox.ts`, `approvalQueue.ts`, `teamTools.ts`, `fileLock.ts` (delete `src/agent/approvals.ts` when unused) |
| Agent loop | `loop` | `src/agent/loop.ts`, `src/agent/systemPrompt.ts`, `src/agent/tools.ts` (lock hook only) |
| Panel host | `panel` | `src/ChatPanel.ts` (replaces `ChatViewProvider.ts`), `src/extension.ts`, root `package.json` (`contributes` only) |
| Webview | `webview` | `webview-ui/**` |
| Tests | `tester` | `test/**` |
| Review / QA | `reviewer` | `QA.md`; findings only, no source edits |
