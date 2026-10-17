// Planted-failure check: copies check.mjs to a temp dir, plants one bug at a time, and runs
// check.test.mjs against it. Every mutant must make at least one test fail.
// Run: node bench/test/mutate.mjs   (exit 0 only if every planted bug is caught)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'check.mjs'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwr-mutants-'));

const mutants = [
  ['drop the message.id dedup', "const key = m.id ?? `noid-${lineNo}`;", "const key = `${m.id}|${lineNo}`;"],
  ['shift the soft line by +10 points', 'const soft = (o.soft / 100) * W;', 'const soft = ((o.soft + 10) / 100) * W;'],
  ['count end_turn as mid-task', "if (s === 'tool_use') res.midTask++;", "if (s === 'end_turn') res.midTask++;"],
  ['stop skipping sidechain records', 'if (!r || r.isSidechain) continue;', 'if (!r) continue;'],
  ['stop deduplicating boundary records', 'const key = `${r.timestamp}|${cm.preTokens}`;', 'const key = `${r.timestamp}|${cm.preTokens}|${lineNo}`;'],
  ['forget the read cost of a simulated compaction', 'extra += c; out.clean++; c = reset;', 'out.clean++; c = reset;'],
];

let bad = 0;
const baseline = spawnSync(process.execPath, ['--test', path.join(here, 'check.test.mjs')], { encoding: 'utf8' });
console.log(`unmutated: ${baseline.status === 0 ? 'tests pass' : 'TESTS FAIL (fix first)'}`);
if (baseline.status !== 0) process.exit(1);

mutants.forEach(([name, from, to], i) => {
  if (!src.includes(from)) { console.log(`MUTANT NOT APPLIED (pattern missing): ${name}`); bad++; return; }
  const f = path.join(tmp, `check-${i}.mjs`);
  fs.writeFileSync(f, src.replace(from, to));
  const r = spawnSync(process.execPath, ['--test', path.join(here, 'check.test.mjs')], {
    encoding: 'utf8', env: { ...process.env, CHECK_SCRIPT: f },
  });
  const failed = (r.stdout.match(/^ℹ fail (\d+)/m) || [])[1];
  const caught = r.status !== 0;
  console.log(`${caught ? 'CAUGHT ' : 'MISSED '} ${name} (failing tests: ${failed})`);
  if (!caught) bad++;
});
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
