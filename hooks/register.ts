import type { PluginOptions, Register, Timer } from 'claude-code'

// catnap (formerly compact-when-ready): Claude compacts its own conversation at a clean break, then carries on by itself.
// Two lines on the context window:
// - SOFT (soft_percent, 50 by default): one note on a tool result: plan a compaction at a comfortable moment, i.e.
//   finish the piece you are on properly (a page, a section), start nothing big, then save, compact_now and end the turn.
// - STRICT (strict_percent, 60 by default): the strict note, repeated every REMIND_STEP points: save everything now,
//   call compact_now and end the turn. If a turn ends past this line without compact_now, the mod asks for it with a
//   prompt of its own.
// - AUTO (auto_percent, 70 by default): Claude Code's own auto-compact, the backstop that still compacts mid-turn.
//   The mod sets CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in its own process to this value (the engine reads the variable at
//   each check: moved 70->7 and 7->12 at runtime, live 2026-10-17), so the mod's setting wins over one from the
//   settings files, which stays as the fallback when the mod is off. 0 leaves Claude Code's own setting alone; off
//   (config.json) or 0 puts back what the process had before the mod first set it (kept in CATNAP_AUTO_ORIG,
//   so a reload still knows it). Only in a person's session, like the notes.
// "Save" is the save_step option when it is set (a command such as /save-before-compact, which writes a handoff file
// whose path Claude passes to compact_now), else Claude passes its handoff to compact_now itself, as `note`: one call
// instead of a file write plus the call. When a turn that called compact_now ends, this mod compacts the session and
// queues a prompt that makes the model continue, with the handoff's text in it (the note, or the file read back, cut
// at PASTE_MAX). Asking Claude to read the file was not enough: in 10 of 10 compactions of a 2026-10-18 benchmark it
// carried on from the compaction summary and never opened it.
// The model request that would follow compact_now in its turn could only end the reply (the tool result says so), yet
// it re-reads the whole context; a turn.step hook answers that one request itself with a one-line reply, so the turn
// ends at once. Only that turn's next request in the main loop, once.
// The notes and the tool ask for compact_now in the same response as Claude's last action (for example the command
//   that runs the tests), not in a reply of its own, which re-reads the whole context for that one call: up to 0.3.7
//   compact_now came alone in every benchmark nap, right after a call that wrote files and ran the tests (102-108K
//   tokens a nap on a 200K window, 498-512K on 1M). The handoff is then written before that action's result is seen,
//   so its next step starts with checking it. In 6 runs on 200K (2026-10-19), 10 of 11 naps rode along.
// Below the line (the soft one, or the strict one when the soft line is off) compact_now waits for the note: called
//   on Claude's own it is refused, unless the person's latest prompt asks for a compaction (/catnap:compact, or words
//   like "compact now"). On a 1M window Claude otherwise napped at clean breaks long before 50%: 23 of 28 naps in a
//   2026-10-19 benchmark, at 12-47%, one run every ~20 tickets. Only in a person's session, like the notes.
// How it compacts: $.session.compact between turns. A host that refuses that call (the desktop app's Code tab runs the
//   engine as an SDK session: "not available in a headless (-p / SDK) session", seen live 2026-10-13) gets a
//   /compact run through $.command.run instead (also after FALLBACK_AFTER refusals of any kind; a plugin's prompt may
//   not begin with /); the session.compact hook, or else the command's end, marks it landed and the continue follows.
//   If neither works the mod gives up for the cycle: a toast, the queued state cleared, no notes or asks until a
//   compaction lands some other way (auto-compact, a typed /compact).
// A compaction the mod did not run (auto-compact, a typed /compact) starts the note cycle over. The session.compact
//   hook reports it, except where Claude Code's built-in sec-default mod is seated (managed settings, or a Team or
//   Enterprise organization), which holds that hook back from a person's mods since 2.1.299
//   (anthropics/claude-code#102134). The fallback: context that falls DROP_POINTS or more between two checks, with no
//   compaction of the mod's own queued or running, was compacted some other way.
// After any compaction the first percent seen is the floor: for that cycle both lines sit at least FLOOR_GAIN points
//   above it (logged once a cycle, one toast a session when that moves a line), so a session whose fixed part is near
//   the lines is not asked to compact again and again. The auto line stays as set.
//
// State folder = <state>/catnap (NAME), <state> = CLAUDE_STATE_DIR, else ~/.claude/state.
// Config: the userConfig options (soft_percent, strict_percent, auto_percent, save_step), then config.json in the state
//   folder ({"soft": 50, "threshold": 60, "auto": 70, "off": false}, re-read on every check, no reload needed), then a
//   per-session <session id>.config.json beside it; each later one wins. A soft line at or above the strict line is off;
//   an auto line at or below the strict line gets one toast, since auto-compact then runs before the mod can ask.
// Pending flag: <session id>.json = {"pending": true, ...}. A Stop hook of yours that keeps a turn going should stay
//   silent while it is fresh, so the turn really ends and the compaction can run.
// Log: <session id>.log.json, the last 60 events; written only for a person's session or one that did something.
// Acts only in a person's session: one where something draws (a terminal), or a desktop app chat. The app runs the
//   engine as an SDK session whose surface list is empty until a window attaches and can empty again mid-turn (a long
//   turn there crossed 50% and 60% with no note, live 2026-10-17), so its chats are known by CLAUDE_CODE_ENTRYPOINT =
//   claude-desktop instead. A `claude -p` started from inside such a chat inherits that entry point, but also CLAUDECODE
//   and CLAUDE_CODE_CHILD_SESSION, which the engine sets only for the processes it starts (its own nested-session
//   test); with either one set it is not a person's session. A plain -p run is untouched, and so is any process with
//   CATNAP_OFF set, or the old COMPACT_WHEN_READY_OFF (or the author's wrapper markers CLAUDE_DELEGATE_LEG / CLAUDE_HARNESS_PROBE).
// Deferred work (the compaction, the prompts) runs on one timer started in session.start: $ is only ever spelled at
// its call site inside a hook, so the deferred steps are flags this timer picks up.

// The plugin's name (.claude-plugin/plugin.json "name"). The default tool name, the state folder and the "[NAME]" prefix
// of every note are built from it. The ONE exception is the tool.call matcher further down, which has to be a regex
// literal: `claude plugin validate` and the directory's checks read it statically and show tool=? for anything built at
// run time. So a rename touches two places: this line and that literal. hooks/catnap.test.ts fails if they disagree
// with each other or with plugin.json (the notes tell Claude the name the engine gives the plugin, and the test calls
// that name and expects the mod to answer).
export const NAME = 'catnap'
const TOOL = 'compact_now'
// the tool's full name as the engine registers it for a plugin of that name
export const toolNameFor = (plugin: string): string => `mcp__${plugin}__${TOOL}`
const DEFAULT_SOFT = 50
const DEFAULT_THRESHOLD = 60
const DEFAULT_AUTO = 70
const REMIND_STEP = 2 // percentage points between repeated mid-turn notes
const ASK_STEP = 5 // percentage points before an ignored turn-end ask is repeated
const TICK_MS = 1500 // how often the timer looks for deferred work
const FALLBACK_AFTER = 3 // direct compactions refused in a row before /compact is run instead
const SLASH_TIMEOUT_MS = 10 * 60_000 // a /compact run that has not landed by then is given up on
// a fall this big between two checks is a compaction: a cycle only has state from the soft line (50%) on, and a
// compaction leaves a few percent (live: 257K->29K, 531K->28K, 66K->7K tokens; on 2.1.302 an auto-compact went from
// 38% to 8% at the next check, the messages it keeps included), while plain work only adds context
const DROP_POINTS = 20
// how far above the floor the lines sit at least: a compaction normally leaves a few percent, so the lines stand as
// set; where the session's fixed part (system prompt, tools, CLAUDE.md) is itself near the lines, a compaction frees
// almost nothing and each note would ask for another one (live 2026-10-18: a 90K-token CLAUDE.md on a 200K window left
// 50-51% after each compaction, and Claude compacted twice in under a minute and queued a third)
const FLOOR_GAIN = 10
// the most of a handoff the continue prompt carries (about 8K tokens); a longer one is cut there, and the prompt says
// where the rest is
export const PASTE_MAX = 32_000
// $.session.compact's refusal where only a /compact run can compact (the desktop app, live 2026-10-13)
export const isHeadlessRefusal = (err: unknown) => /not available in a headless/i.test(String(err))
// Where a prompt comes from when a person sent it: typed at the terminal, through Remote Control, or as the SDK host's
// turn (the desktop app's chats, `claude -p`). A plugin's prompt (catnap's own continue and ask) or a notification is
// not the person asking.
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'unclassified'])
// A prompt that asks for a compaction: /catnap:compact, a typed /compact line, "compact now", "take a nap" ("catnap"
// alone is not one)
export const asksToCompact = (text: string) => /\bcompact|\bnap\b/i.test(text)

type Config = { soft: number; threshold: number; auto: number; off: boolean; fresh: boolean }
// handoff: the file it is saved in ('' when there is none); note: the handoff text Claude passed itself ('' when it
// passed a path only)
type Job = { handoff: string; note: string; keep: string; percent: number }

export const stateDirFor = (stateEnv: string | undefined, home: string | undefined): string => {
  const base = stateEnv || (home ? `${home}/.claude/state` : '')
  return base ? `${base.split('\\').join('/').replace(/\/+$/, '')}/${NAME}` : ''
}

// A line in percent: above 0 and below 100 (lowest = 0 for the auto line, where 0 means "leave it alone").
const percentOption = (v: unknown, fallback: number, lowest = 1): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) && n >= lowest && n < 100 ? n : fallback
}

// The userConfig options as the base config, and the save step (empty: a plain "write a handoff file").
export const fromOptions = (options: PluginOptions | undefined): { base: Config; save: string } => ({
  base: {
    soft: percentOption(options?.soft_percent, DEFAULT_SOFT),
    threshold: percentOption(options?.strict_percent, DEFAULT_THRESHOLD),
    auto: percentOption(options?.auto_percent, DEFAULT_AUTO, 0),
    off: false,
    fresh: options?.fresh_start === true,
  },
  save: typeof options?.save_step === 'string' ? options.save_step.trim() : '',
})

export const parseConfig = (texts: readonly (string | null)[], base?: Config): Config => {
  const c: Config = base ? { ...base } : { soft: DEFAULT_SOFT, threshold: DEFAULT_THRESHOLD, auto: DEFAULT_AUTO, off: false, fresh: false }
  for (const text of texts) {
    if (!text) continue
    try {
      const j = JSON.parse(text) as { soft?: unknown; threshold?: unknown; auto?: unknown; off?: unknown; fresh?: unknown } | null
      if (typeof j?.soft === 'number' && j.soft > 0 && j.soft < 100) c.soft = j.soft
      if (typeof j?.threshold === 'number' && j.threshold > 0 && j.threshold < 100) c.threshold = j.threshold
      if (typeof j?.auto === 'number' && j.auto >= 0 && j.auto < 100) c.auto = j.auto
      if (typeof j?.off === 'boolean') c.off = j.off
      if (typeof j?.fresh === 'boolean') c.fresh = j.fresh
    } catch {
      // a broken config file is ignored, the defaults stand
    }
  }
  return c
}

// What CLAUDE_AUTOCOMPACT_PCT_OVERRIDE should hold under this config: the auto line, or, when the mod is off or the
// line is 0, what the process had before the mod first set it ('' = it was unset).
export const autoTarget = (c: Config, orig: string): { value: string | undefined; restore: boolean } =>
  c.off || c.auto === 0 ? { value: orig === '' ? undefined : orig, restore: true } : { value: String(c.auto), restore: false }

// How to save, in the notes: the save_step command when one is set (it writes a handoff file), else the handoff goes
// straight into compact_now's `note`.
const HANDOFF_PARTS = 'the task, what is done, the next step, open decisions and the files that matter'
const saveHow = (save: string): string =>
  save
    ? `run ${save} (it writes the handoff file and anything else not yet saved)`
    : `write your handoff (${HANDOFF_PARTS}) straight into the note of the compaction call below; no separate file is needed`

const saveShort = (save: string): string => (save ? `run ${save}` : 'write your handoff')

// What compact_now gets: the handoff file's path when a save step wrote one, else the handoff itself as `note`.
const callWith = (save: string): string =>
  save ? "that handoff file's path as handoff" : 'your handoff as note'

// compact_now in the same response as the last action (see the header); `what` names that action
const alongside = (what: string): string =>
  `Make that call in the same response as ${what} (for example the command that runs the tests), as its last tool call, ` +
  'not in a reply of its own: a reply of its own reads the whole conversation once more. ' +
  "You will not see that action's result before the compaction, so your handoff's next step starts with checking it."

const steps = (tool: string, save: string): string =>
  [
    '1. Finish only the step you are on; start nothing new.',
    `2. Save everything a fresh start would need: ${saveHow(save)}.`,
    `3. Call ${tool} with ${callWith(save)}, and what the summary must keep (the task, the next step, open decisions) as keep. ` +
      `${alongside("the step's last action")} If the step is already done, call it now.`,
    '4. End your reply right there: no more tool calls and no closing summary. The compaction runs once your turn ends, and a message then gives you your handoff back and tells you to continue.',
  ].join('\n')

export const softText = (p: number, t: number, tool: string, save = '') =>
  [
    `[${NAME}] Context is at ${p}% of the window. Compact at a comfortable moment before ${t}%, where you will be told to compact at once:`,
    '- Finish the piece you are on, and finish it properly (for example the page, section or feature: done, checked, saved). Do not start the next big piece before compacting.',
    `- At that clean break: ${saveShort(save)}, call ${tool} with ${callWith(save)} and what the summary must keep, then end your reply.`,
    `- ${alongside("the piece's last action")}`,
    '- If your reply is ending anyway (the work is done, or you are waiting on the user), that is a good moment too.',
  ].join('\n')

export const noteText = (p: number, t: number, tool: string, save = '') =>
  `[${NAME}] Context is at ${p}% of the window (the line is ${t}%). Save and compact now; do not wait for a better moment. In this order:\n${steps(tool, save)}`

export const askText = (p: number, t: number, tool: string, save = '') =>
  `[${NAME}] Your last turn ended with context at ${p}% of the window (the line is ${t}%). Compact before anything else, in this order:\n${steps(tool, save)}`

// compact_now's answer below the line, when the person has not asked for a compaction
export const earlyText = (p: number, line: number, tool: string) =>
  `Not yet: context is at ${p}% of the window, below catnap's line (${line}%). Carry on with the work; a [${NAME}] note ` +
  `will tell you when to compact. Don't call ${tool} again before then, unless the person asks for a compaction.`

const QUEUED_NOTE =
  `[${NAME}] Compaction is queued. End your reply now: no more tool calls and no more text. It runs as soon as the turn ends, and a message then tells you to continue.`

// The reply catnap gives in Claude's place to the one model request after compact_now (see the header).
export const NAP_REPLY = `[${NAME}] Compacting now; Claude carries on right after.`

const CARRY_ON =
  'Carry on exactly where you left off, with the next step it names. ' +
  'If the work was finished, or you were waiting on the user, say in a line or two where things stand and stop; do not start new work.'

// The continue prompt. `text` is the handoff to give back (the note, or the file read back); null when the file could
// not be read, and then the prompt names the file, as before 0.3.6. `cut`: the text was cut at PASTE_MAX.
export const continueText = (job: Job, text: string | null, cut = false, fresh = false) => {
  const head = fresh
    ? `[${NAME}] This is a fresh start: the conversation was cleared at your request (context had reached ${job.percent}%), so you have only your handoff.`
    : `[${NAME}] The conversation was just compacted at your request (context had reached ${job.percent}%).`
  if (text === null) return `${head} Your handoff: ${job.handoff}. Read it first, then ${CARRY_ON.charAt(0).toLowerCase()}${CARRY_ON.slice(1)}`
  const saved = job.handoff ? ` (saved in ${job.handoff})` : ''
  const rest = cut ? `\n[cut here at ${PASTE_MAX} characters: read the rest in ${job.handoff} before you go on]` : ''
  return `${head} Here is the handoff you wrote just before it${saved}:\n\n<handoff>\n${text}${rest}\n</handoff>\n\n${CARRY_ON}`
}

const instructionsFor = (job: Job) =>
  `Keep what the next turn needs to continue: ${job.keep}.` +
  (job.handoff ? ` The full state is saved in ${job.handoff}; name that path in the summary.` : '') +
  ' Claude gets its own handoff back, word for word, right after this compaction.'

// The handoff to give back after the compaction: the note, else the file, cut at PASTE_MAX; null when there is no
// note and the file can't be read. A note is cut only when a file holds the whole of it.
export const handoffText = async (job: Job, read: (path: string) => Promise<string | null | undefined>) => {
  let text = job.note
  if (!text) {
    if (!job.handoff) return { text: null, cut: false }
    const got = await read(job.handoff).catch(() => null)
    if (typeof got !== 'string' || got.trim() === '') return { text: null, cut: false }
    text = got.trim()
  }
  if (text.length <= PASTE_MAX || !job.handoff) return { text, cut: false }
  return { text: text.slice(0, PASTE_MAX), cut: true }
}

export const register: Register = (on, options) => {
  const { base, save } = fromOptions(options)
  let toolName = toolNameFor(NAME) // replaced at session.start by the name the engine gives the plugin
  let stateDir = ''
  let sid = ''
  let desktopChat = false // a desktop app chat, not a process started from inside one: acts with no window attached
  let pending: Job | null = null // compact_now was called; runs when the turn ends
  let turnNow = '' // the main loop's running turn, from turn.start
  let napTurn = '' // the turn that called compact_now: the mod answers its next model request (see the header)
  let due = false // the turn ended: the timer may compact now
  let ask: string | null = null // a turn-end ask the timer submits
  let softNoted = false // the soft note went out this cycle
  let lastNote = -1 // percent at the last mid-turn note
  let lastAsk = -1 // percent at the last turn-end ask
  let lastPct = -1 // percent at the last check, for the drop fallback (-1: none since the cycle started)
  let floor = -1 // percent at the first check after the last compaction (-1: none seen yet)
  let floorNext = false // a compaction landed: the next check with a number sets the floor
  let floorNoted = false // this floor's line move is logged
  let floorWarned = false // the toast about a floor near the lines went out (once a session)
  let busy = false
  let retries = 0
  let flagDirty = false // the pending flag file needs rewriting
  let useSlash = false // this host refuses $.session.compact: compact with a /compact run
  let slashJob: Job | null = null // a /compact run went out for this job and has not landed yet
  let slashAt = 0
  let landedJob: Job | null = null // its compaction landed: the timer sends the continue prompt
  let clearJob: Job | null = null // fresh start: a /clear went out for this job and has not landed yet
  let clearAt = 0
  let landedFresh = false // the landed job was a fresh start: the continue prompt says so
  let gaveUp = false // compacting failed this cycle: no notes or asks until a compaction lands some other way
  let personAsked = false // the person's latest prompt asks for a compaction: compact_now is not held to the line
  let toast: string | null = null // a toast the timer shows (the host puts "catnap:" in front)
  let autoOrig = '' // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE before the mod first set it ('' = unset)
  let autoNow: string | undefined // what the variable holds now
  let autoTouched = false // the mod (this module or one before a reload) has set the variable
  let autoWant: { value: string | undefined; restore: boolean } | null = null // what the timer sets it to
  let autoWarned = false
  let autoBroken = false // the host refused a write to the variable: stop trying
  let timer: Timer | undefined
  const events: Record<string, unknown>[] = []
  let logDirty = false
  let logWorthy = false // a person's session, or one that did something: only then does its log go to disk

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
    napTurn = ''
    due = false
    ask = null
    softNoted = false
    lastNote = -1
    lastAsk = -1
    lastPct = -1 // the mod's own compaction, or one the hook reported, is never seen again as a drop
    retries = 0
    slashJob = null
    clearJob = null
    gaveUp = false
    personAsked = false // a compaction landed (or the cycle started over): the ask is done
  }
  const giveUp = (reason: string) => {
    log('gave-up', { reason })
    toast = `could not compact this chat (${reason}). The automatic compaction still applies.`
    reset()
    gaveUp = true
  }
  // The auto line under this config, for the timer to set; one toast when it sits at or below the strict line.
  const wantAuto = (c: Config) => {
    autoWant = autoTarget(c, autoOrig)
    if (autoWant.restore || autoWarned || c.auto > c.threshold) return
    autoWarned = true
    log('auto-below-strict', { auto: c.auto, threshold: c.threshold })
    toast = `auto-compact (${c.auto}%) is at or below the strict line (${c.threshold}%), so it runs before Claude is asked`
  }
  // Each check's percent, for the fallback: a fall of DROP_POINTS or more since the last check, with nothing of the
  // mod's own queued or running, was a compaction the hook did not report. Logged once: the next check compares anew.
  const sawPercent = (pct: number | undefined) => {
    if (pct === undefined) return // none until the first response after a compaction: the next check compares
    if (floorNext) setFloor(pct)
    const before = lastPct
    lastPct = pct
    if (pending || slashJob || before < 0 || pct > before - DROP_POINTS) return
    reset()
    lastPct = pct
    setFloor(pct)
    log('compacted-elsewhere', { via: 'drop', from: before, to: pct })
  }
  const setFloor = (pct: number) => {
    floor = pct
    floorNext = false
    floorNoted = false
  }
  // The lines this cycle: as set, but at least FLOOR_GAIN points above the floor (a soft line lifted to the strict
  // one is off, as when set that way).
  const lifted = (c: Config): Config =>
    floor < 0 ? c : { ...c, soft: Math.max(c.soft, floor + FLOOR_GAIN), threshold: Math.max(c.threshold, floor + FLOOR_GAIN) }
  const noteFloor = (c: Config, l: Config) => {
    if (floorNoted || (l.soft === c.soft && l.threshold === c.threshold)) return
    floorNoted = true
    const next = l.soft < l.threshold ? l.soft : l.threshold
    log('high-floor', { floor, soft: l.soft, threshold: l.threshold })
    if (floorWarned) return
    floorWarned = true
    toast = `context was still at ${floor}% right after compacting (this session's fixed part, such as the system prompt, tools and CLAUDE.md, takes that much), so the next note waits for ${next}%`
  }

  on('session.start', async ($, e, next) => {
    toolName = toolNameFor($.plugin.name)
    // CATNAP_OFF (or its old name COMPACT_WHEN_READY_OFF), or the author's wrapper markers (each name spelled out: the
    // engine lists what a mod reads)
    const isWrapperChild =
      (await $.env.get('CATNAP_OFF')) !== undefined ||
      (await $.env.get('COMPACT_WHEN_READY_OFF')) !== undefined ||
      (await $.env.get('CLAUDE_DELEGATE_LEG')) !== undefined ||
      (await $.env.get('CLAUDE_HARNESS_PROBE')) !== undefined
    // an empty state folder switches every check off: the tool still answers, nothing is ever injected or asked
    stateDir = isWrapperChild
      ? ''
      : stateDirFor(await $.env.get('CLAUDE_STATE_DIR'), (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')))
    sid = await $.session.id()
    desktopChat =
      (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop' &&
      (await $.env.get('CLAUDECODE')) === undefined &&
      (await $.env.get('CLAUDE_CODE_CHILD_SESSION')) === undefined
    // the auto line's starting point; after a reload the marker still holds the value from before the mod's first set
    autoNow = await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')
    const marked = await $.env.get('CATNAP_AUTO_ORIG')
    autoTouched = marked !== undefined
    autoOrig = marked ?? autoNow ?? ''
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
        'Compacts this conversation once your turn ends, then gives you your handoff back and tells you to continue. ' +
        `Use it when a [${NAME}] note asks you to, or when the person asks for a compaction; before that, carry on: ` +
        'the window has room, and the note tells you when. ' +
        (save
          ? `Call it once everything needed to pick the work up again is saved (normally by ${save}), with the handoff file's path. `
          : `Call it with your handoff as note (${HANDOFF_PARTS}); no separate file is needed. `) +
        `${alongside('your last action')} ` +
        'After calling it, end your reply at once: no more tool calls and no more text. Main conversation only.',
      inputSchema: {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            description: `Your handoff, written for yourself right after the compaction: ${HANDOFF_PARTS}. catnap saves it and gives it back to you word for word.`,
          },
          handoff: {
            type: 'string',
            description: 'Path of a handoff file you saved (for example by a save command), if you saved one. catnap gives its text back to you after the compaction.',
          },
          keep: { type: 'string', description: 'What the compaction summary must keep: the task, the next step, open decisions.' },
        },
        required: ['keep'],
      },
      isDeferred: false,
    })
    const surfaces = [...(await $.session.surfaces())]
    if (surfaces.length > 0 || desktopChat) logWorthy = true
    log('start', { surfaces, desktopChat, root: $.plugin.root, stateDir, isWrapperChild, autoNow: autoNow ?? null })
    if (stateDir && (desktopChat || surfaces.length > 0))
      wantAuto(parseConfig(await Promise.all(configPaths().map(p => $.fs.read(p).catch(() => null))), base))

    const tick = async () => {
      if (busy) return
      busy = true
      try {
        if (stateDir && flagDirty) {
          flagDirty = false
          await $.fs.write(`${stateDir}/${sid}.json`, flagBody())
        }
        const want = autoBroken ? null : autoWant
        if (want && want.value !== autoNow && (autoTouched || !want.restore)) {
          try {
            // the first set keeps what was there, so off or 0 can put it back, also after a reload; since 2.1.302 a
            // write the engine holds (a session under an organization's settings) resolves { deny } instead of rejecting
            const kept = autoTouched ? undefined : await $.env.set('CATNAP_AUTO_ORIG', autoOrig)
            if (kept?.deny) throw new Error(kept.deny)
            const res = await $.env.set('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', want.value)
            if (res?.deny) throw new Error(res.deny)
            autoNow = want.value
            autoTouched = true
            log('auto-line', { value: want.value ?? null, restore: want.restore })
          } catch (err) {
            // a refused write must not hold up the compaction below: the auto line is dropped for this module
            autoBroken = true
            log('auto-line-refused', { error: String(err).slice(0, 200) })
          }
        }
        if (ask !== null) {
          const text = ask
          ask = null
          log('ask-submitted')
          void $.prompt.submit({ text })
        }
        if (slashJob && (await $.clock.now()) - slashAt > SLASH_TIMEOUT_MS) giveUp('/compact did not compact within 10 minutes')
        if (clearJob && (await $.clock.now()) - clearAt > SLASH_TIMEOUT_MS) giveUp('/clear did not run within 10 minutes')
        const fresh = due && pending && !slashJob && !clearJob
          ? parseConfig(await Promise.all(configPaths().map(p => $.fs.read(p).catch(() => null))), base).fresh
          : false
        if (fresh && pending) {
          // fresh start: a /clear instead of a compaction; session.end (reason clear), or else the command's end, marks it
          // landed, and the continue prompt then opens the new conversation with the handoff
          const job = pending
          clearJob = job
          clearAt = await $.clock.now()
          due = false
          log('clear-submitted')
          void $.command.run({ command: 'clear' }).then(
            () => {
              if (clearJob !== job) return
              reset()
              landedJob = job
              landedFresh = true
              floorNext = true
              log('cleared', { via: 'command-result' })
            },
            err => {
              if (clearJob === job) giveUp(`/clear was refused: ${String(err).slice(0, 160)}`)
            },
          )
        }
        if (due && pending && !slashJob && !clearJob) {
          const job = pending
          let viaSlash = useSlash
          if (!viaSlash) {
            try {
              const res = await $.session.compact({ instructions: instructionsFor(job) })
              reset()
              if ('skip' in res && res.skip !== undefined) {
                log('skipped', { reason: res.skip })
                toast = `the compaction was skipped (${res.skip})`
              } else {
                log('compacted', { tokensBefore: res.tokensBefore, tokensAfter: res.tokensAfter })
                landedJob = job
                floorNext = true
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
                floorNext = true
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
          const freshStart = landedFresh
          landedFresh = false
          sid = await $.session.id() // a fresh start runs under a new session id
          const back = await handoffText(job, path => $.fs.read(path))
          void $.prompt.submit({ text: continueText(job, back.text, back.cut, freshStart) })
          log('continue-submitted', { handoffChars: back.text?.length ?? null, cut: back.cut, fresh: freshStart })
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

  // Serves the mod's own compact_now, the documented way: a tool.call hook matched to the registered tool's full
  // name (fixed text, so the directory's checks can see it answers only its own tool; a RegExp, because the generated
  // types list only the tools known when they were written). It must read mcp__<NAME>__<TOOL>: see NAME above.
  on('tool.call', { tool: /^mcp__catnap__compact_now$/ }, async ($, e) => {
    if (e.agentId) return { deny: 'Only the main conversation can compact itself; a subagent cannot.' }
    // below the line, only when the person asked (see the header); where the notes never come, never held, and a check
    // that fails lets the call through
    let early: { percent: number; line: number } | null = null
    try {
      if (!personAsked && stateDir && (desktopChat || (await $.session.surfaces()).length > 0)) {
        const pct = (await $.session.usage()).context.percent
        const c = parseConfig(await Promise.all(configPaths().map(p => $.fs.read(p).catch(() => null))), base)
        const l = lifted(c)
        const line = l.soft < l.threshold ? l.soft : l.threshold
        if (!c.off && pct !== undefined && pct < line) early = { percent: pct, line }
      }
    } catch {
      early = null
    }
    if (early) {
      log('too-early', early)
      return { deny: earlyText(early.percent, early.line, toolName) }
    }
    const input = e as unknown as { note?: unknown; handoff?: unknown; keep?: unknown }
    const note = String(input.note ?? '').trim()
    let handoff = String(input.handoff ?? '').trim()
    const keep = String(input.keep ?? '').trim()
    if (!note && !handoff)
      return {
        deny: save
          ? `Save everything first (run ${save}), then call again with the handoff file's path as handoff.`
          : `Write your handoff first and pass it as note (${HANDOFF_PARTS}), then call again.`,
      }
    if (note && !handoff && stateDir) {
      // a copy on disk: for a person to look at, and for the continue prompt to point at if the note is cut
      const path = `${stateDir}/${sid}.handoff.md`
      try {
        await $.fs.write(path, `${note}\n`)
        handoff = path
      } catch {
        // the note still comes back from memory
      }
    }
    pending = {
      handoff,
      note,
      keep: keep || 'the current task and its next step',
      percent: (await $.session.usage()).context.percent ?? -1,
    }
    napTurn = turnNow
    due = false
    retries = 0
    gaveUp = false // a call of the model's own is a fresh try
    flagDirty = true
    log('queued', { handoff, noteChars: note.length, percent: pending.percent })
    return {
      result:
        'Compaction queued. End your reply now: write nothing more and call no more tools. ' +
        'The conversation is compacted as soon as this turn ends, and a message then tells you to continue.',
    }
  }).catch(() => ({ deny: 'compact_now failed inside the mod. Your work is saved; run /compact yourself, or call it again.' }))

  // A person's prompt says whether they ask for a compaction (compact_now is then not held to the line); other prompts
  // (catnap's own, a notification, a scheduled one) leave that as it is.
  on('prompt.submit', async ($, e, next) => {
    if (PERSON_ORIGINS.has(e.origin?.kind ?? '')) personAsked = asksToCompact(e.text ?? '')
    return next(e)
  })

  // The main loop's running turn, so a compact_now call knows which turn it belongs to.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) turnNow = e.turnId
    return next(e)
  })

  // The model request right after compact_now could only end the reply (its tool result says so), yet it re-reads the
  // whole context: the mod answers that one request with NAP_REPLY instead, and the turn ends. Only in the turn that
  // called compact_now (turn.complete clears it), in the main loop, once; every other request goes to the model, and a
  // hook that fails here leaves the request to the model too.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !pending || !napTurn || e.turnId !== napTurn) return yield* next(e)
    napTurn = ''
    log('nap-reply', { step: e.index })
    yield { kind: 'text', index: 0, text: NAP_REPLY }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: NAP_REPLY, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // Every other tool call goes to its tool; past the lines, the result gets a note.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.tool === toolName || e.agentId || r.deny !== undefined) return r
    if (pending) return { ...r, context: [...(r.context ?? []), QUEUED_NOTE] }
    if (!stateDir || (!desktopChat && (await $.session.surfaces()).length === 0)) return r
    const pct = (await $.session.usage()).context.percent
    sawPercent(pct) // before the give-up check: a compaction seen this way also ends a give-up
    if (gaveUp) return r
    const c = parseConfig(await Promise.all(configPaths().map(p => $.fs.read(p).catch(() => null))), base)
    wantAuto(c)
    if (c.off) return r
    if (pct === undefined) return r
    const l = lifted(c)
    noteFloor(c, l)
    if (pct < l.threshold) {
      // the soft line: one note per cycle, then quiet until the strict line
      if (softNoted || l.soft >= l.threshold || pct < l.soft) return r
      softNoted = true
      log('soft-note', { percent: pct, soft: l.soft, threshold: l.threshold })
      return { ...r, context: [...(r.context ?? []), softText(pct, l.threshold, toolName, save)] }
    }
    if (lastNote >= 0 && pct < lastNote + REMIND_STEP) return r
    softNoted = true // past the strict line the soft note is moot
    lastNote = pct
    log('note', { percent: pct, threshold: l.threshold })
    return { ...r, context: [...(r.context ?? []), noteText(pct, l.threshold, toolName, save)] }
  }).catch(($, e, next) => next(e)) // fail open: a broken note never blocks a tool

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    sid = await $.session.id()
    if (pending) {
      napTurn = '' // the turn is over: no later request is answered in Claude's place
      // interrupted or errored: stay queued, it runs at the next turn that ends normally
      if (e.reason === 'answer') {
        due = true
        retries = 0
        log('due')
      }
      return r
    }
    if (!stateDir || (!desktopChat && (await $.session.surfaces()).length === 0)) return r
    const pct = (await $.session.usage()).context.percent
    sawPercent(pct) // an auto-compact inside the turn shows here at the latest
    if (gaveUp || e.reason !== 'answer') return r
    const c = parseConfig(await Promise.all(configPaths().map(p => $.fs.read(p).catch(() => null))), base)
    wantAuto(c)
    if (c.off || pct === undefined) return r
    const l = lifted(c)
    noteFloor(c, l)
    if (pct < l.threshold) return r
    if (lastAsk >= 0 && pct < lastAsk + ASK_STEP) return r
    lastAsk = pct
    ask = askText(pct, l.threshold, toolName, save)
    log('ask', { percent: pct, threshold: l.threshold })
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
        floorNext = true
        log('compacted', { via: 'prompt', trigger: e.trigger, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter })
      } else {
        const reason = 'skip' in r && r.skip !== undefined ? String(r.skip) : 'skipped'
        reset()
        log('skipped', { via: 'prompt', reason })
        $.ui.toast(`the compaction was skipped (${reason})`)
      }
      return r
    }
    if (!e.agentId && landed && (e.trigger === 'auto' || e.trigger === 'manual')) {
      // the backstop or the user compacted: whatever was queued is done, start the note cycle over
      reset()
      floorNext = true
      log('compacted-elsewhere', { trigger: e.trigger })
    }
    return r
  }).catch(($, e, next) => next(e)) // fail open: never block a compaction

  on('session.end', async ($, e, next) => {
    const ours = clearJob !== null && e.reason === 'clear' ? clearJob : null
    reset()
    if (ours) {
      // the fresh start this mod ran: the timer opens the new conversation with the handoff
      landedJob = ours
      landedFresh = true
      log('cleared', { via: 'session-end' })
    }
    // a /clear ends the conversation but not this module (no session.start follows): the next one starts with no floor
    floor = -1
    floorNext = false
    floorNoted = false
    floorWarned = false
    return next(e)
  })
}
