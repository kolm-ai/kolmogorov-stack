// tools/edge/cloudflare-worker.js
//
// W780-3 -- Cloudflare Workers adapter for the kolm.ai multi-region
// gateway. This is a STARTER TEMPLATE -- drop into a Cloudflare Workers
// project, wire the gateway map via wrangler vars / secrets, and deploy
// behind us.kolm.ai / eu.kolm.ai / ap.kolm.ai.
//
// Honesty contract:
//   - When the request carries a residency_requirement header
//     (x-kolm-residency: eu|us|apac) we route to the matching region or
//     return 451 (Unavailable For Legal Reasons) with an honest envelope
//     listing the available_regions. We NEVER silently downgrade.
//   - When the gateway map is empty we return 503 with
//     error='region_not_configured' (not a synthesized happy path).
//   - We DO NOT modify the request body -- only the URL is rewritten.
//     A capture sent to the EU worker stays an EU capture in transit.
//
// Wiring (wrangler.toml fragment):
//   [vars]
//   KOLM_REGION = "eu-west-1"
//   KOLM_REGION_GATEWAY_URLS = '{"us":"https://us.kolm.ai","eu":"https://eu.kolm.ai","apac":"https://ap.kolm.ai"}'
//
// Deploy steps:
//   1) Create a Cloudflare Workers project (npx wrangler init).
//   2) Replace src/index.js with this file.
//   3) Add the [vars] block above to wrangler.toml.
//   4) Map the worker route to us.kolm.ai/* (or the matching region).
//   5) npx wrangler deploy.
//
// CANONICAL_REGIONS keeps the short<->long mapping aligned with
// src/multi-region.js. Keep both in sync when adding a region.

const CANONICAL_REGIONS = {
  us:   { canonical: 'us-east-1',      display_name: 'United States (East)' },
  eu:   { canonical: 'eu-west-1',      display_name: 'European Union (West)' },
  apac: { canonical: 'ap-southeast-1', display_name: 'Asia Pacific (Singapore)' },
};

function parseGatewayMap(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const k of Object.keys(parsed)) {
      const v = parsed[k];
      if (typeof v === 'string' && v.length > 0) out[k.toLowerCase()] = v;
    }
    return out;
  } catch (_e) {
    return {};
  }
}

function resolveShort(input) {
  if (!input || typeof input !== 'string') return null;
  const norm = input.trim().toLowerCase();
  if (norm.length === 0) return null;
  if (Object.prototype.hasOwnProperty.call(CANONICAL_REGIONS, norm)) return norm;
  for (const sn of Object.keys(CANONICAL_REGIONS)) {
    if (CANONICAL_REGIONS[sn].canonical === norm) return sn;
  }
  if (/^us-/.test(norm)) return 'us';
  if (/^eu-/.test(norm)) return 'eu';
  if (/^ap-/.test(norm)) return 'apac';
  return null;
}

function chooseGateway({ gateways, residency_requirement, prefer_region, current_region }) {
  const available = Object.keys(gateways);
  if (available.length === 0) {
    return {
      ok: false,
      status: 503,
      envelope: {
        ok: false,
        error: 'region_not_configured',
        hint: 'Set KOLM_REGION and KOLM_REGION_GATEWAY_URLS in wrangler.toml',
        version: 'w780-v1',
      },
    };
  }
  // (1) hard constraint
  if (residency_requirement) {
    const sn = resolveShort(residency_requirement);
    if (!sn || !gateways[sn]) {
      return {
        ok: false,
        status: 451,
        envelope: {
          ok: false,
          error: 'no_gateway_for_residency_requirement',
          requirement: residency_requirement,
          available_regions: available,
          hint: 'add a "' + (sn || residency_requirement) + '" entry to KOLM_REGION_GATEWAY_URLS',
          version: 'w780-v1',
        },
      };
    }
    return { ok: true, region: sn, url: gateways[sn], reason: 'residency_requirement' };
  }
  // (2) prefer hint
  if (prefer_region) {
    const sn = resolveShort(prefer_region);
    if (sn && gateways[sn]) {
      return { ok: true, region: sn, url: gateways[sn], reason: 'prefer_region' };
    }
  }
  // (3) current region
  if (current_region) {
    const sn = resolveShort(current_region);
    if (sn && gateways[sn]) {
      return { ok: true, region: sn, url: gateways[sn], reason: 'current_region' };
    }
  }
  // (4) first available
  const first = available[0];
  return { ok: true, region: first, url: gateways[first], reason: 'first_configured_gateway' };
}

export default {
  async fetch(request, env, ctx) {
    void ctx;
    const url = new URL(request.url);
    const gateways = parseGatewayMap(env.KOLM_REGION_GATEWAY_URLS || '');
    const current_region = env.KOLM_REGION || 'us-east-1';
    const residency_requirement = request.headers.get('x-kolm-residency') || null;
    const prefer_region = request.headers.get('x-kolm-prefer-region') || null;
    const decision = chooseGateway({
      gateways,
      residency_requirement,
      prefer_region,
      current_region,
    });
    if (!decision.ok) {
      return new Response(JSON.stringify(decision.envelope), {
        status: decision.status,
        headers: { 'content-type': 'application/json', 'x-kolm-region': 'unrouted' },
      });
    }
    const upstream = new URL(decision.url.replace(/\/$/, '') + url.pathname + url.search);
    // Defensive: preserve method, headers, and body -- never mutate the
    // capture payload. We add an x-kolm-routed-region header so the
    // downstream daemon can log the decision.
    const proxied = new Request(upstream.toString(), {
      method: request.method,
      headers: new Headers(request.headers),
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
    proxied.headers.set('x-kolm-routed-region', decision.region);
    proxied.headers.set('x-kolm-routed-reason', decision.reason);
    const resp = await fetch(proxied);
    const out = new Response(resp.body, resp);
    out.headers.set('x-kolm-routed-region', decision.region);
    out.headers.set('x-kolm-routed-reason', decision.reason);
    return out;
  },
};
