// W867 - Trinity-500 council distillation lock-in.
//
// Pins the shape of the trinity-500-2026-05-26 distill run:
//   - spec.json declares 3-teacher council
//   - passport.json carries provenance (run_id, adapter_sha256, holdout)
//   - merged/qwen-merged/README.md is the HF model card
//   - merged/gguf/ contains the 4 quantization variants + Modelfile
//
// The distill-run lives OUTSIDE the repo at ~/.kolm/distill-runs/ (user
// machine state, not source). Tests env-skip with an explicit reason when
// the directory is absent — matches the pattern of wave144-native-compile
// for environment-conditional checks.
//
// W604 anti-brittleness: family lock uses regex + numeric threshold (never
// an explicit hard-coded sibling list).
//
// Items pinned:
//   1) distill-runs root exists OR test skips with explicit reason
//   2) spec.json present + declares teacher_council with 3 entries
//   3) passport.json present + carries run_id matching trinity-500-2026-05-26
//   4) merged/qwen-merged/README.md present + mentions all 3 council vendors
//   5) merged/gguf/ contains Q4_K_M, Q5_K_M, Q8_0, IQ4_XS variants
//   6) Modelfile (Ollama recipe) present in merged/gguf/
//   7) Family lock — at least one prior wave8xx test file exists

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = __dirname;

const RUN_DIR = path.join(os.homedir(), '.kolm', 'distill-runs', 'trinity-500-2026-05-26');
const HAS_RUN = fs.existsSync(RUN_DIR);
const SKIP_REASON = `trinity-500 distill-run absent at ${RUN_DIR} - env-conditional skip`;

// ----------------------------------------------------------------------------
// 1) Run directory presence
// ----------------------------------------------------------------------------
test('W867 #1 - trinity-500-2026-05-26 distill-run directory presence', { skip: !HAS_RUN ? SKIP_REASON : false }, () => {
  assert.ok(fs.statSync(RUN_DIR).isDirectory(), `${RUN_DIR} must be a directory`);
});

// ----------------------------------------------------------------------------
// 2) spec.json declares 3-teacher council
// ----------------------------------------------------------------------------
test('W867 #2 - spec.json declares teacher_council with 3 entries', { skip: !HAS_RUN ? SKIP_REASON : false }, () => {
  const specPath = path.join(RUN_DIR, 'spec.json');
  assert.ok(fs.existsSync(specPath), `${specPath} must exist`);
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  assert.equal(typeof spec.job_id, 'string', 'spec.job_id must be a string');
  assert.equal(typeof spec.system, 'string', 'spec.system must be a string');
  assert.ok(Array.isArray(spec.teacher_council),
    'spec.teacher_council must be an array');
  assert.equal(spec.teacher_council.length, 3,
    `teacher_council must have exactly 3 entries; got ${spec.teacher_council.length}`);
  for (const t of spec.teacher_council) {
    assert.equal(typeof t.slug, 'string', 'each teacher must have a slug');
    assert.equal(typeof t.weight, 'number', 'each teacher must have a numeric weight');
  }
});

// ----------------------------------------------------------------------------
// 3) passport.json carries run_id
// ----------------------------------------------------------------------------
test('W867 #3 - passport.json carries id matching trinity-500-2026-05-26', { skip: !HAS_RUN ? SKIP_REASON : false }, () => {
  // passport.json lives one level deeper at merged/ once the run is exported.
  const candidates = [
    path.join(RUN_DIR, 'passport.json'),
    path.join(RUN_DIR, 'merged', 'passport.json'),
  ];
  const p = candidates.find((c) => fs.existsSync(c));
  assert.ok(p, `passport.json missing at any of: ${candidates.join(' OR ')}`);
  const passport = JSON.parse(fs.readFileSync(p, 'utf8'));
  // Accept any of `id`, `run_id`, `job_id` (kolm.passport/1 uses `id`).
  const idLike = passport.id || passport.run_id || passport.job_id || '';
  assert.ok(/trinity-500/.test(idLike),
    `passport id/run_id/job_id must contain "trinity-500"; got ${JSON.stringify(idLike)}`);
  // Passport must also carry the adapter sha256 (proof of artifact pinning).
  assert.ok(passport.artifact && /^[0-9a-f]{64}$/.test(passport.artifact.sha256 || ''),
    `passport.artifact.sha256 must be a 64-char hex string; got ${passport.artifact?.sha256}`);
});

// ----------------------------------------------------------------------------
// 4) HF model card mentions all 3 council vendors
// ----------------------------------------------------------------------------
test('W867 #4 - merged/qwen-merged/README.md is the HF model card and mentions all 3 council vendors', { skip: !HAS_RUN ? SKIP_REASON : false }, () => {
  const readmePath = path.join(RUN_DIR, 'merged', 'qwen-merged', 'README.md');
  assert.ok(fs.existsSync(readmePath), `${readmePath} must exist`);
  const txt = fs.readFileSync(readmePath, 'utf8');
  // HF model card frontmatter
  assert.ok(/^---\s*$/m.test(txt), 'README.md must begin with YAML frontmatter');
  assert.ok(/license:\s*apache-2\.0/i.test(txt), 'README must declare apache-2.0 license');
  // All 3 council vendors must appear
  for (const vendor of ['claude', 'gpt-4o', 'deepseek']) {
    assert.ok(new RegExp(vendor, 'i').test(txt),
      `model card must mention "${vendor}"; not found`);
  }
});

// ----------------------------------------------------------------------------
// 5) GGUF quantization variants
// ----------------------------------------------------------------------------
test('W867 #5 - merged/gguf/ contains Q4_K_M, Q5_K_M, Q8_0, IQ4_XS GGUF variants', { skip: !HAS_RUN ? SKIP_REASON : false }, () => {
  const ggufDir = path.join(RUN_DIR, 'merged', 'gguf');
  assert.ok(fs.existsSync(ggufDir), `${ggufDir} must exist`);
  const files = fs.readdirSync(ggufDir).map((f) => f.toLowerCase());
  for (const quant of ['q4_k_m', 'q5_k_m', 'q8_0', 'iq4_xs']) {
    assert.ok(files.some((f) => f.endsWith('.gguf') && f.includes(quant)),
      `gguf/ must contain ${quant.toUpperCase()} variant; saw: ${files.join(', ')}`);
  }
});

// ----------------------------------------------------------------------------
// 6) Ollama Modelfile
// ----------------------------------------------------------------------------
test('W867 #6 - Modelfile (Ollama recipe) present in merged/gguf/', { skip: !HAS_RUN ? SKIP_REASON : false }, () => {
  const modelfilePath = path.join(RUN_DIR, 'merged', 'gguf', 'Modelfile');
  assert.ok(fs.existsSync(modelfilePath), `${modelfilePath} must exist`);
  const txt = fs.readFileSync(modelfilePath, 'utf8');
  assert.ok(/^FROM\s+/m.test(txt), 'Modelfile must declare FROM directive');
});

// ----------------------------------------------------------------------------
// 7) Family lock (W604): regex + threshold, never explicit array.
// ----------------------------------------------------------------------------
test('W867 #7 - W604 family pattern: at least one prior wave8xx test file exists', () => {
  const re = /^wave(\d{3,4}).*\.test\.js$/;
  const files = fs.readdirSync(TESTS_DIR);
  const wave8xx = files.filter((f) => {
    const m = f.match(re);
    if (!m) return false;
    const n = Number(m[1]);
    return n >= 800 && n <= 999;
  });
  assert.ok(wave8xx.length >= 1,
    `expected at least 1 wave8xx test file (regex+threshold per W604); found ${wave8xx.length}`);
});
