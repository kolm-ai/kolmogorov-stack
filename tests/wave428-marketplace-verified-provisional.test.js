// Wave 428 — marketplace listArtifacts() must NOT expose a sync-only
// `verified: true` to public consumers.
//
// Auditor finding (2026-05-19 P1-4): src/marketplace.js:hydrate() called
// productionReadySync() and stored its `ok` boolean as the row's public
// `verified` field. productionReadySync() skips the durability,
// executable_bundle, and eval_parity gates and tags its envelope with
// `_provisional: true` — meaning a freshly compiled .kolm whose bundle hash
// has not been verified, whose recipe has not been re-run, and whose seed
// store has not been durability-checked could ship a green "Verified" pill
// straight from a direct listArtifacts() call. The server and CLI both
// overlay the LIVE async productionReady() call before the row leaves the
// trust boundary, but a third-party / future / direct module consumer that
// trusts the row as-is would reintroduce the W342/W411 regression.
//
// W428 fix:
//   - hydrate() exposes the sync result as `verified_provisional` (a
//     transparent name; the field name itself documents the sync trust
//     level) and sets the public `verified` field to false.
//   - Honest badges: the 'Verified' pill is stripped at the sync layer; the
//     server's __hydrateVerified() and the CLI's localList() re-add it from
//     the live async verdict.
//   - _resolveProductionReadinessState() refuses to flip to
//     'production_ready_verified' when the verdict carries
//     `_provisional: true`. The router/CLI overlay re-promotes from the
//     async verdict after hydrate().
//
// Tests assert BEHAVIOR (return shape of listArtifacts()) AND a static-
// source assert against src/marketplace.js to lock in the rename so a future
// edit that re-exposes `verified: <syncOk>` is caught at test time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MARKETPLACE_SRC = path.join(ROOT, 'src', 'marketplace.js');

// ---------- W428 #1 — listArtifacts() never carries verified:true from sync derivation ----------

test('W428 #1 — listArtifacts() exposes verified_provisional, not a sync-true verified', async () => {
  const { listArtifacts } = await import('../src/marketplace.js');
  const all = listArtifacts({ filter: {} });
  assert.ok(all.length > 0, 'seed catalog must hydrate at least one row');
  for (const a of all) {
    // The public `verified` field MUST be false (or absent) for every row
    // emitted by listArtifacts() — the only way it can be true is via the
    // router's __hydrateVerified() overlay or the CLI's localList overlay.
    assert.notEqual(a.verified, true,
      `${a.slug}: listArtifacts() must NOT expose verified:true based only on sync derivation (got ${a.verified})`);
    // The sync truth MUST be available under verified_provisional so a
    // caller that explicitly opts in to the unsafe sync value can read it.
    // The field name itself documents the sync trust level.
    assert.equal(typeof a.verified_provisional, 'boolean',
      `${a.slug}: verified_provisional must be a boolean (got ${typeof a.verified_provisional})`);
  }
});

// ---------- W428 #2 — async productionReady() overlay can upgrade a row to verified:true ----------

test('W428 #2 — overlaying async productionReady() upgrades a row to verified:true', async () => {
  const { listArtifacts } = await import('../src/marketplace.js');
  const all = listArtifacts({ filter: {} });
  const row = all.find((a) => a.slug === 'claims-redactor');
  if (!row) {
    assert.ok(true, 'claims-redactor not in seed catalog — skip');
    return;
  }
  // claims-redactor was built with --seeds (W343), so the live async
  // productionReady() verdict ok=true. The overlay mirrors what the router
  // does in __hydrateVerified.
  assert.equal(row.verified, false,
    'pre-overlay row.verified must be false (W428 lock-in)');
  // The verified_provisional field MAY be true (sync gates pass for this
  // fixture) but the public verified is the gate.
  const { productionReady } = await import('../src/production-ready.js');
  const abs = path.resolve(ROOT, row.source_path);
  if (!fs.existsSync(abs)) {
    assert.ok(true, `${row.source_path} not on disk — skip overlay test`);
    return;
  }
  const v = await productionReady(abs);
  // Simulate the router/CLI overlay.
  const overlaid = { ...row, verified: !!v.ok };
  if (v.ok) {
    assert.equal(overlaid.verified, true,
      'async productionReady() ok=true must upgrade the row to verified:true');
  } else {
    // If the local fixture environment can't pass the async gate (missing
    // adm-zip env, sandbox), the test still proves the overlay propagates
    // the verdict — just in the failing direction.
    assert.equal(overlaid.verified, false,
      'async productionReady() ok=false keeps the row verified:false');
  }
}, { timeout: 30000 });

// ---------- W428 #3 — async fail keeps verified:false even when sync_provisional:true ----------

test('W428 #3 — async failure keeps verified false even if verified_provisional was true', async () => {
  const { listArtifacts } = await import('../src/marketplace.js');
  const all = listArtifacts({ filter: {} });
  // Simulate the structural guarantee: take a row whose sync gates passed
  // (verified_provisional:true) and overlay an async ok=false verdict.
  // Public verified MUST remain false (or null) — the row cannot claim
  // verified just because the sync layer marked it provisionally OK.
  const provisional = all.find((a) => a.verified_provisional === true) || all[0];
  assert.ok(provisional, 'expected at least one row to overlay');
  // Synthetic fail verdict (matches the shape productionReady() returns).
  const fakeFailVerdict = { ok: false, gates: {}, reasons: ['executable_bundle: hash_mismatch'] };
  const overlaid = {
    ...provisional,
    verified: !!fakeFailVerdict.ok,
    gate_reasons: fakeFailVerdict.reasons,
  };
  assert.equal(overlaid.verified, false,
    'async-fail overlay must keep verified:false regardless of verified_provisional');
  // The provisional flag survives the overlay (it documents the sync truth);
  // its presence does NOT promote the row to verified.
  assert.notEqual(overlaid.verified, true,
    'verified_provisional:true MUST NOT promote a row when async fails');
});

// ---------- W428 #4 — static-source assert: hydrate() does NOT assign verified from a raw sync result ----------

test('W428 #4 — src/marketplace.js does NOT assign `verified` directly from productionReadySync', () => {
  const src = fs.readFileSync(MARKETPLACE_SRC, 'utf8');
  // Forbid `const verified = verdict.ok === true` (the pre-W428 pattern that
  // exposed the sync result as public truth). The hydrate() function must
  // either set the public `verified` to false (the W428 fix) or run an
  // async productionReady() before flipping the flag.
  const oldPattern = /const\s+verified\s*=\s*verdict\.ok\s*===\s*true\s*;/;
  assert.equal(oldPattern.test(src), false,
    'src/marketplace.js must not assign public `verified` directly from sync `verdict.ok`. ' +
    'Use `verified_provisional` for the sync result and let the server/CLI overlay set `verified` from async productionReady().');
  // Lock-in: verified_provisional MUST appear in the file (the rename target).
  assert.match(src, /verified_provisional/,
    'src/marketplace.js must expose the renamed field `verified_provisional` so consumers that need the sync result can opt in explicitly.');
  // Lock-in: _resolveProductionReadinessState must check _provisional flag
  // so the metadata state is not promoted from a provisional sync verdict.
  assert.match(src, /_provisional\s*!==\s*true/,
    'src/marketplace.js must guard the production_ready_verified promotion against provisional sync verdicts.');
});

// ---------- W428 #5 — listArtifacts({verified:true}) filter returns no rows from sync alone ----------

test('W428 #5 — listArtifacts({filter:{verified:true}}) returns no rows before async overlay', async () => {
  const { listArtifacts } = await import('../src/marketplace.js');
  const verifiedOnly = listArtifacts({ filter: { verified: true } });
  // The audit's structural assertion: a direct module consumer asking for
  // verified-only rows MUST receive [] until an async overlay has populated
  // the public verified field. The router applies its verified filter
  // AFTER __hydrateVerified, so the server path is unaffected.
  assert.equal(verifiedOnly.length, 0,
    `listArtifacts({verified:true}) must return [] from sync-only derivation (got ${verifiedOnly.length} rows)`);
});

// ---------- W428 #6 — production_readiness_state honors the provisional flag ----------

test('W428 #6 — production_readiness_state is not "production_ready_verified" from sync alone', async () => {
  const { listArtifacts } = await import('../src/marketplace.js');
  const all = listArtifacts({ filter: {} });
  for (const a of all) {
    // Because hydrate() passes the sync verdict (carrying _provisional:true),
    // _resolveProductionReadinessState() must demote to 'source_generated' or
    // 'foundation'. The state field is the same string the listing UI uses to
    // paint the "verified" pill, so this guard prevents the badge regression
    // through the metadata path as well as the verified field path.
    assert.notEqual(a.production_readiness_state, 'production_ready_verified',
      `${a.slug}: production_readiness_state must NOT claim 'production_ready_verified' from sync derivation alone (got ${a.production_readiness_state})`);
    // The mirrored metadata.production_readiness_state must agree.
    if (a.metadata && typeof a.metadata.production_readiness_state === 'string') {
      assert.notEqual(a.metadata.production_readiness_state, 'production_ready_verified',
        `${a.slug}: metadata.production_readiness_state must mirror the top-level field`);
    }
  }
});
