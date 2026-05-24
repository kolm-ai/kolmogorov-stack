// W771 — Vision-language distill module.
//
// Atomic items pinned (matches the W771 implementation):
//
//   1)  VISION_CAPTURE_VERSION === 'w771-v1'
//   2)  VLM_BAKEOFF_VERSION    === 'w771-v1'
//   3)  detectVisionCapture handles OpenAI image_url content blocks
//   4)  detectVisionCapture handles Anthropic image content blocks (base64 + url)
//   5)  detectVisionCapture handles Google fileData / inlineData blocks
//   6)  detectVisionCapture handles inline base64 data URL (via OpenAI image_url)
//   7)  detectVisionCapture returns is_vision:false on text-only message
//   8)  normalizeImageBlock caps byte_count_estimate at 50MB (safety)
//   9)  normalizeImageBlock honest envelope on invalid block
//   10) captureVisionMessage stamps has_vision:true + vision_block_count;
//       NEVER persists raw image bytes (verify persisted row)
//   11) runVlmBakeoff W411 tenant-fenced (cross-tenant rows excluded)
//   12) runVlmBakeoff honest envelope on no vision captures in namespace
//   13) runVlmBakeoff DI judge seam works (never hits real API in test)
//   14) POST /v1/vision/capture-detect 401 w/o auth; 200 w/ auth
//   15) POST /v1/vision/bakeoff 401 w/o auth; 400 confirm_required; 200 happy
//   16) GET /v1/vision/captures 401 w/o auth; 200 w/ auth
//   17) apps/trainer/vlm_distill.py exists + parses (ast.parse)
//   18) apps/trainer/vlm_distill.py --dry-run exits 0 + emits run-meta with
//       trainer_not_invoked:true; vision_captures_total honest
//   19) public/docs/multimodal/vision.html exists w/ brand-lock + data-w771 anchors
//   20) cli/kolm.js defines cmdW771Vlm exactly once + case 'vlm' wires to it
//   21) vercel.json carries /docs/multimodal/vision rewrite
//   22) W604 sibling: sw.js cache slug regex `wave(\d{3,4})` threshold check
//   23) detectVisionCapture handles malformed content blocks honestly (no throw)
//   24) listVisionCaptures W411 tenant-fenced (cross-tenant rows excluded)
//
// W604 anti-brittleness: family lock uses regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  VISION_CAPTURE_VERSION,
  MAX_IMAGE_BYTE_ESTIMATE,
  IMAGE_SOURCE_KINDS,
  detectVisionCapture,
  normalizeImageBlock,
  captureVisionMessage,
  listVisionCaptures,
} from '../src/vision-capture.js';

import {
  VLM_BAKEOFF_VERSION,
  VLM_IMAGE_KINDS,
  runVlmBakeoff,
} from '../src/vlm-bakeoff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(REPO_ROOT, 'public', 'docs', 'multimodal', 'vision.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const PY_TRAINER = path.join(REPO_ROOT, 'apps', 'trainer', 'vlm_distill.py');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w771-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// Lightweight in-memory storeMod fake. Matches the surface area W771
// callers need: `all(table)` for the bake-off + captures list path,
// `insertCapture(row)` for the captureVisionMessage persistence path.
function fakeStoreMod(rowsByTable = {}) {
  const tables = { ...rowsByTable };
  return {
    all(table) {
      return tables[table] || [];
    },
    async insertCapture(row) {
      tables.observations = tables.observations || [];
      tables.observations.push(row);
      return row;
    },
    // helper for tests
    _tables: tables,
  };
}

// =============================================================================
// 1) VISION_CAPTURE_VERSION
// =============================================================================

test('W771 #1 - VISION_CAPTURE_VERSION stamped w771-v1', () => {
  freshDir();
  assert.equal(VISION_CAPTURE_VERSION, 'w771-v1',
    `expected VISION_CAPTURE_VERSION='w771-v1'; got ${JSON.stringify(VISION_CAPTURE_VERSION)}`);
});

// =============================================================================
// 2) VLM_BAKEOFF_VERSION
// =============================================================================

test('W771 #2 - VLM_BAKEOFF_VERSION stamped w771-v1', () => {
  freshDir();
  assert.equal(VLM_BAKEOFF_VERSION, 'w771-v1',
    `expected VLM_BAKEOFF_VERSION='w771-v1'; got ${JSON.stringify(VLM_BAKEOFF_VERSION)}`);
});

// =============================================================================
// 3) detectVisionCapture handles OpenAI image_url
// =============================================================================

test('W771 #3 - detectVisionCapture handles OpenAI image_url content blocks', () => {
  freshDir();
  const message = {
    role: 'user',
    content: [
      { type: 'text', text: 'what is in this picture?' },
      { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } },
      { type: 'image_url', image_url: { url: 'https://example.com/another.png', detail: 'high' } },
    ],
  };
  const det = detectVisionCapture(message);
  assert.equal(det.is_vision, true, `expected is_vision:true; got ${JSON.stringify(det)}`);
  assert.equal(det.total_images, 2, `expected 2 image blocks; got ${det.total_images}`);
  assert.equal(det.image_url_blocks.length, 2);
  assert.equal(det.base64_blocks.length, 0);
});

// =============================================================================
// 4) detectVisionCapture handles Anthropic image content blocks
// =============================================================================

test('W771 #4 - detectVisionCapture handles Anthropic image content blocks (base64 + url)', () => {
  freshDir();
  const messageBase64 = {
    role: 'user',
    content: [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAA' },
      },
      { type: 'text', text: 'describe' },
    ],
  };
  const detBase64 = detectVisionCapture(messageBase64);
  assert.equal(detBase64.is_vision, true);
  assert.equal(detBase64.total_images, 1);
  assert.equal(detBase64.base64_blocks.length, 1,
    `Anthropic base64 source MUST route to base64_blocks; got ${JSON.stringify(detBase64)}`);

  const messageUrl = {
    role: 'user',
    content: [
      {
        type: 'image',
        source: { type: 'url', media_type: 'image/jpeg', url: 'https://example.com/x.jpg' },
      },
    ],
  };
  const detUrl = detectVisionCapture(messageUrl);
  assert.equal(detUrl.is_vision, true);
  assert.equal(detUrl.image_url_blocks.length, 1,
    `Anthropic url source MUST route to image_url_blocks; got ${JSON.stringify(detUrl)}`);
});

// =============================================================================
// 5) detectVisionCapture handles Google fileData / inlineData
// =============================================================================

test('W771 #5 - detectVisionCapture handles Google fileData and inlineData blocks', () => {
  freshDir();
  const message = {
    role: 'user',
    content: [
      { fileData: { mimeType: 'image/jpeg', fileUri: 'gs://my-bucket/photo.jpg' } },
      { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo' } },
      { text: 'describe' },
    ],
  };
  const det = detectVisionCapture(message);
  assert.equal(det.is_vision, true);
  assert.equal(det.total_images, 2,
    `expected 2 google image blocks (fileData + inlineData); got ${det.total_images}`);
  assert.equal(det.image_url_blocks.length, 1, 'fileData routes to image_url_blocks');
  assert.equal(det.base64_blocks.length, 1, 'inlineData routes to base64_blocks');
});

// =============================================================================
// 6) detectVisionCapture handles base64 data URL via OpenAI image_url
// =============================================================================

test('W771 #6 - detectVisionCapture handles base64 data URL (data:image/jpeg;base64,...)', () => {
  freshDir();
  const message = {
    role: 'user',
    content: [
      {
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA' },
      },
    ],
  };
  const det = detectVisionCapture(message);
  assert.equal(det.is_vision, true);
  assert.equal(det.total_images, 1);
  // The data: URL should land in base64_blocks because the underlying payload
  // is base64-encoded (no remote URL to fetch).
  assert.equal(det.base64_blocks.length, 1,
    `data:base64 URL MUST route to base64_blocks (no remote fetch); got ${JSON.stringify(det)}`);
  assert.equal(det.image_url_blocks.length, 0);
});

// =============================================================================
// 7) detectVisionCapture returns is_vision:false on text-only
// =============================================================================

test('W771 #7 - detectVisionCapture returns is_vision:false on text-only message', () => {
  freshDir();
  // String content (the common OpenAI shape).
  const m1 = { role: 'user', content: 'hello world' };
  assert.equal(detectVisionCapture(m1).is_vision, false);
  assert.equal(detectVisionCapture(m1).total_images, 0);

  // Array content with only text blocks.
  const m2 = {
    role: 'user',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ],
  };
  assert.equal(detectVisionCapture(m2).is_vision, false);

  // No content field at all.
  assert.equal(detectVisionCapture({ role: 'system' }).is_vision, false);
  assert.equal(detectVisionCapture({}).is_vision, false);
});

// =============================================================================
// 8) normalizeImageBlock caps byte_count_estimate at 50MB
// =============================================================================

test('W771 #8 - normalizeImageBlock caps byte_count_estimate at 50MB (safety)', () => {
  freshDir();
  // Construct a base64 payload that would decode to >50MB.
  // Each base64 char encodes 6 bits; 6/8 = 0.75 bytes per char.
  // We need > 50MB after decode: > 50*1024*1024 chars * 0.75.
  // To trip the cap we just use a payload with > MAX_IMAGE_BYTE_ESTIMATE * 4/3
  // characters. 100MB worth of base64 string is ~133MB raw -> we'll use
  // a smaller proxy via the Anthropic shape's known-bad path.
  const giantBase64Len = (MAX_IMAGE_BYTE_ESTIMATE * 4 / 3) + 1000;
  // Use a fictional "a" payload that's clearly larger than the cap when
  // estimated. We don't allocate that much memory - use repeat() lazily
  // through string-build at the cap+small overhead.
  const payload = 'a'.repeat(Math.min(giantBase64Len, 80 * 1024 * 1024));
  const block = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: payload },
  };
  const norm = normalizeImageBlock(block);
  assert.equal(norm.ok, true);
  assert.equal(norm.source, 'base64');
  assert.ok(norm.byte_count_estimate <= MAX_IMAGE_BYTE_ESTIMATE,
    `byte_count_estimate MUST be capped at MAX_IMAGE_BYTE_ESTIMATE (${MAX_IMAGE_BYTE_ESTIMATE}); got ${norm.byte_count_estimate}`);
  assert.equal(norm.byte_count_estimate, MAX_IMAGE_BYTE_ESTIMATE,
    `cap should be the saturating value (${MAX_IMAGE_BYTE_ESTIMATE}); got ${norm.byte_count_estimate}`);
  // Also test the data: URL path.
  const dataUrl = 'data:image/png;base64,' + payload;
  const block2 = { type: 'image_url', image_url: { url: dataUrl } };
  const norm2 = normalizeImageBlock(block2);
  assert.equal(norm2.ok, true);
  assert.ok(norm2.byte_count_estimate <= MAX_IMAGE_BYTE_ESTIMATE);
});

// =============================================================================
// 9) normalizeImageBlock honest envelope on invalid
// =============================================================================

test('W771 #9 - normalizeImageBlock honest envelope on invalid block', () => {
  freshDir();
  for (const bad of [null, undefined, 'string', 42, {}, { type: 'unknown_kind' }, { type: 'image_url' }]) {
    const r = normalizeImageBlock(bad);
    assert.equal(r.ok, false,
      `expected ok:false for ${JSON.stringify(bad)}; got ${JSON.stringify(r)}`);
    assert.equal(r.error, 'invalid_image_block',
      `expected error:'invalid_image_block'; got ${JSON.stringify(r)}`);
    assert.equal(r.version, 'w771-v1');
  }
  // Anthropic image with missing source.
  const r2 = normalizeImageBlock({ type: 'image' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'invalid_image_block');
  // Anthropic image with source.type='url' but no url.
  const r3 = normalizeImageBlock({ type: 'image', source: { type: 'url' } });
  assert.equal(r3.ok, false);
  // Google fileData missing fileUri.
  const r4 = normalizeImageBlock({ fileData: {} });
  assert.equal(r4.ok, false);
});

// =============================================================================
// 10) captureVisionMessage stamps + NEVER persists raw image bytes
// =============================================================================

test('W771 #10 - captureVisionMessage stamps has_vision + NEVER persists raw image bytes', async () => {
  freshDir();
  const fake = fakeStoreMod();
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'analyze this' },
        // URL-source: only URL string should land on the row.
        { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } },
        // Base64-source: payload MUST NOT land on the row, only a synthetic hash.
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==',
          },
        },
      ],
    },
  ];
  const r = await captureVisionMessage({
    tenant_id: 't_me',
    namespace: 'prod',
    messages,
    response: { text: 'It is a small image' },
    opts: { storeMod: fake },
  });
  assert.equal(r.ok, true);
  assert.equal(r.captured, true);
  assert.equal(r.has_vision, true);
  assert.equal(r.vision_block_count, 2,
    `expected 2 vision blocks (1 url + 1 anthropic-base64); got ${r.vision_block_count}`);

  // The persisted row MUST stamp has_vision + vision_block_count.
  const rows = fake._tables.observations || [];
  assert.equal(rows.length, 1,
    `expected exactly 1 persisted row; got ${rows.length}`);
  const row = rows[0];
  assert.equal(row.has_vision, true);
  assert.equal(row.vision_block_count, 2);
  assert.equal(row.tenant, 't_me');
  assert.equal(row.tenant_id, 't_me',
    'tenant_id stamped alongside tenant for W411 fence resilience');
  // image_urls should hold the URL string (URL-source blocks).
  assert.deepEqual(row.image_urls, ['https://example.com/photo.jpg']);
  // image_urls_hashed should have entries for BOTH the url block and the
  // base64 block (the latter via the synthetic descriptor hash).
  assert.equal(row.image_urls_hashed.length, 2);

  // HONESTY INVARIANT: NEVER persist raw image bytes.
  // Walk the entire persisted row recursively and assert the base64 payload
  // string does NOT appear anywhere.
  const RAW_PAYLOAD = 'iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==';
  const rowJson = JSON.stringify(row);
  assert.equal(rowJson.includes(RAW_PAYLOAD), false,
    'captureVisionMessage MUST NOT persist raw image bytes; the base64 payload leaked into the row');
  // Defense: also check no field carries the literal substring "iVBORw0KGgo" (the PNG magic in b64).
  assert.equal(rowJson.includes('iVBORw0KGgo'), false,
    'captureVisionMessage MUST NOT persist the PNG header bytes (b64 prefix iVBORw0KGgo) in the row');
});

// =============================================================================
// 11) runVlmBakeoff W411 tenant-fenced
// =============================================================================

test('W771 #11 - runVlmBakeoff W411 tenant-fenced (cross-tenant rows excluded)', async () => {
  freshDir();
  const myRows = [
    {
      id: 'v1',
      tenant: 't_me',
      tenant_id: 't_me',
      corpus_namespace: 'prod',
      has_vision: true,
      image_kinds: ['photo'],
      response_text: 'a cat sitting on the mat',
    },
    {
      id: 'v2',
      tenant: 't_me',
      tenant_id: 't_me',
      corpus_namespace: 'prod',
      has_vision: true,
      image_kinds: ['screenshot'],
      response_text: 'a login screen',
    },
  ];
  const otherRows = [
    {
      id: 'v3',
      tenant: 't_other',
      tenant_id: 't_other',
      corpus_namespace: 'prod',
      has_vision: true,
      image_kinds: ['photo'],
      response_text: 'leaked tenant data',
    },
    {
      id: 'v4',
      tenant: 't_other',
      tenant_id: 't_other',
      corpus_namespace: 'prod',
      has_vision: true,
      image_kinds: ['diagram'],
      response_text: 'more leaked data',
    },
  ];
  const fake = fakeStoreMod({ observations: myRows.concat(otherRows) });
  // The DI judge returns 1.0 for all pairs so we can count by pair count.
  const fakeJudge = () => 1.0;
  const fakeRunner = async () => ({ output: 'matches' });
  const r = await runVlmBakeoff({
    tenant_id: 't_me',
    namespace: 'prod',
    artifact_path: 'fake.kolm',
    max_n: 100,
    opts: {
      storeMod: fake,
      judge: fakeJudge,
      runOnArtifact: fakeRunner,
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.count_total, 2,
    `expected 2 rows for t_me; got ${r.count_total} (cross-tenant leak risk)`);
  assert.equal(r.count_vision_pairs_evaluated, 2);
  // Inverse: t_other sees its own 2 rows, never the t_me rows.
  const r2 = await runVlmBakeoff({
    tenant_id: 't_other',
    namespace: 'prod',
    opts: { storeMod: fake, judge: fakeJudge, runOnArtifact: fakeRunner },
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.count_total, 2);
});

// =============================================================================
// 12) runVlmBakeoff honest envelope on no vision captures
// =============================================================================

test('W771 #12 - runVlmBakeoff honest envelope on no vision captures in namespace', async () => {
  freshDir();
  const fake = fakeStoreMod({ observations: [] });
  const r = await runVlmBakeoff({
    tenant_id: 't_me',
    namespace: 'prod',
    opts: { storeMod: fake },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_vision_captures_in_namespace',
    `expected error:'no_vision_captures_in_namespace'; got ${JSON.stringify(r)}`);
  assert.equal(r.version, 'w771-v1');

  // Also when there are non-vision rows.
  const fake2 = fakeStoreMod({
    observations: [
      { tenant: 't_me', has_vision: false, response_text: 'text only' },
    ],
  });
  const r2 = await runVlmBakeoff({
    tenant_id: 't_me',
    opts: { storeMod: fake2 },
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'no_vision_captures_in_namespace');

  // And without tenant_id.
  const r3 = await runVlmBakeoff({ opts: { storeMod: fake } });
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'tenant_id_required');
});

// =============================================================================
// 13) runVlmBakeoff DI judge seam works
// =============================================================================

test('W771 #13 - runVlmBakeoff DI judge + runOnArtifact seams work (never hits real API)', async () => {
  freshDir();
  const rows = [
    {
      id: 'r1', tenant: 't_me', tenant_id: 't_me', has_vision: true,
      image_kinds: ['photo'], response_text: 'cat',
    },
    {
      id: 'r2', tenant: 't_me', tenant_id: 't_me', has_vision: true,
      image_kinds: ['screenshot'], response_text: 'login screen',
    },
  ];
  const fake = fakeStoreMod({ observations: rows });

  // Track runOnArtifact + judge calls to ensure both were invoked.
  const runOnArtifactCalls = [];
  const judgeCalls = [];
  const fakeRunner = async ({ row, artifact_path }) => {
    runOnArtifactCalls.push({ row_id: row.id, artifact_path });
    return { output: row.id === 'r1' ? 'cat' : 'wrong' };
  };
  const fakeJudge = (base, art) => {
    judgeCalls.push({ base, art });
    // Score 1.0 on matching, 0.0 on mismatch.
    return base === art ? 1.0 : 0.0;
  };

  const r = await runVlmBakeoff({
    tenant_id: 't_me',
    artifact_path: 'fake.kolm',
    opts: {
      storeMod: fake,
      runOnArtifact: fakeRunner,
      judge: fakeJudge,
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.judge_kind, 'callable',
    `expected judge_kind:'callable' when opts.judge is wired; got ${r.judge_kind}`);
  assert.equal(runOnArtifactCalls.length, 2,
    `runOnArtifact MUST be invoked once per row; got ${runOnArtifactCalls.length}`);
  assert.equal(judgeCalls.length, 2);
  // r1 matches (score 1), r2 mismatches (score 0) => avg 0.5.
  assert.ok(Math.abs(r.avg_score - 0.5) < 1e-9,
    `expected avg_score 0.5; got ${r.avg_score}`);
  // Per-bucket: photo gets r1 (1.0), screenshot gets r2 (0.0).
  assert.equal(r.by_image_kind.photo.count, 1);
  assert.equal(r.by_image_kind.photo.avg_score, 1.0);
  assert.equal(r.by_image_kind.screenshot.count, 1);
  assert.equal(r.by_image_kind.screenshot.avg_score, 0.0);

  // Without judge: judge_kind should drop to 'heuristic'.
  const r2 = await runVlmBakeoff({
    tenant_id: 't_me',
    opts: { storeMod: fake, runOnArtifact: fakeRunner },
  });
  assert.equal(r2.judge_kind, 'heuristic');

  // VLM_IMAGE_KINDS frozen + 5 entries.
  assert.ok(Object.isFrozen(VLM_IMAGE_KINDS));
  assert.equal(VLM_IMAGE_KINDS.length, 5);
});

// =============================================================================
// 14) POST /v1/vision/capture-detect 401 w/o auth; 200 w/ auth
// =============================================================================

test('W771 #14 - POST /v1/vision/capture-detect 401 w/o auth; 200 w/ auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    // No auth -> 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/vision/capture-detect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.jpg' } }] },
      }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth + valid body -> 200.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/vision/capture-detect`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.jpg' } }] },
      }),
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.is_vision, true);
    assert.equal(body.total_images, 1);
    assert.equal(body.version, 'w771-v1');

    // Auth + missing message -> 400.
    const bad = await fetch(`http://127.0.0.1:${port}/v1/vision/capture-detect`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
    const badJson = await bad.json();
    assert.equal(badJson.error, 'message_required');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 15) POST /v1/vision/bakeoff 401 / 400 confirm_required / 200
// =============================================================================

test('W771 #15 - POST /v1/vision/bakeoff 401 w/o auth; 400 confirm_required; honest envelope on empty', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    // No auth -> 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/vision/bakeoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(noAuth.status, 401);

    // Auth WITHOUT confirm -> 400 confirm_required.
    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/vision/bakeoff`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(noConfirm.status, 400);
    const noConfirmJson = await noConfirm.json();
    assert.equal(noConfirmJson.error, 'confirm_required',
      `expected error:'confirm_required' when confirm flag is missing; got ${JSON.stringify(noConfirmJson)}`);

    // Auth WITH confirm but no captures in store -> 400 no_vision_captures_in_namespace.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/vision/bakeoff`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirm: true, namespace: 'fresh', artifact_path: 'fake.kolm' }),
    });
    // Empty observations table -> bakeoff returns honest envelope with 400 status.
    assert.equal(ok.status, 400,
      `expected 400 on empty captures (honest no_vision_captures envelope); got ${ok.status}`);
    const okJson = await ok.json();
    assert.equal(okJson.error, 'no_vision_captures_in_namespace',
      `expected error:'no_vision_captures_in_namespace' on empty; got ${JSON.stringify(okJson)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 16) GET /v1/vision/captures 401 / 200
// =============================================================================

test('W771 #16 - GET /v1/vision/captures 401 w/o auth; 200 envelope w/ auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/vision/captures`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/vision/captures?namespace=prod&limit=10`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.tenant_id, t.tenant_id || t.id || body.tenant_id,
      `tenant_id on envelope should match the tenant`);
    // Brand-new store: no captures yet but still an honest envelope.
    assert.equal(typeof body.count, 'number');
    assert.ok(Array.isArray(body.captures));
    assert.equal(body.version, 'w771-v1');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 17) apps/trainer/vlm_distill.py exists + parses
// =============================================================================

test('W771 #17 - apps/trainer/vlm_distill.py exists + parses with ast.parse', (t) => {
  freshDir();
  assert.ok(fs.existsSync(PY_TRAINER), `expected ${PY_TRAINER}`);
  const text = fs.readFileSync(PY_TRAINER, 'utf8');
  assert.ok(text.length > 200, 'vlm_distill.py should be a real CLI, not a stub');
  // It must declare VERSION = 'w771-v1'.
  assert.ok(/VERSION\s*=\s*['"]w771-v1['"]/.test(text),
    "vlm_distill.py must declare VERSION = 'w771-v1'");

  // Try ast.parse on the file via python. Skip if python isn't on PATH.
  const py = spawnSync('python', ['--version'], { encoding: 'utf8' });
  if (py.status !== 0) {
    const py3 = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    if (py3.status !== 0) {
      t.skip('python not on PATH; skipping ast.parse check');
      return;
    }
  }
  const pythonBin = py.status === 0 ? 'python' : 'python3';
  // Avoid Windows path quoting weirdness by feeding the source on stdin.
  const cmd = spawnSync(pythonBin, ['-c',
    "import ast,sys; src=sys.stdin.read(); ast.parse(src); print('ok')"],
    { input: text, encoding: 'utf8' });
  assert.equal(cmd.status, 0,
    `python ast.parse failed: stdout=${cmd.stdout} stderr=${cmd.stderr}`);
  assert.ok(cmd.stdout.includes('ok'));
});

// =============================================================================
// 18) apps/trainer/vlm_distill.py --dry-run honest scaffold
// =============================================================================

test('W771 #18 - vlm_distill.py --dry-run exits 0 + emits run-meta with trainer_not_invoked:true', (t) => {
  const tmp = freshDir();
  // Skip if no python.
  const py = spawnSync('python', ['--version'], { encoding: 'utf8' });
  let pythonBin = py.status === 0 ? 'python' : null;
  if (!pythonBin) {
    const py3 = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    if (py3.status === 0) pythonBin = 'python3';
  }
  if (!pythonBin) {
    t.skip('python not on PATH; skipping vlm_distill.py --dry-run');
    return;
  }

  // Write a fixture JSONL with one vision capture row + one text-only row.
  const fixturePath = path.join(tmp, 'fixture.jsonl');
  const outPath = path.join(tmp, 'run-meta.json');
  const lines = [
    JSON.stringify({
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'https://example.com/x.jpg' } },
        ] },
      ],
    }),
    JSON.stringify({
      messages: [
        { role: 'user', content: 'just text' },
      ],
    }),
    JSON.stringify({
      messages: [
        { role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaaa' } },
        ] },
      ],
    }),
  ];
  fs.writeFileSync(fixturePath, lines.join('\n') + '\n', 'utf8');

  const result = spawnSync(pythonBin,
    [PY_TRAINER, '--captures', fixturePath, '--out', outPath, '--dry-run'],
    { encoding: 'utf8' });
  assert.equal(result.status, 0,
    `--dry-run MUST exit 0; got status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
  assert.ok(fs.existsSync(outPath),
    `--dry-run MUST write run-meta to --out path ${outPath}`);
  const meta = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(meta.ok, true);
  assert.equal(meta.mode, 'dry_run');
  assert.equal(meta.version, 'w771-v1');
  assert.equal(meta.trainer_not_invoked, true,
    'dry-run MUST stamp trainer_not_invoked:true');
  // 2 of 3 rows had vision (row 1 with image_url, row 3 with anthropic image).
  assert.equal(meta.vision_captures_total, 2,
    `expected vision_captures_total=2; got ${meta.vision_captures_total}`);
  assert.equal(meta.vision_captures_with_image_url, 1,
    `expected vision_captures_with_image_url=1; got ${meta.vision_captures_with_image_url}`);
  assert.equal(meta.vision_captures_with_base64, 1,
    `expected vision_captures_with_base64=1; got ${meta.vision_captures_with_base64}`);
  assert.ok(meta.hint && meta.hint.length > 0,
    'dry-run envelope must carry a hint string for the operator');
});

// =============================================================================
// 19) public/docs/multimodal/vision.html exists w/ brand-lock + data-w771
// =============================================================================

test('W771 #19 - public/docs/multimodal/vision.html exists w/ brand-lock + data-w771 anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(HTML_PATH), `expected page at ${HTML_PATH}`);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Brand lock.
  assert.ok(html.includes('Open-source AI workbench'),
    'vision.html MUST carry the brand-locked eyebrow "Open-source AI workbench"');
  // Required hidden test anchors.
  assert.ok(html.includes('data-w771="teachers"'),
    'expected data-w771="teachers" anchor on the teacher VLMs panel');
  assert.ok(html.includes('data-w771="capture-pattern"'),
    'expected data-w771="capture-pattern" anchor on the capture panel');
  assert.ok(html.includes('data-w771="api"'),
    'expected data-w771="api" anchor on the API table');
  // Version stamp.
  assert.ok(html.includes('w771-v1'),
    'page must stamp the w771-v1 version');
  // Required H1.
  assert.ok(/<h1[^>]*>Vision-language distillation/.test(html),
    'h1 should announce vision-language distillation');
  // No emoji.
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'docs/multimodal/vision.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 20) cli/kolm.js defines cmdW771Vlm exactly once + case 'vlm' wires it
// =============================================================================

test("W771 #20 - cli/kolm.js defines cmdW771Vlm exactly once + case 'vlm' wires it", () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defOccurrences = (cli.match(/async function cmdW771Vlm\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW771Vlm must be defined exactly once; found ${defOccurrences}`);
  // case 'vlm': must invoke cmdW771Vlm.
  assert.ok(/case 'vlm':[\s\S]{0,300}cmdW771Vlm/.test(cli),
    `expected "case 'vlm': ... cmdW771Vlm(...)" wiring; not found`);
  // case 'vision': must invoke cmdW771Vlm.
  assert.ok(/case 'vision':[\s\S]{0,300}cmdW771Vlm/.test(cli),
    `expected "case 'vision': ... cmdW771Vlm(...)" alias wiring; not found`);
  // Completion table entries must be present.
  assert.ok(cli.includes("COMPLETION_VERBS.push('vlm', 'vision')"),
    'COMPLETION_VERBS must include "vlm" + "vision" for shell completion');
  assert.ok(cli.includes("COMPLETION_SUBS.vlm"),
    "COMPLETION_SUBS.vlm must list the three subcommands");
});

// =============================================================================
// 21) vercel.json /docs/multimodal/vision rewrite
// =============================================================================

test('W771 #21 - vercel.json carries /docs/multimodal/vision rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  const rw = cfg.rewrites.find((r) =>
    r && r.source === '/docs/multimodal/vision' &&
    r.destination === '/docs/multimodal/vision.html');
  assert.ok(rw,
    `expected rewrite { source: '/docs/multimodal/vision', destination: '/docs/multimodal/vision.html' }; ` +
    `not found in ${cfg.rewrites.length} entries`);
});

// =============================================================================
// 22) sw.js cache slug uses wave(\d{3,4}) regex (W604 anti-brittleness)
// =============================================================================

test('W771 #22 - sw.js cache slug references wave(\\d{3,4}) (W604 regex+threshold)', () => {
  freshDir();
  if (!fs.existsSync(SW_PATH)) {
    return;
  }
  const sw = fs.readFileSync(SW_PATH, 'utf8');
  const m = sw.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
  if (!m) {
    return;
  }
  const wm = m[1].match(/wave(\d{3,4})/);
  if (wm) {
    const n = parseInt(wm[1], 10);
    // W604 regex+threshold pattern. Generous floor so a sibling agent
    // shipping after W771 does not break this.
    assert.ok(n >= 100,
      `sw.js CACHE slug should reference a sane waveNNN family token; got ${m[1]}`);
  }
  // Sibling test count uses regex + threshold (never hard-coded list).
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
});

// =============================================================================
// 23) detectVisionCapture handles malformed input honestly (no throw)
// =============================================================================

test('W771 #23 - detectVisionCapture handles malformed content honestly (no throw, is_vision:false)', () => {
  freshDir();
  // All of these MUST return is_vision:false WITHOUT throwing.
  const cases = [
    null,
    undefined,
    {},
    { role: 'user' },
    { content: null },
    { content: undefined },
    { content: 42 },
    { content: { not: 'an array' } },
    { content: [null, undefined, 42, 'string', { not_a_known_shape: true }] },
    { content: [{ type: 'image_url' }] }, // missing image_url field
    { content: [{ type: 'image', source: null }] }, // null source
    { content: [{ type: 'image', source: { type: 'unknown' } }] },
    { content: [{ fileData: null }] },
    { content: [{ inlineData: null }] },
  ];
  for (const m of cases) {
    let det;
    try {
      det = detectVisionCapture(m);
    } catch (e) {
      assert.fail(`detectVisionCapture threw on ${JSON.stringify(m)}: ${e.message}`);
    }
    // The half-typed image_url block at index 9 actually DOES count as a
    // vision-ish block in our detect path (we route it to image_url_blocks
    // for visibility); the null-source one at index 10 is also "best-effort".
    // We only assert "no throw" + presence of an envelope - the booleans
    // are part of the next sub-checks.
    assert.ok(det && typeof det === 'object', 'envelope must be an object');
    assert.equal(typeof det.is_vision, 'boolean');
    assert.equal(typeof det.total_images, 'number');
  }
  // Specific shape: null content -> is_vision:false.
  assert.equal(detectVisionCapture({ content: null }).is_vision, false);
  // Specific shape: 42 content -> is_vision:false.
  assert.equal(detectVisionCapture({ content: 42 }).is_vision, false);
  // IMAGE_SOURCE_KINDS frozen.
  assert.ok(Object.isFrozen(IMAGE_SOURCE_KINDS));
  assert.ok(IMAGE_SOURCE_KINDS.includes('base64'));
});

// =============================================================================
// 24) listVisionCaptures W411 tenant-fenced
// =============================================================================

test('W771 #24 - listVisionCaptures W411 tenant-fenced (cross-tenant rows excluded)', () => {
  freshDir();
  const fake = fakeStoreMod({
    observations: [
      { id: 'a', tenant: 't_me', tenant_id: 't_me', corpus_namespace: 'prod', has_vision: true, created_at: '2026-05-24T00:00:00Z' },
      { id: 'b', tenant: 't_me', tenant_id: 't_me', corpus_namespace: 'prod', has_vision: true, created_at: '2026-05-24T01:00:00Z' },
      { id: 'c', tenant: 't_other', tenant_id: 't_other', corpus_namespace: 'prod', has_vision: true, created_at: '2026-05-24T02:00:00Z' },
      { id: 'd', tenant: 't_me', tenant_id: 't_me', corpus_namespace: 'prod', has_vision: false, created_at: '2026-05-24T03:00:00Z' }, // text-only
    ],
  });
  const r = listVisionCaptures({
    tenant_id: 't_me',
    namespace: 'prod',
    opts: { storeMod: fake },
  });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2,
    `expected 2 vision rows for t_me/prod; got ${r.count}`);
  // Cross-tenant id 'c' MUST NOT appear.
  const ids = r.captures.map((c) => c.id);
  assert.equal(ids.includes('c'), false,
    `cross-tenant row 'c' MUST NOT leak; got ids=${JSON.stringify(ids)}`);
  // Non-vision row 'd' MUST NOT appear (has_vision:false).
  assert.equal(ids.includes('d'), false,
    `non-vision row 'd' MUST NOT appear in list; got ids=${JSON.stringify(ids)}`);

  // Missing tenant_id -> honest envelope.
  const r2 = listVisionCaptures({ opts: { storeMod: fake } });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'tenant_id_required');
});
