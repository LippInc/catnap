# compact-when-ready for Gemini CLI

A Gemini CLI extension, ported from the Claude Code mod [compact-when-ready](../../README.md). In a long session the model picks the moment to reset its context instead of hitting a limit mid-edit. It is told early, finishes the piece it is on, saves a handoff file, calls a `compact_now` tool and ends its turn. The extension then clears the conversation and sends the model a new prompt: read the handoff, carry on where you left off. You type nothing.

**Not the same as the Claude Code mod.** Gemini CLI has no hook that starts its own summary compression. What a hook can do is clear the conversation and send a new prompt, so this port is "clear and reload from the handoff": the model's memory after the reset is the handoff file plus what it reads again, not a summary. Anything that is not in a file is gone (the UI keeps showing the old transcript; the model does not see it).

Status: built against the hook and extension docs and the code of Gemini CLI 0.64.0. Verified against a real model (free AI Studio key, `gemini-3.8-flash`, headless) for the hook plumbing only: the hooks load from the linked extension, `AfterModel` delivers the token counts as assumed and the state file tracks them. Verified with the real CLI, extension, hooks and MCP server against a **scripted stand-in for the Gemini API (not a model)**: soft and strict notes reach the model as `<hook_context>` in the tool result, `compact_now` is called and queued, the `AfterAgent` deny with `clearContext` empties the history and the continuation prompt names the handoff, the scripted model reads it and finishes in the same `gemini -p` run, `COMPACT_WHEN_READY_OFF=1` does nothing, a second clear is refused, a subagent's readings are ignored. **Verified twice with a real model** (2026-10-18 00:08 and 00:13 UTC, `gemini-3-flash-preview` on the free key, headless, lines 25/33 on a 60,000 window): both times the model ignored the soft note, acted on the second strict note, wrote a handoff, called `compact_now`, the context was cleared, and the continuation read the handoff and finished the task correctly in the same `gemini -p` run. The first run's prompt told the model that notes in tool results come from installed tooling; the second's did not (its last reply then hit the free daily quota, after the task was done). Not verified: `gemini-3.8-flash` (its free daily quota of 20 requests ran out), the interactive screen, a long real session. See [LIVE-TEST.md](LIVE-TEST.md).

## What happens

- **Soft line (default 50% of the window):** one note on a tool result (or on the prompt, if a turn starts past the line). It tells the model to finish the piece it is on properly, then save a handoff file, call `compact_now` and end its turn.
- **Strict line (default 60%):** a stricter note, repeated every 2 points until the model does it.
- **`compact_now`** (a tool of the bundled MCP server): queues the reset and answers "Queued. End your turn now."
- **When that turn ends** (AfterAgent hook): the extension answers `deny` with `clearContext: true` and the reason *"The conversation was just cleared at your request. Here is the handoff you wrote just before it (saved in \<file\>): \<handoff\>...\</handoff\> Carry on exactly where you left off, with the next step it names. ..."*: the text of the handoff file itself (trimmed, at most 32,000 characters; a longer one is cut with a line that names the file), because models often skipped "read it first" and started from nothing. A relative path is read from the session folder the hook reports. If the file is missing, unreadable or empty, the reason is the short one: *"... Your handoff: \<file\>. Read it first, then carry on exactly where you left off."* Gemini CLI clears the model's history and sends that reason as the next prompt.
- **Gemini CLI's own compression** is the backstop. The extension leaves `model.compressionThreshold` alone. Its default is 0.5, which is the same point as the default soft line, so Gemini CLI may compress at about the moment the first note arrives. To let the notes come first, set `model.compressionThreshold` to 0.7 or more in your own `settings.json` (restart needed), or move the extension's lines below it. A compression done by Gemini CLI shows up as a fall of 20 points or more in the token reading, which starts the note cycle over. (The `PreCompress` hook is deliberately not used: Gemini CLI fires it at every compression check, not only when it compresses.)
- **When a clear or a compression frees almost nothing,** the notes wait. That happens when the part of a session that never goes away (the system prompt, tools, GEMINI.md) is itself near the lines. So after either one, both lines sit at least 10 points above the first reading after it, for that round, with one `high-floor` log line. A normal clear leaves a few percent, so the lines stay as set. The Claude Code mod has the same rule since 0.3.5, after a live run there compacted twice in under a minute and queued a third.

Differences from the Claude Code mod: no turn-end "ask" when a turn ends past the strict line without `compact_now`; no auto line (Gemini CLI has its own threshold, above); the percentage is computed from token counts the model reports, not given by the host.

## Install

Needs Gemini CLI with extension and hook support (built against 0.64.0) and Node 20 or later. No dependencies, no build step.

```bash
gemini extensions install <path or git URL of this folder>
```

(`gemini extensions link <path>` works for development.) Restart Gemini CLI afterwards; the install asks you to consent to the hooks. Review the source first: the logic is `lib/cwr.cjs`, `hooks/hook.cjs` and `mcp/server.cjs`.

To let `compact_now` run without a prompt each time, allow it with a rule of your own. Extensions cannot grant themselves `allow`. For example in a policy file you pass with `--policy`, or in your user policies:

```toml
[[rule]]
mcpName = "compact-when-ready"
toolName = "compact_now"
decision = "allow"
priority = 100
```

Without it, Gemini CLI asks you to confirm the first `compact_now` call (and in headless `-p` mode an "ask" decision is treated as deny, per the policy-engine docs).

## Settings

| Option | Default | Environment variable | `config.json` key |
| :- | :- | :- | :- |
| Soft line, percent | 50 | `COMPACT_WHEN_READY_SOFT` | `soft` |
| Strict line, percent | 60 | `COMPACT_WHEN_READY_STRICT` | `strict` (or `threshold`) |
| Context window, tokens | model table, else 1,000,000 | `COMPACT_WHEN_READY_WINDOW` | `window` |
| Off | on | `COMPACT_WHEN_READY_OFF=1` | `"off": true` |
| State folder | `~/.gemini/state/compact-when-ready` | `COMPACT_WHEN_READY_STATE_DIR` | |

- Order: defaults, then `config.json` in the state folder (re-read on every hook call, no restart), then environment variables.
- A soft line at or above the strict line turns the soft note off.
- **Window:** Gemini CLI does not tell hooks the window size. The extension uses a built-in table keyed by the `llm_request.model` hook field (`gemini-1.5-pro` 2,097,152; other `gemini-*` models 1,048,576) and 1,000,000 for a model it does not know. An explicitly set window (environment or `config.json`) wins over the table.
- **Off:** with `COMPACT_WHEN_READY_OFF` set, every hook does nothing and `compact_now` answers that it is off and queues nothing.

## Files it writes

All in the state folder, nothing in `settings.json`, `GEMINI.md` or the project:

- `<session id>.json`: tokens, model, whether the soft note went out, when the last clear happened. Files of sessions untouched for 7 days are deleted at `SessionStart` (plain files in this folder only; `config.json`, `queued.json` and the log are never touched).
- `<session id>.pending.json`: the queued reset (handoff path, `keep`, time). Only the `compact_now` branch writes it, so hooks that run in parallel and rewrite the session state cannot lose it. `AfterAgent` removes it when it clears (or refuses); a new user turn (`BeforeAgent`) drops one left over from a cancelled turn; one older than 10 minutes expires.
- `queued.json`: written by the MCP server on `compact_now`. The server cannot know which session called it, so the hooks claim it: the AfterTool hook (which sees the session id and the tool's own arguments) normally, the AfterAgent hook as a fallback if the file is under 10 minutes old and was written from the same working folder. The manifest sets no `cwd` for the server, so it runs in the folder Gemini CLI runs in (the project folder, which is also the hooks' `cwd`).
- `events.jsonl`: one JSON object per event (`soft-note`, `strict-note`, `queued`, `cleared`, `clear-refused`, `clear-skipped`, `pending-dropped`, `pending-expired`, `reading-ignored`, `compacted-elsewhere`, `state-pruned`, `hook-error`, ...), trimmed to the last 1000 lines at 256 KB.
- `config.json`: optional, yours.

## How it works

| Piece | What it does |
| :- | :- |
| `hooks/hooks.json` | Registers one script for `SessionStart`, `BeforeAgent`, `AfterModel`, `AfterTool`, `AfterAgent`. |
| `AfterModel` | Records `llm_response.usageMetadata.totalTokenCount` (falls back to prompt + candidates, then prompt only) for the session. Seen live (0.64.0): it fires once per streamed chunk (2 to 5 chunks per response), every chunk carries `usageMetadata` (a running total that includes thinking tokens), and only the last chunk has `finishReason`; the hook script answers at once for chunks that are not the last. Only readings of the main chat count: its first message is Gemini CLI's environment context (`This is the Gemini CLI. We are setting up the context for our chat...`), a subagent chat's is not, and subagents share the session id and the model. Once the main chat has been seen, readings from other chats are ignored (`reading-ignored`). A fall of 20 points or more between two readings of the main chat, with nothing queued, starts the note cycle over. |
| `AfterTool` / `BeforeAgent` | Adds the soft or strict note as `additionalContext` (appended to the tool result, or to the prompt for that turn). While a reset is queued, other tool results get a reminder to end the turn. Notices `compact_now` and writes the session's pending file. A new turn (`BeforeAgent`) drops a pending reset left over from an earlier turn (`pending-dropped`), so a cancelled `compact_now` cannot end or clear the user's next turn. |
| `AfterAgent` | If a reset is pending and `stop_hook_active` is false: returns `deny` + reason + `clearContext`, resets the session state, removes the pending file. A second clear within 2 minutes of the previous one is refused while the reading is below the soft line or has not grown 10 points past its first reading after the previous clear (`clear-refused`, flag dropped): Gemini CLI's headless loop passes `stop_hook_active: true` only for the immediate continuation, never for the turn ends after it. If `stop_hook_active` is true it does nothing and the flag stays until the next turn starts (then it is dropped). Without a pending reset it allows. |
| `mcp/server.cjs` | stdio MCP server (hand-written JSON-RPC, no SDK) with the one tool `compact_now(handoff, keep?)`. |

Hooks always exit 0 and print one JSON line; an internal error is logged and the CLI carries on.

**Cost.** Gemini CLI waits for each hook, and starts every hook as its own process. On Windows it does so through PowerShell, which alone takes about 0.4 s per hook (measured: 0.39 to 0.48 s median per call through `powershell -Command`, against about 0.05 s for the Node script itself). `AfterModel` fires per streamed chunk, so a response costs roughly 1 to 2 s of waiting on Windows, plus one hook each for the start of the session, each turn, each tool result and the end of each turn. The extension cannot reduce that from its side: Gemini CLI does not apply a `matcher` to `AfterModel`. Linux and macOS start hooks without PowerShell and should be much cheaper (not measured). A way around it, not built because it could not be tested live: read the token counts from the session transcript file (`transcript_path`) in the `AfterTool` / `BeforeAgent` hooks and drop `AfterModel`.

## What it can reach

No network calls, no model calls of its own, no processes started. It reads the hook payload on stdin, its own state files and the `COMPACT_WHEN_READY_*`, `GEMINI_CLI_HOME` and home-folder variables to find them. It writes only the files above. It reads no keys or credentials. The only conversation text it handles is the two fields the model passes to `compact_now`.

## Tests

```bash
node --test test/hooks.test.cjs     # 58 tests: the hook script and MCP server run as child processes
node test/validate.cjs              # checks gemini-extension.json and hooks/hooks.json against the documented shapes
```

(`node --test test/` does not work on Windows with Node 24; name the file.) The unit tests feed fake stdin payloads and cover: no note under the line, one soft note, strict repeats, `compact_now` setting the pending file (through the hook and through the MCP server started as the manifest says, in a project folder that is not the extension folder), AfterAgent deny + reason + `clearContext`, `stop_hook_active`, no flag, off, config and window handling, a stale session-state write and really parallel hook processes not losing the pending reset, subagent readings, repeated clears, a cancelled turn's leftover reset (dropped at the next turn, expired after 10 minutes) and pruning of old session files. Results, planted-failure checks and what was and was not run live are in [LIVE-TEST.md](LIVE-TEST.md).

## Limits

- The model has to follow the notes; Gemini CLI offers no way to force a reset.
- A cleared conversation keeps only what is in files. The `keep` field of `compact_now` is stored for the log but the reload prompt carries the handoff file's text (cut at 32,000 characters), or only names its path when the file cannot be read.
- Token readings come from the last model response. Subagent chats fire the same hooks with the same session id; their readings are ignored once the main chat has been seen (see `AfterModel` above). If a future Gemini CLI stops starting the main chat with the environment context, no reading is ever classified as main and every reading counts (the pre-fix behaviour, where a subagent can look like a compression).
- `AfterTool` does not say which chat made a tool call. While a subagent is running (its model readings came after the main chat's last one) tool results get no note, so a note is not used up on a result only the subagent sees; `invoke_agent`'s own result, or the main chat's next reading, ends that. A note can therefore come a step later than the line.
- If the model calls `compact_now` in the turn that follows a reset (`stop_hook_active` true), that turn is not cleared. The flag stays until the next turn starts and is then dropped. A `compact_now` in a later turn end of the same headless run (where Gemini CLI no longer passes `stop_hook_active`) is refused within 2 minutes of the last clear unless the context is past the soft line and has grown by 10 points since its first reading after that clear. A refused clear just lets the turn end: the model stops with its reply and nothing is cleared.
- A pending reset is dropped when the next user turn starts, or after 10 minutes. A `compact_now` the user cancelled therefore does not clear a later turn.
- Hook and extension APIs are young and change between releases; this was written against 0.64.0.

## License

MIT, like the original. Not affiliated with Google.
