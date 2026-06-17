import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  AUDIO_CAPTURE_VERSION,
  detectAudioCapture,
  normalizeAudioBlock,
  captureAudioMessage,
} from '../src/audio-capture.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SAMPLE_B64 = Buffer.from('voice sample bytes').toString('base64');
const SIGNED_URL = 'https://cdn.example.invalid/audio.wav?token=secret-token-123';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function audioMessage() {
  return {
    role: 'user',
    whisper_transcript: 'Please summarize this support call.',
    content: [
      {
        type: 'input_audio',
        input_audio: {
          format: 'wav',
          data: SAMPLE_B64,
        },
      },
      {
        type: 'audio',
        source: {
          type: 'url',
          media_type: 'audio/wav',
          url: SIGNED_URL,
        },
      },
    ],
  };
}

test('W682 audio capture source pins redaction and persistence hardening controls', () => {
  const source = read('src/audio-capture.js');
  assert.match(source, /detectAudioCapture\(message, opts = \{\}\)/);
  assert.match(source, /const includeRaw = Boolean\(opts && opts\.includeRaw === true\)/);
  assert.match(source, /const MAX_AUDIO_BLOCKS = 64/);
  assert.match(source, /const MAX_AUDIO_MESSAGES = 64/);
  assert.match(source, /const MAX_NAMESPACE_CHARS = 256/);
  assert.match(source, /_base64Block/);
  assert.match(source, /_dataUrlBlock/);
  assert.match(source, /_urlBlock/);
  assert.match(source, /audio_sha256/);
  assert.match(source, /url_sha256/);
  assert.match(source, /event_store_not_wired/);
  assert.match(source, /messages_truncated/);
  assert.match(source, /audio_blocks_truncated/);

  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['verify:audio-capture'], 'node --test --test-concurrency=1 tests/wave682-audio-capture-contract.test.js');
  assert.match(pkg.scripts['verify:depth'], /verify:distill-bon && npm run verify:audio-capture && npm run verify:audio-bakeoff/);
});

test('W682 detector redacts raw inline audio and signed URLs by default', () => {
  const detected = detectAudioCapture(audioMessage());
  assert.equal(detected.ok, undefined);
  assert.equal(detected.is_audio, true);
  assert.equal(detected.total_audio, 2);
  assert.equal(detected.transcript_present, true);

  const inline = detected.audio_blocks.find((b) => b.kind === 'openai_input_audio');
  assert.ok(inline);
  assert.equal(inline.mime, 'audio/wav');
  assert.equal(inline.base64, undefined);
  assert.equal(inline.base64_chars, SAMPLE_B64.length);
  assert.match(inline.audio_sha256, /^[a-f0-9]{64}$/);
  assert.equal(normalizeAudioBlock(inline).source, 'base64');
  assert.ok(normalizeAudioBlock(inline).byte_count_estimate > 0);

  const url = detected.audio_blocks.find((b) => b.kind === 'anthropic_audio_url');
  assert.ok(url);
  assert.equal(url.url, undefined);
  assert.equal(url.url_host, 'cdn.example.invalid');
  assert.match(url.url_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(detected), /secret-token-123/);

  const raw = detectAudioCapture(audioMessage(), { includeRaw: true });
  assert.equal(raw.audio_blocks[0].base64, SAMPLE_B64);
  assert.equal(raw.audio_blocks[1].url, SIGNED_URL);
});

test('W682 capture persists only tenant-fenced hashes and privacy-safe metadata', async () => {
  const appended = [];
  const eventStore = {
    async appendEvent(ev) {
      appended.push(ev);
      return { event_id: 'evt_audio_1' };
    },
  };

  const result = await captureAudioMessage({
    tenant_id: ' tenant-a ',
    namespace: ' voice-support ',
    messages: [audioMessage()],
    response: {
      choices: [{ message: { content: 'Summary response from teacher.' } }],
    },
    opts: { eventStore },
  });

  assert.equal(result.ok, true);
  assert.equal(result.version, AUDIO_CAPTURE_VERSION);
  assert.equal(result.row_id, 'evt_audio_1');
  assert.equal(result.audio_block_count, 2);
  assert.equal(result.transcript_present, true);
  assert.deepEqual(result.audio_urls_hashed.map((h) => /^[a-f0-9]{64}$/.test(h)), [true, true]);
  assert.equal(appended.length, 1);

  const row = appended[0];
  assert.equal(row.tenant_id, 'tenant-a');
  assert.equal(row.namespace, 'voice-support');
  assert.equal(row.media_kind, 'audio');
  assert.equal(row.media_uri, null);
  assert.match(row.media_hash, /^[a-f0-9]{64}$/);
  assert.equal(row.prompt_head, 'Please summarize this support call.');
  assert.equal(row.response_head, 'Summary response from teacher.');
  assert.equal(row.audio_capture_version, AUDIO_CAPTURE_VERSION);
  assert.equal(row.messages_truncated, false);
  assert.equal(row.audio_blocks_truncated, false);

  const persisted = JSON.stringify(row);
  assert.doesNotMatch(persisted, new RegExp(SAMPLE_B64));
  assert.doesNotMatch(persisted, /secret-token-123/);
  assert.doesNotMatch(persisted, /input_audio/);
});

test('W682 capture fails honestly on invalid namespace or missing event store', async () => {
  const invalid = await captureAudioMessage({
    tenant_id: 'tenant-a',
    namespace: 'bad\nnamespace',
    messages: [audioMessage()],
    opts: {
      eventStore: {
        async appendEvent() {
          throw new Error('must not be called');
        },
      },
    },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'invalid_namespace');

  const notWired = await captureAudioMessage({
    tenant_id: 'tenant-a',
    messages: [audioMessage()],
    opts: { eventStore: {} },
  });
  assert.equal(notWired.ok, false);
  assert.equal(notWired.persist_error, 'event_store_not_wired');
  assert.equal(notWired.has_audio, true);
});

test('W682 capture caps messages and audio blocks without raw-byte leakage', async () => {
  const messages = Array.from({ length: 70 }, (_, i) => ({
    role: 'user',
    whisper_transcript: `clip ${i}`,
    content: [
      {
        type: 'input_audio',
        input_audio: {
          format: 'wav',
          data: Buffer.from(`clip-${i}`).toString('base64'),
        },
      },
    ],
  }));
  let row = null;
  const result = await captureAudioMessage({
    tenant_id: 'tenant-a',
    messages,
    opts: {
      eventStore: {
        async appendEvent(ev) {
          row = ev;
          return { event_id: 'evt_many_audio' };
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.audio_block_count, 64);
  assert.equal(result.messages_truncated, true);
  assert.equal(result.audio_blocks_truncated, true);
  assert.equal(row.audio_block_count, 64);
  assert.equal(row.messages_truncated, true);
  assert.equal(row.audio_blocks_truncated, true);
  assert.equal(row.audio_urls_hashed.length, 64);
  assert.ok(row.audio_urls_hashed.every((h) => /^[a-f0-9]{64}$/.test(h)));
});
