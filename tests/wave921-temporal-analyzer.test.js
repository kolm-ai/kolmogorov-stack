// W921 — Deterministic contract test for src/temporal-analyzer.js
//
// Target export (confirmed by reading the module):
//   async analyzeTemporalCoverage({ tenant, namespace, window_days, captures })
//     -> { ok, version, buckets, gaps, n_captures, persisted }   (ok:true)
//     -> { ok:false, error, version }                            (read failure)
//
// Determinism: every assertion drives the DIRECT `captures` array path (the
// testable seam — an array `captures` wins over the event-store read), so there
// is NO network and NO real wall-clock branching. All timestamps are explicit
// fixtures with fixed UTC offsets ('Z'). Timestamp field read by the module is
// `created_at` first, then `ts` (confirmed via __internals._extractDateMs).
//
// Tenant-fencing: each call uses a unique `tenant_w921_temporal_*` id so the
// best-effort persistence seam can never cross-contaminate another test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import temporal, {
  analyzeTemporalCoverage,
  TEMPORAL_VERSION,
  __internals,
} from '../src/temporal-analyzer.js';

// --- Fixtures (all UTC, all weekday Mon..Fri unless noted) -----------------
// Verified UTC weekdays: 2026-01-05=Mon(1) .. 2026-01-09=Fri(5),
// 2026-01-10=Sat(6), 2026-01-11=Sun(0). All in January => 'winter' season.
const WEEKDAY_TS = [
  '2026-01-05T09:00:00Z', // Mon, hour 9
  '2026-01-06T10:00:00Z', // Tue, hour 10
  '2026-01-07T11:00:00Z', // Wed, hour 11
  '2026-01-08T12:00:00Z', // Thu, hour 12
  '2026-01-09T13:00:00Z', // Fri, hour 13
];
const WEEKEND_TS = [
  '2026-01-10T14:00:00Z', // Sat
  '2026-01-11T15:00:00Z', // Sun
];

const asCaptures = (stamps, prefix) =>
  stamps.map((s, i) => ({ created_at: s, id: `${prefix}_${i}` }));

// Sanity-anchor the module's documented timestamp seam so the fixtures above
// are provably using the field the analyzer actually reads.
test('w921 temporal: _extractDateMs reads created_at then ts (fixture key is real)', () => {
  const viaCreatedAt = __internals._extractDateMs({ created_at: '2026-01-05T09:00:00Z' });
  const viaTs = __internals._extractDateMs({ ts: Date.UTC(2026, 0, 5, 9, 0, 0) });
  assert.equal(typeof viaCreatedAt, 'number');
  assert.equal(typeof viaTs, 'number');
  assert.equal(viaCreatedAt, Date.UTC(2026, 0, 5, 9, 0, 0));
  assert.equal(__internals._extractDateMs({ id: 'no-timestamp' }), null);
});

test('w921 temporal: all-weekday captures => full bucket envelope contract', async () => {
  const res = await analyzeTemporalCoverage({
    tenant: 'tenant_w921_temporal_weekday',
    namespace: 'w921_ns',
    captures: asCaptures(WEEKDAY_TS, 'wd'),
  });

  // (contract) ok:true envelope with version + buckets.
  assert.equal(res.ok, true);
  assert.equal(res.version, TEMPORAL_VERSION);
  assert.equal(res.version, 'tmp-v1');
  assert.equal(res.n_captures, WEEKDAY_TS.length);

  // (1) buckets present with the module's documented shapes.
  const b = res.buckets;
  assert.ok(b && typeof b === 'object', 'buckets object present');
  assert.ok(Array.isArray(b.by_weekday) && b.by_weekday.length === 7, 'by_weekday[7]');
  assert.ok(Array.isArray(b.by_hour) && b.by_hour.length === 24, 'by_hour[24]');
  assert.deepEqual(Object.keys(b.by_season).sort(), ['fall', 'spring', 'summer', 'winter']);
  assert.equal(b.by_season.winter, WEEKDAY_TS.length, 'all January => winter');
  assert.equal(b.weekday.count, 5);
  assert.equal(b.weekend.count, 0);
  assert.equal(b.weekday.share, 1);
  assert.equal(b.weekend.share, 0);
  // Hour buckets land where the fixtures placed them (UTC hours 9..13).
  assert.equal(b.by_hour[9], 1);
  assert.equal(b.by_hour[13], 1);
});

test('w921 temporal: all-weekday corpus flags weekend as under-represented gap', async () => {
  const res = await analyzeTemporalCoverage({
    tenant: 'tenant_w921_temporal_gap',
    namespace: 'w921_ns',
    captures: asCaptures(WEEKDAY_TS, 'gap'),
  });

  // (2) the weekend rollup is surfaced as an under-represented gap.
  const weekendGap = res.gaps.find((g) => g.bucket === 'weekend');
  assert.ok(weekendGap, 'weekend gap present');
  assert.equal(weekendGap.underrepresented, true);
  // share (0) is below half the expected uniform weekend share (2/7).
  assert.ok(weekendGap.share < __internals.WEEKEND_EXPECTED * __internals.GAP_THRESHOLD);
  assert.equal(weekendGap.expected, 0.2857); // _round(2/7)
  assert.ok(weekendGap.deficit > 0, 'positive deficit for a real gap');

  // The weekday rollup is fully covered, so it is NOT flagged.
  assert.equal(res.gaps.some((g) => g.bucket === 'weekday'), false);
});

test('w921 temporal: balanced corpus surfaces no weekend gap', async () => {
  const balanced = asCaptures([...WEEKDAY_TS, ...WEEKEND_TS], 'bal');
  const res = await analyzeTemporalCoverage({
    tenant: 'tenant_w921_temporal_balanced',
    namespace: 'w921_ns',
    captures: balanced,
  });

  // (3) weekend share (2/7) is at the expected uniform level => no gap.
  assert.equal(res.ok, true);
  assert.equal(res.buckets.weekend.count, 2);
  assert.equal(res.buckets.weekend.share, 0.2857);
  assert.ok(
    res.buckets.weekend.share >= __internals.WEEKEND_EXPECTED * __internals.GAP_THRESHOLD,
  );
  assert.equal(res.gaps.some((g) => g.bucket === 'weekend'), false, 'no weekend gap');
});

test('w921 temporal: empty captures => sane envelope, no crash', async () => {
  const res = await analyzeTemporalCoverage({
    tenant: 'tenant_w921_temporal_empty',
    namespace: 'w921_ns',
    captures: [],
  });

  // (4) empty input still yields a well-formed ok:true envelope.
  assert.equal(res.ok, true);
  assert.equal(res.version, 'tmp-v1');
  assert.equal(res.n_captures, 0);
  assert.deepEqual(res.buckets.by_weekday, [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(res.buckets.weekend.share, 0);
  assert.ok(Array.isArray(res.gaps), 'gaps array present even when empty');
  // default export exposes the same function (module surface contract).
  assert.equal(temporal.analyzeTemporalCoverage, analyzeTemporalCoverage);
});

test('w921 temporal: unparseable rows are skipped, denominator counts only parseable', async () => {
  const mixed = [
    { created_at: '2026-01-05T09:00:00Z' }, // valid Mon
    { created_at: 'garbage-not-a-date' },   // skipped
    { ts: 'also-not-a-date' },              // skipped
    { id: 'no-timestamp-field' },           // skipped
  ];
  const res = await analyzeTemporalCoverage({
    tenant: 'tenant_w921_temporal_mixed',
    namespace: 'w921_ns',
    captures: mixed,
  });
  assert.equal(res.ok, true);
  assert.equal(res.n_captures, 1, 'only the one parseable row contributes');
  assert.equal(res.buckets.by_weekday[1], 1, 'Monday bucket got the parseable row');
});
