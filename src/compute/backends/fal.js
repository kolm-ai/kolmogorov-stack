// fal - fal.ai serverless inference queue.
// API: https://docs.fal.ai/model-endpoints/queue + https://queue.fal.run/{app_id}
// Env: KOLM_FAL_TOKEN (or FAL_KEY). run() submits to queue, polls, returns result.

import crypto from 'node:crypto';
import https from 'node:https';

export const FAL_BACKEND_CONTRACT_VERSION = 'w776-fal-backend-v1';
export const FAL_BACKEND_LIMITS = Object.freeze({
  max_app_id_chars: 160,
  max_app_id_segments: 4,
  max_request_id_chars: 160,
  max_input_json_bytes: 256 * 1024,
  max_command_chars: 8192,
  min_timeout_ms: 1000,
  max_timeout_ms: 30 * 60 * 1000,
  default_timeout_ms: 30 * 60 * 1000,
  default_poll_interval_ms: 1500,
  min_poll_interval_ms: 0,
  max_poll_interval_ms: 60 * 1000,
  max_poll_attempts: 1200,
  max_error_chars: 500,
  max_stdout_chars: 2 * 1024 * 1024,
});

const QUEUE_HOST = 'queue.fal.run';
const APP_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]+$/;

function _token() {
  return String(process.env.KOLM_FAL_TOKEN || process.env.FAL_KEY || '').trim();
}

function _sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function _redactText(value, limit = FAL_BACKEND_LIMITS.max_error_chars) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '[redacted-email]')
    .replace(/\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*[^,\s"'}]+/ig, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/ig, 'Bearer [redacted]')
    .replace(/Key\s+[A-Za-z0-9._~+/=-]+/ig, 'Key [redacted]')
    .slice(0, limit);
}

function _failure(reason, extra = {}) {
  return {
    ok: false,
    contract_version: FAL_BACKEND_CONTRACT_VERSION,
    secret_values_included: false,
    reason,
    ...extra,
  };
}

function _providerFailure(reason, text, extra = {}) {
  return _failure(reason, {
    exit_code: 1,
    stderr: _redactText(text),
    error_sha256: _sha256(text),
    ...extra,
  });
}

function _normalizeBoundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function _normalizeAppId(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > FAL_BACKEND_LIMITS.max_app_id_chars) return null;
  const segments = raw.split('/');
  if (segments.length < 2 || segments.length > FAL_BACKEND_LIMITS.max_app_id_segments) return null;
  if (!segments.every((segment) => APP_SEGMENT_RE.test(segment))) return null;
  return segments.join('/');
}

function _safeRequestId(value) {
  const raw = String(value || '').trim();
  if (
    !raw
    || raw.length > FAL_BACKEND_LIMITS.max_request_id_chars
    || !REQUEST_ID_RE.test(raw)
  ) return null;
  return raw;
}

function _queuePath(appId, parts = []) {
  const appPath = appId.split('/').map(encodeURIComponent).join('/');
  const suffix = parts.map((part) => encodeURIComponent(part)).join('/');
  return suffix ? `/${appPath}/${suffix}` : `/${appPath}`;
}

function _normalizeInput(command, env = {}) {
  if (env.FAL_INPUT_JSON != null) {
    const raw = String(env.FAL_INPUT_JSON);
    if (Buffer.byteLength(raw, 'utf8') > FAL_BACKEND_LIMITS.max_input_json_bytes) {
      return { ok: false, reason: 'FAL_INPUT_JSON exceeds size limit' };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, reason: `FAL_INPUT_JSON parse error: ${e.message}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'FAL_INPUT_JSON must be a JSON object' };
    }
    return { ok: true, input: parsed };
  }

  const prompt = Array.isArray(command) ? command.map((v) => String(v)).join(' ') : String(command || '');
  if (prompt.length > FAL_BACKEND_LIMITS.max_command_chars) {
    return { ok: false, reason: 'fal command prompt exceeds size limit' };
  }
  return { ok: true, input: { prompt } };
}

export async function detect() {
  if (!_token()) {
    return {
      available: false,
      reason: 'KOLM_FAL_TOKEN env var not set',
      contract_version: FAL_BACKEND_CONTRACT_VERSION,
      secret_values_included: false,
    };
  }
  return {
    available: true,
    device: 'fal-serverless',
    endpoint: 'https://fal.run',
    contract_version: FAL_BACKEND_CONTRACT_VERSION,
    secret_values_included: false,
  };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

// Minimal JSON request helper. No external deps; uses node:https.
function _req(method, host, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = https.request({
      method,
      host,
      path: pathname,
      headers: { ...(headers || {}), ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode || 0, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// run({ image, command, env, timeoutMs }) - `image` is the fal app id
// (e.g. "fal-ai/any-llm"). `command` becomes the JSON `input` payload via
// env.FAL_INPUT_JSON or falls back to {prompt: command.join(' ')}.
export async function run({
  image,
  command = [],
  env = {},
  timeoutMs = FAL_BACKEND_LIMITS.default_timeout_ms,
  pollIntervalMs = FAL_BACKEND_LIMITS.default_poll_interval_ms,
  request = _req,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const t0 = now();
  const tok = _token();
  if (!tok) {
    return _failure('KOLM_FAL_TOKEN not set', {
      next_step: 'export KOLM_FAL_TOKEN=...; see https://fal.ai/dashboard/keys',
    });
  }
  if (/[\r\n]/.test(tok)) {
    return _failure('invalid KOLM_FAL_TOKEN');
  }

  const appId = _normalizeAppId(image || env.FAL_APP_ID || process.env.FAL_APP_ID || 'fal-ai/any-llm');
  if (!appId) {
    return _failure('invalid_app_id', {
      next_step: 'pass image like "fal-ai/any-llm" or set FAL_APP_ID to a safe fal app id',
      latency_ms: now() - t0,
    });
  }

  const normalizedInput = _normalizeInput(command, env);
  if (!normalizedInput.ok) {
    return _failure(normalizedInput.reason, { latency_ms: now() - t0 });
  }

  const boundedTimeoutMs = _normalizeBoundedInt(
    timeoutMs,
    FAL_BACKEND_LIMITS.default_timeout_ms,
    FAL_BACKEND_LIMITS.min_timeout_ms,
    FAL_BACKEND_LIMITS.max_timeout_ms,
  );
  const boundedPollMs = _normalizeBoundedInt(
    pollIntervalMs,
    FAL_BACKEND_LIMITS.default_poll_interval_ms,
    FAL_BACKEND_LIMITS.min_poll_interval_ms,
    FAL_BACKEND_LIMITS.max_poll_interval_ms,
  );
  const maxPolls = Math.max(1, Math.min(
    FAL_BACKEND_LIMITS.max_poll_attempts,
    Math.ceil(boundedTimeoutMs / Math.max(1, boundedPollMs)),
  ));

  const headers = { Authorization: `Key ${tok}`, 'Content-Type': 'application/json' };
  let submit;
  try {
    submit = await request('POST', QUEUE_HOST, _queuePath(appId), headers, normalizedInput.input);
  } catch (e) {
    return _failure('submit fetch failed', {
      error_sha256: _sha256(e && e.message || e),
      latency_ms: now() - t0,
    });
  }
  if (submit.status >= 400) {
    return _providerFailure(`fal submit ${submit.status}`, submit.text, { latency_ms: now() - t0 });
  }

  let submitJson;
  try {
    submitJson = JSON.parse(submit.text);
  } catch {
    submitJson = {};
  }
  const requestId = _safeRequestId(submitJson.request_id);
  if (!requestId) {
    return _providerFailure('fal submit returned no valid request_id', submit.text, { latency_ms: now() - t0 });
  }

  const deadline = now() + boundedTimeoutMs;
  for (let pollCount = 0; pollCount < maxPolls && now() < deadline; pollCount += 1) {
    await sleep(boundedPollMs);
    let st;
    try {
      st = await request('GET', QUEUE_HOST, _queuePath(appId, ['requests', requestId, 'status']), headers);
    } catch (e) {
      return _failure('poll failed', {
        request_id: requestId,
        error_sha256: _sha256(e && e.message || e),
        latency_ms: now() - t0,
      });
    }
    if (st.status >= 400) {
      return _providerFailure(`poll ${st.status}`, st.text, { request_id: requestId, latency_ms: now() - t0 });
    }
    let sj;
    try {
      sj = JSON.parse(st.text);
    } catch {
      sj = {};
    }
    if (sj.status === 'COMPLETED') {
      const r2 = await request('GET', QUEUE_HOST, _queuePath(appId, ['requests', requestId]), headers);
      const stdout = String(r2.text || '').slice(0, FAL_BACKEND_LIMITS.max_stdout_chars);
      if (r2.status >= 400) {
        return _providerFailure(`fal result ${r2.status}`, r2.text, { request_id: requestId, latency_ms: now() - t0 });
      }
      return {
        ok: true,
        contract_version: FAL_BACKEND_CONTRACT_VERSION,
        secret_values_included: false,
        exit_code: 0,
        stdout,
        stdout_truncated: stdout.length < String(r2.text || '').length,
        stderr: '',
        artifact_url: `https://${QUEUE_HOST}${_queuePath(appId, ['requests', requestId])}`,
        latency_ms: now() - t0,
        request_id: requestId,
        poll_count: pollCount + 1,
      };
    }
    if (sj.status === 'FAILED' || sj.status === 'ERROR') {
      return _providerFailure(`fal ${sj.status}`, st.text, { request_id: requestId, latency_ms: now() - t0 });
    }
  }
  return _failure(`timed out after ${boundedTimeoutMs}ms`, {
    latency_ms: now() - t0,
    request_id: requestId,
    poll_limit: maxPolls,
  });
}

export default { detect, test, run };
