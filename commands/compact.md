---
description: Compact now, at a clean break - Claude finishes the piece it is on, writes a handoff, compacts and carries on by itself
argument-hint: "[what the summary should keep]"
allowed-tools: 'mcp__catnap__compact_now'
---

Compact this conversation now, at a clean break, the way catnap does at its lines:

1. If you are in the middle of something, finish only the piece you are on and stop at the nearest clean point. Start nothing new.
2. Save a handoff file: what is done, what is next, and which files matter. If the project names a place for handoffs, use it; otherwise write `handoff.md` in the working folder. If nothing has been done yet, one line saying so is enough.
3. Call the `compact_now` tool with that file's path as `handoff`, and as `keep`: $ARGUMENTS (if that is empty, the current task and its next step).
4. End your reply right after the call. Write nothing more.

After the compaction catnap tells you to carry on: read the handoff first, then continue with its next step.
