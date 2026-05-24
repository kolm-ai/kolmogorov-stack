// W829 — Multimodal capture pipeline tests.
//
// Atomic test discipline (per W604 memory): one contract per test, never
// assert exact file contents for dashboards, sw.js wave token asserted
// via regex+threshold (`wave(\d{3,4})` ≥ 829) NOT an explicit array so
// future waves don't have to touch the test.
//
// Coverage map (each W829 atom appears in at least one test):
//   W829-1: tests #1, #2, #6, #11
//   W829-2: tests #4, #5
//   W829-3: test #3 (honest envelope when KOLM_VLM_TEACHER_API_KEY unset)
//   W829-4: tests #6, #11
//   Routes + auth + version hygiene: tests #7, #8, #9, #10, #12

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// We import lazily inside freshDir() in tests that need fresh module state
// (the captures module reads env at call time, not load time, so static
// imports here are safe for the route + version tests).
import {
  recordMultimodalCapture,
  recordMultiTurnCapture,
  resolveMultimodalPath,
  resolveMultiTurnPath,
  readMultimodalCaptures,
  readMultiTurnCaptures,
  hashPayload,
  MULTIMODAL_KINDS,
  W829_VERSION,
} from '../src/captures.js';

import {
  vlmDistillRun,
  vlmDistillList,
  SUPPORTED_TEACHERS,
  VLM_DISTILL_VERSION,
  _resetForTests as vlmResetForTests,
} from '../src/vlm-distill.js';

import {
  addHeterogeneousWeights,
  HETEROGENEOUS_WEIGHTS_VERSION,
} from '../src/artifact.js';

import { registerMultimodalPipelineRoutes } from '../src/multimodal-pipeline-routes.js';

// Helper: pin HOME / USERPROFILE / KOLM_DATA_DIR to an isolated tmpdir so
// the test never touches the operator's real ~/.kolm.
function freshDir(slug = 'w829') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `kolm-${slug}-`));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  delete process.env.KOLM_NO_RAW_MULTIMODAL;
  delete process.env.KOLM_VLM_TEACHER_API_KEY;
  vlmResetForTests();
  return tmp;
}

// Tiny express harness — registers the W829 routes, returns a runnable app
// + a fake auth middleware that injects req.tenant_record so the
// auth-gate tests can verify both paths (with + without record).
function makeApp({ authed = true } = {}) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  if (authed) {
    app.use((req, _res, next) => {
      req.tenant_record = { id: 'tenant_w829_test', plan: 'business' };
      next();
    });
  }
  registerMultimodalPipelineRoutes(app);
  return app;
}

// Trivial inline supertest replacement — Node has no fetch-to-app loopback
// utility built in, so we spin a server on an ephemeral port for the test
// duration. This keeps the test file dep-free.
async function request(app, { method = 'GET', path: urlPath, body }) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const opts = {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, opts);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, body: json, raw: text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---------------------------------------------------------------------------
// #1 — recordMultimodalCapture writes correct path layout
// ---------------------------------------------------------------------------

test('W829 #1 — recordMultimodalCapture writes to namespace/multimodal/kind/hash.jsonl', () => {
  freshDir();
  const hash = hashPayload({ pixels: 'fake-image-bytes' });
  const env = recordMultimodalCapture({
    tenant: 'tenant_test',
    namespace: 'demo-ns',
    kind: 'image',
    payload: {
      data_uri: 'data:image/png;base64,iVBORw0KGgoAAAA',
      created_at: '2026-05-24T00:00:00.000Z',
      redaction_classes_seen: ['face', 'license_plate'],
    },
    hash,
    redaction_receipt: { redactor: 'w462', mode: 'blur' },
  });
  assert.equal(env.ok, true, `expected ok=true, got ${JSON.stringify(env)}`);
  assert.equal(env.namespace, 'demo-ns');
  assert.equal(env.kind, 'image');
  assert.equal(env.hash, hash);
  // Path layout must match the spec exactly.
  const resolved = resolveMultimodalPath({ namespace: 'demo-ns', kind: 'image', hash });
  assert.ok(resolved.file.includes(path.join('captures', 'demo-ns', 'multimodal', 'image')));
  assert.ok(resolved.file.endsWith(`${hash}.jsonl`));
  assert.ok(fs.existsSync(resolved.file), `file should exist at ${resolved.file}`);
});

// ---------------------------------------------------------------------------
// #2 — KOLM_NO_RAW_MULTIMODAL=1 strips data_uri while keeping the hash
// ---------------------------------------------------------------------------

test('W829 #2 — KOLM_NO_RAW_MULTIMODAL=1 strips data_uri (hash binding preserved)', () => {
  freshDir();
  process.env.KOLM_NO_RAW_MULTIMODAL = '1';
  const hash = hashPayload({ pixels: 'fake-image-bytes' });
  const env = recordMultimodalCapture({
    tenant: 'tenant_test',
    namespace: 'demo-ns',
    kind: 'image',
    payload: {
      data_uri: 'data:image/png;base64,SECRET_SHOULD_NOT_BE_STORED',
      created_at: '2026-05-24T00:00:00.000Z',
    },
    hash,
  });
  assert.equal(env.ok, true);
  assert.equal(env.raw_stored, false, 'env must report raw_stored:false');
  const rows = readMultimodalCaptures({ namespace: 'demo-ns', kind: 'image', hash });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hash, hash, 'hash must still bind the row');
  assert.equal(rows[0].raw_stored, false);
  assert.ok(!('data_uri' in rows[0]) || rows[0].data_uri == null,
    'data_uri must not be present when raw is stripped');
});

// ---------------------------------------------------------------------------
// #3 — vlmDistillRun without env → honest queued envelope
// ---------------------------------------------------------------------------

test('W829 #3 — vlmDistillRun without KOLM_VLM_TEACHER_API_KEY → real_run:false', () => {
  freshDir();
  // Just to be defensive — freshDir already deletes it.
  delete process.env.KOLM_VLM_TEACHER_API_KEY;
  const env = vlmDistillRun({
    teacher: 'gpt-4v',
    student_model: 'Qwen2.5-VL-2B',
    dataset_captures: ['cap_1', 'cap_2', 'cap_3'],
  });
  assert.equal(env.ok, true, 'ok must be true (the job IS queued)');
  assert.equal(env.status, 'queued');
  assert.equal(env.real_run, false, 'real_run must be false without the env key');
  assert.equal(env.missing_env, 'KOLM_VLM_TEACHER_API_KEY');
  assert.ok(env.run_id && env.run_id.startsWith('vlm_'), `run_id must be assigned; got ${env.run_id}`);
  assert.ok(typeof env.queued_at === 'string' && env.queued_at.length > 0);
});

// ---------------------------------------------------------------------------
// #4 — addHeterogeneousWeights writes 3 subdirs + manifest block
// ---------------------------------------------------------------------------

test('W829 #4 — addHeterogeneousWeights adds weights/text|vision-encoder|tool-use-head + manifest block', () => {
  const builder = { files: [], manifest: {} };
  const result = addHeterogeneousWeights(builder, {
    text_weights: Buffer.from('TEXT-WEIGHTS-FAKE'),
    vision_encoder: { kind: 'clip-vit-b32', content: Buffer.from('CLIP-WEIGHTS-FAKE') },
    tool_use_head: { kind: 'tool-use-head-v1', content: Buffer.from('TUH-WEIGHTS-FAKE') },
  });
  // Identity: helper returns the same builder so the result is chainable.
  assert.equal(result, builder);
  const filenames = builder.files.map((f) => f.filename).sort();
  assert.ok(filenames.includes('weights/text/weights.bin'), `missing weights/text/, got ${JSON.stringify(filenames)}`);
  assert.ok(filenames.includes('weights/vision-encoder/weights.bin'), 'missing weights/vision-encoder/');
  assert.ok(filenames.includes('weights/tool-use-head/weights.bin'), 'missing weights/tool-use-head/');
  // Manifest block contract.
  const hw = builder.manifest.heterogeneous_weights;
  assert.ok(hw, 'manifest.heterogeneous_weights must be present');
  assert.deepEqual(hw.present_modalities.sort(), ['text', 'tool_use', 'vision']);
  assert.equal(hw.vision_encoder_kind, 'clip-vit-b32');
  assert.equal(hw.tool_use_head_kind, 'tool-use-head-v1');
  assert.equal(hw.text_weights_present, true);
  assert.equal(hw.vision_encoder_present, true);
  assert.equal(hw.tool_use_head_present, true);
  assert.equal(hw.spec_version, HETEROGENEOUS_WEIGHTS_VERSION);
});

// ---------------------------------------------------------------------------
// #5 — addHeterogeneousWeights rejects unknown vision encoder kinds
// ---------------------------------------------------------------------------

test('W829 #5 — addHeterogeneousWeights rejects unknown vision_encoder.kind', () => {
  const builder = { files: [], manifest: {} };
  assert.throws(() => addHeterogeneousWeights(builder, {
    vision_encoder: { kind: 'totally-made-up-encoder', content: Buffer.from('x') },
  }), /vision_encoder\.kind/);
  // And rejects unknown tool_use_head.kind:
  assert.throws(() => addHeterogeneousWeights({ files: [], manifest: {} }, {
    tool_use_head: { kind: 'not-real', content: Buffer.from('x') },
  }), /tool_use_head\.kind/);
});

// ---------------------------------------------------------------------------
// #6 — recordMultiTurnCapture appends to JSONL
// ---------------------------------------------------------------------------

test('W829 #6 — recordMultiTurnCapture appends to ~/.kolm/captures/<ns>/multi-turn/<cid>.jsonl', () => {
  freshDir();
  const cid = 'conv-abc-123';
  const env1 = recordMultiTurnCapture({
    tenant: 'tenant_test',
    namespace: 'mt-ns',
    conversation_id: cid,
    conversation: [
      { role: 'user', content: 'Hello', timestamp: '2026-05-24T00:00:00Z' },
      { role: 'assistant', content: 'Hi!', timestamp: '2026-05-24T00:00:01Z' },
    ],
  });
  assert.equal(env1.ok, true);
  assert.equal(env1.turn_count, 2);

  // Second call appends, doesn't replace.
  const env2 = recordMultiTurnCapture({
    tenant: 'tenant_test',
    namespace: 'mt-ns',
    conversation_id: cid,
    conversation: [
      { role: 'user', content: 'Hello', timestamp: '2026-05-24T00:00:00Z' },
      { role: 'assistant', content: 'Hi!', timestamp: '2026-05-24T00:00:01Z' },
      { role: 'user', content: 'Tell me a joke', timestamp: '2026-05-24T00:00:05Z' },
      {
        role: 'assistant',
        content: 'Why did the chicken cross the road?',
        timestamp: '2026-05-24T00:00:06Z',
        tool_calls: [{ name: 'get_joke', arguments: { topic: 'chicken' }, id: 'tc1' }],
      },
    ],
    parent_message_id: 'msg_root',
  });
  assert.equal(env2.ok, true);
  assert.equal(env2.turn_count, 4);

  const rows = readMultiTurnCaptures({ namespace: 'mt-ns', conversation_id: cid });
  assert.equal(rows.length, 2, 'must have 2 appended rows, not 1');
  assert.equal(rows[0].turn_count, 2);
  assert.equal(rows[1].turn_count, 4);
  assert.equal(rows[1].parent_message_id, 'msg_root');
  assert.ok(rows[1].conversation[3].tool_calls);
  assert.equal(rows[1].conversation[3].tool_calls[0].name, 'get_joke');
});

// ---------------------------------------------------------------------------
// #7 — all 4 routes are registered (smoke test through the route surface)
// ---------------------------------------------------------------------------

test('W829 #7 — registerMultimodalPipelineRoutes registers all four routes', async () => {
  freshDir();
  const app = makeApp({ authed: true });
  const captures = await request(app, {
    method: 'POST',
    path: '/v1/captures/multimodal',
    body: { namespace: 'rt-ns', kind: 'image', payload: { data_uri: 'data:image/png;base64,AA' } },
  });
  assert.equal(captures.status, 200, `POST /v1/captures/multimodal status was ${captures.status} body=${JSON.stringify(captures.body)}`);
  assert.equal(captures.body.ok, true);

  const multiTurn = await request(app, {
    method: 'POST',
    path: '/v1/captures/multi-turn',
    body: {
      namespace: 'rt-ns',
      conversation_id: 'conv-route-1',
      conversation: [{ role: 'user', content: 'hi' }],
    },
  });
  assert.equal(multiTurn.status, 200);
  assert.equal(multiTurn.body.ok, true);

  const vlmRun = await request(app, {
    method: 'POST',
    path: '/v1/vlm-distill/run',
    body: { teacher: 'gpt-4v', student_model: 'Qwen2.5-VL-2B', dataset_captures: ['c1'] },
  });
  assert.equal(vlmRun.status, 200);
  assert.equal(vlmRun.body.ok, true);
  assert.equal(vlmRun.body.real_run, false);
  assert.equal(vlmRun.body.missing_env, 'KOLM_VLM_TEACHER_API_KEY');

  const vlmList = await request(app, { method: 'GET', path: '/v1/vlm-distill/runs' });
  assert.equal(vlmList.status, 200);
  assert.equal(vlmList.body.ok, true);
  assert.ok(Array.isArray(vlmList.body.runs));
  assert.ok(vlmList.body.runs.length >= 1);
  assert.deepEqual(vlmList.body.supported_teachers.sort(), [...SUPPORTED_TEACHERS].sort());
});

// ---------------------------------------------------------------------------
// #8 — all 4 routes are auth-gated (401 without tenant_record)
// ---------------------------------------------------------------------------

test('W829 #8 — all four W829 routes are auth-gated (401 without tenant_record)', async () => {
  freshDir();
  const app = makeApp({ authed: false });
  for (const probe of [
    { method: 'POST', path: '/v1/captures/multimodal', body: {} },
    { method: 'POST', path: '/v1/captures/multi-turn', body: {} },
    { method: 'POST', path: '/v1/vlm-distill/run', body: {} },
    { method: 'GET', path: '/v1/vlm-distill/runs' },
  ]) {
    const r = await request(app, probe);
    assert.equal(r.status, 401, `${probe.method} ${probe.path} should 401, got ${r.status}`);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, 'auth_required');
  }
});

// ---------------------------------------------------------------------------
// #9 — W604 regex pattern check passes against sw.js
// ---------------------------------------------------------------------------

test('W829 #9 — sw.js wave token matches `wave(\\d{3,4})` and includes a token >=829', () => {
  const swPath = path.resolve('public/sw.js');
  const raw = fs.readFileSync(swPath, 'utf8');
  // Per W604/W466/W454 family: regex+threshold, never explicit array.
  const matches = [...raw.matchAll(/wave(\d{3,4})/g)].map((m) => Number(m[1]));
  assert.ok(matches.length > 0, 'sw.js must contain at least one wave token');
  const maxWave = Math.max(...matches);
  assert.ok(maxWave >= 829, `sw.js highest wave token ${maxWave} must be >= 829`);
  // And the specific W829 suffix the wave-plan asked for must be present.
  assert.ok(raw.includes('wave829-multimodal-pipeline'),
    'sw.js must include the wave829-multimodal-pipeline suffix per the W829 plan');
});

// ---------------------------------------------------------------------------
// #10 — backward compat: existing src/capture.js + src/capture-store.js
// exports are still importable (we did not touch them).
// ---------------------------------------------------------------------------

test('W829 #10 — existing capture.js / capture-store.js exports remain importable', async () => {
  const capMod = await import('../src/capture.js');
  // Anchors that have shipped for many waves — if W829 accidentally
  // touched the wrong file these would explode.
  assert.equal(typeof capMod.sanitizeNamespace, 'function');
  assert.equal(typeof capMod.pickAnthropicUpstream, 'function');
  assert.equal(typeof capMod.pickOpenAIUpstream, 'function');
  assert.equal(typeof capMod.extractPromptForCapture, 'function');
  assert.equal(typeof capMod.forwardAnthropic, 'function');
  assert.equal(typeof capMod.promptHash, 'function');

  const storeMod = await import('../src/capture-store.js');
  assert.equal(typeof storeMod.insertCapture, 'function');
  assert.equal(typeof storeMod.listCaptures, 'function');
  assert.equal(typeof storeMod.countCaptures, 'function');
  assert.equal(typeof storeMod.isDurable, 'function');
});

// ---------------------------------------------------------------------------
// #11 — recordMultimodalCapture rejects unknown kind + missing hash
// ---------------------------------------------------------------------------

test('W829 #11 — recordMultimodalCapture rejects unknown kind + missing hash', () => {
  freshDir();
  // Unknown kind surfaces as invalid_args (not a thrown exception).
  const env1 = recordMultimodalCapture({
    tenant: 'tenant_test',
    namespace: 'rt-ns',
    kind: 'video-of-grandma',
    payload: { data_uri: 'data:video/mp4;base64,AA' },
    hash: 'a'.repeat(64),
  });
  assert.equal(env1.ok, false);
  assert.equal(env1.error, 'invalid_args');

  // Missing hash → invalid_args (kind valid, but no hash provided).
  const env2 = recordMultimodalCapture({
    tenant: 'tenant_test',
    namespace: 'rt-ns',
    kind: 'image',
    payload: { data_uri: 'data:image/png;base64,AA' },
    hash: null,
  });
  assert.equal(env2.ok, false);
  assert.equal(env2.error, 'invalid_args');

  // Tenant required — distinct error code.
  const env3 = recordMultimodalCapture({
    tenant: null,
    namespace: 'rt-ns',
    kind: 'image',
    payload: { data_uri: 'data:image/png;base64,AA' },
    hash: 'a'.repeat(64),
  });
  assert.equal(env3.ok, false);
  assert.equal(env3.error, 'tenant_required');

  // The valid-kinds enum is exactly the contract.
  assert.deepEqual(
    [...MULTIMODAL_KINDS].sort(),
    ['audio', 'image', 'multi_turn', 'tool_use'].sort(),
  );
});

// ---------------------------------------------------------------------------
// #12 — version hygiene: all three W829 modules report w829-v* spec_version
// ---------------------------------------------------------------------------

test('W829 #12 — module spec_version strings are stamped w829-v*', () => {
  assert.match(W829_VERSION, /^w829-v\d+$/, `W829_VERSION ${W829_VERSION} must match /^w829-v\\d+$/`);
  assert.match(VLM_DISTILL_VERSION, /^w829-v\d+$/, `VLM_DISTILL_VERSION ${VLM_DISTILL_VERSION} must match /^w829-v\\d+$/`);
  assert.match(HETEROGENEOUS_WEIGHTS_VERSION, /^w829-v\d+$/, `HETEROGENEOUS_WEIGHTS_VERSION ${HETEROGENEOUS_WEIGHTS_VERSION} must match /^w829-v\\d+$/`);
  // vlmDistillList returns the version in its envelope (informational route).
  freshDir();
  const list = vlmDistillList({});
  assert.equal(list.version, VLM_DISTILL_VERSION);
});
