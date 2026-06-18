// W740 - direct contract test for src/vlm-bakeoff.js.
//
// This pins the W771 vision-language bakeoff atom: tenant/namespace fencing,
// bounded store scans and replay caps, artifact path redaction, per-image-kind
// aggregation, deterministic receipts, and non-leaky route/store failures.

import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VLM_BAKEOFF_CONTRACT_VERSION,
  VLM_BAKEOFF_LIMITS,
  VLM_BAKEOFF_VERSION,
  VLM_IMAGE_KINDS,
  runVlmBakeoff,
} from '../src/vlm-bakeoff.js';

const NOW_MS = Date.parse('2026-06-18T00:00:00.000Z');
const HEX64_RE = /^[a-f0-9]{64}$/;

function read(rel) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function storeWith(rows, calls = []) {
  return {
    all(table) {
      calls.push(table);
      return rows;
    },
  };
}

test('W740 VLM bakeoff is wired into direct depth verification', () => {
  const pkg = readJson('package.json');
  const source = read('src/vlm-bakeoff.js');
  const routerSource = read('src/router.js');

  assert.equal(VLM_BAKEOFF_VERSION, 'w771-v1');
  assert.equal(VLM_BAKEOFF_CONTRACT_VERSION, 'w740-vlm-bakeoff-v1');
  assert.equal(VLM_BAKEOFF_LIMITS.hard_max_n, 500);
  assert.ok(VLM_BAKEOFF_LIMITS.max_store_scan_rows <= 1000);
  assert.deepEqual(VLM_IMAGE_KINDS, ['photo', 'screenshot', 'diagram', 'chart', 'other']);
  assert.equal(Object.isFrozen(VLM_IMAGE_KINDS), true);
  assert.equal(
    pkg.scripts['verify:vlm-bakeoff'],
    'node --test --test-concurrency=1 tests/wave740-vlm-bakeoff-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:vision-capture && npm run verify:vlm-bakeoff && npm run verify:website-status && npm run verify:zip-large && npm run verify:python-onnx-text && npm run verify:fal-backend && npm run verify:vast-backend && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.match(source, /VLM_BAKEOFF_LIMITS/);
  assert.match(source, /_errorEnvelope/);
  assert.match(source, /artifact_path_sha256/);
  assert.match(routerSource, /vision_bakeoff_error/);
  assert.match(routerSource, /w740-vlm-bakeoff-v1/);
  assert.doesNotMatch(routerSource, /vision_bakeoff_error['"][\s\S]{0,240}detail:/);
});

test('W740 tenant and namespace boundaries fail closed before store reads', async () => {
  const missing = await runVlmBakeoff();
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'tenant_id_required');
  assert.equal(missing.contract_version, VLM_BAKEOFF_CONTRACT_VERSION);

  const calls = [];
  const badNamespace = await runVlmBakeoff({
    tenant_id: 'tenant_w740',
    namespace: 'vision\ncustomer@example.com',
    opts: { storeMod: storeWith([], calls) },
  });
  const json = JSON.stringify(badNamespace);
  assert.equal(badNamespace.ok, false);
  assert.equal(badNamespace.error, 'invalid_namespace');
  assert.match(badNamespace.error_sha256, HEX64_RE);
  assert.equal(calls.length, 0);
  assert.equal(json.includes('customer@example.com'), false);
});

test('W740 no-captures envelope keeps tenant fence, cap, and all image-kind keys', async () => {
  const calls = [];
  const artifactPath = 'C:/private/vlm-model.kolm';
  const out = await runVlmBakeoff({
    tenant_id: 'tenant_a',
    namespace: 'vision',
    max_n: 999999,
    artifact_path: artifactPath,
    opts: {
      storeMod: storeWith([
        { tenant_id: 'tenant_b', corpus_namespace: 'vision', has_vision: true, response_text: 'secret' },
        { tenant_id: 'tenant_a', corpus_namespace: 'other', has_vision: true, response_text: 'not in namespace' },
      ], calls),
      now_ms: NOW_MS,
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.message, 'no_vision_captures');
  assert.equal(out.contract_version, VLM_BAKEOFF_CONTRACT_VERSION);
  assert.equal(out.tenant_id, 'tenant_a');
  assert.equal(out.namespace, 'vision');
  assert.equal(out.artifact_path, '[redacted]');
  assert.equal(out.artifact_path_sha256, sha(artifactPath));
  assert.equal(out.count_total, 0);
  assert.equal(out.max_n, VLM_BAKEOFF_LIMITS.hard_max_n);
  assert.deepEqual(Object.keys(out.by_image_kind), VLM_IMAGE_KINDS);
  for (const kind of VLM_IMAGE_KINDS) {
    assert.deepEqual(out.by_image_kind[kind], { count: 0, avg_score: null });
  }
  assert.deepEqual(calls, ['observations']);
});

test('W740 scoring aggregates per image kind and never echoes artifact paths', async () => {
  const artifactPath = 'C:/Users/example/private-vlm.kolm';
  const seenArtifactPaths = [];
  const rows = [
    {
      tenant_id: 'tenant_a',
      corpus_namespace: 'vision',
      has_vision: true,
      response_text: 'cat sitting on contract',
      image_kinds: ['photo'],
    },
    {
      tenant_id: 'tenant_a',
      corpus_namespace: 'vision',
      has_vision: true,
      response_text: 'architecture diagram contract',
      image_kinds: ['diagram'],
    },
    {
      tenant_id: 'tenant_b',
      corpus_namespace: 'vision',
      has_vision: true,
      response_text: 'cross tenant secret',
      image_kinds: ['photo'],
    },
  ];

  const out = await runVlmBakeoff({
    tenant_id: 'tenant_a',
    namespace: 'vision',
    artifact_path: artifactPath,
    max_n: 2.9,
    opts: {
      storeMod: storeWith(rows),
      runOnArtifact: async ({ artifact_path }) => {
        seenArtifactPaths.push(artifact_path);
        return { output: 'contract response' };
      },
      judge: (base, candidate) => (String(base).includes('cat') && String(candidate).includes('contract')) ? 1 : 0.5,
      judgeKind: 'fixture_jaccard_v1',
      now_ms: NOW_MS,
    },
  });
  const json = JSON.stringify(out);

  assert.equal(out.ok, true);
  assert.equal(out.contract_version, VLM_BAKEOFF_CONTRACT_VERSION);
  assert.equal(out.count_total, 2);
  assert.equal(out.count_vision_pairs_evaluated, 2);
  assert.equal(out.max_n, 2);
  assert.equal(out.avg_score, 0.75);
  assert.equal(out.by_image_kind.photo.count, 1);
  assert.equal(out.by_image_kind.photo.avg_score, 1);
  assert.equal(out.by_image_kind.diagram.count, 1);
  assert.equal(out.by_image_kind.diagram.avg_score, 0.5);
  assert.equal(out.judge_kind, 'fixture_jaccard_v1');
  assert.equal(out.artifact_error_count, 0);
  assert.equal(out.judge_error_count, 0);
  assert.equal(out.unscorable_row_count, 0);
  assert.equal(out.generated_at, '2026-06-18T00:00:00.000Z');
  assert.equal(out.artifact_path, '[redacted]');
  assert.equal(out.artifact_path_sha256, sha(artifactPath));
  assert.deepEqual(seenArtifactPaths, [artifactPath, artifactPath]);
  assert.equal(json.includes('private-vlm.kolm'), false);
  assert.equal(json.includes('cross tenant secret'), false);
});

test('W740 store, artifact, and judge failures stay bounded and non-leaky', async () => {
  const failedStore = await runVlmBakeoff({
    tenant_id: 'tenant_a',
    opts: {
      storeMod: {
        all() {
          throw new Error('db password secret customer@example.com');
        },
      },
    },
  });
  const failedStoreJson = JSON.stringify(failedStore);
  assert.equal(failedStore.ok, false);
  assert.equal(failedStore.error, 'store_read_failed');
  assert.match(failedStore.error_sha256, HEX64_RE);
  assert.equal(failedStoreJson.includes('customer@example.com'), false);
  assert.equal(failedStoreJson.includes('password'), false);

  const out = await runVlmBakeoff({
    tenant_id: 'tenant_a',
    max_n: 3,
    opts: {
      storeMod: storeWith([
        { tenant_id: 'tenant_a', has_vision: true, response_text: 'score this', image_kinds: ['photo'] },
        { tenant_id: 'tenant_a', has_vision: true, response_text: 'judge this', image_kinds: ['chart'] },
        { tenant_id: 'tenant_a', has_vision: true, response_text: '', image_kinds: ['other'] },
      ]),
      runOnArtifact: async ({ row }) => {
        if (row.image_kinds[0] === 'photo') throw new Error('artifact path secret');
        return 'candidate';
      },
      judge: (base) => {
        if (String(base).includes('judge')) return 2;
        return 0.5;
      },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.artifact_error_count, 1);
  assert.equal(out.judge_error_count, 1);
  assert.equal(out.unscorable_row_count, 1);
  assert.equal(out.count_vision_pairs_evaluated, 2);
  assert.equal(out.by_image_kind.photo.avg_score, 0.5);
  assert.equal(out.by_image_kind.chart.avg_score, 0);
});
