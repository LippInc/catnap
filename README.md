<img alt="catnap: a pixel cat asleep on its notes" src="launch/catnap.svg" width="220">

# catnap

**Claude naps at a clean break. Not mid-task.**

https://github.com/user-attachments/assets/f8da42f1-4ef9-4471-8593-b682d969cbfe

```text
finish the thought.
leave a note.
nap.
wake up knowing everything.
```

Claude Code compacts your conversation when the context window fills up, usually in the middle of a task. catnap gives Claude a heads-up at 50% instead. Claude finishes the piece it is on, writes itself a handoff note, compacts, and carries on by itself. You don't type anything.

## Install

```bash
claude plugin marketplace add LippInc/catnap
claude plugin install catnap@lippinc
```

You need Claude Code v2.1.287 or later, or v2.1.286 in the desktop app. Inside a terminal session instead: `/plugin install catnap --marketplace LippInc/catnap`. New sessions load it on their own, including the desktop app's Code tab; a session that is already open needs `/reload-plugins` first. Only install catnap from LippInc/catnap: everything it hooks and calls is listed under [What it can reach](#what-it-can-reach).

**Try it now:** type `/catnap:compact`. Claude finishes the piece it is on, writes itself a handoff, compacts, and carries on by itself. That is the whole loop, on demand.

**After that it runs on its own.** You see nothing until the context reaches 50%: about 100K tokens on a 200K window, about 500K on a 1M window, which can take hours. Then Claude finishes its piece, writes a handoff and compacts, and a message starting with `[catnap]` hands the handoff back and tells it to carry on. You don't type anything.

**Your own numbers:** `/catnap:check` reads your local Claude Code logs (numbers only; nothing leaves your machine) and starts with a card like this one, from the author's last 30 days. To see yours before installing anything, run `npx github:LippInc/catnap` in any terminal (Node 18 or later):

```text
 /\_/\  zZ   78 of 82 auto-compactions cut Claude off mid-task.
( -.- )      A clean break at 50% would re-read about 17% less context (estimate).
 > ^ <       catnap check, your last 30 days · github.com/LippInc/catnap
```

If catnap saves you one "let me re-read where I was", a star helps other people find it.

## Why

| | Without catnap | With catnap |
| :- | :- | :- |
| When it compacts | when the window is nearly full | when Claude finishes the piece it is on, from 50% |
| Compactions in the middle of a task | 78 of 82 auto-compactions in the author's last 30 days of logs | none so far in the author's own work: each one came at a moment Claude picked |
| Right after | Claude carries on from Claude Code's summary of the conversation | Claude also gets back the note it wrote at the clean break, word for word |
| Context re-read in long sessions | baseline | **about 30% less** |

<sub>Replay of the author's long sessions (over a whole month, short sessions included: 17.5%). Method, script and per-session table: [Numbers](#numbers) and [bench/REPLAY.md](bench/REPLAY.md). Yours: `/catnap:check`.</sub>

You set the lines; Claude picks the moment inside them. The mod compacts nothing until Claude has finished its piece and written its note (Claude Code's own auto-compact stays on as the backstop), and one setting turns it all off.

## What happens

- **Before 50%:** catnap stays quiet, and Claude doesn't compact on its own: if it calls `compact_now` this early, catnap answers "not yet" and Claude carries on. You can still nap any time: type `/catnap:compact`, or ask for a compaction in your own words.
- **At 50% context:** one note on a tool result. It tells Claude to finish the piece it is on properly (the page, the section, the feature), and to save and compact at that clean break.
- **At 60%:** a strict note telling Claude to save and compact now. It repeats every 2 points until Claude does. If a turn ends past 60% without a compaction, catnap asks with a prompt of its own, again every 5 points.
- **`compact_now`:** Claude passes its handoff with the call (or the path of a handoff file your `save_step` wrote). It makes the call in the same response as its last action (say, the command that runs the tests), so the nap takes no model call of its own; it hasn't seen that action's result yet, so the handoff's next step starts with checking it. When that turn ends, catnap compacts the conversation and tells the summary to keep what Claude named. Then it sends Claude a message with the handoff in it, word for word: *"The conversation was just compacted at your request ... Here is the handoff you wrote just before it: ... Carry on exactly where you left off, with the next step it names."*
- **At 70%:** Claude Code's own auto-compact, the backstop if Claude hasn't compacted by then. Without catnap it would wait until the window is nearly full.

All three lines are settings (below).

## Settings

| Option | Default | What it does |
| :- | :- | :- |
| `soft_percent` | 50 | Where the soft note comes. Set it at or above the strict line to turn the soft note off. |
| `strict_percent` | 60 | Where the strict note comes. |
| `auto_percent` | 70 | Where Claude Code's own auto-compact runs. Keep it above the strict line, or Claude Code compacts before Claude is asked to (the mod shows a toast if it isn't). `0` leaves Claude Code's own setting alone. |
| `save_step` | empty | A command Claude runs to save its work before compacting, for example `/save-before-compact` from [save-before-compact](https://github.com/LippInc/save-before-compact). Left empty, Claude passes its handoff to `compact_now` itself, and catnap keeps a copy (see [Files it writes](#files-it-writes)). |
| `fresh_start` | off | At each nap, clear the conversation instead of compacting it: Claude carries on from its handoff alone. A nap then costs about a quarter of the tokens (no compaction call, and no summary carried into the calls after it). The conversation before the nap is cleared, not summarized: Claude has only its handoff, and Claude Code's summary is not there to catch what the handoff missed. |

You can change these in `/config`, or from the shell:

```bash
echo '{"save_step": "/save-before-compact", "strict_percent": "65", "auto_percent": "75"}' | claude plugin configure catnap@lippinc --values-stdin
```

A change there applies to sessions that start after it, or to an open one after `/reload-plugins`. To move a line in a session that is already running, use `config.json` (see [Files it writes](#files-it-writes)). It is re-read on every check.

- **Turn it off for one process:** set `CATNAP_OFF=1` (the old name `COMPACT_WHEN_READY_OFF=1` still works). Auto-compact is then left as Claude Code has it.
- **Turn it off everywhere:** disable the plugin in `/plugin`.
- **Uninstall:** `claude plugin uninstall catnap@lippinc`. If you installed it under its old name, `claude plugin uninstall compact-when-ready@lippinc`. Its state folder (see [Files it writes](#files-it-writes)) is left behind; delete it if you want it gone.
- **How the auto line works:** the mod sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in Claude Code's own process, the same variable you could set yourself. While the mod is on, its setting wins over one in your settings files. That one still applies when the mod is off, so it's a good fallback to keep. Turning the mod off in `config.json`, or setting the line to `0`, puts back whatever the variable held before. Programs Claude starts from the session (Bash commands, a nested `claude`) inherit the value.
- **Limits of the auto line:** Claude Code can only move auto-compact earlier than its own default, never later, so values near 100 do nothing. Like the notes, it is only set in a person's session (a terminal, or a desktop app chat): `claude -p` runs keep Claude Code's own setting.

## Works with

| Agent | Status |
| :- | :- |
| Claude Code | the original: a mod, everything above |
| OpenCode | a plugin, [ports/opencode](ports/opencode). Tested live on OpenCode 1.19.0 under `opencode serve` with a free model; a bare `opencode run` exits before the compaction, and the TUI is not tested yet |
| Gemini CLI | an extension, [ports/gemini-cli](ports/gemini-cli). Gemini CLI has no compaction a hook can start, so the port clears the context and the model carries on from its own handoff. The full loop ran live twice (Gemini CLI 0.64.0, `gemini-3-flash-preview`, headless); the interactive screen is not tested |

### Port it to your agent

A port needs four things from the agent's hooks: read the context percentage, add a note to a tool result the model reads, start a compaction (or clear the context) between turns, and submit a prompt after it. [ports/opencode](ports/opencode) and [ports/gemini-cli](ports/gemini-cli) show how. Where it stands elsewhere today: Codex and Cursor hooks can continue a session but cannot start a compaction, so a port would be partial at best; Windsurf has no hook that can continue a session or see context use. Pull requests are welcome.

## Numbers

**About 30% less context re-read** was measured by replaying the author's 9 real long sessions with the mod against Claude Code's default auto-compact point: 33.0% less. One known bias pushes that up, so we say about 30%. Per session it ran from about 0% (sessions that ended right after compacting) to 46%. Against an auto-compact line already set to 70%, it was 16%. Most of the saving comes from compacting earlier. A lower auto-compact setting does that too, but auto-compact lands mid-task almost every time; this waits for a clean break. These are tokens re-read, not plan usage: on a subscription the saving in usage is smaller, because cache reads weigh less. Script and per-session table: [bench/REPLAY.md](bench/REPLAY.md).

**Measured to the end of a task:** a paired benchmark ran Opus 5.5 on long synthetic coding tasks until hidden tests passed, and counted every call, compactions included. On a 1M window catnap used 56% fewer tokens than Claude Code's default auto-compact point, about a third less at API prices. On a 200K window, 17% fewer tokens. That saving comes from compacting earlier. Against auto-compact set to cut at the same point, catnap's totals were within noise on both windows, so the clean break and the handoff showed no measurable extra cost. Since 0.3.8 the handoff rides along with Claude's last action instead of taking a model call of its own: in 6 runs on 200K, 10 of 11 naps did. With `fresh_start` on, a nap took about a quarter of the tokens of a compaction, which is a few percent of a whole run, too little to show in these totals. Method and tables, in tokens and dollars: [bench/PAIRED.md](bench/PAIRED.md).

**No compaction mid-task with catnap:** in the author's real work over 5 days with it, all 13 compactions came at a moment Claude picked, and each one carried on by itself.

**Check your own history in seconds:** `/catnap:check` inside Claude Code (or `npx github:LippInc/catnap` with nothing installed, or `node bench/check.mjs` from a clone) reads your local Claude Code logs and prints numbers only (nothing leaves your machine) and tells you how often auto-compact cut in mid-task and what a clean-break compaction would have saved. Your number will differ: it covers all your sessions, short ones included, so it is usually lower than the long-session replay above (17.5% on the author's last 30 days). The author's last 30 days: 78 of 82 auto-compactions landed while Claude was in the middle of a tool loop. That is not bad luck: on the author's machine about 92% of Claude's calls end in a tool call, and auto-compact doesn't wait for a clean break.

## FAQ

- **Isn't this just auto-compact at 50%?** Most of the saving comes from compacting earlier, and a lower auto-compact setting does that too. But auto-compact lands mid-task almost every time (78 of 82 in the author's logs). catnap waits until Claude has finished the piece it is on, so its compactions come between steps rather than in the middle of one, and after the compaction Claude gets back the note it wrote instead of relying on the summary alone.
- **Why not fast-jev-compaction?** It changes what goes into the summary; catnap changes when the compaction happens. Using both together is untested.
- **Does it cost tokens?** Each note costs a few hundred tokens. Claude passes its handoff in the same response as its last action, so a nap usually takes no model call of its own (10 of 11 naps in a 200K benchmark), only the compaction call every compaction makes; catnap answers the request after `compact_now` itself, so there is no extra call to end the reply either. In return each compaction comes earlier and at a clean break. Measured to the end of a task, catnap's total was within noise of auto-compact cutting at the same point; see [Numbers](#numbers), and `/catnap:check` for your own history.
- **Can it compact at a bad moment?** Claude picks the moment, between your lines. If you catch it compacting at a moment you think is wrong, an issue with the session's `.log.json` is the most useful thing you can send.
- **What if Claude Code does this itself one day?** Then uninstall catnap: `claude plugin uninstall catnap@lippinc`. Until then it works today.

## How it compacts

- **In a terminal session**, the mod compacts directly, between turns.
- **In the desktop app's Code tab**, a direct compaction is refused ("not available in a headless (-p / SDK) session"). There the mod runs `/compact` with its instructions, as if you had typed it.
- **If `/compact` fails**, because it is refused or hasn't compacted within 10 minutes, the mod gives up for that round. It shows a toast and stays quiet until a compaction happens some other way, and auto-compact still applies.
- **A compaction the mod didn't run** (auto-compact, or a `/compact` you type) starts the notes over. Claude Code reports it through the `session.compact` hook. Where that hook is held back (see [Limits](#limits)), the mod spots it from the context instead: a fall of 20 points or more between two checks, while nothing of its own is queued, counts as a compaction.
- **When a compaction frees almost nothing,** the notes wait. That happens when the part of a session that never compacts (the system prompt, tools, a large CLAUDE.md) is itself near the lines. So after any compaction, both lines sit at least 10 points above where it left the context, for that round, and a toast says so once. (Where the `session.compact` hook is held back, a compaction the mod didn't run counts only when the context falls 20 points or more, as above.) Without this, Claude was asked to compact again after every feature (live: a 90K-token CLAUDE.md on a 200K window, two compactions in under a minute and a third queued; with the guard, the same setup compacted once and Claude finished the task). In a normal session a compaction leaves a few percent, so the lines stay where you set them.
- **It stays out of scripted runs:** `claude -p` runs, including ones started from inside a chat, and SDK sessions with nothing drawn. Subagents get no notes and can't call the tool.
- **A desktop app chat counts as yours even while no window shows it.** The app attaches its window to a chat and detaches it again as it goes, so the mod knows the app's chats by Claude Code's entry point (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`). A `claude -p` started from inside a chat inherits that, but Claude Code also marks it as started from another session (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`), so it stays out.

## Files it writes

All its files go in `~/.claude/state/catnap/`, or in `$CLAUDE_STATE_DIR/catnap/` if you set that variable:

- **`<session id>.json`** is `{"pending": true, ...}` while a compaction is queued. Other tools may read it: if you have a Stop hook that keeps turns going, make it stay quiet while this file is fresh. Otherwise the turn never ends and the compaction never runs.
- **`<session id>.handoff.md`** is the last handoff Claude passed to `compact_now` as a note, kept so you can look at it. The message after the compaction gives Claude the same text.
- **`<session id>.log.json`** holds the last 60 events (notes, queued, compacted, gave up) for debugging. Only a person's session gets one, or a session where the mod did something.
- **`config.json`** is optional. It overrides the options live, with no reload: `{"soft": 50, "threshold": 60, "auto": 70, "off": false, "fresh": false}`. `threshold` is the strict line, and `fresh` is `fresh_start`.

catnap was called compact-when-ready until this rename, and its state folder was `~/.claude/state/compact-when-ready/`. Old settings and files in that folder are not read; copy a `config.json` over to keep it.

## What it can reach

catnap is a mod: code that runs with your permissions. These are the calls `claude plugin validate .` lists, and what each one is for; to check them before you install, clone the repository and run that command. Nothing here leaves your machine: the mod makes no network requests, no model calls of its own, and starts no processes.

- **Hooks:**
  - `session.start` reads the settings and starts the mod's timer.
  - `tool.call` adds the notes to tool results and answers `compact_now`.
  - `prompt.submit` checks whether your latest prompt asks for a compaction (the words compact or nap, as in `/catnap:compact`), so `compact_now` may run before the line. It keeps only that yes or no, and passes the prompt on unchanged.
  - `turn.start` notes which turn is running, so `compact_now` knows its turn.
  - `turn.step` answers one model request itself: the one right after `compact_now` in that turn, which could only end the reply. It answers with one line (*"[catnap] Compacting now; Claude carries on right after."*), so the turn ends without reading the whole context once more. Every other request goes to the model unchanged.
  - `turn.complete` runs a queued compaction, or asks for one past the strict line.
  - `session.compact` only notices that a compaction happened, so the notes start over. It passes the event on unchanged and never blocks a compaction.
  - `session.end` clears the queued state.
- **The one tool call it answers itself** is its own `compact_now` (`$.tool.register`). It queues the compaction and tells Claude to end the turn. It refuses the call from a subagent, and below the line unless your latest prompt asked for a compaction. Every other tool call goes to its tool unchanged; past the soft or strict line, the mod adds one note to the result.
- **Files it writes** (`$.fs.write`): only the queued flag, the log and the copy of Claude's handoff note in its state folder (see [Files it writes](#files-it-writes)). The flag is the one file meant for other tools to read: a Stop hook should stay quiet while it is set. The mod never writes a settings, instructions, start-up or build file.
- **Environment variables it sets** (`$.env.set`), in Claude Code's own process, never in a settings file:
  - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: the auto-compact line (`auto_percent`, 70 by default).
  - `CATNAP_AUTO_ORIG`: what that variable held before the mod set it, so turning the mod off puts it back, also after a reload.
- **Prompts it submits** (`$.prompt.submit`) go into the same session, as if you had typed them. There are two:
  - After a compaction it ran: *"[catnap] The conversation was just compacted at your request (context had reached 61%). Here is the handoff you wrote just before it (saved in \<file\>):"*, then the handoff itself between `<handoff>` tags (up to 32,000 characters; a longer one is cut there, with a line saying where the rest is), then *"Carry on exactly where you left off, with the next step it names. If the work was finished, or you were waiting on the user, say in a line or two where things stand and stop; do not start new work."* If the handoff file can't be read, the message names the file and asks Claude to read it instead.
  - When a turn ends past the strict line without a compaction: *"[catnap] Your last turn ended with context at 63% of the window (the line is 60%). Compact before anything else, in this order:"*, then four numbered steps: finish only the current step, save (your `save_step` command, or the handoff as the call's note), call `compact_now` in the same response as the step's last action, end the reply.
  - They hold only the mod's own text, the context percentage, the lines, your save command, the handoff path and the handoff Claude wrote. They contain no other conversation text, and no address to send anything to.
- **Slash commands it runs** (`$.command.run`): `/clear`, only when `fresh_start` is on, when the turn in which Claude called `compact_now` ends; and `/compact`, only where Claude Code refuses a direct compaction (the desktop app's Code tab), when the turn in which Claude called `compact_now` ends. Its instructions: *"Keep what the next turn needs to continue: \<what Claude asked to keep\>. The full state is saved in \<handoff path\>; name that path in the summary."* Elsewhere it compacts directly with `$.session.compact`, with the same instructions.
- **What it reads:**
  - the context percentage and token counts (`$.session.usage`), whether anything is drawn (`$.session.surfaces`), the session id, and its own state files
  - the handoff file Claude names in `compact_now` (`$.fs.read`), to give its text back after the compaction
  - your prompts as you send them, only to see whether one asks for a compaction (see `prompt.submit` above)
  - environment variables:
    - `CLAUDE_STATE_DIR`, `HOME` and `USERPROFILE`, to find the state folder
    - `CLAUDE_CODE_ENTRYPOINT`, `CLAUDECODE` and `CLAUDE_CODE_CHILD_SESSION`, to tell a desktop chat from a script run
    - `CATNAP_OFF`, and its old name `COMPACT_WHEN_READY_OFF`
    - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and `CATNAP_AUTO_ORIG`, for the auto line
    - `CLAUDE_DELEGATE_LEG` and `CLAUDE_HARNESS_PROBE`, markers my own wrapper scripts set; elsewhere they do nothing
  - It reads no keys, tokens or other credentials. The only conversation text its hooks read is what Claude passes to `compact_now`, the handoff file it names there, and your prompts, which it only checks for a request to compact.
  - The `/check` command runs only when you type it. It asks Claude to run `bench/check.mjs`, which reads your local Claude Code transcript files and uses only numbers from them (token counts, timestamps, stop reasons, compaction markers), never message text. It prints a summary, writes nothing and sends nothing. Its `allowed-tools` line lets that one command (`node` on that one script) run without a permission prompt; it allows nothing else. `npx github:LippInc/catnap` runs the same script outside Claude Code: npm downloads it from this repository (`package.json` maps the command to `bench/check.mjs`, and the only code in the package is that script), and it does the same reading and nothing more.
- **Other calls:** `$.clock.every` and `$.clock.now` run its timer. `$.ui.toast` shows a short notice when something fails, or when a compaction left the context near the lines.

## Tested

- 91 automated tests (`claude plugin test .`), including the desktop app's refusal word for word. I broke twenty copies of the mod on purpose (three in 0.2; in 0.3, five for the auto line, seven for the drop fallback and five for desktop chats), and the tests fail on each one. Three more broken copies, for the rename: a tool name, a matcher or a manifest that disagrees with the others. Three of the tests exist to fail on those. Nine more broken copies in 0.3.5, for the floor guard (see [How it compacts](#how-it-compacts)): the tests fail on each one. Eight more in 0.3.6, for the handoff coming back in the continue message and the one-call nap; one of them is the whole of 0.3.5, which fails five of the new tests. Ten more in 0.3.7, for the line `compact_now` waits for; one of them takes the rule out, which fails six of the new tests. Nine more in 0.3.8, for `compact_now` riding along with the last action; one of them puts 0.3.7's step back, which fails two of the tests.
- The live runs below were made before the rename, when the mod was called compact-when-ready.
- Live on Windows 11, 2026-10-13:
  - **Desktop app Code tab (Claude Code 2.1.295):** `/compact` ran at 257K tokens and wrote a 29K-token summary. The continue message arrived and the work carried on.
  - **Terminal (Claude Code 2.1.293, Haiku 5.5):** the mod compacted directly at 66K tokens, with a 7K-token summary, in 10 seconds. Claude read the handoff and carried on.
- As catnap, headless with a 200K window (Claude Code 2.1.302), 2026-10-17 and 10-18:
  - **Windows 11:** 2 of 2 runs did the whole loop at the 50% note. Claude finished the feature it was on, wrote its handoff, compacted (context about 106K to 50-51K tokens) and carried on to a green finish.
  - **Linux (Ubuntu on WSL):** with the strict line at 50%, the same loop ran and the task finished green. In an earlier run with the strict line at 54%, Claude ignored the 50% note and finished the whole task before reaching 54%, so it never compacted.
- As catnap, interactive on Linux (Ubuntu on WSL, Claude Code 2.1.302, a terminal session, 200K window), 2026-10-18: 2 of 2 runs did the whole loop, with the mod compacting directly (no `/compact` fallback). In one, Claude had just finished the task when the note came, and after the compaction it said so. In the other it was mid-task and carried on to a green finish.
- catnap 0.3.6, headless with a 200K window (Claude Code 2.1.302, Opus 5.5), 2026-10-18: 6 of 6 runs on two 40-ticket coding tasks, 12 naps. Every time, the continue message carried the handoff Claude had passed to `compact_now`, word for word; catnap answered the one request after the call, so the turn ended without another model call; and Claude's first step after the compaction was the next step its handoff named.
- catnap 0.3.6, headless with a 1M window (Claude Code 2.1.303, Opus 5.5), 2026-10-19: 4 runs on a 250-ticket coding task, 16 naps, with the same three results each time. In 3 of the 4 runs Claude also napped on its own before the 50% note, from 12%; 0.3.7 stops that.
- catnap 0.3.7, headless with a 1M window (Claude Code 2.1.303, Opus 5.5), 2026-10-19: 3 runs on the 250-ticket task, 6 naps, every one at the 50% note (501K to 514K tokens). Claude never called `compact_now` before it, so catnap never had to answer "not yet", and every nap passed the same three checks. With Haiku 5.5 over stream-json (the desktop app's protocol), `/catnap:compact` at 5% context napped as asked, and Claude's own call to `compact_now` at 5% got "not yet" with nothing compacted; on 0.3.6 the same call compacted.
- catnap 0.3.8, headless with a 200K window (Claude Code 2.1.303, Opus 5.5), 2026-10-19: 6 of 6 runs on the two 40-ticket tasks, 11 naps. 10 rode along with the response that ran the last test; the other came when the note arrived after that test had already run. Every handoff written that way began with checking that test, and after the nap Claude re-ran it in the same call as starting the next ticket. Every nap passed the same three checks, and every run finished with all tests passing.
- The fresh start (catnap 0.3.7, `fresh_start` on) in a desktop app chat, 2026-10-19: asked for a nap at 8%, catnap cleared the conversation, its message opened the new one in the same chat with the handoff, and Claude did the step the handoff named. Headless before that: 16 of 16 clears on a 200K window and 12 of 12 on 1M passed the same three checks.
- The auto line, live on Claude Code 2.1.296, 2026-10-17:
  - **Changing the variable at runtime moves auto-compact both ways.** A test mod lowered it from 70 to 7 at session start. Auto-compact then fired at the first check past the 7% line (about 69K): at 87K tokens, once a large file read had come in. In the control run it didn't fire up to 112K. Raised from 7 to 12, it didn't fire up to 111K either.
  - **In a terminal session, the mod set it:** no value at the start, the toast for a line below the strict one, and `7` set 1.5 seconds later, from `config.json`.
- Compactions the mod didn't run, live on Claude Code 2.1.302, 2026-10-17 (terminal, Haiku 5.5, a personal Max plan, auto-compact moved to 40%, a subagent called at about 27% context):
  - **Without `sec-default`, the `session.compact` hook still runs.** Auto-compact fired at 391K tokens (with a 20K summary), and the hook reported it. The drop fallback then stayed quiet, so nothing was counted twice. It also stayed quiet while the subagent ran.
  - **The drop fallback catches what the hook doesn't report.** In a copy whose hook only noted that it ran and didn't reset, as where `sec-default` holds it back, the same auto-compaction was caught 5 seconds later at the next check: context from 38% to 8%, logged once.
- Desktop chats with no window attached, on Claude Code 2.1.299, 2026-10-17:
  - **The bug:** in a real chat, one long turn crossed 50% and then 60% with no note. The app had no window attached to the chat, and 0.2 only acted while one was. The first note came at 63%, right after a new prompt was typed in that chat.
  - **The fix, on the same engine with nothing attached** (test lines at 1% and 2%): 0.3 knew it was a desktop chat, gave the note at 5% and asked at the turn end. A `claude -p` started from inside a chat stayed silent. With the fix taken out, the first run was silent too, as the real chat had been.
- **Not tested:** macOS, the VS Code extension, long real sessions in a terminal, the auto line in the desktop app's Code tab, and a session with `sec-default` really seated (that needs an organization's managed settings).

## Limits

- Claude has to follow the notes. In the terminal test Haiku wrote a sentence after calling the tool instead of stopping. That was harmless: the compaction still ran when the turn ended.
- The notes arrive inside tool results, so each one costs a few hundred tokens.
- The context breakdown (the SDK's `get_context_usage`, the mods API's `usage({ breakdown })`) still reports Claude Code's default auto-compact point, not the line the variable sets ([anthropics/claude-code#97568](https://github.com/anthropics/claude-code/issues/97568)). Auto-compact itself follows the variable.
- Where an organization manages Claude Code (managed settings on the machine, or a Team or Enterprise plan), Claude Code seats its built-in `sec-default` mod. Since 2.1.299 that mod keeps the `session.compact` hook from running in mods you install ([anthropics/claude-code#102134](https://github.com/anthropics/claude-code/issues/102134)). Two things change there:
  - A compaction the mod didn't run is spotted only by the context falling 20 points or more. That covers the default lines: in the live test an auto-compaction at 38% left 8%, the messages it keeps included. With lines set below about 35%, or on a small window where the kept messages weigh more, a compaction can fall by less. The notes for that round then come late or not at all.
  - If auto-compact runs after Claude has called `compact_now` but before its turn ends, the mod still compacts at the turn end. That is a second, small compaction, and the continue message follows as usual.
- A switch to a model with a larger window also makes the context fall sharply. The mod counts that as a compaction too, so the notes start over. No harm is done: the notes follow the new percentages.
- The mods API is early access and changes between Claude Code releases, so an update can break this mod.
- A compaction is a summary. Anything that isn't in a file is at risk, which is what the save step is for.

## Related

- [disler/self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent) does the same for the Pi coding agent: the agent watches its own context, writes a note to itself and compacts, at lines you set.

## Privacy

catnap collects nothing and sends nothing anywhere. It makes no network requests, no model calls of its own and starts no processes, and it has no account, telemetry or analytics. What it keeps stays on your machine, in its own state folder (see [Files it writes](#files-it-writes)). The two prompts it submits go into your own session and hold only the text listed under [What it can reach](#what-it-can-reach). The `/check` command (and `npx github:LippInc/catnap`, the same script) reads your local Claude Code transcripts on your machine for numbers only, and sends nothing.

## License

MIT, Martin Lipp ([LippInc](https://github.com/LippInc)). Not affiliated with Anthropic. If it saved you a re-read, a star helps other people find it. If it misbehaves on your setup, an issue saying what happened is the most useful thing you can send. The session's `.log.json` helps.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/LippInc/catnap/main/docs/stamp-dark.svg">
  <img alt="" src="https://raw.githubusercontent.com/LippInc/catnap/main/docs/stamp-light.svg" width="64">
</picture> made by <a href="https://wayflare.eu">Wayflare</a>

