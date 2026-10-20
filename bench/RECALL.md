# Recall benchmark: what Claude still knows of the chat right after a compaction

At a nap, catnap puts Claude's own handoff where Claude Code's summary would go, with the person's newest messages word
for word. A short handoff could lose something the person said that a summary keeps. This benchmark asks Claude, right
after a compaction, to list from memory everything the person told it, and then checks the code it writes next.

## Setup

- As in [PAIRED.md](PAIRED.md): Opus 5.5 at effort medium, a 200K window, a fresh Claude Code profile per run (Claude
  Code 2.1.303), stream-json with the desktop app's entry point, the 40-ticket synthetic backlog (each ticket a small
  module with its own tests).
- The session goes one ticket per message, the way a person works: the driver names a ticket, waits for the turn to
  end, then names the next.
- Arms: catnap at its defaults, and Claude Code's auto-compact at 55%, which cuts near 100K, where catnap naps on
  this window.
- **Easy round:** ten short items said in the chat at T02-T11 and nowhere else: seven working rules (a docstring line,
  `__all__`, a `TICKET` constant, type annotations, a closing comment, private helpers, a reply line `Done Tnn:`) and
  three facts about later tickets.
- **Hard round:** twenty items (the seven rules and thirteen facts with exact details: names, numbers, a server name)
  inside chatty messages of about 1,100 characters each, with project chatter around them and after them. By the probe,
  catnap 0.3.9 kept only the newest 12,000 characters of the person's messages word for word, so the early items
  reached Claude only through its own handoff, or a notes file it chose to keep.
- **The probe**, right after the first compaction once every item had been said: *"Answer from memory only: don't open,
  read or search any files and don't run anything. List (1) every rule or instruction I've given you in this chat so
  far, as exactly as you can, (2) any decisions or facts I've told you about upcoming tickets or the project, (3) the
  last ticket you finished."* No run used a tool during the probe. Then eight more tickets: the modules they produced
  are checked for the six code rules, and Claude's replies for the `Done Tnn:` line.
- **Scoring:** an item counts as named when the answer contains its key (the exact string, name or number only that
  item gives). Every miss was also read by hand; two were the scorer's (an answer said "350-cent" for 3.5 euro, another
  "helpers start with `_`"), and the keys were widened, with self-test cases, to accept them. The self-test: full
  answers name every item, empty and near-miss answers don't; a module that keeps the rules passes all six checks, one
  that breaks them fails all six.
- A first try of the easy round was stopped and not counted: its probe came at the first compaction (near T06), before
  all ten items had been said.

## Results (2026-10-20)

Easy round:

| arm | runs | items named after the compaction | code rules kept after it | `Done Tnn:` replies after it |
| :- | -: | -: | -: | -: |
| auto-compact at 55% | 3 | 30 of 30 | 162 of 162 | 24 of 24 |
| catnap 0.3.9 | 3 | 30 of 30 | 162 of 162 | 24 of 24 |

Hard round:

| arm | runs | items named after the compaction | code rules kept after it | `Done Tnn:` replies after it | the reply on the compaction's own step |
| :- | -: | -: | -: | -: | -: |
| auto-compact at 55% | 5 | 100 of 100 | 270 of 270 | 40 of 40 | 14 of 14 |
| catnap 0.3.9 | 3 | 60 of 60 | 162 of 162 | 23 of 24 | 5 of 7 |
| catnap 0.3.10, first build (48,000 characters kept; the handoff carries standing instructions) | 6 | 120 of 120 | 324 of 324 | 46 of 48 | 12 of 15 |
| catnap 0.3.10 as released (and the reply after a nap that rode along) | 6 | 120 of 120 | 324 of 324 | 48 of 48 | 11 of 11 |

- **Nothing the person said was lost**, with either compaction, in any run: Claude named every item and kept every rule
  in the code it wrote next. In the hard round Claude kept its own `NOTES.md` with the rules, unasked, in 10 of 15
  catnap runs and 1 of 5 auto-compact runs, and re-read it after compactions; the runs without one named every item
  too, from Claude Code's summary or from catnap's handoff and the messages it keeps ("I only have these as a summary,
  not your exact words", one catnap probe answer said of the early rules).
- **Where the cut landed:** all 27 auto-compactions came in the middle of a tool loop; none of catnap's 50 naps did.
- **What stood in place of the summary:** a median 8.6K (easy) and 10.0K (hard) tokens for Claude Code's summary;
  1.0K and 4.0K for catnap's handoff with the person's messages.
- **The one thing catnap did worse, fixed in 0.3.10:** since 0.3.8 Claude naps in the same response as its last action
  (say, the command that runs the tests), before it has seen the result, so it has not yet given the person its reply
  on that step. After the nap it gave a status line instead ("T01 to T24 are done…"), and twice said it had already
  sent the reply. The person missed the reply on 5 of 22 nap steps, against 0 of 14 with auto-compact. 0.3.10's
  continue message says so: once Claude has checked the result, it gives the reply it owed. With it, 11 of 11.
- **The 12,000 cap:** 0.3.9 lost nothing here although the early items had fallen past the person's messages it keeps;
  Claude's handoff and its notes carried them. 0.3.10 keeps 48,000 characters and asks the handoff for every
  instruction that still applies, in the person's words, as a margin for longer sessions; it measured the same.

## What this cannot tell

- Synthetic tasks, one model (Opus 5.5), a 200K window: real sessions run to 500K and more on a 1M window, with more to
  lose. 3 to 6 runs per arm.
- A few shell commands outside the benchmark's allowed list were refused in both arms; Claude worked around them.

The driver and scorer are not in this repository yet.
