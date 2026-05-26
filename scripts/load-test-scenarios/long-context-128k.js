// scripts/load-test-scenarios/long-context-128k.js
//
// Scenario: single call with a 128K-token-equivalent prompt.
//
// We approximate 128K tokens with a ~500 KB string built by repeating a marker
// phrase. (Rough rule of thumb: ~4 bytes per token for English.) The test does
// NOT need to be tokenizer-exact; the point is to push past the limit any
// reasonable upstream will accept without truncation.
//
// Acceptance:
//   - response received within 60 s, AND one of:
//       a) HTTP 2xx (gateway and upstream handled the full context), OR
//       b) HTTP 413 or 422 with a `context_too_large` envelope (graceful
//          rejection — this is a PASS, not a FAIL).
//
// Reports:
//   ttft_ms          time from request send to first response byte
//   total_ms         time from request send to response end
//   response_status  HTTP status code
//
// Limitations of this scaffold:
//   - ttft_ms is approximated as time-to-first-data-chunk on the response
//     stream; for non-streaming endpoints it will be close to total_ms.
//   - "128K-token-equivalent" is a byte-count proxy, not a tokenizer count.

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const PATH = '/v1/gateway/dispatch';
const TARGET_BYTES = 500 * 1024; // ~128K tokens at ~4 bytes/token
const MARKER = 'The quick brown fox jumps over the lazy dog. ';
const PER_REQUEST_TIMEOUT_MS = 60_000;

function buildLargePrompt() {
  const reps = Math.ceil(TARGET_BYTES / MARKER.length);
  return MARKER.repeat(reps);
}

function postOnce(baseUrl, bearer, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(PATH, baseUrl); }
    catch (err) { return resolve({ ok: false, error: 'bad_base_url: ' + err.message, total_ms: 0, ttft_ms: 0, status: 0 }); }

    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
    const headers = {
      'content-type': 'application/json',
      'content-length': payload.length,
      'user-agent': 'kolm-load-test/long-context-128k',
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
    let firstByteAt = null;
    let bodyText = '';

    const req = lib.request(opts, (res) => {
      res.on('data', (chunk) => {
        if (firstByteAt === null) firstByteAt = process.hrtime.bigint();
        bodyText += chunk.toString('utf8');
      });
      res.on('end', () => {
        const tEnd = process.hrtime.bigint();
        const total_ms = Number(tEnd - t0) / 1e6;
        const ttft_ms = firstByteAt ? Number(firstByteAt - t0) / 1e6 : total_ms;
        let json = null;
        try { json = JSON.parse(bodyText); } catch (_) { /* non-json body */ }
        resolve({ status: res.statusCode, total_ms, ttft_ms, body_json: json });
      });
    });
    req.on('error', (err) => {
      const total_ms = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ ok: false, error: err.code || err.message, total_ms, ttft_ms: total_ms, status: 0 });
    });
    req.setTimeout(PER_REQUEST_TIMEOUT_MS, () => { req.destroy(new Error('client_timeout_60s')); });
    req.write(payload);
    req.end();
  });
}

async function run(ctx) {
  const prompt = buildLargePrompt();
  const body = { model: 'auto', messages: [{ role: 'user', content: prompt }] };

  if (ctx.dry_run) {
    return {
      ok: true,
      skipped: true,
      reason: 'dry-run: would POST ' + prompt.length + ' bytes (~128K tokens) to ' + ctx.base + PATH,
      metrics: { prompt_bytes: prompt.length, requests_sent: 0 },
      assertions: [],
      errors: [],
    };
  }

  const r = await postOnce(ctx.base, ctx.bearer, body);

  const withinBudget = r.total_ms <= PER_REQUEST_TIMEOUT_MS;
  const is2xx = r.status >= 200 && r.status < 300;
  const isGraceful413or422 = (r.status === 413 || r.status === 422)
    && r.body_json
    && (r.body_json.error_code === 'context_too_large' ||
        (typeof r.body_json.error === 'string' && r.body_json.error.indexOf('context_too_large') !== -1));

  const assertions = [
    { label: 'response within 60s', pass: withinBudget, observed: r.total_ms },
    { label: '2xx OR graceful 413/422 context_too_large', pass: is2xx || isGraceful413or422, observed: { status: r.status, graceful: isGraceful413or422 } },
  ];
  const ok = assertions.every((a) => a.pass);
  const errors = r.error ? [r.error] : [];

  return {
    ok,
    skipped: false,
    metrics: {
      requests_sent: 1,
      requests_success: is2xx ? 1 : 0,
      requests_429: r.status === 429 ? 1 : 0,
      requests_5xx: (r.status >= 500 && r.status < 600) ? 1 : 0,
      latency_p50_ms: r.total_ms,
      latency_p95_ms: r.total_ms,
      latency_max_ms: r.total_ms,
      ttft_ms: r.ttft_ms,
      total_ms: r.total_ms,
      response_status: r.status,
      prompt_bytes: prompt.length,
    },
    assertions,
    errors,
  };
}

export default run;
export { run };
