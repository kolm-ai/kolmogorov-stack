// tests/wave635-speculative-registry-sync.test.js
//
// W635 - keep JS compile/bench speculative draft pairings and Python serve
// draft pairings in lockstep, while keeping EAGLE head repos as a separate
// registry by design.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DRAFT_PAIRINGS,
  pickDraft,
} from '../src/speculative-decoding.js';
import {
  EAGLE_HEAD_REGISTRY,
} from '../src/serve-config.js';

function pythonBin() {
  const candidates = [process.env.PYTHON, 'python', 'python3'].filter(Boolean);
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ['--version'], { stdio: 'pipe', timeout: 10_000 });
    if (r.status === 0) return candidate;
  }
  return null;
}

const PY = pythonBin();
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function loadPythonSpeculative() {
  const code = [
    'import json',
    'from apps.trainer.speculative import DRAFT_PAIRINGS, pick_draft',
    'payload = {',
    '  "pairings": DRAFT_PAIRINGS,',
    '  "qwen_suffix": pick_draft("Qwen/Qwen2.5-7B-Instruct-AWQ"),',
    '  "qwen3": pick_draft("Qwen/Qwen3-8B"),',
    '  "llama70": pick_draft("meta-llama/Llama-3.1-70B-Instruct"),',
    '}',
    'print(json.dumps(payload, sort_keys=True))',
  ].join('\n');
  const r = spawnSync(PY, ['-c', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `python speculative registry load failed\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('W635 JS and Python draft pairings are identical', { skip: PY ? false : 'python not available' }, () => {
  const py = loadPythonSpeculative();
  assert.deepEqual(py.pairings, DRAFT_PAIRINGS);
  assert.equal(py.qwen_suffix, pickDraft('Qwen/Qwen2.5-7B-Instruct-AWQ'));
  assert.equal(py.qwen3, pickDraft('Qwen/Qwen3-8B'));
  assert.equal(py.llama70, pickDraft('meta-llama/Llama-3.1-70B-Instruct'));
});

test('W635 EAGLE registry remains head-repo-only, not a duplicate draft map', () => {
  assert.ok(Object.keys(EAGLE_HEAD_REGISTRY).length >= 3);
  for (const [target, head] of Object.entries(EAGLE_HEAD_REGISTRY)) {
    assert.notEqual(head, DRAFT_PAIRINGS[target], `EAGLE head for ${target} must not duplicate the draft-model pairing`);
    assert.match(head, /(eagle|speculator)/i, `EAGLE registry value should look like a draft-head repo: ${head}`);
  }
  assert.ok(DRAFT_PAIRINGS['qwen/qwen3-8b'], 'qwen3 still has a separate draft-model fallback');
  assert.ok(EAGLE_HEAD_REGISTRY['qwen/qwen3-8b'], 'qwen3 still has an EAGLE head when runtime supports it');
});
