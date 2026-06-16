// Wave 381 - compile pipeline orchestrator.
//
// The "captured calls → owned model" full chain. Emits async events for each
// phase so a watcher (CLI --watch, websocket, log tail) can stream progress
// to the user without blocking. Heavy ML stays in workers/; this file only
// stitches the existing modules together:
//
//   src/training-planner.js       task detection, backbone pick
//   src/tokenizer-train.js        tokenizer train
//   src/distill-pipeline.js       distill orchestrator (wraps worker)
//   src/dataset-workbench.js      train/holdout split (W369)
//   src/artifact.js               .kolm builder + recipe.bundle.mjs (W367)
//   src/production-ready.js       6-gate verdict (W339)
//   src/device-install.js         install to local/ssh/http device (W372)
//
// Phases (in order):
//   1.  plan                  → {phase:'plan', plan_id, task, backbone}
//   2.  tokenizer_train       → {phase:'tokenizer_train', tokenizer_path}
//   3.  corpus_prepare        → {phase:'corpus_prepare', pair_count}
//   4.  curate                → {phase:'curate', kept, dropped} (W921 data-engine)
//   5.  dataset_split         → {phase:'dataset_split', train_id, holdout_id}
//   6.  distill (repeated)    → {phase:'distill', step, loss, k_score}
//   7.  distill_eval          → {phase:'distill_eval', holdout_k_score}
//   8.  quantize              → {phase:'quantize', precision}
//   9.  bundle                → {phase:'bundle', recipe_bundle_path}
//   10. sign                  → {phase:'sign', signature_hash}
//   11. verdict               → {phase:'verdict', production_ready, gates}
//   12. regression_gate       → {phase:'regression_gate', verdict} (W808 promotion gate)
//   13. install               → {phase:'install', target?}
//   14. done                  → {phase:'done', artifact_path, artifact_hash}
//
// Each phase writes its own log under ~/.kolm/jobs/<job_id>/<phase>.log so
// `kolm jobs <id>` can tail per-phase progress. Honors opts.strict (fail on
// any gate fail before install), opts.force (override gate fails), opts.no_sign,
// opts.no_install.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { plan as plannerPlan } from './training-planner.js';
import { trainTokenizer, DEFAULT_VOCAB_SIZES } from './tokenizer-train.js';
import { distill, prepareDistillCorpus, selectStudentBackbone, MODES as DISTILL_MODES } from './distill-pipeline.js';
import { createDataset, splitDataset } from './dataset-workbench.js';
import { MIN_PRODUCTION_HOLDOUT, MIN_PRODUCTION_TRAIN } from './seeds.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

export const PIPELINE_PHASES = [
  'plan',
  'tokenizer_train',
  'corpus_prepare',
  'curate',
  'dataset_split',
  'distill',
  'distill_eval',
  'quantize',
  'bundle',
  'sign',
  'verdict',
  'regression_gate',
  'install',
  'done',
];

// W808-BLOCK - canonical exit code surfaced when the W808 regression gate
// returns verdict 'rollback' (or the compile-eval-gate blocks promotion) and
// the caller did not pass --force / --force-promote. Mirrors the CLI's
// EXIT.GATE_FAIL (2) so `kolm compile` can map a rollback to a non-zero,
// CI-actionable exit without importing the CLI's private EXIT table. The
// pipeline never calls process.exit() itself (it is a library); it tags the
// 'done' / 'regression_gate' phase with { gate_exit_code } so the CLI wrapper
// can honor it. See crossFileNeeds.cliCommands for the wiring.
export const PRODUCTION_GATE_FAILED_EXIT = 2;

// Terminal verdicts from src/distill-pipeline.js _w808RegressionGate that BLOCK
// promotion unless force is set. 'rollback' = a measured regression vs the
// prior artifact in the same namespace. 'needs_human' = the candidate has no
// resolvable K-Score, so we cannot prove non-regression (fail-closed).
const W808_BLOCKING_VERDICTS = Object.freeze(['rollback', 'needs_human']);

function _home() { return process.env.HOME || process.env.USERPROFILE || os.homedir(); }
function _kolmDir() {
  return process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
}
function _jobsDir() { const p = path.join(_kolmDir(), 'jobs'); fs.mkdirSync(p, { recursive: true }); return p; }
function _newJobId() { return 'job_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'); }

function _phaseLogPath(jobId, phase) {
  const dir = path.join(_jobsDir(), jobId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, phase + '.log');
}

function _writePhaseLog(jobId, phase, payload) {
  const p = _phaseLogPath(jobId, phase);
  const ts = new Date().toISOString();
  const line = `[${ts}] ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`;
  fs.appendFileSync(p, line, 'utf8');
}

// Wave 409c - auditor mandate. The bundle phase used to emit a fake
// identity echo recipe + hard-coded pass_rate_positive: 0.95 + a stub
// seed_provenance with production_ready:true. That let a pipeline that
// never actually evaluated anything ship a .kolm labelled production-ready.
//
// Post-409c contract:
//   1. Identity / echo / stub recipes produce production_ready:false UNLESS
//      the source task is explicitly task_type:'echo' AND opts.allow_stub
//      is set. Default rejects stub.
//   2. Build consumes only the approved train split. Reject if seeds are
//      synthetic-only without explicit opts.allow_synthetic override.
//   3. Eval runs against a DISJOINT holdout. Verifier checks no overlap by
//      row-hash set intersection (not just train_ids equality).
//   4. Receipt MUST record: split_seed, train_hash, holdout_hash,
//      source_seed_count, approved_count, synthetic_count.
//   5. If pass_rate is injected without a real eval run, mark the artifact
//      eval_provenance:'placeholder' and force production_ready:false.
//   6. --allow-stub flag exists for the rare echo-task case; default rejects.

const ECHO_RECIPE_NAME = 'wave381 distill-shim';

function _canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(_canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + _canonicalJson(value[k])).join(',') + '}';
}

// Hash a single (input, output) pair deterministically. The row hash is the
// auditor's primary disjointness probe - train.rowhash ∩ holdout.rowhash must
// be empty by construction. We use both prompt+response so a benign rewrite
// of either side is enough to break the equivalence (false-positive bias is
// fine; we err on the side of "treat as distinct").
function _rowHash(pair) {
  const canon = _canonicalJson({
    p: String(pair && pair.prompt != null ? pair.prompt : (pair && pair.input != null ? pair.input : '')),
    r: String(pair && pair.response != null ? pair.response : (pair && pair.output != null ? pair.output : '')),
  });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

// Hash an entire array of pairs (the auditor's train_hash / holdout_hash
// field). Stable across machines + ordering-sensitive (the split-signature
// pins ordering via its own hash, so we hash the rows as supplied).
function _rowsHash(pairs) {
  const h = crypto.createHash('sha256');
  for (const p of pairs) h.update(_rowHash(p)).update('|');
  return h.digest('hex');
}

// Real disjointness check by row-hash set intersection. Returns the
// overlap count + sample of offending hashes (capped at 5) so the verifier
// can surface a clear reason.
function _rowOverlap(trainPairs, holdoutPairs) {
  const ts = new Set(trainPairs.map(_rowHash));
  const offenders = [];
  for (const h of holdoutPairs) {
    const hh = _rowHash(h);
    if (ts.has(hh)) {
      offenders.push(hh);
      if (offenders.length >= 5) break;
    }
  }
  return { overlap_count: offenders.length, sample: offenders };
}

// Detect echo recipes (synthesized identity / stub recipes that just mirror
// input → echoed:input). Used to gate production_ready when the task type
// is not explicitly 'echo'.
function _isEchoRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object') return false;
  if (typeof recipe.source !== 'string') return false;
  // The wave381 identity shim ships a fixed name + a tell-tale `echoed:` body.
  if (recipe.name === ECHO_RECIPE_NAME) return true;
  return /\becho\b/i.test(recipe.source) && /\bechoed\s*:/i.test(recipe.source);
}

// Phase 7 - bundle. Produces a .kolm via src/artifact.js. The auditor mandate
// forces honest provenance: real row hashes, real disjointness gating, and an
// explicit eval_provenance flag. The historical W381 path emitted an identity
// echo recipe + 0.95 pass_rate; we keep that path runnable for tests/demos but
// mark it eval_provenance:'placeholder' so productionReady() returns false.
async function _bundlePhase({
  jobId, namespace, distillResult, plan, tokenizerInfo, datasetId, splitInfo, trainPairs, holdoutPairs, sourceTypeStats, opts,
}) {
  const { buildAndZip } = await import('./artifact.js');
  const outDir = opts.out_dir || path.join(_kolmDir(), 'artifacts');
  fs.mkdirSync(outDir, { recursive: true });

  // Caller-supplied recipes (real rules from src/rule-synth / DSL compile).
  // When none are supplied AND the task type is not explicitly 'echo' the
  // bundle phase still emits the identity shim (so the W367 recipe.bundle.mjs
  // invariant holds) but flags the artifact as non-production. The shim
  // recipe carries an honest name + comment so a human inspecting the .kolm
  // can see why production_ready:false.
  const callerRecipes = Array.isArray(opts.recipes) ? opts.recipes : null;
  const taskType = (plan && plan.task) || (opts && opts.task_type) || 'unknown';
  const allowStub = !!opts.allow_stub;
  const allowSynthetic = !!opts.allow_synthetic;
  const isEchoTask = taskType === 'echo';

  const recipeSource = `function generate(input, lib) {
  // wave409c synthesized identity stub. Marked eval_provenance:'placeholder'
  // so productionReady() refuses to ship this as production_ready:true
  // unless the source task is explicitly task_type:'echo' AND --allow-stub
  // was passed. See src/compile-pipeline.js _bundlePhase for the contract.
  if (typeof input === 'string') return { echoed: input, _wave: 409 };
  return { echoed: JSON.stringify(input), _wave: 409 };
}`;
  const stubRecipe = {
    id: 'rcp_wave409c_stub_' + jobId,
    name: ECHO_RECIPE_NAME,
    schema: { input: {}, output: {} },
    source: recipeSource,
    class: 'rule',
  };
  const recipes = (callerRecipes && callerRecipes.length > 0) ? callerRecipes : [stubRecipe];
  const recipesAreStubOnly = recipes.every(_isEchoRecipe);

  // Determine if THIS build qualifies as a real distill + real eval. A stub
  // is anything where the only recipe shipped is the identity echo AND there
  // is no real eval result attached. The auditor's rule: stub artifacts MUST
  // be production_ready:false unless task is explicitly 'echo' AND
  // --allow-stub is set.
  const hasRealEvalResult = !!(opts.eval_result && typeof opts.eval_result.pass_rate === 'number');
  const stubAcceptable = recipesAreStubOnly && isEchoTask && allowStub;

  // Source-type accounting. The pipeline reads from a captured-events namespace
  // by default (sourceTypeStats.real > 0); a tenant can also supply synthetic
  // seeds via opts. Reject synthetic-only without opts.allow_synthetic so a
  // pipeline that captured nothing real cannot ship a production artifact.
  const sourceCounts = sourceTypeStats || { source_seed_count: 0, approved_count: 0, synthetic_count: 0 };
  const isSyntheticOnly = sourceCounts.source_seed_count > 0
    && sourceCounts.synthetic_count === sourceCounts.source_seed_count
    && !allowSynthetic;

  // Real train / holdout hashing. The wave381 codepath used
  // sha256(datasetId|jobId) which had no relationship to the row content.
  // Post-409c we hash the actual pairs so a verifier can recompute the same
  // values from the on-disk dataset record.
  const tp = Array.isArray(trainPairs) ? trainPairs : [];
  const hp = Array.isArray(holdoutPairs) ? holdoutPairs : [];
  const trainHash = tp.length ? _rowsHash(tp) : null;
  const holdoutHash = hp.length ? _rowsHash(hp) : null;
  const seedsHash = (tp.length || hp.length)
    ? crypto.createHash('sha256').update((trainHash || '') + '|' + (holdoutHash || '')).digest('hex')
    : crypto.createHash('sha256').update(String(datasetId || jobId)).digest('hex');

  // Real row-hash disjointness probe. The dataset_split phase also asserts
  // train_ids ∩ holdout_ids = ∅, but that is identity-based; this one is
  // content-based and catches the cross-namespace replay attack where two
  // distinct event_ids happen to carry the same (prompt, response) pair.
  const overlap = _rowOverlap(tp, hp);

  // Eval provenance. Real eval result → 'real_eval'. Stub injection (the
  // wave381 hard-coded 0.95) → 'placeholder', which the productionReady()
  // gate rejects.
  const evalProvenance = hasRealEvalResult ? 'real_eval' : 'placeholder';
  const passRate = hasRealEvalResult ? Number(opts.eval_result.pass_rate) : 0;

  // Production_ready synthesis - the bundle phase's honest verdict on whether
  // this artifact deserves the production_ready:true stamp on seed_provenance.
  // The full productionReady() gate runs in the verdict phase; this is the
  // first line of defence so a stub artifact's manifest is never even hashed
  // as production-ready in the first place.
  const trainCount = splitInfo ? splitInfo.train_count : tp.length;
  const holdoutCount = splitInfo ? splitInfo.holdout_count : hp.length;
  const splitWasStub = !!(splitInfo && splitInfo.stub);
  let seedProductionReady = true;
  const seedReasons = [];
  if (recipesAreStubOnly && !stubAcceptable) {
    seedProductionReady = false;
    seedReasons.push('echo-only recipe set (task_type=' + taskType + ', allow_stub=' + allowStub + ')');
  }
  if (isSyntheticOnly) {
    seedProductionReady = false;
    seedReasons.push('synthetic-only seeds (pass --allow-synthetic to override)');
  }
  if (!hasRealEvalResult) {
    seedProductionReady = false;
    seedReasons.push('no real eval result (eval_provenance=placeholder)');
  }
  if (overlap.overlap_count > 0) {
    seedProductionReady = false;
    seedReasons.push('train/holdout row-hash overlap=' + overlap.overlap_count);
  }
  if (splitWasStub) {
    seedProductionReady = false;
    seedReasons.push('dataset_split used stub fallback (real workbench rejected the corpus)');
  }
  if (sourceCounts.source_seed_count === 0 && tp.length === 0 && hp.length === 0) {
    seedProductionReady = false;
    seedReasons.push('no seeds available (corpus was empty)');
  }

  // W411 P0 #8 + #10 - honest receipt audit fields. holdout_excluded_count is
  // the number of pairs the distill() boundary refused as holdout_only;
  // row_hash_dedupe_count is the number of duplicate (prompt, response) rows
  // collapsed by createDataset() before split. Both are forwarded into the
  // .kolm bundle so a verifier can confirm the dedupe + holdout chokepoints
  // fired without re-running the pipeline.
  const holdoutExcludedCount = (distillResult && Number.isFinite(distillResult.holdout_excluded_count))
    ? Number(distillResult.holdout_excluded_count)
    : 0;
  const rowHashDedupeCount = (splitInfo && Number.isFinite(splitInfo.row_hash_dedupe_count))
    ? Number(splitInfo.row_hash_dedupe_count)
    : (opts && Number.isFinite(opts.row_hash_dedupe_count) ? Number(opts.row_hash_dedupe_count) : 0);

  const seedProvenance = {
    seeds_hash: seedsHash,
    split_seed: (splitInfo && splitInfo.split_signature) || 'wave409c-pipeline-v1',
    train_hash: trainHash,
    holdout_hash: holdoutHash,
    train_count: trainCount,
    holdout_count: holdoutCount,
    min_train: MIN_PRODUCTION_TRAIN,
    min_holdout: MIN_PRODUCTION_HOLDOUT,
    input_overlap_count: overlap.overlap_count,
    output_overlap_count: 0,
    // Atom 5 - near_duplicate_count now reflects the MinHash LSH near-dup
    // removals from the curate sub-phase (was hard-coded 0). compileFull threads
    // curateInfo.near_dup_removed through opts.near_duplicate_count.
    near_duplicate_count: (opts && Number.isFinite(opts.near_duplicate_count)) ? Number(opts.near_duplicate_count) : 0,
    grouped_overlap_count: 0,
    production_ready: seedProductionReady,
    // Wave 409c new fields.
    source_seed_count: sourceCounts.source_seed_count,
    approved_count: sourceCounts.approved_count,
    synthetic_count: sourceCounts.synthetic_count,
    eval_provenance: evalProvenance,
    eval_source: hasRealEvalResult ? 'tenant_captured' : 'self_generated',
    // W411 P0 #8 + #10 - dedupe + holdout audit.
    holdout_excluded_count: holdoutExcludedCount,
    row_hash_dedupe_count: rowHashDedupeCount,
    // W808-BLOCK - bind the regression-gate verdict into the signed manifest so
    // a verifier can confirm the promotion decision was gated. We carry the
    // verdict + the comparison numbers (not the full run list) so the field is
    // small + tamper-evident. The compile-pipeline verdict/install phases read
    // distillResult.w808_regression_gate directly to BLOCK; this copy is the
    // signed audit record.
    w808_regression_gate: (opts && opts.w808_regression_gate && typeof opts.w808_regression_gate === 'object')
      ? {
          verdict: opts.w808_regression_gate.verdict || null,
          candidate_kscore: (opts.w808_regression_gate.candidate_kscore ?? null),
          prior_kscore: (opts.w808_regression_gate.prior_kscore ?? null),
          kscore_drop: (opts.w808_regression_gate.kscore_drop ?? null),
          critical_fail_rate_increase: (opts.w808_regression_gate.critical_fail_rate_increase ?? null),
          prior_run_id: (opts.w808_regression_gate.prior_run_id ?? null),
          version: opts.w808_regression_gate.version || null,
        }
      : null,
  };

  const extra_files = [];
  if (tokenizerInfo && tokenizerInfo.tokenizer_path && fs.existsSync(tokenizerInfo.tokenizer_path)) {
    extra_files.push({
      filename: 'tokenizer.json',
      content: fs.readFileSync(tokenizerInfo.tokenizer_path),
    });
  }
  if (distillResult && distillResult.student_path && fs.existsSync(distillResult.student_path)) {
    extra_files.push({
      filename: 'student.pointer.json',
      content: Buffer.from(JSON.stringify({
        spec: 'wave409c-student-pointer',
        path: distillResult.student_path,
        backbone: plan.backbone || 'unknown',
      }, null, 2)),
    });
  }
  const result = await buildAndZip({
    job_id: jobId,
    task: { id: 'wave409c_pipeline', kind: taskType, type: taskType },
    base_model: plan.backbone || 'qwen-0.5b',
    recipes,
    training_stats: {
      // Wave 409c - was hard-coded to 0.95. Now 0 unless a real eval ran.
      pass_rate_positive: passRate,
      latency_p50_us: 200,
      cost_usd_per_call: 0,
    },
    evals: opts.eval_result && Array.isArray(opts.eval_result.cases)
      ? { cases: opts.eval_result.cases, coverage: opts.eval_result.coverage || 0 }
      : { cases: [], coverage: 0 },
    outDir,
    seed_provenance: seedProvenance,
    extra_files,
    artifact_class: 'rule',
    // Wave 409c - a placeholder eval produces a sub-gate K-score by
    // construction (pass_rate=0). We DO still want the artifact to materialize
    // so the user / verifier can inspect the honest non-production verdict;
    // the productionReady() gate is the load-bearing reject path (k_score and
    // seed_provenance both fail), not the buildPayload throw. The manifest
    // records ship_gate_overridden=true so a downstream consumer can see the
    // override was applied at build time.
    allow_below_gate: !hasRealEvalResult ? true : !!opts.allow_below_gate,
  });
  // Annotate the in-memory result so compileFull's caller can log the honest
  // reasons even before the productionReady() verdict runs.
  return {
    ...result,
    _wave409c: {
      seed_production_ready: seedProductionReady,
      seed_reasons: seedReasons,
      recipes_are_stub_only: recipesAreStubOnly,
      stub_acceptable: stubAcceptable,
      eval_provenance: evalProvenance,
      row_overlap_count: overlap.overlap_count,
      source_counts: sourceCounts,
      // W411 P0 #8 + #10 - surface to compileFull's yield/log path.
      holdout_excluded_count: holdoutExcludedCount,
      row_hash_dedupe_count: rowHashDedupeCount,
    },
  };
}

// Optional quantize phase - calls into the workers/quantize/quantize.mjs
// worker via spawnSync. Skipped when opts.quantize is falsy. Honest exit:
// emits {phase:'quantize', precision, skipped:true} when the worker doctor
// reports the python stack is missing.
async function _quantizePhase({ jobId, distillResult, opts }) {
  if (!opts.quantize) {
    return { skipped: true, reason: 'quantize disabled' };
  }
  const precision = opts.quantize === true ? 'int4' : String(opts.quantize);
  const workerCmd = process.env.KOLM_QUANTIZE_WORKER_CMD
    || path.join(ROOT, 'workers', 'quantize', 'quantize.mjs');
  if (!fs.existsSync(workerCmd)) {
    return { skipped: true, reason: 'worker not present', precision };
  }
  if (!distillResult || !distillResult.student_path || !fs.existsSync(distillResult.student_path)) {
    return { skipped: true, reason: 'no student weights to quantize', precision };
  }
  const { spawnSync } = await import('node:child_process');
  const outDir = path.join(_jobsDir(), jobId, 'quantize');
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync(process.execPath, [
    workerCmd,
    `--method=${precision}`,
    `--in=${distillResult.student_path}`,
    `--out=${outDir}`,
    '--json',
  ], { encoding: 'utf8', timeout: 60_000 });
  return {
    precision,
    exit_code: r.status,
    out_dir: outDir,
    ml_pipeline_run: r.status === 0,
  };
}

// Optional sign phase - when opts.no_sign is set this is a no-op. The
// artifact.js build path already signs (HMAC chain) unconditionally; this
// phase emits a REAL Ed25519 sidecar so an offline verifier can check the
// .kolm bytes against an embedded public key with no shared secret.
//
// Atom 3 (CA-03) - the historical sidecar was non-functional: it called
// ed.sign(bytes, signingKey) (reversed args; the real signature is
// ed.sign(privateKeyPem, bytes)) with an HMAC secret (KOLM_SIGNING_KEY)
// where an Ed25519 PEM private key is required. That can never produce a
// verifiable signature, so ed25519_attached:true was unreachable for any
// correct invocation. We now resolve a real signer via
// loadOrCreateDefaultSigner() (honors KOLM_ED25519_PRIVATE_KEY / _PATH /
// per-machine cache; returns null when KOLM_ED25519_DISABLE=1), sign the
// artifact bytes with the PEM private key, write a structured sidecar an
// offline verifier can check, and only set ed25519_attached:true after a
// successful verify-roundtrip. The HMAC receipt chain is already baked into
// the .kolm by buildAndZip; we no longer touch KOLM_SIGNING_KEY here.
async function _signPhase({ jobId, artifactResult, opts }) {
  if (opts.no_sign) {
    return { skipped: true, reason: 'no_sign opt' };
  }
  // The HMAC receipt chain is baked into the .kolm by buildAndZip. We
  // surface its signature hash here so the watcher gets a confirmable value.
  const sigHash = artifactResult && artifactResult.receipt
    ? crypto.createHash('sha256').update(JSON.stringify(artifactResult.receipt)).digest('hex').slice(0, 32)
    : null;
  const out = {
    signature_hash: sigHash,
    artifact_hash: artifactResult ? artifactResult.artifact_hash : null,
    ed25519_attached: false,
  };
  if (!artifactResult || !artifactResult.outPath || !fs.existsSync(artifactResult.outPath)) {
    out.ed25519_error = 'no artifact on disk to sign';
    return out;
  }
  try {
    const ed = await import('./ed25519.js');
    // loadOrCreateDefaultSigner returns null only when KOLM_ED25519_DISABLE=1
    // (operator opted out of asymmetric signing - legacy HMAC-only). Any other
    // path (env key / env path / per-machine cache / freshly generated) yields
    // a real Ed25519 PEM keypair.
    const signer = ed.loadOrCreateDefaultSigner();
    if (!signer || !signer.privateKey) {
      out.ed25519_skipped = 'ed25519 signing disabled (KOLM_ED25519_DISABLE=1); shipping HMAC-only';
      return out;
    }
    const bytes = fs.readFileSync(artifactResult.outPath);
    // ed.sign(privateKeyPem, data) - PEM FIRST. The previous code reversed
    // these and passed an HMAC secret where a PEM is required.
    const signature = ed.sign(signer.privateKey, bytes);
    const signed_at = new Date().toISOString();
    const sidecar = {
      spec: ed.ED25519_SPEC,
      alg: ed.ED25519_ALG,
      public_key: signer.publicKey,
      key_fingerprint: signer.key_fingerprint,
      signature,
      signed_at,
      artifact_hash: artifactResult.artifact_hash || null,
    };
    // Verify-roundtrip BEFORE claiming attachment: an offline verifier checks
    // ed.verify(public_key, bytes, signature); we run the exact same check here
    // so ed25519_attached:true is never set on a signature that would not
    // verify against the embedded public key.
    const roundtrips = ed.verify(signer.publicKey, bytes, signature);
    if (!roundtrips) {
      out.ed25519_error = 'sign/verify roundtrip failed; sidecar not written';
      return out;
    }
    const sidecarPath = artifactResult.outPath + '.ed25519.sig';
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
    out.ed25519_attached = true;
    out.ed25519_sidecar_path = sidecarPath;
    out.ed25519_key_fingerprint = signer.key_fingerprint;
    out.ed25519_source = signer.source || null;
  } catch (e) {
    out.ed25519_error = String((e && e.message) || e);
  }
  return out;
}

// W808-BLOCK - interpret the regression-gate envelope distill() attached to
// its `done` event and decide whether promotion must HALT. This is the single
// chokepoint compileFull uses to turn the (previously advisory) W808 verdict
// into a BLOCKING decision per spec G1.
//
// Inputs:
//   gate  - distillResult.w808_regression_gate (may be null/undefined when the
//           distill path did not run the gate, e.g. a pure synth/rule compile).
//   force - opts.force || opts.force_promote. When set, a blocking verdict is
//           downgraded to a logged warning and promotion proceeds.
//
// Returns { blocked:bool, verdict, reason, gate, forced:bool, exit_code }.
// Fail-closed posture:
//   - verdict 'rollback'      -> blocked (a measured regression).
//   - verdict 'needs_human'   -> blocked (no candidate K-Score: cannot prove
//                                 non-regression).
//   - verdict 'promote' / 'first_run' -> not blocked.
//   - gate absent             -> not blocked (the rule/synth lane has its own
//                                 productionReady() K-gate; W808 only applies
//                                 to distill runs that produced a comparable
//                                 candidate K-Score). We surface that as
//                                 verdict 'not_applicable' so the phase event is
//                                 still honest about why nothing was enforced.
function _interpretW808Gate(gate, force) {
  if (!gate || typeof gate !== 'object') {
    return {
      blocked: false,
      verdict: 'not_applicable',
      reason: 'no W808 regression gate on distill result (rule/synth compile or gate not run)',
      gate: null,
      forced: false,
      exit_code: 0,
    };
  }
  const verdict = String(gate.verdict || 'unknown');
  const isBlocking = W808_BLOCKING_VERDICTS.includes(verdict);
  if (!isBlocking) {
    return {
      blocked: false,
      verdict,
      reason: Array.isArray(gate.reasons) && gate.reasons.length
        ? gate.reasons.join('; ')
        : (gate.hint || `W808 verdict '${verdict}' permits promotion`),
      gate,
      forced: false,
      exit_code: 0,
    };
  }
  // Blocking verdict. Build a clear, ASCII-only reason string.
  let reason;
  if (verdict === 'rollback') {
    const detail = Array.isArray(gate.reasons) && gate.reasons.length
      ? gate.reasons.join('; ')
      : `K-Score ${Number(gate.candidate_kscore).toFixed(4)} vs prior ${Number(gate.prior_kscore).toFixed(4)}`;
    reason = `W808 regression gate: rollback - ${detail}`;
  } else {
    reason = `W808 regression gate: needs_human - ${gate.hint || gate.error || 'candidate K-Score unresolvable; cannot prove non-regression'}`;
  }
  if (force) {
    return { blocked: false, verdict, reason, gate, forced: true, exit_code: 0 };
  }
  return { blocked: true, verdict, reason, gate, forced: false, exit_code: PRODUCTION_GATE_FAILED_EXIT };
}

// W808-BLOCK / P1 (atoms 4+5) - run the signed eval gate against the freshly
// built artifact's manifest. This binds a K-Score-delta + new-regression-class
// decision into the promotion path using src/compile-eval-gate.js, the same
// chokepoint the standalone /v1/eval/gate route exposes. Returns the gate
// result ({ promote, reason, eval_summary }) plus a `blocked` boolean that the
// caller turns into a halt unless force is set.
//
// baselineManifest may be null (first compile in this namespace) - the eval
// gate then falls back to its absolute-floor logic. We deliberately do NOT
// re-implement baseline resolution here; the distill-side W808 gate already
// located the prior run by (tenant, namespace). When a caller wants the eval
// gate to compare against an explicit incumbent it passes opts.baseline.
async function _runEvalGate({ manifest, baseline, thresholds, force }) {
  let gate;
  try {
    const { evaluateAndGate } = await import('./compile-eval-gate.js');
    gate = evaluateAndGate({
      candidate_artifact: manifest || {},
      baseline: baseline || null,
      thresholds: thresholds || undefined,
    });
  } catch (e) {
    // Fail-closed: if the gate itself throws we treat promotion as blocked
    // (unless forced) rather than silently shipping.
    return {
      promote: false,
      reason: 'eval_gate_error: ' + String(e && e.message || e),
      eval_summary: null,
      blocked: !force,
      forced: !!force,
      error: true,
    };
  }
  // When no baseline AND no absolute floor is configured, evaluateAndGate
  // promotes by default; that is the correct first-compile behavior. We only
  // BLOCK when the gate itself says block.
  const blocked = gate.promote === false && !force;
  return { ...gate, blocked, forced: !!force && gate.promote === false };
}

// Atom 8 (CA-08) - score a real distilled student on the DISJOINT holdout so
// the distill lane can legitimately clear productionReady() through the
// orchestrator (instead of depending on an out-of-band opts.eval_result that,
// when absent, forced eval_provenance='placeholder' -> production_ready:false).
//
// The RTX-5090 distill worker produces a student model + a run manifest. We
// resolve the student's MEASURED holdout accuracy from the worker manifest /
// run dir (the trainer scores the student against the held-out split it was
// given) and synthesize a real eval_result { pass_rate, cases, coverage:1.0 }
// with eval_provenance='real_eval'. We NEVER fabricate a pass rate: when the
// trainer did not emit a student holdout score, we return null and the lane
// stays placeholder (fail-LOUD via the returned reason), so a non-evaluated
// student can still not reach production_ready.
//
// Returns { eval_result, source, reason } or { eval_result:null, reason }.
async function _distillHoldoutEval({ distillResult, holdoutPairs }) {
  if (!distillResult) {
    return { eval_result: null, reason: 'no distill result (rule/synth lane)' };
  }
  if (!distillResult.student_path) {
    return { eval_result: null, reason: 'no student weights produced (distill worker did not emit a student)' };
  }
  if (!Array.isArray(holdoutPairs) || holdoutPairs.length === 0) {
    return { eval_result: null, reason: 'no holdout pairs to score the student against' };
  }
  // Resolve a MEASURED student holdout accuracy. Order:
  //   1. worker manifest student_holdout_accuracy / holdout_accuracy
  //   2. worker manifest k_score_final (trainer's measured composite)
  //   3. a real eval pass via artifact-runner over the student when a runtime
  //      is available (env-gated; absent runtime -> null, no fabrication).
  const manifest = distillResult.manifest || {};
  let accuracy = null;
  let evalSource = null;
  for (const key of ['student_holdout_accuracy', 'holdout_accuracy', 'k_score_final', 'k_score']) {
    const v = Number(manifest[key]);
    if (Number.isFinite(v) && v >= 0 && v <= 1) { accuracy = v; evalSource = 'worker_manifest:' + key; break; }
  }
  if (accuracy == null) {
    // Try a real run over the student via artifact-runner. evalArtifact needs a
    // packaged .kolm; the raw student is a model file, so this path only fires
    // when the distill worker already packaged a runnable student artifact at
    // student_path (a .kolm). Otherwise it throws and we fall through to null.
    try {
      if (typeof distillResult.student_path === 'string' && /\.kolm$/i.test(distillResult.student_path)
          && fs.existsSync(distillResult.student_path)) {
        const { evalArtifact } = await import('./artifact-runner.js');
        const cases = holdoutPairs.map((p, i) => ({ id: 'holdout_' + i, input: p.prompt, expected: p.response }));
        const ev = await evalArtifact(distillResult.student_path, { cases });
        if (ev && Number.isFinite(ev.accuracy)) {
          accuracy = ev.accuracy;
          evalSource = 'artifact_runner:student_holdout';
        }
      }
    } catch (_) { /* no runtime / unrunnable student -> stays null, no fabrication */ }
  }
  if (accuracy == null) {
    return {
      eval_result: null,
      reason: 'student produced but NOT scored on holdout (trainer emitted no student holdout metric and no runnable student artifact); '
        + 'eval_provenance stays placeholder - run the student eval to reach production_ready',
    };
  }
  // Synthesize a real eval_result. coverage:1.0 because we declared
  // holdoutPairs.length cases and the trainer scored against the full holdout.
  return {
    eval_result: {
      pass_rate: accuracy,
      cases: holdoutPairs.slice(0, 50).map((p, i) => ({ id: 'holdout_' + i, input: p.prompt, expected: p.response })),
      coverage: 1.0,
    },
    source: evalSource,
    reason: 'student scored on disjoint holdout (' + evalSource + ')',
  };
}

// Main pipeline. Yields phase events; the caller drives the iterator.
//
// Wave 409c flags (auditor mandate):
//   opts.allow_stub - accept identity / echo recipes as production_ready.
//                          Default false. Only honored when plan.task is
//                          explicitly 'echo'.
//   opts.allow_synthetic - accept synthetic-only training seeds. Default false:
//                          a corpus that contains zero real captured events is
//                          rejected.
//   opts.eval_result - { pass_rate, cases?, coverage? } from a real eval
//                          run. When absent, eval_provenance is stamped
//                          'placeholder' and productionReady() returns false.
export async function* compileFull({ namespace, opts = {} } = {}) {
  if (!namespace) throw new Error('compileFull requires {namespace}');
  const jobId = opts.job_id || _newJobId();
  // W808-BLOCK - `force` OR `force_promote`/`forcePromote` downgrade a blocking
  // regression-gate verdict to a logged warning. `force_promote` is the
  // explicit, audit-friendly opt-in the CLI surfaces as `--force-promote`;
  // legacy `force` (the gate-override flag that already exists for the
  // production-ready verdict) keeps working so existing callers are unchanged.
  const force = !!opts.force || !!opts.force_promote || !!opts.forcePromote;
  const strict = !!opts.strict;
  const noSign = !!opts.no_sign;
  const noInstall = !!opts.no_install;
  const installTarget = opts.install_target || null;
  const allowStub = !!opts.allow_stub;
  const allowSynthetic = !!opts.allow_synthetic;
  // W411 - tenant fence: the compile pipeline must only ingest rows owned by
  // the calling tenant. Routes (router.js) pass tenant_id from req.tenant_record.id;
  // CLI / local-daemon callers leave it null and get the global view.
  const tenantScope = opts.tenant_id || opts.tenant || null;

  // 1. plan ----------------------------------------------------------------
  // Pull a sample of events from the namespace and run the training planner.
  // W439 - opts.since filters the corpus to events created strictly AFTER the
  // given timestamp. Used by `kolm compile --since-last-compile` to drive
  // incremental retrain over only the new approvals since the previous
  // artifact's created_at. cmdCompile resolves last-compile to the artifact
  // mtime before invoking compileFull.
  const sinceFilter = opts.since != null ? opts.since : null;
  const { pairs: corpusPairs, stats: corpusStats } = await prepareDistillCorpus({ namespace, split: 'all', tenant_id: tenantScope, since: sinceFilter });
  const planRows = corpusPairs.map((p) => ({ input: p.prompt, output: p.response }));
  const plan = await plannerPlan('inline', { rows: planRows });
  _writePhaseLog(jobId, 'plan', { plan_id: plan.plan_id, task: plan.task, backbone: plan.backbone, examples: planRows.length });
  yield {
    phase: 'plan',
    job_id: jobId,
    plan_id: plan.plan_id,
    task: plan.task,
    backbone: plan.backbone,
    examples: planRows.length,
  };

  // 2. tokenizer_train -----------------------------------------------------
  // Train a small BPE tokenizer over the corpus. vocab_size scales with
  // pair count: tiny corpora get a tiny vocab so the worker finishes fast.
  const vocabTarget = Math.min(
    opts.vocab_size || 4000,
    Math.max(300, Math.floor(corpusPairs.length * 4)),
  );
  const tokDir = path.join(_jobsDir(), jobId, 'tokenizer');
  fs.mkdirSync(tokDir, { recursive: true });
  const tokenizerInfo = await trainTokenizer({
    corpus: corpusPairs.map((p) => p.prompt + ' ' + p.response),
    vocab_size: vocabTarget,
    algorithm: opts.tokenizer_algorithm || 'bpe',
    model_prefix: path.join(tokDir, 'tok'),
    seed: 1,
  });
  _writePhaseLog(jobId, 'tokenizer_train', tokenizerInfo);
  yield {
    phase: 'tokenizer_train',
    job_id: jobId,
    tokenizer_path: tokenizerInfo.tokenizer_path,
    vocab_size: tokenizerInfo.vocab_size,
    deterministic_hash: tokenizerInfo.deterministic_hash,
  };

  // 3. corpus_prepare ------------------------------------------------------
  _writePhaseLog(jobId, 'corpus_prepare', corpusStats);
  yield {
    phase: 'corpus_prepare',
    job_id: jobId,
    pair_count: corpusPairs.length,
    stats: corpusStats,
    // W439 - surface incremental-retrain window on the phase event so
    // watchers / logs can confirm the --since filter was applied.
    since: corpusStats && corpusStats.since ? corpusStats.since : null,
    dropped_since: corpusStats && corpusStats.dropped_since ? corpusStats.dropped_since : 0,
  };

  // 3.5. curate (atom 5 / CA-05) - DEFAULT-ON best-in-slot data curation -----
  // Before the train/holdout split, collapse near-duplicates so paraphrase
  // duplicates cannot inflate the corpus or leak across the train/holdout
  // boundary (which would undermine the honest-holdout K-score). The default
  // pipeline historically did exact-match dedupe only (createDataset row-hash);
  // here we add MinHash LSH near-dup removal + semantic dedup + learned quality
  // scoring on corpusPairs BY DEFAULT (opts.curate !== false). The heavy stages
  // (augment / synthesize / active-learning) stay opt-in behind opts.auto.
  //
  // We compute the survivor event_id set and pass it to createDataset via
  // fromEventIds so the workbench split sees only curated rows. We DO NOT drop
  // rows that lack an event_id from the allowlist (the workbench keys on
  // event_id), and we fail OPEN (skip curation) on any error so curation can
  // never break a compile.
  let curateInfo = {
    ran: false,
    near_dup_removed: 0,
    semantic_dup_removed: 0,
    quality_dropped: 0,
    survivor_event_ids: null,
    minhash_signature: null,
  };
  const wantCurate = opts.curate !== false && corpusPairs.length >= 2;
  if (wantCurate) {
    try {
      const { minhashPredup } = await import('./minhash-dedup.js');
      // Stage 1 - MinHash LSH near-dup removal over the (prompt,response) pair.
      const mh = minhashPredup(
        corpusPairs.map((p) => ({ input: p.prompt, output: p.response, _event_id: p.event_id || null })),
        { jaccardThreshold: Number(opts.curate_minhash_threshold) || 0.85, verify: true, key: 'pair' },
      );
      const removedIdx = new Set((mh.removals || []).map((r) => r.removed_idx));
      curateInfo.near_dup_removed = removedIdx.size;
      curateInfo.minhash_signature = (mh.report && mh.report.dedup_signature) || null;
      // Survivors after MinHash near-dup removal.
      let survivors = corpusPairs.filter((_, i) => !removedIdx.has(i));

      // Stage 2 - semantic dedup + learned quality via the curate pipeline,
      // in-memory (pairs array, no file I/O). We disable the mutating stages
      // (pii redaction / cot drop / cluster) and MinHash (already done) so this
      // sub-phase is purely "semantic dedup + quality filter". curatePairs
      // returns the surviving row OBJECTS (same references) so event_ids carry
      // through. Heavy active-learning SELECT only runs when opts.auto is set.
      const { curatePairs } = await import('./data-curate.js');
      const beforeSemantic = survivors.length;
      const curated = await curatePairs({
        tenant: tenantScope || undefined,
        namespace,
        pairs: survivors.map((p) => ({ input: p.prompt, output: p.response, _event_id: p.event_id || null })),
        opts: {
          minhash: false,            // already ran stage 1
          dedup: true,               // semantic near-dup (python; degrades to no-op)
          quality: true,             // learned quality filter (default-on)
          qualityClassifier: true,
          cluster: false,
          semanticCluster: false,
          cot: false,
          pii: false,
          detectErrors: false,
          // augment/synthesize/active-learning SELECT stays opt-in via --auto.
          target_size: opts.auto ? (Number(opts.curate_target_size) || 0) : 0,
        },
      });
      if (curated && curated.ok) {
        const keptEventIds = new Set();
        // curatePairs returns counts in report; re-derive survivor event_ids by
        // reading the curated out (we passed pairs in-memory so it wrote a file
        // too, but we keep the in-memory survivor set authoritative). We re-run
        // the survivor join by event_id from the report counters.
        const semanticDropped = (curated.report && Number.isFinite(curated.report.deduped)) ? curated.report.deduped : 0;
        const qualityDropped = (curated.report && Number.isFinite(curated.report.quality_filtered)) ? curated.report.quality_filtered : 0;
        curateInfo.semantic_dup_removed = Math.max(0, semanticDropped);
        curateInfo.quality_dropped = Math.max(0, qualityDropped);
        // Map curated survivor count back to event_ids: curatePairs preserves
        // input order of survivors, so re-run the same filter chain locally to
        // recover the exact survivor event_id set deterministically. To avoid a
        // second python call we conservatively reconstruct survivors from the
        // n_kept count via the curated out_path when available; otherwise we
        // keep ALL post-MinHash survivors (fail-open: never drop more than we
        // can prove) so the allowlist only ever encodes the MinHash removals
        // plus whatever the curate file recorded.
        try {
          const fsmod = await import('node:fs');
          if (curated.out_path && fsmod.existsSync(curated.out_path)) {
            const txt = fsmod.readFileSync(curated.out_path, 'utf8');
            for (const line of txt.split(/\r?\n/)) {
              const t = line.trim();
              if (!t) continue;
              try {
                const row = JSON.parse(t);
                if (row && row._event_id) keptEventIds.add(row._event_id);
              } catch { /* skip malformed line */ }
            }
          }
        } catch { /* fall through to MinHash-only allowlist */ }
        if (keptEventIds.size > 0) {
          curateInfo.survivor_event_ids = keptEventIds;
        } else {
          // No file-derived survivor ids; fall back to the MinHash survivor set.
          const mhKept = new Set();
          for (const p of survivors) if (p && p.event_id) mhKept.add(p.event_id);
          curateInfo.survivor_event_ids = mhKept.size > 0 ? mhKept : null;
        }
      } else {
        // Semantic/quality stage failed - keep MinHash survivors only.
        const mhKept = new Set();
        for (const p of survivors) if (p && p.event_id) mhKept.add(p.event_id);
        curateInfo.survivor_event_ids = mhKept.size > 0 ? mhKept : null;
      }
      curateInfo.ran = true;
      void beforeSemantic;
      _writePhaseLog(jobId, 'curate', {
        near_dup_removed: curateInfo.near_dup_removed,
        semantic_dup_removed: curateInfo.semantic_dup_removed,
        quality_dropped: curateInfo.quality_dropped,
        survivors: curateInfo.survivor_event_ids ? curateInfo.survivor_event_ids.size : null,
        minhash_signature: curateInfo.minhash_signature,
      });
      yield {
        phase: 'curate',
        job_id: jobId,
        near_dup_removed: curateInfo.near_dup_removed,
        semantic_dup_removed: curateInfo.semantic_dup_removed,
        quality_dropped: curateInfo.quality_dropped,
        survivors: curateInfo.survivor_event_ids ? curateInfo.survivor_event_ids.size : null,
      };
    } catch (e) {
      // Curation is best-effort - never break a compile. Record + continue with
      // the full corpus (exact-match dedupe still applies in createDataset).
      _writePhaseLog(jobId, 'curate', { ran: false, error: String((e && e.message) || e) });
      curateInfo = {
        ran: false, near_dup_removed: 0, semantic_dup_removed: 0, quality_dropped: 0,
        survivor_event_ids: null, minhash_signature: null,
      };
      yield { phase: 'curate', job_id: jobId, ran: false, error: String((e && e.message) || e) };
    }
  }

  // 4. dataset_split -------------------------------------------------------
  // Auditor mandate (W409c): the workbench split is the ONLY approved
  // train/holdout split path. The pre-409c code fell back to a synthetic
  // "all-rows-train, no-holdout" stub when the workbench rejected the corpus,
  // which let a pipeline with zero approved events still emit a .kolm. Now
  // the stub fallback is reachable only with opts.allow_stub OR opts.force
  // (the existing override).
  let trainId = null;
  let holdoutId = null;
  let splitInfo = null;
  let trainPairs = [];
  let holdoutPairs = [];
  try {
    // W409n/W409o - pass approvedOnly through so that pipelines built with
    // --approved-only see exactly the rows that passed human review; the
    // unapproved-row-never-in-split invariant is enforced at dataset creation
    // time so the rest of the pipeline (split, bundle, distill) inherits it.
    const approvedOnly = !!opts.approved_only || !!opts.approvedOnly;
    const splitSeed = opts.split_seed != null ? opts.split_seed : opts.splitSeed;
    // Atom 5 - constrain the workbench split to the curated survivor set so the
    // near-dup / semantic-dup / quality removals actually take effect on the
    // split membership. Intersect with any caller-supplied fromEventIds.
    //
    // STARVATION GUARD: curation must never break a compile. If applying the
    // survivor allowlist would drop the corpus below the production floors
    // (MIN_PRODUCTION_TRAIN + MIN_PRODUCTION_HOLDOUT), we fall back to the
    // high-precision MinHash near-dup survivors only (leakage-safe, minimally
    // lossy), and if that is STILL too small we skip the allowlist entirely so
    // exact-match dedupe (createDataset) governs. The curate phase event still
    // reports the full quality/semantic drop counts for transparency.
    const _splitFloor = MIN_PRODUCTION_TRAIN + MIN_PRODUCTION_HOLDOUT;
    let fromEventIds = Array.isArray(opts.fromEventIds) ? opts.fromEventIds.slice() : null;
    if (curateInfo.ran && curateInfo.survivor_event_ids && curateInfo.survivor_event_ids.size > 0) {
      const survivors = curateInfo.survivor_event_ids;
      const candidate = fromEventIds
        ? fromEventIds.filter((id) => survivors.has(id))
        : [...survivors];
      if (candidate.length >= _splitFloor) {
        fromEventIds = candidate;
      } else {
        // Allowlist would starve the split below the production floors. Skip the
        // lossy allowlist and let exact-match dedupe (createDataset) govern;
        // near-dup leakage is STILL caught fail-closed by the MinHash-band
        // disjointness probe in the split block below, and the curate phase
        // event already reported the full drop counts for transparency.
        _writePhaseLog(jobId, 'curate', {
          allowlist_skipped: 'would_starve_split',
          survivors: candidate.length,
          floor: _splitFloor,
        });
      }
    }
    const ds = await createDataset(namespace, {
      train_ratio: 0.8,
      approvedOnly,
      seed: splitSeed,
      tenant_id: tenantScope,
      min_train: MIN_PRODUCTION_TRAIN,
      min_holdout: MIN_PRODUCTION_HOLDOUT,
      ...(fromEventIds ? { fromEventIds } : {}),
    });
    trainId = ds.dataset_id;
    splitInfo = await splitDataset(trainId, 0.8, {
      seed: splitSeed,
      min_train: MIN_PRODUCTION_TRAIN,
      min_holdout: MIN_PRODUCTION_HOLDOUT,
    });
    // W411 P0 #10 - propagate row-hash dedupe count from createDataset into
    // the splitInfo envelope so the bundle phase can fold it into the
    // seed_provenance receipt.
    if (ds && Number.isFinite(ds.row_hash_dedupe_count)) {
      splitInfo.row_hash_dedupe_count = ds.row_hash_dedupe_count;
    }
    holdoutId = trainId + ':holdout';
    // Resolve pair content for the train/holdout row sets. The workbench
    // returns event_ids; we hydrate them back to (prompt, response) pairs from
    // the corpus we already prepared so the bundle phase can hash row content.
    const idToPair = new Map();
    for (const p of corpusPairs) {
      if (p && p.event_id) idToPair.set(p.event_id, p);
    }
    trainPairs = splitInfo.train_ids.map((id) => idToPair.get(id)).filter(Boolean);
    holdoutPairs = splitInfo.holdout_ids.map((id) => idToPair.get(id)).filter(Boolean);
    _writePhaseLog(jobId, 'dataset_split', { train_id: trainId, holdout_id: holdoutId, ...splitInfo });
    yield {
      phase: 'dataset_split',
      job_id: jobId,
      train_id: trainId,
      holdout_id: holdoutId,
      train_count: splitInfo.train_count,
      holdout_count: splitInfo.holdout_count,
      split_signature: splitInfo.split_signature,
    };
    // W369 disjointness gate - splitDataset already asserts; we re-check
    // for the strict-mode test path (#18).
    const trainSet = new Set(splitInfo.train_ids);
    for (const h of splitInfo.holdout_ids) {
      if (trainSet.has(h)) {
        const reason = `dataset_split: train/holdout disjointness violated on ${h}`;
        _writePhaseLog(jobId, 'dataset_split', { error: reason });
        if (!force) {
          throw new Error(reason);
        }
      }
    }
    // Wave 409c - content-based disjointness (row-hash intersection). The
    // identity-based check above guards against the same event_id ending up
    // in both buckets, but two distinct event_ids carrying the same
    // (prompt, response) pair would still pass that probe. Verifier checks
    // this same intersection in the bundle phase.
    {
      const trainHashes = new Set(trainPairs.map((p) => _rowHash(p)));
      let rowOverlap = 0;
      for (const h of holdoutPairs) {
        if (trainHashes.has(_rowHash(h))) rowOverlap += 1;
      }
      if (rowOverlap > 0) {
        const reason = `dataset_split: row-hash overlap=${rowOverlap} (content-based train/holdout leakage)`;
        _writePhaseLog(jobId, 'dataset_split', { error: reason });
        if (!force) {
          throw new Error(reason);
        }
      }
    }
    // Atom 5 - MinHash-band overlap probe. sha256 row-hash only catches EXACT
    // (prompt,response) duplicates split across train/holdout; a paraphrase
    // duplicate (same meaning, edited wording) slips past it and leaks the
    // holdout. Run the train+holdout pairs through MinHash LSH and FAIL CLOSED
    // if any train pair lands in the same near-dup cluster as a holdout pair.
    if (trainPairs.length && holdoutPairs.length) {
      try {
        const { minhashPredup } = await import('./minhash-dedup.js');
        const tagged = [
          ...trainPairs.map((p) => ({ input: p.prompt, output: p.response, __side: 'train' })),
          ...holdoutPairs.map((p) => ({ input: p.prompt, output: p.response, __side: 'holdout' })),
        ];
        const mh = minhashPredup(tagged, {
          jaccardThreshold: Number(opts.curate_minhash_threshold) || 0.85,
          verify: true,
          key: 'pair',
        });
        let bandLeak = 0;
        for (const cluster of (mh.clusters || [])) {
          const sides = new Set(cluster.map((i) => tagged[i] && tagged[i].__side));
          if (sides.has('train') && sides.has('holdout')) bandLeak += 1;
        }
        if (bandLeak > 0) {
          const reason = `dataset_split: MinHash-band overlap=${bandLeak} near-dup cluster(s) spanning train+holdout (paraphrase leakage)`;
          _writePhaseLog(jobId, 'dataset_split', { error: reason, minhash_band_leak: bandLeak });
          if (!force) {
            throw new Error(reason);
          }
        } else {
          _writePhaseLog(jobId, 'dataset_split', { minhash_band_leak: 0, minhash_disjoint: true });
        }
      } catch (e) {
        // A throw from the leak check above must propagate; a failure to LOAD
        // the dedup module must not (fail-open on infra error, fail-closed on
        // detected leakage).
        if (/MinHash-band overlap=/.test(String(e && e.message))) throw e;
        _writePhaseLog(jobId, 'dataset_split', { minhash_probe_skipped: String((e && e.message) || e) });
      }
    }
  } catch (e) {
    // Wave 409c - gated stub fallback. Previously this branch fired silently
    // whenever the workbench rejected the corpus, which meant an empty
    // namespace still produced a .kolm. Now the fallback requires explicit
    // allow_stub or force; without either we re-throw so the pipeline fails
    // closed.
    const stubAllowed = allowStub || force;
    if (!stubAllowed) {
      _writePhaseLog(jobId, 'dataset_split', { error: String(e.message || e), stub_blocked: true });
      throw new Error('dataset_split: workbench rejected corpus and stub fallback requires --allow-stub or --force (' + String(e.message || e) + ')');
    }
    _writePhaseLog(jobId, 'dataset_split', { error: String(e.message || e), stub: true });
    splitInfo = {
      train_count: corpusPairs.length,
      holdout_count: 0,
      train_ids: corpusPairs.map((p) => p.event_id || ''),
      holdout_ids: [],
      split_signature: 'sha256:wave409c-stub',
      stub: true,
    };
    trainPairs = corpusPairs.slice();
    holdoutPairs = [];
    yield {
      phase: 'dataset_split',
      job_id: jobId,
      train_id: trainId || 'wave409c-stub',
      holdout_id: holdoutId || 'wave409c-stub:holdout',
      train_count: splitInfo.train_count,
      holdout_count: splitInfo.holdout_count,
      split_signature: splitInfo.split_signature,
      stub: true,
    };
  }

  // 5. distill (events repeated) ------------------------------------------
  const studentBase = opts.student_base || selectStudentBackbone({
    task_type: plan.task,
    hw_tier: opts.hw_tier,
  });
  // W411 P0 #1 - distillation MUST see trainPairs only, never the full
  // corpus. Previously this passed `corpusPairs` (the entire namespace,
  // including holdout rows), so the artifact was trained on its own eval
  // set and the K-score "honest holdout" claim was a lie. trainPairs is
  // hydrated from splitInfo.train_ids at line 533, so distillation now
  // sees exactly the train half of the workbench split. Fallback to
  // corpusPairs only when stubAllowed branch hydrated trainPairs from the
  // full corpus (W409c stub path).
  if (!(trainPairs && trainPairs.length)) {
    if (!allowStub) {
      throw new Error('distill: trainPairs empty and allowStub is false — refusing to distill on full corpus (W411 train/holdout boundary)');
    }
    trainPairs = corpusPairs.slice();
  }
  // Atom 6 (CA-06) - apply the W717 easy->hard curriculum ordering to the train
  // pairs BEFORE they reach the distill worker. Previously distillPairs reached
  // the trainer in workbench order, so the measured training-efficiency win from
  // curriculum learning (Bengio et al, 2009) was dead in production despite the
  // module shipping. We reorder by ascending complexity_proxy (length + Shannon
  // perplexity vs a per-corpus unigram table), thread each row's complexity
  // through to the worker (SequentialSampler honors it), and stamp
  // curriculum_applied on the distill phase event. Default ON; opt out via
  // opts.curriculum===false. Curriculum NEVER drops a row and NEVER crosses the
  // train/holdout boundary - it only permutes trainPairs.
  // W411 P0 #1 / W416 #1 - the distill input is train-only. The empty-train
  // fallback to the corpus was handled above (throw unless allowStub, which
  // mirrors corpusPairs into trainPairs); by here trainPairs IS the train set,
  // so distillPairs is assigned trainPairs and corpusPairs never reaches
  // distillation across the train/holdout boundary.
  const distillPairs = trainPairs;
  // The order the rows are FED to the worker. Defaults to the train-only set;
  // the curriculum reordering below permutes this view ONLY (never crosses the
  // train/holdout boundary, never adds a row from outside distillPairs).
  let distillFeed = distillPairs;
  let curriculumApplied = false;
  let curriculumMode = null;
  if (opts.curriculum !== false && trainPairs.length >= 2) {
    try {
      const { sortCapturesByCurriculum, complexityProxy, buildUnigramTable } = await import('./curriculum-sort.js');
      curriculumMode = (opts.curriculum_mode === 'descending') ? 'descending' : 'ascending';
      // Sort against capture-shaped views so the per-corpus unigram table is
      // built once over the whole train set, then map back to the ORIGINAL pair
      // objects in that order (preserving event_id, source_type, holdout flags).
      const views = distillPairs.map((p, i) => ({ prompt: p.prompt, response: p.response, __idx: i }));
      const ordered = sortCapturesByCurriculum(views, curriculumMode);
      // Build the per-corpus complexity table ONCE so we can stamp each row's
      // complexity_proxy for the worker's SequentialSampler.
      const { table, total } = buildUnigramTable(views);
      distillFeed = ordered.map((v) => {
        const orig = distillPairs[v.__idx];
        const cmp = complexityProxy(v, { unigramTable: table, totalTokens: total });
        // Shallow-clone so we attach complexity_proxy without mutating the
        // shared corpus pair object (it is also referenced by holdout hashing).
        return { ...orig, complexity_proxy: cmp.score };
      });
      curriculumApplied = true;
      _writePhaseLog(jobId, 'curriculum', {
        applied: true,
        mode: curriculumMode,
        n: distillFeed.length,
        first_complexity: distillFeed.length ? distillFeed[0].complexity_proxy : null,
        last_complexity: distillFeed.length ? distillFeed[distillFeed.length - 1].complexity_proxy : null,
      });
    } catch (e) {
      // Curriculum ordering is an efficiency optimization, never load-bearing
      // for correctness; degrade to workbench order on any failure (recorded).
      _writePhaseLog(jobId, 'curriculum', { applied: false, error: String((e && e.message) || e) });
      distillFeed = distillPairs;
      curriculumApplied = false;
    }
  }
  const distillIter = distill({
    teacher_namespace: namespace,
    student_base: studentBase,
    dataset_id: trainId,
    k_target: opts.k_target || 0.85,
    max_steps: opts.max_steps || 200,
    tokenizer_path: tokenizerInfo.tokenizer_path,
    pipeline_mode: opts.distill_mode || 'kd_softmax',
    pairs_override: distillFeed,
    // Atom 6 - signal the worker to honor the curriculum order (SequentialSampler
    // instead of a shuffler) and to read each row's complexity_proxy.
    curriculum: curriculumApplied ? { applied: true, mode: curriculumMode } : undefined,
    emit_progress_every: opts.emit_progress_every == null ? 100 : opts.emit_progress_every,
  });
  let distillResult = null;
  let distillProgressYielded = 0;
  for await (const ev of distillIter) {
    if (ev.done) {
      distillResult = ev;
      _writePhaseLog(jobId, 'distill', { done: true, ...ev });
      continue;
    }
    _writePhaseLog(jobId, 'distill', ev);
    distillProgressYielded += 1;
    yield {
      phase: 'distill',
      job_id: jobId,
      step: ev.step,
      loss: ev.loss,
      k_score: ev.k_score,
      ts: ev.ts,
      curriculum_applied: curriculumApplied,
    };
  }
  // Even when emit_progress_every=0 (silent mode), surface a single
  // canonical distill phase event so the watcher can confirm the phase ran
  // and so PIPELINE_PHASES holds end-to-end (test #9 invariant).
  if (distillProgressYielded === 0) {
    const summary = distillResult
      ? { worker_mode: distillResult.worker_mode, pair_count: distillResult.pair_count }
      : { worker_mode: 'unknown', pair_count: 0 };
    _writePhaseLog(jobId, 'distill', { phase_summary: true, ...summary });
    yield {
      phase: 'distill',
      job_id: jobId,
      step: 0,
      loss: 0,
      k_score: 0,
      ts: new Date().toISOString(),
      summary: true,
      worker_mode: summary.worker_mode,
      pair_count: summary.pair_count,
      curriculum_applied: curriculumApplied,
    };
  }

  // W808-BLOCK - the distill() done event carries the regression-gate verdict
  // (distill-pipeline.js _w808RegressionGate). Capture it here so the bundle
  // phase can bind it into the signed manifest and the verdict/install phases
  // can BLOCK promotion on a 'rollback' / 'needs_human' verdict. distillResult
  // is null only on the synth/rule lane that never ran distill(); in that case
  // the W808 gate is not applicable and the productionReady() K-gate governs.
  const w808Gate = (distillResult && distillResult.w808_regression_gate) || null;

  // Atom 8 (CA-08) - score the distilled student on the disjoint holdout so the
  // distill lane can clear productionReady() through the orchestrator. Only
  // fires when a real student exists (distillResult.student_path) AND a holdout
  // is present; never fabricates a pass rate. The result is bound into
  // bundleOpts.eval_result (when the caller did not already supply one and the
  // rule-class synth lane did not run), giving the W808 / eval gate (CA-01) a
  // real candidate K-score to compare.
  let distillEval = { eval_result: null, reason: 'not_run' };
  if (distillResult && distillResult.student_path && holdoutPairs.length > 0) {
    distillEval = await _distillHoldoutEval({ distillResult, holdoutPairs });
    _writePhaseLog(jobId, 'distill_eval', {
      scored: !!distillEval.eval_result,
      source: distillEval.source || null,
      pass_rate: distillEval.eval_result ? distillEval.eval_result.pass_rate : null,
      reason: distillEval.reason,
    });
    yield {
      phase: 'distill_eval',
      job_id: jobId,
      scored: !!distillEval.eval_result,
      pass_rate: distillEval.eval_result ? distillEval.eval_result.pass_rate : null,
      eval_provenance: distillEval.eval_result ? 'real_eval' : 'placeholder',
      reason: distillEval.reason,
    };
  }

  // 6. quantize ------------------------------------------------------------
  const quantizeInfo = await _quantizePhase({ jobId, distillResult, opts });
  _writePhaseLog(jobId, 'quantize', quantizeInfo);
  yield {
    phase: 'quantize',
    job_id: jobId,
    precision: quantizeInfo.precision || null,
    skipped: !!quantizeInfo.skipped,
    ml_pipeline_run: !!quantizeInfo.ml_pipeline_run,
  };

  // 6.5. recipe_synthesis (W438) - opt-in via opts.synthesize_recipe. Builds a
  // real JS classifier/regex recipe from trainPairs via src/synthesis.js
  // (pattern strategy, CPU-only, no GPU/teacher needed) and scores it against
  // holdoutPairs via src/verifier.js. Produces real eval_result so the
  // resulting artifact passes productionReady() without allow_stub. This is
  // the rule-class real-compile lane the W437 audit asked for.
  //
  // Distill-class real compile (rented teacher inference, GPU/cloud) uses the
  // existing _resolveWorkerMode() path: KOLM_DISTILL_TEACHER or
  // ANTHROPIC_API_KEY wired ⇒ worker_mode='collect'/'full'. That path is
  // exercised by tests/wave438-rented-distill.test.js (env-gated).
  let synthesizedRecipes = null;
  let synthEvalResult = null;
  // W451 - synth path defaults ON when no teacher API is wired AND the caller
  // didn't pass explicit recipes. Without this default, a tenant with real
  // captures who runs `kolm pipeline make --namespace foo` (no --allow-stub,
  // no teacher env-var) gets a hard error from the bundle phase ("stub-only
  // recipes require --allow-stub"). Auto-enabling the rule-class synth path
  // means the same invocation produces a real .kolm artifact whose K-score
  // verdict reflects the honest holdout pass rate. Callers who want to skip
  // synth (running collect/full distill against a teacher) can pass
  // opts.synthesize_recipe:false explicitly.
  const teacherWired = !!(process.env.KOLM_DISTILL_TEACHER
    || process.env.ANTHROPIC_API_KEY
    || process.env.OPENAI_API_KEY);
  const synthDefault = !teacherWired && !opts.recipes;
  const synthOpt = opts.synthesize_recipe === undefined ? synthDefault : !!opts.synthesize_recipe;
  const wantSynth = synthOpt
    && !opts.recipes
    && trainPairs.length >= 2
    && holdoutPairs.length >= 1;
  if (wantSynth) {
    try {
      const { synthesize } = await import('./synthesis.js');
      const { compileJs, verify } = await import('./verifier.js');
      const positives = trainPairs.map((p) => ({ input: p.prompt, expected: p.response }));
      const outputSpec = opts.output_spec || { type: 'enum' };
      const synth = await synthesize({ positives, negatives: [], output_spec: outputSpec, priors: {} });
      const source = synth.accepted ? synth.source : (synth.best_source || null);
      if (source) {
        const compiled = compileJs(source);
        const holdoutCases = holdoutPairs.map((p) => ({ input: p.prompt, expected: p.response }));
        const holdoutVerify = verify(compiled, { positives: holdoutCases });
        synthesizedRecipes = [{
          id: 'rcp_wave438_synth_' + jobId,
          name: 'wave438 synthesized rule',
          schema: { input: {}, output: {} },
          source,
          class: 'rule',
        }];
        synthEvalResult = {
          pass_rate: holdoutVerify.pass_rate_positive,
          cases: holdoutVerify.trace.slice(0, 50),
          // K-score V (eval coverage) is "cases covered / cases declared",
          // NOT "holdout fraction of corpus". We declared holdoutCases.length
          // eval cases and verified all of them, so V = 1.0. The previous
          // formula (holdoutCases / total_corpus) penalized real-eval coverage
          // for being a proper train/holdout split - exactly backwards.
          coverage: holdoutCases.length > 0 ? 1.0 : 0,
        };
        _writePhaseLog(jobId, 'recipe_synthesis', {
          accepted: !!synth.accepted,
          source_bytes: Buffer.byteLength(source, 'utf8'),
          holdout_pass_rate: holdoutVerify.pass_rate_positive,
          holdout_n: holdoutCases.length,
        });
        yield {
          phase: 'recipe_synthesis',
          job_id: jobId,
          accepted: !!synth.accepted,
          source_bytes: Buffer.byteLength(source, 'utf8'),
          holdout_pass_rate: holdoutVerify.pass_rate_positive,
          holdout_n: holdoutCases.length,
        };
      } else {
        _writePhaseLog(jobId, 'recipe_synthesis', { error: 'no candidate compiled', reason: synth.reason || null });
      }
    } catch (e) {
      _writePhaseLog(jobId, 'recipe_synthesis', { error: String(e.message || e) });
    }
  }

  // 7. bundle --------------------------------------------------------------
  // Wave 409c - compute honest source-type stats from corpusPairs metadata.
  // Pairs that came from the event store carry an event_id; explicit
  // synthetic pairs (passed in via opts.synthetic_pairs) are counted
  // separately. The approved_count comes from the approvals.jsonl file (if
  // present); we re-read it directly so the audit field is content-derived,
  // not pipeline-asserted.
  const sourceSeedCount = corpusPairs.length;
  const syntheticCount = corpusPairs.filter((p) => p && p.source_type === 'synthetic').length;
  let approvedCount = 0;
  try {
    const approvalsPath = path.join(_kolmDir(), 'labels', 'approvals.jsonl');
    if (fs.existsSync(approvalsPath)) {
      const txt = fs.readFileSync(approvalsPath, 'utf8');
      for (const line of txt.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e && e.decision === 'approve') approvedCount += 1;
        } catch {} // deliberate: cleanup
      }
    }
  } catch {} // deliberate: cleanup
  const sourceTypeStats = {
    source_seed_count: sourceSeedCount,
    approved_count: approvedCount,
    synthetic_count: syntheticCount,
  };
  // Pre-bundle gate: synthetic-only seeds without explicit allow_synthetic.
  if (sourceSeedCount > 0 && syntheticCount === sourceSeedCount && !allowSynthetic && !force) {
    throw new Error('compileFull: synthetic-only seeds (' + syntheticCount + '/' + sourceSeedCount + '); pass opts.allow_synthetic or opts.force to override');
  }
  // W438 - fold synthesized recipe + eval_result into bundle opts so the
  // existing _bundlePhase contract (opts.recipes, opts.eval_result) picks
  // them up. Caller-supplied opts.recipes / opts.eval_result still win.
  // allow_below_gate defaults to true on the synth path because the
  // pattern-strategy synthClassifier is bursty on small holdouts (n<20) and
  // we want the artifact to materialize so productionReady() can record the
  // honest low-K verdict - the verdict gate is the load-bearing reject path,
  // not the buildPayload throw. Caller can still pass allow_below_gate:false
  // to force the throw (release pipelines).
  // Atom 8 - bind the distill-lane holdout eval_result so the distill lane can
  // legitimately clear productionReady(). Caller-supplied opts.eval_result still
  // wins; the synth lane's synthEvalResult is the rule-class path. For the
  // distill case allow_below_gate is NOT forced true (a real student must clear
  // the gate on its measured holdout score) - only the synth small-holdout case
  // keeps allow_below_gate=true.
  const distillEvalResult = (distillEval && distillEval.eval_result) || null;
  const bundleOpts = (synthesizedRecipes || synthEvalResult)
    ? {
        ...opts,
        recipes: opts.recipes || synthesizedRecipes,
        eval_result: opts.eval_result || synthEvalResult,
        allow_below_gate: (opts.allow_below_gate === false) ? false : true,
        // W808-BLOCK - bind the regression-gate verdict into the signed manifest.
        w808_regression_gate: w808Gate,
        // Atom 5 - fold the MinHash near-dup count into seed_provenance so
        // near_duplicate_count reflects real curation, not a hard-coded 0.
        near_duplicate_count: curateInfo.near_dup_removed,
        curate_signature: curateInfo.minhash_signature,
      }
    : {
        ...opts,
        // Atom 8 - distill lane: real measured holdout eval (or caller's).
        eval_result: opts.eval_result || distillEvalResult || undefined,
        w808_regression_gate: w808Gate,
        near_duplicate_count: curateInfo.near_dup_removed,
        curate_signature: curateInfo.minhash_signature,
      };
  const artifactResult = await _bundlePhase({
    jobId, namespace, distillResult, plan, tokenizerInfo, datasetId: trainId, splitInfo, trainPairs, holdoutPairs, sourceTypeStats, opts: bundleOpts,
  });
  _writePhaseLog(jobId, 'bundle', {
    out_path: artifactResult.outPath,
    artifact_hash: artifactResult.artifact_hash,
    wave409c: artifactResult._wave409c || null,
  });
  yield {
    phase: 'bundle',
    job_id: jobId,
    recipe_bundle_path: artifactResult.outPath,
    artifact_hash: artifactResult.artifact_hash,
    cid: artifactResult.cid,
    seed_production_ready: artifactResult._wave409c ? artifactResult._wave409c.seed_production_ready : null,
    seed_reasons: artifactResult._wave409c ? artifactResult._wave409c.seed_reasons : [],
    eval_provenance: artifactResult._wave409c ? artifactResult._wave409c.eval_provenance : 'unknown',
    // W411 P0 #8 + #10 - surface dedupe + holdout chokepoint counters on the
    // bundle phase yield so watchers can see them without re-reading the .kolm.
    holdout_excluded_count: artifactResult._wave409c ? (artifactResult._wave409c.holdout_excluded_count || 0) : 0,
    row_hash_dedupe_count: artifactResult._wave409c ? (artifactResult._wave409c.row_hash_dedupe_count || 0) : 0,
  };

  // 8. sign ----------------------------------------------------------------
  const signInfo = await _signPhase({ jobId, artifactResult, opts: { no_sign: noSign } });
  _writePhaseLog(jobId, 'sign', signInfo);
  yield {
    phase: 'sign',
    job_id: jobId,
    signature_hash: signInfo.signature_hash,
    skipped: !!signInfo.skipped,
    ed25519_attached: !!signInfo.ed25519_attached,
  };

  // 9. verdict -------------------------------------------------------------
  const { productionReady } = await import('./production-ready.js');
  let verdict;
  try {
    verdict = await productionReady(artifactResult.outPath);
  } catch (e) {
    verdict = { ok: false, gates: {}, reasons: ['verdict_error: ' + String(e.message || e)] };
  }
  _writePhaseLog(jobId, 'verdict', verdict);
  yield {
    phase: 'verdict',
    job_id: jobId,
    production_ready: verdict.ok,
    gates: verdict.gates,
    reasons: verdict.reasons,
  };

  // 9.5. regression_gate (atom 2 / CA-01, BLOCKING) ----------------------
  // Bind BOTH the W808 distill-side regression gate AND the signed
  // compile-eval-gate into the promotion path as a real chokepoint. The
  // functions existed (_interpretW808Gate, _runEvalGate) but were never
  // invoked, so a measured regression ('rollback') or an unresolvable
  // candidate K-Score ('needs_human' / eval-gate block) did NOT halt
  // bundle/sign/install - a regressing artifact was signed and installed.
  //
  //   _interpretW808Gate(w808Gate, force) -> blocks on rollback/needs_human.
  //   _runEvalGate({manifest, baseline, thresholds, force}) -> blocks on a
  //       K-Score-delta / new-regression-class failure vs opts.baseline.
  //
  // force (opts.force || opts.force_promote) downgrades a blocking verdict to
  // a logged warning so the operator can still ship an override.
  const evalGate = await _runEvalGate({
    manifest: (artifactResult && artifactResult.manifest) || {},
    baseline: opts.baseline || null,
    thresholds: opts.gate_thresholds,
    force,
  });
  const w808 = _interpretW808Gate(w808Gate, force);
  const gateBlocked = !!(w808.blocked || evalGate.blocked);
  const gateExitCode = gateBlocked ? PRODUCTION_GATE_FAILED_EXIT : 0;
  _writePhaseLog(jobId, 'regression_gate', {
    blocked: gateBlocked,
    w808_verdict: w808.verdict,
    w808_reason: w808.reason,
    eval_gate: evalGate.reason,
    eval_gate_promote: evalGate.promote,
    forced: !!force,
    gate_exit_code: gateExitCode,
  });
  yield {
    phase: 'regression_gate',
    job_id: jobId,
    blocked: gateBlocked,
    w808_verdict: w808.verdict,
    eval_gate: evalGate.reason,
    gate_exit_code: gateExitCode,
    forced: !!force,
  };
  if (gateBlocked && force) {
    _writePhaseLog(jobId, 'regression_gate', {
      warning: 'regression_gate_blocked_overridden_by_force',
      w808_verdict: w808.verdict,
      eval_gate: evalGate.reason,
    });
  }

  // Unified terminal-abort - HALT promotion (skip install, emit a terminal
  // 'done' with production_ready:false) when EITHER the regression gate blocks
  // (atom 2 BLOCKING chokepoint: rollback / needs_human / eval-gate block) OR
  // strict mode is set and the productionReady() verdict failed - and force is
  // not set. A single terminal so we never double-emit 'done'. The strict-mode
  // contract (aborted:true, reason:'strict_gate_failure', skipped install) is
  // preserved; a pure regression-gate block carries blocked:true +
  // reason:'regression_gate_block' + the CI exit code.
  const strictAbort = strict && !verdict.ok;
  const shouldInstall = !noInstall && installTarget && (verdict.ok || force);
  if ((gateBlocked || strictAbort) && !force) {
    const blockReason = w808.blocked ? w808.reason
      : (evalGate.blocked ? evalGate.reason
        : 'strict mode + verdict failed (no --force)');
    _writePhaseLog(jobId, 'install', { skipped: true, reason: blockReason });
    yield {
      phase: 'install',
      job_id: jobId,
      target: installTarget,
      skipped: true,
      reason: gateBlocked ? 'regression_gate blocked promotion' : 'strict mode + verdict failed (no --force)',
    };
    // 11. done (terminal abort) -------------------------------------------
    // strict_gate_failure preserves the legacy strict contract; when ONLY the
    // regression gate fired (verdict passed) we tag regression_gate_block.
    const terminalReason = strictAbort ? 'strict_gate_failure' : 'regression_gate_block';
    const doneEvent = {
      phase: 'done',
      job_id: jobId,
      artifact_path: artifactResult.outPath,
      artifact_hash: artifactResult.artifact_hash,
      production_ready: verdict.ok && !gateBlocked ? verdict.ok : false,
      aborted: strictAbort ? true : undefined,
      blocked: gateBlocked ? true : undefined,
      gate_exit_code: gateBlocked ? PRODUCTION_GATE_FAILED_EXIT : undefined,
      reason: terminalReason,
      block_detail: gateBlocked ? blockReason : undefined,
    };
    _writePhaseLog(jobId, 'done', doneEvent);
    yield doneEvent;
    return;
  }
  if (force && (!verdict.ok || gateBlocked)) {
    _writePhaseLog(jobId, 'verdict', { warning: 'gate_failure_overridden_by_force', reasons: verdict.reasons, regression_gate_blocked: gateBlocked });
  }

  // 10. install ------------------------------------------------------------
  let installResult = { skipped: true };
  if (shouldInstall) {
    try {
      const { installToDevice } = await import('./device-install.js');
      installResult = await installToDevice(artifactResult.outPath, { deviceId: installTarget });
    } catch (e) {
      installResult = { error: String(e.message || e), target: installTarget };
    }
  }
  _writePhaseLog(jobId, 'install', installResult);
  yield {
    phase: 'install',
    job_id: jobId,
    target: installTarget,
    skipped: !!installResult.skipped,
    installed_path: installResult.installed_path || null,
  };

  // 11. done ---------------------------------------------------------------
  _writePhaseLog(jobId, 'done', { artifact_path: artifactResult.outPath, artifact_hash: artifactResult.artifact_hash, production_ready: verdict.ok });
  yield {
    phase: 'done',
    job_id: jobId,
    artifact_path: artifactResult.outPath,
    artifact_hash: artifactResult.artifact_hash,
    production_ready: verdict.ok,
  };
}

export default { compileFull, PIPELINE_PHASES };
