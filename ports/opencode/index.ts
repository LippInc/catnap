import { type Plugin, type PluginOptions, tool } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

// compact-when-ready for OpenCode: the model compacts its own conversation at a clean break, then carries on.
//
// Flow (same behaviour as the Claude Code mod):
//   1. `message.updated` (assistant) gives the context use of the session: input + output + cache.read + cache.write
//      of the latest assistant message, as a percent of the model's window (`client.config.providers()` ->
//      limit.context, or the `window` option).
//   2. SOFT line (default 50%): ONE note, once per cycle. STRICT line (default 60%): a stricter note, repeated every
//      REMIND_STEP points until the model calls compact_now.
//      Route for the notes: `tool.execute.after`, which appends the note to the output of a tool call. Why this one and
//      not `experimental.chat.system.transform`: the note is written into the conversation exactly once (it is part of
//      a stored tool result, so it stays in context like any other text), it reaches the model on its very next
//      step, and it does not touch the system prompt, so the provider's prompt cache for the stable prefix is never
//      invalidated. A system-transform note would be re-sent (and re-priced) on every later call, or would have to
//      be dropped again by the plugin, and it can change the cached prefix. The cost: a note only appears after a
//      tool call (a turn with no tool call gets none), which is the same as the Claude Code original.
//   3. `compact_now` (a model-callable tool) only records the request: a pending flag for that session.
//   4. When the session goes idle (`session.idle`, or `session.status` = idle) with a pending flag: summarize the
//      session (`client.session.summarize`), then send the continue prompt (`client.session.promptAsync`).
//      One compaction per request; a failed summarize is retried once, then the plugin gives up for that cycle.
//   5. OpenCode's own auto-compaction is never touched: it stays the backstop.
//   6. After any compaction the first percent seen is the floor: for that cycle both lines sit at least FLOOR_GAIN
//      points above it (logged once a cycle, one toast a session when that moves a line), so a session whose fixed
//      part (system prompt, tools, AGENTS.md) is near the lines is not asked to compact again and again.
//
// Files written: one JSON-lines log per session in <state>/compact-when-ready-opencode/. No network calls of its own.

const TOOL = "compact_now"
const LOG_FOLDER = "compact-when-ready-opencode"
const DEFAULT_SOFT = 50
const DEFAULT_STRICT = 60
const REMIND_STEP = 2 // percentage points between repeated strict notes
const SUMMARIZE_TRIES = 2 // the first try plus one retry
const SUMMARIZE_TIMEOUT_MS = 10 * 60_000
// how far above the floor the lines sit at least (the Claude Code mod 0.3.5 has the same rule: there a 90K-token
// CLAUDE.md on a 200K window left 50-51% after each compaction, and the model compacted twice in under a minute and queued a third)
const FLOOR_GAIN = 10

type Config = { soft: number; strict: number; window: number | undefined; off: boolean; logDir: string }
type Job = { handoff: string; keep: string; percent: number }
type Sess = {
  id: string
  pct: number // -1 = unknown (nothing seen since the cycle started)
  providerID: string
  modelID: string
  softNoted: boolean
  lastNote: number // percent at the last strict note, -1 = none
  pending: Job | null
  running: boolean // a compaction for this session is in flight
  job: Job | null // the job being compacted now (for the compaction prompt hook)
  gaveUp: boolean
  child: boolean | undefined // a subagent session (has a parent): it gets no notes and cannot compact
  dir: string // the session's folder, from session.get ("" = not known: the plugin's own folder is used)
  started: boolean
  lastCreated: number // created time of the newest assistant message counted
  floor: number // messages created at or before this are from before the last compaction
  maxCreated: number
  agent: string // agent of the latest assistant message ("" = unknown): the continue prompt runs under it
  newestCreated: number // created time of the newest assistant message seen, token-bearing or not
  errored: boolean // that newest message ended with an error (aborted, provider error, ...)
  pctFloor: number // percent at the first message after the last compaction, -1 = none seen yet
  floorNext: boolean // a compaction landed: the next message with tokens sets the floor
  floorNoted: boolean // this floor's line move is logged
  floorWarned: boolean // the toast about a floor near the lines went out (once a session)
}

// ---- options ---------------------------------------------------------------------------------------------------

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}
// a line in percent: above 0 and below 100
const percentOf = (...vs: unknown[]): number | undefined => {
  for (const v of vs) {
    const n = num(v)
    if (n !== undefined && n > 0 && n < 100) return n
  }
  return undefined
}
const windowOf = (...vs: unknown[]): number | undefined => {
  for (const v of vs) {
    const n = num(v)
    if (n !== undefined && n >= 1000) return Math.floor(n)
  }
  return undefined
}
const isOn = (v: string | undefined) => v !== undefined && !["", "0", "false", "no"].includes(v.trim().toLowerCase())

// order of precedence: environment variable, then plugin option, then default
const readConfig = (options: PluginOptions | undefined, env: Record<string, string | undefined>): Config => {
  const o = options ?? {}
  const stateBase = env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  const logDir =
    env.COMPACT_WHEN_READY_LOG_DIR ||
    (typeof o.logDir === "string" && o.logDir ? o.logDir : "") ||
    join(stateBase, LOG_FOLDER)
  return {
    soft: percentOf(env.COMPACT_WHEN_READY_SOFT, o.soft) ?? DEFAULT_SOFT,
    strict: percentOf(env.COMPACT_WHEN_READY_STRICT, o.strict) ?? DEFAULT_STRICT,
    window: windowOf(env.COMPACT_WHEN_READY_WINDOW, o.window),
    off: isOn(env.COMPACT_WHEN_READY_OFF) || o.off === true,
    logDir,
  }
}

// ---- the texts ---------------------------------------------------------------------------------------------------

const softText = (p: number, strict: number) =>
  [
    `[compact-when-ready] Context is at ${Math.round(p)}% of the window. Compact at a comfortable moment before ${strict}%, where you will be told to compact at once:`,
    "- Finish the piece you are on, and finish it properly (for example the function, section or test: done, checked, saved). Do not start the next big piece before compacting.",
    `- At that clean break: save a short handoff file (what is done, what is next, the files involved), call ${TOOL} with the handoff file's path, then end your turn.`,
    "- If your reply is ending anyway (the work is done, or you are waiting on the user), that is a good moment too.",
  ].join("\n")

const strictText = (p: number, strict: number) =>
  [
    `[compact-when-ready] Context is at ${Math.round(p)}% of the window (the line is ${strict}%). Save and compact now; do not wait for a better moment. In this order:`,
    "1. Finish only the step you are on; start nothing new.",
    "2. Save a short handoff file: what is done, what is next, open decisions and the files that matter.",
    `3. Call ${TOOL} with that handoff file's path (and in 'keep' what the summary must keep).`,
    "4. End your turn right there: no more tool calls and no closing summary. The compaction runs once your turn ends, and a message then tells you to continue.",
  ].join("\n")

const QUEUED_NOTE =
  "[compact-when-ready] Compaction is queued. End your turn now: no more tool calls and no more text. It runs as soon as the turn ends, and a message then tells you to continue."

const QUEUED_RESULT = "Compaction queued. End your turn now."

// the most of a handoff the continue message carries (about 8K tokens); a longer one is cut there, and the message says
// where the rest is
const PASTE_MAX = 32_000

const CARRY_ON =
  "Carry on exactly where you left off, with the next step it names. " +
  "If the work was finished, or you were waiting on the user, say in a line or two where things stand and stop; do not start new work."

// The handoff file's text for the continue message, trimmed and cut at PASTE_MAX; null when the file is missing,
// unreadable (a folder, no rights) or empty. A relative path is read from `dir`, the session's folder.
const readHandoff = (handoff: string, dir: string): { text: string; cut: boolean } | null => {
  try {
    const text = readFileSync(resolve(dir || process.cwd(), handoff), "utf8").trim()
    if (text === "") return null
    return text.length <= PASTE_MAX ? { text, cut: false } : { text: text.slice(0, PASTE_MAX), cut: true }
  } catch {
    return null
  }
}

// The continue message. With the handoff's text it carries the text itself (a model can skip "Read it first" and carry on
// from the summary alone); when the file cannot be read it only names the file, as before.
const continueText = (job: Job, dir: string) => {
  const head = `[compact-when-ready] The conversation was just compacted at your request${job.percent >= 0 ? ` (context had reached ${Math.round(job.percent)}%)` : ""}.`
  const back = readHandoff(job.handoff, dir)
  if (!back) return `${head} Your handoff: ${job.handoff}. Read it first, then ${CARRY_ON.charAt(0).toLowerCase()}${CARRY_ON.slice(1)}`
  const rest = back.cut ? `\n[cut here at ${PASTE_MAX} characters: read the rest in ${job.handoff} before you go on]` : ""
  return `${head} Here is the handoff you wrote just before it (saved in ${job.handoff}):\n\n<handoff>\n${back.text}${rest}\n</handoff>\n\n${CARRY_ON}`
}

const instructionsFor = (job: Job) =>
  `Keep what the next turn needs to continue: ${job.keep}. The full state is saved in ${job.handoff}; name that path in the summary.`

// ---- the plugin --------------------------------------------------------------------------------------------------

const server: Plugin = async ({ client, directory }, options) => {
  const cfg = readConfig(options, process.env)
  if (cfg.off) return {} // COMPACT_WHEN_READY_OFF: no tool, no hooks, no log

  const sessions = new Map<string, Sess>()
  const windows = new Map<string, number | null>() // "provider/model" -> context limit, null = lookup found nothing
  const noWindowLogged = new Set<string>()
  let logDirReady = false

  const sess = (id: string): Sess => {
    let s = sessions.get(id)
    if (!s) {
      s = {
        id,
        pct: -1,
        providerID: "",
        modelID: "",
        softNoted: false,
        lastNote: -1,
        pending: null,
        running: false,
        job: null,
        gaveUp: false,
        child: undefined,
        dir: "",
        started: false,
        lastCreated: 0,
        floor: -1,
        maxCreated: 0,
        agent: "",
        newestCreated: 0,
        errored: false,
        pctFloor: -1,
        floorNext: false,
        floorNoted: false,
        floorWarned: false,
      }
      sessions.set(id, s)
    }
    return s
  }

  // JSON lines, one file per session. The only thing this plugin writes. Never throws.
  const log = (id: string, kind: string, data: Record<string, unknown> = {}) => {
    try {
      if (!logDirReady) {
        mkdirSync(cfg.logDir, { recursive: true })
        logDirReady = true
      }
      const file = join(cfg.logDir, `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`)
      appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind, session: id, ...data }) + "\n")
    } catch {
      // a log that cannot be written must never disturb the session
    }
  }
  const touch = (s: Sess) => {
    if (s.started) return
    s.started = true
    log(s.id, "start", { soft: cfg.soft, strict: cfg.strict, window: cfg.window ?? null })
  }

  // a new cycle: after a compaction (ours or someone else's) the notes start over
  const resetCycle = (s: Sess) => {
    s.pct = -1
    s.softNoted = false
    s.lastNote = -1
    s.floor = s.maxCreated // anything created up to now is from before the compaction
    s.lastCreated = 0
    s.errored = false
    s.floorNext = true // the first message with tokens after it is the floor
  }

  // The lines this cycle: as set, but at least FLOOR_GAIN points above the floor (a soft line lifted to the strict
  // one is off, as when set that way).
  const linesFor = (s: Sess): { soft: number; strict: number } =>
    s.pctFloor < 0
      ? { soft: cfg.soft, strict: cfg.strict }
      : { soft: Math.max(cfg.soft, s.pctFloor + FLOOR_GAIN), strict: Math.max(cfg.strict, s.pctFloor + FLOOR_GAIN) }

  const windowFor = async (providerID: string, modelID: string): Promise<{ size: number; source: string } | undefined> => {
    if (cfg.window) return { size: cfg.window, source: "option" }
    const key = `${providerID}/${modelID}`
    if (!windows.has(key)) {
      try {
        const res: any = await client.config.providers()
        if (res && typeof res === "object" && res.error) throw new Error("providers lookup returned an error")
        const list: any[] = res?.data?.providers ?? []
        const limit = list.find((p) => p?.id === providerID)?.models?.[modelID]?.limit?.context
        // the lookup returned: cache the size, or a clean "not found" (null)
        windows.set(key, typeof limit === "number" && limit > 0 ? limit : null)
      } catch {
        // the lookup failed: cache nothing, so the next message tries again (notes stay off until one works)
      }
    }
    const size = windows.get(key)
    return size ? { size, source: "providers" } : undefined
  }

  const isChild = async (s: Sess): Promise<boolean> => {
    if (s.child !== undefined) return s.child
    try {
      const res: any = await client.session.get({ path: { id: s.id } })
      s.child = Boolean(res?.data?.parentID)
      if (typeof res?.data?.directory === "string") s.dir = res.data.directory
    } catch {
      s.child = false
    }
    return s.child
  }

  const toast = async (message: string, variant: "info" | "warning" | "error" = "warning") => {
    try {
      await client.tui.showToast({ body: { title: "compact-when-ready", message, variant } })
    } catch {
      // no TUI (opencode run / serve): the log has it
    }
  }

  const giveUp = async (s: Sess, reason: string) => {
    log(s.id, "gave-up", { reason })
    s.pending = null
    s.gaveUp = true // no notes until a compaction lands some other way, or the model calls compact_now again
    await toast(`could not compact this chat (${reason}). OpenCode's automatic compaction still applies.`)
  }

  const failure = (res: any): string | undefined => {
    if (res && typeof res === "object" && res.error) return JSON.stringify(res.error).slice(0, 300)
    return undefined
  }

  const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
      p.then(
        (v) => (clearTimeout(t), resolve(v)),
        (e) => (clearTimeout(t), reject(e)),
      )
    })

  // The compaction itself. Runs from the idle event, never inside a tool call (summarize waits for the session loop).
  const compact = async (s: Sess, job: Job) => {
    if (!s.providerID || !s.modelID) return giveUp(s, "no assistant message seen yet, so the model is unknown")
    s.job = job
    let ok = false
    let result: unknown
    for (let attempt = 1; attempt <= SUMMARIZE_TRIES && !ok; attempt++) {
      try {
        const res = await withTimeout(
          client.session.summarize({ path: { id: s.id }, body: { providerID: s.providerID, modelID: s.modelID } }),
          SUMMARIZE_TIMEOUT_MS,
        )
        const bad = failure(res)
        if (bad) throw new Error(bad)
        result = (res as any)?.data
        ok = true
      } catch (err) {
        log(s.id, "summarize-failed", { attempt, error: String(err).slice(0, 300) })
      }
    }
    s.job = null
    if (!ok) return giveUp(s, "summarize failed twice")
    log(s.id, "compacted", { percent: Math.round(job.percent), handoff: job.handoff, result: result ?? null })
    resetCycle(s)
    s.gaveUp = false

    let sent = false
    for (let attempt = 1; attempt <= 2 && !sent; attempt++) {
      try {
        const res = await client.session.promptAsync({
          path: { id: s.id },
          body: {
            model: { providerID: s.providerID, modelID: s.modelID },
            ...(s.agent ? { agent: s.agent } : {}), // keep the user's agent (plan, a read-only custom one, ...)
            parts: [{ type: "text", text: continueText(job, s.dir || directory || "") }],
          },
        })
        const bad = failure(res)
        if (bad) throw new Error(bad)
        sent = true
      } catch (err) {
        log(s.id, "continue-failed", { attempt, error: String(err).slice(0, 300) })
      }
    }
    if (sent) log(s.id, "continued", { handoff: job.handoff })
    else {
      // the compaction itself landed, so the notes stay on for the new cycle (gaveUp stays false); only say so
      log(s.id, "continue-gave-up", { handoff: job.handoff })
      await toast(
        `the chat was compacted, but the continue message could not be sent. Tell the model to read ${job.handoff} and carry on.`,
      )
    }
  }

  const onIdle = async (id: string) => {
    const s = sessions.get(id)
    const job = s?.pending
    if (!s || !job || s.running) return // idle without a pending flag does nothing
    if (s.errored) {
      // the turn was cancelled or errored: stay queued, the next turn that ends normally compacts (as in the original)
      log(s.id, "idle-after-error", { handoff: job.handoff })
      return
    }
    s.pending = null // taken now: one compaction per request, whatever happens next
    s.running = true
    try {
      await compact(s, job)
    } finally {
      s.running = false
    }
  }

  // Which note (if any) goes out now for this session. Updates the cycle state when it returns a note.
  const noteFor = (s: Sess): { kind: "soft" | "strict"; text: string } | undefined => {
    if (s.pct < 0 || s.gaveUp) return undefined
    const l = linesFor(s)
    if (s.pct < l.strict) {
      if (s.softNoted || l.soft >= l.strict || s.pct < l.soft) return undefined
      s.softNoted = true
      return { kind: "soft", text: softText(s.pct, l.strict) }
    }
    if (s.lastNote >= 0 && s.pct < s.lastNote + REMIND_STEP) return undefined
    s.softNoted = true // past the strict line the soft note is moot
    s.lastNote = s.pct
    return { kind: "strict", text: strictText(s.pct, l.strict) }
  }

  const onAssistantMessage = async (info: any) => {
    const s = sess(String(info.sessionID))
    touch(s)
    if (info.summary) return // the compaction's own summary message: its tokens are the whole old context
    const created = Number(info.time?.created ?? 0)
    if (created <= s.floor) return // from before the last compaction
    // recorded before the zero-token return below: an aborted message may carry no tokens
    if (created >= s.newestCreated) {
      s.newestCreated = created
      s.errored = Boolean(info.error)
    }
    const agent = info.agent ?? info.mode
    if (typeof agent === "string" && agent) s.agent = agent
    if (info.providerID) s.providerID = String(info.providerID)
    if (info.modelID) s.modelID = String(info.modelID)
    const t = info.tokens
    const total = (t?.input ?? 0) + (t?.output ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0)
    if (!(total > 0)) return // a message just started: tokens are filled in when its step finishes
    if (created < s.lastCreated) return // an older message arriving late
    const w = await windowFor(s.providerID, s.modelID)
    if (!w) {
      const key = `${s.id}/${s.providerID}/${s.modelID}`
      if (!noWindowLogged.has(key)) {
        noWindowLogged.add(key)
        log(s.id, "no-window", { providerID: s.providerID, modelID: s.modelID })
      }
      return
    }
    s.lastCreated = created
    s.maxCreated = Math.max(s.maxCreated, created)
    s.pct = (total / w.size) * 100
    if (s.floorNext) {
      s.floorNext = false
      s.pctFloor = s.pct
      s.floorNoted = false
    }
  }

  // One log line a floor, one toast a session, when the floor moves a line.
  const noteFloor = async (s: Sess) => {
    const l = linesFor(s)
    if (s.floorNoted || s.pctFloor < 0 || (l.soft === cfg.soft && l.strict === cfg.strict)) return
    s.floorNoted = true
    log(s.id, "high-floor", { floor: Math.round(s.pctFloor), soft: Math.round(l.soft), strict: Math.round(l.strict) })
    if (s.floorWarned) return
    s.floorWarned = true
    const next = Math.round(l.soft < l.strict ? l.soft : l.strict)
    await toast(
      `context was still at ${Math.round(s.pctFloor)}% right after compacting (this session's fixed part, such as the system prompt, tools and AGENTS.md, takes that much), so the next note waits for ${next}%`,
      "info",
    )
  }

  return {
    tool: {
      [TOOL]: tool({
        description:
          "Compacts this conversation once your turn ends, then sends you a message to continue. Call it only after everything " +
          "needed to pick the work up again is saved to a handoff file. After calling it, end your turn at once: " +
          "no more tool calls and no more text. Main conversation only.",
        args: {
          handoff: tool.schema.string().describe("Path of the handoff file you just saved."),
          keep: tool.schema
            .string()
            .optional()
            .describe("What the compaction summary must keep: the task, the next step, open decisions."),
        },
        async execute(args, context) {
          const s = sess(context.sessionID)
          touch(s)
          if (await isChild(s)) return "Only the main conversation can compact itself; a subagent cannot."
          const handoff = String(args.handoff ?? "").trim()
          if (!handoff) return "Save everything first (a short handoff file), then call again with the handoff file path."
          const keep = String(args.keep ?? "").trim() || "the current task and its next step"
          s.pending = { handoff, keep, percent: s.pct }
          s.gaveUp = false // a call of the model's own is a fresh try
          log(s.id, "queued", { handoff, percent: Math.round(s.pct) })
          return QUEUED_RESULT
        },
      }),
    },

    async event({ event }) {
      try {
        const ev: any = event
        const p = ev.properties
        switch (ev.type) {
          case "message.updated":
            if (p?.info?.role === "assistant") await onAssistantMessage(p.info)
            break
          case "session.created":
            if (p?.info?.id) sess(String(p.info.id)).child = Boolean(p.info.parentID)
            break
          case "session.idle":
            if (p?.sessionID) await onIdle(String(p.sessionID))
            break
          case "session.status":
            if (p?.status?.type === "idle" && p?.sessionID) await onIdle(String(p.sessionID))
            break
          case "session.compacted": {
            const s = sessions.get(String(p?.sessionID))
            if (!s) break
            if (!s.running) log(s.id, "compacted-elsewhere", {}) // OpenCode's own auto-compaction, or a typed /compact
            resetCycle(s)
            s.gaveUp = false
            s.pending = null
            break
          }
        }
      } catch (err) {
        // fail open: a broken hook must never disturb the session
        log("plugin", "event-error", { error: String(err).slice(0, 300) })
      }
    },

    async "tool.execute.after"(input, output) {
      try {
        if (input.tool === TOOL) return
        const s = sess(input.sessionID)
        touch(s)
        if (await isChild(s)) return
        if (s.pending) {
          output.output = `${output.output ?? ""}\n\n${QUEUED_NOTE}`
          return
        }
        if (s.pct >= 0 && !s.gaveUp) await noteFloor(s)
        const note = noteFor(s)
        if (!note) return
        const l = linesFor(s)
        log(s.id, "note", { which: note.kind, percent: Math.round(s.pct), soft: Math.round(l.soft), strict: Math.round(l.strict) })
        output.output = `${output.output ?? ""}\n\n${note.text}`
      } catch (err) {
        log("plugin", "hook-error", { error: String(err).slice(0, 300) })
      }
    },

    // The `keep` text goes to the summary, through the compaction prompt hook (summarize has no instructions field).
    async "experimental.session.compacting"(input, output) {
      try {
        const job = sessions.get(input.sessionID)?.job
        if (!job) return
        output.context.push(instructionsFor(job))
        log(input.sessionID, "keep-passed", { handoff: job.handoff })
      } catch {
        // fail open
      }
    },
  }
}

export default { id: "compact-when-ready-opencode", server }
