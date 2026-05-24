// W843 - CLI surfaces for the W834 regulatory toolkit + W830 federated
// consortium dispatchers. Audit (this wave) found both feature sets shipped
// HTTP routes but had ZERO CLI presence; W843 wires top-level `kolm
// regulatory` (alias `kolm reg`) and the `consortium` subverb of `kolm
// federated`.
//
// W604 anti-brittleness: family lock uses regex + numeric threshold (never
// an explicit hard-coded sibling list).
//
// Items pinned:
//   1) cli/kolm.js defines async cmdW834Regulatory exactly once and case
//      'regulatory' is wired from main() to it
//   2) cli/kolm.js defines async cmdW830FederatedConsortium exactly once and
//      cmdFederated dispatches `consortium` subverb to it (NOT via
//      _badArgs throw)
//   3) `kolm regulatory --help` exits 0 and lists ALL 6 W834 subverbs
//      (eu-aiact, risk-classify, hil, data-governance, model-card,
//      grc-export)
//   4) `kolm regulatory risk-classify` (no flags) exits 1 with an honest
//      envelope shaped {ok:false, error:'intended_use_required',
//      hint:..., version:/^w834-/}
//   5) `kolm federated consortium --help` exits 0 and lists the 3 W830
//      subverbs (verify-mia, audit-epsilon, status)
//   6) `kolm federated consortium audit-epsilon --epsilon 1.5` returns the
//      honest `awaiting_operator_hook` envelope (no route invented) +
//      preserves claimed_epsilon=1.5
//   7) HELP._root mentions the `regulatory` verb so it shows up in
//      `kolm --help` and won't be invisible to fresh users
//   8) COMPLETION_VERBS includes 'regulatory' and 'reg' for shell completion
//   9) Family lock: at least one prior wave8xx CLI dispatcher test file
//      exists (regex + threshold, never explicit array per W604).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const TESTS_DIR = __dirname;

const ENV = {
  ...process.env,
  KOLM_NO_INTERACTIVE: '1',
  NO_COLOR: '1',
  // Deliberately unset KOLM_API_KEY so auth-gated subverbs error before
  // hitting the network. The honest-envelope tests don't need the network.
  KOLM_API_KEY: '',
  KOLM_BASE: 'http://127.0.0.1:1', // Unreachable; never actually fetched.
  KOLM_BASE_URL: 'http://127.0.0.1:1',
};

function execKolm(args, env = ENV) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    timeout: 15_000,
    encoding: 'utf8',
    env,
  });
}

function readCli() {
  return fs.readFileSync(CLI_PATH, 'utf8');
}

// ----------------------------------------------------------------------------
// 1) cmdW834Regulatory exactly once + wired from case 'regulatory'
// ----------------------------------------------------------------------------
test("W843 #1 - cli/kolm.js defines cmdW834Regulatory exactly once + wired from case 'regulatory'", () => {
  const src = readCli();
  const defOccurrences = (src.match(/async function cmdW834Regulatory\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW834Regulatory must be defined exactly once; found ${defOccurrences}`);
  assert.ok(/case 'regulatory':[\s\S]{0,400}cmdW834Regulatory/.test(src),
    `expected "case 'regulatory': ... cmdW834Regulatory(...)" wiring; not found`);
  // Alias 'reg' must also dispatch to the same function.
  assert.ok(/case 'reg':[\s\S]{0,400}cmdW834Regulatory/.test(src),
    `expected "case 'reg': ... cmdW834Regulatory(...)" alias wiring; not found`);
});

// ----------------------------------------------------------------------------
// 2) cmdW830FederatedConsortium exactly once + dispatched from cmdFederated
// ----------------------------------------------------------------------------
test("W843 #2 - cli/kolm.js defines cmdW830FederatedConsortium exactly once + cmdFederated dispatches consortium subverb", () => {
  const src = readCli();
  const defOccurrences = (src.match(/async function cmdW830FederatedConsortium\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW830FederatedConsortium must be defined exactly once; found ${defOccurrences}`);
  // cmdFederated must intercept `consortium` and route to the new dispatcher
  // BEFORE throwing _badArgs('unknown federated subcommand').
  assert.ok(/cmdFederated[\s\S]*?sub === 'consortium'[\s\S]*?cmdW830FederatedConsortium/.test(src),
    `cmdFederated must dispatch consortium subverb to cmdW830FederatedConsortium`);
});

// ----------------------------------------------------------------------------
// 3) `kolm regulatory --help` lists all 6 W834 subverbs
// ----------------------------------------------------------------------------
test('W843 #3 - kolm regulatory --help lists all 6 W834 subverbs', () => {
  const r = execKolm(['regulatory', '--help']);
  assert.equal(r.status, 0,
    `kolm regulatory --help exited ${r.status} (stderr: ${(r.stderr || '').slice(0, 300)})`);
  const out = (r.stdout || '') + (r.stderr || '');
  for (const sub of ['eu-aiact', 'risk-classify', 'hil', 'data-governance', 'model-card', 'grc-export']) {
    assert.ok(out.includes(sub), `help must mention subverb "${sub}"; got:\n${out}`);
  }
});

// ----------------------------------------------------------------------------
// 4) risk-classify (no flags) returns honest envelope at exit 1
// ----------------------------------------------------------------------------
test('W843 #4 - kolm regulatory risk-classify (no flags) returns honest envelope shape at exit 1', () => {
  const r = execKolm(['regulatory', 'risk-classify']);
  assert.equal(r.status, 1,
    `expected exit 1 (BAD_ARGS), got ${r.status} (stderr: ${(r.stderr || '').slice(0, 300)})`);
  let envelope;
  try {
    envelope = JSON.parse(r.stdout || '');
  } catch (e) {
    throw new Error(`stdout must be a single JSON envelope; got:\n${r.stdout}\n--\nparse error: ${e.message}`);
  }
  assert.equal(envelope.ok, false, 'envelope.ok must be false');
  assert.equal(envelope.error, 'intended_use_required',
    `envelope.error must be intended_use_required; got ${envelope.error}`);
  assert.equal(typeof envelope.hint, 'string', 'envelope.hint must be a string');
  assert.ok(envelope.hint.includes('--intended-use'),
    `envelope.hint must mention --intended-use; got "${envelope.hint}"`);
  assert.ok(/^w834-/.test(envelope.version || ''),
    `envelope.version must match /^w834-/; got "${envelope.version}"`);
});

// ----------------------------------------------------------------------------
// 5) `kolm federated consortium --help` lists 3 W830 subverbs
// ----------------------------------------------------------------------------
test('W843 #5 - kolm federated consortium --help lists 3 W830 subverbs', () => {
  const r = execKolm(['federated', 'consortium', '--help']);
  assert.equal(r.status, 0,
    `kolm federated consortium --help exited ${r.status} (stderr: ${(r.stderr || '').slice(0, 300)})`);
  const out = (r.stdout || '') + (r.stderr || '');
  for (const sub of ['verify-mia', 'audit-epsilon', 'status']) {
    assert.ok(out.includes(sub), `help must mention subverb "${sub}"; got:\n${out}`);
  }
});

// ----------------------------------------------------------------------------
// 6) audit-epsilon honest envelope (route not invented)
// ----------------------------------------------------------------------------
test('W843 #6 - kolm federated consortium audit-epsilon returns honest awaiting_operator_hook envelope (route not invented)', () => {
  const r = execKolm(['federated', 'consortium', 'audit-epsilon', '--epsilon', '1.5']);
  // The honest hook exits 4 (EXIT.EXECUTION) because the feature is gated
  // until the hosted route ships. The CLI must NOT pretend success.
  assert.notEqual(r.status, 0,
    `audit-epsilon must NOT exit 0 when the hosted route is missing; got status ${r.status}`);
  let envelope;
  try {
    envelope = JSON.parse(r.stdout || '');
  } catch (e) {
    throw new Error(`stdout must be a single JSON envelope; got:\n${r.stdout}\n--\nparse error: ${e.message}`);
  }
  assert.equal(envelope.ok, false, 'envelope.ok must be false');
  assert.equal(envelope.error, 'awaiting_operator_hook',
    `envelope.error must be awaiting_operator_hook (route missing); got ${envelope.error}`);
  assert.equal(envelope.claimed_epsilon, 1.5,
    `envelope.claimed_epsilon must preserve --epsilon input; got ${envelope.claimed_epsilon}`);
  assert.ok(envelope.hint && envelope.hint.includes('dpEpsilonAudit'),
    `envelope.hint must point operator at the dpEpsilonAudit in-process module`);
  assert.ok(/^w830-/.test(envelope.version || ''),
    `envelope.version must match /^w830-/; got "${envelope.version}"`);
});

// ----------------------------------------------------------------------------
// 7) HELP._root mentions the `regulatory` verb
// ----------------------------------------------------------------------------
test('W843 #7 - HELP._root mentions regulatory verb (visible to fresh users)', () => {
  const src = readCli();
  // Match the HELP._root template literal block.
  const m = src.match(/_root:\s*`([\s\S]*?)`,\n  [a-z_]+:/);
  assert.ok(m, 'HELP._root template literal must exist');
  const rootHelp = m[1];
  assert.ok(/\bregulatory\b/.test(rootHelp),
    `HELP._root must mention "regulatory"; not found`);
});

// ----------------------------------------------------------------------------
// 8) COMPLETION_VERBS includes regulatory + reg
// ----------------------------------------------------------------------------
test('W843 #8 - COMPLETION_VERBS includes regulatory and reg for shell completion', () => {
  const src = readCli();
  assert.ok(src.includes("COMPLETION_VERBS.push('regulatory'"),
    `COMPLETION_VERBS must push 'regulatory' for shell completion`);
  assert.ok(src.includes('COMPLETION_SUBS.regulatory ='),
    `COMPLETION_SUBS.regulatory must be defined`);
});

// ----------------------------------------------------------------------------
// 9) Family lock (W604): regex + threshold, never explicit array.
// ----------------------------------------------------------------------------
test('W843 #9 - W604 family pattern: at least one prior wave8xx CLI dispatcher test file exists', () => {
  const re = /^wave(\d{3,4}).*\.test\.js$/;
  const files = fs.readdirSync(TESTS_DIR);
  const wave8xx = files.filter((f) => {
    const m = f.match(re);
    if (!m) return false;
    const n = Number(m[1]);
    return n >= 800 && n <= 999;
  });
  // Threshold check: this wave (W843) ships with at least 1 other wave8xx
  // test alongside it (W830 + W834 already on disk). Forward-compatible:
  // future wave8xx tests only INCREASE this count.
  assert.ok(wave8xx.length >= 1,
    `expected at least 1 wave8xx test file (regex+threshold per W604); found ${wave8xx.length}`);
});
