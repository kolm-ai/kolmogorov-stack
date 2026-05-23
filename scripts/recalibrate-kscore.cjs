#!/usr/bin/env node
// W810-5 — quarterly recalibration job for K-Score external calibration.
//
// Usage:
//   node scripts/recalibrate-kscore.cjs --period 2026-Q2
//   node scripts/recalibrate-kscore.cjs --period 2026-04
//   node scripts/recalibrate-kscore.cjs                  # auto-pick current quarter
//   node scripts/recalibrate-kscore.cjs --json
//   node scripts/recalibrate-kscore.cjs --dry-run        # fit but don't write
//
// Cron-friendly:
//   - exit 0 = success (mapping written)
//   - exit 2 = pack not found
//   - exit 3 = pack loaded but no category reached min_pairs threshold
//   - exit 4 = unexpected exception
//
// The script is a thin wrapper around src/kscore-calibration.js — it imports
// the ESM module via dynamic import() so this file can stay .cjs (compatible
// with the rest of the cron-style scripts in this repo).

'use strict';

const path = require('node:path');
const url = require('node:url');

function _argFlag(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] || true;
}

function _currentQuarter(now) {
  const d = now || new Date();
  const yr = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${yr}-Q${q}`;
}

async function main() {
  const wantJson = process.argv.includes('--json');
  const dryRun = process.argv.includes('--dry-run');
  const period = (typeof _argFlag('--period') === 'string')
    ? _argFlag('--period')
    : _currentQuarter();

  // Use file:// URL so this works on Windows where absolute paths start with
  // a drive letter (ERR_UNSUPPORTED_ESM_URL_SCHEME otherwise).
  const modPath = path.resolve(__dirname, '..', 'src', 'kscore-calibration.js');
  const mod = await import(url.pathToFileURL(modPath).href);
  const pack = mod.loadPack(period);
  if (!pack.ok) {
    const out = {
      ok: false,
      stage: 'load_pack',
      error: pack.error,
      detail: pack.detail,
      period,
    };
    if (wantJson) process.stdout.write(JSON.stringify(out) + '\n');
    else process.stderr.write(`recalibrate-kscore: pack not found for ${period}\n  expected at ${pack.detail}\n`);
    process.exit(2);
  }

  // Fit (and optionally persist).
  let mapping;
  if (dryRun) {
    // Reuse the fitting logic by writing to a tmp path so we don't touch
    // ~/.kolm. The simplest path: clone _dataDir into KOLM_DATA_DIR for this
    // process before calling fitAndPersist, then read+discard. But we don't
    // need to: fitAndPersist returns the mapping object directly.
    const res = mod.fitAndPersist(pack);
    mapping = res.mapping;
    // dry-run cleanup: remove the file we just wrote (fitAndPersist always
    // writes; the dry-run intent is "fit + report, don't leave a side effect").
    try { require('node:fs').unlinkSync(res.mapping_path); } catch { /* ignore */ }
  } else {
    const res = mod.fitAndPersist(pack);
    mapping = res.mapping;
  }

  // Honest gate: if NO category fit ok AND the pooled fit didn't either,
  // exit 3 so a cron monitor can alert.
  const cats = mapping.by_category || {};
  const okCats = Object.keys(cats).filter((k) => cats[k] && cats[k].status === 'ok');
  const pooledOk = mapping.pooled && mapping.pooled.status === 'ok';
  if (okCats.length === 0 && !pooledOk) {
    const out = {
      ok: false,
      stage: 'fit_calibration',
      error: 'no_category_reached_threshold',
      period: mapping.calibration_pack_id,
      n_pairs: mapping.n_pairs,
      threshold: mod.MIN_PAIRS_PER_CATEGORY,
      by_category: cats,
      pooled: mapping.pooled,
    };
    if (wantJson) process.stdout.write(JSON.stringify(out) + '\n');
    else process.stderr.write(`recalibrate-kscore: ${out.error} (n=${mapping.n_pairs}, threshold=${out.threshold})\n`);
    process.exit(3);
  }

  const out = {
    ok: true,
    stage: 'fit_calibration',
    period: mapping.calibration_pack_id,
    fitted_at: mapping.fitted_at,
    n_pairs: mapping.n_pairs,
    threshold: mod.MIN_PAIRS_PER_CATEGORY,
    categories_with_mapping: okCats,
    categories_insufficient: Object.keys(cats).filter((k) => cats[k] && cats[k].status === 'insufficient_data'),
    pooled_status: mapping.pooled ? mapping.pooled.status : null,
    mapping_path: dryRun ? null : require('path').join(
      process.env.KOLM_DATA_DIR || path.join(require('os').homedir(), '.kolm'),
      'kscore-calibration.json',
    ),
    dry_run: dryRun,
  };
  if (wantJson) process.stdout.write(JSON.stringify(out) + '\n');
  else {
    process.stdout.write(`recalibrate-kscore: ${out.period} fitted (n=${out.n_pairs})\n`);
    process.stdout.write(`  categories_with_mapping: ${out.categories_with_mapping.join(', ') || '(none)'}\n`);
    process.stdout.write(`  categories_insufficient: ${out.categories_insufficient.join(', ') || '(none)'}\n`);
    process.stdout.write(`  pooled: ${out.pooled_status}\n`);
    if (!dryRun) process.stdout.write(`  written: ${out.mapping_path}\n`);
  }
  process.exit(0);
}

main().catch((err) => {
  const out = {
    ok: false,
    stage: 'unexpected_exception',
    error: String(err && err.message || err),
    stack: err && err.stack ? String(err.stack) : null,
  };
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(out) + '\n');
  else process.stderr.write(`recalibrate-kscore: ${out.error}\n${out.stack || ''}\n`);
  process.exit(4);
});
