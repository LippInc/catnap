import type { PluginOptions, Register, Timer } from 'claude-code'

// self-compact: Claude compacts its own conversation at a clean break, then carries on by itself.
// Two lines on the context window:
// - SOFT (soft_percent, 50 by default): one note on a tool result: plan a compaction at a comfortable moment, i.e.
//   finish the piece you are on properly (a page, a section), start nothing big, then save, compact_now and end the turn.
// - STRICT (strict_percent, 60 by default): the strict note, repeated every REMIND_STEP points: save everything now,
//   call compact_now and end the turn. If a turn ends past this line without compact_now, the mod asks for it with a
//   prompt of its own.
// "Save" is the save_step option when it is set (a command such as /save-before-compact), else a plain instruction to
// write a handoff file. When a turn that called compact_now ends, this mod compacts the session and queues a prompt
// that makes the model continue. Claude Code's own auto-compact stays as the backstop and still compacts mid-turn.
// How it compacts: $.session.compact between turns. A host that refuses that call (the desktop app's Code tab runs the
//   engine as an SDK session: "not available in a headless (-p / SDK) session", seen live 2026-10-13) gets a
//   /compact run through $.command.run instead (also after FALLBACK_AFTER refusals of any kind; a plugin's prompt may
//   not begin with /); the session.compact hook, or else the command's end, marks it landed and the continue follows.
//   If neither works the mod gives up for the cycle: a toast, the queued state cleared, no notes or asks until a
//   compaction lands some other way (auto-compact, a typed /compact).
//
// State folder = <state>/self-compact, <state> = CLAUDE_STATE_DIR, else ~/.claude/state.
// Config: the userConfig options (soft_percent, strict_percent, save_step), then config.json in the state folder
//   ({"soft": 50, "threshold": 60, "off": false}, re-read on every check, no reload needed), then a per-session
//   <session id>.config.json beside it; each later one wins. A soft line at or above the strict line is off.
// Pending flag: <session id>.json = {"pending": true, ...}. A Stop hook of yours that keeps a turn going should stay
//   silent while it is fresh, so the turn really ends and the compaction can run.
// Log: <session id>.log.json, the last 60 events; written only for sessions that draw or did something.
// Acts only where something draws (the app or a terminal): a plain -p run is untouched, and so is any process with
//   SELF_COMPACT_OFF set (or the author's wrapper markers CLAUDE_DELEGATE_LEG / CLAUDE_HARNESS_PROBE).
// Deferred work (the compaction, the prompts) runs on one timer started in session.start: $ is only ever spelled at
// its call site inside a hook, so the deferred steps are flags this timer picks up.

const TOOL = 'compact_now'
const DEFAULT_SOFT = 50
const DEFAULT_THRESHOLD = 60
const REMIND_STEP = 2 // percentage points between repeated mid-turn notes
const ASK_STEP = 5 // percentage points before an ignored turn-end ask is repeated
const TICK_MS = 1500 // how often the timer looks for deferred work
const FALLBACK_AFTER = 3 // direct compactions refused in a row before /compact is run instead
const SLASH_TIMEOUT_MS = 10 * 60_000 // a /compact run that has not landed by then is given up on
// $.session.compact's refusal where only a /compact run can compact (the desktop app, live 2026-10-13)
export const isHeadlessRefusal = (err: unknown) => /not available in a headless/i.test(String(err))

type Config = { soft: number; threshold: number; off: boolean }
type Job = { handoff: string; keep: string; percent: number }

export const stateDirFor = (stateEnv: string | undefined, home: string | undefined): string => {
  const base = stateEnv || (home ? `${home}/.claude/state` : '')
  return base ? `${base.split('\\').join('/').replace(/\/+$/, '')}/self-compact` : ''
}

const percentOption = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 && n < 100 ? n : fallback
}

// The userConfig options as the base config, and the save step (empty: a plain "write a handoff file").
export const fromOptions = (options: PluginOptions | undefined): { base: Config; save: string } => ({
  base: {
    soft: percentOption(options?.soft_percent, DEFAULT_SOFT),
    threshold: percentOption(options?.strict_percent, DEFAULT_THRESHOLD),
    off: false,
  },
  save: typeof options?.save_step === 'string' ? options.save_step.trim() : '',
})

export const parseConfig = (texts: readonly (string | null)[], base?: Config): Config => {
  const c: Config = base ? { ...base } : { soft: DEFAULT_SOFT, threshold: DEFAULT_THRESHOLD, off: false }
  for (const text of texts) {
    if (!text) continue
    try {
      const j = JSON.parse(text) as { soft?: unknown; threshold?: unknown; off?: unknown } | null
      if (typeof j?.soft === 'number' && j.soft > 0 && j.soft < 100) c.soft = j.soft
      if (typeof j?.threshold === 'number' && j.threshold > 0 && j.threshold < 100) c.threshold = j.threshold
      if (typeof j?.off === 'boolean') c.off = j.off
    } catch {
      // a broken config file is ignored, the defaults stand
    }
  }
  return c
}

// How to save, in the notes: the save_step command when one is set, else a plain handoff file.
const saveHow = (save: string): string =>
  save
    ? `run ${save} (it writes the handoff file and anything else not yet saved)`
    : 'write a handoff file, or update the one this project already uses: the task, what is done, the next step, open decisions and the files that matter'

const saveShort = (save: string): string => (save ? `run ${save}` : 'save the handoff file')

const steps = (tool: string, save: string): string =>
  [
    '1. Finish only the step you are on; start nothing new.',
    `2. Save everything a fresh start would need: ${saveHow(save)}.`,
    `3. Call ${tool} with that handoff file's path and what the summary must keep (the task, the next step, open decisions).`,
    '4. End your reply right there: no more tool calls and no closing summary. The compaction runs once your turn ends, and a message then tells you to continue.',
  ].join('\n')

export const softText = (p: number, t: number, tool: string, save = '') =>
  [
    `[self-compact] Context is at ${p}% of the window. Compact at a comfortable moment before ${t}%, where you will be told to compact at once:`,
    '- Finish the piece you are on, and finish it properly (for example the page, section or feature: done, checked, saved). Do not start the next big piece before compacting.',
    `- At that clean break: ${saveShort(save)}, call ${tool} with the handoff file's path and what the summary must keep, then end your reply.`,
    '- If your reply is ending anyway (the work is done, or you are waiting on the user), that is a good moment too.',
  ].join('\n')

export const noteText = (p: number, t: number, tool: string, save = '') =>
  `[self-compact] Context is at ${p}% of the window (the line is ${t}%). Save and compact now; do not wait for a better moment. In this order:\n${steps(tool, save)}`

export const askText = (p: number, t: number, tool: string, save = '') =>
  `[self-compact] Your last turn ended with context at ${p}% of the window (the line is ${t}%). Compact before anything else, in this order:\n${steps(tool, save)}`

const QUEUED_NOTE =
  '[self-compact] Compaction is queued. End your reply now: no more tool calls and no more text. It runs as soon as the turn ends, and a message then tells you to continue.'

const continueText = (job: Job) =>
  `[self-compact] The conversation was just compacted at your request (context had reached ${job.percent}%). ` +
  `Your handoff: ${job.handoff}. Read it first, then carry on exactly where you left off, with the next step it names. ` +
  'If the work was finished, or you were waiting on the user, say in a line or two where things stand and stop; do not start new work.'

const instructionsFor = (job: Job) =>
  `Keep what the next turn needs to continue: ${job.keep}. The full state is saved in ${job.handoff}; name that path in the summary.`

export const register: Register = (on, options) => {
  const { base, save } = fromOptions(options)
  let toolName = `mcp__self-compact__${TOOL}`
  let stateDir = ''
  let sid = ''
  let pending: Job | null = null // compact_now was called; runs when the turn ends
  let due = false // the turn ended: the timer may compact now
  let ask: string | null = null // a turn-end ask the timer submits
  let softNoted = false // the soft note went out this cycle
  let lastNote = -1 // percent at the last mid-turn note
  let lastAsk = -1 // percent at the last turn-end ask
  let busy = false
  let retries = 0
  let flagDirty = false // the pending flag file needs rewriting
  let useSlash = false // this host refuses $.session.compact: compact with a /compact run
  let slashJob: Job | null = null // a /compact run went out for this job and has not landed yet
  let slashAt = 0
  let landedJob: Job | null = null // its compaction landed: the timer sends the continue prompt
  let gaveUp = false // compacting failed this cycle: no notes or asks until a compaction lands some other way
  let toast: string | null = null // a toast the timer shows
  let timer: Timer | undefined
  const events: Record<string, unknown>[] = []
  let logDirty = false
  let logWorthy = false // a session that draws, or did something: only then does its log go to disk

  const log = (kind: string, data: Record<string, unknown> = {}) => {
    events.push({ at: new Date().toISOString(), kind, ...data })
    if (events.length > 60) events.splice(0, events.length - 60)
    if (kind !== 'start') logWorthy = true
    logDirty = true
  }
  const configPaths = () => [`${stateDir}/config.json`, `${stateDir}/${sid}.config.json`]
  const flagBody = () =>
    JSON.stringify({ pending: pending !== null, at: new Date().toISOString(), handoff: pending?.handoff ?? null })
  const reset = () => {
    if (pending) flagDirty = true
    pending = null
    due = false
    ask = null
    softNoted = false
    lastNote = -1
    lastAsk = -1
    retries = 0
    slashJob = null
    gaveUp = false
  }
  const giveUp = (reason: string) => {
    log('gave-up', { reason })
    toast = `self-compact could not compact this chat (${reason}). The automatic compaction still applies.`
    reset()
    gaveUp = true
  }

  on('session.start', async ($, e, next) => {
    toolName = `mcp__${$.plugin.name}__${TOOL}`
    // SELF_COMPACT_OFF, or the author's wrapper markers (each name spelled out: the engine lists what a mod reads)
    const isWrapperChild =
      (await $.env.get('SELF_COMPACT_OFF')) !== undefined ||
      (await $.env.get('CLAUDE_DELEGATE_LEG')) !== undefined ||
      (await $.env.get('CLAUDE_HARNESS_PROBE')) !== undefined
    // an empty state folder switches every check off: the tool still answers, nothing is ever injected or asked
    stateDir = isWrapperChild
      ? ''
      : stateDirFor(await $.env.get('CLAUDE_STATE_DIR'), (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')))
    sid = await $.session.id()
    if (stateDir) {
      // a reload starts the module over: keep this session's log, and drop a queued flag the old module left behind
      try {
        const old = JSON.parse((await $.fs.read(`${stateDir}/${sid}.log.json`)) ?? '[]') as unknown
        if (Array.isArray(old) && events.length === 0) {
          events.push(...(old as Record<string, unknown>[]).slice(-59))
          logWorthy = true
        }
      } catch {
        // no log yet
      }
      try {
        const flag = JSON.parse((await $.fs.read(`${stateDir}/${sid}.json`)) ?? '{}') as { pending?: unknown } | null
        if (flag?.pending === true) flagDirty = true
      } catch {
        // no flag yet
      }
    }
    await $.tool.register({
      name: TOOL,
      description:
        'Compacts this conversation once your turn ends, then sends you a message to continue. Call it only after everything ' +
        `needed to pick the work up again is saved to files (${save ? `normally by ${save}` : 'a handoff file'}). After calling it, ` +
        'end your reply at once: no more tool calls and no more text. Main conversation only.',
      inputSchema: {
        type: 'object',
        properties: {
          handoff: { type: 'string', description: 'Path of the handoff file you just saved.' },
          keep: { type: 'string', description: 'What the compaction summary must keep: the task, the next step, open decisions.' },
        },
        required: ['handoff', 'keep'],
      },
      isDeferred: false,
    })
    const surfaces = [...(await $.session.surfaces())]
    if (surfaces.length > 0) logWorthy = true
    log('start', { surfaces, root: $.plugin.root, stateDir, isWrapperChild })

    const tick = async () => {
      if (busy) return
      busy = true
      try {
        if (stateDir && flagDirty) {
          flagDirty = false
          await $.fs.write(`${stateDir}/${sid}.json`, flagBody())
        }
        if (ask !== null) {
          const text = ask
          ask = null
          log('ask-submitted')
          void $.prompt.submit({ text })
        }
        if (slashJob && (await $.clock.now()) - slashAt > SLASH_TIMEOUT_MS) giveUp('/compact did not compact within 10 minutes')
        if (due && pending && !slashJob) {
          const job = pending
          let viaSlash = useSlash
          if (!viaSlash) {
            try {
              const res = await $.session.compact({ instructions: instructionsFor(job) })
              reset()
              if ('skip' in res && res.skip !== undefined) {
                log('skipped', { reason: res.skip })
                toast = `self-compact: the compaction was skipped (${res.skip})`
              } else {
                log('compacted', { tokensBefore: res.tokensBefore, tokensAfter: res.tokensAfter })
                landedJob = job
              }
            } catch (err) {
              // refused: this host never compacts directly (learned for the session), or a turn runs; a /compact
              // prompt waits for the session to be idle, so it covers both
              retries += 1
              const headless = isHeadlessRefusal(err)
              if (headless || retries >= FALLBACK_AFTER) {
                if (headless) useSlash = true
                viaSlash = true
                log('slash-fallback', { attempts: retries, error: String(err).slice(0, 200) })
              } else {
                log('retry', { attempt: retries, error: String(err).slice(0, 200) })
              }
            }
          }
          if (viaSlash) {
            slashJob = job
            slashAt = await $.clock.now()
            due = false
            log('slash-submitted')
            // runs as if typed, once the session is idle; a plugin's prompt may not begin with / (host check)
            void $.command.run({ command: 'compact', args: instructionsFor(job) }).then(
              res => {
                // normally the session.compact hook saw it land first; if not, the finished command stands for it
                if (slashJob !== job) return
                reset()
                landedJob = job
                log('compacted', { via: 'command-result', text: String(res.text ?? '').slice(0, 200) })
              },
              err => {
                if (slashJob === job) giveUp(`/compact was refused: ${String(err).slice(0, 160)}`)
              },
            )
          }
        }
        if (landedJob) {
          const job = landedJob
          landedJob = null
          void $.prompt.submit({ text: continueText(job) })
          log('continue-submitted')
        }
        if (toast !== null) {
          const text = toast
          toast = null
          $.ui.toast(text)
        }
        if (stateDir && flagDirty) {
          flagDirty = false
          await $.fs.write(`${stateDir}/${sid}.json`, flagBody())
        }
        if (stateDir && logDirty && logWorthy) {
          logDirty = false
          await $.fs.write(`${stateDir}/${sid}.log.json`, JSON.stringify(events, null, 1))
        }
      } catch {
        // never let the timer die on a failed write
      } finally {
        busy = false
      }
    }
    timer?.cancel() // a reload starts a fresh module, but a second session.start in one load must not double the timer
    timer = $.clock.every(TICK_MS, () => void tick())
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === toolName) {
      if (e.agentId) return { deny: 'Only the main conversation can compact itself; a subagent cannot.' }
      const input = e as unknown as { handoff?: unknown; keep?: unknown }
      const handoff = String(input.handoff ?? '').trim()
      const keep = String(input.keep ?? '').trim()
      if (!handoff) return { deny: `Save everything first (${saveShort(save)}), then call again with the handoff file path.` }
      pending = { handoff, keep: keep || 'the current task and its next step', percent: (await $.session.usage()).context.percent ?? -1 }
      due = false
      retries = 0
      gaveUp = false // a call of the model's own is a fresh try
      flagDirty = true
      log('queued', { handoff, percent: pending.percent })
      return {
        result:
          'Compaction queued. End your reply now: write nothing more and call no more tools. ' +
          'The conversation is compacted as soon as this turn ends, and a message then tells you to continue.',
      }
    }
    const r = await next(e)
    if (e.agentId || r.deny !== undefined) return r
    if (pending) return { ...r, context: [...(r.context ?? []), QUEUED_NOTE] }
    if (gaveUp || !stateDir || (await $.session.surfaces()).length === 0) return r
    const c = parseConfig(await Promise.all(configPaths().map(p => $.fs.read(p).catch(() => null))), base)
    if (c.off) return r
    const pct = (await $.session.usage()).context.percent
    if (pct === undefined) return r
    if (pct < c.threshold) {
      // the soft line: one note per cycle, then quiet until the strict line
      if (softNoted || c.soft >= c.threshold || pct < c.soft) return r
      softNoted = true
      log('soft-note', { percent: pct, soft: c.soft, threshold: c.threshold })
      return { ...r, context: [...(r.context ?? []), softText(pct, c.threshold, toolName, save)] }
    }
    if (lastNote >= 0 && pct < lastNote + REMIND_STEP) return r
    softNoted = true // past the strict line the soft note is moot
    lastNote = pct
    log('note', { percent: pct, threshold: c.threshold })
    return { ...r, context: [...(r.context ?? []), noteText(pct, c.threshold, toolName, save)] }
  }).catch(($, e, next) => next(e)) // fail open: a broken note never blocks a tool

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    sid = await $.session.id()
    if (pending) {
      // interrupted or errored: stay queued, it runs at the next turn that ends normally
      if (e.reason === 'answer') {
        due = true
        retries = 0
        log('due')
      }
      return r
    }
    if (gaveUp || e.reason !== 'answer' || !stateDir || (await $.session.surfaces()).length === 0) return r
    const c = parseConfig(await Promise.all(configPaths().map(p => $.fs.read(p).catch(() => null))), base)
    if (c.off) return r
    const pct = (await $.session.usage()).context.percent
    if (pct === undefined || pct < c.threshold) return r
    if (lastAsk >= 0 && pct < lastAsk + ASK_STEP) return r
    lastAsk = pct
    ask = askText(pct, c.threshold, toolName, save)
    log('ask', { percent: pct, threshold: c.threshold })
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    const landed = !('skip' in r && r.skip !== undefined)
    if (!e.agentId && slashJob && (e.trigger === 'manual' || e.trigger === 'plugin')) {
      // the /compact this mod ran: on landing the timer sends the continue prompt
      const job = slashJob
      if (landed) {
        reset()
        landedJob = job
        log('compacted', { via: 'prompt', trigger: e.trigger, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter })
      } else {
        const reason = 'skip' in r && r.skip !== undefined ? String(r.skip) : 'skipped'
        reset()
        log('skipped', { via: 'prompt', reason })
        $.ui.toast(`self-compact: the compaction was skipped (${reason})`)
      }
      return r
    }
    if (!e.agentId && landed && (e.trigger === 'auto' || e.trigger === 'manual')) {
      // the backstop or the user compacted: whatever was queued is done, start the note cycle over
      reset()
      log('compacted-elsewhere', { trigger: e.trigger })
    }
    return r
  }).catch(($, e, next) => next(e)) // fail open: never block a compaction

  on('session.end', async ($, e, next) => {
    reset()
    return next(e)
  })
}
