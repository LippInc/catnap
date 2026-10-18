import type { On, RenderSurface } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { NAME, NAP_REPLY, PASTE_MAX, autoTarget, isHeadlessRefusal, parseConfig } from './register'

// The tool's full name, spelled out here and NOT taken from register.ts, so a rename that reaches only one of the two
// files shows up: the tests under "the name trap" at the end check it against what the engine says the plugin is called.
const TOOL = 'mcp__catnap__compact_now'
const FLAG = /state\/catnap\/sess-1\.json$/
const slash = (p: string) => p.split('\\').join('/') // the engine hands paths over with backslashes on Windows

type World = {
  pct: number | undefined
  surfaces: RenderSurface[]
  files: Map<string, string>
  prompts: string[]
  compacts: (string | undefined)[]
  compactFailures: number
  headless: boolean // $.session.compact refused as in the desktop app's SDK session; a /compact prompt works
  triggers: (string | undefined)[] // every session.compact that reached the engine, by trigger
  commands: string[] // every slash command run, as typed
  commandMode: 'done' | 'hold' | 'refuse' // a command finishes at once, waits for release(), or is refused
  toasts: string[]
}

// Everything beneath the plugin: the engine's answers, held in memory.
const world = (on: On, init: Partial<World> = {}, fixture: Record<string, string> = { USERPROFILE: 'C:\\Users\\tester' }) => {
  const w: World = {
    pct: 10,
    surfaces: ['desktop'],
    files: new Map(),
    prompts: [],
    compacts: [],
    compactFailures: 0,
    headless: false,
    triggers: [],
    commands: [],
    commandMode: 'done',
    toasts: [],
    ...init,
  }
  const clock = mock.clock(on)
  // the process environment, read and written (mock.env answers reads only). The starting record is called
  // `fixture`: under its old name the directory's checker took listing it for listing the real environment and held
  // the plugin for "uses a credential" (found 2026-10-17 by elimination on probe branches)
  const vars = new Map(Object.entries(fixture))
  on('env.get', ($, e) => ({ value: vars.get(e.name) }))
  on('env.set', ($, e) => {
    if (vars.has('TEST_REFUSE_ENV_SET')) throw new Error('env writes are not allowed here')
    if (vars.has('TEST_HOLD_ENV_SET')) return { value: { deny: 'held: this session takes its settings from its organization' } }
    if (e.value === undefined) vars.delete(e.name)
    else vars.set(e.name, e.value)
    return { value: {} } // written (since 2.1.302 a held write resolves { deny } instead of rejecting)
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: w.surfaces }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context:
        w.pct === undefined ? { window: 1_000_000 } : { window: 1_000_000, tokens: w.pct * 10_000, percent: w.pct },
      rateLimits: [],
    },
  }))
  on('fs.read', ($, e) => {
    const want = slash(e.path).replace(/^.*\/state\//, '/state/')
    const text = [...w.files].find(([p]) => slash(p).endsWith(want))?.[1]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__catnap__${e.name}` } }))
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('session.compact', ($, e) => {
    w.triggers.push(e.trigger)
    // a plugin's own call reaches the test's bottom with no trigger
    if (w.headless && (e.trigger === undefined || e.trigger === 'plugin')) {
      // the live 2026-10-13 refusal, word for word
      throw new Error(
        'HooksError: catnap: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on',
      )
    }
    if (w.compactFailures > 0) {
      w.compactFailures -= 1
      throw new Error('a turn is running')
    }
    w.compacts.push(e.instructions)
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensBefore: 640_000, tokensAfter: 40_000 }
  })
  const held: (() => void)[] = []
  on('command.run', ($, e) => {
    w.commands.push(`/${e.command} ${e.args}`)
    if (w.commandMode === 'refuse') throw new Error('no such command')
    if (w.commandMode === 'hold') return new Promise(resolve => held.push(() => resolve({ text: 'Compacted.' })))
    return { text: 'Compacted.' }
  })
  const release = () => held.splice(0).forEach(f => f())
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('turn.complete', () => ({ text: 'done' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const flag = () => {
    const hit = [...w.files].filter(([p]) => FLAG.test(slash(p))).pop() // the newest, whatever its slashes
    return hit ? (JSON.parse(hit[1]) as { pending: boolean; handoff: string | null }) : undefined
  }
  return { w, clock, flag, release, vars }
}

const start = ($: Engine) =>
  $.session.start({ cwd: '.', surface: 'desktop', isInteractive: false })

const read = { tool: 'Read', file_path: 'a.txt' } as const

test('below the soft line a tool result carries no note', async ($, on) => {
  const { w } = world(on, { pct: 49 })
  await start($)
  const r = await $.tool.call(read)
  expect(r.context ?? []).toEqual([])
  expect(w.prompts).toEqual([])
})

test('at the soft line the soft note lands once, then the strict note at the line', async ($, on) => {
  const { w } = world(on, { pct: 50 })
  await start($)
  const soft = (await $.tool.call(read)).context?.[0] ?? ''
  expect(soft).toMatch(/Context is at 50% of the window\. Compact at a comfortable moment before 60%/)
  expect(soft).toMatch(/Finish the piece you are on, and finish it properly/)
  expect(soft).toMatch(/write your handoff, call mcp__catnap__compact_now with your handoff as note/)
  expect(soft).not.toMatch(/save-before-compact/)
  expect(soft).toMatch(/compact_now/)
  expect(soft).not.toMatch(/do not wait for a better moment/)
  w.pct = 55
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 59
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 60
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 60% of the window \(the line is 60%\)\. Save and compact now/)
})

test('a turn that ends between the soft line and the line gets no ask', async ($, on) => {
  const { w, clock } = world(on, { pct: 55 })
  await start($)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(3200)
  expect(w.prompts).toEqual([])
  expect(w.compacts).toEqual([])
})

test('a jump straight past the line skips the soft note', async ($, on) => {
  world(on, { pct: 65 })
  await start($)
  const first = (await $.tool.call(read)).context ?? []
  expect(first.length).toBe(1)
  expect(first[0] ?? '').toMatch(/Save and compact now/)
  expect(first[0] ?? '').not.toMatch(/comfortable moment/)
})

test('a soft line at or above the line is off', async ($, on) => {
  const { w } = world(on, { pct: 55 })
  w.files.set('X/state/catnap/config.json', '{"soft": 60, "threshold": 60}')
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
})

test('after a compaction the soft note comes back in the next cycle', async ($, on) => {
  const { w, clock } = world(on, { pct: 52 })
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/comfortable moment/)
  await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k' } as never)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  w.pct = 8
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 51
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 51% of the window\. Compact at a comfortable moment/)
})

test('past the line the note lands once, then again two points later', async ($, on) => {
  const { w } = world(on, { pct: 61 })
  await start($)
  const first = await $.tool.call(read)
  expect(first.context?.[0] ?? '').toMatch(/Context is at 61% of the window \(the line is 60%\)/)
  expect(first.context?.[0] ?? '').toMatch(/do not wait for a better moment/)
  expect(first.context?.[0] ?? '').toMatch(/write your handoff \(the task, what is done, the next step, open decisions and the files that matter\) straight into the note/)
  expect(first.context?.[0] ?? '').toMatch(/3\. Call mcp__catnap__compact_now with your handoff as note/)
  expect(first.context?.[0] ?? '').toMatch(/End your reply right there/)
  w.pct = 62
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 63
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 63%/)
})

test('compact_now queues, the turn end compacts, then a continue prompt is sent', async ($, on) => {
  const { w, clock, flag } = world(on, { pct: 64 })
  await start($)
  const q = await $.tool.call({ tool: TOOL, handoff: 'C:/p/.claude/handoffs/x.md', keep: 'the mod build' } as never)
  expect(String(q.result)).toMatch(/Compaction queued\. End your reply now/)
  expect(q.context ?? []).toEqual([]) // its own answer, with no note added past the line
  // a second call while queued is answered by the mod again, still with no note
  expect((await $.tool.call({ tool: TOOL, handoff: 'C:/p/.claude/handoffs/x.md', keep: 'the mod build' } as never)).context ?? []).toEqual([])
  await clock.advance(1600)
  expect(flag()?.pending).toBe(true)
  // a tool call after queueing is told to stop
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Compaction is queued\. End your reply now/)
  expect(w.compacts).toEqual([]) // nothing runs mid-turn
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  expect(w.compacts[0] ?? '').toMatch(/the mod build/)
  expect(w.compacts[0] ?? '').toMatch(/x\.md/)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/just compacted at your request \(context had reached 64%\)/)
  expect(w.prompts[0] ?? '').toMatch(/x\.md/)
  expect(flag()?.pending).toBe(false)
})

test('a compaction refused while a turn runs is retried', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, compactFailures: 2 })
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k' } as never)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.compacts.length).toBe(0)
  await clock.advance(1600)
  expect(w.compacts.length).toBe(0)
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  expect(w.prompts.length).toBe(1)
})

test('an interrupted turn keeps the compaction queued until a normal turn end', async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k' } as never)
  await $.turn.complete({ reason: 'aborted', isAborted: true, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(3200)
  expect(w.compacts.length).toBe(0)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't2', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
})

test('a turn that ends past the line without compact_now gets an ask, repeated only five points later', async ($, on) => {
  const { w, clock } = world(on, { pct: 65 })
  await start($)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/Your last turn ended with context at 65%/)
  expect(w.prompts[0] ?? '').toMatch(/compact_now/)
  w.pct = 68
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't2', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  w.pct = 70
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't3', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.prompts.length).toBe(2)
})

test('a run where nothing draws (-p, delegate legs) is never touched', async ($, on) => {
  const { w, clock } = world(on, { pct: 90, surfaces: [] })
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(3200)
  expect(w.prompts).toEqual([])
  expect(w.compacts).toEqual([])
})

// The desktop app attaches its window to a chat and detaches it again: a long turn there crossed 50% and 60% with no
// note while nothing was attached (live 2026-10-17). Its chats are known by the entry point instead.
const DESKTOP = { USERPROFILE: 'C:\\Users\\tester', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }

test('a desktop app chat with no window attached still gets both notes, the ask, its log and the auto line', async ($, on) => {
  const { w, clock, vars } = world(on, { pct: 55, surfaces: [] }, DESKTOP)
  await start($)
  await clock.advance(1600)
  expect(vars.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')).toBe('70')
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 55% of the window\. Compact at a comfortable moment/)
  w.pct = 62
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/the line is 60%/)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/Your last turn ended with context at 62%/)
  expect([...w.files.keys()].map(slash).filter(p => /sess-1\.log\.json$/.test(p)).length).toBeGreaterThan(0)
})

test('a desktop app chat whose window goes away mid-turn keeps getting notes', async ($, on) => {
  const { w } = world(on, { pct: 45 }, DESKTOP)
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.surfaces = []
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/the line is 60%/)
})

// A claude -p started from inside a desktop chat inherits its entry point, but the engine also sets CLAUDECODE and
// CLAUDE_CODE_CHILD_SESSION for what it starts (seen live 2026-10-17); either one alone keeps the mod out.
for (const [what, extra] of [
  ['CLAUDECODE', { CLAUDECODE: '1' }],
  ['CLAUDE_CODE_CHILD_SESSION', { CLAUDE_CODE_CHILD_SESSION: '1' }],
  ['a plain -p run (sdk-cli)', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }],
] as const) {
  test(`a run started from inside a chat is never touched: ${what}`, async ($, on) => {
    const { w, clock, vars } = world(on, { pct: 90, surfaces: [] }, { ...DESKTOP, ...extra, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '55' })
    await start($)
    expect((await $.tool.call(read)).context ?? []).toEqual([])
    await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
    await clock.advance(3200)
    expect(w.prompts).toEqual([])
    expect(w.compacts).toEqual([])
    expect(vars.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')).toBe('55')
    expect([...w.files.keys()].filter(p => /\.log\.json$/.test(p))).toEqual([])
  })
}

test('subagents get no note and may not compact', async ($, on) => {
  const { w } = world(on, { pct: 90 })
  await start($)
  expect((await $.tool.call({ ...read, agentId: 'a1' } as never)).context ?? []).toEqual([])
  const denied = await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k', agentId: 'a1' } as never)
  expect(denied.deny ?? '').toMatch(/Only the main conversation/)
  expect(w.compacts).toEqual([])
})

test('the config file switches it off and moves the line; a per-session file wins', async ($, on) => {
  const { w } = world(on, { pct: 30 })
  w.files.set('X/state/catnap/config.json', '{"threshold": 25}')
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/the line is 25%/)
  w.files.set('X/state/catnap/sess-1.config.json', '{"off": true}')
  w.pct = 40
  expect((await $.tool.call(read)).context ?? []).toEqual([])
})

test('compact_now with neither a note nor a handoff path is refused', async ($, on) => {
  const { w } = world(on, { pct: 64 })
  await start($)
  const r = await $.tool.call({ tool: TOOL, note: ' ', handoff: '  ', keep: 'k' } as never)
  expect(r.deny ?? '').toMatch(/Write your handoff first and pass it as note/)
  expect([...w.files.keys()].some(k => /handoff\.md$/.test(k))).toBe(false)
})

test('wrapper children (CLAUDE_DELEGATE_LEG) are never touched, even with a surface', async ($, on) => {
  const { w, clock } = world(on, { pct: 90 }, { USERPROFILE: 'C:\\Users\\tester', CLAUDE_DELEGATE_LEG: 'glm' })
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  await clock.advance(3200)
  expect(w.prompts).toEqual([])
})

test('CLAUDE_STATE_DIR moves the state folder, as it does for the settings hooks', async ($, on) => {
  const { w, clock } = world(on, { pct: 64 }, { USERPROFILE: 'C:\\Users\\tester', CLAUDE_STATE_DIR: 'D:\\st' })
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k' } as never)
  await clock.advance(1600)
  expect([...w.files.keys()].map(slash)).toContain('D:/st/catnap/sess-1.json')
})

const MSGS = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

const turnEnd = ($: Engine, turnId: string) =>
  $.turn.complete({ reason: 'answer', isAborted: false, turnId, answer: 'ok', durationMs: 1 })

const LIVE_REFUSAL =
  'HooksError: catnap: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on'

test("the desktop app's refusal is recognised; a busy refusal is not", () => {
  expect(isHeadlessRefusal(new Error(LIVE_REFUSAL))).toBe(true)
  expect(isHeadlessRefusal(LIVE_REFUSAL)).toBe(true)
  expect(isHeadlessRefusal(new Error('a turn is running'))).toBe(false)
  expect(isHeadlessRefusal(undefined)).toBe(false)
})

// The test kit hands the plugin its own error text for a refused call, so these reach /compact by the count.
const queueAndEnd = async ($: Engine) => {
  await $.tool.call({ tool: TOOL, handoff: 'C:/p/.claude/handoffs/x.md', keep: 'the mod build' } as never)
  await turnEnd($, 't1')
}

test('where direct compaction is refused (the desktop app), /compact runs and the continue follows its landing', async ($, on) => {
  const { w, clock, flag, release } = world(on, { pct: 64, headless: true, commandMode: 'hold' })
  await start($)
  await queueAndEnd($)
  await clock.advance(1500 * 2 + 100)
  expect(w.commands).toEqual([]) // two refusals: still trying directly
  await clock.advance(1500)
  expect(w.triggers.length).toBe(3)
  expect(w.commands.length).toBe(1)
  expect(w.commands[0] ?? '').toMatch(/^\/compact Keep what the next turn needs to continue: the mod build\./)
  expect(w.commands[0] ?? '').toMatch(/x\.md/)
  expect(w.prompts).toEqual([]) // never a prompt beginning with /
  expect(flag()?.pending).toBe(true) // still queued while /compact runs
  await clock.advance(4500)
  expect(w.commands.length).toBe(1) // no second /compact while the first is out
  expect(w.triggers.length).toBe(3) // and no more direct calls
  // /compact compacts: the engine raises session.compact with trigger manual
  await $.session.compact({ trigger: 'manual', messages: MSGS, instructions: 'x' } as never)
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/just compacted at your request \(context had reached 64%\)/)
  expect(flag()?.pending).toBe(false)
  release() // the command finishes after its compaction: no second continue
  await clock.advance(3200)
  expect(w.prompts.length).toBe(1)
  expect(w.toasts).toEqual([])
})

test('if no compaction is seen, the finished /compact stands for it and the continue follows', async ($, on) => {
  const { w, clock, flag } = world(on, { pct: 64, headless: true })
  await start($)
  await queueAndEnd($)
  await clock.advance(1500 * 3 + 100)
  expect(w.commands.length).toBe(1)
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/just compacted at your request/)
  expect(flag()?.pending).toBe(false)
})

test('a refused /compact gives up: toast, queued state cleared', async ($, on) => {
  const { w, clock, flag } = world(on, { pct: 64, headless: true, commandMode: 'refuse' })
  await start($)
  await queueAndEnd($)
  await clock.advance(1500 * 4 + 100)
  expect(w.commands.length).toBe(1)
  expect(w.prompts).toEqual([])
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0] ?? '').toMatch(/^could not compact this chat \(\/compact was refused/) // the host adds "catnap:"
  expect(flag()?.pending).toBe(false)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
})

test('a /compact that never lands is given up after 10 minutes: toast, queued state cleared, quiet', async ($, on) => {
  const { w, clock, flag } = world(on, { pct: 64, headless: true, commandMode: 'hold' })
  await start($)
  await queueAndEnd($)
  await clock.advance(1500 * 3 + 100)
  expect(w.commands.length).toBe(1)
  await clock.advance(10 * 60_000 + 3200)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0] ?? '').toMatch(/^could not compact this chat \(\/compact did not compact within 10 minutes\)/)
  expect(flag()?.pending).toBe(false)
  // quiet: no queued note, no strict note, no ask
  w.pct = 70
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await turnEnd($, 't2')
  await clock.advance(3200)
  expect(w.prompts).toEqual([])
})

test('a compaction landing some other way ends the give-up', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, headless: true, commandMode: 'hold' })
  await start($)
  await queueAndEnd($)
  await clock.advance(11 * 60_000)
  expect(w.toasts.length).toBe(1)
  await $.session.compact({ trigger: 'auto', messages: MSGS, instructions: undefined } as never)
  w.pct = 5 // the first check after it: the floor
  await $.tool.call(read)
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Save and compact now/)
})

test('a reload clears a queued flag the old module left behind', async ($, on) => {
  const { w, clock, flag } = world(on, { pct: 10 })
  w.files.set('C:/Users/tester/.claude/state/catnap/sess-1.json', '{"pending":true,"at":"2026-10-13T17:31:43.722Z","handoff":"h.md"}')
  await start($)
  await clock.advance(1600)
  expect(flag()?.pending).toBe(false)
})

test('save_step names the save command in every note, the ask and the refusal', { options: { save_step: '/save-before-compact' } }, async ($, on) => {
  const { w, clock } = world(on, { pct: 52 })
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/At that clean break: run \/save-before-compact, call/)
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/2\. Save everything a fresh start would need: run \/save-before-compact \(it writes the handoff file/)
  await turnEnd($, 't1')
  await clock.advance(1600)
  expect(w.prompts[0] ?? '').toMatch(/run \/save-before-compact/)
  const r = await $.tool.call({ tool: TOOL, handoff: ' ', keep: 'k' } as never)
  expect(r.deny ?? '').toMatch(/Save everything first \(run \/save-before-compact\)/)
})

test('soft_percent and strict_percent move both lines', { options: { soft_percent: 30, strict_percent: 40 } }, async ($, on) => {
  const { w } = world(on, { pct: 29 })
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 30
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 30% of the window\. Compact at a comfortable moment before 40%/)
  w.pct = 40
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/\(the line is 40%\)\. Save and compact now/)
})

test('the config file still wins over the options', { options: { soft_percent: 30, strict_percent: 40 } }, async ($, on) => {
  const { w } = world(on, { pct: 45 })
  w.files.set('X/state/catnap/config.json', '{"threshold": 50}')
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/comfortable moment before 50%/)
})

// CATNAP_OFF, and the old name of the switch, which keeps working
for (const OFF of ['CATNAP_OFF', 'COMPACT_WHEN_READY_OFF'])
  test(`${OFF} switches it off, even with a surface`, async ($, on) => {
  const { w, clock } = world(on, { pct: 90 }, { USERPROFILE: 'C:\\Users\\tester', [OFF]: '1' })
  await start($)
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await turnEnd($, 't1')
  await clock.advance(3200)
  expect(w.prompts).toEqual([])
  expect([...w.files.keys()]).toEqual([])
})

test('a session where nothing draws leaves no log file; one that draws does', async ($, on) => {
  const { w, clock } = world(on, { pct: 10, surfaces: [] })
  await start($)
  await clock.advance(3200)
  expect([...w.files.keys()].filter(p => /\.log\.json$/.test(p))).toEqual([])
  w.surfaces = ['desktop']
  await start($)
  await clock.advance(3200)
  expect([...w.files.keys()].map(slash).filter(p => /sess-1\.log\.json$/.test(p)).length).toBeGreaterThan(0)
})

// The auto line: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in the mod's own process.
const AUTO = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'
const ORIG = 'CATNAP_AUTO_ORIG'
const HOME = { USERPROFILE: 'C:\\Users\\tester' }

test('a session that draws gets auto-compact at 70 by default, and what was there is kept', async ($, on) => {
  const { clock, vars } = world(on)
  await start($)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('70')
  expect(vars.get(ORIG)).toBe('') // it was unset
})

test('auto_percent moves the auto line and wins over a value from the settings', { options: { auto_percent: 80 } }, async ($, on) => {
  const { clock, vars } = world(on, {}, { ...HOME, [AUTO]: '55' })
  await start($)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('80')
  expect(vars.get(ORIG)).toBe('55')
})

test("auto_percent 0 leaves Claude Code's own setting alone", { options: { auto_percent: 0 } }, async ($, on) => {
  const { clock, vars } = world(on, { pct: 30 }, { ...HOME, [AUTO]: '55' })
  await start($)
  await $.tool.call(read)
  await turnEnd($, 't1')
  await clock.advance(3200)
  expect(vars.get(AUTO)).toBe('55')
  expect(vars.has(ORIG)).toBe(false)
})

test('config.json moves the auto line at the next check, and off puts the old value back', async ($, on) => {
  const { w, clock, vars } = world(on, { pct: 30 }, { ...HOME, [AUTO]: '55' })
  await start($)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('70')
  w.files.set('X/state/catnap/config.json', '{"auto": 75}')
  await $.tool.call(read)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('75')
  w.files.set('X/state/catnap/config.json', '{"auto": 75, "off": true}')
  await $.tool.call(read)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('55')
})

test('off puts an unset variable back to unset, also after a reload', async ($, on) => {
  // a reload: the variable holds the mod's own 70, the marker says it was unset before
  const { w, clock, vars } = world(on, {}, { ...HOME, [AUTO]: '70', [ORIG]: '' })
  w.files.set('X/state/catnap/config.json', '{"off": true}')
  await start($)
  await clock.advance(1600)
  expect(vars.has(AUTO)).toBe(false)
})

test('the desktop app attaches after the start: its first tool call sets the auto line', async ($, on) => {
  const { w, clock, vars } = world(on, { pct: 20, surfaces: [] })
  await start($)
  await clock.advance(1600)
  expect(vars.has(AUTO)).toBe(false)
  w.surfaces = ['desktop']
  await $.tool.call(read)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('70')
})

test('a run where nothing draws never touches the auto line', async ($, on) => {
  const { clock, vars } = world(on, { pct: 90, surfaces: [] }, { ...HOME, [AUTO]: '55' })
  await start($)
  await $.tool.call(read)
  await turnEnd($, 't1')
  await clock.advance(3200)
  expect(vars.get(AUTO)).toBe('55')
  expect(vars.has(ORIG)).toBe(false)
})

for (const OFF of ['CATNAP_OFF', 'COMPACT_WHEN_READY_OFF'])
  test(`${OFF} leaves the auto line alone, even with a surface`, async ($, on) => {
  const { clock, vars } = world(on, { pct: 30 }, { ...HOME, [OFF]: '1' })
  await start($)
  await $.tool.call(read)
  await clock.advance(3200)
  expect(vars.has(AUTO)).toBe(false)
})

test('a wrapper child (CLAUDE_DELEGATE_LEG) leaves the auto line alone, even with a surface', async ($, on) => {
  const { clock, vars } = world(on, { pct: 30 }, { ...HOME, CLAUDE_DELEGATE_LEG: 'glm', [AUTO]: '70' })
  await start($)
  await $.tool.call(read)
  await clock.advance(3200)
  expect(vars.get(AUTO)).toBe('70')
  expect(vars.has(ORIG)).toBe(false)
})

test('an auto line at or below the strict line is kept, with one toast', { options: { auto_percent: 60 } }, async ($, on) => {
  const { w, clock, vars } = world(on, { pct: 30 })
  await start($)
  await $.tool.call(read)
  await clock.advance(1600)
  await $.tool.call(read)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('60')
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0] ?? '').toMatch(/^auto-compact \(60%\) is at or below the strict line \(60%\), so it runs before Claude is asked$/)
})

test('a host that refuses the variable write still gets its compaction and the continue', async ($, on) => {
  const { w, clock, vars } = world(on, { pct: 64 }, { ...HOME, TEST_REFUSE_ENV_SET: '1' })
  await start($)
  await queueAndEnd($)
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/just compacted at your request/)
  expect(vars.has(AUTO)).toBe(false)
  const log = [...w.files].find(([p]) => /sess-1\.log\.json$/.test(slash(p)))?.[1] ?? ''
  expect(log.match(/auto-line-refused/g)?.length).toBe(1) // tried once, then left alone
})

test('a write the engine holds back ({ deny }, since 2.1.302) counts as refused, not as set', async ($, on) => {
  const { w, clock, vars } = world(on, { pct: 30 }, { ...HOME, TEST_HOLD_ENV_SET: '1' })
  await start($)
  await $.tool.call(read)
  await clock.advance(3200)
  await $.tool.call(read)
  await clock.advance(1600)
  expect(vars.has(AUTO)).toBe(false)
  const log = [...w.files].find(([p]) => /sess-1\.log\.json$/.test(slash(p)))?.[1] ?? ''
  expect(log).not.toMatch(/"kind": "auto-line"/)
  expect(log.match(/auto-line-refused/g)?.length).toBe(1)
  expect(log).toMatch(/held: this session takes its settings from its organization/)
})

test('the auto line in the config parser and the target', () => {
  expect(parseConfig([]).auto).toBe(70)
  expect(parseConfig(['{"auto": 0}']).auto).toBe(0)
  expect(parseConfig(['{"auto": 100}', '{"auto": -1}', '{"auto": "80"}']).auto).toBe(70) // out of range or not a number
  expect(autoTarget(parseConfig(['{"auto": 65}']), '55')).toEqual({ value: '65', restore: false })
  expect(autoTarget(parseConfig(['{"auto": 0}']), '55')).toEqual({ value: '55', restore: true })
  expect(autoTarget(parseConfig(['{"off": true}']), '')).toEqual({ value: undefined, restore: true })
})

// The fallback for a compaction the session.compact hook does not report (a seated sec-default holds that hook back:
// anthropics/claude-code#102134). Here the hook is simply never raised, as there.
type LogEvent = { kind: string; via?: string; from?: number; to?: number; trigger?: string; floor?: number; soft?: number; threshold?: number }
const logOf = (w: World): LogEvent[] =>
  JSON.parse([...w.files].find(([p]) => /sess-1\.log\.json$/.test(slash(p)))?.[1] ?? '[]') as LogEvent[]
const elsewhere = (w: World) => logOf(w).filter(e => e.kind === 'compacted-elsewhere')

test('a sharp drop in context, with no hook, starts the note cycle over and is logged once', async ($, on) => {
  const { w, clock } = world(on, { pct: 52 })
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/comfortable moment/)
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Save and compact now/)
  await turnEnd($, 't1')
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1) // the ask at 61
  // auto-compact inside the next turn: no hook, only the context that fell
  w.pct = 5
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 6
  await $.tool.call(read)
  await clock.advance(1600)
  expect(elsewhere(w).map(e => [e.via, e.from, e.to])).toEqual([['drop', 61, 5]])
  // a fresh cycle: the soft note again, the strict note at once, the ask without waiting five points
  w.pct = 51
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 51% of the window\. Compact at a comfortable moment/)
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 61%/)
  w.pct = 62
  await turnEnd($, 't2')
  await clock.advance(1600)
  expect(w.prompts.length).toBe(2)
  expect(w.prompts[1] ?? '').toMatch(/Your last turn ended with context at 62%/)
})

test('a dip under 20 points is not a compaction; 20 points is', async ($, on) => {
  const { w, clock } = world(on, { pct: 61 })
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 61%/)
  w.pct = 42 // 19 points
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 52
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // no soft note: still the same cycle
  w.pct = 62
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // the strict note still waits for 63
  await clock.advance(1600)
  expect(elsewhere(w)).toEqual([])
  w.pct = 42 // 20 points
  await $.tool.call(read)
  await clock.advance(1600)
  expect(elsewhere(w).map(e => [e.from, e.to])).toEqual([[62, 42]])
})

test('the check right after a compaction has no percent: the next one with a number compares', async ($, on) => {
  const { w, clock } = world(on, { pct: 61 })
  await start($)
  await $.tool.call(read)
  w.pct = undefined
  await $.tool.call(read)
  w.pct = 7
  await $.tool.call(read)
  await clock.advance(1600)
  expect(elsewhere(w).map(e => [e.from, e.to])).toEqual([[61, 7]])
})

test("the mod's own direct compaction is not counted again as a drop", async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  await start($)
  await $.tool.call(read)
  await queueAndEnd($)
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  w.pct = 4
  await $.tool.call(read)
  await turnEnd($, 't2')
  await clock.advance(1600)
  expect(logOf(w).filter(e => e.kind === 'compacted').length).toBe(1)
  expect(elsewhere(w)).toEqual([])
  expect(w.prompts.length).toBe(1) // the continue, and nothing else
})

test('a /compact of the mod that only its command result reports is not counted again as a drop', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, headless: true })
  await start($)
  await $.tool.call(read)
  await queueAndEnd($)
  await clock.advance(1500 * 3 + 100)
  expect(w.commands.length).toBe(1)
  await clock.advance(1600)
  w.pct = 4
  await $.tool.call(read)
  await turnEnd($, 't2')
  await clock.advance(1600)
  expect(logOf(w).filter(e => e.kind === 'compacted').map(e => e.via)).toEqual(['command-result'])
  expect(elsewhere(w)).toEqual([])
  expect(w.prompts.length).toBe(1)
})

test("a drop while the mod's own /compact is out does not cut it short", async ($, on) => {
  const { w, clock, release } = world(on, { pct: 64, headless: true, commandMode: 'hold' })
  await start($)
  await $.tool.call(read)
  await queueAndEnd($)
  await clock.advance(1500 * 3 + 100)
  expect(w.commands.length).toBe(1)
  w.pct = 3 // it compacted; the command has not finished yet
  await $.tool.call(read)
  await turnEnd($, 't2')
  await clock.advance(1600)
  expect(elsewhere(w)).toEqual([])
  release()
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0] ?? '').toMatch(/just compacted at your request/)
})

test('a compaction the hook reports is logged once, not again as a drop', async ($, on) => {
  const { w, clock } = world(on, { pct: 61 })
  await start($)
  await $.tool.call(read)
  await $.session.compact({ trigger: 'auto', messages: MSGS, instructions: undefined } as never)
  w.pct = 5
  await $.tool.call(read)
  await clock.advance(1600)
  expect(elsewhere(w).map(e => e.trigger ?? e.via)).toEqual(['auto'])
})

test('a drop ends a give-up when the hook is silent', async ($, on) => {
  const { w, clock } = world(on, { pct: 64, headless: true, commandMode: 'hold' })
  await start($)
  await queueAndEnd($)
  await clock.advance(11 * 60_000)
  expect(w.toasts.length).toBe(1)
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // given up: quiet
  w.pct = 5 // auto-compact, unreported
  await $.tool.call(read)
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Save and compact now/)
})

// The name trap: the tool's full name is built from the plugin's name ($.plugin.name, from plugin.json), the tool.call
// matcher that answers it is a regex literal in register.ts (it has to be one: `claude plugin validate` reads it
// statically), and NAME is the constant the rest of the module uses. If any of them differs, Claude's call to the tool
// goes unanswered while every other test here still passes. The notes tell Claude which name to call, so they show
// what the engine thinks the plugin is called.
const advertised = async ($: Engine) => {
  await start($)
  const note = (await $.tool.call(read)).context?.[0] ?? ''
  return /[Cc]all (mcp__\S+) with/.exec(note)?.[1] ?? ''
}

test('plugin.json, NAME and this file agree on the tool name the notes tell Claude to call', async ($, on) => {
  world(on, { pct: 61 })
  const name = await advertised($)
  expect(name).toBe(TOOL) // the name the engine gives the plugin (plugin.json)
  expect(name).toBe(`mcp__${NAME}__compact_now`)
})

test('a call to the advertised tool name is answered by the mod, not passed on', async ($, on) => {
  world(on, { pct: 61 })
  const name = await advertised($)
  const r = await $.tool.call({ tool: name, handoff: 'h.md', keep: 'k' } as never)
  expect(JSON.stringify(r)).toMatch(/Compaction queued/)
})

test('the matcher answers the full tool name and nothing else', async ($, on) => {
  world(on, { pct: 10 })
  await start($)
  for (const other of [`${TOOL}x`, `x${TOOL}`, 'mcp__other-plugin__compact_now', 'compact_now']) {
    const r = await $.tool.call({ tool: other, handoff: 'h.md', keep: 'k' } as never)
    expect(JSON.stringify(r)).not.toMatch(/Compaction queued/)
  }
})

// A session whose fixed part (system prompt, tools, CLAUDE.md) sits near the lines: a compaction frees almost nothing,
// so for that cycle the lines sit ten points above where it left the context (live 2026-10-18: two compactions in under
// a minute, and a third queued, without this).
const floorMoves = (w: World) => logOf(w).filter(e => e.kind === 'high-floor')

test('a compaction that leaves the context near the lines lifts them ten points for that cycle, with one toast', async ($, on) => {
  const { w, clock } = world(on, { pct: 52 })
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/comfortable moment/)
  await queueAndEnd($)
  await clock.advance(1600)
  expect(w.compacts.length).toBe(1)
  expect(w.prompts.length).toBe(1) // the continue
  w.pct = 51 // the compaction freed almost nothing
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // no soft note at 51
  await clock.advance(1600)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0] ?? '').toMatch(/still at 51% right after compacting.*the next note waits for 61%/)
  w.pct = 60
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // no strict note at 60 either
  await turnEnd($, 't2')
  await clock.advance(1600)
  expect(w.prompts.length).toBe(1) // and no ask at 60
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 61% of the window \(the line is 61%\)\. Save and compact now/)
  expect(floorMoves(w).map(e => [e.floor, e.soft, e.threshold])).toEqual([[51, 61, 61]])
})

test('a compaction that leaves 40% or less keeps the lines as set, with no toast', async ($, on) => {
  const { w, clock } = world(on, { pct: 61 })
  await start($)
  await $.tool.call(read)
  await queueAndEnd($)
  await clock.advance(1600)
  w.pct = 40 // 40 + 10 is the soft line itself
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 50
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 50% of the window\. Compact at a comfortable moment before 60%/)
  await clock.advance(1600)
  expect(w.toasts).toEqual([])
  expect(floorMoves(w)).toEqual([])
})

test('an auto-compaction or an unreported drop sets the floor too; the next compaction sets a new one', async ($, on) => {
  const { w, clock } = world(on, { pct: 75 })
  await start($)
  await $.tool.call(read)
  await $.session.compact({ trigger: 'auto', messages: MSGS, instructions: undefined } as never)
  w.pct = 55
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // both lines at 65: the soft one is off
  w.pct = 64
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 65
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 65% of the window \(the line is 65%\)/)
  w.pct = 30 // compacted some other way, unreported: a 35-point fall
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 50
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 50% of the window\. Compact at a comfortable moment before 60%/)
  await clock.advance(1600)
  expect(w.toasts.length).toBe(1) // once a session
  expect(floorMoves(w).map(e => e.floor)).toEqual([55])
})

test('a second cycle near the lines lifts them again, logged again, with no second toast', async ($, on) => {
  const { w, clock } = world(on, { pct: 52 })
  await start($)
  await queueAndEnd($)
  await clock.advance(1600)
  w.pct = 51
  await $.tool.call(read)
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/the line is 61%/)
  await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k' } as never)
  await turnEnd($, 't2')
  await clock.advance(1600)
  expect(w.compacts.length).toBe(2)
  w.pct = 52
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await clock.advance(1600)
  expect(w.toasts.length).toBe(1)
  expect(floorMoves(w).map(e => [e.floor, e.threshold])).toEqual([[51, 61], [52, 62]])
})

test("the floor after the mod's /compact (the desktop app's way) counts too, by hook or by the command's end", async ($, on) => {
  const { w, clock, release } = world(on, { pct: 52, headless: true, commandMode: 'hold' })
  await start($)
  await queueAndEnd($)
  await clock.advance(1500 * 3 + 100)
  expect(w.commands.length).toBe(1)
  await $.session.compact({ trigger: 'manual', messages: MSGS, instructions: 'x' } as never) // landed, by the hook
  await clock.advance(1600)
  release()
  w.pct = 51
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/the line is 61%/)
  // the next one lands only by the command's end
  w.commandMode = 'done'
  await $.tool.call({ tool: TOOL, handoff: 'h.md', keep: 'k' } as never)
  await turnEnd($, 't2')
  await clock.advance(1500 * 3 + 100) // three refusals again, then /compact
  expect(w.commands.length).toBe(2)
  await clock.advance(1600)
  w.pct = 53
  expect((await $.tool.call(read)).context ?? []).toEqual([])
  await clock.advance(1600) // the log goes to disk on the timer
  expect(floorMoves(w).map(e => [e.floor, e.threshold])).toEqual([[51, 61], [53, 63]])
})

test('a /clear ends the floor: the next conversation in the same module starts with the lines as set', async ($, on) => {
  const { w, clock } = world(on, { pct: 52 })
  on('session.end', ($, e) => ({ sessionId: e.sessionId })) // nothing beneath answers it otherwise
  await start($)
  await queueAndEnd($)
  await clock.advance(1600)
  w.pct = 51
  expect((await $.tool.call(read)).context ?? []).toEqual([]) // lifted to 61
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: undefined } as never)
  w.pct = 55
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Context is at 55% of the window\. Compact at a comfortable moment before 60%/)
})

// 0.3.6: the handoff comes back in the continue prompt itself, and the one request after compact_now is answered by
// the mod. Before 0.3.6 the prompt only named the file and asked Claude to read it; in a 2026-10-18 benchmark Claude
// never did (0 of 10 compactions), so the handoff turns were pure cost.

const landed = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, turnId = 't1') => {
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId, answer: 'ok', durationMs: 1 })
  await clock.advance(1600) // the timer compacts
  await clock.advance(1600) // and sends the continue prompt
}

test('a note comes back word for word in the continue prompt, and a copy is saved in the state folder', async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  await start($)
  const note = 'Task: tickets T01-T40.\nDone: T01-T09, tests green.\nNext: T10 (westbrook), then T11.'
  const q = await $.tool.call({ tool: TOOL, note, keep: 'the ticket list' } as never)
  expect(String(q.result)).toMatch(/Compaction queued\. End your reply now/)
  const saved = [...w.files].find(([p]) => /state\/catnap\/sess-1\.handoff\.md$/.test(slash(p)))
  expect(saved?.[1]).toBe(`${note}\n`)
  await landed($, clock)
  expect(w.compacts.length).toBe(1)
  expect(w.compacts[0] ?? '').toMatch(/the ticket list/)
  expect(w.compacts[0] ?? '').toMatch(/gets its own handoff back, word for word/)
  expect(w.prompts.length).toBe(1)
  const p = w.prompts[0] ?? ''
  expect(p).toMatch(/^\[catnap\] The conversation was just compacted at your request \(context had reached 64%\)\. Here is the handoff you wrote just before it \(saved in .*sess-1\.handoff\.md\):/)
  expect(p).toContain(`<handoff>\n${note}\n</handoff>`)
  expect(p).toMatch(/Carry on exactly where you left off, with the next step it names\./)
  expect(p).not.toMatch(/Read it first/)
})

test("a handoff file comes back word for word (a save step's file), and nothing is written beside it", async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  w.files.set('C:/p/.claude/handoffs/x.md', 'RESUME - the mod build\nNext: step 3 of the plan\n')
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'C:/p/.claude/handoffs/x.md', keep: 'the mod build' } as never)
  expect([...w.files.keys()].some(k => /handoff\.md$/.test(k))).toBe(false)
  await landed($, clock)
  const p = w.prompts[0] ?? ''
  expect(p).toContain('Here is the handoff you wrote just before it (saved in C:/p/.claude/handoffs/x.md):')
  expect(p).toContain('<handoff>\nRESUME - the mod build\nNext: step 3 of the plan\n</handoff>')
  expect(w.compacts[0] ?? '').toMatch(/The full state is saved in C:\/p\/\.claude\/handoffs\/x\.md/)
})

test('a handoff file that cannot be read: the prompt names it and asks Claude to read it, as before', async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'C:/nowhere/h.md', keep: 'k' } as never)
  await landed($, clock)
  const p = w.prompts[0] ?? ''
  expect(p).toMatch(/Your handoff: C:\/nowhere\/h\.md\. Read it first, then carry on exactly where you left off/)
  expect(p).not.toContain('<handoff>')
})

test('a long handoff is cut at PASTE_MAX, and the prompt says where the rest is', async ($, on) => {
  const { w, clock } = world(on, { pct: 64 })
  w.files.set('C:/p/long.md', `${'a'.repeat(PASTE_MAX)}TAIL-NOT-PASTED`)
  await start($)
  await $.tool.call({ tool: TOOL, handoff: 'C:/p/long.md', keep: 'k' } as never)
  await landed($, clock)
  const p = w.prompts[0] ?? ''
  expect(p).toContain(`[cut here at ${PASTE_MAX} characters: read the rest in C:/p/long.md before you go on]`)
  expect(p).not.toContain('TAIL-NOT-PASTED')
  expect(p.length).toBeLessThan(PASTE_MAX + 1000)
})

// The model beneath every turn.step: records the requests that reached it.
const model = (on: On) => {
  const calls: { turnId: string; index: number }[] = []
  on('turn.step', async function* ($, e) {
    calls.push({ turnId: e.turnId, index: e.index })
    yield { kind: 'text' as const, index: 0, text: 'from the model' }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'from the model', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return calls
}

const step = async ($: Engine, turnId: string, index: number, agentId?: string) => {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 10 + index, ...(agentId ? { agentId } : {}) })
  const texts: string[] = []
  // read by hand to the end: the generator's own return value is the step's result as the engine gets it
  let r = await stream.next()
  while (!r.done) {
    if (r.value.kind === 'text') texts.push(r.value.text)
    r = await stream.next()
  }
  return { text: texts.join(''), result: r.value }
}

test('the request after compact_now is answered by the mod, once, in that turn only', async ($, on) => {
  const { clock } = world(on, { pct: 64 })
  const calls = model(on)
  await start($)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  expect((await step($, 't1', 0)).text).toBe('from the model') // nothing queued: the model answers
  await $.tool.call({ tool: TOOL, note: 'n', keep: 'k' } as never)
  const nap = await step($, 't1', 1)
  expect(nap.text).toBe(NAP_REPLY)
  expect(nap.result.stopReason).toBe('end_turn')
  expect(nap.result.toolUses).toEqual([])
  expect(calls.length).toBe(1) // the request after compact_now never reached the model
  expect((await step($, 't1', 2)).text).toBe('from the model') // once only
  expect(calls.length).toBe(2)
  await clock.advance(1600)
})

test('the mod answers no request of a subagent, of another turn, or after the turn ended', async ($, on) => {
  const { clock } = world(on, { pct: 64 })
  const calls = model(on)
  await start($)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await $.tool.call({ tool: TOOL, note: 'n', keep: 'k' } as never)
  expect((await step($, 't1', 1, 'agent-7')).text).toBe('from the model') // a subagent's request in that turn
  expect((await step($, 't9', 0)).text).toBe('from the model') // another turn
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok', durationMs: 1 })
  expect((await step($, 't1', 2)).text).toBe('from the model') // the turn is over
  expect(calls.length).toBe(3)
  await clock.advance(1600)
})

test('a compact_now denied (no handoff) leaves the next request to the model', async ($, on) => {
  const { clock } = world(on, { pct: 64 })
  const calls = model(on)
  await start($)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await $.tool.call({ tool: TOOL, keep: 'k' } as never)
  expect((await step($, 't1', 1)).text).toBe('from the model')
  expect(calls.length).toBe(1)
  await clock.advance(1600)
})
