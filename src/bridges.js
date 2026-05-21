// W560 — repeated-workflow clustering surface.
//
// Used by /v1/workflows/repeated and repeated-workflows.html. The router
// lazy-imports this module so a missing file degrades to {ok:true, total:0,
// workflows:[], note:'Cannot find module...'} rather than 500. Persona walks
// (P6 AI-SaaS + P7 Support/Ops) flagged the missing module, which prevented
// the "canned reply suggestions" engine from surfacing real clusters even
// when observations existed.
//
// Source of truth: the `observations` table (W258-BE-1 durable contract),
// populated by POST /v1/bridges/observe and the proxy capture handlers. We
// group on `template_hash` (already computed at insert time by
// templateSignature() in router.js), so this module stays read-only and
// can't drift from the writer.

import { findByTenant } from './store.js';

const SAMPLE_CAP = 8;

function obsNs(o) {
  return o.corpus_namespace || o.namespace || 'default';
}

function previewInput(o) {
  return String(o.variable_input || o.prompt || o.template_preview || '').slice(0, 240);
}

function previewOutput(o) {
  if (typeof o.response === 'string') return o.response.slice(0, 240);
  try { return JSON.stringify(o.response || '').slice(0, 240); } catch (_) { return ''; }
}

export async function observations(opts = {}) {
  const tenant = opts.tenant || null;
  const namespace = opts.namespace ? String(opts.namespace) : null;
  const minCount = Math.max(2, Number(opts.min_count) || 2);
  if (!tenant) return { clusters: [] };

  let rows = findByTenant('observations', tenant);
  if (!Array.isArray(rows)) rows = [];
  rows = rows.filter((o) => o && !o.discarded);
  if (namespace) rows = rows.filter((o) => obsNs(o) === namespace);

  const groups = new Map();
  for (const o of rows) {
    const key = o.template_hash || o.template_preview || 'unknown';
    let g = groups.get(key);
    if (!g) {
      g = {
        template: o.template_preview || o.template_hash || null,
        template_signature: o.template_hash || null,
        count: 0,
        first_seen: o.created_at || null,
        last_seen: o.created_at || null,
        total_cost_usd: 0,
        total_latency_ms: 0,
        models: new Set(),
        namespaces: new Set(),
        samples: [],
      };
      groups.set(key, g);
    }
    g.count++;
    g.total_cost_usd += Number(o.cost_usd) || 0;
    g.total_latency_ms += Number(o.latency_ms) || 0;
    if (o.model) g.models.add(String(o.model));
    g.namespaces.add(obsNs(o));
    const ts = o.created_at || '';
    if (ts && (!g.first_seen || ts < g.first_seen)) g.first_seen = ts;
    if (ts && (!g.last_seen || ts > g.last_seen)) g.last_seen = ts;
    if (g.samples.length < SAMPLE_CAP) {
      g.samples.push({
        id: o.id || null,
        input: previewInput(o),
        output: previewOutput(o),
        model: o.model || '',
        created_at: o.created_at || null,
      });
    }
  }

  const clusters = [...groups.values()]
    .filter((g) => g.count >= minCount)
    .map((g) => ({
      template: g.template,
      template_signature: g.template_signature,
      count: g.count,
      first_seen: g.first_seen,
      last_seen: g.last_seen,
      avg_latency_ms: Math.round(g.total_latency_ms / Math.max(1, g.count)),
      total_cost_usd: Math.round(g.total_cost_usd * 1e6) / 1e6,
      models: [...g.models],
      namespaces: [...g.namespaces],
      samples: g.samples,
    }))
    .sort((a, b) => b.count - a.count);

  return { clusters };
}

export default { observations };
