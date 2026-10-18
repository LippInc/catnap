# Build spec: compact-when-ready for OpenCode (plugin)

## What it must do (same behaviour as the Claude Code mod in ../../hooks/register.ts and ../../README.md)
1. Track the session's context use. After every assistant message, context = tokens.input + tokens.output + tokens.cache.read + tokens.cache.write of the latest assistant message (event `message.updated`, `properties.info`), as a percent of the model's window (`client.config.providers()` -> the model's `limit.context`; fall back to a `window` option).
2. At the soft line (default 50%) append ONE note to the model, once: finish the piece you are on properly (the function, the section, the test), save a short handoff file (what is done, what is next, the files involved), then call the `compact_now` tool with the handoff path and end your turn. At the strict line (default 60%) a stricter note ("save and compact now"), repeated every 2 points until it does. Inject the note through the cheapest route that reaches the model on its next step: `tool.execute.after` output, or `experimental.chat.system.transform`. Pick one, document why.
3. Register a model-callable tool `compact_now` with `tool()` from `@opencode-ai/plugin` (arg: `handoff` path string, optional `keep` string). It only records the request (sets a pending flag for that session) and answers "Compaction queued. End your turn now."
4. When the session goes idle (`session.idle` event) with a pending flag: call `client.session.summarize({ path: { id }, body: { providerID, modelID } })` with the ids from the latest assistant message (check the installed SDK's real signature in node_modules / the CLI's bundled types first), then send `client.session.promptAsync` (or `prompt`) with: "The conversation was just compacted at your request. Here is the handoff you wrote just before it (saved in <file>):\n\n<handoff>\n<file text>\n</handoff>\n\nCarry on exactly where you left off, with the next step it names. ..." (the file text trimmed and at most 32,000 characters, a longer one cut with a line `[cut here at 32000 characters: read the rest in <file> before you go on]` before `</handoff>`; a relative path is read from the session's folder; if the file is missing, unreadable or empty, the old text: "Your handoff: <file>. Read it first, then carry on exactly where you left off."). Clear the flag. Never loop: one compaction per request; if summarize fails twice, toast/log and give up.
5. Backstop: OpenCode's own auto-compaction stays on (config `compaction.auto`); document in the README how to let it run later if the version supports a reserve/buffer setting. Do not change the user's config files.
6. Options (plugin options or env): soft (50), strict (60), window override, off switch (`COMPACT_WHEN_READY_OFF=1`).
7. Log events (start, note, queued, compacted, continued, gave-up) as JSON lines to `~/.local/state/compact-when-ready-opencode/<session>.jsonl` or the OS equivalent; no network calls, no other writes.

## Files you own (write only these)
- `C:/Users/marti/Dev/Claude-tools/cwr-launch/ports/opencode/` : `index.ts` (the plugin), `package.json` (name `compact-when-ready-opencode`, MIT, peer dep `@opencode-ai/plugin`), `README.md` (install, options, what it touches, honest limits), `test/` (unit tests), `LIVE-TEST.md` (what you ran and saw). Do NOT commit; the reviewer commits.
- Scratch: `C:/Users/marti/AppData/Local/Temp/cwr-oc-test/` for the live test (config, data dirs, test project).

## Checks (each must be run and pass; each needs a planted failure that makes it fail first)
1. Unit tests (bun test or node --test) on the decision logic with fake events: no note under the line; exactly one soft note at 50%; strict notes every 2 points; compact_now sets the flag; idle with the flag calls summarize then prompt in that order; idle without the flag does nothing; a summarize error is retried once then gives up. Plant a bug (e.g. soft line off by 10) and show a test fails.
2. Type check against the installed `@opencode-ai/plugin` types.
3. LIVE test with the real OpenCode CLI 1.19.0 (already installed; `opencode` on PATH) and its FREE model `opencode/deepseek-v4.1-flash-free`:
   - Isolate it completely: set XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_CACHE_HOME to folders under the scratch dir, OPENCODE_CONFIG to a scratch config.json that loads the plugin from this folder, OPENCODE_DISABLE_CLAUDE_CODE=1, OPENCODE_DISABLE_AUTOUPDATE=1, OPENCODE_DISABLE_EXTERNAL_SKILLS=1; drop every inherited OPENCODE_* variable first. See C:/Users/marti/.claude/wrapper/opencode-delegate.ps1 for the exact env recipe that works on this machine (read it; do not run that wrapper).
   - Use a very low soft line (e.g. 2-5% of the window) so the loop triggers in a few steps, in a scratch test project with a few text files to read.
   - Drive it with the official CLI only: `opencode run ...` or `opencode serve` on localhost plus the local SDK/HTTP against that local server. NEVER call opencode.ai's servers directly or imitate the CLI. At most 2 opencode processes at a time.
   - Pass = the log shows note -> queued -> summarize done -> continue prompt sent, and the model's next turn reads the handoff and carries on. Record the evidence (log lines, event names) in LIVE-TEST.md. If `opencode run` exits before the idle step can fire, use `opencode serve`.
   - If the live test cannot pass, say exactly where it stopped and why; do not fake it.

## Rules
- Never read or change the OpenCode desktop app's data dir, ~/.config/opencode, ~/.local/share/opencode, or any user config; never read the main checkout C:/Users/marti/Dev/Claude-tools/self-compact or other worktrees except to read ../../hooks/register.ts and ../../README.md in THIS worktree for behaviour.
- Public material only (this is open-source code); no secrets in files.
- Long commands in the background, checked in steps under 4 minutes; no single blocking call over 40 minutes.
- Honesty: report failures and skipped checks plainly; "it did not work" is a valid result.
- Return: a summary under 250 words: what works, check results (with the planted failures), the live-test result, open issues.
