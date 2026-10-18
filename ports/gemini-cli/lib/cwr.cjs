'use strict'
// compact-when-ready for Gemini CLI: shared logic for the hook script and the MCP server.
// Plain CommonJS, no dependencies, no network. Every handler takes the hook's stdin payload and returns the JSON
// object the hook prints; all state lives in small files in the state folder (see stateDirFor).

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SERVER_NAME = 'compact-when-ready'
const TOOL = 'compact_now'
const TOOL_FQN = `mcp_${SERVER_NAME}_${TOOL}` // how Gemini CLI names an MCP tool: mcp_<server>_<tool>

const DEFAULT_SOFT = 50
const DEFAULT_STRICT = 60
const DEFAULT_WINDOW = 1_000_000
const REMIND_STEP = 2 // percentage points between repeated strict notes
const DROP_POINTS = 20 // a fall this big between two readings of one model is a compaction done some other way
const QUEUED_MAX_AGE_MS = 10 * 60_000 // the MCP server's unscoped flag is adopted by a session only while fresh
const PENDING_MAX_AGE_MS = 10 * 60_000 // a session's pending reset that nobody honoured expires after this
const CLEAR_COOLDOWN_MS = 2 * 60_000 // a second clear sooner than this after the last one is refused while the context is small
const CLEAR_GROWTH_POINTS = 10 // ... or while it has not grown this far past its size right after the last clear
// After a clear or a compression the first main-chat reading is the floor: for that cycle both lines sit at least this
// far above it, so a session whose fixed part (system prompt, tools, GEMINI.md) is near the lines is not asked to reset
// again and again (the Claude Code mod 0.3.5 rule: there a 90K-token CLAUDE.md on a 200K window left 50-51% after each
// compaction, and the model compacted three times in two minutes).
const FLOOR_GAIN = 10
const STATE_MAX_AGE_MS = 7 * 24 * 3600_000 // per-session files older than this are deleted at SessionStart
// The first message of the main chat is Gemini CLI's environment context (getEnvironmentContext in the 0.64.0 bundle,
// prepended by getInitialChatHistory after every reset and compression); a subagent chat does not start with it.
const MAIN_CHAT_MARKER = 'This is the Gemini CLI. We are setting up the context for our chat'
const LOG_MAX_BYTES = 256 * 1024
const LOG_KEEP_LINES = 1000

// Context windows of the Gemini models, matched on the model name a hook receives (llm_request.model).
// First match wins, so list the longer names first.
const WINDOWS = [
  [/^gemini-1\.5-pro/i, 2_097_152],
  [/^gemini-1\.5/i, 1_048_576],
  [/^gemini-(2|3)(\.\d+)?-(pro|flash)/i, 1_048_576],
  [/^gemini-/i, 1_048_576],
]

// ---------- paths and config ----------

const stateDirFor = (env = process.env) => {
  const explicit = env.COMPACT_WHEN_READY_STATE_DIR
  if (explicit && explicit.trim()) return path.resolve(explicit.trim())
  const home = env.GEMINI_CLI_HOME || os.homedir()
  return path.join(home, '.gemini', 'state', 'compact-when-ready')
}

const safeId = id => String(id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'unknown'

const num = (v, lo, hi) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) && n > lo && n < hi ? n : undefined
}
const flag = v => {
  if (v === true) return true
  if (typeof v !== 'string') return false
  const s = v.trim().toLowerCase()
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'off'
}

// Defaults, then config.json in the state folder (re-read on every call), then environment variables.
// {soft, strict, window, off}; "threshold" is accepted for "strict" like the Claude Code mod's config.json.
const loadConfig = (dir, env = process.env) => {
  const c = { soft: DEFAULT_SOFT, strict: DEFAULT_STRICT, window: undefined, off: false }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    if (j && typeof j === 'object') {
      c.soft = num(j.soft, 0, 100) ?? c.soft
      c.strict = num(j.strict ?? j.threshold, 0, 100) ?? c.strict
      c.window = num(j.window, 999, 1e9) ?? c.window
      if (typeof j.off === 'boolean') c.off = j.off
    }
  } catch {
    // no config file, or a broken one: the defaults stand
  }
  c.soft = num(env.COMPACT_WHEN_READY_SOFT, 0, 100) ?? c.soft
  c.strict = num(env.COMPACT_WHEN_READY_STRICT, 0, 100) ?? c.strict
  c.window = num(env.COMPACT_WHEN_READY_WINDOW, 999, 1e9) ?? c.window
  if (flag(env.COMPACT_WHEN_READY_OFF)) c.off = true
  return c
}

// An explicitly set window wins; else the model table; else the default.
const windowFor = (model, cfg) => {
  if (cfg.window) return cfg.window
  if (typeof model === 'string') for (const [re, w] of WINDOWS) if (re.test(model)) return w
  return DEFAULT_WINDOW
}

// ---------- files ----------

const ensureDir = dir => fs.mkdirSync(dir, { recursive: true })

const writeJson = (file, obj) => {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  const body = JSON.stringify(obj)
  try {
    fs.writeFileSync(tmp, body)
    fs.renameSync(tmp, file)
  } catch {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // nothing to clean
    }
    fs.writeFileSync(file, body)
  }
}

const readJson = file => {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

const sessionFile = (dir, sid) => path.join(dir, `${safeId(sid)}.json`)
// The pending reset of a session lives in its own file: only the compact_now branch writes it; only AfterAgent, an
// expiry or a new user turn removes it. Hooks that run in parallel and rewrite the session state can then never lose it.
const pendingFile = (dir, sid) => path.join(dir, `${safeId(sid)}.pending.json`)
const queuedFile = dir => path.join(dir, 'queued.json')
const logFile = dir => path.join(dir, 'events.jsonl')

const freshState = () => ({
  tokens: 0,
  model: null,
  window: null,
  percent: 0,
  softNoted: false,
  lastNote: -1,
  sawMain: false, // a reading from the main chat has been seen since the cycle began
  subActive: false, // a subagent chat has made a reading since the main chat's last one
  ignoredLogged: false,
  lastClearAt: null,
  clearBase: null, // percent at the first main-chat reading after the last clear
  floor: null, // whole percent at the first main-chat reading after the last clear or compression
  floorNext: false, // a clear happened: the next main-chat reading sets the floor
  floorNoted: false, // this floor's line move is logged
})

const LEGACY_KEYS = ['pending', 'handoff', 'keep', 'queuedAt'] // moved to <sid>.pending.json
const readState = (dir, sid) => {
  const st = { ...freshState(), ...(readJson(sessionFile(dir, sid)) || {}) }
  for (const k of LEGACY_KEYS) delete st[k]
  return st
}
const writeState = (dir, sid, st) => writeJson(sessionFile(dir, sid), { ...st, updatedAt: new Date().toISOString() })

// Read the state right before the write, let fn change only the fields its hook owns, and write only if something
// changed. Returns what fn returns. Two hooks racing can still overwrite each other's fields within a few
// milliseconds, so nothing a later hook must not lose (the pending reset) lives in this file.
const update = (dir, sid, fn) => {
  const st = readState(dir, sid)
  const before = JSON.stringify(st)
  const out = fn(st)
  if (JSON.stringify(st) !== before) writeState(dir, sid, st)
  return out
}

const removeFile = file => {
  try {
    fs.unlinkSync(file)
  } catch {
    // already gone
  }
}

// The session's pending reset, or null. One that has waited longer than PENDING_MAX_AGE_MS is removed (expiry).
const readPending = (dir, sid) => {
  const p = readJson(pendingFile(dir, sid))
  if (!p) return null
  const age = Date.now() - Date.parse(p.queuedAt)
  if (Number.isFinite(age) && age > PENDING_MAX_AGE_MS) {
    removeFile(pendingFile(dir, sid))
    log(dir, sid, 'pending-expired', { handoff: p.handoff || null, queuedAt: p.queuedAt })
    return null
  }
  return p
}

// Same folder, compared the way the OS does (Windows paths ignore case and a trailing separator).
const sameFolder = (a, b) => {
  const norm = p => {
    const r = path.resolve(p).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

// Events as JSON lines. Never throws: a log that cannot be written must not break a hook.
const log = (dir, sid, kind, data = {}) => {
  try {
    ensureDir(dir)
    const file = logFile(dir)
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), sid: safeId(sid), kind, ...data }) + '\n')
    if (fs.statSync(file).size > LOG_MAX_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      fs.writeFileSync(file, lines.slice(-LOG_KEEP_LINES).join('\n') + '\n')
    }
  } catch {
    // ignore
  }
}

// ---------- the texts ----------

const steps = () =>
  [
    '1. Finish only the step you are on; start nothing new.',
    "2. Save everything a fresh start would need: write a handoff file (or update the one this project already uses): the task, what is done, the next step, open decisions and the files that matter.",
    `3. Call the ${TOOL} tool (${TOOL_FQN}) with that handoff file's path and what must be kept (the task, the next step, open decisions).`,
    '4. End your reply right there: no more tool calls and no closing summary. Your conversation is then cleared and a message tells you to read the handoff and continue.',
  ].join('\n')

const softText = (p, strict) =>
  [
    `[compact-when-ready] Context is at ${p}% of the window. Plan a context reset at a comfortable moment before ${strict}%, where you will be told to do it at once:`,
    '- Finish the piece you are on, and finish it properly (for example the page, section or feature: done, checked, saved). Do not start the next big piece before the reset.',
    `- At that clean break: write the handoff file (what is done, what is next, the files that matter), call the ${TOOL} tool (${TOOL_FQN}) with the handoff file's path, then end your reply.`,
    '- If your reply is ending anyway (the work is done, or you are waiting on the user), that is a good moment too.',
  ].join('\n')

const strictText = (p, strict) =>
  `[compact-when-ready] Context is at ${p}% of the window (the line is ${strict}%). Save and reset now; do not wait for a better moment. In this order:\n${steps()}`

const QUEUED_NOTE =
  '[compact-when-ready] The reset is queued. End your reply now: no more tool calls and no more text. It runs as soon as the turn ends, and a message then tells you to continue.'

const continueReason = handoff =>
  `The conversation was just cleared at your request. Your handoff: ${handoff || '(no path was given; look for the handoff file you saved)'}. Read it first, then carry on exactly where you left off.`

// ---------- the pieces the handlers share ----------

const isCompactNow = input => {
  const name = String(input.tool_name || '')
  const mcp = input.mcp_context
  if (mcp && mcp.server_name === SERVER_NAME && mcp.tool_name === TOOL) return true
  return name === TOOL_FQN || name === TOOL
}

// The lines this cycle: as set, but at least FLOOR_GAIN points above the floor (a soft line lifted to the strict one
// is off, as when set that way).
const linesFor = (st, cfg) =>
  st.floor == null
    ? { soft: cfg.soft, strict: cfg.strict }
    : { soft: Math.max(cfg.soft, st.floor + FLOOR_GAIN), strict: Math.max(cfg.strict, st.floor + FLOOR_GAIN) }

const pctOf = (st, cfg) => {
  if (!(st.tokens > 0)) return undefined
  const w = windowFor(st.model, cfg)
  return (st.tokens / w) * 100
}

// The note due at this reading, if any. Mutates `st` (softNoted, lastNote); the caller writes it back.
const dueNote = (st, cfg, dir, sid) => {
  const pct = pctOf(st, cfg)
  if (pct === undefined) return null
  const p = Math.floor(pct)
  const l = linesFor(st, cfg)
  if (st.floor != null && !st.floorNoted && (l.soft !== cfg.soft || l.strict !== cfg.strict)) {
    st.floorNoted = true
    log(dir, sid, 'high-floor', { floor: st.floor, soft: l.soft, strict: l.strict })
  }
  if (pct < l.strict) {
    if (st.softNoted || l.soft >= l.strict || pct < l.soft) return null
    st.softNoted = true
    log(dir, sid, 'soft-note', { percent: p, soft: l.soft, strict: l.strict })
    return softText(p, l.strict)
  }
  if (st.lastNote >= 0 && pct < st.lastNote + REMIND_STEP) return null
  st.softNoted = true
  st.lastNote = pct
  log(dir, sid, 'strict-note', { percent: p, strict: l.strict })
  return strictText(p, l.strict)
}

// compact_now was called in this session: write the session's pending reset. The MCP server cannot know the session, so
// it leaves an unscoped queued.json; the hook (which does know the session) claims it, preferring the tool input's own
// handoff. This is the only place that writes <sid>.pending.json.
const adoptQueued = (dir, sid, input, why) => {
  const q = readJson(queuedFile(dir))
  const fromInput = input && input.tool_input && typeof input.tool_input.handoff === 'string' ? input.tool_input.handoff.trim() : ''
  const handoff = fromInput || (q && typeof q.handoff === 'string' ? q.handoff : null)
  const pending = {
    handoff,
    keep: (input && input.tool_input && input.tool_input.keep) || (q && q.keep) || null,
    queuedAt: new Date().toISOString(),
    via: why,
  }
  writeJson(pendingFile(dir, sid), pending)
  removeFile(queuedFile(dir))
  log(dir, sid, 'queued', { handoff, via: why })
  return pending
}

// Which chat a model response belongs to. The main chat starts with the environment context; a subagent chat (same
// session id, same model) does not. No messages in the payload: unknown.
const chatKind = input => {
  const msgs = input.llm_request && input.llm_request.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return 'unknown'
  const first = msgs[0] && typeof msgs[0].content === 'string' ? msgs[0].content : ''
  return first.includes(MAIN_CHAT_MARKER) ? 'main' : 'other'
}

// Deletes the per-session files (<sid>.json, <sid>.pending.json) not touched for STATE_MAX_AGE_MS. Only plain files in
// the state folder itself, one unlinkSync each; config.json, queued.json and the log are never candidates.
const pruneOldState = (dir, keepSid) => {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  let n = 0
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+(\.pending)?\.json$/.test(name) || name === 'config.json' || name === 'queued.json') continue
    if (name === `${safeId(keepSid)}.json` || name === `${safeId(keepSid)}.pending.json`) continue
    try {
      const file = path.join(dir, name)
      const stt = fs.statSync(file)
      if (stt.isFile() && Date.now() - stt.mtimeMs > STATE_MAX_AGE_MS) {
        fs.unlinkSync(file)
        n++
      }
    } catch {
      // skip what cannot be read or removed
    }
  }
  return n
}

// ---------- the handlers (one per hook event) ----------

const handlers = {
  // Tokens used so far in the session, from the usage metadata of each model response chunk.
  AfterModel(input, ctx) {
    const { dir, cfg, sid } = ctx
    const u = input.llm_response && input.llm_response.usageMetadata
    if (!u) return {}
    const total = Number(u.totalTokenCount) || (Number(u.promptTokenCount) || 0) + (Number(u.candidatesTokenCount) || 0) || Number(u.promptTokenCount) || 0
    if (!(total > 0)) return {}
    const model = (input.llm_request && input.llm_request.model) || null
    const kind = chatKind(input)
    const queued = !!readPending(dir, sid)
    update(dir, sid, st => {
      // A subagent chat shares the session id and the model but has a context of its own. Once the main chat has been
      // seen, readings from any other chat are ignored: they are neither the main context's size nor a compression of it.
      if (kind === 'other' && st.sawMain) {
        st.subActive = true
        if (!st.ignoredLogged) {
          st.ignoredLogged = true
          log(dir, sid, 'reading-ignored', { reason: 'not the main chat', total })
        }
        return
      }
      if (kind === 'main') {
        st.sawMain = true
        st.subActive = false
      }
      if (st.tokens === total && st.model === model) return
      const before = pctOf(st, cfg)
      const sameModel = st.model === model
      st.tokens = total
      st.model = model
      st.window = windowFor(model, cfg)
      st.percent = Math.round(((total / st.window) * 100) * 10) / 10
      if (st.lastClearAt && st.clearBase == null) st.clearBase = st.percent
      if (st.floorNext && kind !== 'other') {
        st.floor = Math.round(st.percent)
        st.floorNext = false
        st.floorNoted = false
      }
      // a fall of DROP_POINTS or more between two readings of the main chat, with nothing of ours queued: Gemini CLI's
      // own compression (or a /clear) happened, so the note cycle starts over
      if (!queued && before !== undefined && sameModel && st.percent <= before - DROP_POINTS) {
        st.softNoted = false
        st.lastNote = -1
        st.floor = Math.round(st.percent) // this reading is the first after it
        st.floorNext = false
        st.floorNoted = false
        log(dir, sid, 'compacted-elsewhere', { from: Math.round(before), to: Math.round(st.percent) })
      }
    })
    return {}
  },

  // The note rides on the tool result (AfterTool additionalContext is appended to what the model reads).
  AfterTool(input, ctx) {
    const { dir, cfg, sid } = ctx
    if (isCompactNow(input)) {
      if (input.tool_response && input.tool_response.error) {
        log(dir, sid, 'compact-now-failed', { error: String(input.tool_response.error.message || input.tool_response.error).slice(0, 200) })
        return {}
      }
      adoptQueued(dir, sid, input, 'AfterTool')
      return {}
    }
    // AfterTool does not say which chat made the call. While a subagent is running (its model readings came after the
    // main chat's last one) a tool result may be the subagent's, which cannot act on a note, and the note would be used
    // up. invoke_agent's own result is the main chat's and marks the subagent as finished.
    const inSubagent = update(dir, sid, st => {
      if (String(input.tool_name || '') === 'invoke_agent') st.subActive = false
      return st.subActive
    })
    if (inSubagent) return {}
    if (readPending(dir, sid)) return { hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: QUEUED_NOTE } }
    const text = update(dir, sid, st => dueNote(st, cfg, dir, sid))
    if (!text) return {}
    return { hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: text } }
  },

  // The same note when a turn starts past a line (it is appended to the prompt for that turn).
  BeforeAgent(input, ctx) {
    const { dir, cfg, sid } = ctx
    // A new turn (the user's next prompt, or the clear's own continuation) has begun. A reset still pending from an
    // earlier turn was never honoured (the user cancelled, or the turn ended with stop_hook_active): drop it, so this
    // turn is not told to end and is not cleared unasked. The clear's own continuation finds no flag: AfterAgent
    // removed it before it returned the deny.
    const pend = readPending(dir, sid)
    if (pend) {
      removeFile(pendingFile(dir, sid))
      log(dir, sid, 'pending-dropped', { handoff: pend.handoff || null, queuedAt: pend.queuedAt || null })
    }
    const q = readJson(queuedFile(dir))
    if (q && (!q.cwd || !input.cwd || sameFolder(q.cwd, input.cwd))) {
      removeFile(queuedFile(dir))
      log(dir, sid, 'pending-dropped', { handoff: q.handoff || null, queuedAt: q.at || null, via: 'queued.json' })
    }
    const text = update(dir, sid, st => {
      st.subActive = false // a new turn: no subagent is running
      return dueNote(st, cfg, dir, sid)
    })
    if (!text) return {}
    return { hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: text } }
  },

  // The turn is over. If compact_now was called: clear the conversation and send the model back to the handoff.
  AfterAgent(input, ctx) {
    const { dir, cfg, sid } = ctx
    let pend = readPending(dir, sid)
    if (!pend) {
      // claim a fresh flag from the MCP server when the AfterTool hook did not (same working folder only)
      const q = readJson(queuedFile(dir))
      const age = q && q.at ? Date.now() - Date.parse(q.at) : Infinity
      const sameCwd = q && (!q.cwd || !input.cwd || sameFolder(q.cwd, input.cwd))
      if (q && age >= 0 && age <= QUEUED_MAX_AGE_MS && sameCwd) pend = adoptQueued(dir, sid, null, 'AfterAgent')
    }
    if (!pend) return {}
    // Gemini CLI's headless loop passes stop_hook_active only for the immediate continuation (never again later in the
    // run), so it cannot be relied on to stop repeated clears: refuse a second clear soon after the last one while the
    // context is still small.
    const st0 = readState(dir, sid)
    const since = st0.lastClearAt ? Date.now() - Date.parse(st0.lastClearAt) : Infinity
    const pct = pctOf(st0, cfg)
    // "Small" means below the soft line, and also not grown by CLEAR_GROWTH_POINTS since the first reading after that clear
    // (with a small window set by the user, a cleared context can already sit above the soft line; seen in the live loop test).
    const small = pct === undefined || pct < Math.min(cfg.soft, cfg.strict) || (st0.clearBase != null && pct - st0.clearBase < CLEAR_GROWTH_POINTS)
    if (since >= 0 && since < CLEAR_COOLDOWN_MS && small) {
      removeFile(pendingFile(dir, sid))
      log(dir, sid, 'clear-refused', { sinceLastClearMs: Math.round(since), percent: pct === undefined ? null : Math.round(pct) })
      return {}
    }
    if (input.stop_hook_active === true) {
      log(dir, sid, 'clear-skipped', { reason: 'stop_hook_active' })
      return {}
    }
    const handoff = pend.handoff
    update(dir, sid, st => {
      Object.assign(st, freshState(), { model: st.model, window: st.window, lastClearAt: new Date().toISOString(), floorNext: true })
    })
    removeFile(pendingFile(dir, sid))
    log(dir, sid, 'cleared', { handoff })
    return {
      decision: 'deny',
      reason: continueReason(handoff),
      hookSpecificOutput: { hookEventName: 'AfterAgent', clearContext: true },
    }
  },

  // A new, resumed or cleared session: nothing known yet, start the cycle over.
  SessionStart(input, ctx) {
    const { dir, sid } = ctx
    const prev = readState(dir, sid)
    writeState(dir, sid, { ...freshState(), lastClearAt: prev.lastClearAt })
    removeFile(pendingFile(dir, sid))
    log(dir, sid, 'session-start', { source: input.source || null })
    const pruned = pruneOldState(dir, sid)
    if (pruned) log(dir, sid, 'state-pruned', { files: pruned })
    return {}
  },

  // No PreCompress handler on purpose: Gemini CLI 0.64.0 fires that hook at the start of every compression CHECK
  // (every turn and before every follow-up request), not only when it compresses. Resetting the note cycle there made the
  // soft note repeat after every tool call (seen in the live run). A real compression shows up as a fall in the
  // token reading instead (see AfterModel).
}

// Runs one hook event; returns the object to print. Never throws: a broken hook must not break the CLI.
const run = (input, env = process.env) => {
  const dir = stateDirFor(env)
  const event = String((input && input.hook_event_name) || '')
  const handler = handlers[event]
  if (!handler) return {}
  const sid = (input && input.session_id) || 'unknown'
  try {
    const cfg = loadConfig(dir, env)
    if (cfg.off) return {}
    return handler(input, { dir, cfg, sid }) || {}
  } catch (err) {
    log(dir, sid, 'hook-error', { event, error: String(err && err.message ? err.message : err).slice(0, 300) })
    return {}
  }
}

module.exports = {
  SERVER_NAME,
  TOOL,
  TOOL_FQN,
  DEFAULT_SOFT,
  DEFAULT_STRICT,
  DEFAULT_WINDOW,
  WINDOWS,
  stateDirFor,
  safeId,
  loadConfig,
  windowFor,
  readJson,
  writeJson,
  readState,
  sessionFile,
  queuedFile,
  pendingFile,
  logFile,
  log,
  isCompactNow,
  handlers,
  run,
  softText,
  strictText,
  continueReason,
  QUEUED_NOTE,
}
