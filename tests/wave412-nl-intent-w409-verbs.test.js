// W412 — natural-language intent classifier learns the W409 canonical
// control-plane verbs (lake / opportunities / dataset / labels / bakeoff),
// and `kolm next` reads from the canonical lake + opportunity engine so its
// recommendations route through the same source the optimizer sees.
//
// Standing rule: tests assert behavior (verb → routed verb, snapshot field
// presence, recommend output shape) — never page copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyIntent,
  VERB_DESCRIPTIONS,
  listVerbs,
  snapshotContext,
  recommendNext,
} from '../src/intent.js';

// =============================================================================
// 1) The five W409 verbs are listed in VERB_DESCRIPTIONS.
// =============================================================================

test('W412 #1 — VERB_DESCRIPTIONS includes the W409 canonical verbs', () => {
  const verbs = listVerbs();
  for (const need of ['lake', 'opportunities', 'dataset', 'labels', 'bakeoff']) {
    assert.ok(verbs.includes(need), 'VERB_DESCRIPTIONS must list verb: ' + need);
  }
});

// =============================================================================
// 2) Lake routings: spend / usage / how-much questions hit `kolm lake`.
// =============================================================================

test('W412 #2 — natural-language spend questions route to lake', async () => {
  for (const q of [
    'how much am I spending',
    'show spend',
    'show usage',
    'lake stats',
    'show telemetry',
  ]) {
    const r = await classifyIntent(q, {});
    assert.equal(r.verb, 'lake', `"${q}" must route to lake, got ${r.verb} (source=${r.source})`);
  }
});

// =============================================================================
// 3) Opportunity routings: duplicate / savings / leaks → `kolm opportunities`.
// =============================================================================

test('W412 #3 — duplicate / savings / leak questions route to opportunities', async () => {
  for (const q of [
    'find duplicate calls',
    'find savings',
    'duplicate prompts',
    'find leaks',
    'find waste',
    'where can i save',
  ]) {
    const r = await classifyIntent(q, {});
    assert.equal(r.verb, 'opportunities', `"${q}" must route to opportunities, got ${r.verb}`);
  }
});

// =============================================================================
// 4) Dataset / labels / bakeoff routings.
// =============================================================================

test('W412 #4 — dataset / labels / bakeoff intents route correctly', async () => {
  const cases = [
    ['create dataset', 'dataset'],
    ['make dataset', 'dataset'],
    ['list datasets', 'dataset'],
    ['label queue', 'labels'],
    ['reviewer queue', 'labels'],
    ['pending reviews', 'labels'],
    ['compare models', 'bakeoff'],
    ['cheapest model', 'bakeoff'],
    ['bake off', 'bakeoff'],
  ];
  for (const [q, want] of cases) {
    const r = await classifyIntent(q, {});
    assert.equal(r.verb, want, `"${q}" must route to ${want}, got ${r.verb}`);
  }
});

// =============================================================================
// 5) snapshotContext carries the new lake + opportunities + datasets fields,
//    even when no data is present (counts are 0, arrays are empty).
// =============================================================================

test('W412 #5 — snapshotContext exposes lake/opportunities/datasets fields', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w412-'));
  try {
    const snap = await snapshotContext({ cwd: home, home });
    // Sandbox mode skips capture-store + lake module, so the fields are at
    // their declared defaults: null lake, empty arrays for opportunities and
    // datasets. The KEY behavior is that the fields exist (so the recommender
    // can branch on them without `undefined`-checks).
    assert.ok('lake' in snap, 'snapshot must include lake field');
    assert.ok('opportunities' in snap, 'snapshot must include opportunities field');
    assert.ok('datasets' in snap, 'snapshot must include datasets field');
    assert.ok('opportunities' in snap.counts, 'counts.opportunities must exist');
    assert.ok('datasets' in snap.counts, 'counts.datasets must exist');
    assert.equal(snap.counts.opportunities, 0);
    assert.equal(snap.counts.datasets, 0);
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

// =============================================================================
// 6) recommendNext surfaces a privacy_leak suggestion above the money path.
// =============================================================================

test('W412 #6 — recommendNext prioritizes privacy_leak over savings', () => {
  const snap = {
    counts: { artifacts: 1, captures: 1000, namespaces: 1, jobs: 0, opportunities: 2, datasets: 0 },
    artifacts: [{ name: 'phi-redactor.kolm', path: '/x/phi-redactor.kolm', k_score: 0.93 }],
    captures_summary: [{ namespace: 'support', count: 1000, last_seen: '2026-05-19' }],
    jobs: [],
    config: { api_key: 'ks_x' },
    lake: { total_calls: 1000, total_spend_usd: 42, top_provider: 'openai', top_model: 'gpt-4o' },
    opportunities: [
      { id: 'opp_money', type: 'duplicate_call_clusters', namespace: 'support', estimated_savings_usd: 19.50, volume: 200, score: 0.8 },
      { id: 'opp_leak',  type: 'privacy_leak',           namespace: 'support', estimated_savings_usd: 0,    volume: 5,   score: 0.95 },
    ],
    datasets: [],
  };
  const recs = recommendNext(snap);
  // privacy_leak must outrank the dollar-savings path.
  const idxLeak = recs.findIndex(r => r.action === 'fix_privacy_leak');
  const idxMoney = recs.findIndex(r => r.action === 'promote_opportunity');
  assert.ok(idxLeak >= 0, 'recommend must include fix_privacy_leak');
  assert.ok(idxMoney >= 0, 'recommend must include promote_opportunity');
  assert.ok(idxLeak < idxMoney, 'privacy_leak must rank above the money path');
  assert.ok(recs[idxMoney].command.startsWith('kolm opportunities promote opp_money'),
    'money rec wires to the specific opp id, got: ' + recs[idxMoney].command);
});

// =============================================================================
// 7) recommendNext surfaces a bake-off when a dataset exists with holdout.
// =============================================================================

test('W412 #7 — recommendNext suggests bakeoff when a dataset has a holdout', () => {
  const snap = {
    counts: { artifacts: 1, captures: 1, namespaces: 1, jobs: 0, opportunities: 0, datasets: 1 },
    artifacts: [{ name: 'a.kolm', path: '/x/a.kolm', k_score: 0.95 }],
    captures_summary: [{ namespace: 'support', count: 1, last_seen: '2026-05-19' }],
    jobs: [],
    config: { api_key: 'ks_x' },
    lake: null,
    opportunities: [],
    datasets: [{ id: 'ds_abc', namespace: 'support', train_count: 80, holdout_count: 20 }],
  };
  const recs = recommendNext(snap);
  const bake = recs.find(r => r.action === 'run_bakeoff');
  assert.ok(bake, 'recommend must include run_bakeoff when a dataset has holdout');
  assert.ok(bake.command.includes('ds_abc'), 'bakeoff command must reference the specific dataset id');
});

// =============================================================================
// 8) recommendNext surfaces a lake review when spend > 0 (mid-rank).
// =============================================================================

test('W412 #8 — recommendNext surfaces lake stats once spend is non-zero', () => {
  const snap = {
    counts: { artifacts: 0, captures: 50, namespaces: 1, jobs: 0, opportunities: 0, datasets: 0 },
    artifacts: [],
    captures_summary: [{ namespace: 'support', count: 50, last_seen: '2026-05-19' }],
    jobs: [],
    config: { api_key: 'ks_x' },
    lake: { total_calls: 50, total_spend_usd: 4.12, top_provider: 'openai', top_model: 'gpt-4o' },
    opportunities: [],
    datasets: [],
  };
  const recs = recommendNext(snap);
  const lake = recs.find(r => r.action === 'review_lake');
  assert.ok(lake, 'recommend must surface review_lake when spend > 0');
  assert.ok(lake.command === 'kolm lake stats', 'review_lake command must be `kolm lake stats`');
});

// =============================================================================
// 9) When all canonical fields are empty, the recommender still returns at
//    least one suggestion (the show_dashboard fallback).
// =============================================================================

test('W412 #9 — recommender always returns at least one suggestion', () => {
  const snap = {
    counts: { artifacts: 0, captures: 0, namespaces: 0, jobs: 0, opportunities: 0, datasets: 0 },
    artifacts: [], captures_summary: [], jobs: [], config: { api_key: 'ks_x' },
    lake: null, opportunities: [], datasets: [],
  };
  const recs = recommendNext(snap);
  assert.ok(recs.length >= 1, 'recommender must always return at least one suggestion');
  // With no API key removed, the build-first-artifact suggestion will appear.
  assert.ok(recs.some(r => r.action === 'build_first_artifact' || r.action === 'show_dashboard'),
    'first-time user must see either build_first_artifact or show_dashboard');
});

// =============================================================================
// 10) classifyIntent never throws — even on empty / nonsense input.
// =============================================================================

test('W412 #10 — classifyIntent is total over arbitrary input', async () => {
  for (const q of ['', '?', '...', 'asdf qwer zxcv', 'lake', 'opportunities --namespace x']) {
    const r = await classifyIntent(q, {});
    assert.ok(r && typeof r.verb === 'string' && r.verb.length > 0, `must return an intent for "${q}"`);
  }
});
