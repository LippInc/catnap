---
description: Compact now, at a clean break - Claude finishes the piece it is on, writes a handoff, compacts and carries on by itself
argument-hint: "[what the summary should keep]"
allowed-tools: 'mcp__catnap__compact_now'
---

Compact this conversation now, at a clean break, the way catnap does at its lines:

1. If you are in the middle of something, finish only the piece you are on and stop at the nearest clean point. Start nothing new.
2. Write your handoff: what is done, what is next, open decisions and which files matter. If nothing has been done yet, one line saying so is enough. If the project keeps its own handoff file, update that file too.
3. Call the `compact_now` tool with your handoff as `note` (and that project file's path as `handoff`, if you updated one), and as `keep`: $ARGUMENTS (if that is empty, the current task and its next step).
4. End your reply right after the call. Write nothing more.

After the compaction catnap gives you your handoff back, word for word: carry on with the next step it names.
