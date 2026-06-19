// W975 - shared Python runtime boundary.
//
// Locks the architecture answer: Node remains the control plane, while Python
// owns ML/proof workers through one interpreter-selection contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PYTHON_ENV_PRECEDENCE,
  PYTHON_RUNTIME_CONTRACT_VERSION,
  defaultPythonExecutable,
  resolvePythonRuntime,
} from '../src/python-runtime.js';
import { resolveTrainer as resolveSpecDecodeTrainer } from '../src/spec-decode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const MIGRATED = [
  'src/distill-grpo.js',
  'src/distill-grpo-frontier.js',
  'src/distill-preference.js',
  'src/distill-rejection-sampling.js',
  'src/spec-decode.js',
  'src/moe-to-dense.js',
  'src/model-merge.js',
  'src/nras-verifier.js',
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function withEnv(patch, fn) {
  const keys = [
    'KOLM_PYTHON',
    'KOLM_PYTHON_BIN',
    'PYTHON',
    'KOLM_PY',
    'KOLM_SPECDECODE_NO_TRAINER',
    'KOLM_SPECDECODE_TRAINER',
    'PATH',
  ];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, patch);
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

test('W975 resolver pins Python interpreter precedence and contract version', () => {
  assert.equal(PYTHON_RUNTIME_CONTRACT_VERSION, 'w975-python-runtime-v1');
  assert.deepEqual(PYTHON_ENV_PRECEDENCE, ['KOLM_PYTHON', 'KOLM_PYTHON_BIN', 'PYTHON', 'KOLM_PY']);

  assert.deepEqual(
    resolvePythonRuntime({
      env: {
        KOLM_PYTHON: 'py-a',
        KOLM_PYTHON_BIN: 'py-b',
        PYTHON: 'py-c',
        KOLM_PY: 'py-d',
      },
      platform: 'linux',
    }),
    { command: 'py-a', source: 'KOLM_PYTHON', contract_version: PYTHON_RUNTIME_CONTRACT_VERSION }
  );
  assert.equal(resolvePythonRuntime({ env: { KOLM_PYTHON_BIN: 'py-bin', PYTHON: 'py' } }).command, 'py-bin');
  assert.equal(resolvePythonRuntime({ env: { PYTHON: 'py' } }).source, 'PYTHON');
  assert.equal(resolvePythonRuntime({ env: { KOLM_PY: 'legacy-py' } }).command, 'legacy-py');
});

test('W975 resolver falls back by platform without claiming Python is installed', () => {
  assert.equal(defaultPythonExecutable('win32'), 'python');
  assert.equal(defaultPythonExecutable('linux'), 'python3');
  assert.deepEqual(
    resolvePythonRuntime({ env: {}, platform: 'win32' }),
    { command: 'python', source: 'platform_win32_default', contract_version: PYTHON_RUNTIME_CONTRACT_VERSION }
  );
  assert.deepEqual(
    resolvePythonRuntime({ env: {}, platform: 'linux' }),
    { command: 'python3', source: 'platform_posix_default', contract_version: PYTHON_RUNTIME_CONTRACT_VERSION }
  );
});

test('W975 migrated ML/proof dispatchers import shared Python runtime policy', () => {
  for (const rel of MIGRATED) {
    const body = read(rel);
    assert.match(body, /from '\.\/python-runtime\.js'/, `${rel} must import the shared runtime resolver`);
    assert.doesNotMatch(
      body,
      /process\.env\.KOLM_PYTHON\s*\|\|\s*process\.env\.PYTHON/,
      `${rel} must not carry the old local KOLM_PYTHON/PYTHON fallback chain`
    );
  }
});

test('W975 in-repo Python trainer resolution honors KOLM_PYTHON_BIN', () => {
  withEnv({ KOLM_PYTHON_BIN: 'kolm-w975-python-bin', PATH: '' }, () => {
    const trainer = resolveSpecDecodeTrainer();
    assert.equal(trainer.source, 'in_repo');
    assert.equal(trainer.argv[0], 'kolm-w975-python-bin');
    assert.match(trainer.argv[1], /eagle3_train\.py|train_specdecode\.py/);
  });
});
