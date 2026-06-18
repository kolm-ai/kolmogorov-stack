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
const RECEIPT_ID_RE = /^rcpt_[A-Za-z0-9._:@-]+$/;

export const WEBSITE_STATUS_VERSION = 'w921-v1';
export const WEBSITE_STATUS_CONTRACT_VERSION = 'w742-website-status-v1';
export const WEBSITE_STATUS_COMPONENT_IDS = Object.freeze(['gateway', 'signing', 'storage']);
export const WEBSITE_STATUS_LIMITS = Object.freeze({
  max_receipt_scan_rows: 1000,
  max_receipt_id_chars: 128,
  receipt_cache_ttl_ms: 60000,
  max_receipt_cache_ttl_ms: 300000,
});

function _nowMs(opts = {}) {
  const raw = opts.now_ms ?? opts.nowMs;
  const n = Number(raw);
  return Number.isFinite(n) ? n : Date.now();
}

function _now(opts = {}) {
  const rawIso = opts.now_iso ?? opts.nowIso;
  if (typeof rawIso === 'string') {
    const parsed = Date.parse(rawIso);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(_nowMs(opts)).toISOString();
}

function _normalizedTtlMs(value) {
  if (value == null) return WEBSITE_STATUS_LIMITS.receipt_cache_ttl_ms;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return WEBSITE_STATUS_LIMITS.receipt_cache_ttl_ms;
  return Math.min(Math.floor(n), WEBSITE_STATUS_LIMITS.max_receipt_cache_ttl_ms);
}

function _safeIso(value) {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function _cleanReceiptId(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s.length < 6 || s.length > WEBSITE_STATUS_LIMITS.max_receipt_id_chars) return null;
  if (!RECEIPT_ID_RE.test(s)) return null;
  return s;
}

function _receiptIdForRow(row) {
  if (!row || typeof row !== 'object') return null;
  return _cleanReceiptId(row.receipt_id)
    || _cleanReceiptId(row.receipt && row.receipt.receipt_id)
    || _cleanReceiptId(row.id);
}

// Derive per-component status from cheap in-process liveness. A probe that
// throws degrades exactly one component; nothing is faked operational.
export function probeComponents(deps = {}, opts = {}) {
  const updated_at = _now(opts);
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

  out.push({ id: 'gateway', name: 'Gateway', status: COMPONENT_OK, updated_at, contract_version: WEBSITE_STATUS_CONTRACT_VERSION });

  // auth/signing: signer loadable.
  let signerOk = false;
  if (typeof deps.loadSigner === 'function') {
    try {
      signerOk = Boolean(deps.loadSigner());
    } catch (_) {
      signerOk = false;
    }
  }
  out.push({
    id: 'signing',
    name: 'Receipt signing',
    status: signerOk ? COMPONENT_OK : COMPONENT_DEGRADED,
    updated_at,
    contract_version: WEBSITE_STATUS_CONTRACT_VERSION,
  });

  out.push({
    id: 'storage',
    name: 'Storage',
    status: storageOk ? COMPONENT_OK : COMPONENT_DEGRADED,
    updated_at,
    contract_version: WEBSITE_STATUS_CONTRACT_VERSION,
  });

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

export function statusSummary(deps = {}, opts = {}) {
  const components = probeComponents(deps, opts);
  const status = overallIndicator(components);
  return {
    ok: true,
    version: WEBSITE_STATUS_VERSION,
    contract_version: WEBSITE_STATUS_CONTRACT_VERSION,
    page: { id: 'kolm', name: 'kolm.ai', url: 'https://kolm.ai/status', updated_at: _now(opts) },
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
  const ttlMs = _normalizedTtlMs(opts.ttlMs ?? opts.ttl_ms);
  const now = _nowMs(opts);
  if (_receiptCache.value && now - _receiptCache.at < ttlMs) return _receiptCache.value;

  let total = 0;
  let last24h = 0;
  let lastId = null;
  let lastAt = null;
  try {
    const rawRows = deps.store && typeof deps.store.all === 'function' ? deps.store.all('observations') : [];
    const rows = (Array.isArray(rawRows) ? rawRows : []).slice(0, WEBSITE_STATUS_LIMITS.max_receipt_scan_rows);
    const dayAgo = now - 24 * 60 * 60 * 1000;
    for (const row of rows || []) {
      const rid = _receiptIdForRow(row);
      if (!rid) continue;
      total++;
      const ts = _safeIso(row.created_at || row.ts || row.at || row.timestamp);
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
    version: WEBSITE_STATUS_VERSION,
    contract_version: WEBSITE_STATUS_CONTRACT_VERSION,
    total,
    last_24h: last24h,
    last_receipt_id: lastId,
    last_receipt_at: lastAt,
    verify_url: lastId ? `/v1/verify/${encodeURIComponent(lastId)}` : null,
    scanned_row_limit: WEBSITE_STATUS_LIMITS.max_receipt_scan_rows,
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
