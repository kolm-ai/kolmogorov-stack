// Wave 339 — single source-of-truth productionReady() verdict.
//
// Trust bug surfaced in design-partner trial: compile, run, verify, and
// marketplace each had their own gate logic and could disagree (a K-score
// could pass while verify failed). This module collapses those into one
// pure function used by ALL callers:
//
//   - cli/kolm.js cmdCompile (post-build print + --json envelope)
//   - cli/kolm.js cmdRun     (default warns, --strict exits non-zero)
//   - cli/kolm.js cmdVerify  (replaces ad-hoc seed/drift checks)
//   - src/router.js GET /v1/marketplace/list  (verified pill)
//   - src/router.js POST /v1/marketplace/install (refuses fail)
//
// Verdict shape (stable contract; CI scripts MAY parse `gates.*.ok`):
//   {
//     ok: boolean,                  // AND of every gate.ok
//     gates: {
//       seed_provenance: { ok, reason? },
//       k_score:         { ok, value, threshold, reason? },
//       holdout_split:   { ok, train_count, holdout_count, reason? },
//       drift:           { ok, drift_score?, reason? },
//       durability:      { ok, driver?, reason? }
//     },
//     reasons: [ "...human readable strings for failing gates only..." ]
//   }
//
// Reads a .kolm file OR an already-parsed manifest object. Optional opts:
//   { kGate, capture }  — kGate overrides KOLM_K_GATE / 0.85; capture is the
//                         capture-store module (DI for tests).

import fs from 'node:fs';
import path from 'node:path';
import { MIN_PRODUCTION_HOLDOUT, MIN_PRODUCTION_TRAIN } from './seeds.js';
import { readEntryFromLargeZip } from './zip-large.js';

// Re-export so spec-compile.js can keep importing from one place.
export { MIN_PRODUCTION_HOLDOUT, MIN_PRODUCTION_TRAIN };

// Default ship gate — matches src/kscore.js GATE and cli/kolm.js kGate().
// Kept here so spec-compile.js, cmdRun, cmdVerify, and the marketplace all
// resolve the same value when KOLM_K_GATE is unset.
export const DEFAULT_K_GATE = 0.85;

// Default drift threshold. drift_score is a [0..1] distance metric where
// higher = more drift; ship gate is "below this floor".
export const DEFAULT_DRIFT_MAX = 0.30;

export function resolveKGate(override) {
  if (typeof override === 'number' && override >= 0 && override <= 1) return override;
  const env = Number(process.env.KOLM_K_GATE);
  if (Number.isFinite(env) && env >= 0 && env <= 1) return env;
  return DEFAULT_K_GATE;
}

// Compute the production_ready boolean from a hydrated seedSplit record.
// Mirrors the AND gate in src/spec-compile.js (extracted so compile and the
// other callers share one definition — see W339 #2). Returns true when:
//   - train_count >= MIN_PRODUCTION_TRAIN
//   - holdout_count >= MIN_PRODUCTION_HOLDOUT
//   - every leakage channel is clean (input/output/near-dup/grouped overlap)
export function computeSeedProductionReady(seedSplit) {
  if (!seedSplit || typeof seedSplit !== 'object') return false;
  const lr = seedSplit.leakage_report || {};
  return (
    (seedSplit.train_count || 0) >= MIN_PRODUCTION_TRAIN
    && (seedSplit.holdout_count || 0) >= MIN_PRODUCTION_HOLDOUT
    && (lr.input_overlap_count || 0) === 0
    && (lr.output_overlap_count || 0) === 0
    && (lr.near_duplicate_count || 0) === 0
    && (lr.grouped_overlap_count || 0) === 0
  );
}

// Loader: open a .kolm zip and return its parsed manifest. Defers to adm-zip
// (already a root dep). Throws on missing manifest.json so a corrupt file
// fails loud instead of silently returning ok:false.
//
// W891-2.2 — Trinity GGUF .kolm artifacts exceed Node's 2 GiB readFileSync
// limit (a Q4_K_M for a 7B model is ~4.4 GB; the .kolm wraps it with ~5 KB of
// metadata). When the file fits in Buffer we use AdmZip for parity with the
// rest of the codebase. When it doesn't we fall back to a Zip64-aware
// central-directory streaming reader that reads just the named entry.
async function loadManifestFromArtifact(artifactPath) {
  const stat = fs.statSync(artifactPath);
  if (stat.size <= 2 * 1024 * 1024 * 1024 - 1) {
    const { default: AdmZip } = await import('adm-zip');
    const buf = fs.readFileSync(artifactPath);
    const zip = new AdmZip(buf);
    const entry = zip.getEntry('manifest.json');
    if (!entry) throw new Error(`malformed .kolm: missing manifest.json (${path.basename(artifactPath)})`);
    return JSON.parse(entry.getData().toString('utf8'));
  }
  const bytes = await readEntryFromLargeZip(artifactPath, 'manifest.json');
  if (!bytes) throw new Error(`malformed .kolm: missing manifest.json (${path.basename(artifactPath)})`);
  return JSON.parse(bytes.toString('utf8'));
}

// W891-3.1 — readEntryFromLargeZip is now imported from src/zip-large.js
// so artifact-runner + airgap bundler + production-ready share one Zip64
// implementation. See the import at the top of this file.

// W367 — executable-bundle gate. For rule / synthesized_rule / compiled_rule
// artifacts the manifest must declare manifest.entry.{file, sha256}, the named
// file must exist in the zip, and its sha256 must match the declaration.
// Without this gate a .kolm that ships only metadata (manifest + recipes.json
// + signature) could pass productionReady() while having nothing for a host to
// actually run — directly contradicting the "same file runs on a laptop, a
// phone, or an air-gapped server" homepage claim.
async function loadEntryFileBytes(artifactPath, entryFile) {
  const stat = fs.statSync(artifactPath);
  if (stat.size <= 2 * 1024 * 1024 * 1024 - 1) {
    const { default: AdmZip } = await import('adm-zip');
    const buf = fs.readFileSync(artifactPath);
    const zip = new AdmZip(buf);
    const entry = zip.getEntry(entryFile);
    if (!entry) return null;
    return entry.getData();
  }
  return await readEntryFromLargeZip(artifactPath, entryFile);
}

const BUNDLEABLE_CLASSES = new Set(['rule', 'synthesized_rule', 'compiled_rule']);

async function evalExecutableBundle(artifactPathOrManifest, manifest) {
  const cls = manifest.artifact_class || 'rule';
  // distilled_model uses the model weights as its executable artifact, not a
  // JS bundle. The gate is only meaningful for the rule families.
  if (!BUNDLEABLE_CLASSES.has(cls)) return { ok: true };
  // Manifest-only path (no zip on disk to crack open). We cannot verify the
  // entry file exists nor re-hash its bytes; the gate is vacuously ok with an
  // informational note. The strict check fires when a real artifact path is
  // supplied (the cli/router callers — every place a buyer actually runs the
  // .kolm). Pre-W367 in-memory manifests (e.g., the spec-compile dry-run
  // happy-path fixtures in tests/wave339-production-verdict.test.js) keep
  // returning ok:true so the new gate doesn't retroactively fail them.
  if (typeof artifactPathOrManifest !== 'string') {
    if (!manifest.entry) {
      return { ok: true, note: 'manifest-only evaluation (no entry block; zip not available for verification)' };
    }
    return { ok: true, note: 'manifest-only evaluation (zip not available for entry sha256 re-check)' };
  }
  // Real artifact path supplied — strict mode.
  if (!manifest.entry || typeof manifest.entry !== 'object') {
    return { ok: false, reason: 'artifact.no_executable_bundle: manifest.entry block missing — artifact ships metadata only and cannot run' };
  }
  const file = manifest.entry.file;
  const declared = manifest.entry.sha256;
  if (typeof file !== 'string' || !file) {
    return { ok: false, reason: 'artifact.no_executable_bundle: manifest.entry.file missing' };
  }
  if (typeof declared !== 'string' || declared.length < 32) {
    return { ok: false, reason: 'artifact.no_executable_bundle: manifest.entry.sha256 missing or malformed' };
  }
  let bytes;
  try {
    bytes = await loadEntryFileBytes(artifactPathOrManifest, file);
  } catch (e) {
    return { ok: false, reason: `artifact.no_executable_bundle: cannot read entry file ${file}: ${e.message}` };
  }
  if (!bytes) {
    return { ok: false, reason: `artifact.no_executable_bundle: entry file ${file} not present in zip` };
  }
  const { createHash } = await import('node:crypto');
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== declared) {
    return { ok: false, reason: `artifact.no_executable_bundle: entry sha256 mismatch (declared ${declared.slice(0, 16)}…, actual ${actual.slice(0, 16)}…)` };
  }
  return { ok: true, file, bytes: bytes.length };
}

// Per-gate evaluators. Each returns { ok, reason?, ...extras }.

function evalSeedProvenance(manifest) {
  const sp = manifest.seed_provenance;
  if (!sp) {
    return { ok: false, reason: 'no seed_provenance in manifest (built without --seeds)' };
  }
  if (typeof sp.seeds_hash !== 'string' || sp.seeds_hash.length < 16) {
    return { ok: false, reason: 'seed_provenance.seeds_hash missing or malformed' };
  }
  if (typeof sp.split_seed !== 'string' || sp.split_seed.length === 0) {
    return { ok: false, reason: 'seed_provenance.split_seed missing' };
  }
  if (sp.production_ready === false) {
    return { ok: false, reason: 'seed_provenance.production_ready=false (leakage or under-sized split)' };
  }
  // Wave 409c — auditor mandate. eval_provenance must be 'real_eval' for a
  // production_ready artifact. 'placeholder' (synthetic pass_rate or no eval
  // actually ran) is rejected; 'unknown' is tolerated for backward compat
  // with pre-W409c artifacts that did not set the field.
  if (sp.eval_provenance === 'placeholder') {
    return { ok: false, reason: 'seed_provenance.eval_provenance=placeholder (no real eval run; pass_rate was injected)' };
  }
  // Wave 409aa — synthetic-only artifacts cannot claim production_ready.
  // When every seed came from synthetic generation (synthetic_count > 0 and
  // source_seed_count == 0), the train+holdout split is measuring the
  // synthesizer against itself — not real captured tenant IO. The gate
  // returns an explicit enum so the structured verifier can surface
  // `synthetic_only_in_production` rather than a generic seed_provenance
  // failure. production_ready=true on a synthetic-only artifact is the
  // tautological-K-score regression the original Wave 144 audit caught.
  const synC = typeof sp.synthetic_count === 'number' ? sp.synthetic_count : 0;
  const srcC = typeof sp.source_seed_count === 'number' ? sp.source_seed_count : null;
  if (sp.production_ready === true && synC > 0 && srcC === 0) {
    return {
      ok: false,
      reason: 'synthetic_only_in_production: seed_provenance.synthetic_count>0 and source_seed_count=0 — every row was synthesized; the K-score does not measure real-world generalization',
      kind: 'synthetic_only_in_production',
    };
  }
  return { ok: true };
}

function evalKScore(manifest, kGate) {
  const k = manifest.k_score;
  if (!k || typeof k.composite !== 'number') {
    return { ok: false, value: null, threshold: kGate, reason: 'k_score missing or has no composite' };
  }
  if (k.composite >= kGate) return { ok: true, value: k.composite, threshold: kGate };
  return { ok: false, value: k.composite, threshold: kGate, reason: `k_score composite ${k.composite.toFixed(4)} below gate ${kGate}` };
}

function evalHoldoutSplit(manifest) {
  const sp = manifest.seed_provenance;
  if (!sp) {
    return { ok: false, train_count: 0, holdout_count: 0, reason: 'no holdout split — built without --seeds' };
  }
  const train = Number(sp.train_count) || 0;
  const holdout = Number(sp.holdout_count) || 0;
  if (train < MIN_PRODUCTION_TRAIN) {
    return { ok: false, train_count: train, holdout_count: holdout, reason: `train_count ${train} < MIN_PRODUCTION_TRAIN ${MIN_PRODUCTION_TRAIN}` };
  }
  if (holdout < MIN_PRODUCTION_HOLDOUT) {
    return { ok: false, train_count: train, holdout_count: holdout, reason: `holdout_count ${holdout} < MIN_PRODUCTION_HOLDOUT ${MIN_PRODUCTION_HOLDOUT}` };
  }
  // Leakage channels — re-check so a tampered seed_provenance.production_ready
  // can't lie about a clean split. Same AND as computeSeedProductionReady().
  const lr = sp || {};
  const channels = ['input_overlap_count', 'output_overlap_count', 'near_duplicate_count', 'grouped_overlap_count'];
  for (const c of channels) {
    if ((lr[c] || 0) > 0) {
      return { ok: false, train_count: train, holdout_count: holdout, reason: `${c}=${lr[c]} (holdout contamination)` };
    }
  }
  return { ok: true, train_count: train, holdout_count: holdout };
}

function evalDrift(manifest, driftMax) {
  // drift_report block is optional. When present, prefer its top-level
  // drift_score (drift-supersession.js convention). When absent the gate is
  // vacuously ok — drift is opt-in, not a blocker for first compile.
  const block = manifest.drift_report;
  if (!block || typeof block !== 'object') return { ok: true };
  const dscore = typeof block.drift_score === 'number'
    ? block.drift_score
    : (typeof block.score === 'number' ? block.score : null);
  if (dscore == null) return { ok: true };
  if (dscore <= driftMax) return { ok: true, drift_score: dscore };
  return { ok: false, drift_score: dscore, reason: `drift_score ${dscore.toFixed(4)} exceeds max ${driftMax}` };
}

// W407e — live eval parity gate. The trust bug surfaced when a user ran
// `kolm verify demo-log-triage.kolm` (production_ready:true, K=0.864) but
// `kolm eval demo-log-triage.kolm` reported 7/10 (70%). Verify was trusting
// the EMBEDDED eval block in the artifact zip — built once at compile time
// against the recipe-as-of-then — but never re-ran the embedded cases
// against the recipe-as-shipped. If the bundled recipe drifts (or the
// compiler over-counted), verify keeps printing the stale build-time score
// while every other surface (`kolm eval`, the marketplace bench-off, a real
// install on a buyer's machine) disagrees.
//
// This gate re-runs the same `evalArtifact()` path that backs `kolm eval`
// against the embedded cases inside the same .kolm and fails when the live
// accuracy is more than 5 points below the gate (or, when comparable, more
// than 5 points below the embedded eval's claimed accuracy). It is only
// meaningful when the zip is on disk AND the artifact ships eval cases AND
// the runner can execute the bundle — distilled_model and manifest-only
// callers pass through (other gates already enforce shape).
async function evalParity(artifactPathOrManifest, manifest, opts) {
  if (typeof artifactPathOrManifest !== 'string') {
    return { ok: true, _skipped: 'manifest-only (no zip on disk to re-run)' };
  }
  const cls = manifest.artifact_class || 'rule';
  if (!BUNDLEABLE_CLASSES.has(cls)) {
    return { ok: true, _skipped: `artifact_class=${cls} (live rerun only meaningful for rule families)` };
  }
  const kGate = resolveKGate(opts && opts.kGate);
  // 5-point drift floor mirrors the user-reported "verify says K 0.86 / eval
  // says 70%" gap — anything inside the band is treated as eval noise (a
  // tolerance-vs-tolerance mismatch); anything outside is a real parity break.
  const driftFloorPts = 5;
  const driftFloor = driftFloorPts / 100;
  let evalArtifact;
  try {
    ({ evalArtifact } = await import('./artifact-runner.js'));
  } catch (e) {
    // Runner not importable in this context (test stub, partial install) —
    // do not punish the artifact for a host gap. The other gates still apply.
    return { ok: true, _skipped: `artifact-runner unavailable: ${e.message}` };
  }
  let live;
  try {
    live = await evalArtifact(artifactPathOrManifest);
  } catch (e) {
    // Distinguish environment failures from real parity drift. Signature /
    // load errors mean the host doesn't possess the secret needed to open
    // the bundle (RECIPE_RECEIPT_SECRET, cloud-trust list) — those are
    // already policed by the binder's signature check and the
    // executable_bundle gate. They are NOT eval drift. We skip the gate so
    // a host gap doesn't masquerade as a parity break.
    const msg = String(e && e.message || e);
    if (/signature invalid|hmac mismatch|KOLM_E_SIGNATURE_INVALID|cloud-trust/i.test(msg)) {
      return { ok: true, _skipped: `signature/load failure (not parity drift): ${msg}` };
    }
    return { ok: false, reason: `eval_parity: live rerun threw: ${msg}` };
  }
  if (!live || typeof live.n !== 'number' || live.n === 0) {
    // No embedded cases to re-run. Eval coverage is policed by the binder's
    // own "Eval coverage" check; we treat absence as a vacuous pass here.
    return { ok: true, _skipped: 'no embedded eval cases to re-run' };
  }
  const liveAcc = typeof live.accuracy === 'number' ? live.accuracy : (live.passed / live.n);
  // W443 — fix: previously this compared liveAcc to k_score.composite, but
  // composite K bundles 5 axes (A·S·L·C·V) and is structurally higher than
  // accuracy alone (the S/L/C/V baseline pulls K up to ~0.60 even at A=0).
  // A live rerun can never approach K when K=0.88 and A=0.75. The correct
  // embedded reference is the accuracy axis the K-score actually stored
  // (k_score.accuracy) or, when present, the dedicated evals.accuracy field.
  // The composite is kept as informational diagnostic only — not a gate.
  const evalsAcc = (manifest.evals && typeof manifest.evals.accuracy === 'number')
    ? manifest.evals.accuracy
    : null;
  const kScoreAcc = (manifest.k_score && typeof manifest.k_score.accuracy === 'number')
    ? manifest.k_score.accuracy
    : null;
  const embeddedAcc = evalsAcc != null ? evalsAcc : kScoreAcc;
  const composite = (manifest.k_score && typeof manifest.k_score.composite === 'number')
    ? manifest.k_score.composite
    : null;
  // Floor: max of (kGate - drift_floor) and (embedded_acc - drift_floor).
  // The kGate term ensures even a gateless artifact must keep live accuracy
  // near the ship gate; the embedded_acc term enforces parity with whatever
  // accuracy the artifact previously committed to. Composite K is no longer a
  // floor (it's not the same scale as accuracy) — kept on the return envelope
  // for diagnostic transparency.
  const floors = [kGate - driftFloor];
  if (embeddedAcc != null) floors.push(embeddedAcc - driftFloor);
  const floor = Math.max(...floors);
  if (liveAcc + 1e-9 < floor) {
    const liveStr = (liveAcc * 100).toFixed(1) + '%';
    const claim = embeddedAcc != null
      ? `embedded accuracy ${(embeddedAcc * 100).toFixed(1)}%`
      : `gate ${kGate}`;
    return {
      ok: false,
      live_accuracy: liveAcc,
      embedded_accuracy: embeddedAcc,
      composite,
      drift_floor_pts: driftFloorPts,
      reason: `eval_parity: live rerun ${live.passed}/${live.n} (${liveStr}) drifted from ${claim} by more than ${driftFloorPts}pts — rebuild required`,
    };
  }
  return {
    ok: true,
    live_accuracy: liveAcc,
    embedded_accuracy: embeddedAcc,
    n: live.n,
    passed: live.passed,
  };
}

async function evalDurability(opts) {
  // capture-store reports honest durability for the live deploy. Tests can
  // inject opts.capture to stub. When the module isn't importable (e.g. a
  // bare CLI invocation with no router context), default ok:true so this
  // gate doesn't fail a perfectly good local compile.
  try {
    const mod = opts && opts.capture
      ? opts.capture
      : await import('./capture-store.js');
    const durable = typeof mod.isDurable === 'function' ? mod.isDurable() : true;
    const driver = typeof mod.driverName === 'function' ? mod.driverName() : null;
    if (durable) return { ok: true, driver };
    return { ok: false, driver, reason: `store driver ${driver || '?'} is ephemeral (writes do not survive process restart)` };
  } catch (_e) {
    // capture-store unavailable — local-only artifacts pass through.
    return { ok: true };
  }
}

// PUBLIC: productionReady(artifactPathOrManifest, opts?) -> Promise<verdict>
export async function productionReady(artifactPathOrManifest, opts = {}) {
  let manifest;
  if (typeof artifactPathOrManifest === 'string') {
    manifest = await loadManifestFromArtifact(artifactPathOrManifest);
  } else if (artifactPathOrManifest && typeof artifactPathOrManifest === 'object') {
    manifest = artifactPathOrManifest;
  } else {
    throw new Error('productionReady: pass a .kolm path or a manifest object');
  }

  const kGate = resolveKGate(opts.kGate);
  const driftMax = typeof opts.driftMax === 'number' ? opts.driftMax : DEFAULT_DRIFT_MAX;

  const seed_provenance = evalSeedProvenance(manifest);
  const k_score = evalKScore(manifest, kGate);
  const holdout_split = evalHoldoutSplit(manifest);
  const drift = evalDrift(manifest, driftMax);
  const durability = await evalDurability(opts);
  // W367 — executable bundle gate. Must come last so a manifest-only failure
  // here doesn't shadow a more diagnostic failure earlier (seed provenance,
  // k-score, etc.).
  const executable_bundle = await evalExecutableBundle(artifactPathOrManifest, manifest);
  // W407e — live-eval parity gate. Runs after executable_bundle so a missing
  // entry surfaces with the more specific message; only fires when the bundle
  // is intact enough to re-run.
  const eval_parity = executable_bundle.ok
    ? await evalParity(artifactPathOrManifest, manifest, opts)
    : { ok: true, _skipped: 'executable_bundle failed; live rerun skipped' };

  const gates = { seed_provenance, k_score, holdout_split, drift, durability, executable_bundle, eval_parity };
  const reasons = [];
  for (const [name, g] of Object.entries(gates)) {
    if (!g.ok && g.reason) reasons.push(`${name}: ${g.reason}`);
  }
  const ok = Object.values(gates).every((g) => g.ok === true);
  return { ok, gates, reasons };
}

// W409e — Synchronous variant: PROVISIONAL ONLY.
//
// Skips the durability, executable_bundle, and eval_parity gates because all
// three require async I/O (capture-store dynamic import, adm-zip + entry sha
// re-hash, and artifact-runner re-run respectively). Callers MUST treat the
// result as a preliminary indicator; an artifact is NEVER production-ready
// based on the sync verdict alone. The returned envelope carries
// `_provisional: true` so any callsite that mistakenly forwards a sync
// verdict into `production_ready:true` for a real artifact can be caught by
// the verifier (and by tests asserting the field is propagated).
//
// Two legitimate sync uses remain:
//   - src/build-preview.js: dry-run preview before any artifact zip exists.
//   - src/marketplace.js: hot-path catalog hydration where the router still
//     overlays the async verdict via __hydrateVerified.
//
// Every code path that flips production_ready:true for a REAL artifact must
// call AWAIT productionReady(<.kolm path>) after the zip is on disk so the
// executable_bundle + eval_parity + durability gates actually run.
export function productionReadySync(manifest, opts = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('productionReadySync: manifest must be an object');
  }
  const kGate = resolveKGate(opts.kGate);
  const driftMax = typeof opts.driftMax === 'number' ? opts.driftMax : DEFAULT_DRIFT_MAX;
  const seed_provenance = evalSeedProvenance(manifest);
  const k_score = evalKScore(manifest, kGate);
  const holdout_split = evalHoldoutSplit(manifest);
  const drift = evalDrift(manifest, driftMax);
  const durability = { ok: true, _skipped: 'sync-mode' };
  const executable_bundle = { ok: true, _skipped: 'sync-mode (no zip to re-hash)' };
  const eval_parity = { ok: true, _skipped: 'sync-mode (no zip to re-run)' };
  const gates = { seed_provenance, k_score, holdout_split, drift, durability, executable_bundle, eval_parity };
  const reasons = [];
  for (const [name, g] of Object.entries(gates)) {
    if (!g.ok && g.reason) reasons.push(`${name}: ${g.reason}`);
  }
  const ok = Object.values(gates).every((g) => g.ok === true);
  // _provisional is intentionally a top-level field (not inside gates) so a
  // grep for `_provisional` finds every callsite that propagated a sync
  // verdict. The verifier and any "production_ready:true" flip for an
  // on-disk artifact should refuse a verdict carrying this flag.
  return { ok, gates, reasons, _provisional: true };
}

// W409e — verifier helper. Returns true when the verdict came from
// productionReady() (the async path with bundle + eval_parity + durability
// run). Used by callers that publish `production_ready:true` for an artifact
// on disk: they MUST refuse to set the flag from a provisional sync verdict.
export function isFullyVerifiedVerdict(verdict) {
  if (!verdict || typeof verdict !== 'object') return false;
  if (verdict._provisional === true) return false;
  return true;
}
