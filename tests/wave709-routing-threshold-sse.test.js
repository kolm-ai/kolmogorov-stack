// W709-3 + W709-4 — routing-threshold knob + SSE streaming router.
//
// These tests assert observable behavior, NOT internal structure:
//   1) defaultThreshold() reads KOLM_ROUTE_ENTROPY_THRESHOLD when set.
//   2) defaultThreshold() falls back to 1.5 when env unset.
//   3) defaultThreshold() rejects garbage env values (collapses to default).
//   4) getNamespaceThreshold() returns the default when no override is set.
//   5) setNamespaceThreshold() then getNamespaceThreshold() returns the new value.
//   6) Threshold validation rejects -1 and 11 (out of [0, 10] range).
//   7) SSE route end-to-end: low-entropy fixture stream stays on student;
//      final marker reports teacher_called:false and a single student segment.
//   8) SSE route end-to-end: a mid-stream high-entropy token flips to teacher;
//      final marker reports teacher_called:true + two segments + id/created/model
//      pinned to the student values across both segments.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Isolate data dir so we never touch the developer's real ~/.kolm during tests.
const TEST_DATA_DIR = path.join(os.tmpdir(), 'kolm-w709-rts-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.KOLM_DATA_DIR = TEST_DATA_DIR;
process.env.KOLM_HOME = TEST_DATA_DIR;
process.env.HOME = TEST_DATA_DIR;
process.env.USERPROFILE = TEST_DATA_DIR;
// Local-daemon mode keeps __w411HostedAuthGate from rejecting fixture requests
// (no real API key needed for the SSE smoke test).
process.env.KOLM_LOCAL_DAEMON = '1';

const RT = await import('../src/routing-threshold.js');

// =============================================================================
// 1) defaultThreshold reads from env when set
// =============================================================================
test('W709 #1 — defaultThreshold reads KOLM_ROUTE_ENTROPY_THRESHOLD', () => {
  const prev = process.env.KOLM_ROUTE_ENTROPY_THRESHOLD;
  try {
    process.env.KOLM_ROUTE_ENTROPY_THRESHOLD = '2.7';
    assert.equal(RT.defaultThreshold(), 2.7, 'should parse env value');
    process.env.KOLM_ROUTE_ENTROPY_THRESHOLD = '0.5';
    assert.equal(RT.defaultThreshold(), 0.5);
  } finally {
    if (prev === undefined) delete process.env.KOLM_ROUTE_ENTROPY_THRESHOLD;
    else process.env.KOLM_ROUTE_ENTROPY_THRESHOLD = prev;
  }
});

// =============================================================================
// 2) defaultThreshold falls back to 1.5 when env unset
// =============================================================================
test('W709 #2 — defaultThreshold falls back to 1.5 when env unset', () => {
  const prev = process.env.KOLM_ROUTE_ENTROPY_THRESHOLD;
  try {
    delete process.env.KOLM_ROUTE_ENTROPY_THRESHOLD;
    assert.equal(RT.defaultThreshold(), 1.5, 'fallback default is 1.5 nats');
    assert.equal(RT.DEFAULT_THRESHOLD, 1.5, 'exported constant matches');
  } finally {
    if (prev !== undefined) process.env.KOLM_ROUTE_ENTROPY_THRESHOLD = prev;
  }
});

// =============================================================================
// 3) defaultThreshold rejects garbage env values
// =============================================================================
test('W709 #3 — defaultThreshold rejects garbage env values', () => {
  const prev = process.env.KOLM_ROUTE_ENTROPY_THRESHOLD;
  try {
    process.env.KOLM_ROUTE_ENTROPY_THRESHOLD = 'not-a-number';
    assert.equal(RT.defaultThreshold(), 1.5, 'NaN collapses to default');
    process.env.KOLM_ROUTE_ENTROPY_THRESHOLD = '-3';
    assert.equal(RT.defaultThreshold(), 1.5, 'out-of-range negative collapses to default');
    process.env.KOLM_ROUTE_ENTROPY_THRESHOLD = '99';
    assert.equal(RT.defaultThreshold(), 1.5, 'out-of-range positive collapses to default');
    process.env.KOLM_ROUTE_ENTROPY_THRESHOLD = '';
    assert.equal(RT.defaultThreshold(), 1.5, 'empty collapses to default');
  } finally {
    if (prev === undefined) delete process.env.KOLM_ROUTE_ENTROPY_THRESHOLD;
    else process.env.KOLM_ROUTE_ENTROPY_THRESHOLD = prev;
  }
});

// =============================================================================
// 4) getNamespaceThreshold returns default when no override is set
// =============================================================================
test('W709 #4 — getNamespaceThreshold returns default when no override is set', async () => {
  const ns = 'w709-empty-' + crypto.randomBytes(3).toString('hex');
  const tenant = 'tenant_w709_empty_' + crypto.randomBytes(3).toString('hex');
  const got = await RT.getNamespaceThreshold(ns, tenant);
  assert.equal(got, RT.defaultThreshold(),
    'no override row → falls back to defaultThreshold()');
});

// =============================================================================
// 5) setNamespaceThreshold then getNamespaceThreshold returns the new value
// =============================================================================
test('W709 #5 — setNamespaceThreshold persists and getNamespaceThreshold reads it back', async () => {
  const ns = 'w709-override-' + crypto.randomBytes(3).toString('hex');
  const tenant = 'tenant_w709_override_' + crypto.randomBytes(3).toString('hex');
  await RT.setNamespaceThreshold(ns, tenant, 3.2);
  const got = await RT.getNamespaceThreshold(ns, tenant);
  assert.equal(got, 3.2, 'override row should be readable back as 3.2');

  // Most-recent wins: a second write supersedes the first.
  await RT.setNamespaceThreshold(ns, tenant, 0.7);
  const got2 = await RT.getNamespaceThreshold(ns, tenant);
  assert.equal(got2, 0.7, 'most-recent override should win');

  // Tenant fence: a different tenant under the same namespace still sees
  // the default, not the other tenant's override.
  const otherTenant = 'tenant_w709_other_' + crypto.randomBytes(3).toString('hex');
  const other = await RT.getNamespaceThreshold(ns, otherTenant);
  assert.equal(other, RT.defaultThreshold(),
    'foreign tenant must not see the override (tenant fence)');
});

// =============================================================================
// 6) Threshold validation rejects -1 and 11
// =============================================================================
test('W709 #6 — threshold validation rejects -1 and 11 with invalid_threshold', async () => {
  const ns = 'w709-validate';
  const tenant = 'tenant_w709_validate';

  await assert.rejects(
    () => RT.setNamespaceThreshold(ns, tenant, -1),
    (err) => err.code === 'invalid_threshold',
    '-1 should throw invalid_threshold',
  );
  await assert.rejects(
    () => RT.setNamespaceThreshold(ns, tenant, 11),
    (err) => err.code === 'invalid_threshold',
    '11 should throw invalid_threshold',
  );
  await assert.rejects(
    () => RT.setNamespaceThreshold(ns, tenant, Number.NaN),
    (err) => err.code === 'invalid_threshold',
    'NaN should throw invalid_threshold',
  );

  // Boundary values are accepted (inclusive range).
  await RT.setNamespaceThreshold(ns, tenant, 0);
  assert.equal(await RT.getNamespaceThreshold(ns, tenant), 0,
    '0 is the legal lower bound');
  await RT.setNamespaceThreshold(ns, tenant, 10);
  assert.equal(await RT.getNamespaceThreshold(ns, tenant), 10,
    '10 is the legal upper bound');

  // The pure validator throws identically.
  assert.throws(() => RT.validateThreshold(-0.0001), (err) => err.code === 'invalid_threshold');
  assert.throws(() => RT.validateThreshold(10.0001), (err) => err.code === 'invalid_threshold');
  assert.equal(RT.validateThreshold(5), 5, 'in-range threshold round-trips');
});

// =============================================================================
// Helper: stand up a tiny Express app with buildRouter and run a POST that
// drains an SSE response. Returns { status, headers, frames[] } where each
// frame is the JSON-parsed `data:` line (or the literal '[DONE]' string).
// =============================================================================
async function postSSE(path, body) {
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const { buildRouter } = await import('../src/router.js');
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser());
  app.use(buildRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const headers = Object.fromEntries(res.headers.entries());
    const text = await res.text();
    const frames = [];
    for (const block of text.split('\n\n')) {
      const line = block.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { frames.push('[DONE]'); continue; }
      try { frames.push(JSON.parse(payload)); } catch { frames.push(payload); }
    }
    return { status: res.status, headers, frames };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// =============================================================================
// 7) SSE route stays on student when all entropies are below threshold
// =============================================================================
test('W709 #7 — SSE route stays on student when entropies are below threshold', async () => {
  const result = await postSSE('/v1/route/chat/completions/stream', {
    id: 'chatcmpl-w709-student-only',
    created: 1234567890,
    model: 'kolm-student-7b',
    kolm_routing: { threshold: 2.0 },
    __fixture_student_tokens: [
      { text: 'Hello', entropy: 0.1 },
      { text: ' world', entropy: 0.2 },
      { text: '!', entropy: 0.3 },
    ],
    __fixture_teacher_tokens: [
      { text: 'TEACHER' },
    ],
  });
  assert.equal(result.status, 200, 'SSE route should return 200');
  assert.ok(
    (result.headers['content-type'] || '').includes('text/event-stream'),
    'content-type must be text/event-stream',
  );
  // Last frame is [DONE].
  assert.equal(result.frames[result.frames.length - 1], '[DONE]');
  // Locate the routing marker (the second-to-last data frame before [DONE]
  // and before the final 'stop' chunk).
  const markers = result.frames.filter((f) => f && typeof f === 'object' && f.kolm_routing);
  const finalMarker = markers[markers.length - 1].kolm_routing;
  assert.equal(finalMarker.teacher_called, false,
    'all-low-entropy stream should not call teacher');
  assert.ok(Array.isArray(finalMarker.segments) && finalMarker.segments.length === 1,
    'should report one student segment');
  assert.equal(finalMarker.segments[0].source, 'student');
  assert.equal(finalMarker.segments[0].start, 0);
  assert.equal(finalMarker.segments[0].end, 3, 'three student tokens emitted');
  assert.equal(finalMarker.id, 'chatcmpl-w709-student-only');
  assert.equal(finalMarker.created, 1234567890);
  assert.equal(finalMarker.model, 'kolm-student-7b');

  // Every content chunk carries the student id/created/model — coherence across
  // the entire stream.
  const contentChunks = result.frames.filter(
    (f) => f && typeof f === 'object' && f.object === 'chat.completion.chunk',
  );
  assert.ok(contentChunks.length >= 3, 'at least three content chunks (one per student token)');
  for (const c of contentChunks) {
    assert.equal(c.id, 'chatcmpl-w709-student-only', 'id pinned across stream');
    assert.equal(c.created, 1234567890, 'created pinned across stream');
    assert.equal(c.model, 'kolm-student-7b', 'model pinned across stream');
  }
});

// =============================================================================
// 8) SSE route flips to teacher mid-stream when entropy exceeds threshold
// =============================================================================
test('W709 #8 — SSE route flips to teacher mid-stream on high-entropy token', async () => {
  const result = await postSSE('/v1/route/chat/completions/stream', {
    id: 'chatcmpl-w709-flip',
    created: 1700000000,
    model: 'kolm-student-7b',
    kolm_routing: { threshold: 1.5, teacher_model: 'kolm-teacher-70b' },
    __fixture_student_tokens: [
      { text: 'The ', entropy: 0.1 },
      { text: 'answer ', entropy: 0.2 },
      { text: 'is ', entropy: 3.0 },   // <- crosses 1.5; triggers escalation
      { text: 'wrong', entropy: 0.1 }, // should NOT be emitted (we switched)
    ],
    __fixture_teacher_tokens: [
      { text: '42' },
      { text: '.' },
    ],
  });
  assert.equal(result.status, 200);
  const markers = result.frames.filter((f) => f && typeof f === 'object' && f.kolm_routing);
  // Two markers: the high_entropy_detected mid-stream marker, then the final
  // segments/decision marker.
  assert.ok(markers.length >= 2, 'should emit at least two routing markers');
  const evtMarker = markers[0].kolm_routing;
  assert.equal(evtMarker.event, 'high_entropy_detected');
  assert.equal(evtMarker.token_index, 2, 'switch happened at token index 2');
  assert.equal(evtMarker.entropy, 3.0);
  assert.equal(evtMarker.threshold, 1.5);

  const finalMarker = markers[markers.length - 1].kolm_routing;
  assert.equal(finalMarker.teacher_called, true);
  assert.equal(finalMarker.segments.length, 2, 'student + teacher segments');
  assert.deepEqual(finalMarker.segments[0], { start: 0, end: 2, source: 'student' });
  assert.deepEqual(finalMarker.segments[1], { start: 2, end: 4, source: 'teacher' });
  assert.equal(finalMarker.decision.switched, true);
  assert.equal(finalMarker.decision.switch_at_token, 2);
  assert.equal(finalMarker.decision.teacher_tokens, 2);

  // Coherence: every content chunk carries the STUDENT model/id/created,
  // even after the splice. The teacher_model leaks only in the final
  // segments marker, never in the chunk envelope.
  const contentChunks = result.frames.filter(
    (f) => f && typeof f === 'object' && f.object === 'chat.completion.chunk',
  );
  for (const c of contentChunks) {
    assert.equal(c.id, 'chatcmpl-w709-flip', 'id pinned even after teacher splice');
    assert.equal(c.created, 1700000000, 'created pinned even after teacher splice');
    assert.equal(c.model, 'kolm-student-7b',
      'model pinned to student even after teacher splice — OpenAI SDK coherence');
  }

  // The last frame is [DONE].
  assert.equal(result.frames[result.frames.length - 1], '[DONE]');
});
