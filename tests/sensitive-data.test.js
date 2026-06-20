// Agent Security-Review audit - shared sensitive-data detection lock-in tests.
//
// Pins src/sensitive-data.js (GAP-2, detection half): every secret shape in
// SECRET_SHAPE_PATTERNS actually hits its canonical token, ordinary hosts and
// endpoints never hit (so folding secrets into has_sensitive cannot flip the
// red-team fixtures), PII and secret classes stay SEPARATE in scanSensitive,
// and detectorCoverage() - the bounded claim the signed report carries - is
// frozen in shape and vocabulary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET_SHAPE_PATTERNS,
  scanSecretShapes,
  scanSensitive,
  detectorCoverage,
} from '../src/sensitive-data.js';

const join = (...parts) => parts.join('');
const repeat = (ch, n) => String(ch).repeat(n);

// One canonical token per shape id. Values are synthetic and assembled at
// runtime so public Git never stores key-shaped literals that trigger scanners.
const CANONICAL = {
  'openai-style-key': join('sk-', repeat('a', 20)),
  'aws-akid': join('AKIA', repeat('A', 16)),
  'aws-sts-akid': join('ASIA', repeat('B', 16)),
  'github-token': join('ghp_', repeat('c', 20)),
  'slack-token': join('xox', 'b-', repeat('d', 10)),
  'gcp-api-key': join('AI', 'za', repeat('E', 35)),
  'oauth-ya29': join('ya', '29.', repeat('f', 20)),
  'jwt': join('ey', 'J', repeat('g', 8), '.', repeat('h', 8), '.', repeat('i', 4)),
  'pem-private-key': join('-----BEGIN ', 'PRIVATE ', 'KEY-----'),
  'bearer': join('Bearer ', repeat('j', 20)),
  'kv-secret': join('api_', 'key=', repeat('k', 12)),
};

test('every secret shape in the table hits its canonical token', () => {
  assert.equal(SECRET_SHAPE_PATTERNS.length, 11, 'eleven shapes, same as red-team SECRET_PATTERNS');
  for (const p of SECRET_SHAPE_PATTERNS) {
    const tok = CANONICAL[p.id];
    assert.ok(tok, `canonical token defined for shape ${p.id}`);
    const r = scanSecretShapes(`tool call body carrying ${tok} inline`);
    assert.ok(r.hit, `${p.id} hits`);
    assert.ok(r.classes.includes(p.id), `${p.id} class recorded`);
  }
});

test('the scan returns shape ids only - never the matched value', () => {
  const r = scanSecretShapes(`Authorization: ${CANONICAL.bearer}`);
  const flat = JSON.stringify(r);
  assert.ok(r.hit);
  assert.ok(!flat.includes(CANONICAL.bearer.slice('Bearer '.length)), 'matched token never echoed');
});

test('ordinary hosts, endpoints, and prose never match a secret shape', () => {
  for (const benign of [
    'api.openai.com',
    'https://api.openai.com/v1/chat/completions',
    'POST /v1/messages HTTP/1.1',
    'send the quarterly report to bob@acme.com please',
    '{"q":"pricing for the skylark plan"}',
    'the task id is task-1234 and the order id is ord-5678',
  ]) {
    const r = scanSecretShapes(benign);
    assert.deepEqual(r, { hit: false, classes: [] }, `no hit on: ${benign}`);
  }
});

test('short / non-string input degrades to no-hit, never a throw', () => {
  for (const bad of [undefined, null, 42, {}, [], '', 'sk-x', 'short']) {
    const r = scanSecretShapes(bad);
    assert.deepEqual(r, { hit: false, classes: [] });
  }
  for (const bad of [undefined, null, 42, {}, [], '']) {
    const r = scanSensitive(bad);
    assert.deepEqual(r, { has_sensitive: false, pii_classes: [], secret_classes: [] });
  }
});

test('scanSensitive keeps PII and secret classes separate; has_sensitive is the OR', () => {
  // PII only.
  const pii = scanSensitive('customer SSN 123-45-6789 confirmed');
  assert.equal(pii.has_sensitive, true);
  assert.ok(pii.pii_classes.includes('ssn'), 'ssn lands in pii_classes');
  assert.deepEqual(pii.secret_classes, [], 'no secret class on plain PII');

  // Secret only - the GAP-2 case the regex PII scanner was blind to.
  const sec = scanSensitive(`{"headers":{"x-api-key":"${CANONICAL['openai-style-key']}"}}`);
  assert.equal(sec.has_sensitive, true, 'a secret-shaped token alone flips has_sensitive');
  assert.deepEqual(sec.pii_classes, [], 'secret is not mislabeled as PII');
  assert.ok(sec.secret_classes.includes('openai-style-key'));

  // Both.
  const both = scanSensitive(`SSN 123-45-6789 sent with ${CANONICAL['aws-akid']}`);
  assert.equal(both.has_sensitive, true);
  assert.ok(both.pii_classes.includes('ssn'));
  assert.ok(both.secret_classes.includes('aws-akid'));
});

test('detectorCoverage shape is frozen: the exact bounded claim for the signed report', () => {
  const cov = detectorCoverage();
  assert.deepEqual(Object.keys(cov).sort(), ['pii_classes', 'secret_shapes']);
  assert.deepEqual(
    cov.secret_shapes,
    SECRET_SHAPE_PATTERNS.map((p) => p.id),
    'secret shape vocabulary mirrors the pattern table',
  );
  assert.ok(Array.isArray(cov.pii_classes) && cov.pii_classes.length > 0, 'PII vocabulary present');
  for (const c of cov.pii_classes) assert.equal(typeof c, 'string');
  assert.deepEqual(cov.pii_classes, [...cov.pii_classes].sort(), 'PII vocabulary sorted (deterministic)');
  assert.ok(cov.pii_classes.includes('ssn'), 'ssn in the scanned vocabulary');
  // Deterministic across calls (the caveat must canonicalize identically).
  assert.deepEqual(detectorCoverage(), cov);
});
