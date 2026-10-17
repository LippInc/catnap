# Live test: compact-when-ready-opencode against the real OpenCode CLI

Date: 2026-10-17. OpenCode CLI 1.19.0 (`opencode.exe` from the global npm package), Windows 11, model `opencode/deepseek-v4.1-flash-free` (free). Plugin version 0.1.0, `@opencode-ai/plugin` 1.19.0 (types and runtime import, from `./node_modules`).

## Result

PASS, with one limit found: the full loop works under `opencode serve` + `opencode run --attach`; it does not complete under a bare `opencode run`, which exits at the first idle.

## Setup

- Scratch: `C:/Users/marti/AppData/Local/Temp/cwr-oc-test/` (config files, `home/{data,config,state,cache}`, project `proj/` with `notes1.txt` to `notes6.txt`, about 12 KB of text each, logs in `logs/`).
- Isolation: every inherited `OPENCODE_*` variable unset; `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` under `cwr-oc-test/home/`; `OPENCODE_CONFIG=<scratch>/config*.json`; `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`. No user config or data folder was read. The delegate wrapper's API-key file was not used: the free model answered without it.
- Config: plugin loaded as `["file:///C:/Users/marti/Dev/Claude-tools/cwr-launch/ports/opencode/index.ts", {options}]`; `small_model` set to the free model; permissions: `*` deny, read/glob/list/grep/edit/compact_now allow (no bash, web, task).
- Driver: the official CLI only. `opencode serve --port 4097 --hostname 127.0.0.1` (one process) and `opencode run --attach http://127.0.0.1:4097 ...` (a second, short one), so at most 2 processes at a time. Afterwards `curl` to `http://127.0.0.1:4097/session/<id>/message` and `/session/status` on that local server to read the history back. No call to opencode.ai's servers other than what the CLI itself makes for the model.
- Task prompt: "Work through notes1.txt to notes6.txt in order, one file per tool call; for each, read it and write out/notesN.out with the last word of line 120. Obey any [compact-when-ready] message you see in a tool result. When all six exist, reply ALL DONE."

## Things that went wrong first (honest list)

1. **Two runs hung until killed** (first run and the first `live1` try) after the `init` log line. Cause: the CLI waits on stdin when stdin is an open pipe. The no-plugin control hung the same way (3 of 3 tries) and passed with `< /dev/null` (2 of 2). Not the plugin. All later runs use `< /dev/null`.
2. **`live1`, bare `opencode run` (no server):** the plugin logged `start`, soft `note` (41%), `queued` (56%), then `compacted` and `continued` 20 ms apart, but the CLI logged `exiting loop` at 20:34:52.770 and `disposing instance` at 20:34:52.784, i.e. the process shut down right when the session went idle. Only notes1 to notes3 were written; there was no second turn. In this run I did not record the `summarize` return value, so I cannot say whether a compaction really ran. This is the limit stated in the README. After this the `compacted` log line got a `result` field (the `data` of the summarize response).

## Run A: soft line (config `soft 40, strict 60, window 30000`), server + attach

Session `ses_eb46c52a4ffej1fLHiJun344Y1`, log `home/state/compact-when-ready-opencode/ses_eb46c52a4ffej1fLHiJun344Y1.jsonl`:

```
20:35:32.465 start      soft 40 strict 60 window 30000
20:35:41.161 note       which=soft percent=40
20:35:48.758 queued     handoff=...\proj\handoff.md percent=57
20:35:53.443 compacted  percent=57 result=true          (summarize took 4.7 s)
20:35:53.463 continued
20:36:02.038 note       which=soft percent=44           (new cycle, percent counted from the new, smaller context)
20:36:16.461 queued     percent=64
20:36:20.529 compacted  result=true
20:36:20.555 continued
```

From the session history read back over the local server (`/session/<id>/message`), in order:

- assistant steps with token totals rising 4314 -> 8189 -> 8268 -> 12146 -> 12225 -> 16621;
- `write handoff.md`, then `compact_now(handoff=...\handoff.md, keep="Task: ...")` with the result "Compaction queued. End your turn now.", then the text "Compaction queued; ending turn.";
- a user message holding a `compaction` part, then an assistant message with `summary: true` (the OpenCode summary of the old context; tokens 3966 in / 528 out);
- the plugin's user message: "[compact-when-ready] The conversation was just compacted at your request (context had reached 57%). Your handoff: C:\...\proj\handoff.md. Read it first, then carry on exactly where you left off, ...";
- the model's next step: `read handoff.md` (context back at 4832 tokens), then `read notes4.txt`, `write out/notes4.out`, and so on to notes6;
- a second cycle at 64%, a second summary, a second continue message, `read handoff.md`, and the final text "Task complete. ... ALL DONE".

Result check: the last word of line 120 of each notes file against `out/notesN.out`: 6 of 6 correct (iota, gamma, tau, pi, tau, omicron).

The soft note itself, as stored in the first tool result, was visible in the history (`[compact-when-ready] Context is at 40% of the window. Compact at a comfortable moment before 60% ...`).

## Run B: strict line only (`soft 70, strict 35, window 30000`), server restarted

Session `ses_eb46aca91ffe3Q6UVTrbVLfsyp`. Strict notes in tool results: 40% (after a read), 54% (after a write), `queued` 56%, `keep-passed`, `compacted`, `continued`; second cycle: strict notes at 44% and 58%, `queued` 60%, `keep-passed`, `compacted`, `continued`. The notes are in the stored tool results ("Context is at 54% of the window (the line is 35%). Save and compact now ..."). Final assistant text `ALL DONE`; 6 of 6 outputs correct; 2 summary messages. The log lines `keep-passed` show that the `experimental.session.compacting` hook ran with the `keep` text during the plugin's own compaction (whether the summary used it was not measured).

## Run C: window from the provider (config `soft 6, strict 9`, no window option)

`start` logged `window: null` (none given); `GET /config/providers` on the server gives `limit.context = 200000` for this model. Soft note at 6%, `queued` 8%, `compacted`, `continued`, a new soft note at 7% in the next cycle, 6 of 6 outputs written. So the window lookup through `client.config.providers()` works.

## Controls (planted failures)

- **Plugin off:** `COMPACT_WHEN_READY_OFF=1`, same task on a bare `opencode run`: 6 reads, 6 writes, 0 mentions of `compact-when-ready` in the run output, no `compact_now` call, no compaction, no new log file (5 files before and after). So the notes and compactions above come from the plugin.
- **Bare `opencode run` with the plugin on (`live1`):** the loop does not complete (item 2 above). This is the known-bad case for "the run exits before the idle step".
- **stdin hang:** reproduced without the plugin (item 1).

## Not tested

The TUI and the desktop app; any model other than the free DeepSeek one; OpenCode's own auto-compaction interplay; subagent sessions live (unit-tested only); the `session.status` idle route (the live runs went through `session.idle`; both routes are unit-tested); the toast (there is no TUI in these runs); `summarize` failing for real (unit-tested with a fake client only); installing by npm name; macOS and Linux.

## After the review fixes (2026-10-17, evening)

What changed in `index.ts` (all unit-tested, see `test/plugin.test.ts`, block "after the review fixes"):

- F1: the continue prompt now carries `body.agent` (taken from `info.agent`, else `info.mode`, of the latest assistant message), so a session in `plan` or a custom read-only agent continues under that agent. Left out when no agent is known.
- F2: if the newest assistant message ended with an error (for example `MessageAbortedError`, recorded even when the message has 0 tokens), `session.idle` keeps the request queued and logs `idle-after-error`; the next idle after a normal turn compacts.
- F3: when the continue prompt fails twice after a successful summarize, the plugin logs `continue-gave-up` and shows the toast but no longer switches the notes off for the new cycle.
- N1: no "context had reached -1%" when the percent is unknown (the clause is left out).
- N2: a failed `client.config.providers()` lookup is no longer cached; only a found size or a clean "not found" is.
- N4: `LICENSE` added and listed in `package.json` "files".

Tests: 28 before, 38 after (10 new), all green with `bun test`. The 10 new tests run against the unfixed `index.ts` gave 31 pass / 7 fail (F1 x2, F2 x2, F3, N1, N2; the 3 that passed are controls: no agent known, percent known, clean "not found" cached). Against the fixed code: 38 pass / 0 fail. `tsc --strict` (`npm run typecheck`): clean, exit 0.

Live re-run of Run A (soft 40, strict 60, window 30000, `config.json`, server + attach, free model, stdin from /dev/null, same isolation as above; fresh project copy `proj6/` with the same six notes files, output in `proj6/out6/`; 1 of the 4 allowed CLI runs used, never more than 2 opencode processes). Session `ses_eb4500dc3ffeS85KWunKQGEFZm`:

```
21:06:24.968 start        soft 40 strict 60 window 30000
21:06:32.678 note         which=soft percent=40
21:06:39.328 queued       percent=55
21:06:40.536 keep-passed
21:06:44.649 compacted    percent=55 result=true
21:06:44.663 continued
21:06:53.971 note         which=soft percent=45          (new cycle)
```

History read back from `/session/<id>/message`: 8 assistant steps (4231 -> 16890 tokens), `compact_now`, a `summary: true` message, the plugin's continue message ("... compacted at your request (context had reached 55%). Your handoff: ...\out6\handoff.md ..."), 8 more steps (5090 -> 17734), final text `ALL DONE`. Output check: last word of line 120 of each notes file against `out6/notesN.out`: 6 of 6 correct (iota, gamma, tau, pi, tau, omicron).

Differences from the first Run A, stated plainly: only one compaction cycle this time (the context peaked at 17734 of 30000, below the 60% line, so there was no second cycle); and the `opencode run --attach` client process exited (exit 0) after 17 s, at the first idle, before the compaction and the continue message happened. The server carried on without it and finished (session still busy at 21:06:51, idle by 21:06:59). The first Run A's CLI output (`logs/live2.ndjson`) ends the same way, so this is the known "the client leaves at the first idle" behaviour, not new; the proof of the whole loop is the history read from the local server. The agent passthrough was not exercised live with a non-default agent (the session ran under `build`, the continue message's agent was `build`); it is covered by the unit tests only. F2 and F3 are unit-tested only (no live cancel, no live failing continue).
