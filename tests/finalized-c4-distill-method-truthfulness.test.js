// FINALIZED-C4 - worker truthfulness guards (no lying manifests).
//
// The C4 deep-dive found that cross-tokenizer KD methods (uld / seq-level-kd) and
// logit-level objectives (gkd / forward_kl / ...) fell through to train_lora.py in
// --mode=full and stamped a FALSE distillation_method onto the signed manifest
// (running a DIFFERENT objective than the label claims). The fix makes the worker
// FAIL LOUD (exit 2) rather than sign a false receipt. These tests lock that: the
// worker must refuse, not silently mislabel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER = path.resolve(__dirname, '..', 'workers', 'distill', 'distill.mjs');

function _fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-c4-truth-'));
  fs.writeFileSync(path.join(d, 'spec.json'), JSON.stringify({ job_id: 't', system: '' }));
  fs.writeFileSync(path.join(d, 'seeds.jsonl'), JSON.stringify({ input: 'hi', output: 'yo' }) + '\n');
  return d;
}

function _runWorker(extraArgs, env = {}) {
  const d = _fixture();
  const r = spawnSync('node', [
    WORKER, '--mode=full',
    `--spec=${path.join(d, 'spec.json')}`,
    `--seeds=${path.join(d, 'seeds.jsonl')}`,
    `--out=${path.join(d, 'out')}`,
    '--teacher=anthropic:claude-opus-4-7',
    ...extraArgs,
  ], { encoding: 'utf8', env: { ...process.env, ...env } });
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  return r;
}

test('worker FAILS LOUD (exit 2) on --distillation-method=uld in --mode=full, never mislabels', () => {
  const r = _runWorker(['--distillation-method=uld'], { KOLM_CROSS_TOKENIZER_KD: '1' });
  assert.equal(r.status, 2, 'must exit 2 (fail-loud), not proceed to train+mislabel');
  assert.match(r.stderr, /cross-tokenizer KD|false receipt/i,
    'must explain the refusal: ' + r.stderr.slice(0, 200));
  // It must NOT have produced a manifest stamping uld.
  assert.doesNotMatch(r.stderr, /invoking Python LoRA trainer/i,
    'must not fall through to the LoRA trainer');
});

test('worker FAILS LOUD on --distillation-method=seq-level-kd in --mode=full', () => {
  const r = _runWorker(['--distillation-method=seq-level-kd'], { KOLM_CROSS_TOKENIZER_KD: '1' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cross-tokenizer KD|false receipt/i);
});

test('worker FAILS LOUD on a logit-level --objective=gkd in --mode=full (no silent LoRA no-op)', () => {
  const r = _runWorker(['--objective=gkd']);
  assert.equal(r.status, 2, 'must exit 2, not silently run LoRA');
  assert.match(r.stderr, /logit-level|onpolicy train|on-policy/i,
    'must point at the real on-policy entry point: ' + r.stderr.slice(0, 200));
});

test('worker does NOT trip the guards for a plain lora run (reaches teacher/training stage)', () => {
  // lora is a real SFT method; the guards must not fire. Without API keys the run
  // fails later (teacher call), but NOT with the cross-tokenizer/logit refusal.
  const r = _runWorker(['--distillation-method=lora'], { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' });
  assert.doesNotMatch(r.stderr || '', /cross-tokenizer KD|logit-level objective/i,
    'lora must not trip the truthfulness guards');
});
