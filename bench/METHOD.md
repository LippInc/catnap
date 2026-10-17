# How `bench/check.mjs` estimates your number

`node bench/check.mjs [--days 30] [--json] [--soft 50] [--auto 70] [--replace-manual]`

Node 18+, no dependencies, no network, read-only. It reads your local Claude Code transcripts (`$CLAUDE_CONFIG_DIR/projects/*/*.jsonl`, default `~/.claude/projects`), prints numbers only (never transcript text, project names or paths), and gives an **estimate**, not a measurement.

## What it asks

If Claude had compacted its own conversation at a clean break (the end of a turn) once the context passed 50% of the window, instead of whatever actually happened, how many fewer tokens would have been re-read? Every API call re-reads the whole context, so a smaller context on each call is the saving.

## Steps

1. **Find sessions.** Top-level `*.jsonl` files modified in the last N days. `subagents/` folders are never visited and records with `isSidechain: true` are skipped.
2. **Calls.** Assistant records with `message.usage`, `<synthetic>` dropped. Claude Code re-logs the same message (once per content block, and again after compactions), so records are deduplicated by `message.id`, keeping the earliest, then sorted by timestamp. `context = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. `stop_reason` was checked on real files: present on every call except a handful, and identical across the copies of one message. `compact_boundary` records (trigger, preTokens, timestamp) are deduplicated by (timestamp, preTokens).
3. **Window.** 1,000,000 if any model id ends in `[1m]` or any call's context exceeds 200,000, otherwise 200,000. (Transcripts on the author's machine never carry `[1m]`, so in practice the second rule decides.)
4. **Mid-task.** An auto boundary is mid-task if the last call before it had `stop_reason` `tool_use` (Claude was inside a tool loop). `end_turn` means it was at a clean break. Anything else counts as "unknown" and is printed.
5. **Actual total A** = sum of context over all calls + one extra read of the pre-boundary context for each actual compaction (the compaction itself reads it).
6. **Estimated total E** (the counterfactual): replay the session's own growth. `d_t = context_t - context_(t-1)`; `c_t = c_(t-1) + d_t`; across an actual auto boundary `d = 0` for the first call after it. Once `c_t` is above soft% of the window (default 50), compact at the first call with `stop_reason` `end_turn`. If `c_t` goes above the auto line (default 70% of the window, set with `--auto`) before any end_turn, compact there instead (a backstop, counted as mid-task). A simulated compaction costs one extra read of `c_t`, and the next call starts from the reset size plus its own growth. Reset size = the median first-call context after a boundary across all your scanned sessions (100,000 if you have none), capped at half the soft line so a small window cannot loop.
7. **Saving** = 1 - E/A, summed over all sessions (and again over sessions that crossed 50% of their window). Positive = less re-read.

## Hand-calculated test case (what `test/check.test.mjs` asserts)

Fixture `b-linear`: 13 calls, context 50K, 100K, ..., 650K (so the window is 1M, soft line 500K, auto line 700K). `end_turn` on calls 5 (250K), 11 (550K) and 13; the rest `tool_use`. No boundaries, so the reset is the 100K fallback.

- A = 50 x (1+2+...+13) = 50 x 91 = **4,550K**.
- E: calls 1-11 are unchanged (50 ... 550) = 50 x 66 = 3,300K. Call 11 is the first end_turn above 500K (call 10 is exactly 500K, not above; call 5 is below the line), so compact: read cost 550K, reset to 100K. Call 12 = 100 + 50 = 150K, call 13 = 200K (end_turn, below the line). E = 3,300 + 550 + 150 + 200 = **4,200K**.
- Saving = 1 - 4,200/4,550 = 1/13 = 7.69%.

Other fixtures: `a-short` (20K..65K, never near 50%: E = A = 425K exactly, saving 0, plus a huge sidechain record that must be ignored), `c1-mid-task` / `c2-clean` (auto boundary after a tool_use / end_turn call; A = 920K, E = 830K: calls 90,110,130,150 then backstop at 150 [read 150], 60, boundary call 60, 80), `d-dups` (fixture b with every record logged three times; must give the same numbers).

Run the tests with `node --test bench/test/check.test.mjs`. Planted failures: `node bench/test/mutate.mjs` copies the script to a temp folder, plants one bug at a time (drop the dedup, shift the soft line by 10 points, flip the mid-task test, stop skipping sidechains, stop deduplicating boundaries, forget the compaction read) and requires the tests to fail for each. All six are caught. `node bench/test/make-fixtures.mjs` regenerates the fixtures.

## Assumptions and known biases

Biases that make the estimate **too high**:
- The replay assumes the conversation would have gone the same way with a smaller context. Real work after a compaction can need re-reading files, which the replay does not charge for beyond the reset size (the median of your own post-compaction contexts is the only allowance).
- Auto-compaction in Claude Code fires late (well above 70%). The default `--auto 70` backstop is the mod's own setting; with `--auto 95` the saving shrinks (see below).
- Tokens are counted equally; cache reads are far cheaper than uncached input on most plans, so the saving in money or plan usage is smaller than the saving in tokens re-read.

Biases that make it **too low**:
- Compacting at the final clean break of a session that is about to end costs a read for nothing; a real user would not do it, the replay does.
- A session whose real window is 1M but never passed 200K is read as a 200K window, so its soft line is lower and more simulated compactions occur (the effect on the saving is mixed).
- Prompt-cache expiry during idle gaps is not modelled; a smaller context also means cheaper cache rebuilds.
- Manual compactions (yours, or the mod's) are kept as they happened by default, so the number only counts what a clean-break compaction would add on top. `--replace-manual` treats them like auto boundaries (growth continues across them) and lets the simulated policy decide instead.

Not modelled: model switches inside a session, `/clear`, resumes, subagent contexts (excluded on purpose), and the cost of the extra turn the mod spends writing its handoff.

"Mid-task" is not a surprise to be alarmed by: about 92% of all calls on the author's machine end with `tool_use`, so an event that ignores turn boundaries will land mid-task about that often. The point is that auto-compact does not wait for a clean break and the mod does.

## Reproduce

```
node bench/check.mjs --days 30            # the printed summary
node bench/check.mjs --days 30 --json     # same numbers as JSON
node bench/check.mjs --soft 40 --auto 95  # try other settings
```
Transcripts that are still being written change the totals slightly between runs.

## Author's own result (numbers only)

One machine, last 30 days, run 2026-10-17, 16-19 seconds, peak about 300 MB:

| | |
|---|---|
| Sessions scanned / long (past 50% of window) | 539 / 259 |
| Auto-compactions / mid-task | 82 / 78 (95.1%) |
| Manual compactions (includes the mod's own) | 102 |
| Context re-read, actual | 28,809M tokens |
| Context re-read, clean-break at 50% | 23,768M tokens (297 clean + 92 backstop compactions) |
| Estimated saving | 17.5% overall, 19.7% on long sessions |

Sensitivity (same data): `--replace-manual` 15.3% overall / 17.5% long; `--auto 95` 10.2% / 11.5%; `--soft 40` 23.2% / 25.6%.

### Sanity check against `replay.py` (REPLAY.md)

- Parity of the reading and dedup code: on the nine sessions in that file, this script gets 3,549 unique calls and A = 1,147.45M tokens, exactly the figure `replay.py` reports. (DERIVED from running both.)
- The two numbers are not the same quantity, so they should not match. `replay.py` takes the sessions where the mod ran and asks what would have happened with auto-compact only: 33.0% (auto at 967K) or 16.2% (auto at 700K, i.e. 70% of 1M). This script takes your history as it happened and asks what a clean-break compaction at 50% would add. On those same nine sessions the mod had already compacted at clean breaks, so the answer is small: 3.1% (1.4% with `--replace-manual`). That is the expected direction, not a failure.
- On the rest of the history (mostly sessions without the mod, many on 200K windows with late auto-compaction) the saving is around 18% (DERIVED: whole-history figures minus the nine sessions), the same size as the 16.2% of the 700K case in `replay.py`. The much larger 33% there came from comparing against an auto-compact at 967K; this script's default backstop is 70%, so it cannot reach that.
