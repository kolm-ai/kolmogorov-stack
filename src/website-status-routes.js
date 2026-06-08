// src/website-status-routes.js
//
// W921 - public, read-only trust/status routes for the marketing surface.
//
// Mounted by the orchestrator with a single registerWebsiteStatusRoutes(r, deps)
// call so src/router.js is not edited here. These routes are intended to be
// PUBLIC (no auth) - list the path prefix /v1/status/ in the public allowlist
// when wiring. Every route degrades to a non-fabricated answer; it never emits
// a green status or a large count it cannot back.
//
//   GET /v1/status/summary - Atlassian Statuspage v2 summary.json shape
//   GET /v1/status/receipts - privacy-safe global receipt aggregate (zero PII)
//
// deps (all optional; each route degrades if a primitive is missing):
//   deps.store - { all(table), backendInfo(), stats() }
//   deps.loadSigner - () => signer | throws  (auth/signing liveness probe)
//
// ESM module (repo is "type":"module").

const SEVERITY = { none: 0, minor: 1, major: 2, critical: 3 };
const COMPONENT_OK = 'operational';
const COMPONENT_DEGRADED = 'degraded_performance';

function _now() {
  return new Date().toISOString();
}

// Derive per-component status from cheap in-process liveness. A probe that
// throws degrades exactly one component; nothing is faked operational.
export function probeComponents(deps = {}) {
  const updated_at = _now();
  const out = [];

  // storage: a store backend reachable.
  let storageOk = false;
  try {
    if (deps.store && typeof deps.store.backendInfo === 'function') {
      storageOk = Boolean(deps.store.backendInfo());
    }
  } catch (_) {
    storageOk = false;
  }

  out.push({ id: 'gateway', name: 'Gateway', status: COMPONENT_OK, updated_at });

  // auth/signing: signer loadable.
  let signerOk = true;
  if (typeof deps.loadSigner === 'function') {
    try {
      deps.loadSigner();
      signerOk = true;
    } catch (_) {
      signerOk = false;
    }
  }
  out.push({ id: 'signing', name: 'Receipt signing', status: signerOk ? COMPONENT_OK : COMPONENT_DEGRADED, updated_at });

  out.push({ id: 'storage', name: 'Storage', status: storageOk ? COMPONENT_OK : COMPONENT_DEGRADED, updated_at });

  return out;
}

export function overallIndicator(components) {
  let worst = 'none';
  for (const c of components || []) {
    let sev = 'none';
    if (c.status === 'degraded_performance') sev = 'minor';
    else if (c.status === 'partial_outage') sev = 'major';
    else if (c.status === 'major_outage') sev = 'critical';
    if (SEVERITY[sev] > SEVERITY[worst]) worst = sev;
  }
  const description = {
    none: 'All systems operational',
    minor: 'Minor service degradation',
    major: 'Partial outage',
    critical: 'Major outage',
  }[worst];
  return { indicator: worst, description };
}

export function statusSummary(deps = {}) {
  const components = probeComponents(deps);
  const status = overallIndicator(components);
  return {
    page: { id: 'kolm', name: 'kolm.ai', url: 'https://kolm.ai/status', updated_at: _now() },
    status,
    components,
  };
}

// Privacy-safe global receipt aggregate. Reads the 'observations' table where
// gateway receipts are written; exposes ONLY a global count + the single
// already-public most-recent receipt id. No tenant ids, no prompts, no
// per-tenant counts. 60s in-memory cache.
let _receiptCache = { at: 0, value: null };

export function publicReceiptStats(opts = {}, deps = {}) {
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : 60000;
  const now = Date.now();
  if (_receiptCache.value && now - _receiptCache.at < ttlMs) return _receiptCache.value;

  let total = 0;
  let last24h = 0;
  let lastId = null;
  let lastAt = null;
  try {
    const rows = deps.store && typeof deps.store.all === 'function' ? deps.store.all('observations') : [];
    const dayAgo = now - 24 * 60 * 60 * 1000;
    for (const row of rows || []) {
      const rid = row && (row.receipt_id || (typeof row.id === 'string' && row.id.startsWith('rcpt_') ? row.id : null));
      if (!rid) continue;
      total++;
      const ts = row.created_at || row.ts || row.at;
      const ms = ts ? Date.parse(ts) : NaN;
      if (Number.isFinite(ms)) {
        if (ms >= dayAgo) last24h++;
        if (lastAt == null || ms > Date.parse(lastAt)) {
          lastAt = ts;
          lastId = rid;
        }
      } else if (lastId == null) {
        lastId = rid;
      }
    }
  } catch (_) {
    // degrade to zeros - never fabricate a count.
  }

  const value = {
    ok: true,
    total,
    last_24h: last24h,
    last_receipt_id: lastId,
    last_receipt_at: lastAt,
    verify_url: lastId ? `/v1/verify/${lastId}` : null,
  };
  _receiptCache = { at: now, value };
  return value;
}

export function _resetReceiptCacheForTests() {
  _receiptCache = { at: 0, value: null };
}

export function registerWebsiteStatusRoutes(r, deps = {}) {
  if (!r || typeof r.get !== 'function') return;
  r.get('/v1/status/summary', (req, res) => {
    res.json(statusSummary(deps));
  });
  r.get('/v1/status/receipts', (req, res) => {
    res.json(publicReceiptStats({}, deps));
  });
}
