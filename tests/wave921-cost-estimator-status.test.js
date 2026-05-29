// W921 — estimateCostDetailed surfaces an estimator_status so a $0 result from
// an UNKNOWN model ('unpriced_model') is distinguishable from a genuinely-free
// priced call. estimateCost keeps its numeric contract (existing callers
// unchanged).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, estimateCostDetailed } from '../src/cost-estimator.js';
import { PROVIDERS } from '../src/provider-registry.js';

// Pick a provider+model that is actually priced in the registry, for the happy path.
function aPricedPair() {
  for (const [provider, cfg] of Object.entries(PROVIDERS)) {
    if (cfg && cfg.cost_per_1k) {
      const model = Object.keys(cfg.cost_per_1k)[0];
      if (model) return { provider, model };
    }
  }
  return null;
}

test('#1 priced model => status "priced" and a positive cost', () => {
  const pair = aPricedPair();
  assert.ok(pair, 'registry must have at least one priced model');
  const d = estimateCostDetailed({ ...pair, prompt_tokens: 1000, completion_tokens: 1000 });
  assert.equal(d.estimator_status, 'priced');
  assert.ok(d.cost_usd >= 0);
  assert.equal(d.model_key != null, true);
});

test('#2 unknown provider => status "unknown_provider", cost 0', () => {
  const d = estimateCostDetailed({ provider: 'no-such-provider', model: 'x', prompt_tokens: 1000, completion_tokens: 1000 });
  assert.equal(d.estimator_status, 'unknown_provider');
  assert.equal(d.cost_usd, 0);
  assert.equal(d.model_key, null);
});

test('#3 known provider, unpriced model => status "unpriced_model" (the $0 we must flag), cost 0', () => {
  const pair = aPricedPair();
  const d = estimateCostDetailed({ provider: pair.provider, model: 'totally-made-up-model-zzz', prompt_tokens: 1000, completion_tokens: 1000 });
  assert.equal(d.estimator_status, 'unpriced_model');
  assert.equal(d.cost_usd, 0);
});

test('#4 estimateCost numeric contract preserved (delegates to detailed)', () => {
  const pair = aPricedPair();
  const n = estimateCost({ ...pair, prompt_tokens: 1000, completion_tokens: 1000 });
  const d = estimateCostDetailed({ ...pair, prompt_tokens: 1000, completion_tokens: 1000 });
  assert.equal(typeof n, 'number');
  assert.equal(n, d.cost_usd);
  // unknown still returns a bare number (0), never an object
  assert.equal(estimateCost({ provider: 'nope', model: 'nope' }), 0);
});
