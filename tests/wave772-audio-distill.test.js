// W772 - Audio distill module (transcript + intent).
//
// Atomic items pinned (matches the W772 implementation):
//
//   1)  AUDIO_CAPTURE_VERSION === 'w772-v1'
//   2)  AUDIO_BAKEOFF_VERSION === 'w772-v1'
//   3)  SUPPORTED_AUDIO_MIMES Object.freeze()-d + >=7 entries
//   4)  detectAudioCapture handles OpenAI input_audio content blocks
//   5)  detectAudioCapture handles base64 data:audio/wav URL
//   6)  detectAudioCapture detects pre-transcribed whisper_transcript
//   7)  detectAudioCapture returns is_audio:false on text-only message
//   8)  normalizeAudioBlock caps byte_count_estimate at 100MB
//   9)  normalizeAudioBlock honest envelope on bad block
//   10) captureAudioMessage NEVER persists raw audio bytes
//   11) captureAudioMessage stamps transcript_chars correctly
//   12) extractWhisperTranscript returns null when absent (honest)
//   13) runAudioBakeoff W411 tenant-fenced (cross-tenant rows excluded)
//   14) runAudioBakeoff honest envelope on no audio captures
//   15) runAudioBakeoff DI judge seam works (never hits real API)
//   16) POST /v1/audio/capture-detect 401 w/o auth; 200 w/ auth; 400 missing
//   17) POST /v1/audio/bakeoff 401 / 400 confirm_required / 400 honest empty
//   18) GET /v1/audio/captures 401 w/o auth; 200 envelope w/ auth
//   19) apps/trainer/audio_distill.py exists + parses (ast.parse)
//   20) apps/trainer/audio_distill.py --dry-run exits 0 + trainer_not_invoked:true
//   21) public/docs/multimodal/audio.html exists w/ brand-lock + data-w772
//   22) cli/kolm.js defines cmdW772Audio exactly once + case 'audio' wires it
//   23) vercel.json carries /docs/multimodal/audio rewrite
//   24) W604 sibling: sw.js cache slug regex `wave(\d{3,4})` threshold check
//   25) INTENT_KINDS frozen + 5 entries
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
  AUDIO_CAPTURE_VERSION,
  SUPPORTED_AUDIO_MIMES,
  detectAudioCapture,
  normalizeAudioBlock,
  extractWhisperTranscript,
  captureAudioMessage,
} from '../src/audio-capture.js';

import {
  AUDIO_BAKEOFF_VERSION,
  INTENT_KINDS,
  runAudioBakeoff,
} from '../src/audio-bakeoff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(REPO_ROOT, 'public', 'docs', 'multimodal', 'audio.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const PY_TRAINER = path.join(REPO_ROOT, 'apps', 'trainer', 'audio_distill.py');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w772-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// In-memory fake event-store. The W772 runAudioBakeoff consumes
// storeMod.listEvents() directly so the fake matches that shape - NOT the
// W771 fakeStoreMod which exposed all(table) + insertCapture(row).
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
      const row = { event_id: 'evt_' + crypto.randomBytes(4).toString('hex'), created_at: new Date().toISOString(), ...ev };
      rows.push(row);
      return row;
    },
  };
}

// =============================================================================
// 1) AUDIO_CAPTURE_VERSION
// =============================================================================

test('W772 #1 - AUDIO_CAPTURE_VERSION stamped w772-v1', () => {
  freshDir();
  assert.equal(AUDIO_CAPTURE_VERSION, 'w772-v1',
    `expected AUDIO_CAPTURE_VERSION='w772-v1'; got ${JSON.stringify(AUDIO_CAPTURE_VERSION)}`);
});

// =============================================================================
// 2) AUDIO_BAKEOFF_VERSION
// =============================================================================

test('W772 #2 - AUDIO_BAKEOFF_VERSION stamped w772-v1', () => {
  freshDir();
  assert.equal(AUDIO_BAKEOFF_VERSION, 'w772-v1',
    `expected AUDIO_BAKEOFF_VERSION='w772-v1'; got ${JSON.stringify(AUDIO_BAKEOFF_VERSION)}`);
});

// =============================================================================
// 3) SUPPORTED_AUDIO_MIMES frozen + >=7 entries
// =============================================================================

test('W772 #3 - SUPPORTED_AUDIO_MIMES Object.freeze()-d + >=7 entries', () => {
  freshDir();
  assert.ok(Object.isFrozen(SUPPORTED_AUDIO_MIMES),
    'SUPPORTED_AUDIO_MIMES must be Object.freeze()-d to prevent silent mime drift');
  assert.ok(Array.isArray(SUPPORTED_AUDIO_MIMES));
  assert.ok(SUPPORTED_AUDIO_MIMES.length >= 7,
    `expected >=7 audio mime entries; got ${SUPPORTED_AUDIO_MIMES.length}`);
  // Every entry should start with 'audio/' (no leakage of e.g. image mimes).
  for (const m of SUPPORTED_AUDIO_MIMES) {
    assert.ok(typeof m === 'string' && m.startsWith('audio/'),
      `mime entry must be string audio/<subtype>; got ${JSON.stringify(m)}`);
  }
  // wav + mp3 + ogg should definitely be in there.
  for (const must of ['audio/wav', 'audio/mp3', 'audio/ogg']) {
    assert.ok(SUPPORTED_AUDIO_MIMES.includes(must),
      `expected ${must} in SUPPORTED_AUDIO_MIMES`);
  }
});

// =============================================================================
// 4) detectAudioCapture handles OpenAI input_audio
// =============================================================================

test('W772 #4 - detectAudioCapture handles OpenAI input_audio content blocks', () => {
  freshDir();
  const message = {
    role: 'user',
    content: [
      { type: 'text', text: 'what does this clip say?' },
      { type: 'input_audio', input_audio: { format: 'wav', data: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=' } },
    ],
  };
  const det = detectAudioCapture(message);
  assert.equal(det.is_audio, true, `expected is_audio:true; got ${JSON.stringify(det)}`);
  assert.equal(det.total_audio, 1, `expected 1 audio block; got ${det.total_audio}`);
  assert.equal(det.audio_blocks.length, 1);
  assert.equal(det.audio_blocks[0].kind, 'openai_input_audio',
    `expected kind:'openai_input_audio'; got ${det.audio_blocks[0].kind}`);
  assert.equal(det.audio_blocks[0].mime, 'audio/wav');
});

// =============================================================================
// 5) detectAudioCapture handles base64 data:audio/wav URL
// =============================================================================

test('W772 #5 - detectAudioCapture handles base64 data:audio/wav URL', () => {
  freshDir();
  // The OpenAI input_audio shape uses `format:'wav', data:<b64>` so the
  // data URL shape is the alternative we accept on a plain text content
  // block. Both inline shapes must route through detectAudioCapture.
  const dataUrl = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  const message = {
    role: 'user',
    content: [
      { type: 'text', text: dataUrl },
    ],
  };
  const det = detectAudioCapture(message);
  assert.equal(det.is_audio, true);
  assert.equal(det.total_audio, 1);
  assert.equal(det.audio_blocks[0].kind, 'data_url');
  assert.equal(det.audio_blocks[0].mime, 'audio/wav');

  // String-shorthand path: content is a bare string with the data URL.
  const m2 = { role: 'user', content: dataUrl };
  const d2 = detectAudioCapture(m2);
  assert.equal(d2.is_audio, true);
  assert.equal(d2.audio_blocks.length, 1);

  // mp3 also accepted.
  const mp3Url = 'data:audio/mp3;base64,SUQzBAAAAAAA';
  const m3 = { role: 'user', content: mp3Url };
  const d3 = detectAudioCapture(m3);
  assert.equal(d3.is_audio, true);
  assert.equal(d3.audio_blocks[0].mime, 'audio/mp3');
});

// =============================================================================
// 6) detectAudioCapture detects pre-transcribed whisper_transcript
// =============================================================================

test('W772 #6 - detectAudioCapture detects pre-transcribed whisper_transcript', () => {
  freshDir();
  const m1 = {
    role: 'user',
    content: 'hello there',
    whisper_transcript: 'Hello there, what is the weather like today?',
  };
  const det = detectAudioCapture(m1);
  assert.equal(det.is_audio, true,
    `pre-transcribed whisper_transcript field MUST trigger is_audio:true; got ${JSON.stringify(det)}`);
  assert.equal(det.transcript_present, true);
  // No audio block, but is_audio is still true because the transcript
  // implies an upstream audio capture happened.
  assert.equal(det.audio_blocks.length, 0);

  // content[].type === 'transcript' shape.
  const m2 = {
    role: 'user',
    content: [
      { type: 'transcript', text: 'meeting note dictation' },
    ],
  };
  const d2 = detectAudioCapture(m2);
  assert.equal(d2.is_audio, true);
  assert.equal(d2.transcript_present, true);

  // Generic transcript field.
  const m3 = { role: 'user', transcript: 'voice memo' };
  const d3 = detectAudioCapture(m3);
  assert.equal(d3.is_audio, true);
  assert.equal(d3.transcript_present, true);
});

// =============================================================================
// 7) detectAudioCapture returns is_audio:false on text-only
// =============================================================================

test('W772 #7 - detectAudioCapture returns is_audio:false on text-only message', () => {
  freshDir();
  // String content (the common OpenAI shape).
  const m1 = { role: 'user', content: 'hello world' };
  assert.equal(detectAudioCapture(m1).is_audio, false);

  // Array content with only text blocks.
  const m2 = {
    role: 'user',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ],
  };
  assert.equal(detectAudioCapture(m2).is_audio, false);

  // No content field at all.
  assert.equal(detectAudioCapture({ role: 'system' }).is_audio, false);
  assert.equal(detectAudioCapture({}).is_audio, false);
  // null / undefined.
  assert.equal(detectAudioCapture(null).is_audio, false);
  assert.equal(detectAudioCapture(undefined).is_audio, false);

  // Image-only content (no audio) MUST NOT trigger is_audio.
  const m3 = {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } },
    ],
  };
  assert.equal(detectAudioCapture(m3).is_audio, false);

  // Empty string whisper_transcript MUST NOT trigger transcript_present.
  const m4 = { role: 'user', whisper_transcript: '   ' };
  const d4 = detectAudioCapture(m4);
  assert.equal(d4.is_audio, false);
  assert.equal(d4.transcript_present, false);
});

// =============================================================================
// 8) normalizeAudioBlock caps byte_count_estimate at 100MB
// =============================================================================

test('W772 #8 - normalizeAudioBlock caps byte_count_estimate at 100MB', () => {
  freshDir();
  // 100 MiB cap on the byte_count_estimate. The base64 expands 4 chars ->
  // 3 bytes so a 200 MiB b64 string decodes to ~150 MiB raw, well above
  // the cap.
  const CAP = 100 * 1024 * 1024;
  const giant = 'a'.repeat(160 * 1024 * 1024);
  const norm = normalizeAudioBlock({
    kind: 'openai_input_audio',
    mime: 'audio/wav',
    base64: giant,
    format: 'wav',
  });
  assert.equal(norm.byte_count_estimate, CAP,
    `byte_count_estimate MUST saturate at CAP (${CAP}); got ${norm.byte_count_estimate}`);
  assert.equal(norm.truncated_estimate, true,
    'truncated_estimate flag MUST fire when the cap is hit');

  // Sub-cap block should NOT be truncated.
  const small = normalizeAudioBlock({
    mime: 'audio/wav',
    base64: 'a'.repeat(1024),
  });
  assert.equal(small.truncated_estimate, false);
  assert.ok(small.byte_count_estimate > 0 && small.byte_count_estimate < CAP);
});

// =============================================================================
// 9) normalizeAudioBlock honest envelope on bad block
// =============================================================================

test('W772 #9 - normalizeAudioBlock honest envelope on bad block', () => {
  freshDir();
  for (const bad of [null, undefined, 'string', 42, true]) {
    const r = normalizeAudioBlock(bad);
    assert.equal(r.ok, false,
      `expected ok:false for ${JSON.stringify(bad)}; got ${JSON.stringify(r)}`);
    assert.equal(r.error, 'invalid_audio_block');
    assert.ok(typeof r.hint === 'string' && r.hint.length > 0,
      `expected non-empty hint; got ${JSON.stringify(r)}`);
  }
  // Bad mime.
  const r2 = normalizeAudioBlock({ mime: 'image/png', base64: 'aaaa' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'invalid_audio_block');

  // Unknown mime.
  const r3 = normalizeAudioBlock({ mime: 'audio/very-weird-format', base64: 'aaaa' });
  assert.equal(r3.ok, false);

  // No mime at all.
  const r4 = normalizeAudioBlock({ base64: 'aaaa' });
  assert.equal(r4.ok, false);
});

// =============================================================================
// 10) captureAudioMessage NEVER persists raw audio bytes
// =============================================================================

test('W772 #10 - captureAudioMessage NEVER persists raw audio bytes (only URL hash + transcript)', async () => {
  freshDir();
  // Use a clearly identifiable raw payload so we can scan the persisted
  // row for accidental leakage.
  const SECRET_PAYLOAD = 'UklGRDDDDDDD-W772-RAW-AUDIO-PAYLOAD-MUST-NEVER-LEAK-EEEEEEE=';
  const fake = fakeEventStore([]);
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'transcribe this' },
        { type: 'input_audio', input_audio: { format: 'wav', data: SECRET_PAYLOAD } },
      ],
    },
  ];
  const r = await captureAudioMessage({
    tenant_id: 't_me',
    namespace: 'prod',
    messages,
    response: { text: 'transcribed audio response' },
    opts: { eventStore: fake },
  });
  assert.equal(r.ok, true);
  assert.equal(r.has_audio, true);
  assert.equal(r.audio_block_count, 1);
  assert.ok(Array.isArray(r.audio_urls_hashed) && r.audio_urls_hashed.length === 1,
    'audio_urls_hashed must contain exactly one sha256 entry for the input_audio block');
  assert.ok(/^[a-f0-9]{64}$/.test(r.audio_urls_hashed[0]),
    'audio_urls_hashed entry must be a sha256 hex string');

  // The persisted row MUST stamp has_audio + audio_block_count.
  assert.equal(fake.rows.length, 1, `expected 1 persisted row; got ${fake.rows.length}`);
  const row = fake.rows[0];
  assert.equal(row.tenant_id, 't_me');
  assert.equal(row.namespace, 'prod');
  assert.equal(row.media_kind, 'audio');
  assert.equal(row.media_uri, null,
    'PRIVACY P0: media_uri must be null (we hash the URL into media_hash instead)');
  assert.equal(row.audio_block_count, 1);

  // HONESTY INVARIANT: the SECRET_PAYLOAD must NOT appear anywhere in the
  // persisted row. Walk the entire row JSON and assert no leakage.
  const rowJson = JSON.stringify(row);
  assert.equal(rowJson.includes(SECRET_PAYLOAD), false,
    'captureAudioMessage MUST NOT persist raw audio bytes; the base64 payload leaked into the row');
  // The payload's distinctive prefix must also not appear (defense-in-depth).
  assert.equal(rowJson.includes('UklGRDDDDDDD-W772-RAW-AUDIO-PAYLOAD'), false,
    'captureAudioMessage MUST NOT persist any portion of the raw audio bytes');
});

// =============================================================================
// 11) captureAudioMessage stamps transcript_chars correctly
// =============================================================================

test('W772 #11 - captureAudioMessage stamps transcript_chars correctly', async () => {
  freshDir();
  const fake = fakeEventStore([]);
  const transcript = 'Hello, this is a transcribed audio message of moderate length.';
  const r = await captureAudioMessage({
    tenant_id: 't_me',
    namespace: 'prod',
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { format: 'wav', data: 'aaaa' } }],
        whisper_transcript: transcript,
      },
    ],
    response: 'ok',
    opts: { eventStore: fake },
  });
  assert.equal(r.ok, true);
  assert.equal(r.transcript_present, true);
  assert.equal(r.transcript_chars, transcript.length,
    `transcript_chars must equal transcript.length (${transcript.length}); got ${r.transcript_chars}`);

  // The persisted row carries the same count.
  assert.equal(fake.rows[0].transcript_chars, transcript.length);
  assert.equal(fake.rows[0].transcript_present, true);
  // The transcript head should be present (first 400 chars).
  assert.equal(typeof fake.rows[0].prompt_head, 'string');
  assert.ok(fake.rows[0].prompt_head.length > 0);

  // No audio + no transcript: has_audio:false, row_id:null, NEVER persisted.
  const fake2 = fakeEventStore([]);
  const r2 = await captureAudioMessage({
    tenant_id: 't_me',
    namespace: 'prod',
    messages: [{ role: 'user', content: 'just text' }],
    response: 'ok',
    opts: { eventStore: fake2 },
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.has_audio, false);
  assert.equal(r2.row_id, null);
  assert.equal(r2.transcript_chars, 0);
  assert.equal(fake2.rows.length, 0, 'text-only message MUST NOT create an audio observation row');
});

// =============================================================================
// 12) extractWhisperTranscript returns null when absent (honest)
// =============================================================================

test('W772 #12 - extractWhisperTranscript returns null when absent (no fabrication)', () => {
  freshDir();
  // No transcript fields at all.
  assert.equal(extractWhisperTranscript({}), null);
  assert.equal(extractWhisperTranscript({ role: 'user' }), null);
  assert.equal(extractWhisperTranscript({ role: 'user', content: 'hello' }), null);
  assert.equal(extractWhisperTranscript(null), null);
  assert.equal(extractWhisperTranscript(undefined), null);

  // Empty / whitespace-only transcript -> null (honest, not '').
  assert.equal(extractWhisperTranscript({ whisper_transcript: '' }), null);
  assert.equal(extractWhisperTranscript({ whisper_transcript: '   ' }), null);
  assert.equal(extractWhisperTranscript({ transcript: '' }), null);

  // Real transcript -> string returned.
  assert.equal(extractWhisperTranscript({ whisper_transcript: 'real transcript' }), 'real transcript');
  assert.equal(extractWhisperTranscript({ transcript: 'fallback transcript' }), 'fallback transcript');

  // Priority: whisper_transcript wins over transcript wins over content blocks.
  const m = {
    whisper_transcript: 'A',
    transcript: 'B',
    content: [{ type: 'transcript', text: 'C' }],
  };
  assert.equal(extractWhisperTranscript(m), 'A');
});

// =============================================================================
// 13) runAudioBakeoff W411 tenant-fenced
// =============================================================================

test('W772 #13 - runAudioBakeoff W411 tenant-fenced (cross-tenant rows excluded)', async () => {
  freshDir();
  const myRows = [
    {
      event_id: 'a1', tenant_id: 't_me', namespace: 'prod', media_kind: 'audio',
      prompt_head: 'what is the weather today?',
      response_head: 'sunny and warm',
    },
    {
      event_id: 'a2', tenant_id: 't_me', namespace: 'prod', media_kind: 'audio',
      prompt_head: 'open the door',
      response_head: 'door opened',
    },
  ];
  const otherRows = [
    {
      event_id: 'a3', tenant_id: 't_other', namespace: 'prod', media_kind: 'audio',
      prompt_head: 'leaked tenant audio',
      response_head: 'leaked data',
    },
    {
      event_id: 'a4', tenant_id: 't_other', namespace: 'prod', media_kind: 'audio',
      prompt_head: 'more leaked audio',
      response_head: 'leaked',
    },
  ];
  const fake = fakeEventStore(myRows.concat(otherRows));
  const fakeJudge = () => 1.0;
  const fakeRunner = async () => 'matches';
  const r = await runAudioBakeoff({
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
  assert.equal(r.count_audio_pairs_evaluated, 2);

  // Inverse: t_other sees its own 2 rows, never the t_me rows.
  const r2 = await runAudioBakeoff({
    tenant_id: 't_other',
    namespace: 'prod',
    opts: { storeMod: fake, judge: fakeJudge },
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.count_total, 2);

  // W411 defense-in-depth: even if listEvents returns a foreign row by
  // accident (simulated schema flip), the per-row filter inside the
  // bakeoff still drops it. We model this by handing back a store that
  // ignores the tenant_id query filter.
  const leakyStore = {
    async listEvents() {
      return myRows.concat(otherRows);
    },
  };
  const r3 = await runAudioBakeoff({
    tenant_id: 't_me',
    namespace: 'prod',
    opts: { storeMod: leakyStore, judge: fakeJudge },
  });
  assert.equal(r3.ok, true);
  assert.equal(r3.count_total, 2,
    `W411 per-row fence MUST drop foreign rows even when store ignores tenant filter; got ${r3.count_total}`);
});

// =============================================================================
// 14) runAudioBakeoff honest envelope on no audio captures
// =============================================================================

test('W772 #14 - runAudioBakeoff honest envelope on no audio captures (never silent-pass)', async () => {
  freshDir();
  const fake = fakeEventStore([]);
  const r = await runAudioBakeoff({
    tenant_id: 't_me',
    namespace: 'prod',
    opts: { storeMod: fake },
  });
  assert.equal(r.ok, true);
  assert.equal(r.count_total, 0);
  assert.equal(r.message, 'no_audio_captures',
    `expected message:'no_audio_captures' when no rows match; got ${JSON.stringify(r)}`);
  assert.equal(r.version, 'w772-v1');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0,
    'envelope must carry a hint string for the operator');

  // Without tenant_id -> tenant_id_required.
  const r2 = await runAudioBakeoff({ opts: { storeMod: fake } });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'tenant_id_required');

  // Store error -> honest envelope, not throw.
  const badStore = {
    async listEvents() { throw new Error('store down'); },
  };
  const r3 = await runAudioBakeoff({
    tenant_id: 't_me',
    opts: { storeMod: badStore },
  });
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'event_store_unavailable');
});

// =============================================================================
// 15) runAudioBakeoff DI judge seam works (never hits real API)
// =============================================================================

test('W772 #15 - runAudioBakeoff DI judge + runOnArtifact seams work (never hits real API)', async () => {
  freshDir();
  const rows = [
    { event_id: 'r1', tenant_id: 't_me', namespace: 'prod', media_kind: 'audio',
      prompt_head: 'what is the weather?', response_head: 'sunny' },
    { event_id: 'r2', tenant_id: 't_me', namespace: 'prod', media_kind: 'audio',
      prompt_head: 'open the door', response_head: 'door opened' },
  ];
  const fake = fakeEventStore(rows);

  // Track runOnArtifact + judge calls.
  const runOnArtifactCalls = [];
  const judgeCalls = [];
  const fakeRunner = async (artifact_path, transcript, ctx) => {
    runOnArtifactCalls.push({ artifact_path, transcript, ctx });
    // r1 transcript starts with 'what' -> return matching text; r2 -> mismatch
    return transcript.startsWith('what') ? 'sunny' : 'wrong';
  };
  const fakeJudge = ({ transcript, candidate, base }) => {
    judgeCalls.push({ transcript, candidate, base });
    return base === candidate ? 1.0 : 0.0;
  };

  const r = await runAudioBakeoff({
    tenant_id: 't_me',
    artifact_path: 'fake.kolm',
    opts: {
      storeMod: fake,
      runOnArtifact: fakeRunner,
      judge: fakeJudge,
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.judge_kind, 'di_judge',
    `expected judge_kind:'di_judge' when opts.judge is wired; got ${r.judge_kind}`);
  assert.equal(runOnArtifactCalls.length, 2,
    `runOnArtifact MUST be invoked once per row; got ${runOnArtifactCalls.length}`);
  assert.equal(judgeCalls.length, 2,
    `judge MUST be invoked once per row; got ${judgeCalls.length}`);
  // r1 matches (1.0), r2 mismatches (0.0) -> avg 0.5.
  assert.ok(Math.abs(r.avg_score - 0.5) < 1e-9,
    `expected avg_score 0.5; got ${r.avg_score}`);

  // Intent buckets non-empty.
  assert.ok(r.by_intent_kind && typeof r.by_intent_kind === 'object');
  for (const k of INTENT_KINDS) {
    assert.ok(k in r.by_intent_kind,
      `by_intent_kind must contain a slot for every INTENT_KIND ('${k}'); got ${JSON.stringify(r.by_intent_kind)}`);
  }
  // 'what is the weather?' ends with '?' -> question. 'open the door' starts
  // with 'open' -> command. So both intent slots should be at 1.
  assert.equal(r.by_intent_kind.question, 1,
    `expected 1 question intent; got ${r.by_intent_kind.question}`);
  assert.equal(r.by_intent_kind.command, 1,
    `expected 1 command intent; got ${r.by_intent_kind.command}`);

  // Without judge: judge_kind drops to 'transcript_jaccard' (the heuristic).
  const r2 = await runAudioBakeoff({
    tenant_id: 't_me',
    artifact_path: 'fake.kolm',
    opts: { storeMod: fake, runOnArtifact: fakeRunner },
  });
  assert.equal(r2.judge_kind, 'transcript_jaccard');

  // transcript_coverage_pct = (rows with non-empty transcript / total) * 100.
  // Both rows have a prompt_head, so coverage should be 100.
  assert.equal(r.transcript_coverage_pct, 100,
    `expected 100 coverage when every row has a transcript; got ${r.transcript_coverage_pct}`);
});

// =============================================================================
// 16) POST /v1/audio/capture-detect 401 / 400 / 200
// =============================================================================

test('W772 #16 - POST /v1/audio/capture-detect 401 w/o auth; 200 w/ auth; 400 on missing', async () => {
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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/audio/capture-detect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: { role: 'user', content: [{ type: 'input_audio', input_audio: { format: 'wav', data: 'aaaa' } }] },
      }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth + valid body -> 200.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/audio/capture-detect`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: { role: 'user', content: [{ type: 'input_audio', input_audio: { format: 'wav', data: 'aaaa' } }] },
      }),
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.is_audio, true);
    assert.equal(body.total_audio, 1);
    assert.equal(body.version, 'w772-v1');

    // Auth + missing message -> 400.
    const bad = await fetch(`http://127.0.0.1:${port}/v1/audio/capture-detect`, {
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
// 17) POST /v1/audio/bakeoff 401 / 400 confirm_required / 200
// =============================================================================

test('W772 #17 - POST /v1/audio/bakeoff 401 w/o auth; 400 confirm_required; honest envelope on empty', async () => {
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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/audio/bakeoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(noAuth.status, 401);

    // Auth WITHOUT confirm -> 400 confirm_required.
    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/audio/bakeoff`, {
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

    // Auth WITH confirm but no captures -> honest no_audio_captures envelope.
    // Our route still returns 200 because runAudioBakeoff returns ok:true with
    // message:'no_audio_captures' (an honest empty-state, not an error).
    const empty = await fetch(`http://127.0.0.1:${port}/v1/audio/bakeoff`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirm: true, namespace: 'fresh', artifact_path: 'fake.kolm' }),
    });
    assert.equal(empty.status, 200,
      `expected 200 on honest no_audio_captures envelope; got ${empty.status}`);
    const emptyJson = await empty.json();
    assert.equal(emptyJson.ok, true);
    assert.equal(emptyJson.message, 'no_audio_captures',
      `expected message:'no_audio_captures' on empty store; got ${JSON.stringify(emptyJson)}`);
    assert.equal(emptyJson.version, 'w772-v1');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 18) GET /v1/audio/captures 401 / 200
// =============================================================================

test('W772 #18 - GET /v1/audio/captures 401 w/o auth; 200 envelope w/ auth', async () => {
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

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/audio/captures`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/audio/captures?namespace=prod&limit=10`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    // Brand-new store: no captures yet but still an honest envelope.
    assert.equal(typeof body.count, 'number');
    assert.ok(Array.isArray(body.captures));
    assert.equal(body.version, 'w772-v1');
    // tenant_id stamped on the envelope so the operator can verify the fence.
    assert.equal(typeof body.tenant_id, 'string');
    assert.ok(body.tenant_id.length > 0);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 19) apps/trainer/audio_distill.py exists + parses
// =============================================================================

test('W772 #19 - apps/trainer/audio_distill.py exists + parses with ast.parse', (t) => {
  freshDir();
  assert.ok(fs.existsSync(PY_TRAINER), `expected ${PY_TRAINER}`);
  const text = fs.readFileSync(PY_TRAINER, 'utf8');
  assert.ok(text.length > 200, 'audio_distill.py should be a real CLI, not a stub');
  // It must declare VERSION = 'w772-v1'.
  assert.ok(/VERSION\s*=\s*['"]w772-v1['"]/.test(text),
    "audio_distill.py must declare VERSION = 'w772-v1'");

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
// 20) apps/trainer/audio_distill.py --dry-run exits 0 + trainer_not_invoked:true
// =============================================================================

test('W772 #20 - audio_distill.py --dry-run exits 0 + trainer_not_invoked:true', (t) => {
  const tmp = freshDir();
  // Skip if no python.
  const py = spawnSync('python', ['--version'], { encoding: 'utf8' });
  let pythonBin = py.status === 0 ? 'python' : null;
  if (!pythonBin) {
    const py3 = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    if (py3.status === 0) pythonBin = 'python3';
  }
  if (!pythonBin) {
    t.skip('python not on PATH; skipping audio_distill.py --dry-run');
    return;
  }

  // Write a fixture JSONL with one whisper_transcript row + one audio_url row +
  // one audio_base64 row + one text-only row (the text-only row MUST NOT be
  // counted as an audio capture).
  const fixturePath = path.join(tmp, 'fixture.jsonl');
  const outPath = path.join(tmp, 'run-meta.json');
  const lines = [
    JSON.stringify({ whisper_transcript: 'hello world' }),
    JSON.stringify({ audio_url: 'https://example.com/x.wav' }),
    JSON.stringify({ audio_base64: 'UklGRiQAAA==' }),
    JSON.stringify({ messages: [{ role: 'user', content: 'just text - no audio' }] }),
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
  assert.equal(meta.version, 'w772-v1');
  assert.equal(meta.trainer_not_invoked, true,
    'dry-run MUST stamp trainer_not_invoked:true');
  // 3 of 4 rows had audio (transcript + url + base64).
  assert.equal(meta.audio_captures_total, 3,
    `expected audio_captures_total=3; got ${meta.audio_captures_total}`);
  assert.equal(meta.captures_with_transcript, 1,
    `expected captures_with_transcript=1; got ${meta.captures_with_transcript}`);
  assert.equal(meta.captures_with_audio_url, 1,
    `expected captures_with_audio_url=1; got ${meta.captures_with_audio_url}`);
  assert.equal(meta.captures_with_base64, 1,
    `expected captures_with_base64=1; got ${meta.captures_with_base64}`);
  assert.ok(meta.hint && meta.hint.length > 0,
    'dry-run envelope must carry a hint string for the operator');
});

// =============================================================================
// 21) public/docs/multimodal/audio.html exists w/ brand-lock + data-w772
// =============================================================================

test('W772 #21 - public/docs/multimodal/audio.html exists w/ brand-lock + data-w772 anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(HTML_PATH), `expected page at ${HTML_PATH}`);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Brand lock.
  assert.ok(html.includes('Open-source AI workbench'),
    'audio.html MUST carry the brand-locked eyebrow "Open-source AI workbench"');
  // Required hidden test anchors.
  assert.ok(html.includes('data-w772="mimes"'),
    'expected data-w772="mimes" anchor on the mime grid');
  assert.ok(html.includes('data-w772="capture-pattern"'),
    'expected data-w772="capture-pattern" anchor on the capture panel');
  assert.ok(html.includes('data-w772="api"'),
    'expected data-w772="api" anchor on the API table');
  // Version stamp.
  assert.ok(html.includes('w772-v1'),
    'page must stamp the w772-v1 version');
  // Required H1.
  assert.ok(/<h1[^>]*>Audio distillation/.test(html),
    'h1 should announce audio distillation');
  // No emoji.
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'docs/multimodal/audio.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 22) cli/kolm.js defines cmdW772Audio exactly once + case 'audio' wires it
// =============================================================================

test("W772 #22 - cli/kolm.js defines cmdW772Audio exactly once + case 'audio' wires it", () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defOccurrences = (cli.match(/async function cmdW772Audio\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW772Audio must be defined exactly once; found ${defOccurrences}`);
  // case 'audio': must invoke cmdW772Audio.
  assert.ok(/case 'audio':[\s\S]{0,300}cmdW772Audio/.test(cli),
    `expected "case 'audio': ... cmdW772Audio(...)" wiring; not found`);
  // Completion table entries must be present.
  assert.ok(cli.includes("COMPLETION_VERBS.push('audio')"),
    'COMPLETION_VERBS must include "audio" for shell completion');
  assert.ok(cli.includes("COMPLETION_SUBS.audio"),
    'COMPLETION_SUBS.audio must list the subcommands');
});

// =============================================================================
// 23) vercel.json /docs/multimodal/audio rewrite
// =============================================================================

test('W772 #23 - vercel.json carries /docs/multimodal/audio rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  const rw = cfg.rewrites.find((r) =>
    r && r.source === '/docs/multimodal/audio' &&
    r.destination === '/docs/multimodal/audio.html');
  assert.ok(rw,
    `expected rewrite { source: '/docs/multimodal/audio', destination: '/docs/multimodal/audio.html' }; ` +
    `not found in ${cfg.rewrites.length} entries`);
});

// =============================================================================
// 24) sw.js cache slug + sibling test family regex+threshold (W604)
// =============================================================================

test('W772 #24 - sw.js cache slug references wave(\\d{3,4}) (W604 regex+threshold)', () => {
  freshDir();
  if (!fs.existsSync(SW_PATH)) {
    return;
  }
  const sw = fs.readFileSync(SW_PATH, 'utf8');
  const m = sw.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
  if (m) {
    const wm = m[1].match(/wave(\d{3,4})/);
    if (wm) {
      const n = parseInt(wm[1], 10);
      // W604 regex+threshold pattern. Generous floor so a sibling agent
      // shipping after W772 does not break this.
      assert.ok(n >= 100,
        `sw.js CACHE slug should reference a sane waveNNN family token; got ${m[1]}`);
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
// 25) INTENT_KINDS frozen + 5 entries
// =============================================================================

test('W772 #25 - INTENT_KINDS frozen + 5 entries', () => {
  freshDir();
  assert.ok(Object.isFrozen(INTENT_KINDS),
    'INTENT_KINDS must be Object.freeze()-d');
  assert.equal(INTENT_KINDS.length, 5,
    `expected 5 intent kinds; got ${INTENT_KINDS.length}`);
  for (const must of ['question', 'command', 'conversation', 'dictation', 'other']) {
    assert.ok(INTENT_KINDS.includes(must),
      `expected '${must}' in INTENT_KINDS; got ${JSON.stringify(INTENT_KINDS)}`);
  }
});
