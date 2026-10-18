<img alt="catnap: a pixel cat asleep on its notes" src="launch/catnap.svg" width="340">

# catnap

**Claude naps at a clean break. Not mid-task.**

```text
finish the thought.
leave a note.
nap.
wake up knowing everything.
```

Claude Code compacts your conversation when the context window fills up, usually in the middle of a task. catnap gives Claude a heads-up at 50% instead. Claude finishes the piece it is on, writes itself a handoff note, compacts, and carries on by itself. You don't type anything.

| | Without catnap | With catnap |
| :- | :- | :- |
| When it compacts | when the window is nearly full | when Claude finishes the piece it is on, from 50% |
| Compactions in the middle of a task | 78 of 82 auto-compactions in the author's last 30 days of logs | none in the author's real work in 5 days with it (13 of 13 at a moment Claude picked) |
| Right after | Claude re-reads files and works out where it was | Claude reads its own note and carries on |
| Context re-read in long sessions | baseline | **about 30% less**\* (17.5% over a whole month, short sessions included) |

\*Measured by replaying the author's 9 real long sessions with the mod against Claude Code's default auto-compact point: 33.0% less. One known bias pushes that up, so we say about 30%. Per session it ran from about 0% (sessions that ended right after compacting) to 46%. Against an auto-compact line already set to 70%, it was 16%. Most of the saving comes from compacting earlier. A lower auto-compact setting does that too, but auto-compact lands mid-task almost every time; this waits for a clean break. These are tokens re-read, not plan usage: on a subscription the saving in usage is smaller, because cache reads weigh less. Script and per-session table: [bench/REPLAY.md](bench/REPLAY.md).

**Check your own history in seconds:** `/catnap:check` inside Claude Code (or `node bench/check.mjs` from a clone) reads your local Claude Code logs and prints numbers only (nothing leaves your machine) and tells you how often auto-compact cut in mid-task and what a clean-break compaction would have saved. Your number will differ: it covers all your sessions, short ones included, so it is usually lower than the long-session replay above (17.5% on the author's last 30 days). The author's last 30 days: 78 of 82 auto-compactions landed while Claude was in the middle of a tool loop. That is not bad luck: on the author's machine about 92% of Claude's calls end in a tool call, and auto-compact doesn't wait for a clean break.

You set the lines; Claude picks the moment inside them. The mod compacts nothing until Claude has finished its piece and written its note (Claude Code's own auto-compact stays on as the backstop), and one setting turns it all off.

## Install

You need Claude Code v2.1.287 or later, or v2.1.286 in the desktop app. In your shell:

```bash
claude plugin marketplace add LippInc/compact-when-ready
```

```bash
claude plugin install catnap@lippinc
```

Or from a terminal session: `/plugin install catnap --marketplace LippInc/compact-when-ready`. New sessions load it on their own, including the desktop app's Code tab. A session that is already open needs `/reload-plugins` first.

catnap is a mod: code that runs with your permissions. It makes no network calls and writes only to its own state folder. Before you install it, clone the repository and run `claude plugin validate .`: it lists every event catnap hooks and every call it makes (also under [What it can reach](#what-it-can-reach)).

## Works with

| Agent | Status |
| :- | :- |
| Claude Code | the original: a mod, everything above |
| OpenCode | a plugin, [ports/opencode](ports/opencode). Tested live on OpenCode 1.19.0 under `opencode serve` with a free model; a bare `opencode run` exits before the compaction, and the TUI is not tested yet |
| Gemini CLI | an extension, [ports/gemini-cli](ports/gemini-cli). Gemini CLI has no compaction a hook can start, so the port clears the context and the model carries on from its own handoff. The full loop ran live twice (Gemini CLI 0.64.0, `gemini-3-flash-preview`, headless); the interactive screen is not tested |
| Codex, Cursor | partial at best: their hooks can continue a session but cannot start a compaction |
| Windsurf | not possible today: no hook can continue a session or see context use |

## What happens

- **At 50% context:** one note on a tool result. It tells Claude to finish the piece it is on properly (the page, the section, the feature), and to save and compact at that clean break.
- **At 60%:** a strict note telling Claude to save and compact now. It repeats every 2 points until Claude does. If a turn ends past 60% without a compaction, catnap asks with a prompt of its own, again every 5 points.
- **`compact_now`:** when that turn ends, catnap compacts the conversation and tells the summary to keep what Claude named. Then it sends Claude a message: *"The conversation was just compacted at your request ... Your handoff: <file>. Read it first, then carry on exactly where you left off."*
- **At 70%:** Claude Code's own auto-compact, the backstop if Claude hasn't compacted by then. Without catnap it would wait until the window is nearly full.

All three lines are settings (below).

