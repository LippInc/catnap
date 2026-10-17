# compact-when-ready for OpenCode

An [OpenCode](https://opencode.ai) plugin. It is a port of the Claude Code mod compact-when-ready: in a long session the model is told early that a compaction is coming. It finishes the piece it is working on, saves a handoff file, calls a `compact_now` tool and ends its turn. The plugin then compacts the session and sends the model a message to carry on from the handoff. You type nothing.

Status: version 0.1.0, tested against OpenCode 1.19.0 on Windows 11 with one free model (see [LIVE-TEST.md](LIVE-TEST.md)). Not published to npm.

## What happens

- **Soft line (default 50% of the model's window):** one note, once per cycle. It tells the model to finish the piece it is on properly (the function, the section, the test), then save a short handoff file and call `compact_now`.
- **Strict line (default 60%):** a stricter note ("save and compact now"), repeated every 2 points until the model calls `compact_now`.
- **`compact_now`** (a tool the model can call; arguments `handoff`, the path of the handoff file, and optional `keep`, what the summary must keep): it only records the request. It answers "Compaction queued. End your turn now." Other tool results then carry a short "compaction is queued, end your turn" note.
- **Session goes idle** with a request pending: the plugin calls `client.session.summarize` (with the provider and model of the latest assistant message), then `client.session.promptAsync` (under the same agent as the latest assistant message, so a `plan` or read-only custom agent stays in force) with: *"[compact-when-ready] The conversation was just compacted at your request ... Your handoff: <file>. Read it first, then carry on exactly where you left off ..."*
- **Cancelled or errored turn:** if the newest assistant message ended with an error (you pressed Esc, a provider error), the request stays queued and the plugin logs `idle-after-error`; the next turn that ends normally runs the compaction.
- **Never loops:** one compaction per request. If summarize fails, it is retried once; after the second failure the plugin logs `gave-up`, shows a toast (if a TUI is attached) and stays quiet until a compaction happens some other way or the model calls `compact_now` again. A summarize that has not finished after 10 minutes counts as a failure. If the compaction worked but the continue message cannot be sent (two tries), the plugin logs `continue-gave-up` and shows a toast, and the notes stay on for the new cycle.

How the context is measured: after every assistant message (`message.updated`) it is `tokens.input + tokens.output + tokens.cache.read + tokens.cache.write` of the latest assistant message, as a percent of the model's window. The window is the `window` option if you set one, otherwise `limit.context` of the model from `client.config.providers()`. If neither is known there are no notes (one `no-window` line in the log). The compaction's own summary message is ignored, and `session.compacted` starts the cycle over.

## Install

You need OpenCode 1.19.0 or later. The plugin imports `tool` from `@opencode-ai/plugin`, so that package must be resolvable from the plugin folder (`npm install` in this folder does it; `package.json` lists it as a peer and a dev dependency).

Add the plugin to your `opencode.json` (this form, with a `file://` path and an options tuple, is what was tested):

```json
{
  "plugin": [
    ["file:///C:/path/to/compact-when-ready-opencode/index.ts", { "soft": 50, "strict": 60 }]
  ]
}
```

Loading it by npm name (`"compact-when-ready-opencode"`) or from `.opencode/plugin/` is how OpenCode documents plugins, but it was not tried here, because the package is not published.

## Options

Set in the options object of the plugin entry, or as environment variables (the variable wins).

| Option | Environment variable | Default | What it does |
| :- | :- | :- | :- |
| `soft` | `COMPACT_WHEN_READY_SOFT` | 50 | Percent of the window for the soft note. At or above `strict`, the soft note is off. |
| `strict` | `COMPACT_WHEN_READY_STRICT` | 60 | Percent for the strict note. |
| `window` | `COMPACT_WHEN_READY_WINDOW` | the model's `limit.context` | Window size in tokens (1000 or more). Overrides the model's own figure. |
| `off` | `COMPACT_WHEN_READY_OFF` | off | `COMPACT_WHEN_READY_OFF=1` (any value except empty, `0`, `false`, `no`) makes the plugin do nothing: no tool, no hooks, no log. |
| `logDir` | `COMPACT_WHEN_READY_LOG_DIR` | see below | Folder for the log. |

## Why the notes go in tool results

The note is appended to a tool call's output in the `tool.execute.after` hook. The alternative, `experimental.chat.system.transform`, would change the system prompt on every call: the note would be re-sent each time, and it can break the provider's prompt cache for the stable part of the prompt. A note in a tool result is written into the conversation once, reaches the model at its next step, and costs a few hundred tokens once. The price: a turn with no tool call gets no note, and the percent a note quotes is one step old (it is the last finished assistant message).

## What it touches

- **Writes:** one JSON-lines log per session, `<state>/compact-when-ready-opencode/<session id>.jsonl`, where `<state>` is `$XDG_STATE_HOME` or else `~/.local/state` (on Windows too: `C:\Users\<you>\.local\state`). Events: `start`, `note`, `queued`, `summarize-failed`, `compacted`, `continued`, `continue-failed`, `continue-gave-up`, `gave-up`, `idle-after-error`, `compacted-elsewhere`, `keep-passed`, `no-window`, and `event-error` / `hook-error`. No other file is written. It never edits your OpenCode config.
- **Reads:** the environment variables above and `XDG_STATE_HOME`; model windows through `client.config.providers()`; session info through `client.session.get` (to tell a subagent session from a main one).
- **Calls on the local OpenCode server (through the plugin client):** `session.summarize`, `session.promptAsync`, `config.providers`, `session.get`, `tui.showToast`.
- **Hooks:** `event` (`message.updated`, `session.created`, `session.idle`, `session.status`, `session.compacted`), `tool.execute.after`, `experimental.session.compacting` (adds the `keep` text and the handoff path to the compaction prompt, only while a compaction the plugin started is running).
- **Network:** none of its own. The prompts it sends go into your own session and hold only the plugin's text, the context percent and the handoff path.

## Backstop: OpenCode's own auto-compaction

The plugin does not change it. `compaction.auto` stays at its default (`true`), so if the model ignores the notes OpenCode compacts when the window is full, possibly in the middle of an edit. OpenCode's docs list `compaction: { "auto": true, "prune": false, "reserved": 10000 }`; `reserved` is a token buffer left free for the compaction. If your version supports it, a larger `reserved` makes OpenCode's own compaction start earlier, which is not what you want here: leave it at the default so the plugin's lines (50% and 60%) come first and the built-in compaction stays the last resort. The auto-compaction ends the cycle too (`session.compacted`), and the notes start over. This was not exercised in the live test.

## Limits

- **`opencode run` on its own does not finish the job.** `run` ends at the first idle, which is the very moment the plugin starts the compaction, so the process is gone before the compaction and the continue message happen (seen live, see LIVE-TEST.md). Use the TUI, `opencode serve` with `opencode run --attach <url>` or another client that stays up.
- The model has to follow the notes. In the live test the free model did, each time (see LIVE-TEST.md), but that is one model.
- A turn that ends past the strict line without `compact_now` gets no extra prompt (the Claude Code original asks in that case). OpenCode's own auto-compaction is the fallback.
- Subagent sessions (those with a parent) get no notes and cannot call `compact_now`.
- The summarize call has no field for instructions; the `keep` text reaches the summary through the experimental `experimental.session.compacting` hook, which may change between OpenCode versions. The live log shows the hook ran (`keep-passed`); whether the summary honoured the text was not measured.
- A compaction is a summary. Anything that is not in a file is at risk, which is what the handoff file is for.
- The percent is computed from the last finished assistant message, so it lags one step behind.
- Tested only on Windows, with a `file://` plugin path, with OpenCode 1.19.0, through `opencode serve` / `run --attach`. Not tested: the TUI, the desktop app, other models, macOS, Linux, npm install by name.

## Tests

```bash
npm install          # fetches @opencode-ai/plugin and the dev tools into ./node_modules
npm test             # bun test: 38 unit tests with a fake client
npm run typecheck    # tsc --strict against the installed @opencode-ai/plugin types
```

`node_modules/` is generated and should not be committed.

## License

MIT, Martin Lipp ([LippInc](https://github.com/LippInc)). Not affiliated with OpenCode or Anthropic.
