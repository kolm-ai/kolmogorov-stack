// src/log-importer.js
//
// The Continuous ONRAMP transport. A tenant gets a signed report from logs they
// already have without re-implementing the upload dance: POST /v1/audit/import
// (src/audit-routes.js) accepts logs INLINE in the request, or pulls them from a
// URL the tenant controls, then runs them through the SAME scan -> sign path as
// /v1/audit/scan. This module owns ONLY the transport + safety envelope:
//
//   * fetch (url source) or accept (inline source) the raw log payload
//   * a hard byte ceiling on what we will pull (untrusted remote / large export)
//   * an SSRF guard on the url source (no localhost / link-local / private nets
//     unless KOLM_IMPORT_ALLOW_PRIVATE=1, which the test + a self-hosted runner
//     set deliberately)
//   * never throws - every failure is a { ok:false, reason, detail } so the
//     route maps a clean status and the webhook/onramp loop never 500s
//
// Record NORMALIZATION (JSONL/array/wrapper -> clean JSONL + count) stays in the
// route's _toJsonl so there is exactly ONE parser shared with scan/ingest/run;
// this module returns the raw payload for that parser to consume. ZERO new deps:
// global fetch, same as src/asr-billing.js.

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB - a very large agent export, far under anything that strains the store
const FETCH_TIMEOUT_MS = 15000;
const MAX_HEADERS = 30;

// Hop-by-hop / identity headers a caller must never be able to set on our
// outbound fetch (they would either break the request or let a caller spoof the
// origin we present to their log source). Everything else (Authorization,
// content-type, a bearer for their own API) is passed through.
const HEADER_DENYLIST = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive',
  'upgrade', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
]);

function _result(ok, extra) { return { ok, ...extra }; }

// Pass through a caller-supplied header map, but: only string keys/values, drop
// the denylist, and cap the count so a hostile body cannot blow up the request.
function _safeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(headers)) {
    if (n >= MAX_HEADERS) break;
    if (typeof k !== 'string' || v == null) continue;
    const key = k.trim().toLowerCase();
    if (!key || HEADER_DENYLIST.has(key)) continue;
    const val = String(v);
    if (val.length > 8192) continue;
    out[k] = val;
    n++;
  }
  return out;
}

// True for a host that resolves (by literal inspection) to a loopback,
// link-local, or RFC1918 private address - the classic SSRF targets (cloud
// metadata at 169.254.169.254, internal services on 10/192.168/172.16-31,
// localhost). Hostname-based, so a public name that later resolves to a private
// IP (DNS rebinding) is out of scope here; the byte cap + timeout still bound it,
// and KOLM_IMPORT_ALLOW_PRIVATE governs intentional local use.
function _isPrivateHost(hostnameRaw) {
  const h = String(hostnameRaw || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0') return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if ([a, b, +m[3], +m[4]].some((o) => o > 255)) return true; // malformed -> treat as unsafe
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;       // link-local / cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

function _validateUrl(raw) {
  let u;
  try { u = new URL(String(raw)); }
  catch { return _result(false, { reason: 'invalid_url', detail: 'url is not a valid absolute URL' }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return _result(false, { reason: 'invalid_url', detail: 'url must be http(s)' });
  }
  if (process.env.KOLM_IMPORT_ALLOW_PRIVATE !== '1' && _isPrivateHost(u.hostname)) {
    return _result(false, { reason: 'blocked_url', detail: 'url resolves to a private/loopback host; point it at a reachable log endpoint' });
  }
  return _result(true, { url: u });
}

// importAgentLogs - fetch (url) or accept (inline) a raw log payload under a hard
// byte cap. Returns { ok:true, source, payload, bytes } where payload is fed to
// the route's _toJsonl, or { ok:false, reason, detail }. NEVER throws.
export async function importAgentLogs({ source, url, headers, logs, maxBytes, fetchImpl } = {}) {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;
  try {
    const src = String(source || (url ? 'url' : 'inline')).toLowerCase();

    if (src === 'inline') {
      if (logs == null || (typeof logs === 'string' && logs.trim() === '')) {
        return _result(false, { reason: 'no_logs', detail: 'inline import requires a non-empty "logs" field' });
      }
      // Measure bytes against the same cap the url path uses. We keep the
      // original shape (string | array | object) so _toJsonl can parse it.
      let probe;
      if (typeof logs === 'string') probe = logs;
      else { try { probe = JSON.stringify(logs); } catch { return _result(false, { reason: 'unserializable_logs', detail: 'inline logs are not JSON-serializable' }); } }
      const bytes = Buffer.byteLength(probe, 'utf8');
      if (bytes > cap) return _result(false, { reason: 'too_large', detail: `inline logs are ${bytes} bytes; the cap is ${cap}`, bytes });
      return _result(true, { source: 'inline', payload: logs, bytes });
    }

    if (src === 'url') {
      const v = _validateUrl(url);
      if (!v.ok) return v;
      const doFetch = fetchImpl || globalThis.fetch;
      if (typeof doFetch !== 'function') return _result(false, { reason: 'fetch_unavailable', detail: 'global fetch is unavailable (requires Node >= 18)' });
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
      let resp;
      try {
        resp = await doFetch(v.url.href, { method: 'GET', headers: _safeHeaders(headers), signal: ctl.signal, redirect: 'follow' });
      } catch (e) {
        clearTimeout(timer);
        const aborted = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
        return _result(false, { reason: aborted ? 'fetch_timeout' : 'fetch_failed', detail: aborted ? `remote did not respond within ${FETCH_TIMEOUT_MS}ms` : (e && e.message) });
      }
      clearTimeout(timer);
      if (!resp || !resp.ok) {
        return _result(false, { reason: 'fetch_status', detail: `remote responded ${resp ? resp.status : 'no response'}`, status: resp ? resp.status : null });
      }
      // Reject early on a declared content-length over the cap, before reading.
      let declared = NaN;
      try { declared = Number(resp.headers && resp.headers.get && resp.headers.get('content-length')); } catch { /* header read best-effort */ }
      if (Number.isFinite(declared) && declared > cap) {
        return _result(false, { reason: 'too_large', detail: `remote content-length ${declared} exceeds the cap ${cap}`, bytes: declared });
      }
      let text;
      try { text = await resp.text(); }
      catch (e) { return _result(false, { reason: 'read_failed', detail: e && e.message }); }
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > cap) return _result(false, { reason: 'too_large', detail: `fetched ${bytes} bytes exceeds the cap ${cap}`, bytes });
      if (bytes === 0) return _result(false, { reason: 'no_logs', detail: 'the url returned an empty body' });
      return _result(true, { source: 'url', payload: text, bytes });
    }

    return _result(false, { reason: 'invalid_source', detail: 'source must be "url" or "inline"' });
  } catch (e) {
    // Belt-and-suspenders: this module must never throw across the route boundary.
    return _result(false, { reason: 'import_error', detail: e && e.message });
  }
}

export const LOG_IMPORTER_DEFAULTS = Object.freeze({ DEFAULT_MAX_BYTES, FETCH_TIMEOUT_MS });

export default { importAgentLogs, LOG_IMPORTER_DEFAULTS };
