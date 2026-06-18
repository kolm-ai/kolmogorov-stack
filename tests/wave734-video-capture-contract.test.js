// W734 - direct contract test for src/video-capture.js.
//
// This pins the W773 video capture atom itself: bounded block scanning, URL
// sanitization, base64 elision, tenant/namespace fencing, append failure
// envelopes, and route error redaction.

import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BYTE_COUNT_ESTIMATE,
  SUPPORTED_VIDEO_MIMES,
  VIDEO_CAPTURE_CONTRACT_VERSION,
  VIDEO_CAPTURE_LIMITS,
  VIDEO_CAPTURE_VERSION,
  captureVideoMessage,
  detectVideoCapture,
  normalizeVideoBlock,
} from '../src/video-capture.js';

const HEX64_RE = /^[a-f0-9]{64}$/;

function read(rel) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

test('W734 video capture is wired into direct depth verification', () => {
  const pkg = readJson('package.json');
  const source = read('src/video-capture.js');
  const routerSource = read('src/router.js');

  assert.equal(VIDEO_CAPTURE_VERSION, 'w773-v1');
  assert.equal(VIDEO_CAPTURE_CONTRACT_VERSION, 'w734-video-capture-v1');
  assert.equal(MAX_BYTE_COUNT_ESTIMATE, 1024 * 1024 * 1024);
  assert.equal(VIDEO_CAPTURE_LIMITS.max_video_blocks, 32);
  assert.equal(Object.isFrozen(SUPPORTED_VIDEO_MIMES), true);
  assert.equal(
    pkg.scripts['verify:video-capture'],
    'node --test --test-concurrency=1 tests/wave734-video-capture-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:video-bakeoff && npm run verify:video-capture && npm run verify:vision-capture && npm run verify:vlm-bakeoff && npm run verify:website-status && npm run verify:zip-large && npm run verify:python-onnx-text && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.match(source, /VIDEO_CAPTURE_LIMITS/);
  assert.match(source, /_safeUrlForEnvelope/);
  assert.match(source, /invalid_video_block_count/);
  assert.match(routerSource, /video_capture_detect_error/);
  assert.match(routerSource, /w734-video-capture-v1/);
  assert.doesNotMatch(routerSource, /video_capture_detect_error['"][\s\S]{0,240}detail:/);
  assert.doesNotMatch(routerSource, /video_captures_error['"][\s\S]{0,240}detail:/);
});

test('W734 detectVideoCapture caps block scans and inline string scans', () => {
  const blocks = Array.from(
    { length: VIDEO_CAPTURE_LIMITS.max_message_blocks + 50 },
    (_, i) => ({ type: 'video_url', video_url: { url: `https://example.com/${i}.mp4` } }),
  );
  const detected = detectVideoCapture({ content: blocks });
  assert.equal(detected.is_video, true);
  assert.equal(detected.total_videos, VIDEO_CAPTURE_LIMITS.max_video_blocks);
  assert.equal(detected.video_blocks.length, VIDEO_CAPTURE_LIMITS.max_video_blocks);

  const lateInline = 'x'.repeat(VIDEO_CAPTURE_LIMITS.max_inline_scan_chars + 10)
    + 'data:video/mp4;base64,AAAA';
  const none = detectVideoCapture({ content: lateInline });
  assert.equal(none.is_video, false);
  assert.equal(none.total_videos, 0);
});

test('W734 normalizeVideoBlock strips URL secrets, caps bytes, and elides base64', () => {
  const urlBlock = normalizeVideoBlock({
    type: 'video_url',
    video_url: {
      url: 'https://example.com/private/clip.mp4?token=secret#fragment',
      byte_count: MAX_BYTE_COUNT_ESTIMATE * 4,
    },
    duration_s: -5,
  });
  const urlJson = JSON.stringify(urlBlock);
  assert.equal(urlBlock.ok, true);
  assert.equal(urlBlock.contract_version, VIDEO_CAPTURE_CONTRACT_VERSION);
  assert.equal(urlBlock.url, 'https://example.com/private/clip.mp4');
  assert.match(urlBlock.url_sha256, HEX64_RE);
  assert.equal(urlBlock.byte_count_estimate, MAX_BYTE_COUNT_ESTIMATE);
  assert.equal(urlBlock.byte_count_capped, true);
  assert.equal(urlBlock.duration_s_estimate, null);
  assert.equal(urlJson.includes('token=secret'), false);

  const base64Block = normalizeVideoBlock({
    type: 'video',
    source: {
      type: 'base64',
      media_type: 'video/mp4',
      data: 'A'.repeat(5000),
    },
  });
  const base64Json = JSON.stringify(base64Block);
  assert.equal(base64Block.ok, true);
  assert.equal(base64Block.url, 'data:video/mp4;base64,<elided>');
  assert.match(base64Block.url_sha256, HEX64_RE);
  assert.equal(base64Block.byte_count_estimate, 3750);
  assert.equal(base64Json.includes('A'.repeat(80)), false);

  const withCredentials = normalizeVideoBlock({
    type: 'video_url',
    video_url: { url: 'https://user:pass@example.com/clip.mp4' },
  });
  assert.equal(withCredentials.ok, false);
  assert.equal(withCredentials.error, 'invalid_url');
  assert.equal(JSON.stringify(withCredentials).includes('pass@example.com'), false);

  const unsupported = normalizeVideoBlock({
    type: 'video_url',
    video_url: { url: 'https://example.com/clip.gif', mime_type: 'image/gif' },
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error, 'unsupported_mime');
});

test('W734 captureVideoMessage appends only sanitized video metadata', async () => {
  const appended = [];
  const out = await captureVideoMessage({
    tenant_id: 'tenant_w734',
    namespace: 'videos/main',
    response: 'summary\nwith controls',
    messages: [{
      content: [
        {
          type: 'video_url',
          video_url: { url: 'https://media.example.com/private/clip.mp4?token=secret' },
        },
        {
          type: 'video_url',
          video_url: { url: 'ftp://media.example.com/ignored.mp4' },
        },
      ],
    }],
    opts: {
      frame_count_extracted: 3,
      appendEventFn: async (partial) => {
        appended.push(partial);
        return { ...partial, persisted: true };
      },
    },
  });
  const json = JSON.stringify({ out, appended });

  assert.equal(out.ok, true);
  assert.equal(out.contract_version, VIDEO_CAPTURE_CONTRACT_VERSION);
  assert.equal(out.has_video, true);
  assert.equal(out.total_video_blocks_detected, 2);
  assert.equal(out.video_block_count, 1);
  assert.equal(out.invalid_video_block_count, 1);
  assert.equal(out.frame_count_extracted, 3);
  assert.match(out.video_urls_hashed[0], HEX64_RE);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].tenant_id, 'tenant_w734');
  assert.equal(appended[0].namespace, 'videos/main');
  assert.equal(appended[0].media_kind, 'video');
  assert.equal(appended[0].media_uri, 'https://media.example.com/private/clip.mp4');
  assert.match(appended[0].media_hash, HEX64_RE);
  assert.equal(appended[0].raw_video_bytes_persisted, false);
  assert.equal(appended[0].w773.response_head, 'summary with controls');
  assert.equal(appended[0].w773.invalid_video_block_count, 1);
  assert.equal(json.includes('token=secret'), false);
});

test('W734 captureVideoMessage rejects unsafe scope and hashes append failures', async () => {
  let appendCalled = false;
  const invalidScope = await captureVideoMessage({
    tenant_id: 'tenant_w734',
    namespace: 'videos\ncustomer@example.com',
    messages: [{ content: [{ type: 'video_url', video_url: { url: 'https://example.com/clip.mp4' } }] }],
    opts: {
      appendEventFn: async () => {
        appendCalled = true;
        return {};
      },
    },
  });
  const invalidJson = JSON.stringify(invalidScope);
  assert.equal(invalidScope.ok, false);
  assert.equal(invalidScope.error, 'invalid_namespace');
  assert.match(invalidScope.error_sha256, HEX64_RE);
  assert.equal(appendCalled, false);
  assert.equal(invalidJson.includes('customer@example.com'), false);

  const appendFailed = await captureVideoMessage({
    tenant_id: 'tenant_w734',
    messages: [{ content: [{ type: 'video_url', video_url: { url: 'https://example.com/clip.mp4' } }] }],
    opts: {
      appendEventFn: async () => {
        throw new Error('sqlite password secret customer@example.com');
      },
    },
  });
  const failedJson = JSON.stringify(appendFailed);
  assert.equal(appendFailed.ok, false);
  assert.equal(appendFailed.error, 'append_failed');
  assert.match(appendFailed.error_sha256, HEX64_RE);
  assert.equal(appendFailed.detail, undefined);
  assert.equal(failedJson.includes('customer@example.com'), false);
  assert.equal(failedJson.includes('password'), false);
});
