// W957 - EAGLE-3 speculative-decoding trainer boundary.
//
// Proves the ML method lives in Python while JS remains a thin control plane:
//   - apps/trainer/eagle3_train.py self-test
//   - dry-run emits manifest.speculative_decoding consumed by serve-config
//   - src/spec-decode.js resolves the canonical Python trainer by default
//   - trainSpecDecode can dispatch the Python trainer through env-array

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as specdecode from '../src/spec-decode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const EAGLE3_PY = path.join(REPO, 'apps', 'trainer', 'eagle3_train.py');

function pythonBin() {
  const candidates = [
    process.env.KOLM_PYTHON,
    process.env.PYTHON,
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python',
      process.platform === 'win32' ? 'python.exe' : 'bin/python'),
    process.platform === 'win32' ? 'python' : 'python3',
    'python3',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (!r.error && r.status === 0) return candidate;
  }
  return null;
}

function requirePython(t) {
  const py = pythonBin();
  if (!py) {
    t.skip('python not available');
    return null;
  }
  return py;
}

function tmpRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w957-eagle3-'));
  const pairs = path.join(dir, 'pairs.jsonl');
  fs.writeFileSync(pairs, [
    JSON.stringify({ prompt: 'Explain cache locality briefly.', target: 'Cache locality keeps nearby memory hot.' }),
    JSON.stringify({ prompt: 'Name one speculative decoding benefit.', target: 'It verifies draft tokens in batches.' }),
  ].join('\n') + '\n');
  return { dir, pairs, out: path.join(dir, 'out') };
}

test('1. eagle3_train.py self-test validates EAGLE-3 planning and manifest logic', (t) => {
  const py = requirePython(t);
  if (!py) return;
  assert.ok(fs.existsSync(EAGLE3_PY), `missing trainer at ${EAGLE3_PY}`);
  const r = spawnSync(py, [EAGLE3_PY, '--self-test'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `self-test failed\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true);
  assert.ok(out.checks.includes('feature_layers'));
  assert.ok(out.checks.includes('ttt_schedule'));
  assert.ok(out.checks.includes('manifest_speculative_decoding'));
});

test('2. eagle3_train.py dry-run emits serve-ready speculative_decoding manifest', (t) => {
  const py = requirePython(t);
  if (!py) return;
  const { pairs, out } = tmpRun();
  const r = spawnSync(py, [
    EAGLE3_PY,
    '--pairs', pairs,
    '--base', 'qwen/qwen2.5-7b-instruct',
    '--out', out,
    '--dry-run',
    '--feature-layers', '8,16,24,32',
    '--num-speculative-tokens', '6',
    '--eagle-topk', '9',
    '--num-steps', '6',
    '--num-draft-tokens', '48',
  ], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `dry-run failed\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'run-meta.json'), 'utf8'));
  assert.equal(meta.objective, 'spec_decode');
  assert.equal(meta.algorithm, 'eagle3_multilayer_feature_head');
  assert.equal(meta.mode, 'dry_run');
  assert.deepEqual(meta.feature_layers, [8, 16, 24, 32]);
  assert.equal(meta.training_time_test.enabled, true);
  assert.equal(meta.training_time_test.schedule.length, 6);
  assert.equal(meta.speculative_decoding.head_kind, 'eagle3');
  assert.equal(meta.speculative_decoding.head_id, path.resolve(out));
  assert.equal(meta.speculative_decoding.eagle_topk, 9);
  assert.equal(meta.speculative_decoding.num_steps, 6);
  assert.equal(meta.speculative_decoding.num_draft_tokens, 48);
  assert.equal(meta.speculative_decoding.feature_fusion, 'multi_layer_concat_mlp');
});

test('3. spec-decode resolveTrainer defaults to apps/trainer/eagle3_train.py', () => {
  const prev = process.env.KOLM_SPECDECODE_TRAINER;
  const prevNo = process.env.KOLM_SPECDECODE_NO_TRAINER;
  delete process.env.KOLM_SPECDECODE_TRAINER;
  delete process.env.KOLM_SPECDECODE_NO_TRAINER;
  try {
    const t = specdecode.resolveTrainer();
    assert.ok(t);
    assert.equal(t.source, 'in_repo');
    assert.equal(path.resolve(t.argv[1]), path.resolve(EAGLE3_PY));
    const d = specdecode.doctor();
    assert.equal(d.ok, true);
    assert.equal(path.resolve(d.trainer), path.resolve(EAGLE3_PY));
  } finally {
    if (prev === undefined) delete process.env.KOLM_SPECDECODE_TRAINER;
    else process.env.KOLM_SPECDECODE_TRAINER = prev;
    if (prevNo === undefined) delete process.env.KOLM_SPECDECODE_NO_TRAINER;
    else process.env.KOLM_SPECDECODE_NO_TRAINER = prevNo;
  }
});

test('4. trainSpecDecode dispatches the Python EAGLE-3 trainer through env-array', (t) => {
  const py = requirePython(t);
  if (!py) return;
  const { pairs, out } = tmpRun();
  const prev = process.env.KOLM_SPECDECODE_TRAINER;
  const prevNo = process.env.KOLM_SPECDECODE_NO_TRAINER;
  process.env.KOLM_SPECDECODE_TRAINER = JSON.stringify([py, EAGLE3_PY, '--dry-run']);
  delete process.env.KOLM_SPECDECODE_NO_TRAINER;
  try {
    const r = specdecode.trainSpecDecode({
      pairsPath: pairs,
      basePath: 'qwen/qwen2.5-7b-instruct',
      draftKind: 'eagle3',
      outDir: out,
      namespace: 'w957',
      tenant_id: 'tenant-w957',
      timeoutMs: 60000,
    });
    assert.equal(r.ok, true, JSON.stringify(r, null, 2));
    assert.equal(r.trainer_source, 'env-array');
    assert.equal(r.manifest.algorithm, 'eagle3_multilayer_feature_head');
    assert.equal(r.manifest.speculative_decoding.head_kind, 'eagle3');
    assert.equal(r.manifest.speculative_decoding.head_id, path.resolve(out));
  } finally {
    if (prev === undefined) delete process.env.KOLM_SPECDECODE_TRAINER;
    else process.env.KOLM_SPECDECODE_TRAINER = prev;
    if (prevNo === undefined) delete process.env.KOLM_SPECDECODE_NO_TRAINER;
    else process.env.KOLM_SPECDECODE_NO_TRAINER = prevNo;
  }
});
