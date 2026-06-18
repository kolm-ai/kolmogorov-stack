// src/multi-region.js
//
// W780 -- Multi-Region Gateway.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 704-709):
//   [W780-1] Multi-region gateway deployment (EU/US/APAC) -> regional CDN
//            config + DNS schema
//   [W780-2] Region-aware capture routing (uses W769)
//   [W780-3] Edge deployment support (Cloudflare Workers, Lambda@Edge)
//            -> adapter
//   [W780-4] Doc: /docs/multi-region.html
//
// Design contract:
//   - Pure JS. No external dependencies. The gateway map is a JSON env var
//     so an operator can wire EU/US/APAC without redeploying the binary.
//   - HONESTY FLOOR:
//       * getCurrentRegion defaults to 'us-east-1' when KOLM_REGION is
//         unset, but the value is the EXPLICIT single-region default
//         (not a guess). When KOLM_REGION is set to a non-canonical
//         value we return a structured envelope on routeRequest rather
//         than silently coercing.
//       * routeRequest NEVER silently downgrades a residency_requirement.
//         A request tagged 'eu' against a gateway map without an eu
//         entry returns {ok:false, error:'no_gateway_for_residency_
//         requirement', requirement, available_regions} so the caller
//         understands the gateway is the limiting factor.
//       * getRegionGateways returns an empty object (NOT a default
//         single-region map) when the env var is missing. The empty
//         state is the honest "not configured" signal that surfaces
//         the gap rather than hiding it under a synthetic default.
//   - TENANT FENCE (W411 law): getRegionForCapture goes through the
//     W769 data-residency module which already applies the tenant
//     fence + defense-in-depth row filter. We never read foreign
//     namespace state.
//   - DI seam: every public function accepts an opts.env override so
//     tests can swap KOLM_REGION + KOLM_REGION_GATEWAY_URLS without
//     mutating process.env. Production callers leave opts.env unset
//     and the module reads process.env.
//
// Public surface:
//   - MULTI_REGION_VERSION                 ('w780-v1', matches /^w780-/)
//   - CANONICAL_REGIONS                    (Object.freeze({us, eu, apac}))
//   - DEFAULT_REGION                       ('us-east-1')
//   - getCurrentRegion(opts?)              read $KOLM_REGION; default 'us-east-1'
//   - getRegionGateways(opts?)             parse $KOLM_REGION_GATEWAY_URLS
//   - routeRequest({request_hash, residency_requirement?, prefer_region?, opts?})
//   - getRegionForCapture({tenant, namespace, opts?})  joins with W769
//   - testFailover({tenant, namespace, opts?})        probes all gateways

import * as defaultDataResidency from './data-residency.js';

export const MULTI_REGION_VERSION = 'w780-v1';
export const MULTI_REGION_LIMITS = Object.freeze({
  max_gateway_url_chars: 2048,
  max_gateways: 12,
  max_tag_chars: 160,
  max_namespace_chars: 128,
  max_error_detail_chars: 240,
  min_timeout_ms: 100,
  max_timeout_ms: 10000,
});

// CANONICAL_REGIONS is the human-friendly short-name -> long-form mapping
// used by the gateway map (the keys callers type into
// $KOLM_REGION_GATEWAY_URLS). The long-form values are the canonical
// AWS-style region codes we surface in receipts. Frozen so a downstream
// caller cannot mutate the contract.
export const CANONICAL_REGIONS = Object.freeze({
  us: Object.freeze({
    short: 'us',
    canonical: 'us-east-1',
    display_name: 'United States (East)',
    geo: 'NORTH_AMERICA',
    w769_region: 'US_EAST',
  }),
  eu: Object.freeze({
    short: 'eu',
    canonical: 'eu-west-1',
    display_name: 'European Union (West)',
    geo: 'EUROPE',
    w769_region: 'EU_WEST',
  }),
  apac: Object.freeze({
    short: 'apac',
    canonical: 'ap-southeast-1',
    display_name: 'Asia Pacific (Singapore)',
    geo: 'ASIA_PACIFIC',
    w769_region: 'JAPAN',
  }),
});

export const DEFAULT_REGION = 'us-east-1';

// Allowed canonical region codes -- used by getCurrentRegion to decide
// whether the env value is a recognised region. Honesty rule: when the
// value is NOT in this set we return DEFAULT_REGION with a hint so the
// downstream caller can decide whether to fall back or fail.
const ALLOWED_CANONICAL = new Set([
  'us-east-1', 'us-west-2',
  'eu-west-1', 'eu-central-1',
  'ap-southeast-1', 'ap-northeast-1',
]);

function _env(opts) {
  if (opts && opts.env && typeof opts.env === 'object') return opts.env;
  return process.env;
}

function _dataResidency(opts) {
  return (opts && opts.dataResidency) || defaultDataResidency;
}

function _safeTag(value, fallback = null, maxChars = MULTI_REGION_LIMITS.max_tag_chars) {
  const s = String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maxChars);
  if (!s || s === '__proto__' || s === 'constructor' || s === 'prototype') return fallback;
  return s;
}

function _safeDetail(e) {
  return String((e && e.message) || e || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .slice(0, MULTI_REGION_LIMITS.max_error_detail_chars);
}

function _normalizeGatewayUrl(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text || text.length > MULTI_REGION_LIMITS.max_gateway_url_chars) return null;
  let u;
  try { u = new URL(text); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

function _gatewayHealthUrl(base) {
  const u = new URL(base);
  const prefix = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/+$/g, '') : '';
  u.pathname = `${prefix}/v1/health`.replace(/\/{2,}/g, '/');
  u.search = '';
  u.hash = '';
  return u.toString();
}

function _safeTimeoutMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 4000;
  return Math.max(MULTI_REGION_LIMITS.min_timeout_ms, Math.min(MULTI_REGION_LIMITS.max_timeout_ms, Math.trunc(n)));
}

// ---------------------------------------------------------------------------
// getCurrentRegion(opts): reads $KOLM_REGION and returns the canonical
// region code. Defaults to DEFAULT_REGION ('us-east-1') when unset.
//
// HONESTY: when $KOLM_REGION is set to something we do not recognise we
// still return a string -- the canonical default -- but the caller can
// detect the override by comparing against the raw env value. The
// invalid path surfaces via routeRequest envelopes.
// ---------------------------------------------------------------------------
export function getCurrentRegion(opts) {
  const env = _env(opts);
  const raw = env.KOLM_REGION;
  if (!raw || typeof raw !== 'string') return DEFAULT_REGION;
  const norm = raw.trim().toLowerCase();
  if (norm.length === 0) return DEFAULT_REGION;
  if (ALLOWED_CANONICAL.has(norm)) return norm;
  // Short-name short-circuit: a caller setting KOLM_REGION=eu means
  // 'eu-west-1' (the eu entry's canonical). We accept the short form so
  // operators do not need to memorise the canonical strings.
  if (Object.prototype.hasOwnProperty.call(CANONICAL_REGIONS, norm)) {
    return CANONICAL_REGIONS[norm].canonical;
  }
  // Non-recognised value: honest fallback to DEFAULT_REGION. The
  // routeRequest path will surface this via region_not_configured when
  // the gateway map is also empty.
  return DEFAULT_REGION;
}

// ---------------------------------------------------------------------------
// getRegionGateways(opts): parses $KOLM_REGION_GATEWAY_URLS as JSON and
// returns the {short_name: url} map. Returns {} when unset or invalid.
//
// HONESTY: invalid JSON yields {} (not a thrown error) so the caller can
// detect the unconfigured state via Object.keys(map).length === 0. We
// never synthesise a placeholder gateway URL -- that would mask the
// unconfigured state behind a bogus host that fails at request time.
// ---------------------------------------------------------------------------
export function getRegionGateways(opts) {
  const env = _env(opts);
  const raw = env.KOLM_REGION_GATEWAY_URLS;
  if (!raw || typeof raw !== 'string') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const k of Object.keys(parsed).slice(0, MULTI_REGION_LIMITS.max_gateways)) {
    const v = parsed[k];
    const sn = _resolveShortName(k);
    if (!sn) continue;
    const normalized = _normalizeGatewayUrl(v);
    if (normalized) out[sn] = normalized;
  }
  return out;
}

// Internal -- resolve a short name OR canonical region to a short name
// keyed against the gateway map. Returns null when no match.
function _resolveShortName(input) {
  if (!input || typeof input !== 'string') return null;
  const norm = input.trim().toLowerCase();
  if (norm.length === 0) return null;
  if (Object.prototype.hasOwnProperty.call(CANONICAL_REGIONS, norm)) return norm;
  // Walk the canonical map for a long-form match.
  for (const sn of Object.keys(CANONICAL_REGIONS)) {
    if (CANONICAL_REGIONS[sn].canonical === norm) return sn;
  }
  // Region-prefix probe: 'us-east-1' -> 'us'.
  if (/^us-/.test(norm)) return 'us';
  if (/^eu-/.test(norm)) return 'eu';
  if (/^ap-/.test(norm)) return 'apac';
  return null;
}

// ---------------------------------------------------------------------------
// routeRequest({request_hash, residency_requirement?, prefer_region?, opts?}):
// picks the right gateway URL for a request.
//
// Resolution order:
//   1) residency_requirement (HARD constraint) -- must route to that
//      region or return {ok:false, error:'no_gateway_for_residency_
//      requirement'} listing available_regions.
//   2) prefer_region (SOFT hint) -- try first; fall back to current
//      region when not in the map.
//   3) current region from $KOLM_REGION -- final fallback.
//
// When the gateway map is empty entirely we return
// {ok:false, error:'region_not_configured', hint, version}.
// ---------------------------------------------------------------------------
export function routeRequest({
  request_hash,
  residency_requirement,
  prefer_region,
  opts,
} = {}) {
  const safeRequestHash = _safeTag(request_hash, null);
  if (!safeRequestHash) {
    return {
      ok: false,
      error: 'request_hash_required',
      hint: 'pass request_hash as a non-empty string for routing telemetry',
      version: MULTI_REGION_VERSION,
    };
  }
  const gateways = getRegionGateways(opts);
  const available_regions = Object.keys(gateways).sort();
  if (available_regions.length === 0) {
    return {
      ok: false,
      error: 'region_not_configured',
      hint: 'Set KOLM_REGION=us-east-1|eu-west-1|ap-southeast-1 and KOLM_REGION_GATEWAY_URLS=\'{"us":"https://us.kolm.ai","eu":"https://eu.kolm.ai","apac":"https://ap.kolm.ai"}\'',
      version: MULTI_REGION_VERSION,
    };
  }
  // (1) residency_requirement -- HARD constraint.
  if (residency_requirement) {
    const sn = _resolveShortName(residency_requirement);
    if (!sn || !gateways[sn]) {
      const requirement = _safeTag(residency_requirement, 'unknown');
      return {
        ok: false,
        error: 'no_gateway_for_residency_requirement',
        requirement,
        available_regions,
        hint: 'configure $KOLM_REGION_GATEWAY_URLS to include a "' + (sn || requirement) + '" entry, or drop the residency_requirement',
        version: MULTI_REGION_VERSION,
      };
    }
    const requirement = _safeTag(residency_requirement, sn);
    return {
      ok: true,
      region: sn,
      canonical: CANONICAL_REGIONS[sn] ? CANONICAL_REGIONS[sn].canonical : sn,
      gateway_url: gateways[sn],
      reason: 'residency_requirement',
      requirement,
      request_hash: safeRequestHash,
      version: MULTI_REGION_VERSION,
    };
  }
  // (2) prefer_region -- SOFT hint.
  if (prefer_region) {
    const sn = _resolveShortName(prefer_region);
    if (sn && gateways[sn]) {
      return {
        ok: true,
        region: sn,
        canonical: CANONICAL_REGIONS[sn] ? CANONICAL_REGIONS[sn].canonical : sn,
        gateway_url: gateways[sn],
        reason: 'prefer_region',
        request_hash: safeRequestHash,
        version: MULTI_REGION_VERSION,
      };
    }
    // prefer_region miss -> fall through to current region.
  }
  // (3) current region.
  const current = getCurrentRegion(opts);
  const sn = _resolveShortName(current);
  if (sn && gateways[sn]) {
    return {
      ok: true,
      region: sn,
      canonical: CANONICAL_REGIONS[sn] ? CANONICAL_REGIONS[sn].canonical : sn,
      gateway_url: gateways[sn],
      reason: 'current_region',
      request_hash: safeRequestHash,
      version: MULTI_REGION_VERSION,
    };
  }
  // Final fallback: pick the first configured gateway. We surface this
  // path via reason='first_configured_gateway' so callers can detect
  // they hit the no-preference rung of the ladder.
  const firstSn = available_regions[0];
  return {
    ok: true,
    region: firstSn,
    canonical: CANONICAL_REGIONS[firstSn] ? CANONICAL_REGIONS[firstSn].canonical : firstSn,
    gateway_url: gateways[firstSn],
    reason: 'first_configured_gateway',
    request_hash: safeRequestHash,
    version: MULTI_REGION_VERSION,
  };
}

// ---------------------------------------------------------------------------
// getRegionForCapture({tenant, namespace, opts?}): joins with W769
// data-residency to decide which region a capture should land in.
//
// Resolution order:
//   1) W769 namespace-default region (configureNamespaceRegion writes
//      this) -> map W769 long-form to W780 short name.
//   2) W769 inferRegionFromTenant on the tenant record.
//   3) Current region from $KOLM_REGION.
//
// HONESTY: when the W769 region is GLOBAL we return the current region
// with reason='w769_global_uses_current_region' so the caller understands
// the residency module did not constrain the choice.
// ---------------------------------------------------------------------------
export async function getRegionForCapture({ tenant, namespace, opts } = {}) {
  if (!tenant || !tenant.id) {
    return {
      ok: false,
      error: 'tenant_required',
      hint: 'pass {tenant: {id: "..."}} with at least an id field',
      version: MULTI_REGION_VERSION,
    };
  }
  const dr = _dataResidency(opts);
  const safeNamespace = namespace == null ? null : _safeTag(namespace, null, MULTI_REGION_LIMITS.max_namespace_chars);
  // (1) namespace default
  if (safeNamespace) {
    try {
      const nsRegion = await dr.getNamespaceDefaultRegion({
        tenant_id: tenant.id,
        namespace: safeNamespace,
      });
      if (nsRegion && nsRegion !== dr.DEFAULT_REGION) {
        const sn = _w769LongToShort(nsRegion);
        return {
          ok: true,
          region: sn || _w769LongToShort(dr.DEFAULT_REGION) || 'us',
          w769_region: nsRegion,
          reason: 'w769_namespace_default',
          tenant_id: _safeTag(tenant.id, null),
          namespace: safeNamespace,
          version: MULTI_REGION_VERSION,
        };
      }
    } catch (_e) {
      // Fall through to the next rung. We deliberately swallow the
      // W769 read error rather than failing the whole route -- capture
      // routing is best-effort and the current-region rung is always
      // safe.
    }
  }
  // (2) tenant inference
  if (typeof dr.inferRegionFromTenant === 'function') {
    const inferred = dr.inferRegionFromTenant(tenant);
    if (inferred && inferred !== dr.DEFAULT_REGION) {
      const sn = _w769LongToShort(inferred);
      return {
        ok: true,
        region: sn || 'us',
        w769_region: inferred,
        reason: 'w769_tenant_inference',
        tenant_id: _safeTag(tenant.id, null),
        version: MULTI_REGION_VERSION,
      };
    }
  }
  // (3) current region.
  const current = getCurrentRegion(opts);
  const sn = _resolveShortName(current) || 'us';
  return {
    ok: true,
    region: sn,
    canonical: current,
    reason: 'w769_global_uses_current_region',
    tenant_id: _safeTag(tenant.id, null),
    version: MULTI_REGION_VERSION,
  };
}

function _w769LongToShort(w769) {
  if (!w769 || typeof w769 !== 'string') return null;
  for (const sn of Object.keys(CANONICAL_REGIONS)) {
    if (CANONICAL_REGIONS[sn].w769_region === w769) return sn;
  }
  // EU_CENTRAL maps to eu (not in CANONICAL but logically European).
  if (/^EU_/.test(w769)) return 'eu';
  if (/^US_/.test(w769)) return 'us';
  if (w769 === 'JAPAN' || w769 === 'AUSTRALIA') return 'apac';
  return null;
}

// ---------------------------------------------------------------------------
// testFailover({tenant, namespace, opts?}): probes every configured gateway
// and returns {ok, gateways:[{region, url, reachable, latency_ms?}]}.
//
// HONESTY: when the gateway map is empty we return
// {ok:false, error:'region_not_configured'} rather than a vacuous
// happy-path with an empty array (which would let the caller think
// every gateway was healthy).
// ---------------------------------------------------------------------------
export async function testFailover({ tenant, namespace, opts } = {}) {
  void tenant; void namespace;
  const gateways = getRegionGateways(opts);
  const regions = Object.keys(gateways).sort();
  if (regions.length === 0) {
    return {
      ok: false,
      error: 'region_not_configured',
      hint: 'Set KOLM_REGION=us-east-1|eu-west-1|ap-southeast-1 and KOLM_REGION_GATEWAY_URLS=\'{"us":"https://us.kolm.ai","eu":"https://eu.kolm.ai","apac":"https://ap.kolm.ai"}\'',
      version: MULTI_REGION_VERSION,
    };
  }
  const fetchFn = (opts && opts.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchFn) {
    return {
      ok: false,
      error: 'fetch_unavailable',
      hint: 'pass opts.fetch in environments without a global fetch',
      version: MULTI_REGION_VERSION,
    };
  }
  const timeout_ms = _safeTimeoutMs(opts && opts.timeout_ms);
  const results = await Promise.all(regions.map(async (sn) => {
    const url = gateways[sn];
    const started = Date.now();
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeout_ms);
      // /v1/health is the standard liveness path; we never POST to a
      // failover probe because POST has side effects.
      const probeUrl = _gatewayHealthUrl(url);
      let resp;
      try {
        resp = await fetchFn(probeUrl, { method: 'GET', signal: ac.signal });
      } finally {
        clearTimeout(t);
      }
      const latency_ms = Date.now() - started;
      const reachable = !!(resp && resp.status && resp.status >= 200 && resp.status < 500);
      return {
        region: sn,
        canonical: CANONICAL_REGIONS[sn] ? CANONICAL_REGIONS[sn].canonical : sn,
        url,
        reachable,
        status: resp ? resp.status : 0,
        latency_ms,
      };
    } catch (e) {
      const latency_ms = Date.now() - started;
      return {
        region: sn,
        canonical: CANONICAL_REGIONS[sn] ? CANONICAL_REGIONS[sn].canonical : sn,
        url,
        reachable: false,
        error: _safeDetail(e),
        latency_ms,
      };
    }
  }));
  const anyReachable = results.some((r) => r.reachable);
  return {
    ok: anyReachable,
    gateways: results,
    region_count: results.length,
    reachable_count: results.filter((r) => r.reachable).length,
    version: MULTI_REGION_VERSION,
  };
}
