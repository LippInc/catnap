# Paired benchmark: total tokens to the end of a task

What a setting costs to finish a whole task, every call counted: the main model's calls, the compaction calls and the
small side calls, from Claude Code's own running count (stream-json `modelUsage`, all token types: input, output,
cache reads, cache writes), summed over the run's sessions.

## Setup

- Opus 5.5 at effort medium, a fresh Claude Code profile per run, the work folder outside any home folder (so no
  CLAUDE.md, rules or skills of a user's own), stream-json with the desktop app's entry point (catnap acts as it does in
  a desktop chat). Hidden tests decide when the task is done; a turn that ends with the task undone gets one fixed
  nudge. Every run below finished its task.
- Tasks: synthetic coding backlogs, each ticket a small module with its own test. 40 tickets for the 200K window; 250
  for the 1M window, with one line asking Claude to write each module itself (in 2 of the first 6 runs without it,
  Claude wrote a generator script and finished in under 30 calls, which leaves no long session to measure).
- Settings: catnap at its defaults (notes at 50% and 60%, Claude Code's auto-compact moved to 70% as the backstop);
  Claude Code's auto-compact at a set point (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`); Claude Code's default point.

**The two "50%" are not the same point.** Claude Code's percentage is of the window minus about 20K of output reserve:
at 50 it compacts near 90K on a 200K window and near 490K on a 1M window. catnap's 50% is of the whole window, and
Claude then finishes its piece first: its naps came at 102-109K on 200K. So on 200K the setting that cuts where catnap
cuts is auto-compact at 55%. Comparing catnap with auto-compact at 50% there mixes where the cut lands with how it is
made.

## 200K window (catnap 0.3.6, 2026-10-18)

| setting | runs | median total | range | median at API prices |
| :- | -: | -: | :- | -: |
| auto-compact 50% (cuts at 89-99K) | 13 | 3.29M | 2.22M to 6.27M | $3.59 |
| auto-compact 55% (cuts near 100K) | 4 | 3.61M | 2.82M to 3.86M | $3.65 |
| catnap 0.3.6 (naps at 102-109K) | 9 | 3.83M | 2.68M to 4.84M | $3.40 |
| catnap 0.3.6 + fresh start | 8 | 3.33M | 2.71M to 4.22M | $3.21 |
| Claude Code's default point | 4 | 4.62M | 4.52M to 5.45M | $3.46 |

catnap against the default: 17% less. Against auto-compact at the same point (55%): 6% more, which is within noise
here (the same task took 31 to 89 calls from run to run). Against auto-compact at 50%: 16.5% more, mostly because that
setting cuts about 10K earlier. With the fresh start: 8% under auto-compact at 55% and 1% over auto-compact at 50%, both within noise.
In dollars every setting on this window is within noise of the others ($3.21 to $3.65 at the median). Most of a run's
tokens are cache reads, the cheapest kind; writing new context into the cache costs about 40 times as much per token,
and Claude's output about 100 times (Opus 5.5 list prices: $0.20, $8 and $20 per million). Dollars are the runs' own
cost figures, summed over sessions to the result that finished the task.

## 200K window, catnap 0.3.8 (2026-10-19): the nap rides along

Up to 0.3.7 Claude called `compact_now` in a model call of its own, which re-reads the whole context for that one call.
0.3.8 asks for it in the same response as Claude's last action (in these runs, the command that ran a ticket's test).
Same two tasks as the 0.3.6 runs above, 3 runs each:

| setting | runs | median total | range | median at API prices | naps | naps with a call of their own | re-read by those calls |
| :- | -: | -: | :- | -: | -: | -: | -: |
| catnap 0.3.6 (backlog40, followups) | 6 | 3.88M | 3.31M to 4.33M | $3.41 | 12 | 12 | 1.27M |
| catnap 0.3.8 | 6 | 3.75M | 3.27M to 4.44M | $3.25 | 11 | 1 | 0.10M |

The one nap with a call of its own came when the note arrived on the result of the piece's last action, so nothing was
left to ride along with. Claude has not seen that action's result when it naps: every handoff written this way began
with checking it, and after the nap Claude re-ran that check in the same call as starting the next ticket. The calls
that went away are the direct measure: about 5% of a run's tokens here, and 1-2% of its dollars, since they were
almost all cache reads. The difference in the totals is within noise. On 1M the 0.3.7 naps' own calls re-read 498K to
512K each, about 2% of a run's tokens.

## 200K window, catnap 0.3.9 (2026-10-19): the handoff in place of the summary

Up to 0.3.8 every nap ended in Claude Code's compaction: a model call that reads the whole conversation and writes a
summary. 0.3.9 answers its own compaction with Claude's handoff (with the person's prompts and the skills used), so
that call is gone. Same two tasks, 3 runs each, against the 0.3.8 runs above:

| setting | runs | median total | range | median at API prices | range | naps | the compaction, per nap | median time to done |
| :- | -: | -: | :- | -: | :- | -: | :- | -: |
| catnap 0.3.8 (Claude Code's summary) | 6 | 3.75M | 3.27M to 4.44M | $3.25 | $2.80 to $3.89 | 11 | median 19.7 s, $0.090 | 464 s |
| catnap 0.3.9 (the handoff in its place) | 6 | 3.72M | 2.11M to 4.27M | $3.17 | $2.14 to $3.39 | 10 | 16 to 27 ms, $0 | 406 s |

The per-nap figures are the direct measure: the compaction's own time (Claude Code's `compact_boundary` record) and
the cost of its call. Over a run the naps' saving comes to about 5% of the dollars here, inside the run-to-run spread,
so the totals show no difference. On 1M the summary call took a median 20 s and $0.16 a nap (0.3.6 and 0.3.7 runs,
naps near 500K). Claude Code's own compaction also attaches the files read last and the lists of deferred tools,
agents and MCP instructions again; with the handoff in its place the lists came back one model response later in all
10 naps, and Claude re-read 6 files after naps over the 6 runs (5 with 0.3.8). After every nap Claude first checked
its last action, then went on to the next ticket.

## 1M window (catnap 0.3.6 and 0.3.7, 2026-10-19), 250 tickets

| setting | runs | median total | range | median at API prices |
| :- | -: | -: | :- | -: |
| auto-compact 50% (cuts at 485-490K) | 3 | 45.6M | 23.9M to 66.5M | $26.05 |
| catnap 0.3.6 | 3 | 45.1M | 24.6M to 59.9M | $22.77 |
| catnap 0.3.6 + fresh start | 3 | 51.7M | 32.5M to 56.4M | $24.22 |
| catnap 0.3.7 (naps at 501-514K) | 3 | 51.2M | 46.8M to 66.6M | $23.83 |
| Claude Code's default point (cuts near 965K) | 3 | 115.4M | 83.2M to 125.7M | $37.81 |

catnap against the default: 61% fewer tokens (0.3.6) and 56% fewer (0.3.7), 40% and 37% fewer dollars; auto-compact at
50% gets 60% fewer tokens: on a 1M window the saving is where the cut lands. catnap (either version) against auto-compact at 50%: within noise (three identical auto-compact runs ranged from 23.9M to 66.5M,
because the same 250 tickets took them 92 to 274 calls, depending on how Claude batched the work).

Per cut, at matched points (cuts at 440-530K, counting the 100 calls after each): an auto-compaction cost 1.96M tokens
and a catnap nap 1.92M. catnap's extra call (Claude writing its handoff) is offset by what comes back after the
compaction: about 10K re-sent per later call against 15K. A fresh start cost 0.51M per nap: the handoff call, and
nothing put back after the clear. That is about 3% of a run like these per nap, so it does not show in 3 runs. With
0.3.8's ride-along the handoff call goes away for most naps, which would bring a nap to about 1.45M (derived from these
cuts, not measured on 1M).

In 0.3.6 Claude also napped on its own before the 50% note in 2 of these 3 catnap runs (at 28-47%), and in a third run
on an earlier version of the task every ~20 tickets from 12%. 0.3.7 holds `compact_now` to the line unless the person
asks: in its 3 runs all 6 naps came at the note, and Claude never tried an earlier one.

## Every nap was checked

Per nap: exactly one catnap reply to `compact_now` and the turn ended before the compaction; the continue message
carried the handoff; Claude's first step after it was the next step the handoff named. 200K: 17 of 17 naps in 9 runs.
1M: 16 of 16 naps in 4 runs of 0.3.6, 6 of 6 in 3 runs of 0.3.7. 0.3.8 on 200K: 11 of 11 naps in 6 runs. 0.3.9 on 200K: 10 of 10 naps in 6 runs, with the handoff in place of the summary instead of in the continue message. With the fresh start: 16 of 16 clears in 8 runs on 200K, 12 of 12 in 4 runs on 1M. Each check was first shown to fail on a planted bad case.

## What this cannot tell

- Real work: these are synthetic tasks where every ticket ends at an obvious clean break.
- Quality: every run finished; rework would show as extra calls, and calls varied 3x by working style.
- Small differences: 3 to 13 runs per setting; differences under about 10% (200K) or 30% (1M) are noise here.

The runner and analysis scripts are not in this repository yet.
