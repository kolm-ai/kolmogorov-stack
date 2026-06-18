// W931 - direct worker/package safety contracts for uncovered worker atoms.
//
// Covers:
//   workers/audio-tokenize/package.json
//   workers/constrained/package.json
//   workers/data/scripts/score_quality.py
//   workers/data/scripts/select_subset.py
//   workers/distill/scripts/_console.py
//   workers/distill/scripts/cot_markers.json
//   workers/distill/scripts/scrub_think.py
//   workers/itkv/package.json
//   workers/itkv/scripts/itkv.py
//   workers/quantize/requirements-optimizers.txt
//   workers/runtime-build/package.json
//   workers/tsac/package.json
//   workers/tsac/scripts/tsac.py
//   workers/video-tokenize/package.json

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

const PACKAGE_FILES = [
  'workers/audio-tokenize/package.json',
  'workers/constrained/package.json',
  'workers/itkv/package.json',
  'workers/runtime-build/package.json',
  'workers/tsac/package.json',
  'workers/video-tokenize/package.json',
];

const PY_FILES = {
  scoreQuality: 'workers/data/scripts/score_quality.py',
  selectSubset: 'workers/data/scripts/select_subset.py',
  consoleShim: 'workers/distill/scripts/_console.py',
  scrubThink: 'workers/distill/scripts/scrub_think.py',
  itkv: 'workers/itkv/scripts/itkv.py',
  tsac: 'workers/tsac/scripts/tsac.py',
};

function abs(rel) {
  return path.join(ROOT, rel);
}

function read(rel) {
  return fs.readFileSync(abs(rel), 'utf8');
}

function parseJsonTail(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep walking
    }
  }
  throw new Error(`no JSON object found in: ${String(text || '').slice(0, 400)}`);
}

function findPython() {
  const bundledPython = path.join(
    os.homedir(),
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'python',
    'python.exe',
  );
  const candidates = [
    process.env.KOLM_PYTHON,
    process.env.PYTHON,
    fs.existsSync(bundledPython) ? bundledPython : null,
    process.platform === 'win32' ? 'python' : 'python3',
    'python3',
    'python',
    process.platform === 'win32' ? 'py' : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (r.status === 0) return candidate;
  }
  return null;
}

const PYTHON = findPython();

function runPython(args, opts = {}) {
  assert.ok(PYTHON, 'python runtime is required for W931 worker contract tests');
  return spawnSync(PYTHON, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: opts.timeout ?? 30_000,
    input: opts.input,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
    },
  });
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w931-workers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('W931 worker package manifests stay isolated, private, and doctorable', () => {
  for (const rel of PACKAGE_FILES) {
    const pkg = JSON.parse(read(rel));
    assert.equal(pkg.private, true, `${rel} must not be publishable by accident`);
    assert.equal(pkg.type, 'module', `${rel} must stay ESM`);
    assert.equal(pkg.engines?.node, '>=18.0.0', `${rel} pins the Node floor`);
    assert.deepEqual(pkg.dependencies || {}, {}, `${rel} must not pull root-time heavy deps`);
    assert.deepEqual(pkg.optionalDependencies || {}, {}, `${rel} must not hide heavy deps in optional deps`);
    assert.ok(pkg.main && fs.existsSync(abs(path.join(path.dirname(rel), pkg.main))), `${rel} main exists`);
    assert.equal(typeof pkg.scripts?.doctor, 'string', `${rel} exposes a doctor script`);
    assert.match(pkg.scripts.doctor, new RegExp(pkg.main.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(Object.keys(pkg.bin || {}).length, 1, `${rel} exposes exactly one binary`);
    assert.doesNotMatch(JSON.stringify(pkg), /\uFFFD/, `${rel} must not contain replacement characters`);
  }

  assert.match(read('workers/audio-tokenize/package.json'), /no_detector_installed/);
  assert.match(read('workers/video-tokenize/package.json'), /num_frames hard cap \(32\)/);
  assert.match(read('workers/constrained/package.json'), /never silently falls back to unconstrained sampling/i);
  assert.match(read('workers/runtime-build/package.json'), /root kolm install stays light/i);
  assert.match(read('workers/itkv/package.json'), /stdlib Python tier-classifier/i);
  assert.match(read('workers/tsac/package.json'), /Task-Specific Attention Compiler/);
});

test('W931 quant optimizer extras remain opt-in and never auto-install git research repos', () => {
  const rel = 'workers/quantize/requirements-optimizers.txt';
  const src = read(rel);
  assert.match(src, /KOLM_QUANT_OPTIMIZERS=1 pip install -r requirements-optimizers\.txt/);
  assert.match(src, /placeholders that the operator pins/i);
  assert.doesNotMatch(src, /^[^#\n].*git\+https:/m, `${rel} must not contain active git installs`);
  for (const line of src.split(/\r?\n/).filter((row) => row.includes('git+https://'))) {
    assert.match(line, /^# /, `git dependency remains commented: ${line}`);
    assert.match(line, /@[a-f0-9]{40}\b/, `git dependency is pinned to a full SHA: ${line}`);
  }
});

test('W931 optional data workers reject malformed JSONL instead of silently skipping rows', (t) => {
  const dir = tmpDir(t);
  const malformed = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(malformed, '{"input":"ok","output":"row"}\n{bad json}\n', 'utf8');

  const score = runPython([PY_FILES.scoreQuality, '--pairs', malformed]);
  assert.equal(score.status, 20, score.stderr || score.stdout);
  const scoreBody = parseJsonTail(score.stdout);
  assert.equal(scoreBody.ok, false);
  assert.equal(scoreBody.error, 'malformed_jsonl');
  assert.equal(scoreBody.version, 'quality-v1');
  assert.equal(scoreBody.line, 2);
  assert.doesNotMatch(score.stdout + score.stderr, /bad json/);

  const select = runPython([PY_FILES.selectSubset, '--pairs', malformed, '--target-size', '1']);
  assert.equal(select.status, 0, select.stderr || select.stdout);
  const selectBody = parseJsonTail(select.stdout);
  assert.equal(selectBody.ok, false);
  assert.equal(selectBody.error, 'malformed_jsonl');
  assert.equal(selectBody.version, 'select-subset-v1');
  assert.equal(selectBody.line, 2);

  const scoreSrc = read(PY_FILES.scoreQuality);
  const selectSrc = read(PY_FILES.selectSubset);
  assert.match(scoreSrc, /MAX_ROWS = 250_000/);
  assert.match(scoreSrc, /MAX_LINE_CHARS = 1_000_000/);
  assert.match(selectSrc, /MAX_ROWS = 250_000/);
  assert.match(selectSrc, /MAX_LINE_CHARS = 1_000_000/);
});

test('W931 Python quality/select workers preserve JS feature parity and deterministic selection', () => {
  const script = String.raw`
import importlib.util, json, pathlib
root = pathlib.Path.cwd()
def load(rel, name):
    spec = importlib.util.spec_from_file_location(name, root / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
score = load("workers/data/scripts/score_quality.py", "score_quality")
select = load("workers/data/scripts/select_subset.py", "select_subset")
pairs = [
  {"input": "refund invoice", "output": "1. Open Billing and download the invoice."},
  {"input": "password reset", "output": "- Open Security, then reset the password."},
  {"input": "install desktop", "output": "Download the installer and run setup."},
  {"input": "track order", "output": "Open Orders to track shipment."},
  {"input": "payment card", "output": "Add a card under payment methods."},
  {"input": "cancel plan", "output": "Cancel from the Billing page."},
]
out = {
  "numbered_structure": score.extract_features(pairs[0])[4],
  "bullet_structure": score.extract_features(pairs[1])[4],
  "select_a": select.run("k-center", pairs, 3, select.DEFAULT_SEED),
  "select_b": select.run("k-center", pairs, 3, select.DEFAULT_SEED),
}
print(json.dumps(out))
`;
  const r = runPython(['-c', script]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = parseJsonTail(r.stdout);
  assert.equal(out.numbered_structure, 1);
  assert.equal(out.bullet_structure, 1);
  assert.equal(out.select_a.ok, true);
  assert.equal(out.select_a.n_selected, 3);
  assert.deepEqual(out.select_a.selected_indices, out.select_b.selected_indices);
  assert.equal(new Set(out.select_a.selected_indices).size, 3);
});

test('W931 CoT scrubber is case-insensitive and in-place reruns are idempotent', (t) => {
  const dir = tmpDir(t);
  const input = path.join(dir, 'pairs.jsonl');
  fs.writeFileSync(input, [
    JSON.stringify({ teacher_output: '<THINK>hidden trace</THINK> Final answer' }),
    JSON.stringify({ teacher_output: '<Think>open trace without close' }),
    JSON.stringify({ teacher_output: 'Already clean' }),
    '',
  ].join('\n'), 'utf8');

  const src = read(PY_FILES.scrubThink);
  assert.match(src, /_CLOSE_THINK_RE = re\.compile\(r"<\/think>", re\.IGNORECASE\)/);
  assert.match(src, /shutil\.copy2\(t, bak\)/);
  assert.match(read(PY_FILES.consoleShim), /setup_utf8\(\)/);

  const first = runPython([PY_FILES.scrubThink, '--in', input, '--in-place']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const afterFirst = fs.readFileSync(input, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(afterFirst.map((row) => row.teacher_output), ['Final answer', 'Already clean']);
  const backup = fs.readFileSync(input + '.bak', 'utf8');
  assert.match(backup, /open trace without close/);

  const second = runPython([PY_FILES.scrubThink, '--in', input, '--in-place']);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const afterSecond = fs.readFileSync(input, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(afterSecond, afterFirst);
  assert.equal(fs.readFileSync(input + '.bak', 'utf8'), backup);
});

test('W931 distill CoT marker catalog stays explicit and machine-parseable', () => {
  const rel = 'workers/distill/scripts/cot_markers.json';
  const markers = JSON.parse(read(rel));
  assert.ok(Array.isArray(markers.hard) && markers.hard.length >= 4);
  assert.ok(Array.isArray(markers.soft_opener) && markers.soft_opener.length >= 4);
  assert.ok(Array.isArray(markers.soft_inline) && markers.soft_inline.length >= 4);
  assert.ok(markers.hard.includes('<think>'));
  assert.ok(markers.hard.includes('</think>'));
});

test('W931 direct Python ITKV and TSAC failures redact absolute paths', (t) => {
  const dir = tmpDir(t);
  const secretDir = path.join(dir, 'secret-parent-name');
  fs.mkdirSync(secretDir);

  const missingTokens = path.join(secretDir, 'tokens.jsonl');
  const itkv = runPython([PY_FILES.itkv, '--tokens', missingTokens, '--output', path.join(dir, 'out.jsonl')]);
  assert.equal(itkv.status, 64, itkv.stderr || itkv.stdout);
  const itkvErr = parseJsonTail(itkv.stderr);
  assert.equal(itkvErr.error, 'tokens_file_not_found');
  assert.equal(itkvErr.path_basename, 'tokens.jsonl');
  assert.match(itkvErr.path_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(itkv.stderr, /secret-parent-name/);
  assert.doesNotMatch(itkv.stderr, new RegExp(missingTokens.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));

  const missingProfile = path.join(secretDir, 'profile.json');
  const tsac = runPython([PY_FILES.tsac, '--profile', missingProfile]);
  assert.equal(tsac.status, 64, tsac.stderr || tsac.stdout);
  const tsacErr = parseJsonTail(tsac.stderr);
  assert.equal(tsacErr.error, 'profile_not_found');
  assert.equal(tsacErr.path_basename, 'profile.json');
  assert.match(tsacErr.path_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(tsac.stderr, /secret-parent-name/);
  assert.doesNotMatch(tsac.stderr, new RegExp(missingProfile.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
});

test('W931 depth verification runs worker safety contracts before SOTA audit', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(
    pkg.scripts['verify:worker-safety-contracts'],
    'node --test --test-concurrency=1 tests/wave931-worker-safety-contracts.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:eval-safety-harnesses && npm run verify:worker-safety-contracts && npm run verify:compute-backends && node scripts\/audit-sota-readiness\.cjs/,
  );
});
