// Regenerates test/fixtures/*. Synthetic data only. Run: node bench/test/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const iso = (min, sec = 0) => new Date(T0 + min * 60_000 + sec * 1000).toISOString();

// context is carried entirely in cache_read_input_tokens (k = thousands of tokens)
function call(i, ctxK, stop, extra = {}) {
  return {
    type: 'assistant', timestamp: iso(i), sessionId: 'fixture', isSidechain: false, ...extra,
    message: {
      id: `msg_${i}`, model: 'claude-test', stop_reason: stop,
      usage: { input_tokens: 0, cache_read_input_tokens: ctxK * 1000, cache_creation_input_tokens: 0, output_tokens: 10 },
    },
  };
}
const boundary = (min, trigger, preK) => ({
  type: 'system', subtype: 'compact_boundary', timestamp: iso(min, 30),
  compactMetadata: { trigger, preTokens: preK * 1000, postTokens: 5000 },
});
const noise = [{ type: 'user', timestamp: iso(0), message: { role: 'user', content: 'x' } }];

function write(name, records) {
  const dir = path.join(here, 'fixtures', name, 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's.jsonl'), noise.concat(records).map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// (a) never passes 50% of the 200K window; one sidechain record with a huge context that must be ignored
{
  const recs = [];
  for (let i = 0; i < 10; i++) recs.push(call(i, 20 + 5 * i, i % 3 === 2 ? 'end_turn' : 'tool_use'));
  recs.push(call(99, 900, 'tool_use', { isSidechain: true }));
  write('a-short', recs);
}

// (b) linear growth 50K..650K (13 calls), end_turn at i=4 (250K, below the line), i=10 (550K), i=12
const bCalls = [];
for (let i = 0; i < 13; i++) bCalls.push(call(i, 50 * (i + 1), [4, 10, 12].includes(i) ? 'end_turn' : 'tool_use'));
write('b-linear', bCalls);

// (d) the same session with every record re-logged (as Claude Code does after a compaction)
{
  const recs = [];
  for (const c of bCalls) {
    recs.push(c);
    recs.push({ ...c, timestamp: new Date(Date.parse(c.timestamp) + 1000).toISOString() });
    recs.push({ ...c, timestamp: new Date(Date.parse(c.timestamp) + 2000).toISOString() });
  }
  write('d-dups', recs);
}

// (c) auto boundary after the 5th call; c1: that call is tool_use (mid-task), c2: end_turn
for (const [name, lastStop] of [['c1-mid-task', 'tool_use'], ['c2-clean', 'end_turn']]) {
  const recs = [];
  [90, 110, 130, 150, 170].forEach((k, i) => recs.push(call(i, k, i === 4 ? lastStop : 'tool_use')));
  recs.push(boundary(4, 'auto', 170));
  recs.push(boundary(4, 'auto', 170)); // duplicate boundary record, must count once
  recs.push(call(5, 40, 'tool_use'));
  recs.push(call(6, 60, 'end_turn'));
  write(name, recs);
}
console.log('fixtures written');
