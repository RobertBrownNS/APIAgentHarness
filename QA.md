# Manual QA script (Extension Development Host)

Prep: `npm install`, `npm run build`, open this folder in VS Code, press F5. In the new window open a small sample folder (a few text files, a `utils.ts`, a `README.md`, a `package.json`). Open View > Output > "Agent Harness" and keep it visible. Have a real API key ready.

For each step: expected result in **bold**.

## 1. Setup and bad key
1. Open the Agent Harness activity-bar icon. **Chat panel shows, with a hint that no key is set.**
2. Send "hi". **An error notice says to set the API key; no crash.** (Skip if `ANTHROPIC_API_KEY` is set in your environment; then launch VS Code without it.)
3. Run "Agent Harness: Set API Key" and enter `sk-ant-bogus`. Send "hi". **"Invalid API key" notice; the panel is usable again (not stuck busy).** Check the Output channel contains no key text.
4. Set the real key. Send "say hello in five words". **Text streams in; the Stop button turns back into Send afterwards.**
5. Run "Clear API Key", then "Set API Key" again. **Both work; the panel's credential hint updates.**

## 2. Streaming, thinking, markdown
1. Ask "explain what a closure is, with a code example". **Thinking summary (collapsible) then streamed markdown with a code block.**
2. Ask the agent to reply with `<script>alert(1)</script>` and `![x](https://example.com/a.png)`. **The HTML shows as text or is dropped; no alert; the image does not load (shows as text or a link).**

## 3. Read tools (auto-approved)
1. "List the files here and summarise README". **list_files and read_file cards appear without a prompt, with status done.**
2. "Search for TODO". **search_text card shows path:line results.**
3. "Read ../../something outside the folder" or an absolute path like `C:\Windows\win.ini`. **Error result "outside the workspace"; the agent explains.**
4. If you can: create a symlink or junction inside the folder pointing outside (`mklink /J link C:\Windows\Temp`), ask it to read `link/anything`. **Rejected as outside the workspace.**
5. Put a 5 MB file and a binary file (any .png) in the folder and ask it to read each. **"too large" and "looks binary" errors, no hang.**
6. Turn off `agentHarness.autoApproveReads`. Repeat 3.1. **Each read now shows an approval card.** Turn it back on.

## 4. Approval: approve, reject, approve all
1. "Add a hello() function to utils.ts". **edit_file card shows "awaiting approval" with the old/new text visible. Nothing changed on disk yet.**
2. Click Approve. **File edited (and visible in the open editor); card done.** Press Ctrl+Z in the editor. **The edit is undone.**
3. Ask for another edit. Click Reject with the reason "use arrow functions". **Card shows rejected; the agent acknowledges the reason and retries differently.** The file is unchanged.
4. Ask for an edit whose old_str cannot match (e.g. "change the text 'zzzqqq' to 'x' in README.md"). **After approval, an error result "not found"; the agent recovers.**
5. Ask for two edits in one turn (e.g. "add a comment at the top of two different files"). **Approvals come one at a time; both results are returned (no API error after).**
6. Ask for another edit and click "Approve all". **It runs. Later edits in the same chat run without a prompt.** (Check what happens with a run_command afterwards; record whether it asks. Intended behaviour: it should still ask.)
7. New Chat, then ask for an edit. **Prompts again (approve-all does not carry over).**

## 5. Commands
1. "Run `node --version`". **Approval card shows the exact command. After approval: exit code 0 and output in the card and in the Output channel.**
2. Reject a command. **Nothing runs (confirm in Task Manager / Output channel).**
3. "Run `ping -n 200 127.0.0.1`" with `agentHarness.commandTimeoutSec` set to 5. **After about 5 s: "killed: timed out after 5s". In Task Manager no `ping.exe` or `cmd.exe` is left.**
4. Run the ping again with timeout 120, and press Stop after a few seconds. **Command is killed (no leftover ping.exe), the card ends in error, the chat is usable again.**
5. "Run a command that prints 200000 lines" (`node -e "for(let i=0;i<200000;i++)console.log(i)"`). **Result is trimmed in the middle, the last line (199999) is still present, the UI stays responsive.**
6. "Run `echo %ANTHROPIC_API_KEY%`" (with the key in your environment). **Record whether the key is printed. It should not be.**

## 6. Stop and New Chat mid-run
1. Send a long request ("write a 1500 word essay") and press Stop mid-stream. **Stream stops, one "Stopped." notice, input re-enabled.** Send "continue". **Works, no API 400 error.**
2. Ask for an edit; while the approval card is showing press Stop. **Card becomes rejected/stopped, the chat is idle.** Send a follow-up. **Works.**
3. Ask for a long command and, while it is running, click New Chat. **Transcript clears immediately, the command is killed.** Send a new message. **Works with no ghost cards from the old run and no 400 error.**
4. Use the "New Chat" icon in the view title bar (not the in-panel button) after a conversation. **Transcript clears.**
5. Press Enter twice quickly on a message. **Only one request runs.**
6. Hide the panel (switch to Explorer) during a run, then reopen it. **Transcript and busy state are intact.**

## 7. Themes
1. Switch Color Theme to a light theme, a dark theme, and High Contrast (Ctrl+K Ctrl+T). **Backgrounds, text, buttons, borders, code blocks and badges follow the theme; text stays legible in every state (awaiting, error, rejected).**
2. Narrow the sidebar to its minimum width. **No horizontal page scroll; buttons wrap.**

## 8. Caching check
1. In one chat send two short messages in a row. In the Output channel, look at the `[usage]` lines. **The second turn shows `cache_read` greater than 0.** If it stays 0, note the model and the token counts (the prompt may be below the minimum cacheable size).
2. Change the effort/model in the header mid-chat. **Takes effect on the next turn without error** (cache will reset; that is expected).

## 9. Packaging
`npx vsce package --no-dependencies`, install the .vsix in a normal window, repeat sections 1 and 3. **Panel loads; no "UI has not been built" message.**
