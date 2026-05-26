// tests/wrapper-s6.test.js
//
// S-6 — verify the additional export format modules (EXL2, GPTQ, AWQ, FP8,
// NVFP4, HQQ, MLX) and the FORMAT_REGISTRY central index.
//
// These tests DO NOT invoke any real export toolchain. Every assertion runs
// in --preview / pure-metadata mode. The probe* helpers may spawn `python -c`
// but we treat their return values as informational only — the test passes
// whether or not the toolchains are installed on the host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';

import * as exl2 from '../src/export-exl2.js';
import * as gptq from '../src/export-gptq.js';
import * as awq from '../src/export-awq.js';
import * as fp8 from '../src/export-fp8.js';
import * as nvfp4 from '../src/export-nvfp4.js';
import * as hqq from '../src/export-hqq.js';
import * as mlx from '../src/export-mlx.js';
import {
  FORMAT_REGISTRY,
  FORMAT_REGISTRY_VERSION,
  listFormats,
  listFormatIds,
  getFormat,
  isQuantSupported,
  getInstallHint,
  gpuRequiredFormats,
  cpuOnlyFormats,
} from '../src/export-format-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'cli', 'kolm.js');

// Reusable fake artifact for preview-only checks. No filesystem requirements.
const ARTIFACT = {
  name: 'fake-artifact',
  artifact_hash: 'sha256:0123',
  params_b: 7,
  merged_dir: path.join(os.tmpdir(), 'kolm-s6-fake-hf'),
  passport: {},
};

const MODULES = [
  { id: 'exl2', mod: exl2, quants: ['2.4bpw', '4.0bpw', '6.0bpw', '8.0bpw'] },
  { id: 'gptq', mod: gptq, quants: ['w2g16', 'w4g128', 'w8g32'] },
  { id: 'awq', mod: awq, quants: ['w3', 'w4', 'w4-g64', 'w8'] },
  { id: 'fp8', mod: fp8, quants: ['e4m3', 'e5m2', 'w8a8', 'w8a16'] },
  { id: 'nvfp4', mod: nvfp4, quants: ['w4a4', 'w4a8', 'w8a8'] },
  { id: 'hqq', mod: hqq, quants: ['w2_g32', 'w4_g64', 'w8_g32'] },
  { id: 'mlx', mod: mlx, quants: ['4bit', '8bit', 'mixed-4-8', 'fp16'] },
];

// ----------------------------------------------------------------------------
// Module API shape (1 test per module, 7 total)
// ----------------------------------------------------------------------------

for (const { id, mod, quants } of MODULES) {
  test(`${id}: module exports the required API shape`, () => {
    assert.ok(Array.isArray(mod.QUANT_LEVELS), `${id}.QUANT_LEVELS must be array`);
    assert.ok(mod.QUANT_LEVELS.length >= 3, `${id}.QUANT_LEVELS too short (have ${mod.QUANT_LEVELS.length})`);
    assert.ok(Object.isFrozen(mod.QUANT_LEVELS), `${id}.QUANT_LEVELS must be frozen`);
    assert.equal(typeof mod.RUNTIME_HINT, 'string', `${id}.RUNTIME_HINT must be a string`);
    assert.ok(mod.RUNTIME_HINT.length > 0, `${id}.RUNTIME_HINT must be non-empty`);
    assert.equal(typeof mod.previewExport, 'function', `${id}.previewExport must be a function`);
    assert.equal(typeof mod.runExport, 'function', `${id}.runExport must be a function`);
    // Every advertised quant must actually appear in the array.
    for (const q of quants) {
      assert.ok(mod.QUANT_LEVELS.includes(q), `${id}.QUANT_LEVELS missing ${q}`);
    }
  });
}

// ----------------------------------------------------------------------------
// previewExport envelope shape (1 test per module x quant combo, 7 tests)
// ----------------------------------------------------------------------------

for (const { id, mod, quants } of MODULES) {
  test(`${id}: previewExport returns a sane envelope for every quant`, () => {
    for (const q of quants) {
      const target_dir = path.join(os.tmpdir(), `kolm-s6-${id}-${q.replace(/[^a-z0-9]/gi, '_')}`);
      const out = mod.previewExport({ artifact: ARTIFACT, quant: q, target_dir });
      assert.equal(typeof out, 'object', `${id}/${q} preview must return object`);
      assert.equal(typeof out.projected_size_bytes, 'number', `${id}/${q} projected_size_bytes`);
      assert.ok(out.projected_size_bytes > 0, `${id}/${q} projected_size_bytes > 0 (got ${out.projected_size_bytes})`);
      assert.equal(typeof out.projected_time_s, 'number', `${id}/${q} projected_time_s`);
      assert.ok(out.projected_time_s >= 0, `${id}/${q} projected_time_s >= 0`);
      assert.equal(typeof out.requires_gpu, 'boolean', `${id}/${q} requires_gpu boolean`);
      assert.equal(typeof out.runtime_hint, 'string', `${id}/${q} runtime_hint string`);
      assert.ok(out.runtime_hint.length > 0, `${id}/${q} runtime_hint non-empty`);
      assert.equal(typeof out.command, 'string', `${id}/${q} command string`);
      assert.ok(out.command.length > 0, `${id}/${q} command non-empty`);
      assert.equal(out.format, id, `${id}/${q} format field must equal module id`);
    }
  });
}

// ----------------------------------------------------------------------------
// previewExport rejects invalid quant
// ----------------------------------------------------------------------------

test('previewExport throws on invalid quant for every module', () => {
  for (const { id, mod } of MODULES) {
    assert.throws(
      () => mod.previewExport({ artifact: ARTIFACT, quant: 'not-a-real-quant-9999', target_dir: '/tmp/x' }),
      /invalid/i,
      `${id}.previewExport should reject invalid quant`,
    );
  }
});

// ----------------------------------------------------------------------------
// previewExport throws on missing required args
// ----------------------------------------------------------------------------

test('previewExport throws on missing artifact / quant / target_dir', () => {
  for (const { id, mod } of MODULES) {
    assert.throws(() => mod.previewExport({}), `${id}: must require artifact`);
    assert.throws(() => mod.previewExport({ artifact: ARTIFACT }), `${id}: must require quant`);
    assert.throws(() => mod.previewExport({ artifact: ARTIFACT, quant: mod.QUANT_LEVELS[0] }), `${id}: must require target_dir`);
  }
});

// ----------------------------------------------------------------------------
// runExport gracefully returns toolchain-missing envelope (no exception)
// ----------------------------------------------------------------------------

test('runExport returns toolchain-missing envelope when artifact.merged_dir absent', async () => {
  // Use a fake merged_dir that does not exist on disk. runExport must NEVER
  // throw — only return { ok:false, error, ... }.
  const fakeArtifact = { ...ARTIFACT, merged_dir: '/this/path/does/not/exist/anywhere' };
  for (const { id, mod } of MODULES) {
    const out = await mod.runExport({
      artifact: fakeArtifact,
      quant: mod.QUANT_LEVELS[0],
      target_dir: path.join(os.tmpdir(), `kolm-s6-run-${id}`),
    });
    assert.equal(typeof out, 'object', `${id}: runExport must return object`);
    assert.equal(out.ok, false, `${id}: runExport with bad merged_dir must report ok:false`);
    assert.ok(out.error, `${id}: runExport must surface an error code`);
  }
});

// ----------------------------------------------------------------------------
// FORMAT_REGISTRY has 8 entries and each has the expected shape
// ----------------------------------------------------------------------------

test('FORMAT_REGISTRY has exactly 8 entries (gguf + 7 S-6 formats)', () => {
  const ids = Object.keys(FORMAT_REGISTRY);
  assert.equal(ids.length, 8, `expected 8 registry entries, got ${ids.length}: ${ids.join(', ')}`);
  const expected = ['gguf', 'exl2', 'gptq', 'awq', 'fp8', 'nvfp4', 'hqq', 'mlx'];
  for (const k of expected) {
    assert.ok(FORMAT_REGISTRY[k], `FORMAT_REGISTRY missing ${k}`);
  }
});

test('FORMAT_REGISTRY entries all have the required fields', () => {
  for (const [id, entry] of Object.entries(FORMAT_REGISTRY)) {
    assert.equal(entry.id, id, `${id}: registry id must match key`);
    assert.equal(typeof entry.name, 'string', `${id}: name`);
    assert.ok(entry.name.length > 0, `${id}: name non-empty`);
    assert.ok(Array.isArray(entry.quant_levels), `${id}: quant_levels array`);
    assert.ok(entry.quant_levels.length > 0, `${id}: quant_levels non-empty`);
    assert.ok(Array.isArray(entry.runtimes), `${id}: runtimes array`);
    assert.ok(entry.runtimes.length > 0, `${id}: runtimes non-empty`);
    assert.equal(typeof entry.requires_gpu, 'boolean', `${id}: requires_gpu boolean`);
    assert.equal(typeof entry.vendor, 'string', `${id}: vendor`);
    assert.equal(typeof entry.install_hint, 'string', `${id}: install_hint`);
    assert.ok(entry.install_hint.length > 0, `${id}: install_hint non-empty`);
    assert.ok(Object.isFrozen(entry), `${id}: entry must be frozen`);
  }
  assert.ok(Object.isFrozen(FORMAT_REGISTRY), 'FORMAT_REGISTRY must be frozen');
});

test('listFormats returns 8 entries in stable order', () => {
  const out = listFormats();
  assert.equal(out.length, 8);
  // Stable lexicographic order
  const ids = out.map((e) => e.id);
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, 'listFormats must be lexicographically sorted');
});

test('listFormatIds returns 8 lowercase ids', () => {
  const ids = listFormatIds();
  assert.equal(ids.length, 8);
  for (const id of ids) {
    assert.equal(id, id.toLowerCase(), `format id must be lowercase: ${id}`);
  }
});

test('getFormat is case-insensitive and returns null for unknown', () => {
  assert.equal(getFormat('GGUF').id, 'gguf');
  assert.equal(getFormat('EXL2').id, 'exl2');
  assert.equal(getFormat('  mlx  ').id, 'mlx');
  assert.equal(getFormat('not-a-format'), null);
  assert.equal(getFormat(null), null);
  assert.equal(getFormat(''), null);
});

test('isQuantSupported matches each module against the registry', () => {
  assert.equal(isQuantSupported('gguf', 'Q4_K_M'), true);
  assert.equal(isQuantSupported('gguf', 'q4_k_m'), true);
  assert.equal(isQuantSupported('exl2', '4.0bpw'), true);
  assert.equal(isQuantSupported('gptq', 'w4g128'), true);
  assert.equal(isQuantSupported('awq', 'w4'), true);
  assert.equal(isQuantSupported('fp8', 'e4m3'), true);
  assert.equal(isQuantSupported('nvfp4', 'w4a4'), true);
  assert.equal(isQuantSupported('hqq', 'w4_g64'), true);
  assert.equal(isQuantSupported('mlx', '4bit'), true);
  assert.equal(isQuantSupported('gguf', 'made-up-quant'), false);
  assert.equal(isQuantSupported('unknown-format', 'q4_k_m'), false);
});

test('getInstallHint returns a hint for every format', () => {
  for (const id of listFormatIds()) {
    const hint = getInstallHint(id);
    assert.equal(typeof hint, 'string');
    assert.ok(hint.length > 0);
  }
  assert.ok(getInstallHint('not-real').includes('unknown'));
});

test('gpuRequiredFormats vs cpuOnlyFormats partition is correct', () => {
  const gpu = gpuRequiredFormats();
  const cpu = cpuOnlyFormats();
  assert.equal(gpu.length + cpu.length, listFormatIds().length, 'every format must land in exactly one bucket');
  for (const id of gpu) {
    assert.equal(FORMAT_REGISTRY[id].requires_gpu, true, `${id} in gpu bucket but requires_gpu=false`);
  }
  for (const id of cpu) {
    assert.equal(FORMAT_REGISTRY[id].requires_gpu, false, `${id} in cpu bucket but requires_gpu=true`);
  }
  // Specific expectations: gguf, hqq, mlx are CPU-friendly; the rest need GPU.
  assert.ok(cpu.includes('gguf'));
  assert.ok(cpu.includes('hqq'));
  assert.ok(cpu.includes('mlx'));
  assert.ok(gpu.includes('exl2'));
  assert.ok(gpu.includes('gptq'));
  assert.ok(gpu.includes('awq'));
  assert.ok(gpu.includes('fp8'));
  assert.ok(gpu.includes('nvfp4'));
});

test('FORMAT_REGISTRY_VERSION is a stable string', () => {
  assert.equal(typeof FORMAT_REGISTRY_VERSION, 'string');
  assert.match(FORMAT_REGISTRY_VERSION, /^format-registry-v\d+$/);
});

// ----------------------------------------------------------------------------
// CLI integration — `kolm export --format <id> --quant <q> --preview`
// ----------------------------------------------------------------------------

test('CLI: kolm export --format exl2 --quant 4.0bpw --preview returns a preview envelope', () => {
  const r = spawnSync(execPath, [CLI, 'export', '--format', 'exl2', '--quant', '4.0bpw', '--preview'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, KOLM_NO_ANALYTICS: '1' },
  });
  assert.equal(r.status, 0, `CLI exit ${r.status}; stderr=${(r.stderr || '').slice(-512)}`);
  const out = (r.stdout || '').trim();
  // Output should be parseable JSON containing the preview shape.
  let parsed;
  try { parsed = JSON.parse(out); } catch (e) {
    assert.fail(`CLI output is not valid JSON: ${out.slice(-512)}`);
  }
  assert.equal(parsed.format, 'exl2');
  assert.equal(typeof parsed.projected_size_bytes, 'number');
  assert.ok(parsed.projected_size_bytes > 0);
  assert.equal(typeof parsed.projected_time_s, 'number');
  assert.equal(parsed.requires_gpu, true);
  assert.equal(typeof parsed.runtime_hint, 'string');
});

test('CLI: kolm export --format gptq --quant w4g128 --preview returns a preview envelope', () => {
  const r = spawnSync(execPath, [CLI, 'export', '--format', 'gptq', '--quant', 'w4g128', '--preview'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, KOLM_NO_ANALYTICS: '1' },
  });
  assert.equal(r.status, 0, `CLI exit ${r.status}; stderr=${(r.stderr || '').slice(-512)}`);
  const parsed = JSON.parse((r.stdout || '').trim());
  assert.equal(parsed.format, 'gptq');
  assert.equal(parsed.bits, 4);
  assert.equal(parsed.group_size, 128);
});

test('CLI: kolm export --format mlx --quant 4bit --preview returns a preview envelope', () => {
  const r = spawnSync(execPath, [CLI, 'export', '--format', 'mlx', '--quant', '4bit', '--preview'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, KOLM_NO_ANALYTICS: '1' },
  });
  assert.equal(r.status, 0, `CLI exit ${r.status}; stderr=${(r.stderr || '').slice(-512)}`);
  const parsed = JSON.parse((r.stdout || '').trim());
  assert.equal(parsed.format, 'mlx');
  assert.equal(parsed.bits, 4);
  assert.equal(parsed.requires_gpu, false);
});

test('CLI: kolm export --format invalid --quant whatever --preview exits non-zero', () => {
  const r = spawnSync(execPath, [CLI, 'export', '--format', 'not-a-real-format', '--quant', 'q4', '--preview'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, KOLM_NO_ANALYTICS: '1' },
  });
  assert.notEqual(r.status, 0, 'CLI should reject unknown --format');
  const combined = (r.stderr || '') + (r.stdout || '');
  assert.match(combined, /format|unknown|invalid/i, 'CLI should surface an error mentioning format');
});

test('CLI: kolm export --format fp8 --quant e4m3 --preview returns a preview envelope', () => {
  const r = spawnSync(execPath, [CLI, 'export', '--format', 'fp8', '--quant', 'e4m3', '--preview'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, KOLM_NO_ANALYTICS: '1' },
  });
  assert.equal(r.status, 0, `CLI exit ${r.status}; stderr=${(r.stderr || '').slice(-512)}`);
  const parsed = JSON.parse((r.stdout || '').trim());
  assert.equal(parsed.format, 'fp8');
  assert.equal(parsed.weight_dtype, 'e4m3');
});
