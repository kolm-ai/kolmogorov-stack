#!/usr/bin/env node
// scripts/_build-dotkolm-fixtures.cjs
//
// One-shot generator for the three .kolm v1.0 test vectors at
// tests/fixtures/dotkolm/. Re-run when the spec changes; the validator
// expects byte-stable fixtures so callers can pin sha256s without rebuilding.
//
// Three vectors:
//   valid-minimal.kolm           passport + README + dummy weights, signed
//   valid-full.kolm              + tokenizer + eval + receipt + evidence_dag
//   invalid-missing-passport.kolm  README + weights, NO passport.json (fail)
//
// Uses Node's `archiver` to produce deterministic ZIP byte layout (entries
// sorted alphabetically; mtime fixed; uncompressed for stability).
//
// Output paths are written under tests/fixtures/dotkolm/. Existing files
// are overwritten.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const archiver = require('archiver');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'dotkolm');

const EMPTY_SHA = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
const FIXED_DATE = new Date('2026-05-26T00:00:00.000Z');

function canonicalJson(v) {
  if (v === null) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  throw new Error('unsupported value');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildPassport({ artifactId, hashes, extraTopLevel = {}, signed = true }) {
  // Build the deterministic cid first from artifact_id + hashes.
  const cidInputHashes = {
    passport_json: EMPTY_SHA,
    weights: hashes.weights,
    ...(hashes.tokenizer ? { tokenizer: hashes.tokenizer } : {}),
    ...(hashes.eval_set ? { eval_set: hashes.eval_set } : {}),
    ...(hashes.receipts ? { receipts: hashes.receipts } : {}),
    ...(hashes.evidence_dag ? { evidence_dag: hashes.evidence_dag } : {}),
  };
  const cid = sha256(canonicalJson({ artifact_id: artifactId, hashes: cidInputHashes }));

  // Build the passport body with cid pinned BEFORE we compute the
  // passport_json self-hash. artifact_hash starts equal to passport_json
  // self-hash; we'll set it after we know the self-hash.
  const base = {
    spec: 'kolm-format-1.0',
    format_version: '1.0',
    artifact_id: artifactId,
    artifact_hash: 'PLACEHOLDER',
    cid,
    created_at: FIXED_DATE.toISOString(),
    task: 'demo.test-vector',
    artifact_class: 'rule',
    runtime_target: 'js',
    base_model: 'kolm/test-vector-1',
    license: 'Apache-2.0',
    seed_provenance: {
      eval_source: 'self_generated',
      comparator: 'exact',
      production_ready: false,
      holdout_ratio: 0.0,
    },
    hashes: cidInputHashes,
    ...extraTopLevel,
  };

  // To make passport_json a fixed point of the hash, we set artifact_hash
  // equal to the passport_json self-hash. The validator strips both
  // passport_json and signature before recomputing, but artifact_hash stays
  // in the body. We solve this by computing the self-hash with both
  // artifact_hash and passport_json at EMPTY_SHA, then patching both to the
  // result. The validator does the matching strip.
  const baseForSelfHash = JSON.parse(JSON.stringify(base));
  baseForSelfHash.artifact_hash = EMPTY_SHA;
  baseForSelfHash.hashes.passport_json = EMPTY_SHA;
  const passportSelfHash = sha256(canonicalJson(baseForSelfHash));

  base.artifact_hash = passportSelfHash;
  base.hashes.passport_json = passportSelfHash;

  // Compute the signature canonical sha256 (over passport-minus-signature).
  // We use an "unsigned-test-vector" placeholder so the validator does not
  // need a real key. The placeholder is documented in dotkolm-validate.cjs.
  const bodyForSig = JSON.parse(JSON.stringify(base));
  const canonicalForSig = canonicalJson(bodyForSig);
  const canonicalSha = sha256(canonicalForSig);

  if (signed) {
    base.signature = {
      algorithm: 'ed25519',
      public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // 32 bytes
      signature: 'unsigned-test-vector',
      key_fingerprint: '0'.repeat(64),
      signed_at: FIXED_DATE.toISOString(),
      payload_canonical_sha256: canonicalSha,
    };
  }

  return base;
}

// Build a deterministic ZIP by sorting entries and fixing modification time.
function buildZip(targetPath, entries) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(targetPath);
    const arch = archiver('zip', { zlib: { level: 0 } }); // store-only for byte stability
    out.on('close', resolve);
    out.on('error', reject);
    arch.on('error', reject);
    arch.pipe(out);
    // Sort by path so the central directory is deterministic.
    const sorted = entries.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const e of sorted) {
      arch.append(e.bytes, { name: e.path, date: FIXED_DATE });
    }
    arch.finalize();
  });
}

async function buildMinimal() {
  const weights = Buffer.from('# dummy weights for test vector\n', 'utf8');
  const readme = Buffer.from([
    '# valid-minimal.kolm',
    '',
    'Smallest valid .kolm v1.0 artifact. Dummy weights + minimal passport.',
    '',
    'See: docs/spec/dot-kolm-v1.0.md',
  ].join('\n'), 'utf8');

  const passport = buildPassport({
    artifactId: 'valid-minimal',
    hashes: { weights: sha256(weights) },
    extraTopLevel: { weights_filename: 'weights/model.bin' },
  });
  const passportBytes = Buffer.from(canonicalJson(passport), 'utf8');

  await buildZip(path.join(FIXTURE_DIR, 'valid-minimal.kolm'), [
    { path: 'passport.json', bytes: passportBytes },
    { path: 'README.md', bytes: readme },
    { path: 'weights/model.bin', bytes: weights },
  ]);
}

async function buildFull() {
  const weights = Buffer.from('# dummy weights for full test vector\n', 'utf8');
  const tokenizer = Buffer.from('{"vocab":{"<eos>":0,"a":1,"b":2}}\n', 'utf8');
  const evalSet = Buffer.from([
    '{"id":"e1","prompt":"hello","expected":"world"}',
    '{"id":"e2","prompt":"ping","expected":"pong"}',
  ].join('\n') + '\n', 'utf8');
  const receipt = Buffer.from(JSON.stringify({
    kolm_version: '0.1',
    receipt_id: '00000000-0000-0000-0000-000000000002',
    eval_score: 1.0,
    judge_id: 'exact-match',
    tier: 'recipe',
    chain: [],
    anchors: [],
    signature_alg: 'ed25519',
    signed_at: FIXED_DATE.toISOString(),
    signed_by: 'kolm-dev-hmac-1',
  }, null, 2), 'utf8');
  const evidenceDag = Buffer.from(JSON.stringify({
    spec: 'kolm-evidence-dag-1',
    nodes: [
      { id: 'capture_001', kind: 'capture', sha256: sha256(Buffer.from('cap-1')) },
      { id: 'eval_001',    kind: 'eval',    sha256: sha256(Buffer.from('eval-1')) },
    ],
    edges: [
      { from: 'capture_001', to: 'eval_001', kind: 'derived_from' },
    ],
  }, null, 2), 'utf8');
  const readme = Buffer.from([
    '# valid-full.kolm',
    '',
    'Full-featured .kolm v1.0 artifact: weights + tokenizer + eval + receipt +',
    'evidence_dag. Synthetic data; the file sizes are intentionally tiny so the',
    'test suite can run offline.',
    '',
    'See: docs/spec/dot-kolm-v1.0.md',
  ].join('\n'), 'utf8');

  const passport = buildPassport({
    artifactId: 'valid-full',
    hashes: {
      weights: sha256(weights),
      tokenizer: sha256(tokenizer),
      eval_set: sha256(evalSet),
      receipts: sha256(receipt),
      evidence_dag: sha256(evidenceDag),
    },
    extraTopLevel: {
      weights_filename: 'weights/model.bin',
      tokenizer_filename: 'tokenizer/tokenizer.json',
      eval_score: 1.0,
      judge_id: 'exact-match',
      tier: 'recipe',
      policy: { require_ed25519: true, require_rekor: false },
    },
  });
  const passportBytes = Buffer.from(canonicalJson(passport), 'utf8');

  await buildZip(path.join(FIXTURE_DIR, 'valid-full.kolm'), [
    { path: 'passport.json', bytes: passportBytes },
    { path: 'README.md', bytes: readme },
    { path: 'weights/model.bin', bytes: weights },
    { path: 'tokenizer/tokenizer.json', bytes: tokenizer },
    { path: 'eval/eval_set.jsonl', bytes: evalSet },
    { path: 'receipts/receipt.json', bytes: receipt },
    { path: 'evidence_dag.json', bytes: evidenceDag },
  ]);
}

async function buildInvalidMissingPassport() {
  // README + weights, but NO passport.json. Validator MUST reject with a
  // clear "missing_required_entry: passport.json" error.
  const weights = Buffer.from('# weights without a passport — invalid bundle\n', 'utf8');
  const readme = Buffer.from([
    '# invalid-missing-passport.kolm',
    '',
    'This bundle is intentionally invalid — passport.json is absent. The',
    'validator MUST reject it with a clear error naming the missing entry.',
  ].join('\n'), 'utf8');
  await buildZip(path.join(FIXTURE_DIR, 'invalid-missing-passport.kolm'), [
    { path: 'README.md', bytes: readme },
    { path: 'weights/model.bin', bytes: weights },
  ]);
}

async function main() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  await buildMinimal();
  await buildFull();
  await buildInvalidMissingPassport();
  process.stdout.write('test vectors written to ' + FIXTURE_DIR + '\n');
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
