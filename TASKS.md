# Shared task list: Agent Harness VS Code extension

Plan: `C:\Users\brown\.claude\plans\let-s-create-a-new-dynamic-cook.md`

## Rules for every agent
- Only edit rows you own. When you start a task, set Status to `in progress`; when you finish, set it to `done` (or `blocked`) and add a short note.
- Status values: `todo`, `in progress`, `done`, `blocked`.
- `src/shared/protocol.ts` is the contract between the extension host and the webview. **Only `host` edits it.** Anyone else who needs a change adds a row under "Requests" and works around it until it's handled.
- Do not edit files owned by another agent (see the Owns column). Put problems you find in them under "Requests".
- Do not commit to git. The manager commits.
- Do not change the root `package.json` except where your task says you can.

## Team communication
- Team: `host` (extension host + agent loop), `ui` (React/shadcn webview), `tests` (unit tests), `qa` (adversarial review + QA), `manager` (me: coordinates, commits, settles disputes).
- Talk to each other directly with the `SendMessage` tool (`to: "host" | "ui" | "tests" | "qa"`). If it isn't loaded, call `ToolSearch` with `select:SendMessage,ListAgents` first. Keep messages short and specific (file:line, what's wrong, what you propose).
- **Challenge designs.** If you think another agent's approach is wrong or risky, say so to them directly with a concrete alternative. The owner decides for their own files; if you can't agree, record both positions under "Design decisions" and message `manager`.
- **Review each other.** When you finish a chunk, message the reviewer named in the Review tasks below. Reviewers report findings to the owner by message and log them under "Findings"; the owner fixes or replies why not.
- Record any agreed contract or design change under "Design decisions" (one line, who agreed).

## Tasks

> **Moved:** open work now lives in Claude Code's built-in shared task list (tasks #1–#14). Use `TaskList` / `TaskGet` / `TaskUpdate` (load with `ToolSearch` query `select:TaskList,TaskGet,TaskUpdate,TaskCreate`). Set `in_progress` when you start, `completed` only when it builds and passes. Blocked tasks unblock automatically. Create a new task for follow-up work you discover. The table below is history only. This file still holds the rules, Design decisions and Findings.
>
> **File ownership transfers:** `src/agent/approvals.ts`, `tools.ts`, `client.ts`, `systemPrompt.ts` → host. `src/agent/paths.ts`, `textOps.ts` → tests.

| ID | Owner | Owns | Task | Status | Notes |
|----|-------|------|------|--------|-------|
| H1 | host | `src/agent/loop.ts` | Streaming manual agent loop (AgentSession) | done | AgentSession; exposes approvals, transcript, busy |
| H2 | host | `src/ChatViewProvider.ts` | Webview view provider: CSP+nonce HTML, message routing, transcript snapshot | done | |
| H3 | host | `src/extension.ts` | activate(): register provider + commands (setApiKey, clearApiKey, newChat, stop), config wiring | done | |
| H4 | host | — | `npm run build:ext` and `npx tsc --noEmit` pass | done | build:ext + tsc --noEmit pass |
| U1 | ui | `webview-ui/` (scaffold) | Vite + React + TS + Tailwind v4 + shadcn init, fixed output names, typecheck/build/watch scripts | done | built+typechecked, no eval in bundle |
| U2 | ui | `webview-ui/src/index.css` | Map shadcn tokens to `--vscode-*` theme variables | done | built+typechecked, no eval in bundle |
| U3 | ui | `webview-ui/src/components/` | Chat components: MessageList, MessageBubble (markdown), ThinkingBlock, ToolCallCard, ApprovalCard, Composer, Header | done | built+typechecked, no eval in bundle |
| U4 | ui | `webview-ui/src/App.tsx`, `src/vscode.ts` | State reducer from HostMessage, wiring to postMessage | done | built+typechecked, no eval in bundle |
| U5 | ui | — | `npm --prefix webview-ui run build` and `run typecheck` pass | done | built+typechecked, no eval in bundle |
| T1 | tests | `test/paths.test.ts` | Unit tests for `confinePath` (`..`, absolute, symlink, nested new file) | done | 39 tests (2 POSIX-only skipped on Windows); junction tests ran |
| T2 | tests | `test/textOps.test.ts` | Unit tests for replaceUnique (CRLF, not found, multiple), numberLines, truncateMiddle, findMatches, looksBinary | done | 51 tests |
| T3 | tests | `vitest.config.ts` | `npm test` passes; report any bugs found in `src/agent/paths.ts` / `textOps.ts` under Requests | done | `npm test` green: 88 passed, 2 skipped; tsc clean |
| X1 | ui | — | Review host's `loop.ts` + `ChatViewProvider.ts` from the webview's side: does it emit every HostMessage the UI relies on, in the right order, with stable ids? | done | no new findings beyond QA's; confirmed reset() no-snapshot and queued-tool "streaming" from the UI side |
| X2 | host | — | Review ui's `App.tsx` reducer + `vscode.ts`: handles snapshot/item/append/busy/config correctly, posts `ready`, approval flow matches loop | todo | |
| X3 | tests | — | Review `src/agent/tools.ts` for bugs (edge cases, Windows quirks, kill-tree, encoding); write tests for anything testable without vscode | done | test/tools.test.ts (vi.mock vscode); open bugs captured as it.fails; see Findings | |
| Q1 | qa | — | Adversarial design review of the agent loop vs. Claude API rules (stop reasons, tool_result pairing, append-only history, abort mid-tool, merge consecutive user msgs) | done | |
| Q2 | qa | — | Security review: path confinement, command execution, approvals can't be bypassed, CSP/nonce, no secrets in webview/logs | done | |
| Q3 | qa | — | End-to-end QA once H4+U5 are done: full `npm run build`, `npm test`, `npm run typecheck`, `vsce package` dry run; write a manual test script in `QA.md` | done | |
| R1 | manager | — | Final review against the plan; commit | todo | |

## Design decisions
<!-- - decision (agreed by: a, b) -->
- "Approve all" covers file edits/writes for the rest of the chat; run_command always asks. UI label becomes "Approve all edits". (manager)
- Webview CSP has no `https:` img-src; markdown never renders raw HTML or loads images. (manager, from qa)

## Findings
<!-- - [reviewer -> owner] file:line — issue — (open | fixed | wontfix: reason) -->
- [qa -> host] loop.ts:98-105,284 reset() races old run: stale tool_results pushed to new history, ghost items, busy flag clobbered (HIGH) — (fixed, verified by qa)
- [qa -> host] loop.ts:107-144 send() sets busy after await; double send runs two loops (HIGH) — (fixed, verified by qa)
- [qa -> host] loop.ts:98 reset() emits no snapshot; title-bar New Chat leaves stale UI (HIGH) — (fixed, verified by qa)
- [ui -> host] X1 re-review after fixes: reset/newChat snapshot, gen guards, approval round trip, ids and ordering all OK from the webview side. Only note: tools queued behind an awaiting one keep status "streaming" with input set; UI now shows these as "queued" (no host change needed). (done)
- [qa -> host] ChatViewProvider.ts:113 CSP img-src https: allows image-URL exfiltration (HIGH) — (fixed, verified by qa)
- [qa -> ui] MessageBubble.tsx:15 block markdown <img> (MED) — (fixed: img component replaced with text placeholder)
- [qa -> host] approvals.ts:24 unknown decision string approves; no validation of webview messages (MED); retry leaves duplicate partial UI items (MED); tools stuck "streaming" while queued (MED); empty assistant content append (MED); Math.random nonce (MED) — (fixed, verified by qa)
- [qa -> host] stop() double notice; no context-overflow handling; prompt says cannot touch outside files; hasCredentials ignores ant profile (LOW) — (fixed, verified by qa; hasCredentials ignoring ant profile: wontfix, first request decides)
- [qa -> host] approvals.ts:14 request() ignores abort; Stop during multi-tool turn hangs next approval — (fixed, verified by qa)
- [qa -> host] tools.ts:299 runCommand ignores already-aborted signal — (fixed, verified by qa)
- [qa -> host] tools.ts:310 no fallback if pipes never close after kill (timeout/Stop ineffective) — (fixed, verified by qa)
- [qa -> host] tools.ts:258 taskkill spawn has no error handler — (fixed, verified by qa)
- [qa -> host] tools.ts:287 output cap drops tail (the errors) — (fixed, verified by qa)
- [qa -> host] approvals.ts:23 approveAll also auto-runs shell commands — (fixed, verified by qa)
- [qa -> host] tools.ts:274 child env leaks ANTHROPIC_* keys — (fixed, verified by qa)
- [qa -> host] tools.ts:194 search_text regex can freeze extension host (ReDoS) — (partial: line cap + 10s budget between files; a single catastrophic regex on a <=2000-char line can still stall the host (wontfix, known limitation))
- [qa -> host] paths.ts:17 dangling symlink to outside passes confinePath — (fixed, verified by qa)
- [qa -> host] tools.ts:185/198 glob with .. / symlinks followed by search_text — (fixed, verified by qa)
- [qa -> host] package.json no untrustedWorkspaces capability; client.ts key not trimmed — (fixed, verified by qa)
- [tests -> host] tools.ts parseToolInput: `schemas[name]` resolves inherited keys, so name `constructor`/`__proto__`/`toString` throws TypeError instead of ToolError. Use `Object.hasOwn(schemas, name)`. Test: `it.fails` in test/tools.test.ts — (open)
- [tests -> host] tools.ts runCommand: stdin is an open pipe, so commands that read stdin (python, node REPL, `cat`, `sort`, `set /p`) hang until the timeout. Use `stdio: ["ignore","pipe","pipe"]`. Test: `it.fails` — (open)
- [tests -> host] tools.ts runCommand onData: `d.toString()` per chunk corrupts multi-byte chars split across chunks (U+FFFD). Use `child.stdout.setEncoding("utf8")` or a StringDecoder. Test: `it.fails` — (open)
- [tests -> host] tools.ts runCommand: Windows cmd/console tools emit the OEM code page, not UTF-8 (garbled non-ASCII); consider prefixing `chcp 65001>nul &` for cmd or documenting — (open, low)
- [tests -> host] tools.ts runCommand: `commandTimeoutSec` of 0/NaN/negative from settings makes the timer fire immediately; clamp in config reading — (open, low)
- [tests -> host] tools.ts writeFile: if path is an existing directory, `stat` succeeds and `openTextDocument` throws a raw VS Code error rather than ToolError("path is a directory") — (open, low)
- [tests -> host] tools.ts searchText:219 footer "stopped at 200 matches" shows when there are exactly 200 matches — cosmetic — (open, low)
- [tests -> qa,host] paths.ts: dangling symlink/junction to outside was accepted (qa finding) — (fixed by tests: realpathOfExisting now follows dangling links by hand, depth-limited; tests in paths.test.ts)
- [tests -> host] already fixed since qa's report and now covered by tests: pre-aborted signal in runCommand, ANTHROPIC_* env filtering, taskkill error handler. Tree kill on abort verified with a real grandchild process on Windows.

## Requests
<!-- Format: - [from -> to] request ... (status) -->
- [tests -> manager] fixed: `isInside` in `src/agent/paths.ts` used `rel.startsWith("..")`, wrongly rejecting in-workspace names like `..hidden`. Now checks `rel === ".."` or `".." + sep` prefix. No security impact (it failed closed). (done)

- [host] FIXED: qa L1-L11, qa tools #2/#4/#7/(a)-(g), tests tools bugs (hasOwn, stdin, utf8, tail, timeout NaN), dirty-doc save, approvals duplicate id. ACCEPTED/open: single-line ReDoS residual, hasCredentials ignores ant profile, hard-coded search excludes, partial text from retried turns stays in transcript.
