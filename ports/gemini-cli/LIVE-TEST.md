# Live test: compact-when-ready for Gemini CLI

Gemini CLI 0.64.0 (installed with `npm install --prefix <scratch> @google/gemini-cli`, not globally), Windows 11, Node 24.14. Dates 2026-10-17 and 2026-10-18.

## Result: PARTIAL. The loop (items 2 and 3) was NOT run against a real model: the free key's daily quota for `gemini-3.8-flash` is exhausted. The same loop WAS run with the real CLI, extension, hooks and MCP server against a scripted stand-in for the Gemini API.

| Item | Real model (`gemini-3.8-flash`, free key) | Scripted API (no model, no key, no quota) |
| :- | :- | :- |
| 1. AfterModel receives `usageMetadata` as assumed | **PASS** (first session, section 1 below) | PASS (same shapes) |
| 2. Note reaches the model, `compact_now` called, AfterAgent clears, the model reads its handoff and carries on in the same `gemini -p` run | **FAIL: not run.** `TerminalQuotaError`, no model response received (twice, see below) | **PASS** (runs `mock1b`, `mock2`) |
| 3. Control `COMPACT_WHEN_READY_OFF=1` | **NOT RUN** (same reason) | **PASS** (run `mock3off`) |

What the scripted-API runs prove and what they do not: the scripted "model" is a state machine in `cwr-gem-test/mock-gemini.cjs` that reads the history the CLI sends it, reads three files, and acts when the strict note is in a tool result. So they prove everything on the CLI side (hooks fire as assumed, the note is delivered to the model, the MCP tool is callable headless, `deny` + `clearContext` empties the history and the next request is the continuation prompt, the run goes on in the same process, OFF switches it all off). They do **not** prove that a real model follows the note, writes a good handoff, calls `compact_now` or picks the work up again from the file. That remains untested.

## Why the real loop did not run: the quota belongs to `gemini-3.8-flash` itself

The brief's hypothesis was that the first `TerminalQuotaError` came from a different model the CLI calls internally (routing, classifier, lite model). The error text says otherwise (first session, `runs/probe2.err.txt`):

```
Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash
Please retry in 3h1m34.293535932s.
```

and the same on a direct REST `generateContent` call with the same key at 2026-10-17 21:22 UTC (HTTP 429, `quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier`, `quotaDimensions.model: gemini-3.8-flash`, `quotaValue: 20`, `retryDelay: 9451s`, "Please retry in 2h37m31s"). So the free tier allows 20 requests per day per project per model, and the model that hit the limit is `gemini-3.8-flash`, the one asked for with `-m`. No other model is named anywhere in the error; the hypothesis is **refuted** (VERIFIED, both error texts). A direct call that answered at 21:10 UTC (reported in the brief) is not reproduced by anything I saw: my probe at 21:22 UTC got the 429 above. Whether something else shares the key's project and used the quota is not known to me.

Retry after the reset. The 21:22 probe said the window ends about 00:00 UTC, so I waited and started one real run at **2026-10-18 00:02:39 UTC** (`liveC1`, `--skip-trust -m gemini-3.8-flash --approval-mode yolo -p ...`, in the isolated home). Result, after 68.8 s and no model response:

```
Attempt 1 failed. Retrying with backoff... Error: exception TypeError: fetch failed sending request
Error when talking to Gemini API ... TerminalQuotaError: You have exhausted your daily quota on this model.
  cause: { code: 429, message: '... Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash\nPlease retry in 23h56m11.867921481s.', status: 429 }
```

The state folder holds only `session-start`; `live-trace.jsonl` shows only SessionStart and BeforeAgent for the run. The retry delay is now about a day (it was 2h37m before), so the daily window had rolled over but was already used up again when I got there (DERIVED from the two retry delays; I made no other call to the model that day, so something else spent it, or the window does not reset at 00:00 UTC). Per the brief I **stopped the live part** there: no other key, no other model, no further real run.

Counts: real-key CLI starts in this round: 1 (`liveC1`), plus 2 direct REST calls (the 429 probe and a model-list call, which spends no generate quota). The scripted-API runs below used a fake key (`mock-not-a-real-key`), no network and no quota: 10 CLI starts (`mock1` failed on auth selection before any request; see below). The brief's cap of 10 CLI runs is met only if the scripted runs are not counted; counted together it is 11. I read the cap as bounding the real-key runs and say so here.

## Scripted-API runs (real CLI 0.64.0, real extension, hooks and MCP server; the "model" is `mock-gemini.cjs`)

How: `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:<port>` points the CLI at the stand-in, `GEMINI_API_KEY` is a fake string, and the scratch project's `.gemini/settings.json` sets `security.auth.selectedType: gemini-api-key` (without it the CLI rejects the gateway auth type with "Invalid auth method selected", run `mock1`). Same isolated home as before, stdin closed, 5-minute kill, `--approval-mode yolo`. Lines for these runs: `COMPACT_WHEN_READY_WINDOW=40000`, `SOFT=20`, `STRICT=35`. A workspace-level trace hook (`live-logger.cjs`) logged every hook event next to the extension's own hooks. The scripted API reports `10300 + 2500 per read_file result` tokens, so the percentages are artificial.

### Items 2 and 3, loop and control: PASS (scripted)

Run `mock2` (full request logging), `events.jsonl` of the extension:

```
session-start (startup)
soft-note    percent 25   (soft 20, strict 35)       <- AfterTool of the 1st read_file
strict-note  percent 38                              <- AfterTool of the 3rd read_file
strict-note  percent 44                              <- AfterTool of write_file (handoff.md)
mcp-queued   sid mcp, handoff.md, cwd = the PROJECT folder (cwr-gem-test\mock-b)
queued       handoff.md, via AfterTool
cleared      handoff.md                              <- AfterAgent
soft-note    percent 25                              <- a new cycle after the clear
strict-note  percent 38
```

What the model-side requests contained (scripted API log `runs/mock2.mock.jsonl`):
- The note is appended to the tool result as `<hook_context>[compact-when-ready] Context is at 38% of the window (the line is 35%). Save and reset now ... </hook_context>` inside `functionResponse.response.output`. The result of `compact_now` reaches the model as `<untrusted_context>Queued. End your turn now.</untrusted_context>` (Gemini CLI wraps MCP output that way).
- Request 7, the one after the clear: history length 1, a single user turn with two text parts, the environment context and `The conversation was just cleared at your request. Your handoff: handoff.md. Read it first, then carry on exactly where you left off.` Requests 1 to 6 had history lengths 1, 3, 5, 7, 9, 11 (growing), so the history was emptied.
- The scripted model then read `handoff.md` and `part4.txt`, wrote `summary.md` with all four codes (the first three came only from the handoff) and answered `DONE`. `gemini -p` printed `Reset queued; ending my reply.` then `DONE` and exited 0, one process throughout. stderr had `[WARNING] Agent execution blocked: The conversation was just cleared at your request. Your handoff: handoff.md. ...` (the CLI's name for a deny).
- Hook order from the trace hook: SessionStart, BeforeAgent, AfterModel/AfterTool ..., AfterAgent (`stop_hook_active` false), **BeforeAgent with the continuation text as prompt** (so a pending flag must be gone by then, see item 5), then the continuation's model calls, and a last AfterAgent with `stop_hook_active` **false** (the continuation turn ended in tool calls, and the headless loop's later turn ends do not pass the flag). No SessionStart fires on the clear, and the session id stays the same.

Control `mock3off` (`COMPACT_WHEN_READY_OFF=1`, same scripted model): no note in any request, no `compact_now`, no clear, no `handoff.md`, `summary.md` written after six requests, no state folder created at all (every hook returned before logging). Output `DONE`.

### Fix 2, MCP server folder: PASS (scripted)
With `"cwd"` removed from the manifest, `mcp-queued` logs `cwd: C:\Users\marti\AppData\Local\Temp\cwr-gem-test\mock-b`, the project folder (the CLI's `process.cwd()`), not the extension folder. In the bundle: the MCP stdio transport is created with `cwd: mcpServerConfig.cwd` (chunk-NR7L3FXV.js:372168), which is `undefined` when the manifest sets none and then inherits the CLI's folder (`StdioClientTransport` passes it to `cross-spawn`, chunk-NR7L3FXV.js:306738); the hook payload's `cwd` is `config.getWorkingDir()` (365898), set from `process.cwd()` at start (gemini-Q2GRYIAK.js:8585, chunk 380813).

### Fix 3, subagent readings: PASS (scripted), with a correction to the brief
- Bundle: a subagent chat is a separate `GeminiChat` built from the agent's `initialMessages` (chunk-NR7L3FXV.js:351017); the main chat's first message is the environment context that `getInitialChatHistory` puts first after every reset and compression (336356, 348062, 337265), text `<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat. ...` (336343). The AfterModel payload's `llm_request.messages` is built from the request's text parts only (`toHookLLMRequest`, 336410), so `messages[0]` is that text for the main chat. Live trace: `n=1 first=<session_context> This is the Gemini CLI` on every main-chat reading, before and after the clear. **Chosen: tell the main chat apart by that marker** (not a hash of the first message: that text is regenerated, with date and directory tree, after each compression, so a hash would change for the main chat itself, and the first message does **not** change on a clear, contrary to the brief). A subagent's first message is its own prompt (`Your task is to do a deep investigation...`, `List the part files in this folder.`).
- Same session id: confirmed by the trace hook (the subagent's AfterModel events carry the main `session_id`).
- Same model: **not always**. The built-in `codebase_investigator` runs `gemini-3-flash-preview`, so the old drop rule (which requires the same model) did not fire for it (`mock6sub-OLDLIB`: no `compacted-elsewhere`). The built-in `generalist` agent has `model: inherit` and does: with the unfixed `lib/cwr.cjs` (`CWR_ROOT` pointed at a copy of the old tree, run `mock7sub-OLDLIB`) the log shows `compacted-elsewhere {"from":38,"to":8}` after the subagent's first reading, which restarts the note cycle. That is the review's finding reproduced with the real CLI.
- Fixed `lib/cwr.cjs`, subagent `codebase_investigator`, run `mock5sub`: `reading-ignored {"reason":"not the main chat","total":3030}` and the session state keeps `tokens: 17812, sawMain: true`. The fixed code was **not** re-run live against the `generalist` agent (the CLI-run cap); that case is covered by unit tests only.
- Extra finding from `mock5sub`: the subagent's own `complete_task` tool result took the strict note (AfterTool has no chat id), so the note was spent where the main chat could not see it. Fixed too (`subActive`: tool results get no note while a subagent's readings are newer than the main chat's; `invoke_agent`'s result ends that). Unit-tested; not re-run live.

### Fix 4, repeated clears: PASS (scripted), and the first version of the fix FAILED live
`mock8loop2`: the scripted model calls `compact_now` again right after every clear. With the first version of the fix (2-minute rule, "reading below the soft line") the run cleared **10 times in a row** until the 300 s kill (10 `cleared` events, one every ~5 s). Reason: with the test lines (window 40,000, soft 20%) the base prompt alone (10,300 tokens, 25%) is already past the soft line, so the guard never saw a "small" context. The repeated-clear loop in the review was real and live-reproducible. Fix: the refusal also applies when the reading has not grown 10 points past its first reading after the clear. `mock9loop2fixed`: `cleared` once, then `clear-refused {"sinceLastClearMs":4964,"percent":32}`, the run ended after 18 s with the model's last text. (With real-size windows a cleared context is far below the soft line, so the original rule was enough there; the growth rule covers small user-set windows.)

### Items not run live
- Fix 1 (parallel tool calls): unit tests only (a real two-way race; the old code loses the flag in 2 of 3 runs of the parallel test).
- Fix 5 (a cancelled `compact_now`): unit tests only. Live evidence that matters: the clear's own continuation request **does** fire BeforeAgent (trace above) and the flag is already gone by then, so dropping a pending reset in BeforeAgent cannot cancel the clear's own continuation. Cancelling a headless run mid-turn was not tried.
- Pruning of old session files: unit tests only.

## What is still untested
- Everything that needs a real model: that it follows the soft and strict notes, writes a usable handoff, calls `compact_now` (an MCP tool, not asked about in a prompt; `-p` needs `--approval-mode yolo` or an allow rule), ends its reply, and continues from the handoff after the clear. The `<untrusted_context>` wrapping of MCP output and the `<hook_context>` wrapping of notes might make some models treat them as less binding; unknown.
- The control run with a real model (a model may call `compact_now` on its own; the server then answers that it is off).
- A real run for the fixes 1, 3 (generalist), 5, and the early-exit change under load; hook cost on Linux and macOS.

## Setup used in this round (all real-key and scripted runs)
`HOME`, `USERPROFILE`, `GEMINI_CLI_HOME` = `cwr-gem-test/home` (the extension linked there), stdin closed, 5-minute kill, `~/.gemini` untouched, `--approval-mode yolo` (needed so the MCP tool is not denied headless; the project is dummy generated text). The free key was read from `C:/Users/marti/.claude/wrapper/gemini.key` inside the child environment only (`live-launch.cjs`, `probe-quota.cjs`), never printed or written, output scrubbed of it; no other key. Scratch: `live-c`/`live-d` (the prepared real-run projects: three 30 KB files and one 2.5 KB file with `CODE partN = <word>-<n>` first lines; lines `WINDOW=60000, SOFT=25, STRICT=33`, chosen so the base prompt, about 17% of 60,000, is under the soft line), `mock-*` projects, `state-*` folders, `runs/`.


## Earlier real-model session (2026-10-17 evening): hook plumbing, VERIFIED live

This is the first session's result, kept because it is the only part run against a real model. It stopped on the quota error described above after 5 completed model calls.

### Setup of the live runs
The free AI Studio key was read inside a launcher script's child environment only (`GEMINI_API_KEY`); it was never printed, written to a file or echoed, and captured output is scrubbed of it. `HOME`, `USERPROFILE`, `GEMINI_CLI_HOME` = `cwr-gem-test/home` (the extension linked there with `gemini extensions link`), stdin closed, 5-minute kill, `~/.gemini` untouched. Task material: generated dummy text files (`a.txt` to `d.txt`, "the quick brown fox ..."). Flags: `--skip-trust -m gemini-3.8-flash --approval-mode yolo -p "<task>"`. Launcher, wrapper hook and logs are in the scratch folder (`launch.cjs`, `dbg-hook.cjs`, `spawntime.cjs`, `runs/`).

Model calls: 5 completed (probe1, timeH1, timeB1, timeH2, timeB2) and 1 refused by quota (probe2). Other CLI starts: one that failed on argument parsing before any API call (shell quoting in my launcher), `--help`, `extensions list`, `hooks --help`. Total CLI starts: 10 of the 15 allowed.

### 1. Does AfterModel get usageMetadata as the code assumes? Yes (VERIFIED, probe1)
A workspace-level wrapper hook (`dbg-hook.cjs`, which delegates to `lib/cwr.cjs`) logged each payload's shape. Task: "Read the file a.txt and tell me what its first line says." Two model responses (a `read_file` tool call, then the answer), 7 AfterModel calls:

- Response 1 (the tool call): 2 chunks, both `usageMetadata {promptTokenCount:10326, candidatesTokenCount:32, totalTokenCount:10486}`; `finishReason: "STOP"` only on the 2nd.
- Response 2 (the answer): 5 chunks, totals 10660, 10684, 10708, 10709, 10837 (a growing running total; the first chunk has no `candidatesTokenCount`); `finishReason: "STOP"` only on the 5th.
- `totalTokenCount` includes thinking tokens (10326 + 32 + 128 thoughts = 10486, the same as the session transcript's `tokens.total`). Payload keys: `session_id, transcript_path, cwd, hook_event_name, timestamp, llm_request, llm_response`; `llm_request.model` was `gemini-3.8-flash`.
- The extension's state file after the run: `tokens: 10837, window: 1048576, percent: 1`. In the timing runs that went through the real linked extension, the state file's final `tokens` equalled the last total in the session transcript (16432 in timeH1). So the real path works: manifest, `hooks.json` variable hydration, the PowerShell wrapper on Windows, the state file.
- A trivial prompt already costs about 10,300 tokens (system prompt and tool declarations): about 1% of a 1M window. Keep that in mind when testing with a small window.

### 1b. Hook overhead
In probe1, 13 hook processes ran for the 2-response task (SessionStart 1, BeforeAgent 1, PreCompress 2, AfterModel 7, AfterTool 1, AfterAgent 1). The CLI waits for each one; AfterModel is awaited inside the stream loop, once per chunk (read in the 0.64.0 bundle).

Cost of one hook call, measured by spawning it the way the CLI does (`powershell.exe -NoProfile -NonInteractive -Command 'node hook.cjs; ...'`, payload on stdin, 15 calls each, `spawntime.cjs`; an intermediate AfterModel chunk with a changing token total):

| What | median (min to max) |
| :- | :- |
| hook.cjs through PowerShell, before the early-exit fix | 409 ms (358 to 628) |
| hook.cjs through PowerShell, after the early-exit fix | 387 ms (330 to 590) |
| an empty Node script through PowerShell (floor) | 399 ms in one batch, 557 ms in another (340 to 708) |
| hook.cjs run by Node directly, before / after the fix / empty script | 56 / 50 / 49 ms |

So the cost is PowerShell start-up (roughly 0.35 to 0.45 s per hook), not the extension's script (about 5 to 10 ms above an empty one). **The early exit I added to `hooks/hook.cjs` (answer at once for a chunk that has candidates but no `finishReason`, before loading `lib` or touching a file) saves only about 6 ms per chunk. It is harmless and kept, but it does not fix the slowdown.** `AfterModel` cannot take a `matcher` (the CLI's hook planner applies matchers only to tool names and compress triggers and passes no context for AfterModel), so the extension cannot make the CLI start fewer processes. Estimate (derived, not measured end to end): about 3.5 chunks per response at about 0.4 s is roughly 1.4 s per model response on Windows, plus about 0.4 s for each other hook. Linux and macOS were not measured.

Wall-clock A/B, identical task ("read a.txt, b.txt, c.txt, write notes.md, reply done"), extension hooks active vs `-e none` with only the MCP server in workspace settings: hooks 287.2 s and 74.0 s; no hooks 24.5 s and 209.2 s. **These numbers do not measure the hooks.** The API's own latency swung from about 20 s to over 260 s per response (the first model call in timeH1 alone took 260 s), far more than the 1 to 5 s the hooks add, and the quota ran out a few minutes later. I did not repeat them. The overhead figure comes from the per-call spawn measurement and the fire counts.

Not re-measured live after the fix (quota). What would remove the per-chunk cost is reading the token counts from the session transcript (`transcript_path`) in the AfterTool / BeforeAgent hooks and dropping AfterModel. Not built: in the CLI's code `transcript_path` is the chat recording file, but I did not confirm the value in a live payload, and a silent miss would switch all notes off.

### 1c. Bug found live and fixed: PreCompress
probe1's `events.jsonl` showed `compacted-elsewhere via PreCompress trigger auto` twice although nothing was compressed, and each timing run's state folder shows it 3 times. In the CLI (`ChatCompressionService.compress`) the PreCompress hook fires at the start of every compression check (each turn, and before each follow-up request after a tool result); the token threshold is tested afterwards. The handler reset the token reading and the note state each time, so the soft note would have been sent again after nearly every tool call and the strict "every 2 points" spacing would have been lost. Fix: no PreCompress handler and no PreCompress registration in `hooks/hooks.json` (a real compression is still caught by the 20-point fall in the token reading). That also removes 2 or more needless 0.4 s process starts per turn.

## Earlier check (builder): the real CLI loading the extension, no model call

All with `USERPROFILE`, `HOME` and `GEMINI_CLI_HOME` set to `C:/Users/marti/AppData/Local/Temp/cwr-gem-test/home`.

| Step | Result |
| :- | :- |
| `gemini --version` | `0.64.0` |
| `gemini extensions link --consent <this folder>` | "Extension "compact-when-ready" linked successfully and enabled." A libuv assertion printed at process exit; the link had already succeeded. |
| `gemini extensions list` | shows `compact-when-ready (0.1.0)`, enabled for user and workspace, MCP servers: `compact-when-ready` (re-checked this session after the `hooks.json` change) |
| `gemini mcp list` | `compact-when-ready ... (stdio) - Connected` (the CLI's own MCP client initialised and discovered the tool) |
| Hook commands run the way 0.64.0 runs them on Windows, payloads on stdin | SessionStart, AfterModel, AfterTool (strict note), AfterTool `compact_now` (flag set), AfterAgent with `stop_hook_active=true` (`{}`), AfterAgent false (`deny`, `HANDOFF.md` in the reason, `clearContext: true`), AfterAgent again (`{}`). All exit 0, stderr empty (script `cwr-gem-test/shell-run.cjs`). Synthetic payloads, not a live model. |

The behaviour of `deny` / `clearContext` / `stop_hook_active` was read in the 0.64.0 bundle (`fireAfterAgentHookSafe`, `sendMessageStream`: `resetChat()` then the reason is sent as the next request). That is evidence about the code, not a run.


## How to run the real loop when quota is available (workspace-level config only; ~/.gemini untouched)

1. Use a key whose `gemini-3.8-flash` (or another flash model) daily quota is free: the free tier is **20 requests a day per model per project**, and the loop needs about 10 model requests (6 more for the control). Check first with one tiny REST call.
2. Scratch project with `part1.txt`..`part4.txt` (see `cwr-gem-test/mkproj.cjs`), launcher `cwr-gem-test/live-launch.cjs <label> <project> <promptfile>` (reads the key into the child environment only; `COMPACT_WHEN_READY_STATE_DIR=<scratch>/state-<label>`; lines `WINDOW=60000 SOFT=25 STRICT=33`). Choose the lines so that the base prompt of about 10,300 tokens is **below** the soft line, otherwise a cleared context starts past the soft line and every continuation is told to reset again.
3. `gemini --skip-trust -m <flash model> --approval-mode yolo -p "<task>"`, stdin closed (a policy rule for `compact_now` works instead of `yolo`).
4. Success looks like, in `<scratch>/state-<label>/events.jsonl`: `soft-note` or `strict-note`, `mcp-queued`, `queued`, `cleared`; and in the output, the model reading its handoff after the reset and finishing the task. Control: same task with `COMPACT_WHEN_READY_OFF=1`.
5. To run the same loop without a model: `cwr-gem-test/mock-run.cjs <label> <project> <loop|loop2|sub|control>` against `mock-gemini.cjs` (project settings need `security.auth.selectedType: gemini-api-key`).

## Unit tests and planted failures (this round)

- `node --test test/hooks.test.cjs`: **53 tests, 53 pass** (was 34; 19 new, 4 existing ones changed to read the pending file). `node test/validate.cjs`: valid (5 events, 5 command hooks); it now also rejects a `cwd` on the MCP server.
- Red against the unfixed code: the new test file run with `CWR_ROOT` pointing at a copy of the tree as it was before this round (36 pass, **17 fail**, final 53-test file): the stale session-state write after `compact_now`, the really parallel hook processes (a real race: the old tree failed 4 of 9 runs of that test, the new tree passed 5 of 5), the manifest-driven MCP server folder, the manifest `cwd` check, the three subagent tests, the second clear within 2 minutes, the small-window clear, a new turn dropping a leftover reset, the 10-minute expiry, the queued.json drop, the pruning, and four tests that read the pending file the old code does not write. The validator run on the old tree: `INVALID (1): mcpServers.compact-when-ready.cwd: must not be set ...`, exit 1.
- Then green on the fixed code (53/53).
- Planted bugs in a copy of the fixed tree (`scratchpad/cwr/plant.cjs`), each caught by exactly the intended test(s): subagent check always "main" (3 tests fail), no clear cooldown (2), no growth condition (1), no BeforeAgent drop of a pending reset (1), no expiry (1), pruning deleting `config.json` (1), no pruning (1), subagent guard on AfterTool removed (1), a note hook writing the pending file (1). One planted bug per run, each exit 1.
- Not tested by a planted failure: the "re-read the session state right before the write" part of fix 1. It is by construction (`update()` reads, lets the hook change its own fields, writes only on change) and covered by the parallel-process test only as far as that is a real race.
- Earlier (previous sessions): 10 planted bugs in the AfterAgent / compact_now / note logic caught; 7 planted breakages of the JSON files rejected by the validator; PreCompress and early-exit plants (see sections 1b and 1c).

## Real-model run, 2026-10-18 00:08 UTC (added by the coordinating session)

The quota error at 00:02 names `gemini-3.8-flash` only (per-model daily limit). A direct probe showed `gemini-3-flash-preview` still answering on the same free key, so one run used it: `live-launch.cjs` with the model as a setting (`CWR_MODEL=gemini-3-flash-preview`, otherwise unchanged: isolated home, lines `WINDOW=60000 SOFT=25 STRICT=33`, project `live-d`, `prompt-live.txt`). Label `liveD-g3`, exit 0, 140.7 s wall, one rate-limit retry (5 requests a minute for that model).

Event log (`state-liveD-g3/events.jsonl`): `session-start` -> `soft-note` 29% -> `strict-note` 42% -> `strict-note` 55% -> `mcp-queued` (cwd = the project folder) -> `queued` via AfterTool -> `cleared` (00:10:10). The model wrote `handoff.md` (task, done parts 1-3 with their codes, next: read part4, write summary.md, reply DONE), and after the clear the continuation read it, read `part4.txt`, and wrote `summary.md` with all four CODE lines matching the files. Output: `DONE` printed twice (once before the clear, once at the end).

Result: **item 2 PASS on a real model, once.** The soft note was not acted on; the second strict note was. The prompt says notes in tool results come from installed tooling, which a real user's prompt would not say. Not run: the real-model control (`COMPACT_WHEN_READY_OFF=1`; the scripted run covers it), `gemini-3.8-flash`, the interactive screen.

## Second real-model run, 2026-10-18 00:13 UTC, neutral prompt (added by the coordinating session)

Same setup as `liveD-g3` (project `live-e`, fresh), but the prompt without the sentence that says notes come from installed tooling (`prompt-neutral.txt`). Label `liveE-neutral`, 88 s. Event log: `soft-note` 29% -> `strict-note` 42% -> `strict-note` 55% -> `mcp-queued` -> `queued` -> `cleared`. The model wrote `handoff.md`, and after the clear wrote `summary.md` with all four CODE lines correct. The CLI then exited 1: its final reply hit the free daily quota for `gemini-3-flash` (limit 20 a day, retry in 23h45m). So the loop and the task completed; only the closing "DONE" reply was lost to the quota. No real-model control was possible after that (the scripted run covers it).
