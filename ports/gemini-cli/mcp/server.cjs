#!/usr/bin/env node
'use strict'
// compact-when-ready MCP server for Gemini CLI: stdio, newline-delimited JSON-RPC 2.0, no dependencies, no network.
// One tool, compact_now. It cannot know which Gemini session called it, so it leaves an unscoped queued.json in the
// state folder; the AfterTool / AfterAgent hooks (which get the session id) claim it and do the clearing.
const path = require('node:path')
const root = process.env.CWR_ROOT ? path.resolve(process.env.CWR_ROOT) : path.resolve(__dirname, '..')
const lib = require(path.join(root, 'lib', 'cwr.cjs'))

const VERSION = '0.1.0'
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const TOOL_DEF = {
  name: lib.TOOL,
  description:
    'Resets this conversation once your turn ends, then sends you a message to read your handoff file and continue. ' +
    'Call it only after everything needed to pick the work up again is saved to a handoff file. After calling it, end ' +
    'your reply at once: no more tool calls and no more text.',
  inputSchema: {
    type: 'object',
    properties: {
      handoff: { type: 'string', description: 'Path of the handoff file you just saved.' },
      keep: { type: 'string', description: 'What must be remembered: the task, the next step, open decisions.' },
    },
    required: ['handoff'],
  },
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

const callTool = args => {
  const dir = lib.stateDirFor(process.env)
  const cfg = lib.loadConfig(dir, process.env)
  if (cfg.off) return text('compact-when-ready is switched off (COMPACT_WHEN_READY_OFF or config.json). Nothing was queued; carry on without it.')
  const handoff = String((args && args.handoff) || '').trim()
  const keep = String((args && args.keep) || '').trim()
  if (!handoff) return text('Save everything to a handoff file first, then call again with its path in "handoff".', true)
  try {
    lib.writeJson(lib.queuedFile(dir), { pending: true, at: new Date().toISOString(), handoff, keep, cwd: process.cwd(), pid: process.pid })
    lib.log(dir, 'mcp', 'mcp-queued', { handoff, cwd: process.cwd() })
  } catch (err) {
    return text(`Could not queue the reset (${String(err && err.message ? err.message : err).slice(0, 160)}). Your work is saved; carry on.`, true)
  }
  return text('Queued. End your turn now.')
}

const send = obj => process.stdout.write(JSON.stringify(obj) + '\n')

const handle = msg => {
  const { id, method, params } = msg
  const reply = result => id !== undefined && send({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } })
  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion
      return reply({
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: lib.SERVER_NAME, version: VERSION },
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: [TOOL_DEF] })
    case 'tools/call':
      if (!params || params.name !== lib.TOOL) return fail(-32602, `Unknown tool: ${params && params.name}`)
      return reply(callTool(params.arguments))
    default:
      if (id !== undefined) fail(-32601, `Method not found: ${method}`)
  }
}

if (require.main === module) {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        handle(JSON.parse(line))
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      }
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

module.exports = { handle, callTool, TOOL_DEF }
