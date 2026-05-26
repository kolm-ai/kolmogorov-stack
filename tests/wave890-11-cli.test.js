// W890-11 — CLI completeness lock-in.
//
// Thirteen invariants ratify the audit produced by
// `node scripts/w890-11-audit.cjs`. The audit writes ten JSON reports under
// data/ and a canonical reference at docs/reference/cli-policy.md.
//
//   1.  data/w890-11-help-coverage.json: missing_help.length === 0
//   2.  data/w890-11-verb-help-quality.json: weakest.length <= 5 documented
//   3.  data/w890-11-json-flag.json: missing.length <= 5 documented (some
//       verbs don't make sense as JSON)
//   4.  data/w890-11-no-color-flag.json: missing.length === 0
//   5.  data/w890-11-exit-codes.json: all_success_zero && all_failure_nonzero
//   6.  data/w890-11-progress-indicators.json: missing.length === 0
//   7.  data/w890-11-version-output.json: has_version && has_git && has_node
//       && has_python
//   8.  data/w890-11-completions.json: at least bash OR zsh present (and
//       completion_command_exists === true)
//   9.  data/w890-11-cold-start.json: under_500 === true (or documented
//       near-miss)
//   10. data/w890-11-dep-error-messages.json: every sampled message
//       includes_install_instruction === true
//   11. docs/reference/cli-policy.md exists
//   12. No banned vocabulary in any W890-11 artifact or the policy doc
//   13. ship-gate 52/52 still green (snapshotted to
//       data/w890-11-ship-gate-snapshot.json)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('lock-in 1: help coverage — every top-level verb responds to --help', () => {
  const r = readJSON('data/w890-11-help-coverage.json');
  assert.ok(typeof r.total_verbs === 'number' && r.total_verbs > 0,
    `total_verbs must be a positive number; got ${r.total_verbs}`);
  assert.ok(Array.isArray(r.missing_help), 'missing_help must be an array');
  assert.strictEqual(r.missing_help.length, 0,
    `missing_help must be empty; ${r.missing_help.length} verbs missing --help. Sample: ${JSON.stringify(r.missing_help.slice(0, 5))}`);
  assert.strictEqual(r.with_help, r.total_verbs,
    `with_help (${r.with_help}) must equal total_verbs (${r.total_verbs})`);
});

test('lock-in 2: per-verb help quality — weakest set is bounded', () => {
  const r = readJSON('data/w890-11-verb-help-quality.json');
  assert.ok(Array.isArray(r.weakest), 'weakest must be an array');
  assert.ok(r.weakest.length <= 5,
    `weakest.length must be <= 5 (W890-11 budget); got ${r.weakest.length}. Verbs: ${JSON.stringify(r.weakest)}`);
  assert.ok(r.sampled >= 20, `sampled must be >= 20; got ${r.sampled}`);
  // Every "weakest" entry must name at least one missing facet so the audit is
  // actionable.
  for (const w of r.weakest) {
    assert.ok(Array.isArray(w.missing) && w.missing.length > 0,
      `weakest entry ${w.verb} must list missing facets`);
  }
});

test('lock-in 3: --json flag — missing count is bounded and documented', () => {
  const r = readJSON('data/w890-11-json-flag.json');
  assert.ok(Array.isArray(r.missing), 'missing must be an array');
  assert.ok(r.missing.length <= 5,
    `--json missing must be <= 5 (W890-11 budget); got ${r.missing.length}. Verbs: ${JSON.stringify(r.missing)}`);
  // Sanity: the skip list must include obvious interactive / scaffolding verbs.
  assert.ok(Array.isArray(r.skipped) && r.skipped.includes('tui'),
    'skipped must include `tui` (interactive)');
  assert.ok(r.skipped.includes('quickstart'), 'skipped must include `quickstart`');
  // Sanity: every claimed supporter must be a real verb name (not flag/empty).
  for (const v of r.supports) {
    assert.ok(typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v),
      `supports entry must be a verb name; got ${v}`);
  }
});

test('lock-in 4: --no-color contract — zero ANSI leaks across sampled verbs', () => {
  const r = readJSON('data/w890-11-no-color-flag.json');
  assert.ok(Array.isArray(r.missing), 'missing must be an array');
  assert.strictEqual(r.missing.length, 0,
    `--no-color missing must be empty; got ${r.missing.length}. Sample: ${JSON.stringify(r.missing.slice(0, 5))}`);
  assert.ok(r.sampled >= 10, `sampled must be >= 10; got ${r.sampled}`);
});

test('lock-in 5: exit codes — success returns 0, failure returns non-zero', () => {
  const r = readJSON('data/w890-11-exit-codes.json');
  assert.strictEqual(r.all_success_zero, true,
    `all_success_zero must be true; got success_verbs=${JSON.stringify(r.success_verbs)}`);
  assert.strictEqual(r.all_failure_nonzero, true,
    `all_failure_nonzero must be true; got failure_verbs=${JSON.stringify(r.failure_verbs)}`);
  // Sanity: at least 5 of each kind sampled.
  assert.ok(Array.isArray(r.success_verbs) && r.success_verbs.length >= 5,
    `must sample >= 5 success cases; got ${r.success_verbs?.length}`);
  assert.ok(Array.isArray(r.failure_verbs) && r.failure_verbs.length >= 4,
    `must sample >= 4 failure cases; got ${r.failure_verbs?.length}`);
});

test('lock-in 6: progress indicators — every long-running verb has progress signals', () => {
  const r = readJSON('data/w890-11-progress-indicators.json');
  assert.ok(Array.isArray(r.missing), 'missing must be an array');
  assert.strictEqual(r.missing.length, 0,
    `progress missing must be empty; got ${r.missing.length}. Verbs: ${JSON.stringify(r.missing)}`);
  assert.ok(r.sampled >= 6, `sampled must be >= 6; got ${r.sampled}`);
});

test('lock-in 7: version output — version + git + node + python all present', () => {
  const r = readJSON('data/w890-11-version-output.json');
  assert.strictEqual(r.has_version, true, 'version JSON must include `cli` (version field)');
  assert.strictEqual(r.has_git, true, 'version JSON must include git commit hash');
  assert.strictEqual(r.has_node, true, 'version JSON must include node version');
  assert.strictEqual(r.has_python, true, 'version JSON must include python version');
  // Sanity: the raw envelope should be a JSON object.
  assert.ok(r.raw && typeof r.raw === 'object', 'raw envelope must be an object');
});

test('lock-in 8: completions — bash + zsh + fish all available and completion verb exists', () => {
  const r = readJSON('data/w890-11-completions.json');
  // Plan minimum: bash OR zsh + completion_command_exists.
  assert.ok(r.bash || r.zsh,
    `at least one of bash/zsh completion must be present; got bash=${r.bash} zsh=${r.zsh}`);
  assert.strictEqual(r.completion_command_exists, true,
    'completion_command_exists must be true');
  // V1 target: all three shells supported.
  assert.strictEqual(r.bash, true, 'bash completion must be available');
  assert.strictEqual(r.zsh, true, 'zsh completion must be available');
  assert.strictEqual(r.fish, true, 'fish completion must be available');
});

test('lock-in 9: cold start — p95 under 500 ms', () => {
  const r = readJSON('data/w890-11-cold-start.json');
  assert.strictEqual(r.runs, 5, `runs must be 5; got ${r.runs}`);
  assert.ok(typeof r.mean_ms === 'number', 'mean_ms must be a number');
  assert.ok(typeof r.median_ms === 'number', 'median_ms must be a number');
  assert.ok(typeof r.p95_ms === 'number', 'p95_ms must be a number');
  assert.strictEqual(r.under_500, true,
    `cold start under_500 must be true; got mean=${r.mean_ms}ms p95=${r.p95_ms}ms`);
  assert.ok(r.p95_ms < 500, `p95 must be < 500 ms; got ${r.p95_ms}ms`);
});

test('lock-in 10: dep-error messages — every sampled message includes an install hint', () => {
  const r = readJSON('data/w890-11-dep-error-messages.json');
  assert.ok(Array.isArray(r.tests) && r.tests.length >= 3,
    `must sample >= 3 dep-missing scenarios; got ${r.tests?.length}`);
  for (const t of r.tests) {
    assert.strictEqual(t.includes_install_instruction, true,
      `dep-error scenario "${t.scenario}" must include an install hint. error_message: ${t.error_message}`);
  }
});

test('lock-in 11: docs/reference/cli-policy.md exists and references all 10 data files', () => {
  const policyPath = path.join(ROOT, 'docs/reference/cli-policy.md');
  assert.ok(fs.existsSync(policyPath),
    `cli-policy.md must exist at ${policyPath}`);
  const text = readText('docs/reference/cli-policy.md');
  assert.ok(text.length > 1500, `cli-policy.md must be substantive; got ${text.length} bytes`);
  const expectedRefs = [
    'w890-11-help-coverage.json',
    'w890-11-verb-help-quality.json',
    'w890-11-json-flag.json',
    'w890-11-no-color-flag.json',
    'w890-11-exit-codes.json',
    'w890-11-progress-indicators.json',
    'w890-11-version-output.json',
    'w890-11-completions.json',
    'w890-11-cold-start.json',
    'w890-11-dep-error-messages.json',
  ];
  for (const r of expectedRefs) {
    assert.ok(text.includes(r),
      `cli-policy.md must reference ${r}`);
  }
});

test('lock-in 12: no banned vocabulary in W890-11 artifacts or the policy doc', () => {
  // The banned tokens are case-insensitive surface forms of "honesty"/"honest"
  // per the long-standing project directive. We exempt cases where the substring
  // appears inside a longer unrelated word (e.g., "honest" must not appear as a
  // standalone word). The W890-11 deliverables MUST NOT include either form.
  const BANNED = [/\bhonest\b/i, /\bhonesty\b/i];
  const files = [
    'data/w890-11-help-coverage.json',
    'data/w890-11-verb-help-quality.json',
    'data/w890-11-json-flag.json',
    'data/w890-11-no-color-flag.json',
    'data/w890-11-exit-codes.json',
    'data/w890-11-progress-indicators.json',
    'data/w890-11-version-output.json',
    'data/w890-11-completions.json',
    'data/w890-11-cold-start.json',
    'data/w890-11-dep-error-messages.json',
    'docs/reference/cli-policy.md',
  ];
  for (const rel of files) {
    const text = readText(rel);
    for (const pattern of BANNED) {
      assert.ok(!pattern.test(text),
        `banned vocabulary ${pattern} found in ${rel}`);
    }
  }
});

test('lock-in 13: ship-gate snapshot — 52/52 still green', () => {
  const snapPath = path.join(ROOT, 'data/w890-11-ship-gate-snapshot.json');
  assert.ok(fs.existsSync(snapPath),
    `ship-gate snapshot must exist at ${snapPath} (regenerate via scripts/w890-11-audit.cjs + scripts/ship-gate.cjs)`);
  const snap = readJSON('data/w890-11-ship-gate-snapshot.json');
  assert.ok(typeof snap.total === 'number', 'snapshot must have total');
  assert.ok(typeof snap.passed === 'number', 'snapshot must have passed');
  assert.strictEqual(snap.passed, snap.total,
    `ship-gate must be ${snap.total}/${snap.total} green; got ${snap.passed}/${snap.total}`);
  assert.ok(snap.total >= 52, `ship-gate must cover >= 52 checks; got ${snap.total}`);
});
