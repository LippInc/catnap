'use strict'
// Tests for the hook script and the MCP server. They run the real scripts as child processes and feed them the
// stdin payloads Gemini CLI sends. CWR_ROOT points at the tree under test (default: this extension), which is how the
// planted-bug check runs the same tests against a broken copy.
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = process.env.CWR_ROOT ? path.resolve(process.env.CWR_ROOT) : path.resolve(__dirname, '..')
const HOOK = path.join(ROOT, 'hooks', 'hook.cjs')
const SERVER = path.join(ROOT, 'mcp', 'server.cjs')

const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cwr-test-'))
const baseEnv = dir => {
  const env = { ...process.env, COMPACT_WHEN_READY_STATE_DIR: dir }
  for (const k of Object.keys(env)) if (k.startsWith('COMPACT_WHEN_READY_') && k !== 'COMPACT_WHEN_READY_STATE_DIR') delete env[k]
  return env
}

const hook = (dir, payload, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { ...baseEnv(dir), ...extraEnv },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `hook exit ${r.status}: ${r.stderr}`)
  assert.equal(r.stderr, '', 'hooks must keep stderr quiet')
  const out = r.stdout.trim()
  assert.ok(out.split('\n').length === 1, 'exactly one JSON line on stdout')
  return JSON.parse(out)
}

const SID = 'sess-1'
const base = (event, extra = {}) => ({
  session_id: SID,
  transcript_path: '/tmp/t.json',
  cwd: '/work/proj',
  hook_event_name: event,
  timestamp: '2026-10-17T10:00:00Z',
  ...extra,
})
const afterModel = (tokens, extra = {}, model = 'test-model') => // unknown name: the 1,000,000 default window
  base('AfterModel', {
    llm_request: { model, messages: [] },
    llm_response: { candidates: [], usageMetadata: { promptTokenCount: tokens - 100, candidatesTokenCount: 100, totalTokenCount: tokens } },
    ...extra,
  })
const afterTool = (name = 'read_file', extra = {}) =>
  base('AfterTool', { tool_name: name, tool_input: { path: 'a.txt' }, tool_response: { llmContent: 'x' }, ...extra })
const compactNowTool = (handoff, extra = {}) =>
  base('AfterTool', {
    tool_name: 'mcp_compact-when-ready_compact_now',
    tool_input: { handoff, keep: 'the task' },
    tool_response: { llmContent: 'Queued. End your turn now.' },
    mcp_context: { server_name: 'compact-when-ready', tool_name: 'compact_now' },
    ...extra,
  })
const afterAgent = (extra = {}) => base('AfterAgent', { prompt: 'p', prompt_response: 'done', stop_hook_active: false, ...extra })

const pendingPath = dir => path.join(dir, `${SID}.pending.json`)
const readPending = dir => JSON.parse(fs.readFileSync(pendingPath(dir), 'utf8'))
const note = out => out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext
const readLog = dir =>
  fs
    .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))

// ---------- notes ----------

test('no note under the soft line', () => {
  const dir = newDir()
  hook(dir, afterModel(300_000)) // 30% of 1M
  assert.deepEqual(hook(dir, afterTool()), {})
  assert.deepEqual(hook(dir, base('BeforeAgent', { prompt: 'hi' })), {})
})

test('no note before any token reading exists', () => {
  const dir = newDir()
  assert.deepEqual(hook(dir, afterTool()), {})
})

test('one soft note at the soft line, then quiet until the strict line', () => {
  const dir = newDir()
  hook(dir, afterModel(520_000))
  const first = hook(dir, afterTool())
  assert.equal(first.hookSpecificOutput.hookEventName, 'AfterTool')
  assert.match(note(first), /\[compact-when-ready\] Context is at 52% of the window/)
  assert.match(note(first), /compact_now/)
  assert.match(note(first), /before 60%/)
  assert.deepEqual(hook(dir, afterTool()), {}, 'only one soft note')
  assert.deepEqual(hook(dir, base('BeforeAgent', { prompt: 'hi' })), {}, 'BeforeAgent shares the same once-only note')
  hook(dir, afterModel(580_000))
  assert.deepEqual(hook(dir, afterTool()), {}, 'still under the strict line')
})

test('the soft note can ride on BeforeAgent when a turn starts past the line', () => {
  const dir = newDir()
  hook(dir, afterModel(540_000))
  const out = hook(dir, base('BeforeAgent', { prompt: 'hi' }))
  assert.equal(out.hookSpecificOutput.hookEventName, 'BeforeAgent')
  assert.match(note(out), /54%/)
})

test('strict note at the strict line, repeated every 2 points', () => {
  const dir = newDir()
  hook(dir, afterModel(610_000))
  const a = hook(dir, afterTool())
  assert.match(note(a), /Context is at 61% of the window \(the line is 60%\)/)
  assert.match(note(a), /Save and reset now/)
  hook(dir, afterModel(612_000)) // +0.2 points
  assert.deepEqual(hook(dir, afterTool()), {}, 'not yet 2 points further')
  hook(dir, afterModel(631_000)) // +2.1 points over the last note (61.0)
  assert.match(note(hook(dir, afterTool())), /63%/)
  hook(dir, afterModel(640_000))
  assert.deepEqual(hook(dir, afterTool()), {})
  hook(dir, afterModel(655_000))
  assert.match(note(hook(dir, afterTool())), /65%/)
})

test('a jump straight past the strict line gives the strict note, not the soft one', () => {
  const dir = newDir()
  hook(dir, afterModel(700_000))
  assert.match(note(hook(dir, afterTool())), /Save and reset now/)
})

test('soft at or above strict turns the soft note off', () => {
  const dir = newDir()
  hook(dir, afterModel(550_000), { COMPACT_WHEN_READY_SOFT: '60' })
  assert.deepEqual(hook(dir, afterTool(), { COMPACT_WHEN_READY_SOFT: '60' }), {})
})

test('usage metadata with only promptTokenCount still counts', () => {
  const dir = newDir()
  hook(dir, base('AfterModel', { llm_request: { model: 'test-model' }, llm_response: { usageMetadata: { promptTokenCount: 530_000 } } }))
  assert.match(note(hook(dir, afterTool())), /53%/)
})

test('chunks without usage metadata change nothing', () => {
  const dir = newDir()
  hook(dir, afterModel(520_000))
  hook(dir, base('AfterModel', { llm_request: { model: 'test-model' }, llm_response: { candidates: [] } }))
  assert.match(note(hook(dir, afterTool())), /52%/)
})

// ---------- window and config ----------

test('window comes from the model table, and an explicit window wins', () => {
  const dir = newDir()
  hook(dir, afterModel(520_000, {}, 'gemini-1.5-pro')) // 2,097,152 window -> 24.8%
  assert.deepEqual(hook(dir, afterTool()), {})
  const dir2 = newDir()
  hook(dir2, afterModel(520_000, {}, 'gemini-2.5-pro'), { COMPACT_WHEN_READY_WINDOW: '2000000' }) // 26%
  assert.deepEqual(hook(dir2, afterTool(), { COMPACT_WHEN_READY_WINDOW: '2000000' }), {})
  const dir3 = newDir()
  hook(dir3, afterModel(130_000, {}, 'unknown-model-x'), { COMPACT_WHEN_READY_WINDOW: '200000' }) // 65%
  assert.match(note(hook(dir3, afterTool(), { COMPACT_WHEN_READY_WINDOW: '200000' })), /Save and reset now/)
})

test('known Gemini models use their table window (gemini-2.5-pro: 1,048,576)', () => {
  const dir = newDir()
  hook(dir, afterModel(520_000, {}, 'gemini-2.5-pro')) // 49.6%
  assert.deepEqual(hook(dir, afterTool()), {})
  hook(dir, afterModel(530_000, {}, 'gemini-2.5-pro')) // 50.5%
  assert.match(note(hook(dir, afterTool())), /50%/)
})

test('unknown model with no option uses the 1,000,000 default', () => {
  const dir = newDir()
  hook(dir, afterModel(520_000, {}, 'some-other-model'))
  assert.match(note(hook(dir, afterTool())), /52%/)
})

test('config.json in the state folder moves the lines; env wins over it', () => {
  const dir = newDir()
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ soft: 10, strict: 80 }))
  hook(dir, afterModel(120_000))
  assert.match(note(hook(dir, afterTool())), /12%/)
  const dir2 = newDir()
  fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({ soft: 10, strict: 80 }))
  hook(dir2, afterModel(120_000), { COMPACT_WHEN_READY_SOFT: '30' })
  assert.deepEqual(hook(dir2, afterTool(), { COMPACT_WHEN_READY_SOFT: '30' }), {})
})

test('a broken config.json leaves the defaults', () => {
  const dir = newDir()
  fs.writeFileSync(path.join(dir, 'config.json'), '{not json')
  hook(dir, afterModel(520_000))
  assert.match(note(hook(dir, afterTool())), /52%/)
})

test('COMPACT_WHEN_READY_OFF switches every hook off, including the clear', () => {
  const dir = newDir()
  const off = { COMPACT_WHEN_READY_OFF: '1' }
  hook(dir, afterModel(700_000), off)
  assert.deepEqual(hook(dir, afterTool(), off), {})
  // a flag exists (set while it was on) but off wins
  hook(dir, compactNowTool('h.md'))
  assert.deepEqual(hook(dir, afterAgent(), off), {})
  assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), true)
})

test('config.json off:true also switches it off', () => {
  const dir = newDir()
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ off: true }))
  hook(dir, afterModel(700_000))
  assert.deepEqual(hook(dir, afterTool()), {})
})

// ---------- compact_now and the clear ----------

test('compact_now through the AfterTool hook sets the session flag with the handoff', () => {
  const dir = newDir()
  assert.deepEqual(hook(dir, compactNowTool('notes/handoff.md')), {})
  const p = readPending(dir)
  assert.equal(p.handoff, 'notes/handoff.md')
  assert.ok(Date.parse(p.queuedAt) > Date.now() - 60_000)
})

test('while queued, other tool results carry the end-your-turn reminder and no other notes', () => {
  const dir = newDir()
  hook(dir, afterModel(700_000))
  hook(dir, compactNowTool('h.md'))
  const out = hook(dir, afterTool())
  assert.match(note(out), /The reset is queued\. End your reply now/)
})

test('AfterAgent with the flag: deny + reason + clearContext, then the flag is gone', () => {
  const dir = newDir()
  hook(dir, afterModel(650_000))
  hook(dir, compactNowTool('notes/handoff.md'))
  const out = hook(dir, afterAgent())
  assert.equal(out.decision, 'deny')
  assert.equal(
    out.reason,
    'The conversation was just cleared at your request. Your handoff: notes/handoff.md. Read it first, then carry on exactly where you left off.',
  )
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'AfterAgent', clearContext: true })
  const st = JSON.parse(fs.readFileSync(path.join(dir, `${SID}.json`), 'utf8'))
  assert.equal(fs.existsSync(pendingPath(dir)), false, 'the pending file is removed by the clear')
  assert.equal(st.tokens, 0, 'the old reading is dropped so the continuation does not get a stale note')
  assert.deepEqual(hook(dir, afterAgent()), {}, 'the flag is cleared: the next turn end is allowed')
  assert.deepEqual(hook(dir, base('BeforeAgent', { prompt: 'x' })), {}, 'no stale note after the clear')
  assert.ok(readLog(dir).some(e => e.kind === 'cleared' && e.handoff === 'notes/handoff.md'))
})

test('AfterAgent with stop_hook_active true does nothing and keeps the flag', () => {
  const dir = newDir()
  hook(dir, compactNowTool('h.md'))
  assert.deepEqual(hook(dir, afterAgent({ stop_hook_active: true })), {})
  assert.equal(readPending(dir).handoff, 'h.md')
  // the next normal turn end then clears
  assert.equal(hook(dir, afterAgent()).decision, 'deny')
})

test('AfterAgent without the flag allows the turn to end', () => {
  const dir = newDir()
  hook(dir, afterModel(700_000))
  const out = hook(dir, afterAgent())
  assert.deepEqual(out, {})
  assert.notEqual(out.decision, 'deny')
})

test('the flag is per session', () => {
  const dir = newDir()
  hook(dir, compactNowTool('h.md'))
  assert.deepEqual(hook(dir, { ...afterAgent(), session_id: 'other' }), {})
  assert.equal(hook(dir, afterAgent()).decision, 'deny')
})

// ---------- the MCP server ----------

const rpc = (dir, messages, extraEnv = {}, cwd = os.tmpdir()) => {
  const r = spawnSync(process.execPath, [SERVER], {
    input: messages.map(m => JSON.stringify(m)).join('\n') + '\n',
    env: { ...baseEnv(dir), ...extraEnv },
    encoding: 'utf8',
    cwd,
  })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l))
}
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }
const INITED = { jsonrpc: '2.0', method: 'notifications/initialized' }
const call = (id, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'compact_now', arguments: args } })

test('MCP server: initialize, list the tool, answer compact_now and leave the flag', () => {
  const dir = newDir()
  const out = rpc(dir, [INIT, INITED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, call(3, { handoff: 'notes/h.md', keep: 'task' })])
  assert.equal(out.length, 3, 'a notification gets no reply')
  assert.equal(out[0].result.protocolVersion, '2025-06-18')
  assert.equal(out[0].result.serverInfo.name, 'compact-when-ready')
  assert.equal(out[1].result.tools[0].name, 'compact_now')
  assert.deepEqual(out[1].result.tools[0].inputSchema.required, ['handoff'])
  assert.equal(out[2].result.content[0].text, 'Queued. End your turn now.')
  const q = JSON.parse(fs.readFileSync(path.join(dir, 'queued.json'), 'utf8'))
  assert.equal(q.pending, true)
  assert.equal(q.handoff, 'notes/h.md')
})

test('MCP flag alone is enough: AfterAgent claims it from the same project folder only', () => {
  const dir = newDir()
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cwr-proj-')) // the folder Gemini CLI is run in
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cwr-else-'))
  assert.notEqual(path.resolve(project), path.resolve(ROOT), 'the project is not the extension folder')
  rpc(dir, [INIT, call(2, { handoff: 'notes/h.md' })], {}, project)
  assert.deepEqual(hook(dir, afterAgent({ cwd: elsewhere })), {}, 'a session in another folder must not claim it')
  const out2 = hook(dir, afterAgent({ cwd: project }))
  assert.equal(out2.decision, 'deny')
  assert.match(out2.reason, /notes\/h\.md/)
  assert.equal(fs.existsSync(path.join(dir, 'queued.json')), false, 'the unscoped flag is consumed')
})

// The server is started the way gemini-extension.json says: the manifest's cwd if it has one, else (nothing set) the
// folder Gemini CLI itself runs in, which is the project folder (StdioClientTransport spawns with cwd undefined, and the
// hooks' cwd is config.getWorkingDir() = process.cwd(); read in the 0.64.0 bundle).
test('MCP server started as the manifest says records the project folder, so the AfterAgent backup claim can fire', () => {
  const dir = newDir()
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cwr-proj-'))
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'gemini-extension.json'), 'utf8'))
  const srv = manifest.mcpServers['compact-when-ready']
  const hydrate = v => String(v).split('${extensionPath}').join(ROOT).split('${/}').join(path.sep)
  const spawnCwd = srv.cwd ? hydrate(srv.cwd) : project
  const msgs = [INIT, call(2, { handoff: 'notes/h.md' })]
  const r = spawnSync(srv.command === 'node' ? process.execPath : srv.command, (srv.args || []).map(hydrate), {
    input: msgs.map(m => JSON.stringify(m)).join('\n') + '\n',
    env: baseEnv(dir),
    encoding: 'utf8',
    cwd: spawnCwd,
  })
  assert.equal(r.status, 0, r.stderr)
  const q = JSON.parse(fs.readFileSync(path.join(dir, 'queued.json'), 'utf8'))
  assert.equal(fs.realpathSync(q.cwd), fs.realpathSync(project), 'the server must record the project folder, not the extension folder')
  const out = hook(dir, afterAgent({ cwd: project }))
  assert.equal(out.decision, 'deny', 'the hook, in the project folder, claims the flag the server left')
})

test('the manifest sets no cwd on the MCP server (it would pin the server to the extension folder)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'gemini-extension.json'), 'utf8'))
  for (const [name, srv] of Object.entries(manifest.mcpServers)) assert.equal(srv.cwd, undefined, `${name} has a cwd`)
})

test('a stale MCP flag (older than 10 minutes) is not claimed', () => {
  const dir = newDir()
  fs.writeFileSync(path.join(dir, 'queued.json'), JSON.stringify({ pending: true, at: new Date(Date.now() - 11 * 60_000).toISOString(), handoff: 'old.md' }))
  assert.deepEqual(hook(dir, afterAgent()), {})
})

test('MCP server: no handoff is an error result and queues nothing', () => {
  const dir = newDir()
  const out = rpc(dir, [INIT, call(2, {})])
  assert.equal(out[1].result.isError, true)
  assert.equal(fs.existsSync(path.join(dir, 'queued.json')), false)
})

test('MCP server: off answers without queueing; unknown tool and method are errors', () => {
  const dir = newDir()
  const out = rpc(dir, [INIT, call(2, { handoff: 'h.md' })], { COMPACT_WHEN_READY_OFF: '1' })
  assert.match(out[1].result.content[0].text, /switched off/)
  assert.equal(fs.existsSync(path.join(dir, 'queued.json')), false)
  const out2 = rpc(dir, [INIT, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } }, { jsonrpc: '2.0', id: 6, method: 'bogus' }])
  assert.equal(out2[1].error.code, -32602)
  assert.equal(out2[2].error.code, -32601)
})

// ---------- housekeeping events ----------

test('a drop of 20+ points (Gemini CLI compressed by itself) starts the note cycle over', () => {
  const dir = newDir()
  hook(dir, afterModel(520_000))
  assert.match(note(hook(dir, afterTool())), /52%/)
  hook(dir, afterModel(150_000))
  assert.ok(readLog(dir).some(e => e.kind === 'compacted-elsewhere'))
  hook(dir, afterModel(530_000))
  assert.match(note(hook(dir, afterTool())), /53%/, 'soft note is given again in the new cycle')
})

test('PreCompress does not reset the cycle (Gemini CLI fires it at every compression check, live run 0.64.0)', () => {
  const dir = newDir()
  hook(dir, afterModel(520_000))
  assert.match(note(hook(dir, afterTool())), /52%/)
  // the live CLI sent PreCompress (trigger auto) before every follow-up request, with nothing compressed
  hook(dir, base('PreCompress', { trigger: 'auto' }))
  hook(dir, afterModel(525_000, { llm_response: { candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 525_000 } } }))
  hook(dir, base('PreCompress', { trigger: 'auto' }))
  assert.deepEqual(hook(dir, afterTool()), {}, 'the soft note is not given again')
  hook(dir, base('PreCompress', { trigger: 'auto' }))
  hook(dir, afterModel(530_000))
  assert.deepEqual(hook(dir, base('BeforeAgent', { prompt: 'next' })), {}, 'nor on the next turn')
  assert.equal(readLog(dir).filter(e => e.kind === 'soft-note').length, 1)
  assert.ok(!fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8').includes('PreCompress'), 'not registered: it would only cost a process start per check')
})

test('SessionStart drops a stale flag', () => {
  const dir = newDir()
  hook(dir, compactNowTool('h.md'))
  hook(dir, base('SessionStart', { source: 'clear' }))
  assert.deepEqual(hook(dir, afterAgent()), {}, 'a new session start drops a stale flag')
})

// ---------- AfterModel fires once per streamed chunk ----------

const chunk = (tokens, finishReason) =>
  afterModel(tokens, { llm_response: { candidates: [{ content: { role: 'model', parts: ['x'] }, ...(finishReason ? { finishReason } : {}) }], usageMetadata: { totalTokenCount: tokens } } })

test('an intermediate stream chunk (candidates, no finishReason) does no work and leaves no state; the last chunk is recorded', () => {
  const dir = newDir()
  assert.deepEqual(hook(dir, chunk(520_000)), {})
  assert.equal(fs.existsSync(path.join(dir, `${SID}.json`)), false, 'no state file written for an intermediate chunk')
  assert.deepEqual(hook(dir, afterTool()), {}, 'and so no note yet')
  assert.deepEqual(hook(dir, chunk(520_000, 'STOP')), {})
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${SID}.json`), 'utf8')).tokens, 520_000)
  assert.match(note(hook(dir, afterTool())), /52%/)
})

test('a trailing usage-only chunk (no candidates) is still recorded', () => {
  const dir = newDir()
  hook(dir, afterModel(520_000)) // candidates: []
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${SID}.json`), 'utf8')).tokens, 520_000)
})

test('hooks print one JSON object and exit 0 on garbage, empty and unknown input', () => {
  const dir = newDir()
  assert.deepEqual(hook(dir, 'not json'), {})
  assert.deepEqual(hook(dir, ''), {})
  assert.deepEqual(hook(dir, { hook_event_name: 'SomethingNew', session_id: 'x' }), {})
  assert.deepEqual(hook(dir, { hook_event_name: 'AfterModel' }), {})
})

test('events are logged as JSON lines in the state folder', () => {
  const dir = newDir()
  hook(dir, afterModel(520_000))
  hook(dir, afterTool())
  hook(dir, compactNowTool('h.md'))
  hook(dir, afterAgent())
  const kinds = readLog(dir).map(e => e.kind)
  assert.deepEqual(kinds, ['soft-note', 'queued', 'cleared'])
  for (const e of readLog(dir)) assert.ok(e.at && e.sid === SID)
})

// ---------- review fixes: pending flag in its own file, subagent readings, repeated clears, expiry, pruning ----------

const hookAsync = (dir, payload) =>
  new Promise((resolve, reject) => {
    const { spawn } = require('node:child_process')
    const p = spawn(process.execPath, [HOOK], { env: baseEnv(dir) })
    let out = ''
    p.stdout.on('data', d => (out += d))
    p.on('error', reject)
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`hook exit ${code}`))))
    p.stdin.end(JSON.stringify(payload))
  })

test('a stale full-state write after compact_now cannot lose the pending reset (parallel hooks)', () => {
  const dir = newDir()
  hook(dir, afterModel(300_000))
  const stale = fs.readFileSync(path.join(dir, `${SID}.json`), 'utf8') // what a read_file hook read before compact_now
  hook(dir, compactNowTool('notes/handoff.md'))
  fs.writeFileSync(path.join(dir, `${SID}.json`), stale) // ... and wrote back after it, as the old code did
  const out = hook(dir, afterAgent())
  assert.equal(out.decision, 'deny', 'the reset survives a late write of the session state')
  assert.match(out.reason, /notes\/handoff\.md/)
})

test('really parallel hook processes (compact_now among reads and model readings) still end in a clear', async () => {
  const dir = newDir()
  hook(dir, afterModel(520_000))
  for (let round = 0; round < 3; round++) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cwr-par-'))
    fs.copyFileSync(path.join(dir, `${SID}.json`), path.join(d, `${SID}.json`))
    await Promise.all([
      hookAsync(d, afterTool()),
      hookAsync(d, afterTool('write_file')),
      hookAsync(d, compactNowTool('notes/h.md')),
      hookAsync(d, afterModel(525_000 + round)),
      hookAsync(d, afterTool()),
      hookAsync(d, afterTool('list_directory')),
    ])
    assert.equal(hook(d, afterAgent()).decision, 'deny', `round ${round}: the clear happened`)
  }
})

test('the pending reset is written only by compact_now: notes and readings leave the file alone', () => {
  const dir = newDir()
  hook(dir, compactNowTool('notes/handoff.md'))
  const before = fs.readFileSync(pendingPath(dir), 'utf8')
  hook(dir, afterModel(700_000))
  hook(dir, afterTool())
  hook(dir, afterTool('write_file'))
  assert.equal(fs.readFileSync(pendingPath(dir), 'utf8'), before)
})

// -- subagent chats --

const MAIN_FIRST =
  "<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\nToday's date is Saturday, October 17, 2026 (formatted according to the user's locale).\nMy operating system is: win32\n</session_context>"
const MAIN_MSGS = [{ role: 'user', content: MAIN_FIRST }, { role: 'user', content: 'do the task' }]
const SUB_MSGS = [{ role: 'user', content: 'Your task: find every TODO in the repo.' }]
const chatReading = (tokens, messages, model = 'test-model') =>
  base('AfterModel', {
    llm_request: { model, messages },
    llm_response: { candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: tokens } },
  })

test('a subagent chat (same session id and model, small first reading) is not taken for a compression', () => {
  const dir = newDir()
  hook(dir, chatReading(520_000, MAIN_MSGS))
  assert.match(note(hook(dir, afterTool())), /52%/)
  hook(dir, chatReading(40_000, SUB_MSGS)) // the subagent's first call: 48 points below the main reading
  hook(dir, chatReading(60_000, SUB_MSGS))
  assert.equal(readLog(dir).filter(e => e.kind === 'compacted-elsewhere').length, 0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${SID}.json`), 'utf8')).tokens, 520_000, 'the main reading stands')
  hook(dir, chatReading(530_000, MAIN_MSGS))
  assert.deepEqual(hook(dir, afterTool()), {}, 'no second soft note')
  assert.deepEqual(hook(dir, base('BeforeAgent', { prompt: 'next' })), {})
  assert.equal(readLog(dir).filter(e => e.kind === 'soft-note').length, 1)
})

test('a big subagent reading does not trigger notes for the main chat', () => {
  const dir = newDir()
  hook(dir, chatReading(100_000, MAIN_MSGS))
  hook(dir, chatReading(900_000, SUB_MSGS))
  assert.deepEqual(hook(dir, afterTool()), {})
})

test('a real fall in the main chat (same first message) still starts the cycle over', () => {
  const dir = newDir()
  hook(dir, chatReading(520_000, MAIN_MSGS))
  assert.match(note(hook(dir, afterTool())), /52%/)
  hook(dir, chatReading(150_000, MAIN_MSGS))
  assert.equal(readLog(dir).filter(e => e.kind === 'compacted-elsewhere').length, 1)
  hook(dir, chatReading(530_000, MAIN_MSGS))
  assert.match(note(hook(dir, afterTool())), /53%/)
})

test('before the main chat has been seen, no reading is thrown away (a version without the environment context)', () => {
  const dir = newDir()
  hook(dir, chatReading(520_000, SUB_MSGS))
  assert.match(note(hook(dir, afterTool())), /52%/)
})

// -- repeated clears --

const lastClearBack = (dir, ms) => {
  const f = path.join(dir, `${SID}.json`)
  const st = JSON.parse(fs.readFileSync(f, 'utf8'))
  st.lastClearAt = new Date(Date.now() - ms).toISOString()
  fs.writeFileSync(f, JSON.stringify(st))
}

test('a second clear within 2 minutes of the last, with a small context, is refused and the flag dropped', () => {
  const dir = newDir()
  hook(dir, afterModel(650_000))
  hook(dir, compactNowTool('h.md'))
  assert.equal(hook(dir, afterAgent()).decision, 'deny') // the clear
  hook(dir, afterModel(20_000)) // the continuation, small context
  hook(dir, compactNowTool('h2.md'))
  assert.deepEqual(hook(dir, afterAgent()), {}, 'refused')
  assert.equal(fs.existsSync(pendingPath(dir)), false, 'the flag is dropped')
  assert.equal(readLog(dir).filter(e => e.kind === 'clear-refused').length, 1)
  assert.equal(readLog(dir).filter(e => e.kind === 'cleared').length, 1)
  assert.deepEqual(hook(dir, afterAgent()), {}, 'and the next turn end is allowed too')
})

test('a clear right after a clear is allowed when the context is already past the soft line', () => {
  const dir = newDir()
  hook(dir, compactNowTool('h.md'))
  assert.equal(hook(dir, afterAgent()).decision, 'deny')
  hook(dir, afterModel(20_000)) // the first reading after the clear: 2%
  hook(dir, afterModel(550_000)) // 55%: over the 50% soft line and far above where the cleared context started
  hook(dir, compactNowTool('h2.md'))
  assert.equal(hook(dir, afterAgent()).decision, 'deny')
})

test('a cleared context that already sits above the soft line (small window) cannot be cleared again at once', () => {
  const dir = newDir()
  const cfg = { COMPACT_WHEN_READY_WINDOW: '40000', COMPACT_WHEN_READY_SOFT: '20', COMPACT_WHEN_READY_STRICT: '35' }
  hook(dir, compactNowTool('h.md'), cfg)
  assert.equal(hook(dir, afterAgent(), cfg).decision, 'deny')
  hook(dir, afterModel(10_300), cfg) // 26%: the base prompt alone is over the 20% soft line
  hook(dir, afterModel(12_800), cfg) // 32%: grown 6 points
  hook(dir, compactNowTool('h2.md'), cfg)
  assert.deepEqual(hook(dir, afterAgent(), cfg), {}, 'refused: not past the soft line by anything but the base')
  assert.equal(readLog(dir).filter(e => e.kind === 'clear-refused').length, 1)
})

test('after 2 minutes a new clear is allowed again', () => {
  const dir = newDir()
  hook(dir, compactNowTool('h.md'))
  assert.equal(hook(dir, afterAgent()).decision, 'deny')
  lastClearBack(dir, 3 * 60_000)
  hook(dir, afterModel(20_000))
  hook(dir, compactNowTool('h2.md'))
  assert.equal(hook(dir, afterAgent()).decision, 'deny')
})

// -- a pending reset that nobody honoured --

test('a new user turn (BeforeAgent) drops a reset left over from a cancelled turn', () => {
  const dir = newDir()
  hook(dir, afterModel(300_000))
  hook(dir, compactNowTool('h.md')) // the user cancels right after this; no AfterAgent runs
  hook(dir, base('BeforeAgent', { prompt: 'something else' }))
  assert.equal(fs.existsSync(pendingPath(dir)), false)
  assert.ok(readLog(dir).some(e => e.kind === 'pending-dropped' && e.handoff === 'h.md'))
  assert.equal(note(hook(dir, afterTool())), undefined, 'the new turn is not told to end its reply')
  assert.deepEqual(hook(dir, afterAgent()), {}, 'and is not cleared')
})

test('a pending reset older than 10 minutes expires', () => {
  const dir = newDir()
  hook(dir, compactNowTool('h.md'))
  const p = readPending(dir)
  p.queuedAt = new Date(Date.now() - 11 * 60_000).toISOString()
  fs.writeFileSync(pendingPath(dir), JSON.stringify(p))
  assert.equal(note(hook(dir, afterTool())), undefined)
  assert.deepEqual(hook(dir, afterAgent()), {})
  assert.ok(readLog(dir).some(e => e.kind === 'pending-expired'))
  assert.equal(fs.existsSync(pendingPath(dir)), false)
})

test("the clear's own continuation request (BeforeAgent after the deny) is not affected", () => {
  const dir = newDir()
  hook(dir, compactNowTool('h.md'))
  assert.equal(hook(dir, afterAgent()).decision, 'deny')
  assert.deepEqual(hook(dir, base('BeforeAgent', { prompt: 'The conversation was just cleared at your request.' })), {})
  assert.equal(readLog(dir).filter(e => e.kind === 'pending-dropped').length, 0)
  // a compact_now in the continuation turn (stop_hook_active true) keeps its flag until the turn really ends
  hook(dir, afterModel(20_000))
  hook(dir, afterModel(700_000))
  hook(dir, compactNowTool('h2.md'))
  assert.deepEqual(hook(dir, afterAgent({ stop_hook_active: true })), {})
  assert.equal(readPending(dir).handoff, 'h2.md')
})

test("a new turn also drops the MCP server's unscoped flag from the same project, and leaves another project alone", () => {
  const dir = newDir()
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cwr-proj-'))
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cwr-other-'))
  rpc(dir, [INIT, call(2, { handoff: 'notes/h.md' })], {}, project)
  hook(dir, base('BeforeAgent', { prompt: 'x', cwd: other }))
  assert.equal(fs.existsSync(path.join(dir, 'queued.json')), true, "another project's flag stays")
  hook(dir, base('BeforeAgent', { prompt: 'x', cwd: project }))
  assert.equal(fs.existsSync(path.join(dir, 'queued.json')), false)
  assert.deepEqual(hook(dir, afterAgent({ cwd: project })), {})
})

// -- housekeeping --

test('SessionStart deletes per-session files older than 7 days, and nothing else', () => {
  const dir = newDir()
  const old = new Date(Date.now() - 8 * 24 * 3600_000)
  const fresh = new Date(Date.now() - 6 * 24 * 3600_000)
  const put = (name, when, body = '{}') => {
    const f = path.join(dir, name)
    fs.writeFileSync(f, body)
    fs.utimesSync(f, when, when)
  }
  put('old-session.json', old)
  put('old-session.pending.json', old)
  put('recent-session.json', fresh)
  put('config.json', old, '{"soft":10}')
  put('queued.json', old)
  put('events.jsonl', old, '')
  put('notes.txt', old)
  fs.mkdirSync(path.join(dir, 'dir.json'))
  fs.utimesSync(path.join(dir, 'dir.json'), old, old)
  hook(dir, base('SessionStart', { source: 'startup' }))
  const left = fs.readdirSync(dir).sort()
  assert.deepEqual(left, ['config.json', 'dir.json', 'events.jsonl', 'notes.txt', 'queued.json', 'recent-session.json', `${SID}.json`].sort())
  assert.ok(readLog(dir).some(e => e.kind === 'state-pruned' && e.files === 2))
})

test("a note is not spent on a subagent's tool result: it waits for invoke_agent's result or the main chat's next reading", () => {
  const dir = newDir()
  hook(dir, chatReading(520_000, MAIN_MSGS)) // the main chat calls invoke_agent
  hook(dir, chatReading(40_000, SUB_MSGS)) // the subagent runs ...
  assert.deepEqual(hook(dir, afterTool('read_file')), {}, "... its read_file result must not take the main chat's note")
  assert.deepEqual(hook(dir, afterTool('complete_task')), {})
  assert.match(note(hook(dir, afterTool('invoke_agent'))), /52%/, "invoke_agent's result is the main chat's: the note goes there")
  // and with no invoke_agent result seen, the main chat's next reading is enough
  const dir2 = newDir()
  hook(dir2, chatReading(520_000, MAIN_MSGS))
  hook(dir2, chatReading(40_000, SUB_MSGS))
  assert.deepEqual(hook(dir2, afterTool('read_file')), {})
  hook(dir2, chatReading(521_000, MAIN_MSGS))
  assert.match(note(hook(dir2, afterTool('read_file'))), /52%/)
})
