// W773 - Video distill module (frame sampling + caption pipeline).
//
// Atomic items pinned (matches the W773 implementation):
//
//   1)  VIDEO_CAPTURE_VERSION === 'w773-v1'
//   2)  VIDEO_BAKEOFF_VERSION === 'w773-v1'
//   3)  FRAME_SAMPLER_VERSION === 'w773-v1'
//   4)  SUPPORTED_VIDEO_MIMES Object.freeze()-d + 5 entries
//   5)  SAMPLING_STRATEGIES Object.freeze()-d + 4 entries
//   6)  detectVideoCapture handles base64 data:video/mp4 source block
//   7)  detectVideoCapture handles OpenAI-style video_url block
//   8)  detectVideoCapture returns is_video:false on text-only message
//   9)  normalizeVideoBlock caps byte_count_estimate at 1 GiB (observable)
//   10) normalizeVideoBlock honest envelope on bad block + bad mime
//   11) captureVideoMessage NEVER persists raw video bytes
//   12) buildSamplingSpec uniform / adaptive happy paths emit indices
//   13) buildSamplingSpec honest envelope on bad duration / strategy / fps / max
//   14) estimateExtractedFrames respects max_frames + HARD_FRAME_CAP
//   15) runVideoBakeoff W411 tenant-fenced (cross-tenant rows excluded)
//   16) runVideoBakeoff honest envelope on no video captures
//   17) runVideoBakeoff DI judge seam + by_content_kind breakdown
//   18) POST /v1/video/capture-detect 401 w/o auth; 200 w/ auth; ok+is_video:false on missing
//   19) POST /v1/video/bakeoff 401 / 400 confirm_required / 200 honest empty
//   20) GET  /v1/video/captures 401 w/o auth; 200 envelope w/ auth
//   21) apps/trainer/video_distill.py exists + parses with ast.parse
//   22) apps/trainer/video_distill.py --dry-run exits 0 + trainer_not_invoked:true
//   23) public/docs/multimodal/video.html exists w/ brand-lock + data-w773
//   24) cli/kolm.js defines cmdW773Video exactly once + case 'video' wires it
//   25) vercel.json carries /docs/multimodal/video rewrite
//   26) sw.js sibling family regex `wave(\d{3,4})` + threshold check (W604)
//   27) CONTENT_KIND map carries 5 keys always (tutorial/screencast/presentation/surveillance/other)
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
  VIDEO_CAPTURE_VERSION,
  SUPPORTED_VIDEO_MIMES,
  detectVideoCapture,
  normalizeVideoBlock,
  captureVideoMessage,
} from '../src/video-capture.js';

import {
  FRAME_SAMPLER_VERSION,
  SAMPLING_STRATEGIES,
  buildSamplingSpec,
  estimateExtractedFrames,
} from '../src/frame-sampler.js';

import {
  VIDEO_BAKEOFF_VERSION,
  runVideoBakeoff,
} from '../src/video-bakeoff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(REPO_ROOT, 'public', 'docs', 'multimodal', 'video.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const PY_TRAINER = path.join(REPO_ROOT, 'apps', 'trainer', 'video_distill.py');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w773-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// In-memory fake event-store. The W773 runVideoBakeoff consumes
// storeMod.listEvents() directly so the fake matches that shape.
function fakeEventStore(initialRows = []) {
  const rows = [...initialRows];
  return {
    rows,
    async listEvents(query = {}) {
      let out = rows.filter((ev) => {
        if (query.tenant_id && ev.tenant_id !== query.tenant_id) return false;
        if (query.namespace && ev.namespace !== query.namespace) return false;
        if (query.media_kind && ev.media_kind !== query.media_kind) return false;
        return true;
      });
      const lim = Number(query.limit);
      if (Number.isFinite(lim) && lim > 0) out = out.slice(0, lim);
      return out;
    },
    async appendEvent(ev) {
      const row = {
        event_id: 'evt_' + crypto.randomBytes(4).toString('hex'),
        created_at: new Date().toISOString(),
        ...ev,
      };
      rows.push(row);
      return row;
    },
  };
}

// =============================================================================
// 1) VIDEO_CAPTURE_VERSION
// =============================================================================

test('W773 #1 - VIDEO_CAPTURE_VERSION stamped w773-v1', () => {
  freshDir();
  assert.equal(VIDEO_CAPTURE_VERSION, 'w773-v1',
    `expected VIDEO_CAPTURE_VERSION='w773-v1'; got ${JSON.stringify(VIDEO_CAPTURE_VERSION)}`);
});

// =============================================================================
// 2) VIDEO_BAKEOFF_VERSION
// =============================================================================

test('W773 #2 - VIDEO_BAKEOFF_VERSION stamped w773-v1', () => {
  freshDir();
  assert.equal(VIDEO_BAKEOFF_VERSION, 'w773-v1',
    `expected VIDEO_BAKEOFF_VERSION='w773-v1'; got ${JSON.stringify(VIDEO_BAKEOFF_VERSION)}`);
});

// =============================================================================
// 3) FRAME_SAMPLER_VERSION
// =============================================================================

test('W773 #3 - FRAME_SAMPLER_VERSION stamped w773-v1', () => {
  freshDir();
  assert.equal(FRAME_SAMPLER_VERSION, 'w773-v1',
    `expected FRAME_SAMPLER_VERSION='w773-v1'; got ${JSON.stringify(FRAME_SAMPLER_VERSION)}`);
});

// =============================================================================
// 4) SUPPORTED_VIDEO_MIMES frozen + 5 entries
// =============================================================================

test('W773 #4 - SUPPORTED_VIDEO_MIMES Object.freeze()-d + 5 entries', () => {
  freshDir();
  assert.ok(Object.isFrozen(SUPPORTED_VIDEO_MIMES),
    'SUPPORTED_VIDEO_MIMES must be Object.freeze()-d to prevent silent mime drift');
  assert.ok(Array.isArray(SUPPORTED_VIDEO_MIMES));
  assert.equal(SUPPORTED_VIDEO_MIMES.length, 5,
    `expected exactly 5 video mime entries; got ${SUPPORTED_VIDEO_MIMES.length}`);
  // Every entry should start with 'video/' (no leakage of audio/image mimes).
  for (const m of SUPPORTED_VIDEO_MIMES) {
    assert.ok(typeof m === 'string' && m.startsWith('video/'),
      `mime entry must be string video/<subtype>; got ${JSON.stringify(m)}`);
  }
  // mp4 + webm + quicktime should definitely be in there.
  for (const must of ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska']) {
    assert.ok(SUPPORTED_VIDEO_MIMES.includes(must),
      `expected ${must} in SUPPORTED_VIDEO_MIMES`);
  }
});

// =============================================================================
// 5) SAMPLING_STRATEGIES frozen + 4 entries
// =============================================================================

test('W773 #5 - SAMPLING_STRATEGIES Object.freeze()-d + 4 entries', () => {
  freshDir();
  assert.ok(Object.isFrozen(SAMPLING_STRATEGIES),
    'SAMPLING_STRATEGIES must be Object.freeze()-d');
  assert.equal(SAMPLING_STRATEGIES.length, 4,
    `expected exactly 4 sampling strategies; got ${SAMPLING_STRATEGIES.length}`);
  for (const must of ['uniform', 'keyframe', 'scene_change', 'adaptive']) {
    assert.ok(SAMPLING_STRATEGIES.includes(must),
      `expected '${must}' in SAMPLING_STRATEGIES; got ${JSON.stringify(SAMPLING_STRATEGIES)}`);
  }
});

// =============================================================================
// 6) detectVideoCapture handles base64 data:video/mp4
// =============================================================================

test('W773 #6 - detectVideoCapture handles Anthropic-style base64 video block', () => {
  freshDir();
  const message = {
    role: 'user',
    content: [
      { type: 'text', text: 'What happens in this clip?' },
      { type: 'video', source: { type: 'base64', media_type: 'video/mp4',
        data: 'AAAAGGZ0eXBtcDQyAAAAAGlzb21tcDQyAAAA' } },
    ],
  };
  const det = detectVideoCapture(message);
  assert.equal(det.is_video, true, `expected is_video:true; got ${JSON.stringify(det)}`);
  assert.equal(det.total_videos, 1);
  assert.equal(det.video_blocks.length, 1);
  // Also check inline data:video/* in plain string content.
  const m2 = { role: 'user', content: 'see this clip: data:video/webm;base64,AAA=' };
  const d2 = detectVideoCapture(m2);
  assert.equal(d2.is_video, true);
  assert.equal(d2.total_videos, 1);
});

// =============================================================================
// 7) detectVideoCapture handles OpenAI-style video_url block
// =============================================================================

test('W773 #7 - detectVideoCapture handles OpenAI-style video_url block', () => {
  freshDir();
  const message = {
    role: 'user',
    content: [
      { type: 'text', text: 'Summarize the screencast.' },
      { type: 'video_url', video_url: { url: 'https://cdn.example.com/clip.mp4' } },
    ],
  };
  const det = detectVideoCapture(message);
  assert.equal(det.is_video, true);
  assert.equal(det.total_videos, 1);
  assert.equal(det.video_blocks[0].type, 'video_url');

  // Generic block with mime_type and url.
  const m2 = {
    role: 'user',
    content: [{ url: 'https://example.com/clip.webm', mime_type: 'video/webm' }],
  };
  const d2 = detectVideoCapture(m2);
  assert.equal(d2.is_video, true);
});

// =============================================================================
// 8) detectVideoCapture text-only -> is_video:false
// =============================================================================

test('W773 #8 - detectVideoCapture returns is_video:false on text-only message', () => {
  freshDir();
  // Bare string.
  assert.equal(detectVideoCapture({ role: 'user', content: 'hello world' }).is_video, false);
  // Array of text-only blocks.
  const m2 = { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
  assert.equal(detectVideoCapture(m2).is_video, false);
  // No content at all / null / undefined.
  assert.equal(detectVideoCapture({}).is_video, false);
  assert.equal(detectVideoCapture(null).is_video, false);
  assert.equal(detectVideoCapture(undefined).is_video, false);
  // Image-only content MUST NOT trigger is_video.
  const m3 = {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } }],
  };
  assert.equal(detectVideoCapture(m3).is_video, false);
  // Audio-only content MUST NOT trigger is_video.
  const m4 = {
    role: 'user',
    content: [{ type: 'input_audio', input_audio: { format: 'wav', data: 'aaaa' } }],
  };
  assert.equal(detectVideoCapture(m4).is_video, false);
});

// =============================================================================
// 9) normalizeVideoBlock caps byte_count_estimate at 1 GiB (observable)
// =============================================================================

test('W773 #9 - normalizeVideoBlock caps byte_count_estimate at 1 GiB (observable byte_count_capped)', () => {
  freshDir();
  const CAP = 1024 * 1024 * 1024; // 1 GiB
  const r = normalizeVideoBlock({
    type: 'video_url',
    video_url: { url: 'https://cdn.example.com/clip.mp4', byte_count: 5 * CAP },
  });
  assert.equal(r.ok, true);
  assert.equal(r.byte_count_estimate, CAP,
    `byte_count_estimate MUST saturate at CAP (${CAP}); got ${r.byte_count_estimate}`);
  assert.equal(r.byte_count_capped, true,
    'byte_count_capped flag MUST fire when the 1 GiB cap is hit so the clamp is observable');

  // Sub-cap block should NOT be flagged as capped.
  const small = normalizeVideoBlock({
    type: 'video_url',
    video_url: { url: 'https://cdn.example.com/clip.mp4', byte_count: 1024 * 1024 },
  });
  assert.equal(small.ok, true);
  assert.equal(small.byte_count_capped, false);
  assert.ok(small.byte_count_estimate > 0 && small.byte_count_estimate < CAP);
});

// =============================================================================
// 10) normalizeVideoBlock honest envelope on bad block / bad mime
// =============================================================================

test('W773 #10 - normalizeVideoBlock honest envelope on bad block + bad mime', () => {
  freshDir();
  for (const bad of [null, undefined, 'string', 42, true]) {
    const r = normalizeVideoBlock(bad);
    assert.equal(r.ok, false,
      `expected ok:false for ${JSON.stringify(bad)}; got ${JSON.stringify(r)}`);
    assert.ok(typeof r.error === 'string' && r.error.length > 0,
      `expected non-empty error; got ${JSON.stringify(r)}`);
  }
  // Missing url + missing source.data -> honest envelope.
  const r1 = normalizeVideoBlock({ type: 'video' });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'missing_url_or_data');

  // Bad mime - unsupported video MIME.
  const r2 = normalizeVideoBlock({
    type: 'video_url',
    video_url: { url: 'https://example.com/clip.mp4', mime_type: 'audio/wav' },
  });
  assert.equal(r2.ok, false,
    `unsupported MIME MUST return honest envelope; got ${JSON.stringify(r2)}`);
  assert.equal(r2.error, 'unsupported_mime');
  assert.ok(Array.isArray(r2.supported) && r2.supported.length === 5,
    'envelope must carry supported[] for the operator');

  // duration_s_estimate honest null when unknown.
  const r3 = normalizeVideoBlock({
    type: 'video_url',
    video_url: { url: 'https://example.com/clip.mp4' },
  });
  assert.equal(r3.ok, true);
  assert.equal(r3.duration_s_estimate, null,
    'duration_s_estimate must be null when unknown - NEVER fabricated');
});

// =============================================================================
// 11) captureVideoMessage NEVER persists raw video bytes
// =============================================================================

test('W773 #11 - captureVideoMessage NEVER persists raw video bytes', async () => {
  freshDir();
  // Distinctive payload we can scan the persisted row for.
  const SECRET_PAYLOAD = 'AAAAGGZ0eXBtcDQyAAAA-W773-RAW-VIDEO-PAYLOAD-MUST-NEVER-LEAK-XYZ123';
  const fake = fakeEventStore([]);
  const captured = [];
  const r = await captureVideoMessage({
    tenant_id: 't_me',
    namespace: 'prod',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'analyze this video' },
          { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: SECRET_PAYLOAD } },
        ],
      },
    ],
    response: 'detected a snail on a wall',
    opts: {
      appendEventFn: async (partial) => {
        captured.push(partial);
        return { event_id: partial.event_id, ...partial };
      },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.has_video, true);
  assert.equal(r.video_block_count, 1);
  assert.equal(r.raw_video_bytes_persisted, false,
    'envelope MUST stamp raw_video_bytes_persisted:false');
  assert.ok(Array.isArray(r.video_urls_hashed) && r.video_urls_hashed.length === 1,
    'video_urls_hashed must contain one sha256 entry per video block');
  assert.ok(/^[a-f0-9]{64}$/.test(r.video_urls_hashed[0]),
    'video_urls_hashed entry must be a sha256 hex string');

  // The persisted partial MUST NOT contain the secret payload anywhere.
  assert.equal(captured.length, 1, `expected 1 persisted partial; got ${captured.length}`);
  const partial = captured[0];
  assert.equal(partial.tenant_id, 't_me');
  assert.equal(partial.namespace, 'prod');
  assert.equal(partial.media_kind, 'video');
  assert.equal(partial.raw_video_bytes_persisted, false);
  // base64 source -> media_uri is deliberately null (we store the hash, not the URL).
  assert.equal(partial.media_uri, null,
    'PRIVACY P0: base64-source video MUST persist media_uri:null (only the hash)');

  // HONESTY INVARIANT: walk the entire persisted partial as JSON and assert
  // no leakage of the raw bytes. A distinctive prefix and the full payload
  // must both be absent.
  const json = JSON.stringify(partial);
  assert.equal(json.includes(SECRET_PAYLOAD), false,
    'captureVideoMessage MUST NOT persist raw video bytes; the base64 payload leaked into the row');
  assert.equal(json.includes('W773-RAW-VIDEO-PAYLOAD'), false,
    'captureVideoMessage MUST NOT persist any portion of the raw video bytes');
});

// =============================================================================
// 12) buildSamplingSpec uniform / adaptive happy paths emit indices
// =============================================================================

test('W773 #12 - buildSamplingSpec uniform + adaptive happy paths emit indices', () => {
  freshDir();
  const uni = buildSamplingSpec({
    video_duration_s: 60,
    strategy: 'uniform',
    fps_target: 1,
    max_frames: 8,
  });
  assert.equal(uni.ok, true);
  assert.equal(uni.version, 'w773-v1');
  assert.equal(uni.strategy, 'uniform');
  assert.equal(uni.fps_target, 1);
  assert.equal(uni.max_frames, 8);
  assert.equal(uni.duration_s, 60);
  assert.equal(uni.expected_frame_count, 8,
    `uniform 60s @ 1fps cap=8 -> exactly 8 frames; got ${uni.expected_frame_count}`);
  assert.ok(Array.isArray(uni.sampling_indices) && uni.sampling_indices.length === 8,
    'sampling_indices must have exactly expected_frame_count entries');
  // Indices must be monotonically increasing.
  for (let i = 1; i < uni.sampling_indices.length; i++) {
    assert.ok(uni.sampling_indices[i] > uni.sampling_indices[i - 1],
      `sampling_indices must be strictly increasing; got ${JSON.stringify(uni.sampling_indices)}`);
  }
  // Honesty: density multiplier explicit.
  assert.equal(uni.density_mult, 1.0);

  // adaptive densifies by 1.2x.
  const adaptive = buildSamplingSpec({
    video_duration_s: 60,
    strategy: 'adaptive',
    fps_target: 1,
    max_frames: 128, // big enough to not cap
  });
  assert.equal(adaptive.ok, true);
  assert.equal(adaptive.strategy, 'adaptive');
  assert.equal(adaptive.density_mult, 1.2);
  assert.ok(adaptive.expected_frame_count > uni.expected_frame_count,
    `adaptive density (1.2x) MUST exceed uniform when cap permits; got adaptive=${adaptive.expected_frame_count}, uniform=${uni.expected_frame_count}`);
});

// =============================================================================
// 13) buildSamplingSpec honest envelope on bad duration / strategy / fps / max
// =============================================================================

test('W773 #13 - buildSamplingSpec honest envelope on bad duration / strategy / fps / max', () => {
  freshDir();
  // Bad duration.
  for (const bad of [0, -1, NaN, Infinity, 'abc', null, undefined]) {
    const r = buildSamplingSpec({ video_duration_s: bad });
    assert.equal(r.ok, false,
      `bad duration ${JSON.stringify(bad)} MUST return ok:false; got ${JSON.stringify(r)}`);
    assert.equal(r.error, 'bad_duration');
    assert.equal(r.version, 'w773-v1');
  }
  // Bad strategy.
  const r2 = buildSamplingSpec({ video_duration_s: 60, strategy: 'bogus' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'bad_strategy');
  assert.ok(Array.isArray(r2.supported) && r2.supported.length === 4);

  // Bad fps.
  const r3 = buildSamplingSpec({ video_duration_s: 60, strategy: 'uniform', fps_target: -1 });
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'bad_fps_target');

  // Bad max.
  const r4 = buildSamplingSpec({ video_duration_s: 60, strategy: 'uniform', max_frames: 0 });
  assert.equal(r4.ok, false);
  assert.equal(r4.error, 'bad_max_frames');
});

// =============================================================================
// 14) estimateExtractedFrames respects max_frames + HARD_FRAME_CAP
// =============================================================================

test('W773 #14 - estimateExtractedFrames respects max_frames + HARD_FRAME_CAP=1024', () => {
  freshDir();
  // 60s @ 1fps uniform = 60 frames raw.
  assert.equal(estimateExtractedFrames(60, 'uniform', 1, 999), 60);
  // max_frames cap kicks in.
  assert.equal(estimateExtractedFrames(60, 'uniform', 1, 10), 10);
  // HARD_FRAME_CAP = 1024 — a 24-hour clip at fps_target=30 should cap at 1024.
  const big = estimateExtractedFrames(24 * 3600, 'uniform', 30, 10000);
  assert.equal(big, 1024,
    `HARD_FRAME_CAP must clamp at 1024; got ${big}`);
  // Bad inputs -> 0.
  assert.equal(estimateExtractedFrames(0, 'uniform', 1, 10), 0);
  assert.equal(estimateExtractedFrames(60, 'uniform', 0, 10), 0);
  assert.equal(estimateExtractedFrames(-1, 'uniform', 1, 10), 0);
  // Floor of 1 on tiny duration.
  assert.equal(estimateExtractedFrames(0.001, 'uniform', 1, 1000), 1);
});

// =============================================================================
// 15) runVideoBakeoff W411 tenant-fenced
// =============================================================================

test('W773 #15 - runVideoBakeoff W411 tenant-fenced (cross-tenant rows excluded)', async () => {
  freshDir();
  const myRows = [
    { event_id: 'v1', tenant_id: 't_me', namespace: 'prod', media_kind: 'video',
      prompt_head: 'tutorial how to deploy', response_head: 'step by step walkthrough' },
    { event_id: 'v2', tenant_id: 't_me', namespace: 'prod', media_kind: 'video',
      prompt_head: 'analyze surveillance feed', response_head: 'security camera shows nothing' },
  ];
  const otherRows = [
    { event_id: 'v3', tenant_id: 't_other', namespace: 'prod', media_kind: 'video',
      prompt_head: 'leaked tenant video', response_head: 'leaked data' },
    { event_id: 'v4', tenant_id: 't_other', namespace: 'prod', media_kind: 'video',
      prompt_head: 'more leaked video', response_head: 'leaked' },
  ];
  const fake = fakeEventStore(myRows.concat(otherRows));
  const fakeJudge = () => 1.0;
  const fakeRunner = async () => 'matches';
  const r = await runVideoBakeoff({
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
    `expected 2 rows for t_me (cross-tenant rows excluded); got ${r.count_total}`);

  // Inverse: t_other sees its own 2 rows, never the t_me rows.
  const r2 = await runVideoBakeoff({
    tenant_id: 't_other',
    namespace: 'prod',
    opts: { storeMod: fake, judge: fakeJudge, runOnArtifact: fakeRunner },
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.count_total, 2);

  // W411 defense-in-depth: even if listEvents returns a foreign row by
  // accident (simulated schema flip), the per-row filter inside the bakeoff
  // still drops it.
  const leakyStore = {
    async listEvents() {
      return myRows.concat(otherRows);
    },
  };
  const r3 = await runVideoBakeoff({
    tenant_id: 't_me',
    namespace: 'prod',
    opts: { storeMod: leakyStore, judge: fakeJudge, runOnArtifact: fakeRunner },
  });
  assert.equal(r3.ok, true);
  assert.equal(r3.count_total, 2,
    `W411 per-row fence MUST drop foreign rows even when store ignores tenant filter; got ${r3.count_total}`);
});

// =============================================================================
// 16) runVideoBakeoff honest envelope on no video captures
// =============================================================================

test('W773 #16 - runVideoBakeoff honest envelope on no video captures (never silent-pass)', async () => {
  freshDir();
  const fake = fakeEventStore([]);
  const r = await runVideoBakeoff({
    tenant_id: 't_me',
    namespace: 'prod',
    opts: { storeMod: fake },
  });
  assert.equal(r.ok, true);
  assert.equal(r.count_total, 0);
  assert.equal(r.message, 'no_video_captures',
    `expected message:'no_video_captures' when no rows match; got ${JSON.stringify(r)}`);
  assert.equal(r.version, 'w773-v1');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0,
    'envelope must carry a hint string for the operator');

  // Without tenant_id -> tenant_id_required.
  const r2 = await runVideoBakeoff({ opts: { storeMod: fake } });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'tenant_id_required');

  // Store error -> honest envelope, not throw.
  const badStore = {
    async listEvents() { throw new Error('store down'); },
  };
  const r3 = await runVideoBakeoff({
    tenant_id: 't_me',
    opts: { storeMod: badStore },
  });
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'store_read_failed');
});

// =============================================================================
// 17) runVideoBakeoff DI judge seam + by_content_kind breakdown
// =============================================================================

test('W773 #17 - runVideoBakeoff DI judge + by_content_kind breakdown (NEVER hits real API)', async () => {
  freshDir();
  const rows = [
    { event_id: 'v1', tenant_id: 't_me', namespace: 'prod', media_kind: 'video',
      prompt_head: 'tutorial: how to set up the app',
      response_head: 'step by step walkthrough of installation' },
    { event_id: 'v2', tenant_id: 't_me', namespace: 'prod', media_kind: 'video',
      prompt_head: 'surveillance camera-feed analysis',
      response_head: 'security camera shows nothing of note' },
    { event_id: 'v3', tenant_id: 't_me', namespace: 'prod', media_kind: 'video',
      prompt_head: 'random clip',
      response_head: 'some content with no keyword match' },
  ];
  const fake = fakeEventStore(rows);

  // Track DI seam calls so we KNOW we never hit a real teacher.
  const runCalls = [];
  const judgeCalls = [];
  const fakeRunner = async (artifact_path, input) => {
    runCalls.push({ artifact_path, input });
    return 'fake response for ' + input;
  };
  const fakeJudge = (base, candidate) => {
    judgeCalls.push({ base, candidate });
    return 0.75; // every pair scores 0.75 so we can verify averaging
  };

  const r = await runVideoBakeoff({
    tenant_id: 't_me',
    namespace: 'prod',
    artifact_path: 'fake.kolm',
    opts: { storeMod: fake, runOnArtifact: fakeRunner, judge: fakeJudge, judgeKind: 'fake_seam' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.count_total, 3);
  assert.equal(r.count_video_pairs_evaluated, 3);
  assert.ok(Math.abs(r.avg_score - 0.75) < 1e-9,
    `expected avg_score 0.75 across 3 0.75 pairs; got ${r.avg_score}`);
  assert.equal(r.judge_kind, 'fake_seam',
    `expected judge_kind:'fake_seam' when opts.judgeKind wired; got ${r.judge_kind}`);
  assert.equal(runCalls.length, 3, 'runOnArtifact MUST be invoked once per row');
  assert.equal(judgeCalls.length, 3, 'judge MUST be invoked once per row');

  // by_content_kind must ALWAYS carry 5 keys (CONTENT_KIND invariant).
  assert.ok(r.by_content_kind && typeof r.by_content_kind === 'object');
  for (const must of ['tutorial', 'screencast', 'presentation', 'surveillance', 'other']) {
    assert.ok(must in r.by_content_kind,
      `by_content_kind MUST always carry '${must}' key; got ${JSON.stringify(Object.keys(r.by_content_kind))}`);
  }
  // tutorial keyword in row v1 -> tutorial bucket. surveillance keyword in v2 -> surveillance.
  // v3 has no keyword -> other.
  assert.equal(r.by_content_kind.tutorial.count, 1,
    `expected 1 tutorial row (from "tutorial: how to" prompt); got ${r.by_content_kind.tutorial.count}`);
  assert.equal(r.by_content_kind.surveillance.count, 1,
    `expected 1 surveillance row (from "surveillance camera-feed" prompt); got ${r.by_content_kind.surveillance.count}`);
  assert.equal(r.by_content_kind.other.count, 1,
    `expected 1 other row (from "random clip" prompt); got ${r.by_content_kind.other.count}`);

  // Empty kinds report null mean_score, not 0 — distinguishes empty from low-score.
  assert.equal(r.by_content_kind.screencast.count, 0);
  assert.equal(r.by_content_kind.screencast.mean_score, null,
    'empty kinds must report mean_score:null (NEVER 0 - that would imply a measured zero)');
});

// =============================================================================
// 18) POST /v1/video/capture-detect 401 / 200
// =============================================================================

test('W773 #18 - POST /v1/video/capture-detect 401 w/o auth; 200 w/ auth; ok+is_video:false on missing', async () => {
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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/video/capture-detect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: { role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://example.com/clip.mp4' } }] },
      }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth + valid body -> 200, is_video:true.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/video/capture-detect`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: { role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://example.com/clip.mp4' } }] },
      }),
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.is_video, true);
    assert.equal(body.total_videos, 1);
    assert.equal(body.version, 'w773-v1');
    assert.ok(Array.isArray(body.supported_mimes) && body.supported_mimes.length === 5,
      `expected supported_mimes[] with 5 entries; got ${JSON.stringify(body.supported_mimes)}`);
    assert.ok(Array.isArray(body.normalized) && body.normalized.length === 1);

    // Auth + missing message -> 200 ok with is_video:false (the detector is
    // tolerant of empty input - it returns honest "no video" rather than 400).
    const missing = await fetch(`http://127.0.0.1:${port}/v1/video/capture-detect`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 200);
    const missingJson = await missing.json();
    assert.equal(missingJson.ok, true);
    assert.equal(missingJson.is_video, false);
    assert.equal(missingJson.total_videos, 0);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 19) POST /v1/video/bakeoff 401 / 400 confirm / 200 honest empty
// =============================================================================

test('W773 #19 - POST /v1/video/bakeoff 401 w/o auth; 400 confirm_required; honest empty', async () => {
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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/video/bakeoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(noAuth.status, 401);

    // Auth WITHOUT confirm -> 400 confirm_required.
    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/video/bakeoff`, {
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
      `expected error:'confirm_required'; got ${JSON.stringify(noConfirmJson)}`);
    assert.equal(noConfirmJson.version, 'w773-v1');

    // Auth WITH confirm but no captures -> honest no_video_captures envelope (ok:true).
    const empty = await fetch(`http://127.0.0.1:${port}/v1/video/bakeoff`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirm: true, namespace: 'fresh', artifact_path: 'fake.kolm' }),
    });
    assert.equal(empty.status, 200,
      `expected 200 on honest no_video_captures envelope; got ${empty.status}`);
    const emptyJson = await empty.json();
    assert.equal(emptyJson.ok, true);
    assert.equal(emptyJson.message, 'no_video_captures',
      `expected message:'no_video_captures' on empty store; got ${JSON.stringify(emptyJson)}`);
    assert.equal(emptyJson.version, 'w773-v1');
    // The 5-key content-kind map must still be present in the empty envelope.
    assert.ok(emptyJson.by_content_kind && typeof emptyJson.by_content_kind === 'object');
    for (const must of ['tutorial', 'screencast', 'presentation', 'surveillance', 'other']) {
      assert.ok(must in emptyJson.by_content_kind,
        `even on empty envelope by_content_kind MUST carry '${must}'`);
    }
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 20) GET /v1/video/captures 401 / 200
// =============================================================================

test('W773 #20 - GET /v1/video/captures 401 w/o auth; 200 envelope w/ auth', async () => {
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

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/video/captures`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/video/captures?namespace=prod&limit=10`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    // Brand-new store: no captures yet but still an honest envelope.
    assert.equal(typeof body.count, 'number');
    assert.ok(Array.isArray(body.captures));
    assert.equal(body.version, 'w773-v1');
    // tenant_id stamped on the envelope so the operator can verify the fence.
    assert.equal(typeof body.tenant_id, 'string');
    assert.ok(body.tenant_id.length > 0);
    assert.equal(body.namespace, 'prod');
    assert.equal(body.limit, 10);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 21) apps/trainer/video_distill.py exists + parses
// =============================================================================

test('W773 #21 - apps/trainer/video_distill.py exists + parses with ast.parse', (t) => {
  freshDir();
  assert.ok(fs.existsSync(PY_TRAINER), `expected ${PY_TRAINER}`);
  const text = fs.readFileSync(PY_TRAINER, 'utf8');
  assert.ok(text.length > 200, 'video_distill.py should be a real CLI, not a stub');
  // It must declare VIDEO_DISTILL_VERSION = 'w773-v1'.
  assert.ok(/VIDEO_DISTILL_VERSION\s*=\s*['"]w773-v1['"]/.test(text),
    "video_distill.py must declare VIDEO_DISTILL_VERSION = 'w773-v1'");

  // Try ast.parse via python.
  const py = spawnSync('python', ['--version'], { encoding: 'utf8' });
  let pythonBin = py.status === 0 ? 'python' : null;
  if (!pythonBin) {
    const py3 = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    if (py3.status === 0) pythonBin = 'python3';
  }
  if (!pythonBin) {
    t.skip('python not on PATH; skipping ast.parse check');
    return;
  }
  const cmd = spawnSync(pythonBin, ['-c',
    "import ast,sys; src=sys.stdin.read(); ast.parse(src); print('ok')"],
    { input: text, encoding: 'utf8' });
  assert.equal(cmd.status, 0,
    `python ast.parse failed: stdout=${cmd.stdout} stderr=${cmd.stderr}`);
  assert.ok(cmd.stdout.includes('ok'));
});

// =============================================================================
// 22) apps/trainer/video_distill.py --dry-run exits 0 + trainer_not_invoked:true
// =============================================================================

test('W773 #22 - video_distill.py --dry-run exits 0 + trainer_not_invoked:true', (t) => {
  const tmp = freshDir();
  // Skip if no python.
  const py = spawnSync('python', ['--version'], { encoding: 'utf8' });
  let pythonBin = py.status === 0 ? 'python' : null;
  if (!pythonBin) {
    const py3 = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    if (py3.status === 0) pythonBin = 'python3';
  }
  if (!pythonBin) {
    t.skip('python not on PATH; skipping video_distill.py --dry-run');
    return;
  }

  // Write a fixture JSONL with one video_url row + one video_base64 row + one
  // frame_captions row + one text-only row. The text-only row MUST NOT count
  // as a video capture.
  const fixturePath = path.join(tmp, 'fixture.jsonl');
  const outDir = path.join(tmp, 'student-out');
  const lines = [
    JSON.stringify({ video_url: 'https://example.com/clip.mp4', duration_s: 30 }),
    JSON.stringify({ video_base64: 'AAAAGGZ0eXBtcDQy', duration_s: 60 }),
    JSON.stringify({ frame_captions: ['cap1', 'cap2'], duration_s: 90 }),
    JSON.stringify({ messages: [{ role: 'user', content: 'just text - no video' }] }),
  ];
  fs.writeFileSync(fixturePath, lines.join('\n') + '\n', 'utf8');

  const result = spawnSync(pythonBin,
    [PY_TRAINER, '--captures', fixturePath, '--out', outDir, '--dry-run'],
    { encoding: 'utf8' });
  assert.equal(result.status, 0,
    `--dry-run MUST exit 0; got status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
  // The dry-run envelope is emitted as a JSON line on stdout (no file write).
  const stdoutLines = result.stdout.split('\n').filter((line) => line.trim().length > 0);
  assert.ok(stdoutLines.length >= 1,
    `--dry-run MUST emit at least one stdout line; got ${JSON.stringify(stdoutLines)}`);
  let env = null;
  for (const line of stdoutLines) {
    try { env = JSON.parse(line); break; } catch (_) { /* not JSON */ }
  }
  assert.ok(env, `--dry-run MUST emit a JSON envelope on stdout; got ${result.stdout}`);
  assert.equal(env.ok, true);
  assert.equal(env.mode, 'dry_run');
  assert.equal(env.version, 'w773-v1');
  assert.equal(env.trainer_not_invoked, true,
    'dry-run MUST stamp trainer_not_invoked:true');
  // 3 of 4 rows had video (url + base64 + frame_captions).
  assert.equal(env.video_captures_total, 3,
    `expected video_captures_total=3; got ${env.video_captures_total}`);
  assert.ok(env.total_frames_estimated >= 1,
    'total_frames_estimated must be >= 1 (the same math the live run uses)');
  assert.ok(env.hint && env.hint.length > 0,
    'dry-run envelope must carry a hint string for the operator');
});

// =============================================================================
// 23) public/docs/multimodal/video.html exists w/ brand-lock + data-w773
// =============================================================================

test('W773 #23 - public/docs/multimodal/video.html exists w/ brand-lock + data-w773 anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(HTML_PATH), `expected page at ${HTML_PATH}`);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Brand lock.
  assert.ok(html.includes('Open-source AI workbench'),
    'video.html MUST carry the brand-locked eyebrow "Open-source AI workbench"');
  // Required hidden test anchors.
  assert.ok(html.includes('data-w773="mimes"'),
    'expected data-w773="mimes" anchor on the mime grid');
  assert.ok(html.includes('data-w773="strategies"'),
    'expected data-w773="strategies" anchor on the strategies grid');
  assert.ok(html.includes('data-w773="api"'),
    'expected data-w773="api" anchor on the API table');
  assert.ok(html.includes('data-w773="privacy"'),
    'expected data-w773="privacy" anchor on the privacy panel');
  // Version stamp.
  assert.ok(html.includes('w773-v1'),
    'page must stamp the w773-v1 version');
  // Required H1.
  assert.ok(/<h1[^>]*>Video distillation/.test(html),
    'h1 should announce video distillation');
  // No emoji.
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'docs/multimodal/video.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 24) cli/kolm.js defines cmdW773Video exactly once + case 'video' wires it
// =============================================================================

test("W773 #24 - cli/kolm.js defines cmdW773Video exactly once + case 'video' wires it", () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defOccurrences = (cli.match(/async function cmdW773Video\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW773Video must be defined exactly once; found ${defOccurrences}`);
  // case 'video': must invoke cmdW773Video.
  assert.ok(/case 'video':[\s\S]{0,300}cmdW773Video/.test(cli),
    `expected "case 'video': ... cmdW773Video(...)" wiring; not found`);
  // Completion table entries must be present.
  assert.ok(cli.includes("COMPLETION_VERBS.push('video')"),
    'COMPLETION_VERBS must include "video" for shell completion');
  assert.ok(cli.includes("COMPLETION_SUBS.video"),
    'COMPLETION_SUBS.video must list the subcommands');
});

// =============================================================================
// 25) vercel.json /docs/multimodal/video rewrite
// =============================================================================

test('W773 #25 - vercel.json carries /docs/multimodal/video rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  const rw = cfg.rewrites.find((r) =>
    r && r.source === '/docs/multimodal/video' &&
    r.destination === '/docs/multimodal/video.html');
  assert.ok(rw,
    `expected rewrite { source: '/docs/multimodal/video', destination: '/docs/multimodal/video.html' }; ` +
    `not found in ${cfg.rewrites.length} entries`);
});

// =============================================================================
// 26) sw.js cache slug + sibling test family regex+threshold (W604)
// =============================================================================

test('W773 #26 - sw.js cache slug references wave(\\d{3,4}) (W604 regex+threshold)', () => {
  freshDir();
  if (fs.existsSync(SW_PATH)) {
    const sw = fs.readFileSync(SW_PATH, 'utf8');
    const m = sw.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
    if (m) {
      const wm = m[1].match(/wave(\d{3,4})/);
      if (wm) {
        const n = parseInt(wm[1], 10);
        // W604 regex+threshold pattern. Generous floor so a sibling agent
        // shipping after W773 does not break this.
        assert.ok(n >= 100,
          `sw.js CACHE slug should reference a sane waveNNN family token; got ${m[1]}`);
      }
    }
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
// 27) by_content_kind map carries 5 keys always (CONTENT_KIND invariant)
// =============================================================================

test('W773 #27 - by_content_kind map carries 5 keys always (tutorial/screencast/presentation/surveillance/other)', async () => {
  freshDir();
  // Even a single-row bakeoff must produce all 5 buckets.
  const fake = fakeEventStore([
    { event_id: 'v1', tenant_id: 't_me', namespace: 'prod', media_kind: 'video',
      prompt_head: 'random clip', response_head: 'some content' },
  ]);
  const r = await runVideoBakeoff({
    tenant_id: 't_me',
    namespace: 'prod',
    artifact_path: 'fake.kolm',
    opts: {
      storeMod: fake,
      runOnArtifact: async () => 'fake response',
      judge: () => 0.5,
    },
  });
  assert.equal(r.ok, true);
  assert.equal(Object.keys(r.by_content_kind).length, 5,
    `by_content_kind MUST always have exactly 5 keys; got ${Object.keys(r.by_content_kind).length}`);
  for (const k of ['tutorial', 'screencast', 'presentation', 'surveillance', 'other']) {
    const b = r.by_content_kind[k];
    assert.ok(b && typeof b === 'object',
      `by_content_kind.${k} must be an object`);
    assert.ok('count' in b, `by_content_kind.${k} must carry a count`);
    assert.ok('mean_score' in b, `by_content_kind.${k} must carry a mean_score`);
    assert.ok('median_score' in b, `by_content_kind.${k} must carry a median_score`);
  }
});
