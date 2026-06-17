// W651 - direct contract/security test for workers/runtime-build/build.mjs.
//
// Runtime builds produce executable distribution artifacts. The local contract
// must prove target-specific flags, bounded resource knobs, dry-run planning
// without local toolchains, and deterministic receipt hashes over emitted
// binaries/libs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_REPO,
  MAX_BUILD_JOBS,
  PINNED_COMMIT,
  TARGETS,
  createBuildPlan,
  describeTarget,
  emitCmakeArgs,
  hashRuntimeArtifacts,
  listTargets,
  normalizeJobs,
} from '../workers/runtime-build/build.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUILD_SCRIPT = path.join(ROOT, 'workers', 'runtime-build', 'build.mjs');

function sha(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

test('W651 runtime-build target matrix exposes frontier targets and exact CMake flags', () => {
  const slugs = listTargets().map((t) => t.slug).sort();
  assert.deepEqual(slugs, [
    'cpu-avx2',
    'cpu-avx512',
    'cuda-100',
    'cuda-120',
    'cuda-89',
    'cuda-90',
    'metal',
    'rocm-gfx1100',
    'rocm-gfx942',
    'vulkan',
  ].sort());
  assert.equal(describeTarget('cuda-120').arch, 'sm_120');
  assert.equal(describeTarget('metal').vendor, 'apple');
  assert.equal(describeTarget('missing'), null);
  assert.deepEqual(
    emitCmakeArgs('cuda-120', { install_prefix: '/opt/kolm/runtime/cuda-120', openmp: false }).filter((x) => x.startsWith('-D')),
    [
      '-DGGML_CUDA=ON',
      '-DCMAKE_CUDA_ARCHITECTURES=120',
      '-DGGML_CUDA_FA_ALL_QUANTS=ON',
      '-DGGML_CUDA_F16=ON',
      '-DCMAKE_BUILD_TYPE=Release',
      '-DCMAKE_INSTALL_PREFIX=/opt/kolm/runtime/cuda-120',
      '-DGGML_OPENMP=OFF',
    ],
  );
  assert.throws(() => emitCmakeArgs('not-a-target'), /unknown target/);
  assert.equal(TARGETS['cpu-avx2'].sdk, 'none');
});

test('W651 runtime-build createBuildPlan is deterministic, bounded, and shell-free', () => {
  const outDir = path.join(os.tmpdir(), 'kolm-w651-runtime-build-plan');
  const plan = createBuildPlan({
    target: 'cpu-avx2',
    repoUrl: DEFAULT_REPO,
    commit: PINNED_COMMIT,
    outDir,
    jobs: 999999,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.target, 'cpu-avx2');
  assert.equal(plan.repo_url, DEFAULT_REPO);
  assert.equal(plan.commit, PINNED_COMMIT);
  assert.equal(plan.ref_requested, PINNED_COMMIT);
  assert.equal(plan.jobs, MAX_BUILD_JOBS);
  assert.equal(plan.out_dir, path.resolve(outDir));
  assert.equal(plan.steps.length, 5);
  for (const step of plan.steps) {
    assert.equal(Array.isArray(step), true, 'steps are argv arrays, not shell strings');
    assert.equal(step.some((arg) => /&&|\||;/.test(arg)), false, `step must not embed shell control operators: ${step.join(' ')}`);
  }
  assert.deepEqual(plan.steps[0], ['git', 'clone', DEFAULT_REPO, path.join(path.resolve(outDir), 'src')]);
  assert.deepEqual(plan.steps[1], ['git', '-C', path.join(path.resolve(outDir), 'src'), 'checkout', PINNED_COMMIT]);
  assert.equal(plan.steps[3][0], 'cmake');
  assert.equal(plan.steps[3].at(-2), '-j');
  assert.equal(plan.steps[3].at(-1), String(MAX_BUILD_JOBS));
  assert.equal(normalizeJobs(0), 1);
  assert.equal(normalizeJobs(-3), 1);
  assert.equal(normalizeJobs(7.9), 7);
  assert.equal(normalizeJobs(999999), MAX_BUILD_JOBS);
  assert.throws(() => createBuildPlan({ target: 'nope' }), /unknown target/);
});

test('W651 runtime-build dry-run emits a plan without requiring local toolchain', () => {
  const outDir = path.join(os.tmpdir(), `kolm-w651-dry-run-${process.pid}-${Date.now()}`);
  const res = spawnSync(process.execPath, [
    BUILD_SCRIPT,
    '--target=cpu-avx2',
    `--out=${outDir}`,
    '--jobs=0',
    '--dry-run',
    '--json',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const plan = JSON.parse(res.stdout);
  assert.equal(plan.ok, true);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.target, 'cpu-avx2');
  assert.equal(plan.jobs, 1);
  assert.equal(plan.out_dir, path.resolve(outDir));
  assert.equal(Array.isArray(plan.toolchain.missing), true);
  assert.equal(fs.existsSync(outDir), false, 'dry-run must not create build output directories');
});

test('W651 runtime-build JSON errors are machine-readable', () => {
  const missing = spawnSync(process.execPath, [BUILD_SCRIPT, '--json'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).error, 'target_required');

  const unknown = spawnSync(process.execPath, [
    BUILD_SCRIPT,
    '--target=definitely-not-a-target',
    '--dry-run',
    '--json',
  ], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  const body = JSON.parse(unknown.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'unknown_target');
  assert.equal(body.target, 'definitely-not-a-target');
  assert.ok(body.targets.includes('cuda-120'));
});

test('W651 runtime-build hashes only runtime binary/lib artifacts deterministically', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w651-runtime-hash-'));
  try {
    fs.mkdirSync(path.join(outDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(outDir, 'lib', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'bin', 'llama-cli'), 'runner-bytes');
    fs.writeFileSync(path.join(outDir, 'bin', 'readme.txt'), 'ignored text');
    fs.writeFileSync(path.join(outDir, 'lib', 'libggml.so'), 'shared-object');
    fs.writeFileSync(path.join(outDir, 'lib', 'nested', 'libkernels.a'), 'archive-bytes');

    const result = hashRuntimeArtifacts(outDir);
    assert.deepEqual(Object.keys(result.binary_hashes).sort(), [
      'bin/llama-cli',
      'lib/libggml.so',
      'lib/nested/libkernels.a',
    ]);
    assert.equal(result.binary_hashes['bin/llama-cli'], sha('runner-bytes'));
    assert.equal(result.binary_hashes['lib/libggml.so'], sha('shared-object'));
    assert.equal(result.binary_hashes['lib/nested/libkernels.a'], sha('archive-bytes'));
    assert.equal(result.binary_file_count, 3);
    const concat = [
      `bin/llama-cli:${sha('runner-bytes')}`,
      `lib/libggml.so:${sha('shared-object')}`,
      `lib/nested/libkernels.a:${sha('archive-bytes')}`,
    ].sort().join('\n');
    assert.equal(result.binary_tree_sha256, sha(concat));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
