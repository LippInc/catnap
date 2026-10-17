# self-compact: Claude compacts itself at a clean break

A Claude Code mod. In a long session, auto-compact fires whenever the window fills, often in the middle of an edit. This mod lets Claude pick the moment instead. Claude is told early that a compaction is coming. It finishes the piece it is working on, saves a handoff file, calls a `compact_now` tool and ends its turn. The mod then compacts the conversation and sends Claude a message to carry on from the handoff. You don't type anything.

## What happens

- **At 50% context:** one note on a tool result. It tells Claude to finish the piece it is on properly (the page, the section, the feature), and to save and compact at that clean break.
- **At 60%:** a strict note telling Claude to save and compact now. It repeats every 2 points until Claude does. If a turn ends past 60% without a compaction, the mod asks with a prompt of its own, again every 5 points.
- **`compact_now`:** when that turn ends, the mod compacts the conversation and tells the summary to keep what Claude named. Then it sends Claude a message: *"The conversation was just compacted at your request ... Your handoff: <file>. Read it first, then carry on exactly where you left off."*
- Claude Code's own auto-compact stays on as the backstop.

## Install

You need Claude Code v2.1.287 or later, or v2.1.286 in the desktop app. In your shell:

```bash
claude plugin marketplace add LippInc/self-compact
```

```bash
claude plugin install self-compact@lippinc
```

You can also do both from a terminal session: `/plugin install self-compact --marketplace LippInc/self-compact`. New sessions load it on their own, including the desktop app's Code tab. A session that is already open needs `/reload-plugins` first.

A mod is code that runs with your permissions. Before you install it, clone the repository and run `claude plugin validate .` to list every event it hooks and every call it makes. The list is also under [What it can reach](#what-it-can-reach).

## Settings

| Option | Default | What it does |
| :- | :- | :- |
| `soft_percent` | 50 | Where the soft note comes. Set it at or above the strict line to turn the soft note off. |
| `strict_percent` | 60 | Where the strict note comes. |
| `save_step` | empty | A command Claude runs to save its work before compacting, for example `/save-before-compact` from [save-before-compact](https://github.com/LippInc/save-before-compact). Left empty, Claude writes a handoff file itself. |

You can change these in `/config`, or from the shell:

```bash
echo '{"save_step": "/save-before-compact", "strict_percent": "65"}' | claude plugin configure self-compact@lippinc --values-stdin
```

- **Turn it off for one process:** set `SELF_COMPACT_OFF=1`.
- **Turn it off everywhere:** disable the plugin in `/plugin`.
- **Auto-compact:** keep it above the strict line, or the mod never gets its turn. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can only lower auto-compact. I run it at 70 as the backstop.

## How it compacts

- **In a terminal session**, the mod compacts directly, between turns.
- **In the desktop app's Code tab**, a direct compaction is refused ("not available in a headless (-p / SDK) session"). There the mod runs `/compact` with its instructions, as if you had typed it.
- **If `/compact` fails**, because it is refused or hasn't compacted within 10 minutes, the mod gives up for that round. It shows a toast and stays quiet until a compaction happens some other way, and auto-compact still applies.
- **It stays out where nothing is drawn**, such as `claude -p` runs and SDK sessions without a surface. Subagents get no notes and can't call the tool.

## Files it writes

All its files go in `~/.claude/state/self-compact/`, or in `$CLAUDE_STATE_DIR/self-compact/` if you set that variable:

- **`<session id>.json`** is `{"pending": true, ...}` while a compaction is queued. If you have a Stop hook that keeps turns going, make it stay quiet while this file is fresh. Otherwise the turn never ends and the compaction never runs.
- **`<session id>.log.json`** holds the last 60 events (notes, queued, compacted, gave up) for debugging. Only sessions that draw something get one.
- **`config.json`** is optional. It overrides the options live, with no reload: `{"soft": 50, "threshold": 60, "off": false}`.

## What it can reach

This is what `claude plugin validate` reports:

- **Hooks:** `session.start`, `tool.call`, `turn.complete`, `session.compact`, `session.end`
- **Calls:** `$.clock.every`, `$.clock.now`, `$.command.run` (only `/compact`), `$.env.get`, `$.fs.read`, `$.fs.write` (only the state folder), `$.prompt.submit` (the continue message and the turn-end ask), `$.session.compact`, `$.session.id`, `$.session.surfaces`, `$.session.usage`, `$.tool.register` (`compact_now`), `$.ui.toast`
- **Environment reads:** `CLAUDE_STATE_DIR`, `HOME`, `USERPROFILE`, `SELF_COMPACT_OFF`, `CLAUDE_DELEGATE_LEG`, `CLAUDE_HARNESS_PROBE`. The last two are markers my own wrapper scripts set; elsewhere they do nothing.

It makes no network requests and no model calls, and starts no processes.

## Tested

- 29 automated tests (`claude plugin test .`), including the desktop app's refusal word for word. I broke three copies of the mod on purpose, and the tests fail on each one.
- Live on Windows 11, 2026-10-13:
  - **Desktop app Code tab (Claude Code 2.1.295):** `/compact` ran and cut the chat from 257K to 29K tokens. The continue message arrived and the work carried on.
  - **Terminal (Claude Code 2.1.293, Haiku 5.5):** the mod compacted directly, from 66K to 7K tokens in 10 seconds. Claude read the handoff and carried on.
- **Not tested:** macOS, Linux, the VS Code extension, and long real sessions in a terminal.

## Limits

- Claude has to follow the notes. In the terminal test Haiku wrote a sentence after calling the tool instead of stopping. That was harmless: the compaction still ran when the turn ended.
- The notes arrive inside tool results, so each one costs a few hundred tokens.
- The mods API is early access and changes between Claude Code releases, so an update can break this mod.
- A compaction is a summary. Anything that isn't in a file is at risk, which is what the save step is for.

## License

MIT, Martin Lipp ([LippInc](https://github.com/LippInc)). Not affiliated with Anthropic. If it misbehaves on your setup, an issue saying what happened is the most useful thing you can send. The session's `.log.json` helps.
