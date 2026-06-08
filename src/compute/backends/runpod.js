// runpod - RunPod serverless endpoints.
// API: https://docs.runpod.io/serverless/endpoints/job-operations
// Env: KOLM_RUNPOD_TOKEN (or RUNPOD_API_KEY) + KOLM_RUNPOD_ENDPOINT_ID. run() POSTs job, polls.

import https from 'node:https';

const HOST = 'api.runpod.ai';
const POLL_INTERVAL_MS = 2000;

function _token() {
  return process.env.KOLM_RUNPOD_TOKEN || process.env.RUNPOD_API_KEY
    || process.env.runpod_api_key || '';
}

// No local token (operator keeps runpod_api_key in Vercel)? Route serverless
// run/status through the Vercel proxy (api/runpod.js) with a kolm bearer.
function _proxy() {
  const bearer = process.env.KOLM_API_KEY || process.env.KOLM_KEY || '';
  if (!bearer) return null;
  const base = String(process.env.KOLM_BASE_URL || process.env.KOLM_BASE || 'https://kolm.ai').replace(/\/+$/, '');
  return { url: base + '/v1/runpod/graphql', bearer };
}

// Unified submit/poll: direct to api.runpod.ai with a token, else via the Vercel proxy.
async function _call({ op, endpointId, input, jobId }) {
  const tok = _token();
  if (tok) {
    const headers = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
    const path = op === 'status' ? `/v2/${endpointId}/status/${jobId}` : `/v2/${endpointId}/run`;
    const r = await _req(op === 'status' ? 'GET' : 'POST', HOST, path, headers, op === 'status' ? null : { input });
    let j; try { j = JSON.parse(r.text); } catch { j = {}; }
    return { status: r.status, json: j };
  }
  const px = _proxy();
  if (!px) return { status: 0, json: {}, no_auth: true };
  const r = await fetch(px.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${px.bearer}` },
    body: JSON.stringify({ serverless: { endpointId, op, input, jobId } }),
  });
  let j; try { j = JSON.parse(await r.text()); } catch { j = {}; }
  return { status: j.status || r.status, json: j.result || {} };
}

export async function detect() {
  if (!_token()) return { available: false, reason: 'KOLM_RUNPOD_TOKEN env var not set' };
  return {
    available: true,
    device: 'runpod-h100',
    endpoint: process.env.KOLM_RUNPOD_ENDPOINT || 'https://api.runpod.io/graphql',
  };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

function _req(method, host, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = https.request({
      method, host, path: pathname,
      headers: { ...(headers || {}), ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// run({ image, command, env, timeoutMs }) - `image` overrides the serverless
// endpoint id (default env.KOLM_RUNPOD_ENDPOINT_ID). `command` becomes the
// `input` payload (parsed via env.RUNPOD_INPUT_JSON or {prompt: command...}).
export async function run({ image, command = [], env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  if (!_token() && !_proxy()) {
    return { ok: false, reason: 'runpod auth missing', next_step: 'export KOLM_RUNPOD_TOKEN=... (or keep runpod_api_key in Vercel + set KOLM_API_KEY to route via the proxy)' };
  }
  const endpointId = image || env.KOLM_RUNPOD_ENDPOINT_ID || process.env.KOLM_RUNPOD_ENDPOINT_ID;
  if (!endpointId) {
    return { ok: false, reason: 'no endpoint id', next_step: 'pass image=<endpoint_id> or set KOLM_RUNPOD_ENDPOINT_ID' };
  }
  let input;
  if (env.RUNPOD_INPUT_JSON) {
    try { input = JSON.parse(env.RUNPOD_INPUT_JSON); }
    catch (e) { return { ok: false, reason: `RUNPOD_INPUT_JSON parse error: ${e.message}` }; }
  } else {
    input = { prompt: Array.isArray(command) ? command.join(' ') : String(command || '') };
  }
  let submit;
  try {
    submit = await _call({ op: 'run', endpointId, input });
  } catch (e) {
    return { ok: false, reason: `submit fetch failed: ${e.message}`, latency_ms: Date.now() - t0 };
  }
  if (submit.status >= 400) {
    return { ok: false, exit_code: 1, stderr: JSON.stringify(submit.json).slice(0, 1000), reason: `runpod submit ${submit.status}`, latency_ms: Date.now() - t0 };
  }
  const jobId = submit.json.id;
  if (!jobId) {
    return { ok: false, reason: 'runpod submit returned no id', stderr: JSON.stringify(submit.json).slice(0, 500), latency_ms: Date.now() - t0 };
  }
  // Poll status until COMPLETED|FAILED|CANCELLED|TIMED_OUT.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let st;
    try { st = await _call({ op: 'status', endpointId, jobId }); }
    catch (e) { return { ok: false, reason: `poll failed: ${e.message}`, latency_ms: Date.now() - t0 }; }
    if (st.status >= 400) {
      return { ok: false, exit_code: 1, stderr: JSON.stringify(st.json).slice(0, 500), reason: `poll ${st.status}`, latency_ms: Date.now() - t0 };
    }
    const pj = st.json;
    if (pj.status === 'COMPLETED') {
      return {
        ok: true, exit_code: 0,
        stdout: typeof pj.output === 'string' ? pj.output : JSON.stringify(pj.output),
        stderr: '',
        artifact_url: `https://${HOST}/v2/${endpointId}/status/${jobId}`,
        latency_ms: Date.now() - t0,
        job_id: jobId,
      };
    }
    if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(pj.status)) {
      return { ok: false, exit_code: 1, stderr: pj.error || JSON.stringify(pj).slice(0, 500), reason: `runpod ${pj.status}`, latency_ms: Date.now() - t0, job_id: jobId };
    }
  }
  return { ok: false, reason: `timed out after ${timeoutMs}ms`, latency_ms: Date.now() - t0, job_id: jobId };
}

export default { detect, test, run };
