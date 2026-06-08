// W866 - MoE expert activation analysis + pruning.
//
// For an MoE artifact, read the eval set, run inference (or use cached router
// decisions from receipts), and report:
//   - per-expert activation count
//   - per-expert activation percentage (normalized)
//   - prune candidates (activation < threshold)
//   - estimated K-Score impact if pruned
//
// Two data sources, in priority order:
//   1) cached router decisions in artifact's receipts/router.jsonl (preferred)
//   2) live router replay via apps/runtime/serve.py (heavyweight, opt-in)
//
// This module is the data side. UI (CLI, TUI, Account) renders the bar chart
// from `analyzeExperts(...)`. Pruning execution lands in W874 large-model
// streaming-quant - this just identifies candidates and reports estimated cost.

import fs from 'node:fs';
import path from 'node:path';
import { inspectArtifact } from './forge-inspect.js';

export const EXPERTS_VERSION = 'forge-experts-v1';
export const DEFAULT_PRUNE_THRESHOLD = 0.01;   // 1% activation

/**
 * Read cached router decisions from an artifact's receipts directory.
 * Returns array of {expert_id, count} or null if no cache.
 *
 * Receipts format (one JSON per line):
 *   {"input_idx": 12, "experts_activated": [3, 7, 41, 88], "weights": [...]}
 *
 * The artifact runtime writes these during the eval-set pass that gates K-Score.
 */
function readCachedRouterDecisions(artifactDir) {
  const routerLog = path.join(artifactDir, 'receipts', 'router.jsonl');
  if (!fs.existsSync(routerLog)) return null;
  const lines = fs.readFileSync(routerLog, 'utf8').split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  const counts = new Map();
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (!Array.isArray(rec.experts_activated)) continue;
      for (const eid of rec.experts_activated) {
        counts.set(eid, (counts.get(eid) || 0) + 1);
      }
    } catch { /* skip malformed lines */ }
  }
  if (counts.size === 0) return null;
  return Array.from(counts.entries())
    .map(([expert_id, count]) => ({ expert_id, count }))
    .sort((a, b) => a.expert_id - b.expert_id);
}

/**
 * Analyze expert activation distribution for a .kolm artifact.
 * @param {string} artifactPath path to .kolm or directory containing manifest+receipts
 * @returns {Object} {
 *   is_moe, num_experts, num_experts_per_tok,
 *   total_decisions, expert_activations: [{expert_id, count, pct}],
 *   prune_candidates: [{expert_id, pct}], pruned_size_pct_reduction,
 *   estimated_kscore_impact, source
 * }
 */
export async function analyzeExperts(artifactPath, { threshold = DEFAULT_PRUNE_THRESHOLD } = {}) {
  // Determine if it's a directory or a .kolm file
  const isDir = fs.existsSync(artifactPath) && fs.statSync(artifactPath).isDirectory();
  const artifactDir = isDir ? artifactPath : path.dirname(artifactPath);
  // Pull architecture from artifact manifest (async - forge-inspect.inspectArtifact
  // is async because it dynamic-imports src/artifact-runner.js).
  let inspected;
  try {
    inspected = await inspectArtifact(artifactPath);
  } catch (e) {
    throw new Error(`experts_requires_valid_artifact: ${e.message}`);
  }
  if (!inspected.is_moe) {
    return {
      is_moe: false,
      reason: 'artifact_is_dense_not_moe',
      hint: 'use kolm inspect to see architecture',
      forge_experts_version: EXPERTS_VERSION,
    };
  }
  const numExperts = inspected.num_experts;
  const cached = readCachedRouterDecisions(artifactDir);
  if (!cached) {
    return {
      is_moe: true,
      num_experts: numExperts,
      reason: 'no_cached_router_decisions',
      hint: `no receipts/router.jsonl in artifact dir. Re-run kolm verify with --capture-router to generate.`,
      forge_experts_version: EXPERTS_VERSION,
    };
  }
  const totalDecisions = cached.reduce((s, e) => s + e.count, 0);
  // Compute per-expert pct (with zero-fill for inactive experts)
  const countsMap = new Map(cached.map(e => [e.expert_id, e.count]));
  const expert_activations = [];
  for (let eid = 0; eid < numExperts; eid++) {
    const count = countsMap.get(eid) || 0;
    expert_activations.push({
      expert_id: eid,
      count,
      pct: totalDecisions > 0 ? Math.round((count / totalDecisions) * 10000) / 100 : 0,  // 2-dp pct
    });
  }
  const prune_candidates = expert_activations.filter(e => (e.pct / 100) < threshold);
  // Estimated size reduction: each pruned expert saves its MLP weights.
  // For a model with N experts and full-MLP per expert, pruning K = K/N * (MLP_frac_of_total)
  // MLP is typically 50-60% of weights for MoE; assume 0.55.
  const pruned_size_pct_reduction = numExperts > 0
    ? Math.round((prune_candidates.length / numExperts) * 0.55 * 10000) / 100
    : 0;
  // Estimated K-Score impact: linear with summed activation pct of pruned experts.
  // Sum of pruned pcts × penalty factor 1.5 (conservative empirical from
  // sparse pruning papers). Capped at 5% K-Score loss for sanity.
  const prunedPctSum = prune_candidates.reduce((s, e) => s + e.pct, 0);
  const estimated_kscore_impact = Math.min(
    Math.round((prunedPctSum / 100) * 1.5 * 1000) / 1000,
    0.05,
  );
  return {
    is_moe: true,
    num_experts: numExperts,
    num_experts_per_tok: inspected.num_experts_per_tok,
    total_decisions: totalDecisions,
    expert_activations,
    prune_candidates,
    prune_threshold: threshold,
    pruned_size_pct_reduction,
    estimated_kscore_impact,
    source: 'cached_router_decisions',
    forge_experts_version: EXPERTS_VERSION,
  };
}

/**
 * Render a text-bar visualization of activation distribution (for CLI / TUI).
 * Returns a multiline string ready to print.
 */
export function renderActivationBars(analysis, { width = 20 } = {}) {
  if (!analysis.is_moe || !analysis.expert_activations) {
    return analysis.hint || 'no_moe_data';
  }
  const maxPct = Math.max(...analysis.expert_activations.map(e => e.pct), 1);
  const lines = [];
  for (const e of analysis.expert_activations) {
    const filled = Math.round((e.pct / maxPct) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const prune = analysis.prune_candidates.some(p => p.expert_id === e.expert_id) ? '  ← prune?' : '';
    lines.push(`  Expert ${String(e.expert_id).padStart(3)}  ${bar}  ${e.pct.toFixed(1)}%${prune}`);
  }
  return lines.join('\n');
}
