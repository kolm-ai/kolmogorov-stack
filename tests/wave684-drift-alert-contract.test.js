import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  DRIFT_ALERT_VERSION,
  DEFAULTS,
  tokenizeForDistribution,
  buildDistributionSketch,
  normalizeSketch,
  compareSketches,
  generateShiftSuggestion,
  buildAlertEnvelope,
  newAlertId,
} from '../src/drift-alert.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

test('W684 drift-alert source pins bounded sketch and envelope controls', () => {
  const source = read('src/drift-alert.js');
  const router = read('src/router.js');
  assert.match(source, /DRIFT_ALERT_VERSION = 'w747-v1'/);
  assert.match(DRIFT_ALERT_VERSION, /^w747-/);
  assert.equal(DRIFT_ALERT_VERSION, 'w747-v1');
  assert.match(source, /MAX_SAMPLE_CHARS: 8192/);
  assert.match(source, /MAX_WORDS_PER_SAMPLE: 512/);
  assert.match(source, /MAX_SUPPORT_KEYS: 4096/);
  assert.match(source, /export function normalizeSketch/);
  assert.match(source, /RESERVED_KEYS/);
  assert.match(source, /buildAlertEnvelope/);
  assert.match(source, /payload_sha256/);
  assert.match(source, /_stableJson/);
  assert.match(router, /driftAlert\.buildAlertEnvelope/);
  assert.doesNotMatch(source, /[^\x00-\x7F]/);

  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['verify:drift-alert'], 'node --test --test-concurrency=1 tests/wave684-drift-alert-contract.test.js');
  assert.match(pkg.scripts['verify:depth'], /verify:finetune-frameworks && npm run verify:drift-alert && npm run verify:drift-alert-w813 && node --test/);
});

test('W684 tokenization and sketching cap untrusted corpus size deterministically', () => {
  const tokens = tokenizeForDistribution(
    `${'A'.repeat(200)} beta gamma delta epsilon`,
    { max_words: 4, max_token_chars: 8 },
  );
  assert.deepEqual(tokens.slice(0, 4), ['aaaaaaaa', 'beta', 'gamma', 'delta']);
  assert.ok(tokens.every((t) => t.length <= (8 * 3 + 2)));

  const samples = Array.from({ length: 20 }, (_, i) => `topic${i} billing support`);
  const sketch = buildDistributionSketch(samples, {
    top_k: 999999,
    max_samples: 3,
    max_words: 4,
  });
  assert.equal(sketch._top_k, DEFAULTS.MAX_TOP_K);
  assert.ok(sketch._total > 0);
  assert.equal(sketch.topic3, undefined);
  assert.equal(sketch.billing, 3);
});

test('W684 normalizeSketch rejects hostile keys and clamps support before math', () => {
  const hostile = Object.create(null);
  hostile.good = 3;
  hostile.Bad = 2;
  hostile.bad = Number.POSITIVE_INFINITY;
  hostile.negative = -5;
  hostile.__proto__ = 9;
  hostile.constructor = 9;
  hostile['x'.repeat(200)] = 4;
  hostile._total = -100;
  hostile._top_k = 999999;

  const normalized = normalizeSketch(hostile, { max_support_keys: 2 });
  assert.equal(Object.getPrototypeOf(normalized), null);
  assert.equal(normalized.__proto__, undefined);
  assert.equal(normalized.constructor, undefined);
  assert.equal(normalized.negative, undefined);
  assert.ok(normalized._total > 0);
  assert.equal(normalized._top_k, 2);
  assert.ok(Object.keys(normalized).filter((k) => !k.startsWith('_')).length <= 2);
});

test('W684 compareSketches remains finite on malicious sketches', () => {
  const training = { billing: 10, support: 5, _total: -1 };
  const production = Object.create(null);
  production.billing = 1;
  production.refund = 20;
  production['__proto__'] = 10;
  production.nope = Number.NaN;
  production._total = Number.POSITIVE_INFINITY;

  const compare = compareSketches(training, production, {
    top_n: 1000,
    max_support_keys: 3,
  });
  assert.ok(Number.isFinite(compare.kl));
  assert.ok(Number.isFinite(compare.jsd));
  assert.ok(compare.jsd >= 0 && compare.jsd <= 1);
  assert.ok(compare.top_diverging_tokens.length <= 3);
  assert.ok(compare.top_diverging_tokens.every((d) => Number.isFinite(d.p_train) && Number.isFinite(d.p_prod)));
});

test('W684 suggestions sanitize hostile token labels', () => {
  const suggestions = generateShiftSuggestion({
    top_diverging_tokens: [
      { token: 'Billing\nEscalation', p_train: 0.1, p_prod: 0.42, ratio: 4.2 },
      { token: 'stable', p_train: 0.5, p_prod: 0.1, ratio: 0.2 },
    ],
  });
  assert.equal(suggestions.length, 1);
  assert.match(suggestions[0], /billing escalation/);
  assert.doesNotMatch(suggestions[0], /[\r\n]/);
  assert.ok(suggestions[0].length <= DEFAULTS.MAX_SUGGESTION_CHARS);
});

test('W684 alert envelope is deterministic, tenant-hashed, and digest-backed', () => {
  const compare = compareSketches(
    buildDistributionSketch(['billing billing support']),
    buildDistributionSketch(['refund refund billing']),
  );
  const args = {
    namespace: ' support\nvoice ',
    tenant_id: 'tenant-secret',
    compare,
    threshold: 0.05,
    alert: true,
    suggestions: ['Capture more refund examples.\nNow.'],
    generated_at: '2026-06-18T00:00:00Z',
  };
  const first = buildAlertEnvelope(args);
  const second = buildAlertEnvelope(args);

  assert.deepEqual(first, second);
  assert.equal(first.namespace, 'support voice');
  assert.match(first.tenant_hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), /tenant-secret/);
  assert.match(first.alert_id, /^driftalert_[a-f0-9]{16}$/);
  assert.match(first.payload_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(first.suggestions[0], /[\r\n]/);
  assert.equal(newAlertId({ namespace: 'support', jsd: 0.2 }), newAlertId({ namespace: 'support', jsd: 0.2 }));
});
