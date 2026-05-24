// tools/edge/lambda-at-edge.js
//
// W780-3 -- AWS Lambda@Edge adapter for the kolm.ai multi-region gateway.
// This is a STARTER TEMPLATE -- attach to a CloudFront distribution as a
// viewer-request trigger so the routing decision lands at the edge POP
// closest to the user.
//
// Honesty contract:
//   - When the request carries a residency_requirement header
//     (x-kolm-residency: eu|us|apac) we route to the matching origin or
//     return 451 (Unavailable For Legal Reasons) with an honest envelope
//     listing the available_regions. We NEVER silently downgrade.
//   - When the gateway map is empty we return 503 with
//     error='region_not_configured'.
//   - We DO NOT mutate the body -- only the request.origin block is
//     rewritten so CloudFront forwards to the correct backend.
//
// Lambda@Edge config notes:
//   - Lambda@Edge does NOT support env vars. The gateway map must be
//     baked into the deployment OR read from a CloudFront origin custom
//     header at invocation time. The template below reads from
//     environment variables for local testing AND falls back to a
//     hard-coded GATEWAY_MAP constant for production deployment.
//   - Choose viewer-request as the CloudFront trigger so the decision
//     happens BEFORE the cache lookup. Origin-request triggers fire
//     after the cache and cannot redirect to a different origin.
//   - Node 18 runtime minimum (fetch is not available pre-18, but this
//     adapter does not need fetch -- it rewrites the request).
//
// CANONICAL_REGIONS keeps the short<->long mapping aligned with
// src/multi-region.js. Keep both in sync when adding a region.

const CANONICAL_REGIONS = {
  us:   { canonical: 'us-east-1',      display_name: 'United States (East)' },
  eu:   { canonical: 'eu-west-1',      display_name: 'European Union (West)' },
  apac: { canonical: 'ap-southeast-1', display_name: 'Asia Pacific (Singapore)' },
};

// PRODUCTION DEPLOY: bake the gateway map into this constant. Lambda@Edge
// does not support env vars at execution time, so the live deploy reads
// from this object. Local tests read from process.env so the same handler
// can be exercised in node --test.
const GATEWAY_MAP = {
  // us:   'https://us-origin.kolm.ai',
  // eu:   'https://eu-origin.kolm.ai',
  // apac: 'https://ap-origin.kolm.ai',
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

function resolveGatewayMap(env) {
  // Local-test path: env var wins.
  if (env && env.KOLM_REGION_GATEWAY_URLS) {
    return parseGatewayMap(env.KOLM_REGION_GATEWAY_URLS);
  }
  // Production path: baked-in constant.
  const out = {};
  for (const k of Object.keys(GATEWAY_MAP)) {
    const v = GATEWAY_MAP[k];
    if (typeof v === 'string' && v.length > 0) out[k.toLowerCase()] = v;
  }
  return out;
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
      status: '503',
      envelope: {
        ok: false,
        error: 'region_not_configured',
        hint: 'bake the gateway map into GATEWAY_MAP at deploy time (Lambda@Edge has no env vars at runtime)',
        version: 'w780-v1',
      },
    };
  }
  if (residency_requirement) {
    const sn = resolveShort(residency_requirement);
    if (!sn || !gateways[sn]) {
      return {
        ok: false,
        status: '451',
        envelope: {
          ok: false,
          error: 'no_gateway_for_residency_requirement',
          requirement: residency_requirement,
          available_regions: available,
          hint: 'redeploy the Lambda@Edge handler with a "' + (sn || residency_requirement) + '" entry in GATEWAY_MAP',
          version: 'w780-v1',
        },
      };
    }
    return { ok: true, region: sn, url: gateways[sn], reason: 'residency_requirement' };
  }
  if (prefer_region) {
    const sn = resolveShort(prefer_region);
    if (sn && gateways[sn]) {
      return { ok: true, region: sn, url: gateways[sn], reason: 'prefer_region' };
    }
  }
  if (current_region) {
    const sn = resolveShort(current_region);
    if (sn && gateways[sn]) {
      return { ok: true, region: sn, url: gateways[sn], reason: 'current_region' };
    }
  }
  const first = available[0];
  return { ok: true, region: first, url: gateways[first], reason: 'first_configured_gateway' };
}

function getHeader(request, name) {
  const headers = (request && request.headers) || {};
  const key = name.toLowerCase();
  if (!headers[key]) return null;
  const arr = headers[key];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[0].value || null;
}

// AWS Lambda@Edge viewer-request handler. The CloudFront event shape is
// documented at:
//   https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html
//
// We rewrite request.origin so CloudFront proxies to the chosen region's
// origin server. The return value MUST be the same request object (or a
// response object for the deny path).
export async function handler(event, context) {
  void context;
  const cf = (event && event.Records && event.Records[0] && event.Records[0].cf) || {};
  const request = cf.request || {};
  const gateways = resolveGatewayMap(process.env);
  const current_region = process.env.KOLM_REGION || 'us-east-1';
  const residency_requirement = getHeader(request, 'x-kolm-residency');
  const prefer_region = getHeader(request, 'x-kolm-prefer-region');
  const decision = chooseGateway({
    gateways,
    residency_requirement,
    prefer_region,
    current_region,
  });
  if (!decision.ok) {
    return {
      status: decision.status,
      statusDescription: decision.status === '451' ? 'Unavailable For Legal Reasons' : 'Service Unavailable',
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'application/json' }],
        'x-kolm-region': [{ key: 'X-Kolm-Region', value: 'unrouted' }],
      },
      body: JSON.stringify(decision.envelope),
    };
  }
  // Rewrite request.origin to point at the chosen gateway. The host
  // portion of decision.url becomes the custom origin domain. We strip
  // the protocol and trailing slash and split on first '/' to extract
  // the path prefix (if any).
  const m = decision.url.match(/^https?:\/\/([^/]+)(\/.*)?$/);
  if (!m) {
    return {
      status: '500',
      statusDescription: 'Internal Server Error',
      headers: { 'content-type': [{ key: 'Content-Type', value: 'application/json' }] },
      body: JSON.stringify({
        ok: false,
        error: 'invalid_gateway_url',
        url: decision.url,
        version: 'w780-v1',
      }),
    };
  }
  const domain = m[1];
  const pathPrefix = (m[2] || '').replace(/\/$/, '');
  request.origin = {
    custom: {
      domainName: domain,
      port: decision.url.startsWith('https://') ? 443 : 80,
      protocol: decision.url.startsWith('https://') ? 'https' : 'http',
      path: pathPrefix,
      sslProtocols: ['TLSv1.2'],
      readTimeout: 30,
      keepaliveTimeout: 5,
      customHeaders: {
        'x-kolm-routed-region': [{ key: 'X-Kolm-Routed-Region', value: decision.region }],
        'x-kolm-routed-reason': [{ key: 'X-Kolm-Routed-Reason', value: decision.reason }],
      },
    },
  };
  request.headers.host = [{ key: 'Host', value: domain }];
  return request;
}

// Exported for unit testing -- never invoked by CloudFront directly.
export const _internal = { CANONICAL_REGIONS, parseGatewayMap, resolveShort, chooseGateway };
