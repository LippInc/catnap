// node --test bench/test/check.test.mjs
// CHECK_SCRIPT=/path/to/mutated/check.mjs lets mutate.mjs run the same tests against a planted bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = process.env.CHECK_SCRIPT || path.join(here, '..', 'check.mjs');

// The child inherits this process's environment; only CLAUDE_CONFIG_DIR is set, around the call, and restored.
// Nothing copies or lists the environment (the plugin directory's checker reads that as "reads a credential").
function inFixture(fixture, start) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(here, 'fixtures', fixture);
  try {
    return start();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
}

function run(fixture, ...args) {
  const out = inFixture(fixture, () => execFileSync(process.execPath, [script, '--json', '--days', '36500', ...args], { encoding: 'utf8' }));
  return JSON.parse(out);
}

test('(a) session that never passes 50%: saving exactly 0, no compactions', () => {
  const r = run('a-short');
  assert.equal(r.sessions, 1);
  assert.equal(r.longSessions, 0);
  assert.equal(r.tokensActual, 425_000); // 20,25,...,65 (K): 10 terms, mean 42.5; sidechain ignored
  assert.equal(r.tokensEstimated, 425_000);
  assert.equal(r.saving, 0);
  assert.equal(r.autoCompactions, 0);
  assert.equal(r.simulatedClean + r.simulatedBackstop, 0);
});

test('(b) linear growth past the line, one end_turn after it: matches the hand calculation in METHOD.md', () => {
  const r = run('b-linear');
  assert.equal(r.longSessions, 1);
  assert.equal(r.tokensActual, 4_550_000);
  assert.equal(r.tokensEstimated, 4_200_000);
  assert.equal(r.simulatedClean, 1);
  assert.equal(r.simulatedBackstop, 0);
  assert.equal(r.resetTokens, 100_000); // no boundary in the data: fallback
  assert.ok(Math.abs(r.saving - 1 / 13) < 1e-12);
});

test('(b2) moving the soft line to 60% changes the estimate as hand-calculated', () => {
  // 1M window, line 600K: first end_turn above it is i=12 (650K): E = sum(50..650)=4550 + read 650 = 5,200K
  const r = run('b-linear', '--soft', '60');
  assert.equal(r.tokensEstimated, 5_200_000);
  assert.equal(r.simulatedClean, 1);
});

test('(c1) auto boundary after a tool_use call is mid-task', () => {
  const r = run('c1-mid-task');
  assert.equal(r.autoCompactions, 1); // duplicate boundary record counted once
  assert.equal(r.midTask, 1);
  assert.equal(r.notMidTask, 0);
  assert.equal(r.tokensActual, 920_000); // 650 + 100 + 170 (boundary read)
  assert.equal(r.tokensEstimated, 830_000);
  assert.equal(r.simulatedBackstop, 1);
});

test('(c2) auto boundary after an end_turn call is not mid-task', () => {
  const r = run('c2-clean');
  assert.equal(r.autoCompactions, 1);
  assert.equal(r.midTask, 0);
  assert.equal(r.notMidTask, 1);
});

test('(d) re-logged duplicate message.id records are counted once', () => {
  const r = run('d-dups');
  assert.equal(r.calls, 13);
  assert.equal(r.tokensActual, 4_550_000);
  assert.equal(r.tokensEstimated, 4_200_000);
});

test('output prints no paths or text', () => {
  const out = inFixture('b-linear', () => execFileSync(process.execPath, [script, '--days', '36500'], { encoding: 'utf8' }));
  assert.ok(!out.includes('fixtures') && !out.includes('s.jsonl'));
  assert.ok(out.split('\n').length <= 14);
});
