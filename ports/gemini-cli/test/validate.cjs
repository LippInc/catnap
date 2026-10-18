'use strict'
// Checks gemini-extension.json and hooks/hooks.json against the shapes Gemini CLI documents and loads.
// Sources (Gemini CLI 0.64.0, read from the installed package): docs/extensions/reference.md, docs/hooks/reference.md,
// and the loader in the bundle (loadExtensionHooks / processHookDefinition / validateHookConfig / hydrateString).
// Usage: node validate.cjs [extension folder]   (default: the folder above this file)  Exit code 1 on any problem.
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
const problems = []
const bad = msg => problems.push(msg)

const HOOK_EVENTS = [
  'BeforeTool', 'AfterTool', 'BeforeAgent', 'Notification', 'AfterAgent', 'SessionStart', 'SessionEnd',
  'PreCompress', 'BeforeModel', 'AfterModel', 'BeforeToolSelection',
]
const VARIABLES = { extensionPath: root, workspacePath: path.join(root, 'workspace'), '/': path.sep, pathSeparator: path.sep }
const MANIFEST_KEYS = ['name', 'version', 'description', 'mcpServers', 'contextFileName', 'excludeTools', 'migratedTo', 'plan', 'settings', 'themes']
const MCP_KEYS = ['command', 'args', 'env', 'cwd', 'url', 'httpUrl', 'headers', 'tcp', 'timeout', 'trust', 'description', 'includeTools', 'excludeTools']
const HOOK_DEF_KEYS = ['matcher', 'sequential', 'hooks']
const HOOK_CFG_KEYS = ['type', 'command', 'name', 'timeout', 'description', 'env']

// the loader's hydrateString: ${key} -> value, an unknown key stays as written
const hydrate = s => s.replace(/\${(.*?)}/g, (m, k) => (VARIABLES[k] == null ? m : String(VARIABLES[k])))
const unknownVars = s => [...s.matchAll(/\${(.*?)}/g)].map(m => m[1]).filter(k => VARIABLES[k] == null)

const load = rel => {
  const file = path.join(root, rel)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    bad(`${rel}: cannot read or parse (${e.message})`)
    return null
  }
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
const checkKeys = (where, obj, allowed) => {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(`${where}: unknown key "${k}"`)
}
const checkStr = (where, v) => {
  if (typeof v !== 'string') return bad(`${where}: must be a string`)
  for (const k of unknownVars(v)) bad(`${where}: unknown variable \${${k}}`)
}

// ----- gemini-extension.json -----
const man = load('gemini-extension.json')
if (man) {
  if (!isObj(man)) bad('gemini-extension.json: must be an object')
  else {
    checkKeys('gemini-extension.json', man, MANIFEST_KEYS)
    if (typeof man.name !== 'string' || !/^[a-z0-9-]+$/.test(man.name)) bad('name: required, lowercase letters, numbers and dashes only')
    if (typeof man.version !== 'string' || !man.version) bad('version: required string')
    if (man.description !== undefined) checkStr('description', man.description)
    if (man.hooks !== undefined) bad('hooks must not be in gemini-extension.json (they go in hooks/hooks.json)')
    if (man.mcpServers !== undefined) {
      if (!isObj(man.mcpServers)) bad('mcpServers: must be an object')
      else
        for (const [name, s] of Object.entries(man.mcpServers)) {
          const w = `mcpServers.${name}`
          if (/_/.test(name)) bad(`${w}: server names should avoid underscores (tool names are mcp_<server>_<tool>)`)
          if (!isObj(s)) { bad(`${w}: must be an object`); continue }
          checkKeys(w, s, MCP_KEYS)
          if (s.trust !== undefined) bad(`${w}: "trust" is not supported in extensions`)
          if (!s.command && !s.url && !s.httpUrl) bad(`${w}: needs command, url or httpUrl`)
          if (s.command !== undefined) { checkStr(`${w}.command`, s.command); if (/\s/.test(s.command)) bad(`${w}.command: executable and arguments must be separate (use args)`) }
          if (s.args !== undefined) {
            if (!Array.isArray(s.args)) bad(`${w}.args: must be an array`)
            else s.args.forEach((a, i) => { checkStr(`${w}.args[${i}]`, a); const f = hydrate(a); if (path.isAbsolute(f) && !fs.existsSync(f)) bad(`${w}.args[${i}]: ${f} does not exist`) })
          }
          // a cwd would pin the server to that folder; the AfterAgent backup claim compares the server's folder with the project folder
          if (s.cwd !== undefined) bad(`${w}.cwd: must not be set (the server has to inherit Gemini CLI's working folder, the project folder)`)
        }
    }
  }
}

// ----- hooks/hooks.json -----
const hk = load('hooks/hooks.json')
let hookCommands = 0
if (hk) {
  if (!isObj(hk) || !isObj(hk.hooks)) bad('hooks/hooks.json: top level must be {"hooks": {<event>: [...]}}')
  else {
    checkKeys('hooks/hooks.json', hk, ['hooks'])
    for (const [event, defs] of Object.entries(hk.hooks)) {
      if (!HOOK_EVENTS.includes(event)) { bad(`hooks.${event}: not a Gemini CLI hook event`); continue }
      if (!Array.isArray(defs)) { bad(`hooks.${event}: must be an array of hook definitions`); continue }
      defs.forEach((d, i) => {
        const w = `hooks.${event}[${i}]`
        if (!isObj(d) || !Array.isArray(d.hooks)) return bad(`${w}: needs a "hooks" array`)
        checkKeys(w, d, HOOK_DEF_KEYS)
        if (d.matcher !== undefined && typeof d.matcher !== 'string') bad(`${w}.matcher: must be a string`)
        if (d.sequential !== undefined && typeof d.sequential !== 'boolean') bad(`${w}.sequential: must be a boolean`)
        d.hooks.forEach((h, j) => {
          const hw = `${w}.hooks[${j}]`
          if (!isObj(h)) return bad(`${hw}: must be an object`)
          checkKeys(hw, h, HOOK_CFG_KEYS)
          if (h.type !== 'command') bad(`${hw}.type: must be "command" (the only type documented for extensions)`)
          if (typeof h.command !== 'string' || !h.command.trim()) return bad(`${hw}.command: required non-empty string`)
          checkStr(`${hw}.command`, h.command)
          if (h.timeout !== undefined && !(typeof h.timeout === 'number' && h.timeout > 0)) bad(`${hw}.timeout: must be a positive number of milliseconds`)
          if (h.name !== undefined && typeof h.name !== 'string') bad(`${hw}.name: must be a string`)
          if (h.description !== undefined && typeof h.description !== 'string') bad(`${hw}.description: must be a string`)
          hookCommands++
          // the command must run a script that exists once ${extensionPath} is filled in
          const m = hydrate(h.command).match(/"([^"]+\.cjs)"/)
          if (!m) bad(`${hw}.command: no quoted script path found`)
          else if (!fs.existsSync(m[1])) bad(`${hw}.command: script ${m[1]} does not exist`)
        })
      })
    }
    for (const needed of ['AfterModel', 'AfterTool', 'AfterAgent']) if (!hk.hooks[needed]) bad(`hooks.${needed}: the port needs this event`)
  }
}

if (problems.length) {
  console.error(`INVALID (${problems.length}):\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log(`valid: gemini-extension.json (${man.name} ${man.version}, ${Object.keys(man.mcpServers || {}).length} MCP server) and hooks/hooks.json (${Object.keys(hk.hooks).length} events, ${hookCommands} command hooks)`)
