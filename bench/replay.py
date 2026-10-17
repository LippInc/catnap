#!/usr/bin/env python3
"""Replay: how much less context did Claude re-read in sessions where the mod compacted?

This is the script behind the README's "about 30% less context re-read" (33.0% measured on the author's
nine long sessions; see REPLAY.md). It takes sessions where Claude called the mod's compact_now tool and
asks: if Claude Code's auto-compact had been the only compaction, how much context would every call
have re-read?

Run:
  python3 bench/replay.py                         # sessions found automatically (see below)
  python3 bench/replay.py --sessions 92caab09,9cd6d080   # these sessions (id prefixes)
  python3 bench/replay.py --window 200000 --at 83.5,70   # other window / auto-compact points (% of window)

Reads (read-only): ~/.claude/projects/*/<session-id>.jsonl (CLAUDE_CONFIG_DIR is honoured).
Writes nothing. Prints numbers and 8-character session id prefixes only, never transcript text.
Automatic selection: every main-session transcript that contains a call to a tool named *__compact_now
and at least one compaction.

Model
-----
context_t = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
A  = sum(context_t) + sum(actual compaction costs)           (what happened, with the mod)
B  = sum(c_t) + sum(simulated compaction costs)              (replay with auto-compact at T)
saving = 1 - A/B
Actual compaction cost = context of the last call before the boundary (one extra read).
Simulated compaction cost = the counterfactual context at the moment it passes T (one extra read).
Calls are deduplicated by message.id (Claude Code re-logs the same message several times).
"""
import argparse
import glob
import json
import os
import statistics
import sys

CONFIG = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
PROJECTS = os.path.join(CONFIG, "projects")


# ---------------------------------------------------------------- core maths
def replay(contexts, post_idx, T):
    """contexts: ordered list of context_t.  post_idx: indices (into contexts) of the first
    call after each actual compaction boundary.  Returns dict with A, B and counts."""
    post_idx = sorted(set(post_idx))
    posts = [contexts[i] for i in post_idx]
    actual_cost = sum(contexts[i - 1] for i in post_idx if i > 0)
    A = sum(contexts) + actual_cost
    med = statistics.median(posts) if posts else None
    c = contexts[0]
    total = c
    sim_n = 0
    sim_cost = 0
    pset = set(post_idx)
    for t in range(1, len(contexts)):
        d = 0 if t in pset else contexts[t] - contexts[t - 1]
        c = c + d
        if c > T:
            sim_cost += c
            sim_n += 1
            # with no actual compaction there is no observed post size to take a median of;
            # fall back to the smallest context seen in the session
            base = med if med is not None else min(contexts)
            c = base + d
        total += c
    B = total + sim_cost
    return {"A": A, "B": B, "sim_n": sim_n, "actual_n": len(post_idx),
            "actual_cost": actual_cost, "sim_cost": sim_cost,
            "saving": 1 - A / B,
            "A_nocost": A - actual_cost, "B_nocost": B - sim_cost}


# ---------------------------------------------------------------- transcripts
def main_transcripts():
    return [f for f in glob.glob(os.path.join(PROJECTS, "*", "*.jsonl"))
            if os.sep + "subagents" + os.sep not in f]


def find_sessions():
    """Session files that call a *__compact_now tool and contain a compaction."""
    found = []
    for f in main_transcripts():
        tool = boundary = False
        try:
            for line in open(f, encoding="utf-8", errors="replace"):
                if not tool and '__compact_now"' in line and '"tool_use"' in line:
                    tool = True
                if not boundary and '"compact_boundary"' in line:
                    boundary = True
                if tool and boundary:
                    found.append(f)
                    break
        except OSError:
            continue
    return found


def load_session(path):
    calls = {}      # message.id -> (timestamp, file_index, context)
    bounds = {}     # (timestamp, preTokens) -> postTokens
    st = {"lines": 0, "raw_assistant": 0, "synthetic": 0, "sidechain": 0,
          "raw_boundary": 0, "bad_json": 0}
    for i, line in enumerate(open(path, encoding="utf-8", errors="replace")):
        try:
            r = json.loads(line)
        except Exception:
            st["bad_json"] += 1
            continue
        st["lines"] += 1
        if r.get("isSidechain"):
            st["sidechain"] += 1
            continue
        if r.get("subtype") == "compact_boundary":
            st["raw_boundary"] += 1
            cm = r.get("compactMetadata") or {}
            bounds[(r["timestamp"], cm.get("preTokens"))] = cm.get("postTokens")
            continue
        m = r.get("message")
        if r.get("type") == "assistant" and isinstance(m, dict) and isinstance(m.get("usage"), dict):
            st["raw_assistant"] += 1
            if m.get("model") == "<synthetic>":
                st["synthetic"] += 1
                continue
            u = m["usage"]
            ctx = (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) \
                + (u.get("cache_creation_input_tokens") or 0)
            key = m.get("id")
            if not key:
                continue
            cand = (r["timestamp"], i, ctx)
            if key not in calls or cand < calls[key]:   # keep the earliest record per id
                calls[key] = cand
    seq = sorted(calls.values())
    st["unique_calls"] = len(seq)
    st["unique_boundary"] = len(bounds)
    return {"ts": [s[0] for s in seq], "ctx": [s[2] for s in seq],
            "bounds": sorted(bounds), "stats": st}


def session_result(sess, T):
    ts, ctx = sess["ts"], sess["ctx"]
    post_idx = []
    for bts, _pre in sess["bounds"]:
        j = next((k for k, t in enumerate(ts) if t > bts), None)
        if j is not None:
            post_idx.append(j)
    return replay(ctx, post_idx, T), post_idx


# ---------------------------------------------------------------- instrument checks
def checks():
    res = []
    T = 967_000
    # (a) no compaction, stays below T -> exactly 0
    ctxs = [30_000 + 1_000 * k for k in range(200)]
    r = replay(ctxs, [], T)
    res.append(("(a) no compactions, below T gives exactly 0%",
                r["saving"] == 0.0 and r["A"] == r["B"] == sum(ctxs)))
    # negative control for (a): same shape but crossing T must NOT give 0
    rb = replay([30_000 + 10_000 * k for k in range(120)], [], T)
    res.append(("(a-neg) a session that crosses T without the mod must not give 0%",
                rb["saving"] != 0.0 and rb["sim_n"] >= 1))
    # (b) 30K -> 500K linear, compact to 30K, grow to 500K again; hand calculation in REPLAY.md
    leg = [30_000 + 10_000 * k for k in range(48)]
    r = replay(leg + leg, [48], T)
    hand_A, hand_B = 25_940_000, 48_040_000
    res.append(("(b) synthetic 30K-500K-compact-500K matches the hand calculation",
                r["A"] == hand_A and r["B"] == hand_B and r["sim_n"] == 1))
    res.append(("(b-neg) the comparison rejects a wrong hand value", r["B"] != hand_B + 1000))
    return res


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--sessions", help="comma-separated session id prefixes (default: found automatically)")
    ap.add_argument("--window", type=int, default=1_000_000, help="context window in tokens (default 1000000)")
    ap.add_argument("--at", default="96.7,70",
                    help="auto-compact points as %% of the window (default 96.7,70: Claude Code's default "
                         "point on a 1M window, and a 70%% override)")
    a = ap.parse_args()
    thresholds = [int(a.window * float(p) / 100) for p in a.at.split(",")]

    chk = checks()
    for name, ok in chk:
        print("%s  %s" % ("PASS" if ok else "FAIL", name))
    if not all(ok for _, ok in chk):
        print("INSTRUMENT CHECK FAILED - no results")
        sys.exit(1)

    if a.sessions:
        files = []
        for p in a.sessions.split(","):
            m = [f for f in main_transcripts() if os.path.basename(f).startswith(p.strip())]
            if len(m) != 1:
                print("session %s: found %d transcript files, skipped" % (p, len(m)))
            else:
                files.extend(m)
    else:
        files = find_sessions()
    if not files:
        print("No sessions found (none called a compact_now tool and compacted).")
        return

    per = [(os.path.basename(f)[:8], load_session(f)) for f in files]
    per = [(s, x) for s, x in per if x["ctx"]]
    print("\n%d sessions, %s unique calls (%s assistant records before deduplication)" % (
        len(per), "{:,}".format(sum(len(x["ctx"]) for _, x in per)),
        "{:,}".format(sum(x["stats"]["raw_assistant"] - x["stats"]["synthetic"] for _, x in per))))
    for T in thresholds:
        print("\nAuto-compact at %s tokens (%.1f%% of %s)" % ("{:,}".format(T), 100 * T / a.window,
                                                             "{:,}".format(a.window)))
        print("%-9s %7s %8s %12s %12s %6s %8s" % ("session", "calls", "actual", "A (M tok)", "B (M tok)", "sim", "saving"))
        sA = sB = sA0 = sB0 = 0
        for s, sess in per:
            r, _ = session_result(sess, T)
            sA += r["A"]; sB += r["B"]; sA0 += r["A_nocost"]; sB0 += r["B_nocost"]
            print("%-9s %7d %8d %12.2f %12.2f %6d %7.1f%%" % (
                s, len(sess["ctx"]), r["actual_n"], r["A"] / 1e6, r["B"] / 1e6, r["sim_n"], 100 * r["saving"]))
        print("%-9s %7s %8s %12.2f %12.2f %6s %7.1f%%" % ("total", "", "", sA / 1e6, sB / 1e6, "", 100 * (1 - sA / sB)))
        print("ignoring the one-time compaction reads on both sides: %.1f%%" % (100 * (1 - sA0 / sB0)))
    print("\nTokens re-read, counted equally (cache reads included); not plan usage. "
          "The replay assumes the session would have gone the same way without the mod. See bench/REPLAY.md.")


if __name__ == "__main__":
    main()
