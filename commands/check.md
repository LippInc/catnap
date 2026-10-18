---
description: Check your own Claude Code history - how often auto-compact cut in mid-task, and what compacting at a clean break would have saved
argument-hint: "[--days 30] [--soft 50] [--auto 70]"
---

Run this once with the Bash tool. It reads only your local Claude Code logs (numbers, never their text), makes no network calls and writes nothing:

`node "${CLAUDE_PLUGIN_ROOT}/bench/check.mjs" $ARGUMENTS`

Show the user its output as it is. Then add one or two plain sentences on what the numbers mean for them. Do not run anything else. If `node` is missing or the script fails, say so in one line and stop.
