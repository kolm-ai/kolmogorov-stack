// Tests for content-identifier (CID) generation.
//
// The CID is the deterministic, content-addressed identity of a .kolm
// artifact. Two compiles that produce the same byte content must produce
// the same CID; any byte difference must change the CID. The CID must be
// independent of signing key rotation (signature changes; content does not).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cidFromManifestHashes,
  verifyCidAgainstManifestHashes,
  parseCid,
  isValidCidFormat,
  shortCid,
  CID_SPEC,
} from '../src/cid.js';

const VALID_HASHES = {
  model_pointer: 'a'.repeat(64),
  recipes_json:  'b'.repeat(64),
  lora_bin:      'c'.repeat(64),
  index_bin:     'd'.repeat(64),
  evals_json:    'e'.repeat(64),
};

test('cidFromManifestHashes produces a well-formed cidv1:sha256 string', () => {
  const cid = cidFromManifestHashes(VALID_HASHES);
  assert.ok(typeof cid === 'string');
  assert.match(cid, /^cidv1:sha256:[0-9a-f]{64}$/);
});

test('cidFromManifestHashes is deterministic — same inputs, same CID', () => {
  const a = cidFromManifestHashes(VALID_HASHES);
  const b = cidFromManifestHashes({ ...VALID_HASHES });
  assert.equal(a, b);
});

test('cidFromManifestHashes ignores key order (canonical JSON)', () => {
  const reordered = {
    evals_json:    VALID_HASHES.evals_json,
    lora_bin:      VALID_HASHES.lora_bin,
    recipes_json:  VALID_HASHES.recipes_json,
    index_bin:     VALID_HASHES.index_bin,
    model_pointer: VALID_HASHES.model_pointer,
  };
  assert.equal(cidFromManifestHashes(reordered), cidFromManifestHashes(VALID_HASHES));
});

test('cidFromManifestHashes changes when any input hash changes', () => {
  const base = cidFromManifestHashes(VALID_HASHES);
  for (const k of Object.keys(VALID_HASHES)) {
    const mutated = { ...VALID_HASHES, [k]: 'f'.repeat(64) };
    assert.notEqual(cidFromManifestHashes(mutated), base, `mutating ${k} did not change CID`);
  }
});

test('cidFromManifestHashes rejects malformed input', () => {
  assert.throws(() => cidFromManifestHashes(null));
  assert.throws(() => cidFromManifestHashes({}));
  assert.throws(() => cidFromManifestHashes({ ...VALID_HASHES, evals_json: 'too-short' }));
  assert.throws(() => cidFromManifestHashes({ ...VALID_HASHES, evals_json: 'Z'.repeat(64) }));
});

test('verifyCidAgainstManifestHashes succeeds on match, fails on mismatch', () => {
  const cid = cidFromManifestHashes(VALID_HASHES);
  assert.equal(verifyCidAgainstManifestHashes(cid, VALID_HASHES), true);
  assert.equal(verifyCidAgainstManifestHashes(cid, { ...VALID_HASHES, evals_json: 'f'.repeat(64) }), false);
  assert.equal(verifyCidAgainstManifestHashes('cidv1:sha256:' + '0'.repeat(64), VALID_HASHES), false);
  assert.equal(verifyCidAgainstManifestHashes('not-a-cid', VALID_HASHES), false);
});

test('parseCid roundtrips a valid CID', () => {
  const cid = cidFromManifestHashes(VALID_HASHES);
  const parsed = parseCid(cid);
  assert.equal(parsed.version, 'cidv1');
  assert.equal(parsed.digest, 'sha256');
  assert.match(parsed.hex, /^[0-9a-f]{64}$/);
});

test('parseCid returns null for malformed input', () => {
  assert.equal(parseCid(null), null);
  assert.equal(parseCid(''), null);
  assert.equal(parseCid('cidv1:sha256:'), null);
  assert.equal(parseCid('cidv1:sha256:XYZ'), null);
});

test('isValidCidFormat validates strictly', () => {
  assert.equal(isValidCidFormat(cidFromManifestHashes(VALID_HASHES)), true);
  assert.equal(isValidCidFormat('cidv1:sha256:' + 'a'.repeat(64)), true);
  assert.equal(isValidCidFormat('cidv1:sha256:' + 'a'.repeat(63)), false);
  assert.equal(isValidCidFormat('cidv2:sha256:' + 'a'.repeat(64)), false);
  assert.equal(isValidCidFormat('cidv1:blake3:' + 'a'.repeat(64)), false);
});

test('shortCid abbreviates the hex digest for display', () => {
  const cid = cidFromManifestHashes(VALID_HASHES);
  const short = shortCid(cid);
  assert.match(short, /^cidv1:sha256:[0-9a-f]{6}…[0-9a-f]{6}$/);
  assert.notEqual(short, cid);
});

test('CID_SPEC exposes the expected schema constants', () => {
  assert.equal(CID_SPEC.version, 'cidv1');
  assert.equal(CID_SPEC.digest, 'sha256');
  assert.deepEqual(
    [...CID_SPEC.parts].sort(),
    ['evals_json', 'index_bin', 'lora_bin', 'model_pointer', 'recipes_json'],
  );
});

test('CID is stable across two independent builds of the same content', async () => {
  // Build two artifacts with identical inputs (recipes, evals, base model)
  // and confirm CIDs match. The second build's signature is fresh — proves
  // CID is independent of the receipt sealing.
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-v1';
  const { buildPayload } = await import('../src/artifact.js');
  const args = {
    job_id: 'job_test_cid_stability',
    task: 'classify support tickets',
    base_model: 'qwen2.5-coder-7b-instruct-q4_0',
    recipes: [
      { id: 'r1', name: 'urgent-detector', source: 'return {label: "urgent"};', source_hash: 'h1', version_id: 'v1', tags: [], schema: null },
    ],
    training_stats: { distilled_pairs: 0, pass_rate_positive: 1.0, latency_p50_us: 50 },
    evals: { spec: 'rs-1-evals', n: 1, cases: [{ id: 'c1', input: 'ticket', expected: 'urgent' }], coverage: 1.0 },
    judge_id: 'kolm-pattern-synth-1',
    eval_score: 1.0,
    tier: 'recipe',
  };
  const a = buildPayload(args);
  const b = buildPayload({ ...args, job_id: 'job_other_id' });  // job_id differs but content identical
  // The CID is content-only; job_id and timestamps are in the manifest but
  // NOT in the hashes block, so the CID should match across job_ids.
  // BUT — manifest.created_at IS in the manifest, and the manifest contributes
  // to the artifact_hash. So while job_id alone doesn't change the CID,
  // created_at *will* if called milliseconds apart. The right invariant is
  // that the CID is computed from the per-file content hashes, which are
  // independent of manifest contents. Confirm directly:
  assert.equal(a.manifest.cid, b.manifest.cid, 'CID should be content-only, not job-id sensitive');
  // Sanity: artifact_hash includes manifest_hash so it MAY differ; CID does not.
  // (No assertion either way on artifact_hash.)
});

test('CID is embedded in the receipt body', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-v1';
  const { buildPayload } = await import('../src/artifact.js');
  const built = buildPayload({
    job_id: 'job_test_receipt_cid',
    task: 'classify',
    recipes: [{ id: 'r1', name: 'x', source: 'return {ok:true};', source_hash: 'h', version_id: 'v', tags: [], schema: null }],
    evals: { spec: 'rs-1-evals', n: 0, cases: [], coverage: 0 },
  });
  assert.ok(built.receipt.cid, 'receipt should carry CID');
  assert.equal(built.receipt.cid, built.manifest.cid, 'receipt CID matches manifest CID');
  assert.equal(built.cid, built.manifest.cid, 'top-level CID matches manifest CID');
});
