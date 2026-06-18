// W934 - provider/compliance/support boundary contracts.
//
// Covers:
//   src/providers/deepseek-native.js
//   src/providers/google-native.js
//   src/providers/groq.js
//   src/providers/together-hosted.js
//   src/providers/_shared.js
//   src/ai-act-export.js
//   src/ai-act-risk.js
//   src/prompt-redactor.js
//   src/plan-catalog.js
//   src/ofac-denylist.json

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import * as deepseek from '../src/providers/deepseek-native.js';
import * as google from '../src/providers/google-native.js';
import * as groq from '../src/providers/groq.js';
import * as together from '../src/providers/together-hosted.js';
import {
  buildGovernanceReport,
  buildTechnicalDocumentation,
} from '../src/ai-act-export.js';
import {
  AI_ACT_RISK_TEXT_LIMIT_CHARS,
  classifyTaskCategory,
  scoreArtifactRisk,
} from '../src/ai-act-risk.js';
import {
  prepareForDistillation,
  redactSystemPrompt,
} from '../src/prompt-redactor.js';
import {
  PLAN_ALIASES,
  PLAN_CATALOG,
  PLAN_ORDER,
  canonicalPlanId,
  fixedPriceOfferCount,
} from '../src/plan-catalog.js';
import {
  EXPORT_CONTROL_DENYLIST,
  isGeoFenced,
  ofacDenylistStaleness,
} from '../src/auth.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

async function withFetch(stub, fn) {
  const previous = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previous;
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('W934 public provider adapters validate keys and targets before fetch', async () => {
  let fetchCalls = 0;
  await withFetch(async () => {
    fetchCalls += 1;
    return jsonResponse({ choices: [] });
  }, async () => {
    const badKey = await groq.forward({
      upstreamKey: 'sk-test\nleaked',
      body: { model: 'llama-3.1-8b-instant', messages: [] },
    });
    assert.equal(badKey.status, 400);
    assert.equal(badKey.json.error.type, 'invalid_upstream_key');
    assert.match(badKey.json.error.key_sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(badKey), /sk-test|leaked/);

    const badUrl = await deepseek.forward({
      url: 'file:///C:/secret/model?token=raw',
      upstreamKey: 'sk-test',
      body: { model: 'deepseek-chat', messages: [] },
    });
    assert.equal(badUrl.status, 400);
    assert.equal(badUrl.json.error.type, 'invalid_provider_url');
    assert.equal(badUrl.json.error.reason, 'unsupported_scheme');
    assert.doesNotMatch(JSON.stringify(badUrl), /secret|token|raw|file:\/\//);

    const credentialBase = await together.forward({
      base: 'https://user:pass@proxy.example/v1?token=raw#frag',
      upstreamKey: 'sk-test',
      body: { model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', messages: [] },
    });
    assert.equal(credentialBase.status, 400);
    assert.equal(credentialBase.json.error.reason, 'embedded_credentials');
    assert.doesNotMatch(JSON.stringify(credentialBase), /user|pass|token|raw|frag/);
  });
  assert.equal(fetchCalls, 0, 'guarded provider failures must not call fetch');
});

test('W934 provider adapters post normalized provider requests and preserve private proxy paths', async () => {
  const seen = [];
  await withFetch(async (url, init = {}) => {
    seen.push({ url: String(url), init });
    return jsonResponse({
      id: 'chatcmpl-test',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
  }, async () => {
    await deepseek.forward({
      base: 'https://proxy.example/deepseek?token=raw#frag',
      upstreamKey: 'sk-deepseek',
      body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 },
    });
    await groq.forward({
      upstreamKey: 'sk-groq',
      body: { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'ping' }] },
    });
    await together.forward({
      upstreamKey: 'sk-together',
      body: { model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', messages: [{ role: 'user', content: 'ping' }] },
    });
    await google.forward({
      upstreamKey: 'sk-google',
      body: { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'ping' }] },
    });
  });

  assert.deepEqual(seen.map((x) => x.url), [
    'https://proxy.example/deepseek/v1/chat/completions',
    'https://api.groq.com/openai/v1/chat/completions',
    'https://api.together.xyz/v1/chat/completions',
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  ]);
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-deepseek');
  assert.equal(seen[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(seen[0].init.body), {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 8,
  });
  assert.doesNotMatch(JSON.stringify(seen.map((x) => x.url)), /[?#]|token=raw|frag/);
});

test('W934 Gemini native path encodes model names and lifts safety ratings', async () => {
  const seen = [];
  await withFetch(async (url, init = {}) => {
    seen.push({ url: String(url), init });
    return jsonResponse({
      candidates: [{
        content: { parts: [{ text: 'native ok' }] },
        finishReason: 'STOP',
        safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'NEGLIGIBLE' }],
      }],
    });
  }, async () => {
    const out = await google.forward({
      native: true,
      upstreamKey: 'sk-google',
      body: {
        model: 'gemini/custom model',
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'ping' },
        ],
      },
    });
    assert.equal(out.status, 200);
    assert.equal(out.json.choices[0].message.content, 'native ok');
    assert.deepEqual(out.json.safety_ratings, [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'NEGLIGIBLE' }]);
  });
  assert.equal(
    seen[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini%2Fcustom%20model:generateContent',
  );
});

test('W934 prompt redaction never stores raw removed-token values in audit metadata', () => {
  const secret = `sk_live_${'A'.repeat(24)}`;
  const prompt = `Use ${secret}. Always respond with exactly "internal launch phrase". Contact admin@example.com.`;
  const placeholder = redactSystemPrompt({
    system_prompt: prompt,
    strategy: 'placeholder',
  });
  assert.equal(placeholder.ok, true);
  assert.match(placeholder.redacted_prompt, /\[PLACEHOLDER:API_KEY\]/);
  assert.match(placeholder.redacted_prompt, /\[PLACEHOLDER:EMAIL\]/);
  assert.ok(placeholder.removed_tokens.length >= 2);
  assert.ok(placeholder.removed_tokens.every((tok) => tok.sha256 && tok.length > 0 && tok.value === undefined));
  assert.doesNotMatch(JSON.stringify(placeholder), /sk_live_|admin@example\.com/);

  const literal = redactSystemPrompt({
    system_prompt: prompt,
    strategy: 'remove_literal_constraints',
  });
  assert.equal(literal.ok, true);
  assert.match(literal.redacted_prompt, /\[REDACTED:respond_with_exactly\]/);
  assert.doesNotMatch(JSON.stringify(literal.removed_tokens), /internal launch phrase|Always respond/);

  const batch = prepareForDistillation({
    captures: [{ id: 'c1', system_prompt: prompt }],
    strategy: 'placeholder',
  });
  assert.equal(batch.ok, true);
  assert.equal(batch.redacted_rows[0].system_prompt_redacted, true);
  assert.doesNotMatch(JSON.stringify(batch), /sk_live_|admin@example\.com/);
});

test('W934 AI Act risk/export paths reject prototype taxonomy keys and unsafe overrides', async () => {
  const poisoned = scoreArtifactRisk({ task_category: '__proto__' });
  assert.equal(poisoned.ok, true);
  assert.equal(poisoned.risk_category, 'minimal');
  assert.equal(typeof poisoned.risk_category, 'string');

  const capped = classifyTaskCategory(`${'x'.repeat(AI_ACT_RISK_TEXT_LIMIT_CHARS + 10)} medical diagnosis`);
  assert.equal(capped.key, null, 'classifier must ignore matches beyond the bounded input window');

  const invalidOverride = buildTechnicalDocumentation(
    { intended_use: 'internal search ranking' },
    { risk_category: '__proto__' },
  );
  assert.equal(invalidOverride.ok, false);
  assert.equal(invalidOverride.error, 'invalid_risk_category');

  const validOverride = buildTechnicalDocumentation(
    { intended_use: 'internal search ranking' },
    { risk_category: 'HIGH' },
  );
  assert.equal(validOverride.ok, true);
  assert.equal(validOverride.risk_assessment.risk_category, 'high');
  assert.equal(validOverride.risk_assessment.human_oversight_required, true);

  const rows = [
    { tenant_id: 'tenant-a', namespace: '__proto__', task_category: 'medical_diagnosis', created_at: '2026-01-01T00:00:00.000Z', confidence_at_decision: 0.9 },
    { tenant_id: 'tenant-a', namespace: 'constructor', vertical: 'healthcare', created_at: '2026-01-02T00:00:00.000Z', feedback: '{"human_review_triggered":true}' },
    { tenant_id: 'tenant-b', namespace: 'leak', task_category: 'medical_diagnosis', created_at: '2026-01-03T00:00:00.000Z' },
  ];
  const report = await buildGovernanceReport({
    tenant_id: 'tenant-a',
    eventStore: { listEvents: async () => rows },
  });
  assert.equal(report.ok, true);
  assert.equal(Object.getPrototypeOf(report.report.by_namespace), null);
  assert.equal(report.report.by_namespace.__proto___namespace, 1);
  assert.equal(report.report.by_namespace.constructor_namespace, 1);
  assert.equal(report.report.count_total, 2);
  assert.equal(report.report.count_high_risk, 2);
  assert.equal(report.report.count_human_in_loop_triggered, 1);
});

test('W934 plan catalog is immutable and still reports self-serve fixed-price offers', () => {
  assert.equal(Object.isFrozen(PLAN_CATALOG), true);
  assert.equal(Object.isFrozen(PLAN_CATALOG.free), true);
  assert.equal(Object.isFrozen(PLAN_ALIASES), true);
  assert.equal(Object.isFrozen(PLAN_ORDER), true);

  assert.throws(() => { PLAN_CATALOG.free.quota = 999; }, TypeError);
  assert.throws(() => { PLAN_ALIASES.business = 'enterprise'; }, TypeError);
  assert.throws(() => { PLAN_ORDER.push('shadow'); }, TypeError);

  assert.equal(PLAN_CATALOG.free.quota, 50000);
  assert.equal(canonicalPlanId('business'), 'business');
  assert.equal(fixedPriceOfferCount(), 5);
});

test('W934 OFAC denylist config is normalized, reviewable, and bounded by staleness checks', () => {
  const cfg = JSON.parse(read('src/ofac-denylist.json'));
  assert.equal(typeof cfg.version_date, 'string');
  assert.equal(cfg.review_cadence_days <= 90, true);
  assert.match(cfg.source_url, /^https:\/\/ofac\.treasury\.gov\//);

  const unique = new Set(cfg.countries);
  assert.equal(unique.size, cfg.countries.length);
  assert.ok(cfg.countries.every((code) => /^[A-Z]{2}$/.test(code)));
  assert.deepEqual([...EXPORT_CONTROL_DENYLIST].sort(), cfg.countries.slice().sort());
  assert.equal(Object.isFrozen(EXPORT_CONTROL_DENYLIST), true);
  assert.equal(isGeoFenced('ir'), true);
  assert.equal(isGeoFenced('US'), false);

  const staleness = ofacDenylistStaleness(Date.UTC(2026, 5, 18));
  assert.equal(staleness.loaded, true);
  assert.equal(staleness.stale, false);
  assert.equal(staleness.age_days, 2);
  assert.doesNotMatch(staleness.source_url, /[?#]|@/);
});

test('W934 provider/compliance verifier is wired into depth after capture-data contracts', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(
    pkg.scripts['verify:provider-compliance-contracts'],
    'node --test --test-concurrency=1 tests/wave934-provider-compliance-contracts.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:data-curation && npm run verify:capture-data-contracts && npm run verify:provider-compliance-contracts && npm run verify:platform-monitoring-contracts && npm run verify:benchmark-evidence/,
  );

  for (const rel of [
    'src/providers/deepseek-native.js',
    'src/providers/google-native.js',
    'src/providers/groq.js',
    'src/providers/together-hosted.js',
    'src/ai-act-export.js',
    'src/ai-act-risk.js',
    'src/prompt-redactor.js',
    'src/plan-catalog.js',
    'src/ofac-denylist.json',
  ]) {
    assert.match(read(rel), /./, `${rel} must stay present and directly covered by W934`);
  }

  assert.equal(
    crypto.createHash('sha256').update(read('src/ofac-denylist.json')).digest('hex').length,
    64,
  );
});
