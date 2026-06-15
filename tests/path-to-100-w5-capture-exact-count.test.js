// W-5 (Path to 100%) — the account overview reports the EXACT number of
// captured inferences.
//
// Before: /v1/account/compiler-overview counted `captures | capture_events |
// routing_events | events` and took the MAX — but NOT `observations`, the table
// the proxy actually writes captures to (capture-store captureWithSignature).
// Result: real proxy traffic showed "0 captured", while routing telemetry
// (routing_events) could inflate the number. Now `observations` is the truth.

import { test } from 'node:test';
import assert from 'node:assert';
import { computeObservedCaptures } from '../src/router.js';

test('W-5 A2: count equals observations exactly; routing_events never inflates it', () => {
  // N observations, M (!= N) routing_events → count must be EXACTLY N.
  assert.strictEqual(
    computeObservedCaptures({ observations: 12, routing_events: 99, events: 40 }),
    12,
    'observations is the canonical count; routing telemetry must not change it',
  );
});

test('W-5: zero observations falls back to legacy capture tables (not routing_events)', () => {
  // Historical tenant with no observations yet: fall back to capture tables,
  // but routing_events (routing telemetry, not captures) must still be excluded.
  assert.strictEqual(
    computeObservedCaptures({ observations: 0, captures: 5, routing_events: 99 }),
    5,
    'legacy fallback counts captures, never routing_events',
  );
});

test('W-5: a fresh tenant with no captures reports 0 (not a telemetry artifact)', () => {
  assert.strictEqual(computeObservedCaptures({ routing_events: 7, events: 3 }), 0);
  assert.strictEqual(computeObservedCaptures({}), 0);
});

test('W-5: a single real capture is reported as 1, not 0', () => {
  assert.strictEqual(computeObservedCaptures({ observations: 1 }), 1);
});
