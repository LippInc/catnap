#!/usr/bin/env node
'use strict'
// compact-when-ready hook entry point for Gemini CLI. One script for every event: it reads the hook payload from
// stdin, dispatches on hook_event_name and prints one JSON object on stdout (nothing else, as the hook rules ask).
// Exit code is always 0: a failure is logged in the state folder and the CLI carries on (fail open).
const path = require('node:path')
const root = process.env.CWR_ROOT ? path.resolve(process.env.CWR_ROOT) : path.resolve(__dirname, '..')

// Gemini CLI fires AfterModel once per streamed chunk (live run, 0.64.0: 2 to 5 chunks per response, each chunk's
// usageMetadata is the running total, and only the last chunk of a response carries finishReason). A chunk that has
// candidates but no finishReason is therefore not the last one: answer at once, before loading anything or touching
// a file. (A trailing usage-only chunk has no candidates and is still processed.)
const isIntermediateChunk = input => {
  if (!input || input.hook_event_name !== 'AfterModel') return false
  const c = input.llm_response && input.llm_response.candidates
  return Array.isArray(c) && c.length > 0 && !c.some(x => x && x.finishReason)
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => (raw += d))
process.stdin.on('error', () => {})
process.stdin.on('end', () => {
  let out = {}
  try {
    const input = raw.trim() ? JSON.parse(raw) : {}
    out = isIntermediateChunk(input) ? {} : require(path.join(root, 'lib', 'cwr.cjs')).run(input)
  } catch {
    out = {}
  }
  process.stdout.write(JSON.stringify(out) + '\n')
})
