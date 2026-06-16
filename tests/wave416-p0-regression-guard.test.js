// W416 — defense-in-depth regression guards for the four W411 P0 fixes the
// 2026-05-19 audit re-named. The audit claimed they were broken; verification
// confirmed they are SHIPPED with explicit `W411 P0 #N` comments. These
// static-source assertions ensure those fixes cannot silently regress.
//
// Each test names exactly what the W411 fix guarantees, and asserts the
// guarantee is still present in the current source. Behavior-level integration
// (golden e2e) lives in wave411-audit-finish-loop tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const COMPILE_PATH = path.join(REPO, 'src', 'compile-pipeline.js');
const DISTILL_PATH = path.join(REPO, 'src', 'distill-pipeline.js');

const compileSrc = fs.readFileSync(COMPILE_PATH, 'utf8');
const distillSrc = fs.readFileSync(DISTILL_PATH, 'utf8');

test('W416 #1 — compile-pipeline passes trainPairs (not corpusPairs) to distill()', () => {
  // W411 hardened this guarantee: distillPairs is train-ONLY. The empty-train
  // corpus fallback now fails closed (throw unless allow_stub mirrors corpusPairs
  // INTO trainPairs above), so by the time distillPairs is assigned it is exactly
  // the train set - corpusPairs never reaches distillation across the holdout
  // boundary. Assert the current, stronger train-only form rather than the
  // superseded `: corpusPairs` ternary (which W411 forbids).
  assert.match(compileSrc, /const\s+distillPairs\s*=\s*trainPairs\s*;/,
    'distillPairs must be assigned trainPairs (train-only), not corpusPairs');
  assert.ok(
    !/distillPairs\s*=\s*\([^)]*\)\s*\?\s*trainPairs\s*:\s*corpusPairs/.test(compileSrc),
    'the silent (trainPairs ? trainPairs : corpusPairs) corpus fallback must be gone (W411)');
  // The distill() call must be fed from the train-only set (distillPairs or the
  // curriculum-ordered view of it, distillFeed) - never raw corpusPairs.
  const distillCall = compileSrc.match(/distill\(\s*\{[\s\S]{0,800}?pairs_override:\s*(\w+)/);
  assert.ok(distillCall, 'distill() call with pairs_override must exist');
  assert.ok(
    ['distillPairs', 'distillFeed'].includes(distillCall[1]),
    'pairs_override must be the train-only distillPairs/distillFeed, not corpusPairs');
});

test('W416 #2 — prepareDistillCorpus preserves source_type metadata', () => {
  // Pair-push call must include source_type field on the constructed object.
  const pushBlock = distillSrc.match(/pairs\.push\(\s*\{[\s\S]{0,500}?source_type[\s\S]{0,400}?\}\s*\)/);
  assert.ok(pushBlock, 'pairs.push must construct object including source_type');
  assert.match(pushBlock[0], /source_type:\s*ev\.source_type\s*\|\|\s*['"]capture['"]/,
    'source_type must default to "capture" when not on the event');
});

test('W416 #3 — prepareDistillCorpus preserves tenant_id + approved + redaction_policy + holdout_only', () => {
  const pushBlock = distillSrc.match(/pairs\.push\(\s*\{[\s\S]{0,800}?\}\s*\)/);
  assert.ok(pushBlock, 'pairs.push block must exist');
  const block = pushBlock[0];
  assert.match(block, /\btenant_id:/, 'tenant_id must be preserved');
  assert.match(block, /\bapproved:/, 'approved must be preserved');
  assert.match(block, /\bredaction_policy:/, 'redaction_policy must be preserved');
  assert.match(block, /\bholdout_only:/, 'holdout_only must be preserved');
  assert.match(block, /\bfixed_output:/, 'fixed_output must be preserved');
  assert.match(block, /\bevent_id:/, 'event_id must be preserved');
});

test('W416 #4 — distill() filters holdout_only rows from pairs_override (chokepoint)', () => {
  // The chokepoint at distill() boundary: after pairs is resolved, holdout_only
  // rows are stripped BEFORE the worker seeds.jsonl write.
  assert.match(distillSrc, /pairs\s*=\s*pairs\.filter\(\s*\(\s*p\s*\)\s*=>\s*!\(\s*p\s*&&\s*p\.holdout_only\s*\)\s*\)/,
    'distill() must filter holdout_only rows from pairs');
  // The chokepoint must also fire on the prepareDistillCorpus(split:"train") path.
  assert.match(distillSrc, /split\s*===\s*['"]train['"][\s\S]{0,500}?filter\(\s*\(\s*p\s*\)\s*=>\s*!p\.holdout_only\s*\)/,
    'prepareDistillCorpus(split:"train") must strip holdout_only at the consumer boundary');
});

test('W416 #5 — compileFull throws on synthetic-only seeds without allow_synthetic', () => {
  // The gate at compile-pipeline.js: when syntheticCount === sourceSeedCount,
  // no allow_synthetic, no force → throw.
  assert.match(compileSrc, /syntheticCount\s*===\s*sourceSeedCount\s*&&\s*!allowSynthetic\s*&&\s*!force/,
    'synthetic-only gate condition must match');
  assert.match(compileSrc, /synthetic-only seeds/, 'gate must throw with synthetic-only message');
});

test('W416 #6 — productionReady is called on the on-disk artifact, not pipeline metadata', () => {
  // productionReady must be invoked with artifactResult.outPath (the file path),
  // not with the in-memory metadata object.
  assert.match(compileSrc, /productionReady\(\s*artifactResult\.outPath\s*\)/,
    'productionReady must be called on the on-disk artifact path');
});

test('W416 #7 — bundle phase carries holdout_excluded_count + row_hash_dedupe_count on the yield', () => {
  // The bundle yield surfaces these counters so the watcher can confirm the
  // chokepoints ran. The audit chain depends on these being visible.
  assert.match(compileSrc, /holdout_excluded_count/, 'bundle yield must surface holdout_excluded_count');
  assert.match(compileSrc, /row_hash_dedupe_count/, 'bundle yield must surface row_hash_dedupe_count');
});

test('W416 #8 — content-based train/holdout disjointness (row-hash intersection check)', () => {
  // Identity-based check (event_id intersection) AND content-based check
  // (prompt+response hash intersection). Both must throw on overlap unless --force.
  assert.match(compileSrc, /row-hash overlap/, 'row-hash disjointness check message must exist');
  assert.match(compileSrc, /content-based train\/holdout leakage/, 'leakage-error wording must exist');
});

test('W416 #9 — gated stub fallback requires allow_stub or force', () => {
  // The previous "silent stub on any workbench rejection" was W409c P0; the fix
  // requires explicit allow_stub or force, otherwise re-throws fail-closed.
  assert.match(compileSrc, /stub_blocked:\s*true/, 'stub-blocked log must fire when fallback denied');
  assert.match(compileSrc, /workbench rejected corpus and stub fallback requires/, 'fail-closed error message must exist');
});

test('W416 #10 — distill seed writer dedupes by row-hash before worker write', () => {
  // The distill iterator's seed write must include the W411 dedupe counter,
  // even when seeds are passed directly via pairs_override.
  assert.match(distillSrc, /holdout_excluded_count\s*=\s*_holdoutBefore\s*-\s*pairs\.length/,
    'distill() must compute holdout_excluded_count from filter');
});
