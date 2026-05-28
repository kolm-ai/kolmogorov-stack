// Smoke test for src/kscore-timeseries.js — the K-Score time-series layer.
//
// State isolation: point KOLM_DATA_DIR at a fresh temp dir BEFORE importing
// anything that touches the event store, so this run never reads/writes a real
// tenant's data.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-kts-'));

const {
  recordKScore,
  getKScoreSeries,
  backfillKScoreSeries,
  renderSeriesSummary,
  KSCORE_SERIES_VERSION,
} = await import('../src/kscore-timeseries.js');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`); }
}

const TENANT = 'tenant_local';
const DAY = 24 * 60 * 60 * 1000;

// --------------------------------------------------------------------------
// 1. record 3 points with increasing ts -> n===3, ascending, values match.
// --------------------------------------------------------------------------
{
  const ns = 'ns_basic';
  const now = Date.now();
  const t1 = new Date(now - 2 * DAY).toISOString();
  const t2 = new Date(now - 1 * DAY).toISOString();
  const t3 = new Date(now).toISOString();
  // Record out of chronological order to prove sorting works.
  const r2 = await recordKScore({ tenant: TENANT, namespace: ns, kscore: 0.80, run_id: 'r2', ts: t2 });
  const r1 = await recordKScore({ tenant: TENANT, namespace: ns, kscore: 0.70, run_id: 'r1', ts: t1 });
  const r3 = await recordKScore({ tenant: TENANT, namespace: ns, kscore: 0.90, run_id: 'r3', ts: t3 });
  check('record returns ok + version', r1.ok && r2.ok && r3.ok && r1.version === KSCORE_SERIES_VERSION);

  const series = await getKScoreSeries({ tenant: TENANT, namespace: ns });
  check('series ok', series.ok === true);
  check('series n === 3', series.n === 3);
  const ascending = series.points.every((p, i) =>
    i === 0 || new Date(series.points[i - 1].ts).getTime() <= new Date(p.ts).getTime());
  check('series ascending by ts', ascending);
  check('series kscore values match in order', series.points.length === 3
    && series.points[0].kscore === 0.70
    && series.points[1].kscore === 0.80
    && series.points[2].kscore === 0.90);
  check('series run_ids preserved', series.points[0].run_id === 'r1'
    && series.points[2].run_id === 'r3');
}

// --------------------------------------------------------------------------
// 2. window_days filter: 90-day-old point excluded, recent one kept.
// --------------------------------------------------------------------------
{
  const ns = 'ns_window';
  const old = new Date(Date.now() - 90 * DAY).toISOString();
  const recent = new Date(Date.now() - 1 * DAY).toISOString();
  await recordKScore({ tenant: TENANT, namespace: ns, kscore: 0.50, run_id: 'old', ts: old });
  await recordKScore({ tenant: TENANT, namespace: ns, kscore: 0.95, run_id: 'recent', ts: recent });

  const all = await getKScoreSeries({ tenant: TENANT, namespace: ns });
  check('window: 2 points without filter', all.n === 2);

  const win = await getKScoreSeries({ tenant: TENANT, namespace: ns, window_days: 30 });
  check('window: filter drops the 90-day-old point', win.n === 1);
  check('window: surviving point is the recent one', win.points.length === 1 && win.points[0].run_id === 'recent');
}

// --------------------------------------------------------------------------
// 3. backfill against a synthetic runs_dir; idempotent on second call.
// --------------------------------------------------------------------------
{
  const ns = 'ns_backfill';
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-runs-'));
  for (const run of ['run-aaa', 'run-bbb']) {
    const studentDir = path.join(runsDir, run, 'student');
    fs.mkdirSync(studentDir, { recursive: true });
    fs.writeFileSync(
      path.join(studentDir, 'eval-mixeval-hard.json'),
      JSON.stringify({ mean_score: 0.7 }),
      'utf8',
    );
  }

  const first = await backfillKScoreSeries({ tenant: TENANT, namespace: ns, runs_dir: runsDir });
  check('backfill ok', first.ok === true);
  check('backfill recorded === 2', first.recorded === 2);
  check('backfill scanned === 2', first.scanned === 2);

  const seriesAfter = await getKScoreSeries({ tenant: TENANT, namespace: ns });
  check('backfill series has 2 points', seriesAfter.n === 2);
  check('backfill score extracted from mean_score', seriesAfter.points.every(p => p.kscore === 0.7));

  const second = await backfillKScoreSeries({ tenant: TENANT, namespace: ns, runs_dir: runsDir });
  check('backfill idempotent: recorded === 0', second.recorded === 0);
  check('backfill idempotent: skipped === 2', second.skipped === 2);

  const seriesFinal = await getKScoreSeries({ tenant: TENANT, namespace: ns });
  check('backfill idempotent: still 2 points', seriesFinal.n === 2);
}

// --------------------------------------------------------------------------
// 4. recordKScore with NaN -> ok:false invalid_kscore.
// --------------------------------------------------------------------------
{
  const bad = await recordKScore({ tenant: TENANT, namespace: 'ns_bad', kscore: NaN, run_id: 'x' });
  check('NaN kscore -> ok:false', bad.ok === false);
  check('NaN kscore -> error invalid_kscore', bad.error === 'invalid_kscore');
  check('NaN kscore -> version present', bad.version === KSCORE_SERIES_VERSION);
}

// --------------------------------------------------------------------------
// 5. renderSeriesSummary on 3 ascending points -> trend up.
// --------------------------------------------------------------------------
{
  const summary = renderSeriesSummary({
    points: [
      { ts: '2026-01-01T00:00:00.000Z', kscore: 0.70 },
      { ts: '2026-01-02T00:00:00.000Z', kscore: 0.80 },
      { ts: '2026-01-03T00:00:00.000Z', kscore: 0.90 },
    ],
  });
  check('summary trend up', summary.trend === 'up');
  check('summary min/max/latest', summary.min === 0.70 && summary.max === 0.90 && summary.latest === 0.90);
  check('summary n === 3', summary.n === 3);

  // bonus: down + flat + empty edge cases.
  const down = renderSeriesSummary([{ kscore: 0.9 }, { kscore: 0.5 }]);
  check('summary trend down', down.trend === 'down');
  const flat = renderSeriesSummary([{ kscore: 0.5 }, { kscore: 0.5 }]);
  check('summary trend flat', flat.trend === 'flat');
  const empty = renderSeriesSummary({ points: [] });
  check('summary empty -> n 0, flat, nulls', empty.n === 0 && empty.trend === 'flat' && empty.min === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
