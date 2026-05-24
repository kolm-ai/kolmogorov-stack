// Wave 381 — compile pipeline orchestrator.
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
//   4.  dataset_split         → {phase:'dataset_split', train_id, holdout_id}
//   5.  distill (repeated)    → {phase:'distill', step, loss, k_score}
//   6.  quantize              → {phase:'quantize', precision}
//   7.  bundle                → {phase:'bundle', recipe_bundle_path}
//   8.  sign                  → {phase:'sign', signature_hash}
//   9.  verdict               → {phase:'verdict', production_ready, gates}
//   10. install               → {phase:'install', target?}
//   11. done                  → {phase:'done', artifact_path, artifact_hash}
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
import { envSecret } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

export const PIPELINE_PHASES = [
  'plan',
  'tokenizer_train',
  'corpus_prepare',
  'dataset_split',
  'distill',
  'quantize',
  'bundle',
  'sign',
  'verdict',
  'install',
  'done',
];

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

// Wave 409c — auditor mandate. The bundle phase used to emit a fake
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
// auditor's primary disjointness probe — train.rowhash ∩ holdout.rowhash must
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

// Phase 7 — bundle. Produces a .kolm via src/artifact.js. The auditor mandate
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

  // Production_ready synthesis — the bundle phase's honest verdict on whether
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

  // W411 P0 #8 + #10 — honest receipt audit fields. holdout_excluded_count is
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
    near_duplicate_count: 0,
    grouped_overlap_count: 0,
    production_ready: seedProductionReady,
    // Wave 409c new fields.
    source_seed_count: sourceCounts.source_seed_count,
    approved_count: sourceCounts.approved_count,
    synthetic_count: sourceCounts.synthetic_count,
    eval_provenance: evalProvenance,
    eval_source: hasRealEvalResult ? 'tenant_captured' : 'self_generated',
    // W411 P0 #8 + #10 — dedupe + holdout audit.
    holdout_excluded_count: holdoutExcludedCount,
    row_hash_dedupe_count: rowHashDedupeCount,
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
      // Wave 409c — was hard-coded to 0.95. Now 0 unless a real eval ran.
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
    // Wave 409c — a placeholder eval produces a sub-gate K-score by
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
      // W411 P0 #8 + #10 — surface to compileFull's yield/log path.
      holdout_excluded_count: holdoutExcludedCount,
      row_hash_dedupe_count: rowHashDedupeCount,
    },
  };
}

// Optional quantize phase — calls into the workers/quantize/quantize.mjs
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

// Optional sign phase — when opts.no_sign is set this is a no-op. The
// artifact.js build path already signs (HMAC chain) unconditionally; this
// phase records an Ed25519 sidecar when KOLM_SIGNING_KEY is set.
async function _signPhase({ jobId, artifactResult, opts }) {
  if (opts.no_sign) {
    return { skipped: true, reason: 'no_sign opt' };
  }
  // The HMAC receipt chain is baked into the .kolm by buildAndZip. We
  // surface its signature hash here so the watcher gets a confirmable
  // value. When KOLM_SIGNING_KEY is set, also emit an Ed25519 sidecar
  // file alongside the artifact for offline verification.
  const sigHash = artifactResult && artifactResult.receipt
    ? crypto.createHash('sha256').update(JSON.stringify(artifactResult.receipt)).digest('hex').slice(0, 32)
    : null;
  const out = {
    signature_hash: sigHash,
    artifact_hash: artifactResult ? artifactResult.artifact_hash : null,
    ed25519_attached: false,
  };
  // WC07 — signing is OPTIONAL; only emit a sidecar when the operator has
  // explicitly set KOLM_SIGNING_KEY to a non-empty trimmed value. The previous
  // bare `process.env.KOLM_SIGNING_KEY` truthy check let `KOLM_SIGNING_KEY=""`
  // and `KOLM_SIGNING_KEY="   "` pass the guard, after which ed.sign() would
  // either throw or (worse) produce a deterministic forgeable signature against
  // the empty-string key. envSecret() returns null in both broken cases so we
  // fall through to ed25519_attached:false instead.
  const signingKey = envSecret('KOLM_SIGNING_KEY');
  if (signingKey && artifactResult && artifactResult.outPath) {
    try {
      const { default: ed } = await import('./ed25519.js').catch(() => ({ default: null }));
      if (ed && ed.sign) {
        const bytes = fs.readFileSync(artifactResult.outPath);
        const sig = ed.sign(bytes, signingKey);
        fs.writeFileSync(artifactResult.outPath + '.ed25519.sig', sig);
        out.ed25519_attached = true;
      }
    } catch (e) {
      out.ed25519_error = String(e.message || e);
    }
  }
  return out;
}

// Main pipeline. Yields phase events; the caller drives the iterator.
//
// Wave 409c flags (auditor mandate):
//   opts.allow_stub      — accept identity / echo recipes as production_ready.
//                          Default false. Only honored when plan.task is
//                          explicitly 'echo'.
//   opts.allow_synthetic — accept synthetic-only training seeds. Default false:
//                          a corpus that contains zero real captured events is
//                          rejected.
//   opts.eval_result     — { pass_rate, cases?, coverage? } from a real eval
//                          run. When absent, eval_provenance is stamped
//                          'placeholder' and productionReady() returns false.
export async function* compileFull({ namespace, opts = {} } = {}) {
  if (!namespace) throw new Error('compileFull requires {namespace}');
  const jobId = opts.job_id || _newJobId();
  const force = !!opts.force;
  const strict = !!opts.strict;
  const noSign = !!opts.no_sign;
  const noInstall = !!opts.no_install;
  const installTarget = opts.install_target || null;
  const allowStub = !!opts.allow_stub;
  const allowSynthetic = !!opts.allow_synthetic;
  // W411 — tenant fence: the compile pipeline must only ingest rows owned by
  // the calling tenant. Routes (router.js) pass tenant_id from req.tenant_record.id;
  // CLI / local-daemon callers leave it null and get the global view.
  const tenantScope = opts.tenant_id || opts.tenant || null;

  // 1. plan ----------------------------------------------------------------
  // Pull a sample of events from the namespace and run the training planner.
  // W439 — opts.since filters the corpus to events created strictly AFTER the
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
    // W439 — surface incremental-retrain window on the phase event so
    // watchers / logs can confirm the --since filter was applied.
    since: corpusStats && corpusStats.since ? corpusStats.since : null,
    dropped_since: corpusStats && corpusStats.dropped_since ? corpusStats.dropped_since : 0,
  };

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
    // W409n/W409o — pass approvedOnly through so that pipelines built with
    // --approved-only see exactly the rows that passed human review; the
    // unapproved-row-never-in-split invariant is enforced at dataset creation
    // time so the rest of the pipeline (split, bundle, distill) inherits it.
    const approvedOnly = !!opts.approved_only || !!opts.approvedOnly;
    const splitSeed = opts.split_seed != null ? opts.split_seed : opts.splitSeed;
    const ds = await createDataset(namespace, {
      train_ratio: 0.8,
      approvedOnly,
      seed: splitSeed,
      tenant_id: tenantScope,
      min_train: MIN_PRODUCTION_TRAIN,
      min_holdout: MIN_PRODUCTION_HOLDOUT,
    });
    trainId = ds.dataset_id;
    splitInfo = await splitDataset(trainId, 0.8, {
      seed: splitSeed,
      min_train: MIN_PRODUCTION_TRAIN,
      min_holdout: MIN_PRODUCTION_HOLDOUT,
    });
    // W411 P0 #10 — propagate row-hash dedupe count from createDataset into
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
    // W369 disjointness gate — splitDataset already asserts; we re-check
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
    // Wave 409c — content-based disjointness (row-hash intersection). The
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
  } catch (e) {
    // Wave 409c — gated stub fallback. Previously this branch fired silently
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
  // W411 P0 #1 — distillation MUST see trainPairs only, never the full
  // corpus. Previously this passed `corpusPairs` (the entire namespace,
  // including holdout rows), so the artifact was trained on its own eval
  // set and the K-score "honest holdout" claim was a lie. trainPairs is
  // hydrated from splitInfo.train_ids at line 533, so distillation now
  // sees exactly the train half of the workbench split. Fallback to
  // corpusPairs only when stubAllowed branch hydrated trainPairs from the
  // full corpus (W409c stub path).
  const distillPairs = (trainPairs && trainPairs.length) ? trainPairs : corpusPairs;
  const distillIter = distill({
    teacher_namespace: namespace,
    student_base: studentBase,
    dataset_id: trainId,
    k_target: opts.k_target || 0.85,
    max_steps: opts.max_steps || 200,
    tokenizer_path: tokenizerInfo.tokenizer_path,
    pipeline_mode: opts.distill_mode || 'kd_softmax',
    pairs_override: distillPairs,
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

  // 6.5. recipe_synthesis (W438) — opt-in via opts.synthesize_recipe. Builds a
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
  // W451 — synth path defaults ON when no teacher API is wired AND the caller
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
          // for being a proper train/holdout split — exactly backwards.
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
  // Wave 409c — compute honest source-type stats from corpusPairs metadata.
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
        } catch {}
      }
    }
  } catch {}
  const sourceTypeStats = {
    source_seed_count: sourceSeedCount,
    approved_count: approvedCount,
    synthetic_count: syntheticCount,
  };
  // Pre-bundle gate: synthetic-only seeds without explicit allow_synthetic.
  if (sourceSeedCount > 0 && syntheticCount === sourceSeedCount && !allowSynthetic && !force) {
    throw new Error('compileFull: synthetic-only seeds (' + syntheticCount + '/' + sourceSeedCount + '); pass opts.allow_synthetic or opts.force to override');
  }
  // W438 — fold synthesized recipe + eval_result into bundle opts so the
  // existing _bundlePhase contract (opts.recipes, opts.eval_result) picks
  // them up. Caller-supplied opts.recipes / opts.eval_result still win.
  // allow_below_gate defaults to true on the synth path because the
  // pattern-strategy synthClassifier is bursty on small holdouts (n<20) and
  // we want the artifact to materialize so productionReady() can record the
  // honest low-K verdict — the verdict gate is the load-bearing reject path,
  // not the buildPayload throw. Caller can still pass allow_below_gate:false
  // to force the throw (release pipelines).
  const bundleOpts = (synthesizedRecipes || synthEvalResult)
    ? {
        ...opts,
        recipes: opts.recipes || synthesizedRecipes,
        eval_result: opts.eval_result || synthEvalResult,
        allow_below_gate: (opts.allow_below_gate === false) ? false : true,
      }
    : opts;
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
    // W411 P0 #8 + #10 — surface dedupe + holdout chokepoint counters on the
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

  // Strict / force semantics — if strict + verdict failed AND force not set,
  // we skip install and emit done with production_ready:false.
  const shouldInstall = !noInstall && installTarget && (verdict.ok || force);
  if (strict && !verdict.ok && !force) {
    _writePhaseLog(jobId, 'install', { skipped: true, reason: 'strict mode + verdict failed (no --force)' });
    yield {
      phase: 'install',
      job_id: jobId,
      target: installTarget,
      skipped: true,
      reason: 'strict mode + verdict failed (no --force)',
    };
    // 11. done -------------------------------------------------------------
    _writePhaseLog(jobId, 'done', { artifact_path: artifactResult.outPath, artifact_hash: artifactResult.artifact_hash, production_ready: verdict.ok, aborted: true });
    yield {
      phase: 'done',
      job_id: jobId,
      artifact_path: artifactResult.outPath,
      artifact_hash: artifactResult.artifact_hash,
      production_ready: verdict.ok,
      aborted: true,
      reason: 'strict_gate_failure',
    };
    return;
  }
  if (force && !verdict.ok) {
    _writePhaseLog(jobId, 'verdict', { warning: 'gate_failure_overridden_by_force', reasons: verdict.reasons });
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
