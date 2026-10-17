# compact-when-ready: Claude compacts itself at a clean break

A Claude Code mod. In a long session, auto-compact fires whenever the window fills, often in the middle of an edit. This mod lets Claude pick the moment instead. Claude is told early that a compaction is coming. It finishes the piece it is working on, saves a handoff file, calls a `compact_now` tool and ends its turn. The mod then compacts the conversation and sends Claude a message to carry on from the handoff. You don't type anything.

## What happens

- **At 50% context:** one note on a tool result. It tells Claude to finish the piece it is on properly (the page, the section, the feature), and to save and compact at that clean break.
- **At 60%:** a strict note telling Claude to save and compact now. It repeats every 2 points until Claude does. If a turn ends past 60% without a compaction, the mod asks with a prompt of its own, again every 5 points.
- **`compact_now`:** when that turn ends, the mod compacts the conversation and tells the summary to keep what Claude named. Then it sends Claude a message: *"The conversation was just compacted at your request ... Your handoff: <file>. Read it first, then carry on exactly where you left off."*
- **At 70%:** Claude Code's own auto-compact, the backstop if Claude hasn't compacted by then. It can cut in mid-turn. Without the mod it would wait until the window is nearly full.

All three lines are settings (below).

## Install

You need Claude Code v2.1.287 or later, or v2.1.286 in the desktop app. In your shell:

```bash
claude plugin marketplace add LippInc/compact-when-ready
```

```bash
claude plugin install compact-when-ready@lippinc
```

You can also do both from a terminal session: `/plugin install compact-when-ready --marketplace LippInc/compact-when-ready`. New sessions load it on their own, including the desktop app's Code tab. A session that is already open needs `/reload-plugins` first.

A mod is code that runs with your permissions. Before you install it, clone the repository and run `claude plugin validate .` to list every event it hooks and every call it makes. The list is also under [What it can reach](#what-it-can-reach).

## Settings

| Option | Default | What it does |
| :- | :- | :- |
| `soft_percent` | 50 | Where the soft note comes. Set it at or above the strict line to turn the soft note off. |
| `strict_percent` | 60 | Where the strict note comes. |
| `auto_percent` | 70 | Where Claude Code's own auto-compact runs. Keep it above the strict line, or Claude Code compacts before Claude is asked to (the mod shows a toast if it isn't). `0` leaves Claude Code's own setting alone. |
| `save_step` | empty | A command Claude runs to save its work before compacting, for example `/save-before-compact` from [save-before-compact](https://github.com/LippInc/save-before-compact). Left empty, Claude writes a handoff file itself. |

You can change these in `/config`, or from the shell:

```bash
echo '{"save_step": "/save-before-compact", "strict_percent": "65", "auto_percent": "75"}' | claude plugin configure compact-when-ready@lippinc --values-stdin
```

A change there applies to sessions that start after it, or to an open one after `/reload-plugins`. To move a line in a session that is already running, use `config.json` (see [Files it writes](#files-it-writes)). It is re-read on every check.

- **Turn it off for one process:** set `COMPACT_WHEN_READY_OFF=1`. Auto-compact is then left as Claude Code has it.
- **Turn it off everywhere:** disable the plugin in `/plugin`.
- **How the auto line works:** the mod sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in Claude Code's own process, the same variable you could set yourself. While the mod is on, its setting wins over one in your settings files. That one still applies when the mod is off, so it's a good fallback to keep. Turning the mod off in `config.json`, or setting the line to `0`, puts back whatever the variable held before. Programs Claude starts from the session (Bash commands, a nested `claude`) inherit the value.
- **Limits of the auto line:** Claude Code can only move auto-compact earlier than its own default, never later, so values near 100 do nothing. Like the notes, it is only set in a person's session (a terminal, or a desktop app chat): `claude -p` runs keep Claude Code's own setting.

## How it compacts

- **In a terminal session**, the mod compacts directly, between turns.
- **In the desktop app's Code tab**, a direct compaction is refused ("not available in a headless (-p / SDK) session"). There the mod runs `/compact` with its instructions, as if you had typed it.
- **If `/compact` fails**, because it is refused or hasn't compacted within 10 minutes, the mod gives up for that round. It shows a toast and stays quiet until a compaction happens some other way, and auto-compact still applies.
- **A compaction the mod didn't run** (auto-compact, or a `/compact` you type) starts the notes over. Claude Code reports it through the `session.compact` hook. Where that hook is held back (see [Limits](#limits)), the mod spots it from the context instead: a fall of 20 points or more between two checks, while nothing of its own is queued, counts as a compaction.
- **It stays out of scripted runs:** `claude -p` runs, including ones started from inside a chat, and SDK sessions with nothing drawn. Subagents get no notes and can't call the tool.
- **A desktop app chat counts as yours even while no window shows it.** The app attaches its window to a chat and detaches it again as it goes, so the mod knows the app's chats by Claude Code's entry point (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`). A `claude -p` started from inside a chat inherits that, but Claude Code also marks it as started from another session (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`), so it stays out.

## Files it writes

All its files go in `~/.claude/state/compact-when-ready/`, or in `$CLAUDE_STATE_DIR/compact-when-ready/` if you set that variable:

- **`<session id>.json`** is `{"pending": true, ...}` while a compaction is queued. If you have a Stop hook that keeps turns going, make it stay quiet while this file is fresh. Otherwise the turn never ends and the compaction never runs.
- **`<session id>.log.json`** holds the last 60 events (notes, queued, compacted, gave up) for debugging. Only a person's session gets one, or a session where the mod did something.
- **`config.json`** is optional. It overrides the options live, with no reload: `{"soft": 50, "threshold": 60, "auto": 70, "off": false}`. `threshold` is the strict line.

## What it can reach

This is what `claude plugin validate` reports:

- **Hooks:** `session.start`, `tool.call`, `turn.complete`, `session.compact`, `session.end`
- **Calls:** `$.clock.every`, `$.clock.now`, `$.command.run` (only `/compact`), `$.env.get`, `$.env.set` (only the two variables below), `$.fs.read`, `$.fs.write` (only the state folder), `$.prompt.submit` (the continue message and the turn-end ask), `$.session.compact`, `$.session.id`, `$.session.surfaces`, `$.session.usage`, `$.tool.register` (`compact_now`), `$.ui.toast`
- **Environment reads:** `CLAUDE_STATE_DIR`, `HOME`, `USERPROFILE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `COMPACT_WHEN_READY_OFF`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `COMPACT_WHEN_READY_AUTO_ORIG`, `CLAUDE_DELEGATE_LEG`, `CLAUDE_HARNESS_PROBE`. The last two are markers my own wrapper scripts set; elsewhere they do nothing.
- **Environment writes:** `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (the auto line) and `COMPACT_WHEN_READY_AUTO_ORIG` (what it held before, so it can be put back after a reload).

It makes no network requests and no model calls, and starts no processes.

## Tested

- 55 automated tests (`claude plugin test .`), including the desktop app's refusal word for word. I broke twenty copies of the mod on purpose (three in 0.2; in 0.3, five for the auto line, seven for the drop fallback and five for desktop chats), and the tests fail on each one.
- Live on Windows 11, 2026-10-13:
  - **Desktop app Code tab (Claude Code 2.1.295):** `/compact` ran and cut the chat from 257K to 29K tokens. The continue message arrived and the work carried on.
  - **Terminal (Claude Code 2.1.293, Haiku 5.5):** the mod compacted directly, from 66K to 7K tokens in 10 seconds. Claude read the handoff and carried on.
- The auto line, live on Claude Code 2.1.296, 2026-10-17:
  - **Changing the variable at runtime moves auto-compact both ways.** A test mod lowered it from 70 to 7 at session start. Auto-compact then fired at the first check past the 7% line (about 69K): at 87K tokens, once a large file read had come in. In the control run it didn't fire up to 112K. Raised from 7 to 12, it didn't fire up to 111K either.
  - **In a terminal session, the mod set it:** no value at the start, the toast for a line below the strict one, and `7` set 1.5 seconds later, from `config.json`.
- Compactions the mod didn't run, live on Claude Code 2.1.302, 2026-10-17 (terminal, Haiku 5.5, a personal Max plan, auto-compact moved to 40%, a subagent called at about 27% context):
  - **Without `sec-default`, the `session.compact` hook still runs.** Auto-compact cut 391K tokens to 20K, and the hook reported it. The drop fallback then stayed quiet, so nothing was counted twice. It also stayed quiet while the subagent ran.
  - **The drop fallback catches what the hook doesn't report.** In a copy whose hook only noted that it ran and didn't reset, as where `sec-default` holds it back, the same auto-compaction was caught 5 seconds later at the next check: context from 38% to 8%, logged once.
- Desktop chats with no window attached, on Claude Code 2.1.299, 2026-10-17:
  - **The bug:** in a real chat, one long turn crossed 50% and then 60% with no note. The app had no window attached to the chat, and 0.2 only acted while one was. The first note came at 63%, right after a new prompt was typed in that chat.
  - **The fix, on the same engine with nothing attached** (test lines at 1% and 2%): 0.3 knew it was a desktop chat, gave the note at 5% and asked at the turn end. A `claude -p` started from inside a chat stayed silent. With the fix taken out, the first run was silent too, as the real chat had been.
- **Not tested:** macOS, Linux, the VS Code extension, long real sessions in a terminal, the auto line in the desktop app's Code tab, and a session with `sec-default` really seated (that needs an organization's managed settings).

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

## License

MIT, Martin Lipp ([LippInc](https://github.com/LippInc)). Not affiliated with Anthropic. If it misbehaves on your setup, an issue saying what happened is the most useful thing you can send. The session's `.log.json` helps.
