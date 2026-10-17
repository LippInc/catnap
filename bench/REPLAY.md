# Replay: the "about 30% less context re-read" number

`bench/replay.py` is the script behind the README's long-session number. It takes sessions in which Claude called the mod's `compact_now` and asks how much context every API call would have re-read if Claude Code's own auto-compact had been the only compaction. It reads your local transcripts, writes nothing and prints numbers only.

```
python3 bench/replay.py                                   # sessions where compact_now ran, found automatically
python3 bench/replay.py --sessions 92caab09,9cd6d080      # chosen sessions (id prefixes)
python3 bench/replay.py --window 200000 --at 83.5,70      # another window or auto-compact point (% of the window)
```

`/check` (bench/check.mjs) answers a different question: it takes your history as it happened and asks what a clean-break compaction at 50% would have added. On sessions where the mod already compacted, its answer is small by design (see METHOD.md).

## Method

- Calls are assistant records with `message.usage`, deduplicated by `message.id` (Claude Code re-logs the same message several times; the earliest record is kept) and sorted by time. `<synthetic>` records, sidechains and `subagents/` files are left out.
- `context_t = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
- **A (what happened, with the mod)** = the sum of `context_t` over all calls, plus one extra read of the context for each actual compaction.
- **B (auto-compact only)**: the per-call growth `d_t = context_t - context_(t-1)` is replayed without the mod's compactions (the first call after a real compaction gets `d_t = 0`). When the replayed context passes the auto-compact point T, one compaction is simulated: the context drops to the session's median post-compaction size, and the compaction costs one extra read.
- The post-compaction size is the first call's full context after the compaction (system prompt, tools, summary and kept messages: 85K-124K in the sessions below), not the summary size the compaction record reports.
- Saving = 1 - A/B, per session and in total.

## The author's result (numbers only)

Nine long sessions over five days (2026-10-13 to 10-17), one machine, a 1M window, 13 compactions Claude chose.

Auto-compact at 967,000 tokens (Claude Code's default point on a 1M window):

| session | calls | the mod's compactions | A (M tokens) | B (M tokens) | simulated auto-compactions | saving |
|---|---|---|---|---|---|---|
| 0822c7b1 | 106 | 1 | 20.56 | 26.49 | 0 | 22.4% |
| 92caab09 | 406 | 2 | 126.77 | 236.60 | 1 | 46.4% |
| 90efd00c | 280 | 1 | 101.75 | 101.64 | 0 | -0.1% |
| 9cd6d080 | 918 | 3 | 305.18 | 487.78 | 1 | 37.4% |
| f8090ab4 | 368 | 1 | 122.97 | 154.93 | 0 | 20.6% |
| e0dd45f2 | 187 | 1 | 61.93 | 61.83 | 0 | -0.2% |
| 8e7d6c59 | 275 | 1 | 97.83 | 149.34 | 0 | 34.5% |
| 4f9d42a1 | 685 | 2 | 219.37 | 328.22 | 1 | 33.2% |
| 5217f015 | 324 | 1 | 91.10 | 165.44 | 0 | 44.9% |
| **total** | 3,549 | 13 | 1,147.45 | 1,712.27 | 3 | **33.0%** |

Auto-compact at 700,000 tokens (a 70% line): total **16.2%** (per session from -0.2% to 28.0%).

Ignoring the one-time compaction reads on both sides: 33.2% and 16.3%.

## Checks the script runs before printing anything

- A session with no compaction that stays below T gives exactly 0%; the same shape crossing T must not (negative control).
- A synthetic session (30K growing to 500K, compacted, growing to 500K again; T = 967K) must match a hand calculation, in thousands of tokens: A = 12,720 + 12,720 + 500 = 25,940; B = 12,720 + 34,310 + 40 + 970 = 48,040. A deliberately wrong hand value must be rejected.

## Why "about 30%" and not 33%

- One known bias pushes the number up: after a compaction Claude re-reads a few files, and the replay counts that as growth it would also have had without compacting.
- The replay assumes the session would have gone the same way without the mod (same calls, same growth). Real sessions would differ.
- The spread is wide: two sessions ended right after their only compaction, so the compaction was pure cost there (-0.1%, -0.2%); the seven that kept going after compacting saved 21-46%. The total depends on how long sessions run after a compaction.
- Tokens are counted equally. These are tokens re-read, not plan usage: cache reads weigh less there.
- One user, nine sessions, one machine. A data point, not a benchmark. Over the author's whole month, short sessions included, `/check` estimates 17.5% (METHOD.md).
