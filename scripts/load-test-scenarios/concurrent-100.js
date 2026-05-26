// scripts/load-test-scenarios/concurrent-100.js
//
// Scenario: 100 parallel POSTs to /v1/gateway/dispatch.
//
// Acceptance:
//   - success_rate >= 95 %
//   - p95 latency  <= 3000 ms
//
// Body shape mirrors the gateway dispatch contract:
//   { model: 'auto', messages: [{ role: 'user', content: 'ping' }] }
//
// Pure node:http / node:https — no third-party deps.

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const CONCURRENCY = 100;
const PATH = '/v1/gateway/dispatch';

function percentile(arr, q) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)));
  return s[i];
}

function postOnce(baseUrl, bearer, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(PATH, baseUrl); }
    catch (err) { return resolve({ ok: false, error: 'bad_base_url: ' + err.message, elapsed_ms: 0 }); }

    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
    const headers = {
      'content-type': 'application/json',
      'content-length': payload.length,
      'user-agent': 'kolm-load-test/concurrent-100',
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
    const req = lib.request(opts, (res) => {
      let received = 0;
      res.on('data', (chunk) => { received += chunk.length; });
      res.on('end', () => {
        const elapsed_ms = Number(process.hrtime.bigint() - t0) / 1e6;
        resolve({ status: res.statusCode, elapsed_ms, bytes: received });
      });
    });
    req.on('error', (err) => {
      const elapsed_ms = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ ok: false, error: err.code || err.message, elapsed_ms });
    });
    // 30s per-request budget; matches typical gateway upstream timeout.
    req.setTimeout(30_000, () => { req.destroy(new Error('client_timeout')); });
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
      reason: 'dry-run: would POST ' + CONCURRENCY + ' parallel requests to ' + ctx.base + PATH,
      metrics: { requests_sent: 0, requests_success: 0, requests_429: 0, requests_5xx: 0 },
      assertions: [],
      errors: [],
    };
  }

  const tasks = [];
  for (let i = 0; i < CONCURRENCY; i++) tasks.push(postOnce(ctx.base, ctx.bearer, body));
  const out = await Promise.all(tasks);

  const latencies = [];
  let requests_success = 0;
  let requests_429 = 0;
  let requests_5xx = 0;
  const errors = [];
  for (const r of out) {
    if (typeof r.elapsed_ms === 'number') latencies.push(r.elapsed_ms);
    if (r.status >= 200 && r.status < 300) requests_success++;
    else if (r.status === 429) requests_429++;
    else if (r.status >= 500 && r.status < 600) requests_5xx++;
    if (r.error) errors.push(r.error);
  }

  const success_rate = out.length ? requests_success / out.length : 0;
  const p50 = percentile(latencies, 0.50);
  const p95 = percentile(latencies, 0.95);
  const max = latencies.length ? Math.max.apply(null, latencies) : null;

  const assertions = [
    { label: 'success_rate >= 0.95', pass: success_rate >= 0.95, observed: success_rate },
    { label: 'p95_latency_ms <= 3000', pass: (p95 !== null) && (p95 <= 3000), observed: p95 },
  ];
  const ok = assertions.every((a) => a.pass);

  return {
    ok,
    skipped: false,
    metrics: {
      requests_sent: out.length,
      requests_success,
      requests_429,
      requests_5xx,
      latency_p50_ms: p50,
      latency_p95_ms: p95,
      latency_max_ms: max,
      success_rate,
    },
    assertions,
    errors,
  };
}

export default run;
export { run };
