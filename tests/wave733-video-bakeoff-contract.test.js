// W733 - direct contract test for src/video-bakeoff.js.
//
// W773b covers tokenizer routes and workers. This pins the video bakeoff atom:
// tenant/namespace fencing, bounded caps, per-kind aggregation, redacted artifact
// path receipts, non-leaky store errors, and failure counters.

import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTENT_KINDS,
  VIDEO_BAKEOFF_CONTRACT_VERSION,
  VIDEO_BAKEOFF_LIMITS,
  VIDEO_BAKEOFF_VERSION,
  runVideoBakeoff,
} from '../src/video-bakeoff.js';

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

function storeWith(rows, captureArgs = []) {
  return {
    async listEvents(args) {
      captureArgs.push(args);
      return rows;
    },
  };
}

test('W733 video bakeoff is wired into direct depth verification', () => {
  const pkg = readJson('package.json');
  const source = read('src/video-bakeoff.js');
  const routerSource = read('src/router.js');

  assert.equal(VIDEO_BAKEOFF_VERSION, 'w773-v1');
  assert.equal(VIDEO_BAKEOFF_CONTRACT_VERSION, 'w733-video-bakeoff-v1');
  assert.equal(VIDEO_BAKEOFF_LIMITS.hard_max_n, 500);
  assert.ok(VIDEO_BAKEOFF_LIMITS.max_store_scan_rows <= 1000);
  assert.deepEqual(CONTENT_KINDS, [
    'tutorial',
    'screencast',
    'presentation',
    'surveillance',
    'other',
  ]);
  assert.equal(Object.isFrozen(CONTENT_KINDS), true);
  assert.equal(
    pkg.scripts['verify:video-bakeoff'],
    'node --test --test-concurrency=1 tests/wave733-video-bakeoff-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:verticals && npm run verify:video-bakeoff && npm run verify:video-capture && npm run verify:vision-capture && npm run verify:vlm-bakeoff && npm run verify:website-status && npm run verify:zip-large && npm run verify:python-onnx-text && npm run verify:fal-backend && npm run verify:vast-backend && npm run verify:browser-extension-popup && npm run verify:langchain-package-manifest && npm run verify:llamaindex-package-manifest && npm run verify:runtime-rs-build-scripts && npm run verify:runtime-rs-wasm-example && npm run verify:distribution-manifests && npm run verify:eval-safety-harnesses && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.match(source, /VIDEO_BAKEOFF_LIMITS/);
  assert.match(source, /_errorEnvelope/);
  assert.match(source, /artifact_path_sha256/);
  assert.match(routerSource, /video_bakeoff_error/);
  assert.match(routerSource, /w733-video-bakeoff-v1/);
  assert.doesNotMatch(routerSource, /video_bakeoff_error['"][\s\S]{0,240}detail:/);
});

test('W733 tenant and namespace boundaries fail closed before store reads', async () => {
  const missing = await runVideoBakeoff();
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'tenant_id_required');
  assert.equal(missing.contract_version, VIDEO_BAKEOFF_CONTRACT_VERSION);

  const called = [];
  const badNamespace = await runVideoBakeoff({
    tenant_id: 'tenant_w733',
    namespace: 'video\ncustomer@example.com',
    opts: {
      storeMod: {
        async listEvents(args) {
          called.push(args);
          return [];
        },
      },
    },
  });
  const badJson = JSON.stringify(badNamespace);
  assert.equal(badNamespace.ok, false);
  assert.equal(badNamespace.error, 'invalid_namespace');
  assert.match(badNamespace.error_sha256, HEX64_RE);
  assert.equal(called.length, 0);
  assert.equal(badJson.includes('customer@example.com'), false);
});

test('W733 no-video envelope keeps tenant fence, cap, and all content-kind keys', async () => {
  const calls = [];
  const out = await runVideoBakeoff({
    tenant_id: 'tenant_a',
    namespace: 'videos',
    max_n: 999999,
    artifact_path: 'C:/private/model.kolm',
    opts: {
      storeMod: storeWith([
        { tenant_id: 'tenant_b', namespace: 'videos', media_kind: 'video', response_head: 'secret' },
        { tenant_id: 'tenant_a', namespace: 'videos', media_kind: 'audio', response_head: 'not video' },
      ], calls),
      now_ms: NOW_MS,
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.message, 'no_video_captures');
  assert.equal(out.contract_version, VIDEO_BAKEOFF_CONTRACT_VERSION);
  assert.equal(out.tenant_id, 'tenant_a');
  assert.equal(out.namespace, 'videos');
  assert.equal(out.artifact_path, '[redacted]');
  assert.equal(out.artifact_path_sha256, sha('C:/private/model.kolm'));
  assert.equal(out.count_total, 0);
  assert.deepEqual(Object.keys(out.by_content_kind), CONTENT_KINDS);
  for (const kind of CONTENT_KINDS) {
    assert.deepEqual(out.by_content_kind[kind], {
      count: 0,
      mean_score: null,
      median_score: null,
    });
  }
  assert.equal(calls[0].tenant_id, 'tenant_a');
  assert.equal(calls[0].namespace, 'videos');
  assert.equal(calls[0].media_kind, 'video');
  assert.equal(calls[0].limit, VIDEO_BAKEOFF_LIMITS.max_store_scan_rows);
});

test('W733 scoring aggregates per content kind and never echoes artifact paths', async () => {
  const artifactPath = 'C:/Users/example/private-model.kolm';
  const rows = [
    {
      tenant_id: 'tenant_a',
      namespace: 'videos',
      media_kind: 'video',
      prompt_redacted: 'summarize contract tutorial',
      w773: { response_head: 'tutorial step by step contract review' },
    },
    {
      tenant_id: 'tenant_a',
      namespace: 'videos',
      media_kind: 'video',
      prompt_redacted: 'summarize release demo',
      response_head: 'screen recording demo release notes',
      media_uri: 'https://example.com/screencast.mp4',
    },
    {
      tenant_id: 'tenant_b',
      namespace: 'videos',
      media_kind: 'video',
      response_head: 'surveillance cctv secret',
    },
    {
      tenant_id: 'tenant_a',
      namespace: 'other',
      media_kind: 'video',
      response_head: 'presentation slides',
    },
  ];

  const out = await runVideoBakeoff({
    tenant_id: 'tenant_a',
    namespace: 'videos',
    artifact_path: artifactPath,
    max_n: 2.9,
    opts: {
      storeMod: storeWith(rows),
      runOnArtifact: async (_path, input) => String(input || '') + ' contract review demo',
      judge: (base, candidate) => (String(base).includes('tutorial') && String(candidate).includes('contract')) ? 1 : 0.5,
      judgeKind: 'fixture_jaccard_v1',
      now_ms: NOW_MS,
    },
  });
  const json = JSON.stringify(out);

  assert.equal(out.ok, true);
  assert.equal(out.contract_version, VIDEO_BAKEOFF_CONTRACT_VERSION);
  assert.equal(out.count_total, 2);
  assert.equal(out.count_video_pairs_evaluated, 2);
  assert.equal(out.max_n, 2);
  assert.equal(out.avg_score, 0.75);
  assert.equal(out.by_content_kind.tutorial.count, 1);
  assert.equal(out.by_content_kind.tutorial.mean_score, 1);
  assert.equal(out.by_content_kind.screencast.count, 1);
  assert.equal(out.by_content_kind.screencast.mean_score, 0.5);
  assert.equal(out.judge_kind, 'fixture_jaccard_v1');
  assert.equal(out.artifact_error_count, 0);
  assert.equal(out.judge_error_count, 0);
  assert.equal(out.generated_at, '2026-06-18T00:00:00.000Z');
  assert.equal(out.artifact_path, '[redacted]');
  assert.equal(out.artifact_path_sha256, sha(artifactPath));
  assert.equal(json.includes('private-model.kolm'), false);
});

test('W733 store and judge failures stay bounded and non-leaky', async () => {
  const failedStore = await runVideoBakeoff({
    tenant_id: 'tenant_a',
    opts: {
      storeMod: {
        async listEvents() {
          throw new Error('db password secret: customer@example.com');
        },
      },
    },
  });
  const failedStoreJson = JSON.stringify(failedStore);
  assert.equal(failedStore.ok, false);
  assert.equal(failedStore.error, 'store_read_failed');
  assert.match(failedStore.error_sha256, HEX64_RE);
  assert.equal(failedStore.detail, undefined);
  assert.equal(failedStoreJson.includes('customer@example.com'), false);
  assert.equal(failedStoreJson.includes('password'), false);

  let runCount = 0;
  const out = await runVideoBakeoff({
    tenant_id: 'tenant_a',
    max_n: 999999,
    opts: {
      storeMod: storeWith([
        { tenant_id: 'tenant_a', namespace: 'videos', media_kind: 'video', response_head: 'tutorial one' },
        { tenant_id: 'tenant_a', namespace: 'videos', media_kind: 'video', response_head: 'tutorial two' },
        { tenant_id: 'tenant_a', namespace: 'videos', media_kind: 'video', response_head: 'tutorial three' },
      ]),
      runOnArtifact: async () => {
        runCount += 1;
        if (runCount === 1) throw new Error('artifact failed');
        if (runCount === 2) return { __error__: 'artifact failed again' };
        return 'candidate';
      },
      judge: (_base, candidate) => {
        if (candidate === 'candidate') throw new Error('judge failed');
        return 2;
      },
      now_ms: NOW_MS,
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.max_n, VIDEO_BAKEOFF_LIMITS.hard_max_n);
  assert.equal(out.count_video_pairs_evaluated, 3);
  assert.equal(out.artifact_error_count, 2);
  assert.equal(out.judge_error_count, 1);
  assert.equal(out.avg_score, 0);
});
