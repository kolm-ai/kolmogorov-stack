// Adversarial eval - generate weak-cluster probe sets and record the gap
// between a model's standard-bench score and its adversarial-bench score.
//
// A distilled student that looks strong on a held-out bench can still fold on
// adversarial probes targeted at its weak clusters (ambiguous prompts, stacked
// constraints, edge cases, negation, out-of-scope asks). This module turns a
// list of weak clusters into a JSONL bench file that the Python eval adapter
// (`eval_adapter.py --bench adversarial`) consumes on the SAME load/score/write
// path as MixEval-Hard, then records the standard-vs-adversarial gap as a
// best-effort event.
//
// Caveats:
//   - The probes are templated, not model-generated. They are deterministic and
//     reproducible, which is what a CI gate wants; they are not a substitute for
//     a red-team pass.
//   - Persistence is best-effort (see _persist). A failed write never throws
//     across the public API.
//
// Pure ESM. Envelope contract: every public function returns
//   {ok:true, version:'adv-v1', ...} or {ok:false, error, version:'adv-v1'}.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as eventStore from './event-store.js';

export const ADVERSARIAL_VERSION = 'adv-v1';

const PROVIDER = 'kolm_adversarial_eval';

async function _persist({ tenant, namespace, workflow, payload }) {
  try {
    const ev = await eventStore.appendEvent({
      tenant_id: tenant,
      namespace: namespace || 'default',
      provider: PROVIDER,
      vendor: 'kolm',
      model: 'adversarial-eval/v1',
      workflow_id: workflow,
      status: 'ok',
      prompt_tokens: 0,
      completion_tokens: 0,
      feedback: JSON.stringify(payload || {}),
    });
    return { persisted: true, event_id: ev && ev.event_id };
  } catch (e) {
    return { persisted: false, error: String((e && e.message) || e) };
  }
}

// Root for bench files. ~/.kolm by default; KOLM_DATA_DIR overrides the root so
// smokes/tests stay isolated (mirrors event-store.js precedence).
function _benchRoot() {
  const base = process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(os.homedir(), '.kolm');
  return path.join(base, 'benches');
}

// Normalize a weak-cluster entry (string OR {cluster_id, label}) into a stable
// {cluster_id, label} pair. A bare string is used as both id and label.
function _normCluster(c, idx) {
  if (c && typeof c === 'object') {
    const cluster_id = String(c.cluster_id != null ? c.cluster_id : (c.label != null ? c.label : `cluster_${idx}`));
    const label = String(c.label != null ? c.label : cluster_id);
    return { cluster_id, label };
  }
  const s = String(c == null ? `cluster_${idx}` : c);
  return { cluster_id: s, label: s };
}

// The five adversarial templates. Each takes a normalized cluster {label} and
// the probe index within its template, and returns a probe string that mentions
// the cluster label (so a reviewer can trace each probe back to its cluster).
const _TEMPLATES = [
  { key: 'ambiguity', make: (label) =>
      `Regarding "${label}": answer this deliberately ambiguous request without assuming which of the two plausible readings I mean - state the ambiguity first, then handle both.` },
  { key: 'multi-constraint', make: (label) =>
      `For "${label}", satisfy ALL of these at once: be under 40 words, cite a concrete example, avoid the word "simply", and end with a single follow-up question.` },
  { key: 'edge-case', make: (label) =>
      `Take the "${label}" scenario to its boundary: what happens with an empty input, a maximum-size input, and a malformed input? Address each edge case explicitly.` },
  { key: 'negation', make: (label) =>
      `About "${label}": describe what is NOT true and what should NOT be done - answer purely in the negative, listing the common mistakes to avoid.` },
  { key: 'out-of-scope', make: (label) =>
      `This "${label}" question is intentionally out of scope for your role. Decline appropriately, explain why it is out of scope, and redirect to what you can help with.` },
];

// buildProbes(cluster, perTemplate) - pure helper. Returns the probe strings for
// one cluster: `perTemplate` (default 1) variants of EACH of the five templates,
// so the returned count is 5 * perTemplate. Every probe mentions the cluster
// label and the variant index keeps repeats distinct.
export function buildProbes(cluster, perTemplate) {
  const { label } = _normCluster(cluster, 0);
  const per = Math.max(1, Math.trunc(Number(perTemplate) || 1));
  const probes = [];
  for (const tpl of _TEMPLATES) {
    for (let v = 0; v < per; v++) {
      const base = tpl.make(label);
      // Keep repeats distinct without losing the label mention.
      probes.push(per === 1 ? base : `${base} (variant ${v + 1})`);
    }
  }
  return probes;
}

// generateAdversarialSet({ tenant, namespace, weak_clusters, n }) - write a
// JSONL bench file of adversarial probes, one line per probe, each tagged with
// the cluster it targets and the template it came from. Returns
// {ok, version, bench_file, n_questions, clusters_covered}.
//
// n defaults to max(weak_clusters.length * 5, 10). We compute how many probes
// per template per cluster are needed to reach n, then emit exactly n lines so
// the file size is predictable.
export async function generateAdversarialSet({ tenant, namespace, weak_clusters, n } = {}) {
  try {
    const ns = namespace || 'default';
    const tn = tenant || 'tenant_local';
    if (!Array.isArray(weak_clusters) || weak_clusters.length === 0) {
      return { ok: false, error: 'weak_clusters must be a non-empty array', version: ADVERSARIAL_VERSION };
    }
    const clusters = weak_clusters.map((c, i) => _normCluster(c, i));
    const target = (n == null || !Number.isFinite(Number(n)))
      ? Math.max(clusters.length * 5, 10)
      : Math.max(1, Math.trunc(Number(n)));

    // perTemplate so that clusters.length * 5 * perTemplate >= target.
    const perTemplate = Math.max(1, Math.ceil(target / (clusters.length * _TEMPLATES.length)));

    // Build candidate probes round-robin across clusters so every cluster is
    // represented even when target is small.
    const lines = [];
    let counter = 0;
    outer: for (let v = 0; v < perTemplate; v++) {
      for (const tpl of _TEMPLATES) {
        for (const cl of clusters) {
          const probe = perTemplate === 1
            ? tpl.make(cl.label)
            : `${tpl.make(cl.label)} (variant ${v + 1})`;
          counter += 1;
          const row = {
            id: `adv_${ns}_${String(counter).padStart(4, '0')}`,
            cluster_id: cl.cluster_id,
            cluster_label: cl.label,
            template: tpl.key,
            question: probe,
            // No reference: the local judge falls back to a deterministic
            // heuristic for these. A reviewer/teacher can fill reference_answer
            // later to switch to token-overlap scoring.
            reference_answer: null,
          };
          lines.push(JSON.stringify(row));
          if (lines.length >= target) break outer;
        }
      }
    }

    const dir = path.join(_benchRoot(), `adversarial-${ns}`);
    fs.mkdirSync(dir, { recursive: true });
    const benchFile = path.join(dir, 'questions.jsonl');
    fs.writeFileSync(benchFile, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');

    const coveredIds = new Set();
    for (const ln of lines) {
      try { coveredIds.add(JSON.parse(ln).cluster_id); } catch { /* deliberate: skip unparseable */ }
    }
    const clustersCovered = coveredIds.size;

    const persist = await _persist({
      tenant: tn,
      namespace: ns,
      workflow: 'adversarial:generate',
      payload: {
        bench_file: benchFile,
        n_questions: lines.length,
        clusters_covered: clustersCovered,
        clusters: clusters.map((c) => c.cluster_id),
      },
    });

    return {
      ok: true,
      version: ADVERSARIAL_VERSION,
      bench_file: benchFile,
      n_questions: lines.length,
      clusters_covered: clustersCovered,
      persist,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: ADVERSARIAL_VERSION };
  }
}

// recordAdversarialGap({ tenant, namespace, standard_score, adversarial_score })
// - persist the gap (standard - adversarial) so a dashboard / ship gate can
// flag students that degrade under adversarial probing. Returns {ok, version, gap}.
export async function recordAdversarialGap({ tenant, namespace, standard_score, adversarial_score } = {}) {
  try {
    const std = Number(standard_score);
    const adv = Number(adversarial_score);
    if (!Number.isFinite(std) || !Number.isFinite(adv)) {
      return { ok: false, error: 'standard_score and adversarial_score must be numbers', version: ADVERSARIAL_VERSION };
    }
    const gap = Math.round((std - adv) * 1e6) / 1e6;
    const persist = await _persist({
      tenant: tenant || 'tenant_local',
      namespace: namespace || 'default',
      workflow: 'adversarial:gap',
      payload: { standard_score: std, adversarial_score: adv, gap },
    });
    return { ok: true, version: ADVERSARIAL_VERSION, gap, standard_score: std, adversarial_score: adv, persist };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: ADVERSARIAL_VERSION };
  }
}
