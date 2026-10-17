import type { On, RenderSurface } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { isHeadlessRefusal } from './register'

const TOOL = 'mcp__self-compact__compact_now'
const FLAG = /state\/self-compact\/sess-1\.json$/
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
const world = (on: On, init: Partial<World> = {}, env: Record<string, string> = { USERPROFILE: 'C:\\Users\\tester' }) => {
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
  mock.env(on, env)
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
  on('tool.register', ($, e) => ({ value: { tool: `mcp__self-compact__${e.name}` } }))
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
        'HooksError: self-compact: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on',
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
  return { w, clock, flag, release }
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
  w.files.set('X/state/self-compact/config.json', '{"soft": 60, "threshold": 60}')
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
  w.files.set('X/state/self-compact/config.json', '{"threshold": 25}')
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/the line is 25%/)
  w.files.set('X/state/self-compact/sess-1.config.json', '{"off": true}')
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
  expect([...w.files.keys()].map(slash)).toContain('D:/st/self-compact/sess-1.json')
})

const MSGS = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

const turnEnd = ($: Engine, turnId: string) =>
  $.turn.complete({ reason: 'answer', isAborted: false, turnId, answer: 'ok', durationMs: 1 })

const LIVE_REFUSAL =
  'HooksError: self-compact: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on'

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
  expect(w.toasts[0] ?? '').toMatch(/could not compact this chat \(\/compact was refused/)
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
  expect(w.toasts[0] ?? '').toMatch(/could not compact this chat \(\/compact did not compact within 10 minutes\)/)
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
  w.files.set('C:/Users/tester/.claude/state/self-compact/sess-1.json', '{"pending":true,"at":"2026-10-13T17:31:43.722Z","handoff":"h.md"}')
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
  w.files.set('X/state/self-compact/config.json', '{"threshold": 50}')
  await start($)
  expect((await $.tool.call(read)).context?.[0] ?? '').toMatch(/comfortable moment before 50%/)
})

test('SELF_COMPACT_OFF switches it off, even with a surface', async ($, on) => {
  const { w, clock } = world(on, { pct: 90 }, { USERPROFILE: 'C:\Users\tester', SELF_COMPACT_OFF: '1' })
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
