// W820 — GitHub Actions integration tests.
//
// Atomic-per-contract style consistent with the W812+ wave tests:
//   - one test per surface element
//   - version assertions use regex /^w820-/ (W604 anti-brittleness)
//   - no global state leakage between tests (per-test temp dirs)
//
// Coverage map (>= 10 tests):
//   #1  tools/gha/kolm-distill-action/action.yml exists + has required keys
//   #2  tools/gha/kolm-distill-action/README.md exists + non-empty
//   #3  .github/workflows/kolm-template.yml exists + references the local action
//   #4  docs/spec/kolm-yaml-schema.md exists + lists required + optional fields
//   #5  docs/cookbook/kolm.yaml exists + contains required schema fields
//   #6  src/artifact-diff.js exports the documented surface + version regex
//   #7  diffArtifactPaths handles missing files: { ok:false, error:'artifact_not_found' }
//   #8  diffArtifactPaths handles identical artifacts: every numeric delta == 0
//   #9  diffArtifactPaths emits the W820 field set on real .kolm fixtures
//  #10  diffSnapshots verdict: regression flagged when k_score drops
//  #11  cli `kolm diff <missing> <missing>` exits non-zero with artifact_not_found JSON
//  #12  cli `kolm diff a b --json` returns a parseable combined envelope

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'cli', 'kolm.js');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w820-'));
}

// Build a minimal .kolm zip with manifest.json + receipt.json. Returns the
// path. Caller controls every field that W820 surfaces so a test can dial
// regressions or improvements on any axis.
function buildArtifact(dir, name, opts) {
  const manifest = {
    cid: opts.cid || ('cid_' + name),
    parent_cid: opts.parent_cid || null,
    teacher_id: opts.teacher || 'claude-sonnet-4-6',
    student_arch: opts.student_arch || 'qwen2.5-7b-int4',
    param_count: opts.param_count != null ? opts.param_count : 7240000000,
    capture_count: opts.capture_count != null ? opts.capture_count : 12450,
    bench_pass_rate: opts.bench_pass_rate != null ? opts.bench_pass_rate : 0.95,
    k_score: { composite: opts.k_score != null ? opts.k_score : 0.873, point: opts.k_score != null ? opts.k_score : 0.873, ci95: [0.85, 0.89] },
    format_version: '1.0',
    policy: { require_ed25519: opts.signed !== false, require_rekor: false },
  };
  const receipt = {
    cid: manifest.cid,
    artifact_hash: 'sha256:' + name + '_artifact_hash',
    issued_at: '2026-05-24T00:00:00.000Z',
    signed_at: opts.signed === false ? null : '2026-05-24T00:00:00.000Z',
    tier: 'standard',
  };
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile('receipt.json',  Buffer.from(JSON.stringify(receipt,  null, 2)));
  const out = path.join(dir, name + '.kolm');
  zip.writeZip(out);
  return out;
}

// ---------------------------------------------------------------------------
// #1 action.yml exists + has required keys
// ---------------------------------------------------------------------------
test('W820 #1 action.yml exists + has required keys', () => {
  const p = path.join(REPO, 'tools', 'gha', 'kolm-distill-action', 'action.yml');
  assert.ok(fs.existsSync(p), 'action.yml must exist');
  const yaml = fs.readFileSync(p, 'utf8');
  // We accept either single-quoted or unquoted scalar values for the inputs
  // a downstream YAML parser would need. Regex covers both indentation styles.
  for (const key of ['name:', 'description:', 'inputs:', 'outputs:', 'runs:', 'using:', 'kolm-api-key:', 'k-score-gate:', 'redistill-on-drop:', 'publish-release:']) {
    assert.ok(yaml.includes(key), 'action.yml missing required key ' + key);
  }
  assert.match(yaml, /using:\s*['"]?composite['"]?/, 'action.yml must be composite');
  assert.match(yaml, /setup-node@v\d+/, 'action.yml must reference setup-node');
});

// ---------------------------------------------------------------------------
// #2 action README exists + non-empty
// ---------------------------------------------------------------------------
test('W820 #2 action README exists + non-empty + lists W820 fields', () => {
  const p = path.join(REPO, 'tools', 'gha', 'kolm-distill-action', 'README.md');
  assert.ok(fs.existsSync(p), 'README.md must exist');
  const md = fs.readFileSync(p, 'utf8');
  assert.ok(md.length > 500, 'README must have meaningful content');
  for (const key of ['kolm-api-key', 'k-score-gate', 'redistill-on-drop', 'publish-release', 'kscore', 'kscore-passed']) {
    assert.ok(md.includes(key), 'README missing reference to ' + key);
  }
});

// ---------------------------------------------------------------------------
// #3 kolm-template.yml exists + references local action path
// ---------------------------------------------------------------------------
test('W820 #3 kolm-template.yml references local action + 5min timeout', () => {
  const p = path.join(REPO, '.github', 'workflows', 'kolm-template.yml');
  assert.ok(fs.existsSync(p), 'kolm-template.yml must exist');
  const yaml = fs.readFileSync(p, 'utf8');
  assert.match(yaml, /uses:\s*\.\/tools\/gha\/kolm-distill-action/, 'must reference local action path');
  assert.match(yaml, /timeout-minutes:\s*5/, 'must enforce 5-minute job timeout');
  assert.match(yaml, /KOLM_API_KEY/, 'must surface the KOLM_API_KEY secret');
  // W211 / W405 secret-guard pattern stops red-X on missing-secret forks.
  assert.match(yaml, /secrets\.KOLM_API_KEY\s*!=\s*''/, 'must include W211-style secret guard');
});

// ---------------------------------------------------------------------------
// #4 docs/spec/kolm-yaml-schema.md exists + lists required + optional fields
// ---------------------------------------------------------------------------
test('W820 #4 kolm-yaml-schema.md lists required + optional fields', () => {
  const p = path.join(REPO, 'docs', 'spec', 'kolm-yaml-schema.md');
  assert.ok(fs.existsSync(p), 'kolm-yaml-schema.md must exist');
  const md = fs.readFileSync(p, 'utf8');
  // Required: version + namespaces (with name + teacher)
  for (const key of ['version', 'namespaces', 'name', 'teacher']) {
    assert.ok(md.includes(key), 'schema doc missing required field ' + key);
  }
  // Optional: quality_gates + re_distill + publish + eval_set + guardrails
  for (const key of ['quality_gates', 're_distill', 'publish', 'eval_set', 'guardrails']) {
    assert.ok(md.includes(key), 'schema doc missing optional field ' + key);
  }
  assert.ok(md.includes('w732-v1'), 'schema doc must pin the version token');
});

// ---------------------------------------------------------------------------
// #5 docs/cookbook/kolm.yaml exists + contains required schema fields
// ---------------------------------------------------------------------------
test('W820 #5 cookbook kolm.yaml contains required schema fields', () => {
  const p = path.join(REPO, 'docs', 'cookbook', 'kolm.yaml');
  assert.ok(fs.existsSync(p), 'cookbook kolm.yaml must exist');
  const yaml = fs.readFileSync(p, 'utf8');
  assert.match(yaml, /version:\s*w732-v1/, 'must set version to w732-v1');
  assert.match(yaml, /^namespaces:/m, 'must declare a top-level namespaces list');
  assert.match(yaml, /^\s+- name:\s*\S+/m, 'must declare at least one namespace name');
  assert.match(yaml, /teacher:\s*\S+/, 'must declare a teacher');
  // Optional but present in cookbook
  assert.match(yaml, /^quality_gates:/m, 'cookbook should include quality_gates example');
  assert.match(yaml, /min_kscore:/, 'cookbook quality_gates should include min_kscore');
});

// ---------------------------------------------------------------------------
// #6 src/artifact-diff.js exports the documented surface + version regex
// ---------------------------------------------------------------------------
test('W820 #6 artifact-diff.js exports documented surface + version regex', async () => {
  const mod = await import('../src/artifact-diff.js');
  assert.equal(typeof mod.extractSnapshot,   'function');
  assert.equal(typeof mod.diffSnapshots,     'function');
  assert.equal(typeof mod.diffArtifactPaths, 'function');
  assert.equal(typeof mod.formatDiffText,    'function');
  assert.match(mod.ARTIFACT_DIFF_VERSION, /^w820-/, 'version must start with w820-');
});

// ---------------------------------------------------------------------------
// #7 diffArtifactPaths handles missing files
// ---------------------------------------------------------------------------
test('W820 #7 diffArtifactPaths returns artifact_not_found for missing files', async () => {
  const dir = freshDir();
  const { diffArtifactPaths } = await import('../src/artifact-diff.js');
  const a = path.join(dir, 'missing-a.kolm');
  const b = path.join(dir, 'missing-b.kolm');
  const out = await diffArtifactPaths(a, b);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'artifact_not_found');
  assert.equal(out.side, 'left');
  assert.equal(out.path, a);
});

// ---------------------------------------------------------------------------
// #8 diffArtifactPaths on identical artifacts: every numeric delta == 0
// ---------------------------------------------------------------------------
test('W820 #8 identical artifacts diff -> every numeric delta is 0', async () => {
  const dir = freshDir();
  const a = buildArtifact(dir, 'v1', { k_score: 0.873, capture_count: 12450, param_count: 7240000000, bench_pass_rate: 0.95 });
  // Build with a different CID + name so the file paths differ but every
  // W820-surfaced value matches verbatim.
  const b = buildArtifact(dir, 'v1-copy', { k_score: 0.873, capture_count: 12450, param_count: 7240000000, bench_pass_rate: 0.95, cid: 'cid_v1-copy' });
  const { diffArtifactPaths } = await import('../src/artifact-diff.js');
  const out = await diffArtifactPaths(a, b);
  assert.equal(out.ok, true);
  for (const row of out.diff.rows) {
    if (row.kind === 'numeric') {
      assert.equal(row.delta, 0, 'identical artifacts must have delta:0 on ' + row.field);
    } else {
      assert.equal(row.changed, false, 'identical artifacts must show changed:false on ' + row.field);
    }
  }
  assert.equal(out.diff.changed_count, 0);
});

// ---------------------------------------------------------------------------
// #9 diffArtifactPaths emits the W820 field set on real .kolm fixtures
// ---------------------------------------------------------------------------
test('W820 #9 diff envelope carries every W820 field', async () => {
  const dir = freshDir();
  const a = buildArtifact(dir, 'v1', { k_score: 0.873, capture_count: 12000, param_count: 7240000000, bench_pass_rate: 0.95 });
  const b = buildArtifact(dir, 'v2', { k_score: 0.860, capture_count: 12450, param_count: 7240000000, bench_pass_rate: 0.92, teacher: 'claude-opus-4-7' });
  const { diffArtifactPaths } = await import('../src/artifact-diff.js');
  const out = await diffArtifactPaths(a, b);
  assert.equal(out.ok, true);
  const fields = out.diff.rows.map(r => r.field);
  for (const f of ['k_score', 'capture_count', 'teacher', 'student_arch', 'param_count', 'bench_pass_rate', 'signed']) {
    assert.ok(fields.includes(f), 'diff must include ' + f);
  }
  // Teacher changed -> changed:true on the string row.
  const teacherRow = out.diff.rows.find(r => r.field === 'teacher');
  assert.equal(teacherRow.changed, true);
  assert.equal(teacherRow.left, 'claude-sonnet-4-6');
  assert.equal(teacherRow.right, 'claude-opus-4-7');
  // k_score regression -> negative delta.
  const kRow = out.diff.rows.find(r => r.field === 'k_score');
  assert.ok(kRow.delta < 0, 'k_score delta must be negative when right < left');
});

// ---------------------------------------------------------------------------
// #10 diffSnapshots verdict regression detection
// ---------------------------------------------------------------------------
test('W820 #10 verdict flags k_score_regression when k_score drops', async () => {
  const { diffSnapshots } = await import('../src/artifact-diff.js');
  const left  = { k_score: 0.90, capture_count: 1000, teacher: 't', student_arch: 's', param_count: 100, bench_pass_rate: 0.95, signed: true };
  const right = { k_score: 0.85, capture_count: 1100, teacher: 't', student_arch: 's', param_count: 100, bench_pass_rate: 0.95, signed: true };
  const out = diffSnapshots(left, right);
  assert.equal(out.ok, true);
  assert.equal(out.verdict, 'k_score_regression');
  // Also the "improvement" path:
  const improved = diffSnapshots(left, { ...left, k_score: 0.92 });
  assert.equal(improved.verdict, 'k_score_improvement');
  // "identical" only fires when no axis changed.
  const same = diffSnapshots(left, { ...left });
  assert.equal(same.verdict, 'identical');
});

// ---------------------------------------------------------------------------
// #11 CLI `kolm diff <missing> <missing>` exits non-zero + JSON envelope
// ---------------------------------------------------------------------------
test('W820 #11 cli kolm diff <missing> <missing> -> non-zero + artifact_not_found JSON', () => {
  const dir = freshDir();
  const a = path.join(dir, 'nope-a.kolm');
  const b = path.join(dir, 'nope-b.kolm');
  const r = spawnSync(process.execPath, [CLI, 'diff', a, b], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'CLI must exit non-zero on missing artifact (got ' + r.status + ')');
  // CLI prints the envelope as JSON. Parse stdout.
  let env = null;
  try { env = JSON.parse(r.stdout); } catch (_) { env = null; }
  assert.ok(env, 'stdout must be parseable JSON; got: ' + r.stdout.slice(0, 400));
  assert.equal(env.ok, false);
  assert.equal(env.error, 'artifact_not_found');
});

// ---------------------------------------------------------------------------
// #12 CLI `kolm diff a b --json` returns parseable combined envelope
// ---------------------------------------------------------------------------
test('W820 #12 cli kolm diff a b --json -> parseable combined envelope', () => {
  const dir = freshDir();
  const a = buildArtifact(dir, 'v1', { k_score: 0.90, capture_count: 1000 });
  const b = buildArtifact(dir, 'v2', { k_score: 0.85, capture_count: 1100, parent_cid: 'cid_v1' });
  const r = spawnSync(process.execPath, [CLI, 'diff', a, b, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'CLI must exit 0 on a successful diff; stderr=' + r.stderr);
  let env = null;
  try { env = JSON.parse(r.stdout); } catch (_) { env = null; }
  assert.ok(env, 'stdout must be parseable JSON; got: ' + r.stdout.slice(0, 400));
  assert.equal(env.ok, true);
  assert.ok(env.a, 'a side must be present');
  assert.ok(env.b, 'b side must be present');
  assert.ok(env.diff, 'diff block must be present');
  assert.ok(Array.isArray(env.diff.rows), 'diff.rows must be an array');
  assert.match(env.version, /^w820-/);
});

// ---------------------------------------------------------------------------
// #13 W604 anti-brittleness: version regex match for artifact-diff
// ---------------------------------------------------------------------------
test('W820 #13 ARTIFACT_DIFF_VERSION matches /^w820-v\\d+/ (W604 pattern)', async () => {
  const { ARTIFACT_DIFF_VERSION } = await import('../src/artifact-diff.js');
  assert.match(ARTIFACT_DIFF_VERSION, /^w820-v\d+$/, 'version must follow w820-v<N> shape');
});
