// W735 - direct contract test for src/vision-capture.js.
//
// This pins the W771 vision capture atom itself: bounded block scanning,
// supported image MIME handling, URL sanitization, base64 non-persistence,
// tenant/namespace fencing, sanitized capture listing, and route error
// redaction.

import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_SOURCE_KINDS,
  MAX_IMAGE_BYTE_ESTIMATE,
  SUPPORTED_IMAGE_MIMES,
  VISION_CAPTURE_CONTRACT_VERSION,
  VISION_CAPTURE_LIMITS,
  VISION_CAPTURE_VERSION,
  captureVisionMessage,
  detectVisionCapture,
  listVisionCaptures,
  normalizeImageBlock,
} from '../src/vision-capture.js';

const HEX64_RE = /^[a-f0-9]{64}$/;

function read(rel) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

test('W735 vision capture is wired into direct depth verification', () => {
  const pkg = readJson('package.json');
  const source = read('src/vision-capture.js');
  const routerSource = read('src/router.js');

  assert.equal(VISION_CAPTURE_VERSION, 'w771-v1');
  assert.equal(VISION_CAPTURE_CONTRACT_VERSION, 'w735-vision-capture-v1');
  assert.equal(MAX_IMAGE_BYTE_ESTIMATE, 50 * 1024 * 1024);
  assert.equal(VISION_CAPTURE_LIMITS.max_image_blocks, 32);
  assert.equal(Object.isFrozen(SUPPORTED_IMAGE_MIMES), true);
  assert.equal(Object.isFrozen(IMAGE_SOURCE_KINDS), true);
  assert.equal(
    pkg.scripts['verify:vision-capture'],
    'node --test --test-concurrency=1 tests/wave735-vision-capture-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:video-capture && npm run verify:vision-capture && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.match(source, /VISION_CAPTURE_LIMITS/);
  assert.match(source, /_safeUrlForEnvelope/);
  assert.match(source, /invalid_image_block_count/);
  assert.match(routerSource, /vision_capture_detect_error/);
  assert.match(routerSource, /w735-vision-capture-v1/);
  assert.doesNotMatch(routerSource, /vision_capture_detect_error['"][\s\S]{0,240}detail:/);
  assert.doesNotMatch(routerSource, /vision_captures_list_error['"][\s\S]{0,240}detail:/);
});

test('W735 detectVisionCapture caps block scans and inline string scans', () => {
  const blocks = Array.from(
    { length: VISION_CAPTURE_LIMITS.max_message_blocks + 50 },
    (_, i) => ({ type: 'image_url', image_url: { url: `https://example.com/${i}.png` } }),
  );
  const detected = detectVisionCapture({ content: blocks });
  assert.equal(detected.is_vision, true);
  assert.equal(detected.total_images, VISION_CAPTURE_LIMITS.max_image_blocks);
  assert.equal(detected.image_url_blocks.length, VISION_CAPTURE_LIMITS.max_image_blocks);
  assert.equal(detected.total_image_blocks_detected, VISION_CAPTURE_LIMITS.max_message_blocks);
  assert.equal(detected.contract_version, VISION_CAPTURE_CONTRACT_VERSION);

  const lateInline = 'x'.repeat(VISION_CAPTURE_LIMITS.max_inline_scan_chars + 10)
    + 'data:image/png;base64,AAAA';
  const none = detectVisionCapture({ content: lateInline });
  assert.equal(none.is_vision, false);
  assert.equal(none.total_images, 0);
});

test('W735 normalizeImageBlock strips URL secrets and rejects unsafe image sources', () => {
  const urlBlock = normalizeImageBlock({
    type: 'image_url',
    image_url: { url: 'https://example.com/private/photo.png?token=secret#frag' },
  });
  const urlJson = JSON.stringify(urlBlock);
  assert.equal(urlBlock.ok, true);
  assert.equal(urlBlock.contract_version, VISION_CAPTURE_CONTRACT_VERSION);
  assert.equal(urlBlock.url, 'https://example.com/private/photo.png');
  assert.equal(urlBlock.mime_type, 'image/png');
  assert.equal(urlBlock.source, 'url');
  assert.match(urlBlock.url_sha256, HEX64_RE);
  assert.equal(urlJson.includes('token=secret'), false);

  const gcsBlock = normalizeImageBlock({
    fileData: { mimeType: 'image/jpeg', fileUri: 'gs://bucket/private/photo.jpg?token=secret' },
  });
  assert.equal(gcsBlock.ok, true);
  assert.equal(gcsBlock.url, 'gs://bucket/private/photo.jpg');
  assert.equal(gcsBlock.source, 'gcs');
  assert.match(gcsBlock.url_sha256, HEX64_RE);

  const base64Block = normalizeImageBlock({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: 'A'.repeat(5000),
    },
  });
  const base64Json = JSON.stringify(base64Block);
  assert.equal(base64Block.ok, true);
  assert.equal(base64Block.url, null);
  assert.match(base64Block.content_sha256, HEX64_RE);
  assert.equal(base64Block.byte_count_estimate, 3750);
  assert.equal(base64Json.includes('A'.repeat(80)), false);

  const withCredentials = normalizeImageBlock({
    type: 'image_url',
    image_url: { url: 'https://user:pass@example.com/photo.png' },
  });
  assert.equal(withCredentials.ok, false);
  assert.equal(withCredentials.error, 'invalid_image_url');
  assert.equal(JSON.stringify(withCredentials).includes('pass@example.com'), false);

  const unsupported = normalizeImageBlock({
    type: 'image',
    source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' },
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error, 'invalid_image_block');
});

test('W735 captureVisionMessage persists only sanitized vision metadata', async () => {
  const inserted = [];
  const out = await captureVisionMessage({
    tenant_id: 'tenant_w735',
    namespace: 'vision/main',
    response: { text: 'teacher\nanswer' },
    messages: [{
      content: [
        { type: 'image_url', image_url: { url: 'https://media.example.com/private/photo.png?token=secret' } },
        { type: 'image_url', image_url: { url: 'ftp://media.example.com/ignored.png' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(256) } },
      ],
    }],
    opts: {
      storeMod: {
        insertCapture: async (row) => {
          inserted.push(row);
        },
      },
    },
  });
  const json = JSON.stringify({ out, inserted });

  assert.equal(out.ok, true);
  assert.equal(out.contract_version, VISION_CAPTURE_CONTRACT_VERSION);
  assert.equal(out.has_vision, true);
  assert.equal(out.total_image_blocks_detected, 3);
  assert.equal(out.vision_block_count, 2);
  assert.equal(out.invalid_image_block_count, 1);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].tenant_id, 'tenant_w735');
  assert.equal(inserted[0].corpus_namespace, 'vision/main');
  assert.equal(inserted[0].image_urls[0], 'https://media.example.com/private/photo.png');
  assert.match(inserted[0].image_urls_hashed[0], HEX64_RE);
  assert.match(inserted[0].image_urls_hashed[1], HEX64_RE);
  assert.equal(inserted[0].response_text, 'teacher answer');
  assert.equal(inserted[0].contract_version, VISION_CAPTURE_CONTRACT_VERSION);
  assert.equal(json.includes('token=secret'), false);
  assert.equal(json.includes('B'.repeat(80)), false);
});

test('W735 vision capture rejects unsafe scope, hashes store failures, and sanitizes lists', async () => {
  let insertCalled = false;
  const invalidScope = await captureVisionMessage({
    tenant_id: 'tenant_w735',
    namespace: 'vision\ncustomer@example.com',
    messages: [{ content: [{ type: 'image_url', image_url: { url: 'https://example.com/photo.png' } }] }],
    opts: {
      storeMod: {
        insertCapture: async () => {
          insertCalled = true;
        },
      },
    },
  });
  assert.equal(invalidScope.ok, false);
  assert.equal(invalidScope.error, 'invalid_namespace');
  assert.match(invalidScope.error_sha256, HEX64_RE);
  assert.equal(insertCalled, false);
  assert.equal(JSON.stringify(invalidScope).includes('customer@example.com'), false);

  const persistFailed = await captureVisionMessage({
    tenant_id: 'tenant_w735',
    messages: [{ content: [{ type: 'image_url', image_url: { url: 'https://example.com/photo.png' } }] }],
    opts: {
      storeMod: {
        insertCapture: async () => {
          throw new Error('sqlite password secret customer@example.com');
        },
      },
    },
  });
  const failedJson = JSON.stringify(persistFailed);
  assert.equal(persistFailed.ok, false);
  assert.equal(persistFailed.error, 'persist_failed');
  assert.match(persistFailed.error_sha256, HEX64_RE);
  assert.equal(failedJson.includes('customer@example.com'), false);
  assert.equal(failedJson.includes('password'), false);

  const listed = listVisionCaptures({
    tenant_id: 'tenant_w735',
    namespace: 'vision/main',
    limit: 99999,
    opts: {
      storeMod: {
        all: () => [
          {
            id: 'vcap_safe',
            tenant_id: 'tenant_w735',
            corpus_namespace: 'vision/main',
            has_vision: true,
            vision_block_count: 1,
            image_urls: ['https://example.com/private/photo.png?token=secret#frag'],
            image_urls_hashed: ['a'.repeat(64)],
            image_kinds: ['photo'],
            response_text: 'answer\nwith controls',
            created_at: '2026-06-18T00:00:00.000Z',
          },
          {
            id: 'vcap_other',
            tenant_id: 'other_tenant',
            corpus_namespace: 'vision/main',
            has_vision: true,
            image_urls: ['https://example.com/leak.png?token=secret'],
          },
        ],
      },
    },
  });
  const listedJson = JSON.stringify(listed);
  assert.equal(listed.ok, true);
  assert.equal(listed.contract_version, VISION_CAPTURE_CONTRACT_VERSION);
  assert.equal(listed.count, 1);
  assert.equal(listed.limit, VISION_CAPTURE_LIMITS.max_list_limit);
  assert.equal(listed.captures[0].image_urls[0], 'https://example.com/private/photo.png');
  assert.equal(listed.captures[0].response_text, 'answer with controls');
  assert.equal(listedJson.includes('other_tenant'), false);
  assert.equal(listedJson.includes('token=secret'), false);
});
