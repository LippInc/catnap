#!/usr/bin/env node
// catnap: check your own history.
// Read-only, zero dependencies, no network. Prints numbers only, never transcript text.
//
//   node bench/check.mjs [--days 30] [--json] [--soft 50] [--auto 70] [--replace-manual]
//   npx github:LippInc/catnap [same options]   (no install; package.json maps the bin here)
//
// Method: see bench/METHOD.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const FALLBACK_RESET = 100_000;

// ---------------------------------------------------------------- reading
export function findTranscripts(configDir, days) {
  const root = path.join(configDir, 'projects');
  const cutoff = Date.now() - days * 86_400_000;
  const out = [];
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of projects) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      // only <project>/<session>.jsonl; <project>/<session>/subagents/* is never visited
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const fp = path.join(dir, e.name);
      try { if (fs.statSync(fp).mtimeMs >= cutoff) out.push(fp); } catch { /* ignore */ }
    }
  }
  return out;
}

// Returns { calls:[{ts,ctx,stop}], bounds:[{ts,trigger,pre}], oneM, rawCalls } for one file.
export async function loadSession(file) {
  const byId = new Map(); // message.id -> {ts, line, ctx, stop}
  const bounds = new Map(); // `${ts}|${pre}` -> {ts, trigger, pre}
  let oneM = false;
  let rawCalls = 0;
  let lineNo = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    lineNo++;
    const isBoundary = line.includes('compact_boundary');
    if (!isBoundary && !line.includes('"usage"')) continue; // cheap prefilter
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || r.isSidechain) continue;
    if (r.subtype === 'compact_boundary') {
      const cm = r.compactMetadata || {};
      const key = `${r.timestamp}|${cm.preTokens}`;
      if (!bounds.has(key)) bounds.set(key, { ts: r.timestamp, trigger: cm.trigger, pre: cm.preTokens });
      continue;
    }
    const m = r.message;
    if (r.type !== 'assistant' || !m || typeof m !== 'object' || !m.usage || typeof m.usage !== 'object') continue;
    if (m.model === '<synthetic>') continue;
    rawCalls++;
    if (typeof m.model === 'string' && m.model.endsWith('[1m]')) oneM = true;
    const u = m.usage;
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const key = m.id ?? `noid-${lineNo}`;
    const cand = { ts: r.timestamp, line: lineNo, ctx, stop: m.stop_reason ?? null };
    const prev = byId.get(key);
    if (!prev) { byId.set(key, cand); continue; }
    // keep the earliest copy; a later copy may carry the final stop_reason
    const earlier = (cand.ts < prev.ts || (cand.ts === prev.ts && cand.line < prev.line)) ? cand : prev;
    const other = earlier === cand ? prev : cand;
    byId.set(key, { ...earlier, stop: earlier.stop ?? other.stop });
  }
  const calls = [...byId.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.line - b.line));
  return { calls, bounds: [...bounds.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)), oneM, rawCalls };
}

// ---------------------------------------------------------------- model
export function windowOf(session) {
  if (session.oneM) return 1_000_000;
  return session.calls.some((c) => c.ctx > 200_000) ? 1_000_000 : 200_000;
}

// index of the first call after a boundary (calls.length if none)
function postIndex(calls, bts) {
  for (let k = 0; k < calls.length; k++) if (calls[k].ts > bts) return k;
  return calls.length;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// Actual figures for one session.
export function analyse(session, opts = {}) {
  const calls = session.calls;
  const n = calls.length;
  const W = windowOf(session);
  const res = {
    window: W, n, long: false, A: 0,
    auto: 0, manual: 0, midTask: 0, notMid: 0, unknownMid: 0,
    postIdx: new Map(), // index -> 'auto' | 'manual'
    postCtx: [],
  };
  if (!n) return res;
  let sum = 0, maxCtx = 0;
  for (const c of calls) { sum += c.ctx; if (c.ctx > maxCtx) maxCtx = c.ctx; }
  res.long = maxCtx > 0.5 * W;
  let cost = 0;
  const costed = new Set();
  for (const b of session.bounds) {
    const j = postIndex(calls, b.ts);
    const kind = b.trigger === 'auto' ? 'auto' : 'manual';
    if (kind === 'auto') {
      res.auto++;
      if (j >= 1) {
        const s = calls[j - 1].stop;
        if (s === 'tool_use') res.midTask++;
        else if (s === 'end_turn') res.notMid++;
        else res.unknownMid++;
      } else res.unknownMid++;
    } else res.manual++;
    if (j < n) {
      res.postCtx.push(calls[j].ctx);
      if (res.postIdx.get(j) !== 'auto') res.postIdx.set(j, kind);
    }
    if (j >= 1 && !costed.has(j)) { costed.add(j); cost += calls[j - 1].ctx; }
  }
  res.A = sum + cost;
  res.sumCtx = sum;
  return res;
}

// Counterfactual replay for one session. reset = context a compaction resets to.
export function replay(session, act, o) {
  const calls = session.calls;
  const n = calls.length;
  const W = act.window;
  const soft = (o.soft / 100) * W;
  const auto = (o.auto / 100) * W;
  const out = { E: 0, clean: 0, backstop: 0 };
  if (!n) return out;
  // reset value: user's own median, but never at/above the soft line (would loop)
  const reset = Math.min(o.reset, 0.5 * soft);
  let c = calls[0].ctx;
  let total = 0;
  let extra = 0;
  for (let t = 0; t < n; t++) {
    if (t > 0) {
      const kind = act.postIdx.get(t);
      if (kind === 'manual' && !o.replaceManual) {
        // the user's own manual compaction stays in the replay (conservative): reset to what happened
        c = calls[t].ctx;
        extra += calls[t - 1].ctx;
      } else if (kind) {
        // auto boundary (or manual with --replace-manual): the conversation keeps its own growth
        // across it, so the first call after it adds nothing
        c += 0;
      } else {
        c += calls[t].ctx - calls[t - 1].ctx;
      }
    }
    total += c;
    if (c > soft && calls[t].stop === 'end_turn') {
      extra += c; out.clean++; c = reset;
    } else if (c > auto) {
      extra += c; out.backstop++; c = reset;
    }
  }
  out.E = total + extra;
  return out;
}

export function summarise(sessions, o) {
  const acts = sessions.map((s) => analyse(s));
  const posts = acts.flatMap((a) => a.postCtx);
  const med = median(posts);
  const reset = med ?? FALLBACK_RESET;
  const t = {
    sessions: sessions.length, withCalls: 0, long: 0, calls: 0,
    auto: 0, manual: 0, midTask: 0, notMid: 0, unknownMid: 0,
    A: 0, E: 0, cleanSim: 0, backstopSim: 0,
    longA: 0, longE: 0, reset, resetFromData: med != null,
  };
  sessions.forEach((s, i) => {
    const a = acts[i];
    if (!a.n) return;
    const r = replay(s, a, { ...o, reset });
    t.withCalls++; t.calls += a.n;
    t.auto += a.auto; t.manual += a.manual;
    t.midTask += a.midTask; t.notMid += a.notMid; t.unknownMid += a.unknownMid;
    t.A += a.A; t.E += r.E;
    t.cleanSim += r.clean; t.backstopSim += r.backstop;
    if (a.long) { t.long++; t.longA += a.A; t.longE += r.E; }
  });
  t.saving = t.A > 0 ? 1 - t.E / t.A : 0;
  t.longSaving = t.longA > 0 ? 1 - t.longE / t.longA : 0;
  return t;
}

// ---------------------------------------------------------------- output
const M = (x) => (x / 1e6).toFixed(1) + 'M';
const P = (x) => (100 * x).toFixed(1) + '%';

// Three lines sized for a screenshot: the measured count first, the estimate second and labelled as one.
export function card(t, o) {
  const head = !t.withCalls ? `No Claude Code sessions in the last ${o.days} days.`
    : !t.auto ? `No auto-compactions in the last ${o.days} days.`
    : `${t.midTask} of ${t.auto} auto-compaction${t.auto === 1 ? "" : "s"} cut Claude off mid-task.`;
  const est = t.withCalls && t.saving > 0.0005
    ? `A clean break at ${o.soft}% would re-read about ${Math.round(100 * t.saving)}% less context (estimate).`
    : `Compacting at a clean break would not have re-read less here.`;
  return [
    ` /\\_/\\  zZ   ${head}`,
    `( -.- )      ${est}`,
    ` > ^ <       catnap check, your last ${o.days} days · github.com/LippInc/catnap`,
  ].join('\n');
}

export function render(t, o) {
  const mid = t.auto ? `${t.midTask} of ${t.auto} (${P(t.midTask / t.auto)}) cut in mid-task` : 'none';
  const unk = t.unknownMid ? `, ${t.unknownMid} unknown` : '';
  return [
    card(t, o),
    '',
    `Details:`,
    `Sessions scanned:        ${t.withCalls}   (long, past ${o.soft}% of window: ${t.long})`,
    `Auto-compactions:        ${t.auto}   (mid-task: ${mid}${unk})`,
    `Manual compactions:      ${t.manual}`,
    `Context re-read, actual:                 ${M(t.A)} tokens`,
    `Context re-read, clean-break at ${o.soft}%:    ${M(t.E)} tokens  (${t.cleanSim} clean + ${t.backstopSim} backstop compactions)`,
    `Estimated saving:        ${P(t.saving)} overall${t.long ? `, ${P(t.longSaving)} on the long sessions only` : ''}`,
    `Method: re-read = sum of per-call context; window 1M if model id ends [1m] or any call >200K, else 200K;`,
    `  mid-task = last call before the auto-compact had stop_reason tool_use; counterfactual replays your own`,
    `  per-call growth, compacts at the first end_turn past ${o.soft}% (backstop at ${o.auto}%), reset to ${(t.reset / 1000).toFixed(0)}K${t.resetFromData ? ' (your median)' : ' (default)'}.`,
    `Estimate of tokens re-read, not of plan usage (cache reads weigh less there). It covers all your sessions,`,
    `  short ones included, so it is usually lower than the README's replay of long sessions. See bench/METHOD.md`,
  ].join('\n');
}

// ---------------------------------------------------------------- cli
function parseArgs(argv) {
  const o = { days: 30, json: false, soft: 50, auto: 70, replaceManual: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) { console.error(`bad value for ${a}`); process.exit(2); }
      return v;
    };
    if (a === '--days') o.days = num();
    else if (a === '--soft') o.soft = num();
    else if (a === '--auto') o.auto = num();
    else if (a === '--json') o.json = true;
    else if (a === '--replace-manual') o.replaceManual = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node bench/check.mjs [--days 30] [--json] [--soft 50] [--auto 70] [--replace-manual]');
      process.exit(0);
    } else { console.error(`unknown argument ${a}`); process.exit(2); }
  }
  return o;
}

export async function run(o, configDir) {
  const files = findTranscripts(configDir, o.days);
  const sessions = [];
  for (const f of files) {
    try { sessions.push(await loadSession(f)); } catch { /* unreadable file: skip */ }
  }
  return summarise(sessions, o);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const t = await run(o, configDir);
  if (o.json) {
    console.log(JSON.stringify({
      days: o.days, softPct: o.soft, autoPct: o.auto,
      sessions: t.withCalls, longSessions: t.long, calls: t.calls,
      autoCompactions: t.auto, midTask: t.midTask, notMidTask: t.notMid, unknownMidTask: t.unknownMid,
      manualCompactions: t.manual,
      tokensActual: t.A, tokensEstimated: t.E,
      simulatedClean: t.cleanSim, simulatedBackstop: t.backstopSim,
      resetTokens: t.reset, resetFromData: t.resetFromData,
      saving: t.saving, savingLongSessions: t.longSaving, replaceManual: o.replaceManual,
    }, null, 2));
  } else {
    console.log(render(t, o));
  }
}

// Run main only when started as a program, not when imported by the tests. npx starts it through a
// symlink in node_modules/.bin on Linux and macOS, so compare real paths, not the paths as given.
export function isMain(argv1, selfUrl) {
  if (!argv1) return false;
  try {
    const norm = (p) => {
      const r = fs.realpathSync(p);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    return norm(path.resolve(argv1)) === norm(fileURLToPath(selfUrl));
  } catch {
    return false;
  }
}

if (isMain(process.argv[1], import.meta.url)) {
  main();
}
