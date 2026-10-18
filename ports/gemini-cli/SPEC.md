# Build spec: compact-when-ready for Gemini CLI (extension)

## What it must do (same behaviour as the Claude Code mod in ../../hooks/register.ts and ../../README.md, adapted)
Gemini CLI cannot start its own compression from a hook, but an AfterAgent hook can clear the conversation and send a new prompt. So the port is "clear and reload from the handoff":
1. Track context use: an AfterModel hook records `llm_response.usageMetadata.totalTokenCount` (or promptTokenCount; usage may come only on the last chunk) per session into a small state file. Window size is not given to hooks: take it from a built-in table of Gemini model windows by the `model` field if present, else an option (default 1,000,000).
2. At the soft line (default 50%) inject ONE note to the model (AfterTool or BeforeAgent `additionalContext`, whichever the docs confirm reaches the model): finish the piece you are on, save a handoff file (what is done, what is next, files), then call the `compact_now` tool and end your turn. At the strict line (default 60%) a stricter note, repeated every 2 points.
3. `compact_now` is a tool from a tiny MCP server bundled in the extension (stdio, Node, no network): it sets a pending flag (with the handoff path) in the state file and answers "Queued. End your turn now."
4. AfterAgent hook: if the flag is pending and `stop_hook_active` is false, return `{"decision":"deny","reason":"The conversation was just cleared at your request. Here is the handoff you wrote just before it (saved in <file>):\n\n<handoff>\n<file text>\n</handoff>\n\nCarry on exactly where you left off, with the next step it names. If the work was finished, or you were waiting on the user, say in a line or two where things stand and stop; do not start new work.","hookSpecificOutput":{"hookEventName":"AfterAgent","clearContext":true}}` and clear the flag. Otherwise allow. The file text is trimmed and at most 32,000 characters (a longer one is cut, with a line `[cut here at 32000 characters: read the rest in <file> before you go on]` before `</handoff>`); a relative path is read from the hook's `cwd`. If the file is missing, unreadable or empty, the reason is "The conversation was just cleared at your request. Your handoff: <file>. Read it first, then carry on exactly where you left off."
5. Backstop: leave Gemini CLI's own compression (`model.compressionThreshold`) alone; document it.
6. Options via env or a config file in the extension's state dir: soft, strict, window, off (`COMPACT_WHEN_READY_OFF=1`). Log events as JSON lines in the state dir. No network calls.

## Files you own (write only these)
- `C:/Users/marti/Dev/Claude-tools/cwr-launch/ports/gemini-cli/`: `gemini-extension.json` (name, version, mcpServers for the compact_now server using `${extensionPath}`), `hooks/hooks.json`, the hook scripts and the MCP server (Node, plain JS so no build step), `README.md`, `test/`, `LIVE-TEST.md`. Do NOT commit; the reviewer commits.
- Scratch: `C:/Users/marti/AppData/Local/Temp/cwr-gem-test/`.

## Checks (each run, each with a planted failure that makes it fail first)
1. Unit tests (node --test) feeding the hook scripts fake stdin payloads: no note under the line; one soft note; strict repeats; compact_now sets the flag; AfterAgent with the flag returns deny + reason + clearContext; with stop_hook_active true it does nothing; without the flag it allows. Plant a bug and show a test fails.
2. Validate the JSON files against the documented schema (read the docs in the installed package or github.com/google-gemini/gemini-cli docs/: hooks reference, extensions).
3. LIVE test, only if it can be done without any sign-in or paid key:
   - Install the official CLI: `npm install -g @google/gemini-cli` (allowed). Check whether this machine already has Gemini CLI credentials (e.g. `~/.gemini/oauth_creds.json` or a configured auth type). Do NOT read or print secret values; only check that the file exists.
   - If credentials exist: run in a scratch project with WORKSPACE-level config only (`<scratch>/.gemini/settings.json` with the hooks and mcpServers pointing at this folder), a very low soft line, headless (`gemini -p "..."`), and record whether note -> compact_now -> AfterAgent clear+continue happened (hook logs + output) in LIVE-TEST.md.
   - If no credentials, or the CLI asks to sign in, or only a paid API key is available: STOP the live part and write that in LIVE-TEST.md. Never start a sign-in flow, never use an API key file.
   - NEVER modify ~/.gemini (it belongs to other tools, including Antigravity); never run `gemini extensions install/link` against the user's home. If a user-level change looks unavoidable, stop and report.

## Rules
- Public material only. Never read the main checkout C:/Users/marti/Dev/Claude-tools/self-compact or other worktrees, except ../../hooks/register.ts and ../../README.md in THIS worktree for behaviour.
- Long commands in the background, checked in steps under 4 minutes; no single blocking call over 40 minutes.
- Honesty: report failures and skipped checks plainly.
- Return: a summary under 250 words: what works, check results (with planted failures), the live-test result or why it was skipped, open issues.
