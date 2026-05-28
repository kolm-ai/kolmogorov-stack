// Smoke test for src/temporal-analyzer.js — runnable standalone.
//
//   node scripts/temporal-analyzer-smoke.mjs
//
// Isolates event-store state into a throwaway temp dir BEFORE importing any
// module that touches the store, so a developer's real ~/.kolm lake is never
// read or written. Prints "N passed, M failed" and exits nonzero on failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// MUST run before importing temporal-analyzer (which imports event-store).
process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-tmp-'));

const { analyzeTemporalCoverage, summarizeGaps, TEMPORAL_VERSION } =
  await import('../src/temporal-analyzer.js');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

// ---------------------------------------------------------------------------
// Date fixtures. We pin to known UTC dates and assert the weekday so the test
// is self-checking. 2026-06-01 is a Monday (UTC); the surrounding week:
//   2026-05-31 Sun, 06-01 Mon, 06-02 Tue, 06-03 Wed, 06-04 Thu,
//   06-05 Fri, 06-06 Sat.
// ---------------------------------------------------------------------------

function isoAt(dateStr, hour = 12) {
  // Build a UTC ISO timestamp at a fixed hour so weekday/hour buckets are
  // deterministic regardless of the runner's local timezone.
  const hh = String(hour).padStart(2, '0');
  return `${dateStr}T${hh}:00:00.000Z`;
}

// Sanity-check the fixture calendar before relying on it.
check(
  'fixture calendar: 2026-06-01 is Monday (UTC)',
  new Date(isoAt('2026-06-01')).getUTCDay() === 1,
  'getUTCDay=' + new Date(isoAt('2026-06-01')).getUTCDay(),
);
check(
  'fixture calendar: 2026-06-06 is Saturday (UTC)',
  new Date(isoAt('2026-06-06')).getUTCDay() === 6,
);
check(
  'fixture calendar: 2026-05-31 is Sunday (UTC)',
  new Date(isoAt('2026-05-31')).getUTCDay() === 0,
);

const WEEKDAY_DATES = [
  '2026-06-01', // Mon
  '2026-06-02', // Tue
  '2026-06-03', // Wed
  '2026-06-04', // Thu
  '2026-06-05', // Fri
];
const WEEKEND_DATES = [
  '2026-05-31', // Sun
  '2026-06-06', // Sat
];

// ===========================================================================
// Test 1 — all-weekday captures (Mon-Fri only, none Sat/Sun) → result.gaps
// includes a 'weekend' under-represented gap; weekend.share ≈ 0.
// ===========================================================================
{
  const captures = [];
  // 10 captures per weekday, none on the weekend.
  for (const d of WEEKDAY_DATES) {
    for (let i = 0; i < 10; i++) captures.push({ created_at: isoAt(d, 9 + (i % 8)) });
  }
  const res = await analyzeTemporalCoverage({
    tenant: 'tenant_local',
    namespace: 'smoke-weekday-only',
    captures,
  });
  check('T1 envelope ok:true', res.ok === true, JSON.stringify(res.error));
  check('T1 version is tmp-v1', res.version === TEMPORAL_VERSION && res.version === 'tmp-v1');
  check('T1 n_captures = 50', res.n_captures === 50, 'n=' + res.n_captures);
  check('T1 weekend.share ≈ 0', approx(res.buckets.weekend.share, 0), 'share=' + res.buckets.weekend.share);
  check('T1 weekend.count = 0', res.buckets.weekend.count === 0);
  const weekendGap = res.gaps.find((g) => g.bucket === 'weekend');
  check('T1 gaps includes weekend', !!weekendGap, 'gap buckets=' + res.gaps.map((g) => g.bucket).join(','));
  check('T1 weekend gap underrepresented:true', !!weekendGap && weekendGap.underrepresented === true);
  check(
    'T1 weekend gap deficit ≈ expected (share≈0)',
    !!weekendGap && approx(weekendGap.deficit, weekendGap.expected, 1e-3),
    weekendGap ? 'deficit=' + weekendGap.deficit + ' expected=' + weekendGap.expected : 'no gap',
  );
}

// ===========================================================================
// Test 2 — uniform-across-week captures → no weekend gap.
// ===========================================================================
{
  const captures = [];
  // 10 captures on EVERY day of the week (weekday + weekend) → weekend share
  // = 20/70 ≈ 0.2857, exactly the expected uniform share, so no weekend gap.
  for (const d of [...WEEKDAY_DATES, ...WEEKEND_DATES]) {
    for (let i = 0; i < 10; i++) captures.push({ created_at: isoAt(d, i % 24) });
  }
  const res = await analyzeTemporalCoverage({
    tenant: 'tenant_local',
    namespace: 'smoke-uniform-week',
    captures,
  });
  check('T2 envelope ok:true', res.ok === true);
  check('T2 n_captures = 70', res.n_captures === 70, 'n=' + res.n_captures);
  const weekendGap = res.gaps.find((g) => g.bucket === 'weekend');
  check('T2 NO weekend gap', !weekendGap, weekendGap ? JSON.stringify(weekendGap) : '');
  const weekdayGap = res.gaps.find((g) => g.bucket === 'weekday');
  check('T2 NO weekday gap', !weekdayGap, weekdayGap ? JSON.stringify(weekdayGap) : '');
  check(
    'T2 weekend.share ≈ 2/7',
    approx(res.buckets.weekend.share, 2 / 7, 1e-3),
    'share=' + res.buckets.weekend.share,
  );
}

// ===========================================================================
// Test 3 — shape: by_hour length 24, by_weekday length 7, shares sum ≈ 1.
// ===========================================================================
{
  const captures = [];
  for (const d of [...WEEKDAY_DATES, ...WEEKEND_DATES]) {
    for (let h = 0; h < 24; h++) captures.push({ created_at: isoAt(d, h) });
  }
  const res = await analyzeTemporalCoverage({
    tenant: 'tenant_local',
    namespace: 'smoke-shape',
    captures,
  });
  check('T3 by_hour length 24', Array.isArray(res.buckets.by_hour) && res.buckets.by_hour.length === 24);
  check('T3 by_weekday length 7', Array.isArray(res.buckets.by_weekday) && res.buckets.by_weekday.length === 7);

  // weekday.share + weekend.share ≈ 1
  const rollupSum = res.buckets.weekday.share + res.buckets.weekend.share;
  check('T3 weekday+weekend shares sum ≈ 1', approx(rollupSum, 1, 1e-3), 'sum=' + rollupSum);

  // season shares (recomputed from counts) sum ≈ 1
  const seasonTotal = Object.values(res.buckets.by_season).reduce((a, b) => a + b, 0);
  check('T3 season counts sum = n_captures', seasonTotal === res.n_captures, seasonTotal + ' vs ' + res.n_captures);

  // by_hour counts sum = n_captures
  const hourTotal = res.buckets.by_hour.reduce((a, b) => a + b, 0);
  check('T3 by_hour counts sum = n_captures', hourTotal === res.n_captures, hourTotal + ' vs ' + res.n_captures);

  // by_weekday counts sum = n_captures
  const wdTotal = res.buckets.by_weekday.reduce((a, b) => a + b, 0);
  check('T3 by_weekday counts sum = n_captures', wdTotal === res.n_captures, wdTotal + ' vs ' + res.n_captures);
}

// ===========================================================================
// Test 4 — captures param path works WITHOUT any event-store rows. The temp
// KOLM_DATA_DIR has an empty lake, so this proves the direct-captures path is
// independent of persisted state.
// ===========================================================================
{
  // First confirm the empty-lake read path yields zero captures (no rows seeded).
  const empty = await analyzeTemporalCoverage({
    tenant: 'tenant_local',
    namespace: 'smoke-empty-lake-read',
  });
  check('T4 empty-lake read ok:true', empty.ok === true);
  check('T4 empty-lake read n_captures = 0', empty.n_captures === 0, 'n=' + empty.n_captures);

  // Now the direct-captures path on a different (also empty) namespace.
  const captures = [
    { ts: Date.parse(isoAt('2026-06-01', 10)) }, // Mon, epoch ms via ts
    { ts: isoAt('2026-06-02', 11) },             // Tue, ISO via ts
    { created_at: isoAt('2026-06-03', 12) },     // Wed, created_at
  ];
  const res = await analyzeTemporalCoverage({
    tenant: 'tenant_local',
    namespace: 'smoke-direct-no-rows',
    captures,
  });
  check('T4 direct-captures ok:true', res.ok === true);
  check('T4 direct-captures n_captures = 3', res.n_captures === 3, 'n=' + res.n_captures);
  check('T4 direct-captures weekday.count = 3', res.buckets.weekday.count === 3);
  check('T4 ts (epoch ms) parsed into a bucket', res.buckets.by_hour[10] === 1, 'hour10=' + res.buckets.by_hour[10]);
  check('T4 ts (ISO) parsed into a bucket', res.buckets.by_hour[11] === 1, 'hour11=' + res.buckets.by_hour[11]);
  check('T4 created_at parsed into a bucket', res.buckets.by_hour[12] === 1, 'hour12=' + res.buckets.by_hour[12]);
  // persistence ran best-effort and did not fail the call
  check('T4 persisted envelope present', !!res.persisted && typeof res.persisted.persisted === 'boolean');
}

// ===========================================================================
// Test 5 — summarizeGaps returns a non-empty string mentioning the worst bucket.
// ===========================================================================
{
  const captures = [];
  for (const d of WEEKDAY_DATES) {
    for (let i = 0; i < 10; i++) captures.push({ created_at: isoAt(d, 9 + (i % 8)) });
  }
  const res = await analyzeTemporalCoverage({
    tenant: 'tenant_local',
    namespace: 'smoke-summary',
    captures,
  });
  const summary = summarizeGaps(res);
  check('T5 summary is non-empty string', typeof summary === 'string' && summary.length > 0, JSON.stringify(summary));
  check('T5 summary mentions "weekend" (worst gap)', /weekend/i.test(summary), summary);
  check('T5 summary mentions "under-represented"', /under-represented/i.test(summary), summary);

  // Pure-function guards: balanced + malformed inputs never throw.
  const balanced = summarizeGaps({ ok: true, gaps: [], version: 'tmp-v1' });
  check('T5 balanced summary non-empty', typeof balanced === 'string' && balanced.length > 0, balanced);
  const malformed = summarizeGaps(null);
  check('T5 malformed input non-empty (no throw)', typeof malformed === 'string' && malformed.length > 0, malformed);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
