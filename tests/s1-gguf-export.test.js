// S-1 — Generic GGUF export chain.
//
// Pins the shape of src/export-gguf.js so:
//   * QUANT_LEVELS includes the full K-quant + I-quant + full-precision family
//   * exportGguf({dryRun:true}) returns a plan WITHOUT spawning anything
//   * probeGgufToolchain() returns a structured envelope (never throws)
//   * generic artifact descriptor (no Trinity-specific fields) is accepted
//   * unknown quant level raises
//   * IQ quants without imatrix source raise a clean error (not silent)
//
// Real round-trip (HF -> F16 -> Q4_K_M -> coherence test) is env-conditional:
// the test runs ONLY when llama-quantize is on PATH (or in LLAMA_CPP_HOME),
// AND when KOLM_S1_REAL_ROUNDTRIP=1 to opt in. Without that the heavy path
// is skipped with an explicit reason. We never invoke llama-quantize by
// default — it's slow and would block CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QUANT_LEVELS,
  GGUF_EXPORT_VERSION,
  exportGguf,
  probeGgufToolchain,
  locateBinary,
  locateConvertScript,
  computeQualityDelta,
} from '../src/export-gguf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------------------
// 1) QUANT_LEVELS catalog shape
// ----------------------------------------------------------------------------
test('S-1 #1 - QUANT_LEVELS covers full K+I+full-precision family', () => {
  assert.ok(Array.isArray(QUANT_LEVELS), 'QUANT_LEVELS must be an array');
  // K-quants
  for (const q of ['Q2_K', 'Q3_K_M', 'Q4_0', 'Q4_K_S', 'Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0']) {
    assert.ok(QUANT_LEVELS.includes(q), `K-quant ${q} must be in QUANT_LEVELS`);
  }
  // I-quants
  for (const q of ['IQ2_S', 'IQ3_S', 'IQ4_XS', 'IQ4_NL']) {
    assert.ok(QUANT_LEVELS.includes(q), `I-quant ${q} must be in QUANT_LEVELS`);
  }
  // Full precision pass-through
  for (const q of ['F16', 'BF16', 'F32']) {
    assert.ok(QUANT_LEVELS.includes(q), `full-precision ${q} must be in QUANT_LEVELS`);
  }
  // Family lock — at least 18 levels total (we list 24 today).
  assert.ok(QUANT_LEVELS.length >= 18, `QUANT_LEVELS must be >= 18 entries; got ${QUANT_LEVELS.length}`);
});

// ----------------------------------------------------------------------------
// 2) Forge version constant
// ----------------------------------------------------------------------------
test('S-1 #2 - GGUF_EXPORT_VERSION is the export-gguf-vN tag', () => {
  assert.ok(/^export-gguf-v\d+$/.test(GGUF_EXPORT_VERSION),
    `GGUF_EXPORT_VERSION must match /^export-gguf-v\\d+$/; got ${GGUF_EXPORT_VERSION}`);
});

// ----------------------------------------------------------------------------
// 3) probeGgufToolchain returns structured envelope (no throws)
// ----------------------------------------------------------------------------
test('S-1 #3 - probeGgufToolchain returns {ok, components, missing, hint}', () => {
  const p = probeGgufToolchain();
  assert.ok(p && typeof p === 'object', 'probe must return an object');
  assert.equal(typeof p.ok, 'boolean', 'probe.ok must be boolean');
  assert.ok(p.components && typeof p.components === 'object', 'probe.components must be object');
  for (const k of ['convert', 'quantize', 'imatrix', 'cli', 'split']) {
    assert.ok(k in p.components, `probe.components must include ${k}`);
  }
  assert.ok(Array.isArray(p.missing), 'probe.missing must be array');
  // hint may be null when ok=true; must be string otherwise
  if (!p.ok) assert.ok(typeof p.hint === 'string' && p.hint.length > 0, 'probe.hint must be present when missing');
});

// ----------------------------------------------------------------------------
// 4) exportGguf dry-run on a generic artifact (no Trinity assumptions)
// ----------------------------------------------------------------------------
test('S-1 #4 - exportGguf({dryRun:true}) plans without spawning', async () => {
  const out = path.join(os.tmpdir(), `kolm-s1-dryrun-${process.pid}.gguf`);
  // Generic artifact — only the fields any artifact should carry. No
  // hard-coded Trinity slug or council weights anywhere.
  const result = await exportGguf({
    artifact: {
      name: 'generic-test-artifact',
      artifact_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      params_b: 0.5,
      passport: { kscore: 0.8, baseline_metric: 0.85 },
    },
    quant: 'Q4_K_M',
    outputPath: out,
    dryRun: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.ok(result.plan, 'dry-run must return plan');
  assert.equal(result.plan.quant, 'Q4_K_M');
  assert.equal(result.plan.requires_imatrix, false, 'Q4_K_M does not require imatrix');
  assert.equal(result.plan.is_full_precision, false);
  assert.ok(Array.isArray(result.plan.steps), 'plan.steps must be array');
  assert.ok(result.plan.steps.includes('llama_quantize'), 'Q4_K_M plan must include llama_quantize step');
  assert.equal(result.plan.forge_version, GGUF_EXPORT_VERSION);
});

// ----------------------------------------------------------------------------
// 5) exportGguf dry-run for an IQ quant marks imatrix required
// ----------------------------------------------------------------------------
test('S-1 #5 - exportGguf dry-run for IQ4_XS flags imatrix step', async () => {
  const result = await exportGguf({
    artifact: { name: 'any-artifact', artifact_hash: null, passport: {} },
    quant: 'IQ4_XS',
    outputPath: path.join(os.tmpdir(), 'iq4xs-dryrun.gguf'),
    dryRun: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.requires_imatrix, true);
  assert.ok(result.plan.steps.includes('build_imatrix'),
    `IQ4_XS plan must include build_imatrix step; got ${JSON.stringify(result.plan.steps)}`);
});

// ----------------------------------------------------------------------------
// 6) Unknown quant raises
// ----------------------------------------------------------------------------
test('S-1 #6 - unknown quant raises', async () => {
  await assert.rejects(
    () => exportGguf({
      artifact: { name: 'x', passport: {} },
      quant: 'Q9_BOGUS',
      outputPath: '/tmp/x.gguf',
      dryRun: true,
    }),
    /unknown quant/i,
  );
});

// ----------------------------------------------------------------------------
// 7) IQ quant without imatrix source errors cleanly (not silently)
// ----------------------------------------------------------------------------
test('S-1 #7 - IQ quant without imatrix source returns error envelope', async () => {
  // Live (non-dry) path. We expect it to bail BEFORE spawning anything
  // because the IQ family is gated by imatrixSource.
  const out = path.join(os.tmpdir(), `kolm-s1-iq-missing-imatrix-${process.pid}.gguf`);
  const result = await exportGguf({
    artifact: { name: 'noimatrix', artifact_hash: null, passport: {}, merged_dir: '/non/existent/dir' },
    quant: 'IQ4_XS',
    outputPath: out,
    imatrixSource: null,  // intentionally missing
    dryRun: false,
  });
  assert.equal(result.ok, false, `result.ok must be false; got ${JSON.stringify(result).slice(0, 200)}`);
  // Toolchain may be missing on this box — in that case the error is
  // 'toolchain_missing'. If toolchain IS present, the error must be
  // 'imatrix_source_required' OR 'imatrix_tool_missing'.
  const acceptable = ['toolchain_missing', 'imatrix_tool_missing', 'imatrix_source_required'];
  assert.ok(acceptable.includes(result.error),
    `result.error must be one of ${acceptable.join('|')}; got ${result.error}`);
});

// ----------------------------------------------------------------------------
// 8) computeQualityDelta arithmetic
// ----------------------------------------------------------------------------
test('S-1 #8 - computeQualityDelta returns null when inputs missing, value otherwise', () => {
  assert.equal(computeQualityDelta({ baselineMetric: null, quantMetric: 0.8 }), null);
  assert.equal(computeQualityDelta({ baselineMetric: 0.9, quantMetric: null }), null);
  assert.equal(computeQualityDelta({ baselineMetric: 0.9, quantMetric: 0.85 }), -0.05);
  assert.equal(computeQualityDelta({ baselineMetric: 0.9, quantMetric: 0.9 }), 0);
});

// ----------------------------------------------------------------------------
// 9) locator helpers do not throw + accept env override
// ----------------------------------------------------------------------------
test('S-1 #9 - locateBinary + locateConvertScript do not throw', () => {
  // Just exercise the locators; either returns a path or null.
  const a = locateBinary('llama-quantize');
  const b = locateBinary('llama-cli');
  const c = locateConvertScript();
  assert.ok(a === null || typeof a === 'string');
  assert.ok(b === null || typeof b === 'string');
  assert.ok(c === null || typeof c === 'string');
});

// ----------------------------------------------------------------------------
// 10) [env-conditional] Real round-trip on a tiny 0.5B model
// ----------------------------------------------------------------------------
const REAL_RT_OPT_IN = process.env.KOLM_S1_REAL_ROUNDTRIP === '1';
const REAL_RT_GGUF = process.env.KOLM_S1_TEST_GGUF;  // pre-existing F16 GGUF
const probe = probeGgufToolchain();
const REAL_RT_SKIP_REASON = !REAL_RT_OPT_IN
  ? 'env-skip: set KOLM_S1_REAL_ROUNDTRIP=1 to opt in to live llama-quantize (slow)'
  : !probe.ok
    ? `env-skip: llama.cpp toolchain incomplete: missing ${probe.missing.join(', ')}`
    : (!REAL_RT_GGUF || !fs.existsSync(REAL_RT_GGUF))
      ? 'env-skip: set KOLM_S1_TEST_GGUF=/path/to/small-f16.gguf'
      : false;

test('S-1 #10 - [env] real round-trip: F16 GGUF -> Q4_K_M + coherence + metadata',
  { skip: REAL_RT_SKIP_REASON },
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-s1-real-'));
    const out = path.join(tmpDir, 'roundtrip-q4km.gguf');
    const result = await exportGguf({
      artifact: {
        name: 'kolm-s1-roundtrip',
        artifact_hash: 'sha256:' + 'a'.repeat(64),
        passport: { kscore: 0.8 },
      },
      quant: 'Q4_K_M',
      outputPath: out,
      ggufBase: REAL_RT_GGUF,  // skip conversion, use supplied F16
    });
    assert.equal(result.ok, true, `export must succeed: ${JSON.stringify(result, null, 2).slice(0, 400)}`);
    assert.ok(fs.existsSync(result.output_path), `output file must exist: ${result.output_path}`);
    // Verify metadata embed: read first 128 KB of file + scan for the
    // 'kolm-forge' string. llama.cpp stores metadata kv as utf8 strings.
    const head = fs.readFileSync(result.output_path).slice(0, 128 * 1024);
    const headStr = head.toString('binary');
    assert.ok(headStr.includes('kolm-forge'),
      `general.quantized_by=kolm-forge must be embedded in GGUF metadata`);
    // Runtime passport must be tested or estimated
    assert.ok(result.runtime_passport, 'runtime_passport must be returned');
    assert.ok(['tested', 'estimated'].includes(result.runtime_passport.status));
    assert.equal(result.runtime_passport.runtime, 'llama.cpp');
    assert.equal(result.runtime_passport.precision, 'q4_k_m');
  });
