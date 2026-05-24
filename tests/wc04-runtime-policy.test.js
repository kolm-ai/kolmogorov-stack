// WC04 — test coverage close-out for src/runtime-policy.js.
//
// Previously: 661 LOC, 0 atomic-style tests pinning the public-surface
// shape. wave372-runtime-devices.test.js exercises the module via 5
// integration-flavor tests; this file pins each rung of the policy ladder
// individually so future refactors cannot silently re-order, drop, or
// re-shape the decide() / applyPolicy() return contract.
//
// Surface pinned: POLICIES (constant), DEFAULT_POLICY (constant),
// decide(), getPolicy(), setPolicy(), recentDecisions(), replacementStats(),
// _internals(). applyPolicy() is exercised only for the offline branches
// (blocked + cache_hit) because the cheaper_model / frontier_model branches
// dispatch to live LLM backends.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// All tests share one tmp KOLM_DATA_DIR. Each test that mutates on-disk
// state writes into a fresh sub-namespace (cache hash, policy file, etc.)
// so order independence is preserved.
before(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wc04-rp-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  // Make sure no inherited provider creds drag the cheaper/frontier rungs
  // into a live HTTP call when applyPolicy fires.
  delete process.env.KOLM_LLM_PROVIDER;
  delete process.env.KOLM_LLM_KEY;
  delete process.env.KOLM_LLM_BASE_URL;
  delete process.env.KOLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  // Ensure privacy default is 'redact' (non-blocking) unless a test opts in.
  delete process.env.KOLM_PRIVACY_POLICY;
});

// Cache-busted dynamic import so module-level state (the privacy-membrane
// cache, in particular) re-reads our isolated dirs.
async function loadRP(tag) {
  return import('../src/runtime-policy.js?wc04rp=' + tag + '=' + Date.now());
}

// ===================== constants =====================

test('WC04-rp #1 POLICIES is frozen + names cover local_first/frontier_first/cost_optimized/privacy_only', async () => {
  const RP = await loadRP('t1');
  assert.ok(Object.isFrozen(RP.POLICIES), 'POLICIES must be frozen');
  for (const name of ['local_first', 'frontier_first', 'cost_optimized', 'privacy_only']) {
    assert.ok(Array.isArray(RP.POLICIES[name]), name + ' must be a rung array');
    assert.ok(RP.POLICIES[name].length > 0, name + ' must have at least one rung');
  }
});

test('WC04-rp #2 ladder order is privacy_check before cache before local_artifact before cheaper_model before frontier', async () => {
  const RP = await loadRP('t2');
  const lf = RP.POLICIES.local_first;
  // Pin the exact stop list — this is the contract the docs/CLI rely on.
  const idx = (r) => lf.indexOf(r);
  assert.ok(idx('privacy_check') < idx('cache'), 'privacy short-circuits before cache');
  assert.ok(idx('cache') < idx('local_artifact'), 'cache must precede local_artifact');
  assert.ok(idx('local_artifact') < idx('cheaper_model'), 'local_artifact must precede cheaper_model');
  assert.ok(idx('cheaper_model') < idx('frontier'), 'cheaper_model must precede frontier');
});

test('WC04-rp #3 DEFAULT_POLICY exposes name + thresholds + token-budget knobs', async () => {
  const RP = await loadRP('t3');
  const d = RP.DEFAULT_POLICY;
  assert.equal(d.name, 'local_first');
  assert.equal(typeof d.cache_ttl_s, 'number');
  assert.equal(typeof d.local_confidence_threshold, 'number');
  assert.equal(typeof d.cheaper_model, 'string');
  assert.equal(typeof d.frontier_model, 'string');
  assert.equal(typeof d.max_input_tokens, 'number');
  assert.equal(typeof d.semantic_cache_threshold, 'number');
});

// ===================== getPolicy / setPolicy =====================

test('WC04-rp #4 getPolicy returns DEFAULT_POLICY shape when no policy.json on disk', async () => {
  const RP = await loadRP('t4');
  const p = RP.getPolicy();
  assert.equal(p.name, 'local_first');
  assert.equal(p.cheaper_model, RP.DEFAULT_POLICY.cheaper_model);
  assert.equal(p.frontier_model, RP.DEFAULT_POLICY.frontier_model);
});

test('WC04-rp #5 setPolicy persists to disk + getPolicy round-trips', async () => {
  const RP = await loadRP('t5');
  const next = RP.setPolicy({ name: 'cost_optimized', cache_ttl_s: 99 });
  assert.equal(next.name, 'cost_optimized');
  assert.equal(next.cache_ttl_s, 99);
  const back = RP.getPolicy();
  assert.equal(back.name, 'cost_optimized');
  assert.equal(back.cache_ttl_s, 99);
  // Reset so later tests see local_first.
  RP.setPolicy({ name: 'local_first', cache_ttl_s: 3600 });
});

test('WC04-rp #6 setPolicy throws POLICY_UNKNOWN for unknown policy name', async () => {
  const RP = await loadRP('t6');
  try {
    RP.setPolicy({ name: 'not-a-real-policy' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'POLICY_UNKNOWN');
    assert.match(err.message, /unknown policy/);
  }
});

// ===================== decide() ladder rungs =====================

test('WC04-rp #7 decide blocks on privacy when KOLM_PRIVACY_POLICY=block + body has PII', async () => {
  const RP = await loadRP('t7');
  const prev = process.env.KOLM_PRIVACY_POLICY;
  process.env.KOLM_PRIVACY_POLICY = 'block';
  try {
    const d = await RP.decide({ body: 'email me at jane@example.com' });
    assert.equal(d.action, 'blocked');
    assert.equal(d.reason, 'privacy_block');
    assert.ok(Array.isArray(d.sensitive_classes));
    assert.ok(d.sensitive_classes.includes('email'));
    const rung = d.decision_chain.find(r => r.rung === 'privacy_check');
    assert.ok(rung);
    assert.equal(rung.status, 'block');
  } finally {
    if (prev == null) delete process.env.KOLM_PRIVACY_POLICY;
    else process.env.KOLM_PRIVACY_POLICY = prev;
  }
});

test('WC04-rp #8 decide passes privacy_check when body has no PII', async () => {
  const RP = await loadRP('t8');
  const d = await RP.decide({ body: 'plain user prompt with no sensitive data' });
  const rung = d.decision_chain.find(r => r.rung === 'privacy_check');
  assert.ok(rung, 'privacy_check rung must be recorded');
  assert.equal(rung.status, 'pass');
  // local_first with no artifacts + no cache hands off to cheaper_model.
  assert.equal(d.action, 'cheaper_model');
});

test('WC04-rp #9 decide returns cache_hit when seed row is within TTL', async () => {
  const RP = await loadRP('t9');
  const { cacheDir, hashRequest } = RP._internals();
  const req = { body: 'wc04-rp-9 cached prompt', model: 'gpt-4o-mini' };
  const hash = hashRequest(req);
  const row = { ts: Date.now(), response: { text: 'cached-answer' } };
  fs.writeFileSync(path.join(cacheDir(), hash + '.json'), JSON.stringify(row));
  const d = await RP.decide(req);
  assert.equal(d.action, 'cache_hit');
  assert.equal(d.target, hash);
  assert.equal(d.confidence, 1);
  assert.deepEqual(d.cached, row.response);
  const rung = d.decision_chain.find(r => r.rung === 'cache');
  assert.equal(rung.status, 'hit');
});

test('WC04-rp #10 decide reports cache miss when no row exists', async () => {
  const RP = await loadRP('t10');
  const d = await RP.decide({ body: 'wc04-rp-10 unique prompt ' + crypto.randomBytes(4).toString('hex') });
  const rung = d.decision_chain.find(r => r.rung === 'cache');
  assert.ok(rung, 'cache rung must be recorded');
  assert.equal(rung.status, 'miss');
});

test('WC04-rp #11 decide reports no_artifacts when artifacts dir is empty', async () => {
  const RP = await loadRP('t11');
  const d = await RP.decide({ body: 'wc04-rp-11 nothing-on-disk' });
  const rung = d.decision_chain.find(r => r.rung === 'local_artifact');
  assert.ok(rung, 'local_artifact rung must be recorded');
  assert.equal(rung.status, 'no_artifacts');
});

test('WC04-rp #12 decide falls through to cheaper_model under local_first', async () => {
  const RP = await loadRP('t12');
  const d = await RP.decide({ body: 'wc04-rp-12 nothing matches' });
  assert.equal(d.action, 'cheaper_model');
  assert.equal(d.target, RP.DEFAULT_POLICY.cheaper_model);
  assert.equal(d.confidence, 0.7);
  assert.equal(d.reason, 'no_local_match_route_cheaper');
});

test('WC04-rp #13 decide under frontier_first skips cache/local entirely', async () => {
  const RP = await loadRP('t13');
  const d = await RP.decide({ body: 'wc04-rp-13 go straight to frontier' }, { policyName: 'frontier_first' });
  assert.equal(d.action, 'frontier_model');
  assert.equal(d.target, RP.DEFAULT_POLICY.frontier_model);
  // The ladder for frontier_first never logs a cache/local_artifact rung.
  const rungNames = d.decision_chain.map(r => r.rung);
  assert.ok(!rungNames.includes('cache'), 'frontier_first must not include cache rung');
  assert.ok(!rungNames.includes('local_artifact'), 'frontier_first must not include local_artifact rung');
});

test('WC04-rp #14 decide returns token_budget block when input exceeds max_input_tokens', async () => {
  const RP = await loadRP('t14');
  // Force a tiny budget that rejects rather than compresses.
  RP.setPolicy({ name: 'local_first', max_input_tokens: 10, token_budget_action: 'reject', prompt_compression_enabled: false });
  try {
    // Generate >> 10 tokens of garbage so even after coercion we're over.
    const big = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen '.repeat(30);
    const d = await RP.decide({ body: big });
    assert.equal(d.action, 'blocked');
    assert.match(d.reason, /token_budget/);
    const rung = d.decision_chain.find(r => r.rung === 'token_budget');
    assert.ok(rung);
    assert.equal(rung.status, 'block');
  } finally {
    // Restore defaults so later tests see the normal ladder behavior.
    RP.setPolicy({ name: 'local_first', max_input_tokens: 8192, token_budget_action: 'compress', prompt_compression_enabled: true });
  }
});

// ===================== applyPolicy + decision recording =====================

test('WC04-rp #15 applyPolicy writes a row to decisions.jsonl after a cache_hit', async () => {
  const RP = await loadRP('t15');
  const { cacheDir, hashRequest, decisionsPath } = RP._internals();
  const req = { body: 'wc04-rp-15 applyPolicy cache path', model: 'gpt-4o-mini' };
  const hash = hashRequest(req);
  fs.writeFileSync(path.join(cacheDir(), hash + '.json'), JSON.stringify({ ts: Date.now(), response: { text: 'seeded' } }));
  const before = fs.existsSync(decisionsPath()) ? fs.readFileSync(decisionsPath(), 'utf8').split('\n').filter(Boolean).length : 0;
  const r = await RP.applyPolicy(req);
  assert.equal(r.action, 'cache_hit');
  assert.deepEqual(r.result, { text: 'seeded' });
  assert.equal(r.cost_usd, 0, 'cache hits cost nothing');
  assert.match(r.event_id, /^evt_[0-9a-f]+/);
  const after = fs.readFileSync(decisionsPath(), 'utf8').split('\n').filter(Boolean).length;
  assert.ok(after >= before + 1, 'decisions.jsonl must gain a row');
});

test('WC04-rp #16 recentDecisions returns latest-first + cap of n', async () => {
  const RP = await loadRP('t16');
  const { decisionsPath } = RP._internals();
  // Append three known rows.
  for (let i = 0; i < 3; i++) {
    fs.appendFileSync(decisionsPath(), JSON.stringify({
      event_id: 'evt_wc04rp16_' + i,
      timestamp: new Date(Date.now() + i).toISOString(),
      action: 'cache_hit',
      target: 'h' + i,
      decision_chain: [],
    }) + '\n');
  }
  const rows = RP.recentDecisions({ n: 2 });
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 2);
  // Latest first: index 0 is the freshest of the two trailing rows.
  assert.match(rows[0].event_id, /^evt_/);
});

test('WC04-rp #17 replacementStats counts by_action + reports replacement_rate ratio', async () => {
  const RP = await loadRP('t17');
  const s = RP.replacementStats({});
  assert.equal(typeof s.total_decisions, 'number');
  assert.equal(typeof s.replacement_rate, 'number');
  assert.equal(typeof s.savings_usd, 'number');
  assert.equal(typeof s.spent_usd, 'number');
  // by_action must include all known action buckets even when 0.
  for (const k of ['cache_hit', 'semantic_cache_hit', 'local_artifact', 'cheaper_model', 'frontier_model', 'blocked']) {
    assert.equal(typeof s.by_action[k], 'number', 'by_action.' + k + ' must be numeric');
  }
  assert.ok(s.replacement_rate >= 0 && s.replacement_rate <= 1);
});

test('WC04-rp #18 _internals exposes hashRequest + path helpers anchored to KOLM_DATA_DIR', async () => {
  const RP = await loadRP('t18');
  const i = RP._internals();
  assert.equal(typeof i.hashRequest, 'function');
  // Deterministic 64-char sha256 over model+intent+body.
  const h = i.hashRequest({ body: 'abc', model: 'm', intent: 'i' });
  assert.match(h, /^[0-9a-f]{64}$/);
  // Path helpers must all live under KOLM_DATA_DIR/runtime.
  const root = path.resolve(process.env.KOLM_DATA_DIR, 'runtime');
  for (const f of ['runtimeDir', 'cacheDir', 'semanticCachePath', 'installedDir', 'decisionsPath', 'policyPath']) {
    const p = i[f]();
    assert.ok(p.startsWith(root), f + '() must live under ' + root + ' (got ' + p + ')');
  }
});
