// scripts/load-test-scenarios/all-providers-down.js
//
// Scenario: simulate every upstream provider being unreachable, and assert the
// gateway degrades cleanly (queued receipt OR 503 all_providers_down with
// retry_after) rather than 500-crashing or hanging.
//
// Limitations of in-prod simulation:
//   - We CANNOT actually take Anthropic, OpenAI, etc. offline. Instead we send
//     a test-only header `X-Kolm-Test-Force-Provider-Outage: true`. The
//     gateway MUST:
//       * In test environments (KOLM_ENV=test|dev|staging): honor the header
//         and short-circuit upstream calls to simulate the outage.
//       * In production: REJECT the header (treat as if absent) — production
//         must never be talked out of calling its real providers by an
//         attacker.
//   - The gateway-side change to honor / reject this header is a SEPARATE
//     follow-up (see docs/operations/load-testing.md "Gateway TODO"). Until
//     the hook lands, this scenario will SKIP on production targets.
//
// Acceptance (when the hook is wired and active):
//   - Response is one of:
//       a) 2xx with body containing capture_eligible:true (the request was
//          accepted and queued — operator will replay once a provider returns),
//          OR
//       b) 503 with body { error_code: 'all_providers_down', retry_after: <int> }
//   - Anything else (500, hang, malformed body) is a FAIL.

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const PATH = '/v1/gateway/dispatch';
const TEST_HEADER = 'X-Kolm-Test-Force-Provider-Outage';
const PER_REQUEST_TIMEOUT_MS = 15_000;

function isProdBase(base) {
  try {
    const u = new URL(base);
    return /(^|\.)kolm\.ai$/i.test(u.hostname);
  } catch (_) { return false; }
}

function postOnce(baseUrl, bearer, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(PATH, baseUrl); }
    catch (err) { return resolve({ ok: false, error: 'bad_base_url: ' + err.message, elapsed_ms: 0, status: 0 }); }

    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
    const headers = {
      'content-type': 'application/json',
      'content-length': payload.length,
      'user-agent': 'kolm-load-test/all-providers-down',
      [TEST_HEADER]: 'true',
    };
    if (bearer) headers.authorization = 'Bearer ' + bearer;

    const opts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      method: 'POST',
      path: u.pathname + (u.search || ''),
      headers,
    };

    const t0 = process.hrtime.bigint();
    let bodyText = '';
    const req = lib.request(opts, (res) => {
      res.on('data', (chunk) => { bodyText += chunk.toString('utf8'); });
      res.on('end', () => {
        const elapsed_ms = Number(process.hrtime.bigint() - t0) / 1e6;
        let json = null;
        try { json = JSON.parse(bodyText); } catch (_) { /* non-json body */ }
        resolve({ status: res.statusCode, elapsed_ms, body_json: json });
      });
    });
    req.on('error', (err) => {
      const elapsed_ms = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ ok: false, error: err.code || err.message, elapsed_ms, status: 0 });
    });
    req.setTimeout(PER_REQUEST_TIMEOUT_MS, () => { req.destroy(new Error('client_timeout_15s')); });
    req.write(payload);
    req.end();
  });
}

async function run(ctx) {
  const body = { model: 'auto', messages: [{ role: 'user', content: 'ping' }] };

  if (ctx.dry_run) {
    return {
      ok: true,
      skipped: true,
      reason: 'dry-run: would POST with ' + TEST_HEADER + ': true to ' + ctx.base + PATH,
      metrics: { requests_sent: 0 },
      assertions: [],
      errors: [],
    };
  }

  if (isProdBase(ctx.base)) {
    // The gateway hook may not yet be live in production. The scenario does
    // not silently force traffic in that case — operator must explicitly
    // override via KOLM_FORCE_PROVIDER_OUTAGE_ON_PROD=true once the gateway
    // side reliably honors the header for test traffic only.
    if (process.env.KOLM_FORCE_PROVIDER_OUTAGE_ON_PROD !== 'true') {
      return {
        ok: true,
        skipped: true,
        reason: 'prod target detected; gateway hook for ' + TEST_HEADER +
                ' not confirmed. Set KOLM_FORCE_PROVIDER_OUTAGE_ON_PROD=true to override.',
        metrics: { requests_sent: 0 },
        assertions: [],
        errors: [],
      };
    }
  }

  const r = await postOnce(ctx.base, ctx.bearer, body);

  const json = r.body_json || {};
  const captureEligible = (r.status >= 200 && r.status < 300) && (json.capture_eligible === true);
  const clean503 = (r.status === 503)
    && (json.error_code === 'all_providers_down')
    && (typeof json.retry_after === 'number' || typeof json.retry_after === 'string');

  const assertions = [
    {
      label: 'queued receipt (2xx capture_eligible:true) OR 503 all_providers_down + retry_after',
      pass: captureEligible || clean503,
      observed: { status: r.status, capture_eligible: !!json.capture_eligible, error_code: json.error_code, retry_after: json.retry_after },
    },
    {
      label: 'not a 500-class crash',
      pass: !(r.status >= 500 && r.status !== 503),
      observed: r.status,
    },
  ];
  const ok = assertions.every((a) => a.pass);
  const errors = r.error ? [r.error] : [];

  return {
    ok,
    skipped: false,
    metrics: {
      requests_sent: 1,
      requests_success: captureEligible ? 1 : 0,
      requests_429: r.status === 429 ? 1 : 0,
      requests_5xx: (r.status >= 500 && r.status < 600) ? 1 : 0,
      latency_p50_ms: r.elapsed_ms,
      latency_p95_ms: r.elapsed_ms,
      latency_max_ms: r.elapsed_ms,
      response_status: r.status,
      capture_eligible: !!json.capture_eligible,
      retry_after: json.retry_after,
    },
    assertions,
    errors,
  };
}

export default run;
export { run };
