// W817 — .kolm artifact format v1.0 conformance tests.
//
// Validates the 5 fixture manifests at tests/fixtures/format-v1/*.manifest.json
// against the schema described in docs/spec/kolm-format-v1.0.md, re-hashes
// each fixture and asserts the bytes match the recorded sha256 in
// tests/fixtures/format-v1/MANIFEST.sha256.txt, and cross-references
// manifest field names across the C / Python / Rust reference SDKs to make
// the field-name parity contract enforceable.
//
// Coverage map:
//   #1  spec doc kolm-format-v1.0.md exists and declares v1.0
//   #2  CHANGE_PROCESS.md exists and lists patch/minor/major rules
//   #3  C header sdk/c/kolm-format.h declares KOLM_FORMAT_SPEC + EMPTY_SHA
//   #4  Python module sdk/python/kolm/format.py exports Manifest, Receipt,
//       AttestationBlock, SustainabilityBadge, KScore, FormatError
//   #5  Rust module sdk/rust/src/format.rs declares pub struct Manifest +
//       AttestationBlock + KScore
//   #6  Five fixture manifests round-trip through JSON.parse without error
//   #7  Each fixture's sha256 matches the row in MANIFEST.sha256.txt
//   #8  Required-field presence on every fixture (spec, format_version,
//       artifact_class, runtime, runtime_target, hashes, cid, policy,
//       artifact_hash, ...)
//   #9  Enum validation: artifact_class / runtime_target / tier all in
//       their allowed sets
//   #10 runtime == runtime_target (W457 lock) on every fixture
//   #11 Cross-SDK field-name parity: every required manifest field name
//       appears (as a literal string) in all three SDK source files
//   #12 Conditional-slot rule (W460): small.manifest.json has NO optional
//       fields, signed.manifest.json has parent_cid + region + guardrails +
//       entry, attested.manifest.json has confidential_compute, multimodal
//       carries output_schema + extra_files + unknown forward-compat key
//   #13 kolmspec.org TODO placeholder is present in the spec doc
//   #14 Spec doc cross-links CHANGE_PROCESS.md
//   #15 sha256 manifest file format is parseable + has exactly 5 data rows

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'format-v1');
const SPEC_PATH = path.join(REPO_ROOT, 'docs', 'spec', 'kolm-format-v1.0.md');
const CHANGE_PATH = path.join(REPO_ROOT, 'docs', 'spec', 'CHANGE_PROCESS.md');
const C_HEADER = path.join(REPO_ROOT, 'sdk', 'c', 'kolm-format.h');
const PY_MODULE = path.join(REPO_ROOT, 'sdk', 'python', 'kolm', 'format.py');
const RUST_MODULE = path.join(REPO_ROOT, 'sdk', 'rust', 'src', 'format.rs');

const FIXTURES = ['small', 'medium', 'signed', 'attested', 'multimodal'];
const ARTIFACT_CLASSES = new Set(['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model']);
const RUNTIME_TARGETS = new Set(['js', 'gguf', 'onnx', 'wasm', 'native']);
const TIERS = new Set(['recipe', 'adapter', 'specialist', 'bundle']);

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function parseShaManifest(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([0-9a-f]{64})\s+(\S+)$/);
    if (m) rows.push({ sha256: m[1], filename: m[2] });
  }
  return rows;
}

test('W817 #1 — spec doc exists and declares v1.0', () => {
  const text = readFile(SPEC_PATH);
  assert.match(text, /kolm format specification, v1\.0/);
  assert.match(text, /STATUS:\s*DRAFT/);
  assert.match(text, /format_version/);
});

test('W817 #2 — CHANGE_PROCESS doc exists with patch/minor/major', () => {
  const text = readFile(CHANGE_PATH);
  assert.match(text, /Versioning policy/i);
  assert.match(text, /Patch/);
  assert.match(text, /Minor/);
  assert.match(text, /Major/);
  assert.match(text, /(two|2)\s+(or\s+more\s+)?(format\s+)?maintainers/i);
});

test('W817 #3 — C header declares KOLM_FORMAT_SPEC + EMPTY_SHA', () => {
  const text = readFile(C_HEADER);
  assert.match(text, /KOLM_FORMAT_SPEC/);
  assert.match(text, /"kolm-1"/);
  assert.match(text, /KOLM_EMPTY_SHA/);
  assert.match(text, /"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"/);
  assert.match(text, /kolm_manifest_t/);
  assert.match(text, /kolm_receipt_t/);
  assert.match(text, /kolm_attestation_block_t/);
});

test('W817 #4 — Python module exports Manifest/Receipt/AttestationBlock/SustainabilityBadge', () => {
  const text = readFile(PY_MODULE);
  assert.match(text, /class Manifest:/);
  assert.match(text, /class Receipt:/);
  assert.match(text, /class AttestationBlock:/);
  assert.match(text, /class SustainabilityBadge:/);
  assert.match(text, /class KScore:/);
  assert.match(text, /class FormatError\(Exception\):/);
  assert.match(text, /KOLM_FORMAT_SPEC = "kolm-1"/);
  assert.match(text, /EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"/);
});

test('W817 #5 — Rust module declares pub struct Manifest + AttestationBlock + KScore', () => {
  const text = readFile(RUST_MODULE);
  assert.match(text, /pub struct Manifest/);
  assert.match(text, /pub struct Receipt/);
  assert.match(text, /pub struct AttestationBlock/);
  assert.match(text, /pub struct SustainabilityBadge/);
  assert.match(text, /pub struct KScore/);
  assert.match(text, /pub const KOLM_FORMAT_SPEC: &str = "kolm-1"/);
  assert.match(text, /pub const EMPTY_SHA: &str =/);
});

test('W817 #6 — five fixture manifests round-trip through JSON.parse', () => {
  for (const name of FIXTURES) {
    const p = path.join(FIXTURE_DIR, `${name}.manifest.json`);
    const text = readFile(p);
    const obj = JSON.parse(text);
    assert.equal(typeof obj, 'object');
    assert.equal(obj.spec, 'kolm-1', `${name}: spec must be kolm-1`);
    assert.equal(obj.format_version, '1.0', `${name}: format_version must be 1.0`);
  }
});

test('W817 #7 — each fixture sha256 matches MANIFEST.sha256.txt', () => {
  const manifestText = readFile(path.join(FIXTURE_DIR, 'MANIFEST.sha256.txt'));
  const rows = parseShaManifest(manifestText);
  assert.equal(rows.length, FIXTURES.length, 'manifest must list exactly 5 data rows');
  const byName = new Map(rows.map((r) => [r.filename, r.sha256]));
  for (const name of FIXTURES) {
    const filename = `${name}.manifest.json`;
    const recorded = byName.get(filename);
    assert.ok(recorded, `MANIFEST.sha256.txt missing row for ${filename}`);
    const bytes = fs.readFileSync(path.join(FIXTURE_DIR, filename));
    const actual = sha256Hex(bytes);
    assert.equal(actual, recorded, `sha256 drift on ${filename}`);
  }
});

test('W817 #8 — required fields present on every fixture', () => {
  const required = [
    'spec', 'format_version', 'job_id', 'task', 'created_at',
    'runtime', 'runtime_target', 'artifact_class', 'base_model',
    'tier', 'judge_id', 'eval_score', 'recipes', 'evals',
    'seed_provenance', 'hashes', 'cid', 'policy', 'binaries',
    'production_ready', 'memory_requirement_mb', 'offline_capable',
    'license', 'artifact_hash',
  ];
  for (const name of FIXTURES) {
    const obj = JSON.parse(readFile(path.join(FIXTURE_DIR, `${name}.manifest.json`)));
    for (const field of required) {
      assert.ok(field in obj, `${name}: missing required field ${field}`);
    }
    // hashes required slots
    for (const slot of ['model_pointer', 'recipes_json', 'lora_bin', 'index_bin', 'evals_json']) {
      assert.ok(slot in obj.hashes, `${name}: hashes.${slot} missing`);
      assert.match(obj.hashes[slot], /^[a-f0-9]{64}$/, `${name}: hashes.${slot} not a sha256 hex`);
    }
    // policy
    assert.equal(typeof obj.policy.require_ed25519, 'boolean');
    assert.equal(typeof obj.policy.require_rekor, 'boolean');
  }
});

test('W817 #9 — enum validation on artifact_class / runtime_target / tier', () => {
  for (const name of FIXTURES) {
    const obj = JSON.parse(readFile(path.join(FIXTURE_DIR, `${name}.manifest.json`)));
    assert.ok(ARTIFACT_CLASSES.has(obj.artifact_class),
      `${name}: artifact_class ${obj.artifact_class} not in enum`);
    assert.ok(RUNTIME_TARGETS.has(obj.runtime_target),
      `${name}: runtime_target ${obj.runtime_target} not in enum`);
    assert.ok(TIERS.has(obj.tier), `${name}: tier ${obj.tier} not in enum`);
    assert.ok(obj.eval_score >= 0 && obj.eval_score <= 1,
      `${name}: eval_score out of range`);
  }
});

test('W817 #10 — runtime == runtime_target on every fixture (W457 lock)', () => {
  for (const name of FIXTURES) {
    const obj = JSON.parse(readFile(path.join(FIXTURE_DIR, `${name}.manifest.json`)));
    assert.equal(obj.runtime, obj.runtime_target,
      `${name}: runtime must equal runtime_target`);
  }
});

test('W817 #11 — cross-SDK field-name parity (literal string presence)', () => {
  // Fields that MUST appear verbatim in all three SDK sources. Pulled
  // from the required + most-load-bearing optional set so any future
  // schema drift in any one SDK breaks this test.
  const fields = [
    'spec',
    'format_version',
    'job_id',
    'task',
    'created_at',
    'runtime',
    'runtime_target',
    'artifact_class',
    'base_model',
    'tier',
    'judge_id',
    'eval_score',
    'recipes',
    'evals',
    'seed_provenance',
    'hashes',
    'cid',
    'policy',
    'binaries',
    'production_ready',
    'memory_requirement_mb',
    'offline_capable',
    'license',
    'artifact_hash',
    'model_pointer',
    'recipes_json',
    'lora_bin',
    'index_bin',
    'evals_json',
    'require_ed25519',
    'require_rekor',
    'confidential_compute',
    'attestation_kind',
    'attestation_report_hash',
    'parent_cid',
    'region',
    'output_schema',
    'guardrails',
    'sparsity_profile',
    'kv_profile',
    'mixed_precision_profile',
    'k_score',
    'ci95',
    'signature_alg',
    'signature_ed25519',
    'signature_sigstore',
    'event_source_hashes',
    'dataset_hash',
    'train_hash',
    'holdout_hash',
    'split_seed',
    'artifact_files',
    'build_toolchain',
    'sustainability_badge',
  ];
  const cText = readFile(C_HEADER);
  const pyText = readFile(PY_MODULE);
  const rsText = readFile(RUST_MODULE);
  const missing = { c: [], python: [], rust: [] };
  for (const field of fields) {
    if (!cText.includes(field)) missing.c.push(field);
    if (!pyText.includes(field)) missing.python.push(field);
    if (!rsText.includes(field)) missing.rust.push(field);
  }
  assert.deepEqual(missing.c, [], `C header missing fields: ${missing.c.join(', ')}`);
  assert.deepEqual(missing.python, [], `Python module missing fields: ${missing.python.join(', ')}`);
  assert.deepEqual(missing.rust, [], `Rust module missing fields: ${missing.rust.join(', ')}`);
});

test('W817 #12 — conditional-slot rule honored across fixtures', () => {
  const small = JSON.parse(readFile(path.join(FIXTURE_DIR, 'small.manifest.json')));
  // small has NO optional blocks
  for (const k of ['confidential_compute', 'parent_cid', 'region', 'guardrails',
    'output_schema', 'sparsity_profile', 'kv_profile', 'mixed_precision_profile',
    'sustainability_badge', 'k_score', 'entry']) {
    assert.ok(!(k in small), `small: optional ${k} must be absent under W460 rule`);
  }
  const signed = JSON.parse(readFile(path.join(FIXTURE_DIR, 'signed.manifest.json')));
  assert.ok('parent_cid' in signed && typeof signed.parent_cid === 'string');
  assert.ok('region' in signed);
  assert.ok('guardrails' in signed && Array.isArray(signed.guardrails) && signed.guardrails.length > 0);
  assert.ok('entry' in signed);

  const attested = JSON.parse(readFile(path.join(FIXTURE_DIR, 'attested.manifest.json')));
  assert.ok('confidential_compute' in attested);
  assert.equal(attested.confidential_compute.attestation_kind, 'snp-report');
  assert.match(attested.confidential_compute.attestation_report_hash, /^[a-f0-9]{64}$/);

  const multimodal = JSON.parse(readFile(path.join(FIXTURE_DIR, 'multimodal.manifest.json')));
  assert.ok('output_schema' in multimodal);
  assert.ok('extra_files' in multimodal.hashes);
  // Forward-compat: unknown top-level field MUST be preserved by readers.
  assert.ok('x_w817_forward_compat_probe' in multimodal,
    'multimodal fixture must carry the unknown-field probe');
});

test('W817 #13 — kolmspec.org TODO placeholder present in spec doc', () => {
  const text = readFile(SPEC_PATH);
  assert.match(text, /kolmspec\.org/);
  assert.match(text, /TODO\(W817-2\)/);
});

test('W817 #14 — spec doc cross-links CHANGE_PROCESS.md and SDK files', () => {
  const text = readFile(SPEC_PATH);
  assert.match(text, /CHANGE_PROCESS\.md/);
  assert.match(text, /sdk\/c\/kolm-format\.h/);
  assert.match(text, /sdk\/python\/kolm\/format\.py/);
  assert.match(text, /sdk\/rust\/src\/format\.rs/);
});

test('W817 #15 — MANIFEST.sha256.txt has exactly 5 valid rows', () => {
  const rows = parseShaManifest(readFile(path.join(FIXTURE_DIR, 'MANIFEST.sha256.txt')));
  assert.equal(rows.length, 5);
  const filenames = new Set(rows.map((r) => r.filename));
  for (const name of FIXTURES) {
    assert.ok(filenames.has(`${name}.manifest.json`),
      `MANIFEST.sha256.txt missing fixture ${name}.manifest.json`);
  }
  for (const r of rows) {
    assert.match(r.sha256, /^[a-f0-9]{64}$/);
  }
});
