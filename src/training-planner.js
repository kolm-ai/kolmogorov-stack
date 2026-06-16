// Wave 371 - Training planner (builder layer, pillar 9/12).
//
// Public surface:
//   plan(datasetId, opts) -> training plan envelope
//
// Returns:
//   {
//     plan_id,
//     dataset_id,
//     task,                  // classification | extraction | generation | redaction | unknown
//     examples_real,
//     examples_synthetic,
//     labels,                // count of distinct labels (for classification)
//     label_diversity,       // 0..1 entropy ratio
//     input_length: {p50, p95},
//     sensitive_data_detected: bool,
//     recommended_path,      // rule_first | classifier | lora | distill
//     backbone,              // gemma-3n-e2b | qwen-0.5b | phi-mini | claude-haiku-4-5
//     expected_replacement_rate,
//     holdout_size,
//     estimated_latency_ms,
//     estimated_training_cost_usd,
//     warnings: [],
//   }

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Atoms 1 + 7 (CA-07) - wire the rectified data-scaling law into the planner so
// the plan projects the data budget for a target K-Score ("needs ~N more pairs
// to reach K=x"), reports the marginal-data ROI, and biases the path
// recommendation on whether the corpus clears the law's recommended budget. The
// law was authored (src/data-scaling-law.js) but never called by the planner;
// only opportunity-engine consumed it. planDataBudget gates on
// min_points / rmsd_gate itself and never throws across its public API, so a
// cold-start namespace simply falls through to basis:'insufficient' and the
// plan keeps its existing static path baseline.
import { planDataBudget } from './data-scaling-law.js';

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function loadDataset(datasetId, opts) {
  if (Array.isArray(opts && opts.rows) && opts.rows.length) return { rows: opts.rows, source: 'inline' };
  if (Array.isArray(datasetId)) return { rows: datasetId, source: 'inline' };
  if (typeof datasetId === 'string' && fs.existsSync(datasetId)) {
    const text = fs.readFileSync(datasetId, 'utf8').trim();
    if (text.startsWith('[')) {
      try { return { rows: JSON.parse(text), source: 'file' }; } catch { /* fall through to jsonl */ }
    }
    if (text.startsWith('{') && text.indexOf('\n') === -1) {
      try {
        const j = JSON.parse(text);
        if (Array.isArray(j.rows)) return { rows: j.rows, source: 'file', envelope: j };
      } catch { /* fall through to jsonl */ }
    }
    // JSONL: one JSON object per line (handles both `[`-starting and `{`-starting multiline).
    return {
      rows: text.split(/\r?\n/).filter(Boolean).map((ln) => {
        try { return JSON.parse(ln); } catch { return null; }
      }).filter(Boolean),
      source: 'file',
    };
  }
  if (typeof datasetId === 'string' && datasetId.startsWith('ds_')) {
    const p = path.join(os.homedir(), '.kolm', 'simulations', datasetId + '.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { rows: j.rows || [], source: 'sim_dataset', envelope: j };
    }
  }
  return { rows: [], source: 'unknown' };
}

function pctl(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)));
  return s[idx];
}

function detectTask(rows) {
  if (!rows.length) return 'unknown';
  // Sample 50 rows.
  const sample = rows.slice(0, 50);
  // Redaction: outputs look like the input with [PHI_*] tokens inserted.
  const redactionHits = sample.filter((r) => /\[PHI_|\[\w+_\d+\]/.test(String(r.output || ''))).length;
  if (redactionHits >= sample.length * 0.4) return 'redaction';
  // Classification: outputs are short labels, very few distinct values.
  const outputs = sample.map((r) => String(r.output || '').trim());
  const distinct = new Set(outputs);
  const avgLen = outputs.reduce((s, o) => s + o.length, 0) / Math.max(1, outputs.length);
  if (distinct.size <= 20 && avgLen <= 60) return 'classification';
  // Extraction: outputs look like JSON with key extraction.
  const jsonHits = sample.filter((r) => /^[{[]/.test(String(r.output || '').trim())).length;
  if (jsonHits >= sample.length * 0.4) return 'extraction';
  // Default: generation.
  return 'generation';
}

function entropy(map) {
  const total = [...map.values()].reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  let H = 0;
  for (const v of map.values()) {
    const p = v / total;
    if (p > 0) H -= p * Math.log2(p);
  }
  const max = Math.log2(map.size || 1);
  return max > 0 ? H / max : 0;
}

const SENSITIVE_RE = [/\b\d{3}-\d{2}-\d{4}\b/, /\bMRN\d{4,}\b/i, /\b[\w.-]+@[\w-]+\.[a-z]{2,}\b/i, /\b\d{3}-\d{3}-\d{4}\b/, /\[PHI_/, /\[PII_/];
function hasSensitive(rows) {
  return rows.slice(0, 100).some((r) => SENSITIVE_RE.some((re) => re.test(String(r.input || '') + ' ' + String(r.output || ''))));
}

// Heuristic latency + cost estimates per recommended path. These mirror the
// numbers in MEMORY.md (W354-W358) so the user trial doesn't see a contradiction.
const PATH_PROFILES = {
  rule_first:  { latency_ms: 1,    cost_per_call_usd: 0,        training_cost_usd: 0,    replacement: 0.7 },
  classifier:  { latency_ms: 15,   cost_per_call_usd: 0.000005, training_cost_usd: 3,    replacement: 0.85 },
  lora:        { latency_ms: 80,   cost_per_call_usd: 0.00002,  training_cost_usd: 25,   replacement: 0.9 },
  distill:     { latency_ms: 40,   cost_per_call_usd: 0.00002,  training_cost_usd: 80,   replacement: 0.93 },
};

const BACKBONE_BY_PATH = {
  rule_first: 'none',
  classifier: 'gemma-3n-e2b',
  lora: 'qwen-0.5b',
  distill: 'phi-mini',
};

function _basePath(task, examplesReal, labelDiversity) {
  if (task === 'classification' && labelDiversity < 0.3) return 'rule_first';
  if (task === 'classification') return 'classifier';
  if (task === 'redaction' && examplesReal < 200) return 'classifier';
  if (task === 'generation' && examplesReal >= 1000) return 'distill';
  if (task === 'generation') return 'lora';
  if (task === 'extraction' && examplesReal < 500) return 'classifier';
  if (task === 'extraction') return 'lora';
  // Fallback
  if (examplesReal >= 1000) return 'distill';
  return 'lora';
}

// pickPath now consults the fitted data-budget projection (atom 7). When a
// rectified scaling law is available:
//   - corpus BELOW the recommended budget for the target K biases AWAY from the
//     heavyweight distill path toward a lighter rule_first/classifier baseline
//     plus a 'collect more captures' warning - distilling on too-little data is
//     the textbook over-spend the law exists to prevent;
//   - corpus AT/ABOVE the recommended budget can UNLOCK distill for the
//     generation/extraction tasks where it is the right ceiling.
// With no fit (basis:'insufficient') we fall through to the static _basePath, so
// behavior is unchanged for cold-start namespaces.
function pickPath(task, examplesReal, labelDiversity, projection, warnings) {
  const base = _basePath(task, examplesReal, labelDiversity);
  if (!projection || projection.basis !== 'rectified') return base;

  const recommended = Number(projection.data_budget_recommended);
  const reachable = projection.reachable === true;
  const hasBudget = Number.isFinite(recommended) && recommended > 0;

  // Below-budget bias: if the law says we need materially more data than we
  // have to reach the target, do not recommend distill yet.
  if (hasBudget && examplesReal < recommended) {
    if (base === 'distill') {
      if (Array.isArray(warnings)) {
        warnings.push('below_scaling_budget: scaling law projects ~' + Math.max(0, Math.ceil(recommended - examplesReal))
          + ' more pairs needed to reach the target K; recommending classifier until the corpus clears the budget (collect more captures first).');
      }
      return 'classifier';
    }
    return base;
  }

  // Above-budget unlock: enough data + target reachable -> distill is the right
  // ceiling for the generative/extractive tasks.
  if (hasBudget && reachable && examplesReal >= recommended
      && (task === 'generation' || task === 'extraction')) {
    return 'distill';
  }
  return base;
}

// Default target replacement/K the planner projects toward. The data-scaling law
// works in K-Score space [0,1]; a plan's expected_replacement_rate is the same
// quantity the autopilot calls K, so we reuse it as the projection target.
const DEFAULT_SCALING_TARGET_K = 0.85;

// _projectDataBudget - fit the rectified data-scaling law to the namespace's
// observed (n_pairs, K) history and project the data budget for a target K.
// History points come from opts.kscore_history (array of {n_pairs,k} or [n,k])
// or an injectable async opts.loadScalingPoints({tenant,namespace}); with
// neither (or < min_points / rmsd above gate) the law returns
// basis:'insufficient' and we surface a no-fabrication block the planner can
// render as "insufficient history".
//
// Returned block:
//   { basis, target_k, n_points?, rmsd?, achievable_k_max?,
//     data_budget_recommended,           // pairs to reach target_k (null if unreachable)
//     projected_kscore_at_current_n,     // K_hat at the current corpus size
//     marginal_gain_per_1k_examples,     // dK from acquiring +1000 more pairs
//     reachable, reason }
async function _projectDataBudget({ points, currentN, targetK, minPoints, rmsdGate }) {
  // CD-02 / CD-08 - delegate to the planner-facing budget block in
  // data-scaling-law.js rather than re-deriving the projection from the
  // primitives here. planDataBudget() fits the rectified law, runs the
  // acquire/stop/switch recommendation, and returns a planner-shaped block
  // (basis, verdict, required_examples, pairs_remaining, marginal_dk_per_row,
  // expected_k_at_current, achievable_k_max, curve). It NEVER throws across its
  // public API and returns basis:'insufficient' on cold start / junk fit, so the
  // planner still falls through to its static baseline. We keep this function's
  // historical return shape (data_budget_recommended / projected_kscore_at_current_n
  // / marginal_gain_per_1k_examples / reachable) so pickPath, the warnings, and
  // planReport are unchanged, and additionally surface the block's verdict +
  // required_examples + curve so callers can display the data-acquisition call.
  const block = await planDataBudget({
    points: Array.isArray(points) ? points : null,
    current_n: currentN,
    target_k: targetK,
    min_points: Number.isFinite(minPoints) ? minPoints : 4,
    rmsd_gate: Number.isFinite(rmsdGate) ? rmsdGate : 0.05,
  });
  if (!block || block.basis !== 'rectified') {
    return {
      basis: (block && block.basis) || 'insufficient',
      verdict: null,
      target_k: targetK,
      data_budget_recommended: null,
      required_examples: null,
      projected_kscore_at_current_n: null,
      expected_k_at_current: null,
      marginal_gain_per_1k_examples: null,
      marginal_dk_per_row: null,
      pairs_remaining: null,
      reachable: false,
      curve: null,
      reason: (block && (block.reason || block.error)) || 'no_scaling_history',
      hint: 'provide >=4 (n_pairs,K) observations (opts.kscore_history or opts.loadScalingPoints) to enable a data-budget projection',
    };
  }
  // The block's required_examples is the closed-form rows-to-target. A 'switch'
  // verdict (target above the achievable ceiling) leaves required_examples null;
  // we mirror that into reachable so pickPath's below/above-budget logic only
  // unlocks distill when a reachable budget exists.
  const reachable = block.required_examples != null && Number.isFinite(block.required_examples);
  // marginal_gain_per_1k_examples is the realized K-gain from the next 1000
  // pairs: K_hat(N+1000) - K_hat(N) (the integral, not just 1000*dK/dD, so it
  // stays meaningful in the saturating tail). The block already carries the
  // analytic dK/dD at the current size (marginal_dk_per_row); we re-derive the
  // per-1k integral from the sampled curve / a follow-up fit point for the
  // human-facing "needs more data" copy, falling back to 1000*dK/dD.
  let gainPer1k = null;
  const kNow = Number.isFinite(block.expected_k_at_current) ? block.expected_k_at_current : null;
  if (kNow != null && Array.isArray(block.curve) && block.curve.length) {
    const ahead = block.curve.find((pt) => pt && pt.n >= currentN + 1000);
    if (ahead && Number.isFinite(ahead.k_hat)) gainPer1k = ahead.k_hat - kNow;
  }
  if (gainPer1k == null && Number.isFinite(block.marginal_dk_per_row)) {
    gainPer1k = block.marginal_dk_per_row * 1000;
  }
  return {
    basis: 'rectified',
    // CD-08 - surface the acquire | stop | switch verdict so callers (CLI /
    // dashboard) can render the data-acquisition recommendation directly.
    verdict: block.verdict || null,
    target_k: block.target_k != null ? block.target_k : targetK,
    n_points: block.n_points,
    rmsd: block.rmsd,
    achievable_k_max: block.achievable_k_max,
    reachable,
    // When the fit is rectified, the recommended train-row count IS the law's
    // required_examples (the closed-form rows to hit target_k), replacing the
    // fixed heuristic. data_budget_recommended is kept as the legacy alias the
    // pickPath / warnings / report already read.
    required_examples: reachable ? block.required_examples : null,
    data_budget_recommended: reachable ? block.required_examples : null,
    pairs_remaining: (block.pairs_remaining != null && Number.isFinite(block.pairs_remaining))
      ? block.pairs_remaining
      : (reachable ? Math.max(0, block.required_examples - currentN) : null),
    expected_k_at_current: kNow,
    projected_kscore_at_current_n: kNow,
    marginal_dk_per_row: Number.isFinite(block.marginal_dk_per_row) ? block.marginal_dk_per_row : null,
    marginal_gain_per_1k_examples: Number.isFinite(gainPer1k) ? Math.round(gainPer1k * 1e6) / 1e6 : null,
    curve: Array.isArray(block.curve) ? block.curve : null,
    reason: reachable ? 'fitted_rectified_scaling_law' : (block.reason || 'target_above_achievable_k_max'),
  };
}

export async function plan(datasetId, opts = {}) {
  const { rows, source, envelope } = loadDataset(datasetId, opts);
  const warnings = [];
  if (rows.length === 0) {
    warnings.push('dataset_empty');
    return {
      plan_id: 'plan_empty_' + sha(String(datasetId)).slice(0, 12),
      dataset_id: typeof datasetId === 'string' ? datasetId : 'inline',
      dataset_source: source,
      task: 'unknown',
      examples_real: 0,
      examples_synthetic: 0,
      labels: 0,
      label_diversity: 0,
      input_length: { p50: 0, p95: 0 },
      sensitive_data_detected: false,
      recommended_path: 'rule_first',
      backbone: 'none',
      expected_replacement_rate: 0,
      holdout_size: 0,
      estimated_latency_ms: 0,
      estimated_training_cost_usd: 0,
      data_budget: { basis: 'insufficient', verdict: null, target_k: DEFAULT_SCALING_TARGET_K, data_budget_recommended: null, required_examples: null, projected_kscore_at_current_n: null, expected_k_at_current: null, marginal_gain_per_1k_examples: null, marginal_dk_per_row: null, reachable: false, curve: null, reason: 'dataset_empty' },
      data_budget_recommended: null,
      data_budget_verdict: null,
      projected_kscore_at_current_n: null,
      marginal_gain_per_1k_examples: null,
      warnings,
    };
  }
  const examplesSynthetic = rows.filter((r) => r.source_type === 'synthetic').length;
  const examplesReal = rows.length - examplesSynthetic;
  const task = detectTask(rows);
  // Label diversity for classification/redaction.
  const labelMap = new Map();
  for (const r of rows.slice(0, 2000)) {
    const lbl = String(r.output || '').trim().slice(0, 200);
    labelMap.set(lbl, (labelMap.get(lbl) || 0) + 1);
  }
  const labels = labelMap.size;
  const labelDiversity = entropy(labelMap);
  // Input length distribution.
  const lens = rows.slice(0, 2000).map((r) => String(r.input || '').length);
  const inputLength = { p50: pctl(lens, 0.5), p95: pctl(lens, 0.95) };
  const sensitive = hasSensitive(rows);

  // Data-budget projection (atoms 1 + 7). Resolve the namespace's observed
  // (n_pairs, K) history, fit the rectified scaling law, and project the data
  // budget for the target K. History comes from opts.kscore_history (inline) or
  // an injectable opts.loadScalingPoints({tenant,namespace}); absent either, the
  // law returns basis:'insufficient' and the plan keeps its static baseline.
  const targetK = Number.isFinite(Number(opts.target_kscore))
    ? Number(opts.target_kscore) : DEFAULT_SCALING_TARGET_K;
  let scalingPoints = Array.isArray(opts.kscore_history) ? opts.kscore_history : null;
  if (!scalingPoints && typeof opts.loadScalingPoints === 'function') {
    try { scalingPoints = await opts.loadScalingPoints({ tenant: opts.tenant, namespace: opts.namespace }); }
    catch (_) { scalingPoints = null; } // loader failure -> fall through to insufficient
  }
  const dataBudget = await _projectDataBudget({
    points: scalingPoints,
    currentN: examplesReal,
    targetK,
    minPoints: opts.scaling_min_points,
    rmsdGate: opts.scaling_rmsd_gate,
  });

  // Pick path + backbone (projection-aware: below-budget biases lighter,
  // above-budget can unlock distill).
  const recommendedPath = pickPath(task, examplesReal, labelDiversity, dataBudget, warnings);
  const backbone = BACKBONE_BY_PATH[recommendedPath] || 'qwen-0.5b';
  const profile = PATH_PROFILES[recommendedPath];
  const holdoutSize = Math.max(1, Math.floor(rows.length * 0.2));
  // Warnings.
  if (examplesSynthetic > 0 && envelope && Array.isArray(envelope.holdout) && envelope.holdout.some((h) => h.source_type === 'synthetic')) {
    warnings.push('synthetic_in_holdout: holdout contains synthetic rows. Pass holdoutFromSim=false (default) and re-split for an honest evaluation.');
  }
  if (examplesReal < 30) warnings.push('few_real_examples: <30 real examples reduces the floor of every recommendation; consider mining more captures first.');
  if (sensitive && recommendedPath === 'distill') warnings.push('sensitive_data_in_distill: distill copies prompts to a third-party teacher unless you set KOLM_LLM_PROVIDER to a local backend. Verify privacy_membrane first.');
  if (labels > 50 && task === 'classification') warnings.push('too_many_labels_for_classifier: consider switching to lora or hierarchical classification.');
  // Replacement rate estimate is the path baseline, scaled down 5%/100 missing
  // real examples below 200.
  const realPenalty = examplesReal < 200 ? Math.max(0, 0.05 * Math.floor((200 - examplesReal) / 100)) : 0;
  const expectedReplacement = Math.max(0, profile.replacement - realPenalty);

  // Surface a concrete "needs ~N more pairs to reach K=x" warning when the law
  // fitted and the corpus is short of the recommended budget (atom 1). The
  // below-budget bias inside pickPath may already have pushed a distill plan
  // down to classifier; this warning is the human-readable companion.
  if (dataBudget && dataBudget.basis === 'rectified'
      && Number.isFinite(dataBudget.pairs_remaining) && dataBudget.pairs_remaining > 0) {
    warnings.push('needs_more_data: scaling law projects ~' + dataBudget.pairs_remaining
      + ' more pairs to reach K=' + targetK
      + ' (current corpus ' + examplesReal + ', projected K at current size '
      + (dataBudget.projected_kscore_at_current_n != null ? dataBudget.projected_kscore_at_current_n : 'n/a') + ').');
  }

  return {
    plan_id: 'plan_' + sha(String(datasetId) + ':' + recommendedPath + ':' + rows.length).slice(0, 12),
    dataset_id: typeof datasetId === 'string' ? datasetId : 'inline',
    dataset_source: source,
    task,
    examples_real: examplesReal,
    examples_synthetic: examplesSynthetic,
    labels,
    label_diversity: Math.round(labelDiversity * 100) / 100,
    input_length: inputLength,
    sensitive_data_detected: sensitive,
    recommended_path: recommendedPath,
    backbone,
    expected_replacement_rate: Math.round(expectedReplacement * 100) / 100,
    holdout_size: holdoutSize,
    estimated_latency_ms: profile.latency_ms,
    estimated_training_cost_usd: profile.training_cost_usd,
    // Atoms 1 + 7 - the fitted data-budget projection. basis:'insufficient'
    // when there is no usable (n_pairs,K) history, in which case the numeric
    // fields are null (no fabrication).
    data_budget: dataBudget,
    data_budget_recommended: dataBudget.data_budget_recommended,
    // CD-08 - surface the acquire | stop | switch verdict from planDataBudget()
    // at the top level so callers can render the data-acquisition call without
    // reaching into the nested block. null when basis:'insufficient'.
    data_budget_verdict: dataBudget.verdict || null,
    projected_kscore_at_current_n: dataBudget.projected_kscore_at_current_n,
    marginal_gain_per_1k_examples: dataBudget.marginal_gain_per_1k_examples,
    warnings,
  };
}

export function planReport(plan) {
  if (!plan) return 'no plan';
  const lines = [];
  lines.push('Training Plan: ' + plan.plan_id);
  lines.push('');
  lines.push('  Dataset:                  ' + plan.dataset_id);
  lines.push('    Real examples:          ' + plan.examples_real);
  lines.push('    Synthetic examples:     ' + plan.examples_synthetic);
  lines.push('    Labels (distinct):      ' + plan.labels);
  lines.push('    Label diversity:        ' + plan.label_diversity);
  lines.push('    Input length p50/p95:   ' + plan.input_length.p50 + ' / ' + plan.input_length.p95);
  lines.push('    Sensitive data:         ' + (plan.sensitive_data_detected ? 'YES' : 'no'));
  lines.push('');
  lines.push('  Detected task:            ' + plan.task);
  lines.push('  Recommended path:         ' + plan.recommended_path);
  lines.push('  Backbone:                 ' + plan.backbone);
  lines.push('  Expected replacement:     ' + (Math.round(plan.expected_replacement_rate * 100)) + '%');
  lines.push('  Holdout size:             ' + plan.holdout_size + ' examples');
  lines.push('  Estimated p50 latency:    ' + plan.estimated_latency_ms + ' ms');
  lines.push('  Estimated training cost:  $' + plan.estimated_training_cost_usd);
  // Atoms 1 + 7 - data-budget projection from the rectified scaling law.
  const db = plan.data_budget;
  if (db && db.basis === 'rectified') {
    lines.push('');
    lines.push('  Data budget (scaling law, ' + db.n_points + ' pts, rmsd ' + db.rmsd + '):');
    if (db.verdict) lines.push('    Verdict:                ' + db.verdict);
    lines.push('    Target K-Score:         ' + db.target_k);
    lines.push('    Projected K at current: ' + (db.projected_kscore_at_current_n != null ? db.projected_kscore_at_current_n : 'n/a'));
    if (db.reachable && db.data_budget_recommended != null) {
      lines.push('    Pairs to reach target:  ' + db.data_budget_recommended
        + (db.pairs_remaining != null ? ' (' + db.pairs_remaining + ' more)' : ''));
    } else {
      lines.push('    Pairs to reach target:  unreachable (achievable K max '
        + (db.achievable_k_max != null ? db.achievable_k_max : 'n/a') + ')');
    }
    lines.push('    Marginal gain / 1k:     ' + (db.marginal_gain_per_1k_examples != null ? db.marginal_gain_per_1k_examples : 'n/a'));
  } else if (db) {
    lines.push('');
    lines.push('  Data budget:              insufficient history (' + (db.reason || 'no_scaling_history') + ')');
  }
  if (plan.warnings && plan.warnings.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of plan.warnings) lines.push('  - ' + w);
  }
  return lines.join('\n');
}

export default { plan, planReport };
