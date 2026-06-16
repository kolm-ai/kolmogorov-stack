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
// only opportunity-engine consumed it. fitDataScalingLaw gates on
// min_points / rmsd_gate itself and never throws across its public API, so a
// cold-start namespace simply falls through to basis:'insufficient' and the
// plan keeps its existing static path baseline.
import {
  fitDataScalingLaw,
  kHatAtSize,
  marginalDkPerRow,
  pairsToTarget,
} from './data-scaling-law.js';

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
  const fit = await fitDataScalingLaw({
    points: Array.isArray(points) ? points : null,
    min_points: Number.isFinite(minPoints) ? minPoints : 4,
    rmsd_gate: Number.isFinite(rmsdGate) ? rmsdGate : 0.05,
  });
  if (!fit || !fit.ok || fit.basis !== 'rectified') {
    return {
      basis: (fit && fit.basis) || 'insufficient',
      target_k: targetK,
      data_budget_recommended: null,
      projected_kscore_at_current_n: null,
      marginal_gain_per_1k_examples: null,
      reachable: false,
      reason: (fit && (fit.reason || fit.error)) || 'no_scaling_history',
      hint: 'provide >=4 (n_pairs,K) observations (opts.kscore_history or opts.loadScalingPoints) to enable a data-budget projection',
    };
  }
  const ptt = pairsToTarget(fit, targetK);
  const kNow = kHatAtSize(fit, currentN);
  const marginalNow = marginalDkPerRow(fit, currentN);
  // marginal_gain_per_1k_examples is the realized K-gain from the next 1000
  // pairs: K_hat(N+1000) - K_hat(N) (the integral, not just 1000*dK/dD, so it
  // stays meaningful in the saturating tail). Fall back to the analytic
  // 1000*dK/dD when the discrete delta is degenerate.
  const kPlus1k = kHatAtSize(fit, currentN + 1000);
  let gainPer1k = Number.isFinite(kPlus1k) && Number.isFinite(kNow) ? (kPlus1k - kNow) : NaN;
  if (!Number.isFinite(gainPer1k)) gainPer1k = Number.isFinite(marginalNow) ? marginalNow * 1000 : null;
  return {
    basis: 'rectified',
    target_k: targetK,
    n_points: fit.n_points,
    rmsd: fit.rmsd,
    achievable_k_max: fit.achievable_k_max,
    reachable: ptt.reachable === true,
    data_budget_recommended: ptt.reachable ? ptt.pairs_to_target : null,
    pairs_remaining: (ptt.reachable && Number.isFinite(ptt.pairs_to_target))
      ? Math.max(0, ptt.pairs_to_target - currentN) : null,
    projected_kscore_at_current_n: Number.isFinite(kNow) ? Math.round(kNow * 1e6) / 1e6 : null,
    marginal_gain_per_1k_examples: Number.isFinite(gainPer1k) ? Math.round(gainPer1k * 1e6) / 1e6 : null,
    reason: ptt.reachable ? 'fitted_rectified_scaling_law' : 'target_above_achievable_k_max',
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
      data_budget: { basis: 'insufficient', target_k: DEFAULT_SCALING_TARGET_K, data_budget_recommended: null, projected_kscore_at_current_n: null, marginal_gain_per_1k_examples: null, reachable: false, reason: 'dataset_empty' },
      data_budget_recommended: null,
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
