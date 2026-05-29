// src/data-engine.js
//
// KOLM Data Engine — the ORCHESTRATOR (W921).
//
// One real entry point that chains the six existing data-engine stage modules
// in order so `kolm compile --auto` has a single seam to call:
//
//   INGEST → CURATE → AUGMENT → EVALUATE → FEEDBACK
//
// Design rules this module obeys:
//   - Dependency-light: it imports ONLY the existing stage modules below. No new
//     npm deps, no network, no GPU, no python.
//   - Each stage runs in its own try/catch. A stage failure becomes
//     { ok:false, error } in that stage's slot and does NOT abort later
//     independent stages. The result always records which stages ran/skipped
//     and why.
//   - Tenant fences every downstream call (every stage receives `tenant`).
//   - Pure-ish control flow: no wall-clock branching. Anything time/seed-like a
//     stage needs is taken from `opts` and threaded through; this orchestrator
//     itself never reads the clock to decide what to do.
//   - Cost gate on AUGMENT: PREVIEW ONLY by default (writes nothing). The
//     augmentation is only APPLIED when opts.approve_cost_usd is a number that
//     is >= the previewed est_cost_usd. The cost preview is ALWAYS surfaced in
//     the augment stage slot, applied or not.
//
// Envelope contract:
//   orchestratePipeline({ tenant, namespace, opts }) ->
//     { ok:true, version:'data-engine-v1', namespace,
//       stages:{ ingest, curate, augment, evaluate, feedback } }
//   On a fatal pre-flight failure (e.g. no pairs to work with at all) the
//   ingest slot carries { ok:false, error } and later stages are marked skipped
//   with that reason — the top-level envelope still returns ok:true so a caller
//   can inspect every slot uniformly.

import fs from 'node:fs';
import {
  ingestDescribe,
  ingestFile,
  ingestDocs,
  readRawPairs,
  rawPairsPath,
} from './data-ingest.js';
import { curatePairs } from './data-curate.js';
import { augment } from './data-augment.js';
import { evaluateRun } from './data-evaluate.js';
import { identifyProdGaps, proposeRecompile } from './data-feedback.js';
import { summarizeProvenance } from './data-provenance.js';

export const DATA_ENGINE_VERSION = 'data-engine-v1';

// A uniform skipped slot. `reason` explains WHY a stage did not run so the Data
// Health panel (and tests) can show it without guessing.
function _skip(reason) {
  return { skipped: true, reason };
}

// A uniform failure slot for a stage that threw. We never let a stage exception
// escape this module — it lands here so later independent stages keep running.
function _fail(error) {
  return { ok: false, error: String((error && error.message) || error) };
}

// ---------------------------------------------------------------------------
// Stage 1: INGEST
//
// Source precedence (first match wins):
//   opts.describe -> ingestDescribe({namespace, description, n})   (seed prompts)
//   opts.data     -> ingestFile({namespace, file})                 (JSONL pairs)
//   opts.docs     -> ingestDocs({namespace, docs_dir})             (doc chunks)
//   else          -> read whatever raw pairs already live in the namespace.
//
// After any write-side ingest, we ALWAYS re-read the namespace's persisted raw
// pairs via readRawPairs so the rest of the pipeline operates on the canonical
// on-disk corpus (and so a re-run that ingests nothing new still sees the full
// corpus). If there are no pairs at all, the slot is a clear failure and the
// caller learns the pipeline had nothing to work with.
// ---------------------------------------------------------------------------
async function _runIngest({ tenant, namespace, opts }) {
  let source = null;
  let writeResult = null;

  if (opts.describe != null && String(opts.describe).trim()) {
    source = 'describe';
    const n = Number.isFinite(Number(opts.describe_n)) ? Number(opts.describe_n)
      : (Number.isFinite(Number(opts.n)) ? Number(opts.n) : undefined);
    writeResult = await ingestDescribe({
      namespace,
      description: String(opts.describe),
      ...(n != null ? { n } : {}),
    });
  } else if (opts.data != null && String(opts.data).trim()) {
    source = 'file';
    writeResult = await ingestFile({ namespace, file: String(opts.data) });
  } else if (opts.docs != null && String(opts.docs).trim()) {
    source = 'docs';
    writeResult = await ingestDocs({ namespace, docs_dir: String(opts.docs) });
  } else {
    source = 'existing';
  }

  // A write-side ingest that explicitly failed is surfaced — but we still try to
  // read whatever is already on disk so a prior corpus can carry the run.
  const writeError = writeResult && writeResult.ok === false ? writeResult.error : null;

  // Canonical corpus = the persisted raw pairs for the namespace. readRawPairs
  // is sync + never throws (a cold namespace yields []).
  const pairs = readRawPairs(namespace);

  if (!Array.isArray(pairs) || pairs.length === 0) {
    return {
      slot: {
        ok: false,
        error: writeError
          ? `ingest produced no pairs (source=${source}): ${writeError}`
          : `no training pairs available for namespace '${namespace}' (source=${source})`,
        source,
        n_pairs: 0,
        ...(writeResult ? { write: _writeSummary(writeResult) } : {}),
        path: rawPairsPath(namespace),
      },
      pairs: [],
    };
  }

  return {
    slot: {
      ok: true,
      source,
      n_pairs: pairs.length,
      n_written: writeResult && writeResult.ok ? (writeResult.n_written || 0) : 0,
      provenance: summarizeProvenance(pairs),
      ...(writeResult ? { write: _writeSummary(writeResult) } : {}),
      ...(writeError ? { write_error: writeError } : {}),
      path: rawPairsPath(namespace),
    },
    pairs,
  };
}

// Compact view of a write-side ingest envelope (we keep only the fields the
// Data Health panel needs; the raw `rows`/`candidates` arrays are dropped).
function _writeSummary(res) {
  if (!res || typeof res !== 'object') return null;
  return {
    ok: res.ok === true,
    source_type: res.source_type,
    n_written: res.n_written,
    dupes_skipped: res.dupes_skipped,
    ...(res.files_scanned != null ? { files_scanned: res.files_scanned } : {}),
    ...(res.error ? { error: res.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stage 2: CURATE
//
// Runs the curate stage on the ingested pairs (passed by value so we do not
// depend on the curate module's separate on-disk read path). opts.curate, when
// present, is forwarded verbatim as the curate stage's own opts so callers can
// toggle quality/dedup/cluster/cot/pii and the W921 opt-ins.
// ---------------------------------------------------------------------------
async function _runCurate({ tenant, namespace, pairs, opts }) {
  const curateOpts = (opts.curate && typeof opts.curate === 'object') ? opts.curate : {};
  const res = await curatePairs({ tenant, namespace, pairs, opts: curateOpts });
  return res;
}

// ---------------------------------------------------------------------------
// Stage 3: AUGMENT (PREVIEW-ONLY by default)
//
// Always computes the candidate set + cost preview. Only APPLIES (writes the
// candidates) when opts.approve_cost_usd is a finite number >= the previewed
// est_cost_usd. The cost preview is included in the slot whether applied or not.
//
// Seeds: prefer the curated survivors (curated.out_path is on disk but the
// pairs are also passed by value), else fall back to the ingested pairs.
// Strategy defaults to 'evol' (seed-driven complexity escalation) unless the
// caller picks one via opts.augment_strategy.
// ---------------------------------------------------------------------------
async function _runAugment({ tenant, namespace, seedPairs, opts }) {
  const strategy = (typeof opts.augment_strategy === 'string' && opts.augment_strategy)
    ? opts.augment_strategy
    : 'evol';
  const userAugOpts = (opts.augment && typeof opts.augment === 'object') ? opts.augment : {};

  // 1) PREVIEW: force apply:false so nothing is written regardless of caller opts.
  const preview = await augment({
    tenant,
    namespace,
    strategy,
    seedPairs,
    opts: { ...userAugOpts, apply: false },
  });

  if (!preview || preview.ok !== true) {
    return preview || { ok: false, error: 'augment preview returned no envelope' };
  }

  const estCost = preview.cost_preview && Number.isFinite(Number(preview.cost_preview.est_cost_usd))
    ? Number(preview.cost_preview.est_cost_usd)
    : 0;
  const approve = Number(opts.approve_cost_usd);
  const approved = Number.isFinite(approve) && approve >= estCost;

  // 2) APPLY only when explicitly approved at or above the previewed cost.
  if (!approved) {
    return {
      ...preview,
      applied: false,
      approved: false,
      approve_cost_usd: Number.isFinite(approve) ? approve : null,
      gate: estCost > 0
        ? `preview-only: est_cost_usd=${estCost} requires opts.approve_cost_usd >= ${estCost}`
        : 'preview-only: no approval supplied (est_cost_usd=0)',
      // Drop the bulky candidates array from the preview slot — keep the count.
      candidates: undefined,
    };
  }

  const applied = await augment({
    tenant,
    namespace,
    strategy,
    seedPairs,
    opts: { ...userAugOpts, apply: true },
  });

  if (!applied || applied.ok !== true) {
    // Application failed after approval — surface it but keep the preview info.
    return {
      ok: false,
      version: preview.version,
      error: (applied && applied.error) || 'augment apply returned no envelope',
      strategy,
      cost_preview: preview.cost_preview,
      applied: false,
      approved: true,
      approve_cost_usd: approve,
    };
  }

  return {
    ...applied,
    applied: applied.wrote === true,
    approved: true,
    approve_cost_usd: approve,
    candidates: undefined, // keep the slot light; n_candidates carries the count
  };
}

// ---------------------------------------------------------------------------
// Stage 4: EVALUATE (conditional on a trained-model run_dir)
//
// Runs ONLY when opts.run_dir is provided (the dir a TRAIN step wrote eval
// artifacts into). Without it there is nothing trained to score, so the slot is
// a clean skip — never an error.
// ---------------------------------------------------------------------------
async function _runEvaluate({ tenant, namespace, opts }) {
  const runDir = (typeof opts.run_dir === 'string' && opts.run_dir.trim()) ? opts.run_dir : null;
  if (!runDir) {
    return _skip('no opts.run_dir provided (no trained-model dir to evaluate)');
  }
  const baselineDir = (typeof opts.baseline_dir === 'string' && opts.baseline_dir.trim())
    ? opts.baseline_dir : undefined;
  return evaluateRun({
    tenant,
    namespace,
    run_dir: runDir,
    ...(baselineDir ? { baseline_dir: baselineDir } : {}),
  });
}

// ---------------------------------------------------------------------------
// Stage 5: FEEDBACK
//
// Identifies production coverage gaps and PROPOSES a recompile (writes a
// proposal row only). It NEVER trains. opts.inject_gaps (when an array) routes
// through the testable injectGaps path of identifyProdGaps; opts.feedback is
// forwarded as the underlying coverage-gap opts otherwise.
// ---------------------------------------------------------------------------
async function _runFeedback({ tenant, namespace, opts }) {
  const feedbackOpts = (opts.feedback && typeof opts.feedback === 'object') ? opts.feedback : undefined;
  const injectGaps = Array.isArray(opts.inject_gaps) ? opts.inject_gaps : undefined;

  const gapsRes = await identifyProdGaps({
    tenant,
    namespace,
    ...(feedbackOpts ? { opts: feedbackOpts } : {}),
    ...(injectGaps ? { injectGaps } : {}),
  });

  if (!gapsRes || gapsRes.ok !== true) {
    return gapsRes || { ok: false, error: 'identifyProdGaps returned no envelope' };
  }

  const proposalRes = await proposeRecompile({
    tenant,
    namespace,
    gaps: gapsRes.gaps || [],
  });

  return {
    ok: true,
    version: gapsRes.version,
    n_gaps: gapsRes.n_gaps,
    gaps: gapsRes.gaps,
    recommended_actions: gapsRes.recommended_actions,
    proposal: proposalRes && proposalRes.ok ? proposalRes.proposal : null,
    proposal_persisted: !!(proposalRes && proposalRes.persisted),
    ...(proposalRes && proposalRes.ok !== true ? { proposal_error: proposalRes.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// orchestratePipeline — the single public entry point.
// ---------------------------------------------------------------------------

/**
 * Chain the six data-engine stages with per-stage isolation + a cost gate on
 * AUGMENT. Never throws; every stage slot is either an envelope, a
 * { ok:false, error } failure, or a { skipped:true, reason } skip.
 *
 * @param {object}  args
 * @param {string}  args.tenant      tenant id — fences every downstream call.
 * @param {string} [args.namespace]  data namespace (default 'default').
 * @param {object} [args.opts]       per-stage controls:
 *   describe / data / docs        - ingest source selectors (mutually precedence-ordered)
 *   describe_n | n                - seed count for the describe path
 *   curate                        - opts forwarded to curatePairs
 *   augment / augment_strategy    - augment opts + strategy ('evol' default)
 *   approve_cost_usd              - APPROVE augment apply when >= previewed cost
 *   run_dir / baseline_dir        - EVALUATE inputs (evaluate skipped without run_dir)
 *   feedback / inject_gaps        - FEEDBACK coverage-gap inputs
 * @returns {Promise<object>} { ok:true, version, namespace, stages:{...} }
 */
export async function orchestratePipeline({ tenant, namespace, opts = {} } = {}) {
  const ns = (typeof namespace === 'string' && namespace.trim()) ? namespace.trim() : 'default';
  const tn = (tenant != null && String(tenant).trim()) ? String(tenant).trim() : 'tenant_local';
  const o = (opts && typeof opts === 'object') ? opts : {};

  const stages = {
    ingest: null,
    curate: null,
    augment: null,
    evaluate: null,
    feedback: null,
  };

  // ── INGEST ────────────────────────────────────────────────────────────────
  let ingestPairs = [];
  try {
    const { slot, pairs } = await _runIngest({ tenant: tn, namespace: ns, opts: o });
    stages.ingest = slot;
    ingestPairs = Array.isArray(pairs) ? pairs : [];
  } catch (e) {
    stages.ingest = _fail(e);
    ingestPairs = [];
  }

  const haveCorpus = stages.ingest && stages.ingest.ok === true && ingestPairs.length > 0;

  // ── CURATE ────────────────────────────────────────────────────────────────
  let curatedPairs = ingestPairs;
  if (!haveCorpus) {
    stages.curate = _skip('ingest produced no pairs');
  } else {
    try {
      const res = await _runCurate({ tenant: tn, namespace: ns, pairs: ingestPairs, opts: o });
      stages.curate = res;
      // Prefer curated survivors as augment seeds when curate succeeded. The
      // curated rows are written to disk; the survivor pairs themselves are not
      // returned by curatePairs, so we re-read them from the curate out_path.
      if (res && res.ok === true && res.out_path) {
        const survivors = _readJsonlSafe(res.out_path);
        if (survivors.length) curatedPairs = survivors;
      }
    } catch (e) {
      stages.curate = _fail(e);
    }
  }

  // ── AUGMENT (preview-only unless approved) ─────────────────────────────────
  if (!haveCorpus) {
    stages.augment = _skip('ingest produced no pairs');
  } else {
    try {
      stages.augment = await _runAugment({
        tenant: tn,
        namespace: ns,
        seedPairs: curatedPairs,
        opts: o,
      });
    } catch (e) {
      stages.augment = _fail(e);
    }
  }

  // ── EVALUATE (independent of corpus; gated on run_dir) ─────────────────────
  try {
    stages.evaluate = await _runEvaluate({ tenant: tn, namespace: ns, opts: o });
  } catch (e) {
    stages.evaluate = _fail(e);
  }

  // ── FEEDBACK (independent of corpus; proposal-only) ────────────────────────
  try {
    stages.feedback = await _runFeedback({ tenant: tn, namespace: ns, opts: o });
  } catch (e) {
    stages.feedback = _fail(e);
  }

  return {
    ok: true,
    version: DATA_ENGINE_VERSION,
    namespace: ns,
    stages,
  };
}

// Read a JSONL file into an array of parsed objects. Sync + never throws (a
// missing/unreadable file yields []). node:fs is a core module, not a new
// npm dependency, so this keeps the orchestrator dependency-light.
function _readJsonlSafe(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip a malformed line */ }
  }
  return out;
}

export default {
  DATA_ENGINE_VERSION,
  orchestratePipeline,
};
