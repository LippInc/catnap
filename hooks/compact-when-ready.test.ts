import type { On, RenderSurface } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { autoTarget, isHeadlessRefusal, parseConfig } from './register'

const TOOL = 'mcp__compact-when-ready__compact_now'
const FLAG = /state\/compact-when-ready\/sess-1\.json$/
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
  on('tool.register', ($, e) => ({ value: { tool: `mcp__compact-when-ready__${e.name}` } }))
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
        'HooksError: compact-when-ready: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on',
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
  expect(soft).toMatch(/save the handoff file/)
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
  w.files.set('X/state/compact-when-ready/config.json', '{"soft": 60, "threshold": 60}')
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
  expect(first.context?.[0] ?? '').toMatch(/write a handoff file, or update the one this project already uses/)
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
  w.files.set('X/state/compact-when-ready/config.json', '{"threshold": 25}')
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/the line is 25%/)
  w.files.set('X/state/compact-when-ready/sess-1.config.json', '{"off": true}')
  w.pct = 40
  expect((await $.tool.call(read)).context ?? []).toEqual([])
})

test('compact_now without a handoff path is refused', async ($, on) => {
  world(on, { pct: 64 })
  await start($)
  const r = await $.tool.call({ tool: TOOL, handoff: '  ', keep: 'k' } as never)
  expect(r.deny ?? '').toMatch(/Save everything first/)
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
  expect([...w.files.keys()].map(slash)).toContain('D:/st/compact-when-ready/sess-1.json')
})

const MSGS = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

const turnEnd = ($: Engine, turnId: string) =>
  $.turn.complete({ reason: 'answer', isAborted: false, turnId, answer: 'ok', durationMs: 1 })

const LIVE_REFUSAL =
  'HooksError: compact-when-ready: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on'

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
  expect(w.toasts[0] ?? '').toMatch(/^could not compact this chat \(\/compact was refused/) // the host adds "compact-when-ready:"
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
  w.pct = 61
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/Save and compact now/)
})

test('a reload clears a queued flag the old module left behind', async ($, on) => {
  const { w, clock, flag } = world(on, { pct: 10 })
  w.files.set('C:/Users/tester/.claude/state/compact-when-ready/sess-1.json', '{"pending":true,"at":"2026-10-13T17:31:43.722Z","handoff":"h.md"}')
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
  w.files.set('X/state/compact-when-ready/config.json', '{"threshold": 50}')
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/comfortable moment before 50%/)
})

test('COMPACT_WHEN_READY_OFF switches it off, even with a surface', async ($, on) => {
  const { w, clock } = world(on, { pct: 90 }, { USERPROFILE: 'C:\\Users\\tester', COMPACT_WHEN_READY_OFF: '1' })
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
const ORIG = 'COMPACT_WHEN_READY_AUTO_ORIG'
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
  w.files.set('X/state/compact-when-ready/config.json', '{"auto": 75}')
  await $.tool.call(read)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('75')
  w.files.set('X/state/compact-when-ready/config.json', '{"auto": 75, "off": true}')
  await $.tool.call(read)
  await clock.advance(1600)
  expect(vars.get(AUTO)).toBe('55')
})

test('off puts an unset variable back to unset, also after a reload', async ($, on) => {
  // a reload: the variable holds the mod's own 70, the marker says it was unset before
  const { w, clock, vars } = world(on, {}, { ...HOME, [AUTO]: '70', [ORIG]: '' })
  w.files.set('X/state/compact-when-ready/config.json', '{"off": true}')
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

test('COMPACT_WHEN_READY_OFF leaves the auto line alone, even with a surface', async ($, on) => {
  const { clock, vars } = world(on, { pct: 30 }, { ...HOME, COMPACT_WHEN_READY_OFF: '1' })
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
type LogEvent = { kind: string; via?: string; from?: number; to?: number; trigger?: string }
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
