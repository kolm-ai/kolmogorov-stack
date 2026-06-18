import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  AMBER_LICENSES,
  DENY_LICENSES,
  LICENSING_ALLOWLIST_VERSION,
  LICENSING_LIMITS,
  SAFE_LICENSES,
  checkCorpusLicensing,
  classifyLicense,
  classifyLicenseDetailed,
  normalizeLicenseId,
  validSourceUrl,
} from '../src/licensing-allowlist.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

test('W687 licensing allowlist pins bounded evidence controls and depth wiring', () => {
  const source = read('src/licensing-allowlist.js');
  const pkg = readJson('package.json');

  assert.equal(LICENSING_ALLOWLIST_VERSION, 'w194-v2');
  assert.match(LICENSING_ALLOWLIST_VERSION, /^w194-/);
  assert.equal(LICENSING_LIMITS.MAX_SOURCES, 256);
  assert.match(source, /import crypto from 'node:crypto'/);
  assert.match(source, /normalizeLicenseId/);
  assert.match(source, /classifyLicenseDetailed/);
  assert.match(source, /license_gate_sha256/);
  assert.match(source, /source_evidence_sha256/);
  assert.match(source, /source_url_sha256/);
  assert.match(source, /file: URLs are not accepted/);
  assert.match(source, /source_url must not contain credentials/);
  assert.match(source, /source_url host is private or loopback/);

  assert.equal(pkg.scripts['verify:licensing-allowlist'], 'node --test --test-concurrency=1 tests/wave687-licensing-allowlist-contract.test.js');
  assert.match(pkg.scripts['verify:depth'], /verify:package-release && npm run verify:licensing-allowlist && npm run verify:savings-routes && npm run verify:scim-provisioning && npm run verify:trend-extract && npm run verify:verticals && npm run verify:video-bakeoff && npm run verify:video-capture && npm run verify:vision-capture && npm run verify:vlm-bakeoff && npm run verify:website-status && npm run verify:zip-large && npm run verify:python-onnx-text && npm run verify:fal-backend && npm run verify:vast-backend && npm run verify:browser-extension-popup && npm run verify:langchain-package-manifest && npm run verify:llamaindex-package-manifest && npm run verify:runtime-rs-build-scripts && npm run verify:runtime-rs-wasm-example && npm run verify:distribution-manifests && npm run verify:eval-safety-harnesses && npm run verify:worker-safety-contracts && npm run verify:compute-backends && node scripts\/audit-sota-readiness\.cjs/);
});

test('W687 license lists remain disjoint and normalize common SPDX aliases', () => {
  const seen = new Set();
  for (const list of [SAFE_LICENSES, AMBER_LICENSES, DENY_LICENSES]) {
    for (const lic of list) {
      assert.equal(seen.has(lic), false, `duplicate license ${lic}`);
      seen.add(lic);
    }
  }

  assert.deepEqual(normalizeLicenseId(' apache-2.0 ').normalized, 'Apache-2.0');
  assert.deepEqual(normalizeLicenseId('Apache2').normalized, 'Apache-2.0');
  assert.equal(classifyLicense('apache-2.0'), 'safe');
  assert.equal(classifyLicense('CC-BY-NC-4.0'), 'amber');
  assert.equal(classifyLicense('all rights reserved'), 'deny');
  assert.equal(classifyLicense('Apache-2.0\nbad'), 'unknown');

  const detail = classifyLicenseDetailed('mit');
  assert.equal(detail.bucket, 'safe');
  assert.equal(detail.normalized_license, 'MIT');
  assert.match(detail.license_sha256, /^[a-f0-9]{64}$/);
});

test('W687 source URL validation rejects secrets and local network ambiguity', () => {
  const publicUrl = validSourceUrl('https://example.com/datasets/corpus.jsonl');
  assert.equal(publicUrl.ok, true);
  assert.equal(publicUrl.kind, 'url');
  assert.match(publicUrl.source_url_sha256, /^[a-f0-9]{64}$/);
  assert.match(publicUrl.host_sha256, /^[a-f0-9]{64}$/);

  const hf = validSourceUrl('huggingface:org-name/dataset_name');
  assert.equal(hf.ok, true);
  assert.equal(hf.kind, 'identifier');
  assert.equal(hf.prefix, 'huggingface:');

  const s3 = validSourceUrl('s3:bucket/key.jsonl');
  assert.equal(s3.ok, true);
  assert.match(s3.identifier_sha256, /^[a-f0-9]{64}$/);

  const credentialed = validSourceUrl('https://user:secret@example.com/data');
  assert.equal(credentialed.ok, false);
  assert.match(credentialed.reason, /must not contain credentials/);
  assert.doesNotMatch(credentialed.reason, /secret/);

  const loopback = validSourceUrl('http://127.0.0.1:8000/data');
  assert.equal(loopback.ok, false);
  assert.match(loopback.reason, /private or loopback/);

  const fileUrl = validSourceUrl('file:///C:/secret/corpus.jsonl');
  assert.equal(fileUrl.ok, false);
  assert.match(fileUrl.reason, /file: URLs are not accepted/);

  const traversal = validSourceUrl('local:../private-corpus');
  assert.equal(traversal.ok, false);
  assert.match(traversal.reason, /must not be a filesystem path/);

  const badHf = validSourceUrl('hf:only-owner');
  assert.equal(badHf.ok, false);
  assert.match(badHf.reason, /owner\/name/);
});

test('W687 checkCorpusLicensing returns digest-backed pass, caveat, and fail envelopes', () => {
  const clean = checkCorpusLicensing({
    corpus_sources: [
      { name: 'Public Data', source_url: 'https://example.com/corpus', license: 'apache-2.0' },
      { name: 'Research Data', source_url: 'huggingface:org/dataset', license: 'CC-BY-NC-4.0' },
    ],
  });
  assert.equal(clean.status, 'pass');
  assert.equal(clean.sources_count, 2);
  assert.equal(clean.sources_evaluated, 2);
  assert.equal(clean.class_counts.safe, 1);
  assert.equal(clean.class_counts.amber, 1);
  assert.equal(clean.caveats.length, 1);
  assert.match(clean.license_gate_sha256, /^[a-f0-9]{64}$/);
  assert.match(clean.source_evidence_sha256, /^[a-f0-9]{64}$/);
  assert.equal(clean.source_evidence[0].normalized_license, 'Apache-2.0');
  assert.equal(clean.source_evidence[0].bucket, 'safe');
  assert.match(clean.source_evidence[0].source_url_sha256, /^[a-f0-9]{64}$/);

  const failed = checkCorpusLicensing({
    corpus_sources: [
      { name: 'Bad URL', source_url: 'https://user:secret@example.com/corpus', license: 'MIT' },
      { name: 'Bad License', source_url: 'https://example.com/closed', license: 'unknown' },
    ],
  });
  assert.equal(failed.status, 'fail');
  assert.equal(failed.sources_count, 2);
  assert.ok(failed.bad.some((b) => /must not contain credentials/.test(b)));
  assert.ok(failed.bad.some((b) => /license='unknown'/.test(b)));
  assert.doesNotMatch(failed.detail, /secret/);
  assert.match(failed.license_gate_sha256, /^[a-f0-9]{64}$/);

  const legacy = checkCorpusLicensing({});
  assert.equal(legacy.status, 'pass');
  assert.equal(legacy.sources_count, 0);
  assert.match(legacy.license_gate_sha256, /^[a-f0-9]{64}$/);
});

test('W687 checkCorpusLicensing caps oversized source lists deterministically', () => {
  const sources = Array.from({ length: LICENSING_LIMITS.MAX_SOURCES + 1 }, (_, i) => ({
    name: `source-${i}`,
    source_url: `internal:dataset-${i}`,
    license: 'MIT',
  }));
  const result = checkCorpusLicensing({ corpus_sources: sources });
  assert.equal(result.status, 'fail');
  assert.equal(result.sources_count, LICENSING_LIMITS.MAX_SOURCES + 1);
  assert.equal(result.sources_evaluated, LICENSING_LIMITS.MAX_SOURCES);
  assert.equal(result.source_evidence.length, LICENSING_LIMITS.MAX_SOURCES);
  assert.ok(result.bad.some((b) => /too_many_sources/.test(b)));
  assert.match(result.source_evidence_sha256, /^[a-f0-9]{64}$/);
});
