// W712 - direct contract tests for src/namespace-fingerprint.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FINGERPRINT_VERSION,
  FINGERPRINT_CONTRACT_VERSION,
  FINGERPRINT_LIMITS,
  TOP_TERMS_K,
  computeFingerprint,
  cosineSimilarity,
  findNearestNamespaces,
  readFingerprintFile,
  verticalGuess,
} from '../src/namespace-fingerprint.js';

const ROOT = path.resolve('.');
const HEX64 = /^[a-f0-9]{64}$/;

function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

test('W712 namespace fingerprint exposes bounded privacy contract and depth verifier', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.equal(FINGERPRINT_VERSION, 'w715-v1');
  assert.equal(FINGERPRINT_CONTRACT_VERSION, 'w712-v1');
  assert.ok(Object.isFrozen(FINGERPRINT_LIMITS));
  assert.equal(TOP_TERMS_K, 32);
  assert.equal(FINGERPRINT_LIMITS.max_captures, 5000);
  assert.equal(FINGERPRINT_LIMITS.max_nearest_k, 50);
  assert.equal(
    pkg.scripts['verify:namespace-fingerprint'],
    'node --test --test-concurrency=1 tests/wave712-namespace-fingerprint-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:pattern-lake && npm run verify:namespace-fingerprint && npm run verify:dp-aggregation/,
  );
});

test('W712 computeFingerprint redacts unsafe namespace text and raw capture content', () => {
  const fp = computeFingerprint({
    namespace: 'Acme user@example.com / private legal',
    captures: [{
      text: 'contract plaintiff defendant SECRET_API_KEY sk-live-123 john@example.com',
      raw_body: 'RAW_BODY_MUST_NOT_BE_READ',
      messages: Array.from({ length: FINGERPRINT_LIMITS.max_messages_per_capture + 5 }, (_, i) => ({
        content: i === 0 ? 'arbitration liability damages' : `message ${i}`,
      })),
    }],
  });

  assert.equal(fp.version, FINGERPRINT_VERSION);
  assert.equal(fp.contract_version, FINGERPRINT_CONTRACT_VERSION);
  assert.match(fp.namespace, /^ns_[a-f0-9]{24}$/);
  assert.match(fp.namespace_hash, HEX64);
  assert.equal(fp.n_captures, 1);
  assert.equal(fp.n_captures_seen, 1);
  assert.equal(fp.captures_truncated, false);
  assert.equal(fp.vertical_guess, 'legal');
  assert.match(fp.token_bag_hash, HEX64);
  assert.ok(fp.top_terms_hash_array.length <= TOP_TERMS_K);
  assert.ok(fp.top_terms_hash_array.every((h) => HEX64.test(h)));
  const encoded = JSON.stringify(fp);
  assert.doesNotMatch(encoded, /user@example\.com|john@example\.com|sk-live-123|SECRET_API_KEY|RAW_BODY_MUST_NOT_BE_READ|plaintiff|defendant/i);
});

test('W712 fingerprints are deterministic on stable fields and cap hostile capture volume', () => {
  const captures = Array.from({ length: FINGERPRINT_LIMITS.max_captures + 5 }, (_, i) => ({
    input: `invoice refund chargeback ledger row ${i}`,
  }));
  const a = computeFingerprint({ namespace: 'finance-safe', captures });
  const b = computeFingerprint({ namespace: 'finance-safe', captures });

  assert.equal(a.namespace, 'finance-safe');
  assert.match(a.namespace_hash, HEX64);
  assert.equal(a.n_captures_seen, FINGERPRINT_LIMITS.max_captures + 5);
  assert.equal(a.n_captures, FINGERPRINT_LIMITS.max_captures);
  assert.equal(a.captures_truncated, true);
  assert.equal(a.vertical_guess, 'finance');
  assert.equal(a.fingerprint_id, b.fingerprint_id);
  assert.equal(a.token_bag_hash, b.token_bag_hash);
  assert.deepEqual(a.top_terms_hash_array, b.top_terms_hash_array);
});

test('W712 similarity and vertical helpers reject malformed vectors and labels', () => {
  const valid = 'a'.repeat(64);
  assert.equal(cosineSimilarity({ top_terms_hash_array: [valid, 'bad', { x: 1 }] }, { top_terms_hash_array: [valid] }), 1);
  assert.equal(cosineSimilarity({ top_terms_hash_array: ['bad'] }, { top_terms_hash_array: ['also-bad'] }), 0);
  assert.equal(verticalGuess({ contract: 1, plaintiff: 1 }), 'legal');
  assert.equal(verticalGuess(Object.create(null)), 'general');
});

test('W712 nearest namespace ranking hides checkpoint paths and unsafe namespace labels by default', () => {
  const target = computeFingerprint({
    namespace: 'target',
    captures: [{ input: 'ticket login password reset refund' }],
  });
  const candidate = {
    ...computeFingerprint({
      namespace: 'recipient john@example.com',
      captures: [{ input: 'ticket login password reset refund screenshot' }],
    }),
    vertical_guess: 'unknown-vertical',
    warm_start_checkpoint_path: 'C:\\Users\\secret\\models\\private-client.ckpt',
  };

  const ranked = findNearestNamespaces(target, [candidate], { k: 999 });
  assert.equal(ranked.length, 1);
  assert.match(ranked[0].namespace, /^ns_[a-f0-9]{24}$/);
  assert.match(ranked[0].namespace_hash, HEX64);
  assert.equal(ranked[0].vertical_guess, 'general');
  assert.ok(ranked[0].similarity > 0);
  assert.equal(ranked[0].warm_start_checkpoint_path, undefined);
  assert.equal(ranked[0].warm_start_checkpoint_ref.present, true);
  assert.match(ranked[0].warm_start_checkpoint_ref.sha256, HEX64);
  assert.doesNotMatch(JSON.stringify(ranked[0]), /john@example\.com|private-client|models|secret/i);

  const sameTenant = findNearestNamespaces(target, [candidate], { k: 1, include_paths: true });
  assert.match(sameTenant[0].warm_start_checkpoint_path, /private-client\.ckpt/);
});

test('W712 readFingerprintFile fences roots, caps size, and validates fingerprint shape', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w712-fp-'));
  const fp = computeFingerprint({
    namespace: 'safe-ns',
    captures: [{ input: 'function async return export class method' }],
  });
  const goodPath = writeJson(tmp, 'fp.json', fp);

  const read = readFingerprintFile(goodPath, { allowed_root: tmp });
  assert.equal(read.fingerprint_id, fp.fingerprint_id);
  assert.equal(read.contract_version, FINGERPRINT_CONTRACT_VERSION);
  assert.equal(read.namespace, 'safe-ns');
  assert.match(read.namespace_hash, HEX64);

  const badShapePath = writeJson(tmp, 'bad-shape.json', {
    ...fp,
    top_terms_hash_array: ['not-hex'],
  });
  assert.throws(
    () => readFingerprintFile(badShapePath, { allowed_root: tmp }),
    /top_terms_hash_array/,
  );

  const largePath = path.join(tmp, 'large.json');
  fs.writeFileSync(largePath, JSON.stringify(fp) + ' '.repeat(128), 'utf8');
  assert.throws(
    () => readFingerprintFile(largePath, { allowed_root: tmp, max_bytes: 32 }),
    /too large/,
  );

  const outside = path.join(os.tmpdir(), `outside-${Date.now()}.json`);
  fs.writeFileSync(outside, JSON.stringify(fp), 'utf8');
  try {
    assert.throws(
      () => readFingerprintFile(outside, { allowed_root: tmp }),
      /outside allowed_root/,
    );
  } finally {
    fs.rmSync(outside, { force: true });
  }
});
