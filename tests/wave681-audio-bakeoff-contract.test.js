import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  AUDIO_BAKEOFF_VERSION,
  INTENT_KINDS,
  runAudioBakeoff,
} from '../src/audio-bakeoff.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

test('W681 audio bakeoff source pins local-only bounded scoring controls', () => {
  const source = read('src/audio-bakeoff.js');
  assert.match(source, /const MAX_ROWS = 500/);
  assert.match(source, /const MAX_TEXT_CHARS = 64 \* 1024/);
  assert.match(source, /const MAX_NAMESPACE_CHARS = 256/);
  assert.match(source, /const MAX_ARTIFACT_PATH_CHARS = 2048/);
  assert.match(source, /_normalizeNamespace\(a\.namespace\)/);
  assert.match(source, /_normalizeArtifactPath\(a\.artifact_path\)/);
  assert.match(source, /artifact_path must be local; remote artifact URLs are not accepted/);
  assert.match(source, /limit: MAX_ROWS/);
  assert.match(source, /const candidates = rows\.slice\(0, cap\)/);
  assert.match(source, /_boundedText\(_pickTranscript\(ev\)\)/);
  assert.match(source, /score = _normalizeScore\(score\)/);
  assert.match(source, /row_failures\.artifact_run_failed \+= 1/);
  assert.match(source, /row_failures\.judge_failed \+= 1/);
  assert.match(source, /bakeoff_id: _bakeoffId/);

  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['verify:audio-bakeoff'], 'node --test --test-concurrency=1 tests/wave681-audio-bakeoff-contract.test.js');
  assert.match(pkg.scripts['verify:depth'], /verify:distill-bon && npm run verify:audio-bakeoff && npm run verify:airgap/);
});

test('W681 audio bakeoff rejects remote artifacts and malformed scopes before store reads', async () => {
  let called = false;
  const storeMod = {
    async listEvents() {
      called = true;
      return [];
    },
  };

  const remote = await runAudioBakeoff({
    tenant_id: 'tenant-a',
    artifact_path: 'https://example.invalid/model.kolm',
    opts: { storeMod },
  });
  assert.equal(remote.ok, false);
  assert.equal(remote.error, 'invalid_artifact_path');
  assert.match(remote.hint, /local/);
  assert.equal(called, false);

  const badNamespace = await runAudioBakeoff({
    tenant_id: 'tenant-a',
    namespace: 'bad\nnamespace',
    opts: { storeMod },
  });
  assert.equal(badNamespace.ok, false);
  assert.equal(badNamespace.error, 'invalid_namespace');
  assert.equal(called, false);
});

test('W681 audio bakeoff reports total rows separately from capped evaluation', async () => {
  const rows = [
    {
      event_id: 'a1',
      tenant_id: 'tenant-a',
      namespace: 'voice',
      media_kind: 'audio',
      whisper_transcript: 'How do I reset the router?',
      response_head: 'Reset the router from settings.',
    },
    {
      event_id: 'a2',
      tenant_id: 'tenant-a',
      namespace: 'voice',
      media_kind: 'audio',
      transcript: 'open the support dashboard',
      response_redacted: 'Opening the support dashboard.',
    },
    {
      event_id: 'a3',
      tenant_id: 'tenant-a',
      namespace: 'voice',
      media_kind: 'audio',
      prompt_head: Array.from({ length: 40 }, (_, i) => `dictation${i}`).join(' '),
      response: 'Captured long dictation.',
    },
    {
      event_id: 'evil',
      tenant_id: 'tenant-b',
      namespace: 'voice',
      media_kind: 'audio',
      whisper_transcript: 'Should not leak?',
      response_head: 'no',
    },
  ];
  let query = null;
  const calls = [];
  const storeMod = {
    async listEvents(q) {
      query = q;
      return rows;
    },
  };

  const result = await runAudioBakeoff({
    tenant_id: 'tenant-a',
    namespace: ' voice ',
    artifact_path: './student.kolm',
    max_n: 2,
    opts: {
      storeMod,
      async runOnArtifact(artifactPath, transcript, ctx) {
        calls.push({ artifactPath, transcript, ctx });
        return transcript.includes('open') ? 'Opening the support dashboard.' : 'Reset the router from settings.';
      },
      judge({ ev }) {
        return ev.event_id === 'a1' ? 1.5 : -0.25;
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.version, AUDIO_BAKEOFF_VERSION);
  assert.deepEqual(query, {
    tenant_id: 'tenant-a',
    namespace: 'voice',
    media_kind: 'audio',
    limit: 500,
  });
  assert.equal(result.count_total, 3);
  assert.equal(result.count_audio_pairs_evaluated, 2);
  assert.equal(result.max_n, 2);
  assert.equal(result.transcript_coverage_pct, 100);
  assert.equal(result.by_intent_kind.question, 1);
  assert.equal(result.by_intent_kind.command, 1);
  assert.equal(result.by_intent_kind.dictation, 1);
  assert.equal(result.avg_score, 0.5);
  assert.deepEqual(result.row_failures, { artifact_run_failed: 0, judge_failed: 0 });
  assert.match(result.bakeoff_id, /^abk_[a-f0-9]{16}$/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].artifactPath, './student.kolm');
  assert.deepEqual(calls[0].ctx, { tenant_id: 'tenant-a' });
});

test('W681 audio bakeoff bounds text and accounts per-row failures', async () => {
  const hugeTranscript = 'open ' + 'x'.repeat(100000);
  const storeMod = {
    async listEvents() {
      return [
        {
          event_id: 'long',
          tenant_id: 'tenant-a',
          namespace: 'voice',
          media_kind: 'audio',
          whisper_transcript: hugeTranscript,
          response_head: 'base',
        },
        {
          event_id: 'throws',
          tenant_id: 'tenant-a',
          namespace: 'voice',
          media_kind: 'audio',
          whisper_transcript: 'hello there',
          response_head: 'base',
        },
      ];
    },
  };
  const seenLengths = [];
  const result = await runAudioBakeoff({
    tenant_id: 'tenant-a',
    namespace: 'voice',
    artifact_path: './student.kolm',
    max_n: 2,
    opts: {
      storeMod,
      async runOnArtifact(_artifactPath, transcript) {
        seenLengths.push(transcript.length);
        if (seenLengths.length === 2) throw new Error('runner failed');
        return 'candidate';
      },
      judge({ ev }) {
        if (ev.event_id === 'long') throw new Error('judge failed');
        return Number.NaN;
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.count_total, 2);
  assert.equal(result.count_audio_pairs_evaluated, 2);
  assert.equal(result.avg_score, 0);
  assert.equal(result.row_failures.artifact_run_failed, 1);
  assert.equal(result.row_failures.judge_failed, 1);
  assert.ok(seenLengths[0] <= 64 * 1024);
  assert.ok(seenLengths[1] <= 64 * 1024);
});

test('W681 audio bakeoff empty and not-wired states stay explicit', async () => {
  const empty = await runAudioBakeoff({
    tenant_id: 'tenant-a',
    artifact_path: 'none',
    opts: {
      storeMod: {
        async listEvents() {
          return [
            { event_id: 'wrong-tenant', tenant_id: 'tenant-b', namespace: 'voice', media_kind: 'audio' },
            { event_id: 'wrong-kind', tenant_id: 'tenant-a', namespace: 'voice', media_kind: 'video' },
          ];
        },
      },
    },
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.message, 'no_audio_captures');
  assert.equal(empty.count_total, 0);
  assert.equal(empty.artifact_path, null);
  assert.deepEqual(Object.keys(empty.by_intent_kind), INTENT_KINDS);

  const notWired = await runAudioBakeoff({
    tenant_id: 'tenant-a',
    opts: { storeMod: {} },
  });
  assert.equal(notWired.ok, false);
  assert.equal(notWired.error, 'store_not_wired');
});
