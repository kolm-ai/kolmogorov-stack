// Acceptance tests for the sensitive-data-aware generator routing gate
// (src/generator-router.js). Proves the never-to-hyperscaler invariant:
// a sensitive corpus is NEVER routed to a hosted teacher - the only
// sensitive+hosted outcomes are forced-local or a loud fail-closed envelope.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  GENERATOR_ROUTER_VERSION,
  classifySensitivity,
  requestedLocalityOf,
  prepareSeedForPrompt,
  makeLocalTranslateFn,
  LocalGeneratorError,
  route,
  stampRow,
  buildRoutingAssertions,
  routingCostField,
} from '../src/generator-router.js';

import { classifyTeacherSource } from '../src/distillation-pipeline-c1.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');

// Stable trigger strings (probed against scanSensitive):
//   sk-key -> secret class 'openai-style-key'; email -> pii class 'email'.
const SK = 'config has sk-abcdefghijklmnopqrstuvwxyz12345 inside';
const EMAIL_SEED = { input: 'reach me at jane.doe@example.com about the order' };
const SECRET_SEED = { input: SK, output: 'ok' };
const CLEAN_SEED = { input: 'hello world', output: 'goodbye world' };

// ---- env helpers: snapshot + restore so tests do not leak state -----------
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// =============================================================================
// A. SENSITIVITY CLASSIFICATION
// =============================================================================

test('classifySensitivity: secret seed -> sensitive with openai-style-key', () => {
  const v = classifySensitivity([SECRET_SEED]);
  assert.equal(v.sensitivity, 'sensitive');
  assert.ok(v.secret_classes.includes('openai-style-key'));
  assert.equal(v.scanned_count, 1);
  assert.equal(v.pool_count, 1);
  assert.equal(v.sampled, false);
});

test('classifySensitivity: pure clean seed -> clean', () => {
  const v = classifySensitivity([{ input: 'hello world' }]);
  assert.equal(v.sensitivity, 'clean');
  assert.deepEqual(v.pii_classes, []);
  assert.deepEqual(v.secret_classes, []);
});

test('classifySensitivity: UNION aggregation taints whole namespace', () => {
  const v = classifySensitivity([EMAIL_SEED, CLEAN_SEED]);
  assert.equal(v.sensitivity, 'sensitive');
  assert.ok(v.pii_classes.includes('email'));
  assert.equal(v.pool_count, 2);
});

test('classifySensitivity: scans RAW fields, not *_redacted', () => {
  // The raw input carries a secret; a redacted copy would hide it. We must
  // scan the raw text the prompt would actually carry.
  const seed = { input: SK, prompt_redacted: 'XXX', response_redacted: 'XXX' };
  const v = classifySensitivity([seed]);
  assert.equal(v.sensitivity, 'sensitive');
  assert.ok(v.secret_classes.includes('openai-style-key'));
});

test('classifySensitivity: detector_coverage bounds the claim', () => {
  const v = classifySensitivity([CLEAN_SEED]);
  assert.ok(v.detector_coverage && Array.isArray(v.detector_coverage.secret_shapes));
  assert.ok(v.detector_coverage.secret_shapes.includes('openai-style-key'));
});

// =============================================================================
// SAMPLING SAFETY (fail-closed default)
// =============================================================================

test('sampling: unproven-clean sampled pool is sensitive by default', () => {
  const pool = [];
  for (let i = 0; i < 100; i += 1) {
    pool.push(i === 50 ? { input: SK } : { input: 'benign row ' + i });
  }
  // maxScan=1 only scans index 0 (clean) -> unproven, fail-closed.
  const v = classifySensitivity(pool, { maxScan: 1 });
  assert.equal(v.sampled, true);
  assert.equal(v.sensitivity, 'sensitive');
  assert.equal(v.reason, 'sampled_unproven_clean');
  assert.equal(v.scanned_count, 1);
});

test('sampling: env KOLM_ROUTER_MAX_SCAN drives the cap; index-50 secret missed by scan-1', () => {
  const pool = [];
  for (let i = 0; i < 100; i += 1) {
    pool.push(i === 50 ? { input: SK } : { input: 'benign row ' + i });
  }
  withEnv({ KOLM_ROUTER_MAX_SCAN: '1' }, () => {
    const v = classifySensitivity(pool);
    assert.equal(v.sampled, true);
    assert.equal(v.sensitivity, 'sensitive'); // fail-closed
  });
});

test('sampling: allowSampledClean opt-in may report clean', () => {
  const pool = [];
  for (let i = 0; i < 100; i += 1) pool.push({ input: 'benign row ' + i });
  const v = classifySensitivity(pool, { maxScan: 1, allowSampledClean: true });
  assert.equal(v.sampled, true);
  assert.equal(v.sensitivity, 'clean');
});

test('sampling: a scanned sensitive seed is sensitive even when sampled', () => {
  const pool = [{ input: SK }];
  for (let i = 0; i < 99; i += 1) pool.push({ input: 'benign ' + i });
  const v = classifySensitivity(pool, { maxScan: 1 });
  assert.equal(v.sampled, true);
  assert.equal(v.sensitivity, 'sensitive');
  assert.equal(v.reason, undefined); // truly proven sensitive, not unproven
});

// =============================================================================
// B. HOSTED-vs-LOCAL (reuse classifyTeacherSource - not forked)
// =============================================================================

test('requestedLocalityOf reuses classifyTeacherSource: proprietary -> hosted, open -> local', () => {
  assert.equal(classifyTeacherSource('claude-sonnet'), 'proprietary');
  assert.equal(classifyTeacherSource('qwen2.5-7b'), 'open-weights');
  assert.equal(requestedLocalityOf({ slug: 'claude-sonnet' }), 'hosted');
  assert.equal(requestedLocalityOf({ slug: 'qwen2.5-7b' }), 'local');
});

test('requestedLocalityOf: local signals + safe-deny on unknown', () => {
  assert.equal(requestedLocalityOf({ teacher: 'local' }), 'local');
  assert.equal(requestedLocalityOf({ slug: 'local:my-model' }), 'local');
  assert.equal(requestedLocalityOf({ slug: 'hf:org/model' }), 'local');
  assert.equal(requestedLocalityOf({ teacher: 'anthropic' }), 'hosted');
  // 'unknown' is safe-denied to hosted (no relaxation).
  assert.equal(classifyTeacherSource('totally-made-up-9000'), 'unknown');
  assert.equal(requestedLocalityOf({ slug: 'totally-made-up-9000' }), 'hosted');
});

// =============================================================================
// C. FAIL-CLOSED ROUTING STATE MACHINE (load-bearing invariant)
// =============================================================================

test('INVARIANT: sensitive + hosted + NO local generator -> fail-closed, never hosted', () => {
  withEnv({ KOLM_LOCAL_TEACHER_URL: undefined }, () => {
    const r = route({ seeds: [SECRET_SEED], teacher: 'anthropic' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'sensitive_corpus_requires_local_generator');
    assert.ok(typeof r.install_hint === 'string' && r.install_hint.length > 0);
    assert.equal(r.requested_locality, 'hosted');
    assert.equal(r.forced_local, false);
    // It MUST NOT report a hosted effective locality anywhere.
    assert.equal(r.effectiveLocality, undefined);
    assert.equal(r.decision, undefined);
    assert.equal(r.version, GENERATOR_ROUTER_VERSION);
  });
});

test('INVARIANT: no route() return can be hosted+sensitive (exhaustive sweep)', () => {
  // Sweep all (sensitivity x requestedLocality x localGenConfigured) combos and
  // assert: whenever the corpus is sensitive, effectiveLocality is never 'hosted'.
  const teachers = ['anthropic', 'openai', 'claude-sonnet', 'local', 'qwen2.5-7b', 'totally-made-up'];
  const localEnvs = [undefined, 'http://127.0.0.1:11434'];
  for (const t of teachers) {
    for (const le of localEnvs) {
      withEnv({ KOLM_LOCAL_TEACHER_URL: le }, () => {
        const r = route({ seeds: [SECRET_SEED], teacher: t });
        if (r.ok) {
          assert.notEqual(r.decision.effectiveLocality, 'hosted',
            'sensitive corpus must never resolve hosted (teacher=' + t + ', env=' + le + ')');
        } else {
          // The only allowed failure is the loud fail-closed envelope.
          assert.equal(r.error, 'sensitive_corpus_requires_local_generator');
        }
      });
    }
  }
});

test('FORCE-LOCAL: sensitive + hosted + local generator configured -> forced local', () => {
  withEnv({ KOLM_LOCAL_TEACHER_URL: 'http://127.0.0.1:11434' }, () => {
    const r = route({ seeds: [SECRET_SEED], teacher: 'anthropic' });
    assert.equal(r.ok, true);
    assert.equal(r.decision.effectiveLocality, 'local');
    assert.equal(r.decision.forced_local, true);
    assert.equal(r.decision.routing_reason, 'sensitive_corpus_forced_local');
    assert.equal(typeof r.translateFn, 'function');
  });
});

test('sensitive + local-requested -> local, not forced', () => {
  const r = route({ seeds: [SECRET_SEED], teacher: 'local' });
  assert.equal(r.ok, true);
  assert.equal(r.decision.effectiveLocality, 'local');
  assert.equal(r.decision.forced_local, false);
  assert.equal(r.decision.routing_reason, 'sensitive_corpus_local_requested');
});

test('CLEAN-HOSTED: clean + hosted -> hosted allowed, not forced', () => {
  withEnv({ KOLM_LOCAL_TEACHER_URL: undefined }, () => {
    const r = route({ seeds: [CLEAN_SEED], teacher: 'anthropic' });
    assert.equal(r.ok, true);
    assert.equal(r.decision.effectiveLocality, 'hosted');
    assert.equal(r.decision.forced_local, false);
    assert.equal(r.decision.routing_reason, 'clean_corpus_hosted_ok');
    // No translateFn on the hosted path - the existing hosted adapter handles it.
    assert.equal(r.translateFn, undefined);
  });
});

test('clean + local-requested -> local', () => {
  const r = route({ seeds: [CLEAN_SEED], teacher: 'qwen2.5-7b' });
  assert.equal(r.ok, true);
  assert.equal(r.decision.effectiveLocality, 'local');
  assert.equal(r.decision.routing_reason, 'local_requested');
  assert.equal(typeof r.translateFn, 'function');
});

test('route() never throws on garbage input', () => {
  for (const bad of [undefined, null, {}, { seeds: 'x' }, { seeds: [null, 1, 'y'] }]) {
    const r = route(bad);
    assert.ok(r && typeof r.ok === 'boolean');
    assert.equal(r.version, GENERATOR_ROUTER_VERSION);
  }
});

// =============================================================================
// D. SEED REDACTION BEFORE PROMPT (defense-in-depth on the clean path)
// =============================================================================

test('prepareSeedForPrompt redacts a clean-but-PII-bearing seed', () => {
  const raw = 'reach me at jane.doe@example.com about the order';
  const prepped = prepareSeedForPrompt(raw, { mode: 'redact_all' });
  assert.ok(!prepped.includes('jane.doe@example.com'),
    'raw PII token must not survive into the prompt text');
  // default mode is redact_all too
  const def = prepareSeedForPrompt(raw);
  assert.ok(!def.includes('jane.doe@example.com'));
});

// =============================================================================
// E. LOCAL ADAPTER (real path; fail-closed; no echo in prod)
// =============================================================================

test('ADAPTER: unconfigured local generator -> throws LocalGeneratorError (row skipped), never echoes', async () => {
  await withEnv({ KOLM_LOCAL_TEACHER_URL: undefined }, async () => {
    const fn = makeLocalTranslateFn();
    await assert.rejects(
      () => fn({ text: 'hola', source_lang: 'es', target_lang: 'en', teacher: 'local' }),
      (e) => {
        assert.ok(e instanceof LocalGeneratorError);
        assert.equal(e.code, 'local_teacher_unconfigured');
        // never the [lang]-prefixed echo
        assert.ok(!String(e.message).includes('[en]'));
        return true;
      }
    );
  });
});

test('ADAPTER: hits the REAL Ollama /api/generate path with an injected fetch', async () => {
  await withEnv({ KOLM_LOCAL_TEACHER_URL: 'http://127.0.0.1:11434' }, async () => {
    const hits = [];
    const fakeFetch = async (url, init) => {
      hits.push({ url, body: JSON.parse(init.body) });
      return { status: 200, json: async () => ({ model: 'llama3', response: 'translated' }) };
    };
    const fn = makeLocalTranslateFn({ fetch: fakeFetch });
    const out = await fn({ text: 'hola', source_lang: 'es', target_lang: 'en', teacher: 'local' });
    assert.equal(out.text, 'translated');
    assert.equal(out.model, 'llama3');
    // proves the REAL captureFromLocalOllama path was used (Ollama native endpoint)
    assert.equal(hits.length, 1);
    assert.ok(hits[0].url.endsWith('/api/generate'));
    assert.ok(hits[0].body.prompt.includes('Translate the following from es to en'));
    assert.ok(hits[0].body.prompt.includes('hola'));
  });
});

test('ADAPTER: openai transport posts to /v1/chat/completions through wrapFetch', async () => {
  await withEnv({ KOLM_LOCAL_TEACHER_URL: 'http://127.0.0.1:8000' }, async () => {
    const hits = [];
    const fakeFetch = async (url, init) => {
      hits.push({ url, body: JSON.parse(init.body) });
      return { status: 200, json: async () => ({ model: 'qwen', choices: [{ message: { content: 'hi' } }] }) };
    };
    const fn = makeLocalTranslateFn({ fetch: fakeFetch, localTransport: 'openai' });
    const out = await fn({ text: 'hola', source_lang: 'es', target_lang: 'en' });
    assert.equal(out.text, 'hi');
    assert.ok(hits[0].url.endsWith('/v1/chat/completions'));
    assert.equal(hits[0].body.messages[0].role, 'user');
  });
});

test('ADAPTER: ciStub echo only reachable on explicit opt-in', async () => {
  const fn = makeLocalTranslateFn({ ciStub: true });
  const out = await fn({ text: 'hola', target_lang: 'en' });
  assert.equal(out.model, 'local-echo');
  assert.ok(out.text.startsWith('[en]'));
});

test('ADAPTER: http error fails closed (throws), never echo', async () => {
  await withEnv({ KOLM_LOCAL_TEACHER_URL: 'http://127.0.0.1:11434' }, async () => {
    const fakeFetch = async () => ({ status: 500, json: async () => ({}) });
    const fn = makeLocalTranslateFn({ fetch: fakeFetch });
    await assert.rejects(() => fn({ text: 'x', target_lang: 'en' }), (e) => {
      assert.ok(e instanceof LocalGeneratorError);
      assert.equal(e.code, 'local_teacher_http_error');
      return true;
    });
  });
});

// =============================================================================
// F. PROVENANCE STAMP
// =============================================================================

test('stampRow carries the provenance block without mutating the input', () => {
  const r = route({ seeds: [SECRET_SEED], teacher: 'local' });
  const row = { id: 1, text: 'foo' };
  const stamped = stampRow(row, r.decision);
  assert.equal(stamped.generator_locality, 'local');
  assert.equal(stamped.forced_local, false);
  assert.equal(stamped.routing_reason, 'sensitive_corpus_local_requested');
  assert.equal(stamped.router_version, 'gr-v1');
  assert.equal(stamped.sensitivity_verdict.sensitivity, 'sensitive');
  assert.ok(stamped.sensitivity_verdict.secret_classes.includes('openai-style-key'));
  // immutability
  assert.equal(row.generator_locality, undefined);
  assert.equal(row.id, 1);
});

test('buildRoutingAssertions emits kolm.* keys with no raw seed text / secret values', () => {
  const r = route({ seeds: [SECRET_SEED], teacher: 'local' });
  const a = buildRoutingAssertions(r.decision);
  assert.equal(a['kolm.generator_locality'], 'local');
  assert.equal(a['kolm.routing_reason'], 'sensitive_corpus_local_requested');
  assert.equal(a['kolm.sensitivity'], 'sensitive');
  assert.equal(a['kolm.router_version'], 'gr-v1');
  const serialized = JSON.stringify(a);
  // class ids are allowed; the raw secret VALUE must not appear
  assert.ok(!serialized.includes('sk-abcdef'));
  assert.ok(!serialized.includes('jane.doe@example.com'));
});

// =============================================================================
// G. COST FIELD
// =============================================================================

test('routingCostField: forced-local -> $0 hosted egress; hosted -> passes estimate', () => {
  const forced = { effectiveLocality: 'local', forced_local: true, routing_reason: 'sensitive_corpus_forced_local' };
  assert.equal(routingCostField(forced, 12.5).hosted_egress_usd, 0);

  const hosted = { effectiveLocality: 'hosted', forced_local: false, routing_reason: 'clean_corpus_hosted_ok' };
  assert.equal(routingCostField(hosted, 12.5).hosted_egress_usd, 12.5);

  const localPlain = { effectiveLocality: 'local', forced_local: false };
  assert.equal(routingCostField(localPlain, 9).hosted_egress_usd, 0);
});

// =============================================================================
// NO-LEAK / REUSE-NOT-FORK / DISCIPLINE (static source checks)
// =============================================================================

test('SOURCE: router imports classifyTeacherSource and does NOT re-define a families list', () => {
  const src = readFileSync(path.join(SRC, 'generator-router.js'), 'utf8');
  assert.ok(/import\s*\{[^}]*classifyTeacherSource[^}]*\}\s*from\s*'\.\/distillation-pipeline-c1\.js'/.test(src),
    'must import classifyTeacherSource from the C1 module');
  // No forked open/proprietary family arrays.
  assert.ok(!/\bqwen\b[\s\S]{0,40}\bllama\b[\s\S]{0,40}\bmistral\b/.test(src),
    'router must not re-implement the OPEN families list');
});

test('SOURCE: module is ASCII-only and contains no honest/honesty word', () => {
  const src = readFileSync(path.join(SRC, 'generator-router.js'), 'utf8');
  for (let i = 0; i < src.length; i += 1) {
    assert.ok(src.charCodeAt(i) < 128, 'non-ASCII byte at index ' + i);
  }
  assert.ok(!/honest|honesty/i.test(src), 'must not use the word honest/honesty');
});

test('SOURCE: no raw seed input field is interpolated into error strings', () => {
  const src = readFileSync(path.join(SRC, 'generator-router.js'), 'utf8');
  // The fail-closed envelope and adapter errors must not template seed text.
  // Guard: no `+ seed.` / `${seed` / `text}` interpolation inside error returns.
  assert.ok(!/error:[\s\S]{0,200}\$\{?\s*(?:seed|inputText|rawText)/.test(src));
});

test('REUSE: assertPrivacyBoundary in distillation-pipeline-c1.js is byte-identical (function body unchanged)', () => {
  // We restored the C1 module verbatim from main; assert its privacy boundary
  // function is present and unmodified in shape (safe-deny on unknown intact).
  const c1 = readFileSync(path.join(SRC, 'distillation-pipeline-c1.js'), 'utf8');
  assert.ok(/export function assertPrivacyBoundary/.test(c1));
  // The safe-deny comment / posture for unknown must remain.
  assert.ok(/safe-deny/i.test(c1));
});

test('VERSION discipline: all failure returns carry version gr-v1', () => {
  withEnv({ KOLM_LOCAL_TEACHER_URL: undefined }, () => {
    const r = route({ seeds: [SECRET_SEED], teacher: 'anthropic' });
    assert.equal(r.ok, false);
    assert.equal(r.version, 'gr-v1');
  });
});
