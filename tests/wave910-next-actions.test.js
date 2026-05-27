// W910 Track C2 - proactive next-actions engine contract.
//
// Given a synthetic snapshot covering all 7 action types, compute() must
// return them in priority order. Snoozing a dismiss_key must filter the
// matching card from subsequent compute() calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute, snooze, ACTION_PRIORITIES, READINESS_MIN_CAPTURES } from '../src/next-actions.js';

function fullSnapshot() {
  const now = Date.now();
  const oneDay = 86400_000;
  return {
    namespaces: [
      // readiness candidate (>= READINESS_MIN_CAPTURES captures, never compiled)
      { namespace: 'support', captures: READINESS_MIN_CAPTURES + 50, routed_calls: 200, fallbacks: 30, last_compiled_at: null, captures_at_last_compile: 0 },
      // fallbacks candidate (10%+ rate, no readiness because already compiled recently with no new traffic)
      { namespace: 'sales', captures: 75, routed_calls: 200, fallbacks: 30, last_compiled_at: new Date(now - 5 * oneDay).toISOString(), captures_at_last_compile: 75 },
    ],
    artifacts: [
      // drift candidate (deployed K-Score dropped 0.05)
      { artifact_id: 'art-drift', deployed_kscore: 0.92, current_kscore: 0.87, compiled_at: new Date(now - 10 * oneDay).toISOString(), captures_since_compile: 10 },
      // stale candidate (>90d old, 300 new captures)
      { artifact_id: 'art-stale', deployed_kscore: 0.90, current_kscore: 0.90, compiled_at: new Date(now - 120 * oneDay).toISOString(), captures_since_compile: 300 },
    ],
    last_capture_at: new Date(now - 20 * oneDay).toISOString(),    // idle (> 14d)
    spend_30d_usd: 250,
    spend_forecast_usd: 100,                                       // cost ratio 2.5x
    unredacted_pii_captures: 14,                                   // security
  };
}

test('W910 C2: compute() returns all 7 action types ranked by priority', () => {
  const tenant = 't_w910_c2_all';
  const actions = compute(tenant, { snapshot: fullSnapshot(), limit: 50 });
  const types = actions.map((a) => a.type);
  for (const t of ['readiness', 'drift', 'stale', 'idle', 'cost', 'security', 'fallbacks']) {
    assert.ok(types.includes(t), `missing action type ${t} (got ${types.join(',')})`);
  }
  // Confirm priority sort
  for (let i = 1; i < actions.length; i++) {
    assert.ok(actions[i].priority >= actions[i - 1].priority, `priority not monotonic at index ${i}: ${actions[i - 1].priority} -> ${actions[i].priority}`);
  }
  assert.equal(actions[0].type, 'readiness', `top action should be readiness (priority 1)`);
});

test('W910 C2: compute() respects limit', () => {
  const actions = compute('t_w910_c2_limit', { snapshot: fullSnapshot(), limit: 3 });
  assert.equal(actions.length, 3);
});

test('W910 C2: each action card carries the required fields', () => {
  const actions = compute('t_w910_c2_shape', { snapshot: fullSnapshot(), limit: 50 });
  for (const a of actions) {
    assert.ok(typeof a.type === 'string' && a.type.length);
    assert.ok(typeof a.priority === 'number' && a.priority >= 1 && a.priority <= 7);
    assert.ok(typeof a.title === 'string' && a.title.length);
    assert.ok(typeof a.body === 'string' && a.body.length);
    assert.ok(typeof a.cta_label === 'string' && a.cta_label.length);
    assert.ok(typeof a.cta_href === 'string' && a.cta_href.startsWith('/'));
    assert.ok(typeof a.dismiss_key === 'string' && a.dismiss_key.includes(':'));
  }
});

test('W910 C2: snoozing a dismiss_key filters the action on subsequent compute', () => {
  const tenant = 't_w910_c2_snooze_' + Math.random().toString(36).slice(2);
  const snap = fullSnapshot();
  const before = compute(tenant, { snapshot: snap, limit: 50 });
  const target = before.find((a) => a.type === 'idle');
  assert.ok(target, 'expected an idle action');
  const row = snooze(tenant, target.dismiss_key, 14);
  assert.equal(row.dismiss_key, target.dismiss_key);
  assert.ok(typeof row.until_ts === 'number' && row.until_ts > Date.now());
  const after = compute(tenant, { snapshot: snap, limit: 50 });
  const idleAfter = after.find((a) => a.type === 'idle');
  assert.equal(idleAfter, undefined, 'idle action should be hidden after snooze');
});

test('W910 C2: ACTION_PRIORITIES map is canonical and 1..7', () => {
  const vals = Object.values(ACTION_PRIORITIES).sort();
  assert.deepEqual(vals, [1, 2, 3, 4, 5, 6, 7]);
});

test('W910 C2: empty snapshot returns no actions (and no throw)', () => {
  const actions = compute('t_w910_c2_empty', { snapshot: { namespaces: [], artifacts: [] }, limit: 5 });
  assert.deepEqual(actions, []);
});

test('W910 C2: namespace below READINESS_MIN_CAPTURES does NOT trigger readiness', () => {
  const snap = {
    namespaces: [{ namespace: 'tiny', captures: READINESS_MIN_CAPTURES - 1 }],
    artifacts: [],
  };
  const actions = compute('t_w910_c2_below', { snapshot: snap, limit: 5 });
  assert.equal(actions.filter((a) => a.type === 'readiness').length, 0);
});
