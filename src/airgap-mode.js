// W779 - Formal air-gap mode + local-Ollama capture.
//
// Closes the air-gapped half of W779 (the sneakernet half lives in
// src/sneakernet.js). Provides the runtime contract a kolm process honors
// when KOLM_AIRGAP=1 is set:
//
//   - isAirgapped() reads process.env.KOLM_AIRGAP === '1' at call time. Never
//     cached - operators flip the switch mid-process via /v1/airgap/test or
//     CLI `kolm airgap enable` and the next call MUST see the new state.
//   - localTeacherUrl() reads process.env.KOLM_LOCAL_TEACHER_URL (the canonical
//     env var for the local-Ollama / kolm-local-teacher endpoint). When set,
//     wrapFetch() lets calls through even in airgap mode so the local teacher
//     can be reached on the same network segment.
//   - wrapFetch(originalFetch) returns a fetch wrapper that throws when called
//     against a non-loopback URL while airgapped, EXCEPT when the URL host
//     matches localTeacherUrl() OR localhost / 127.0.0.1 / 0.0.0.0 / [::1].
//     The throw shape is the honest envelope (error:'airgap_blocks_network',
//     hint, version) so callers can catch + reflect back to operators.
//   - testNetworkLeak({fetch}) attempts a probe (always returns the honest
//     envelope; DOES NOT actually attempt a real network call by default
//     since tests do not want to depend on internet - they verify the shape).
//   - captureFromLocalOllama({prompt, model, fetch}) uses localTeacherUrl()
//     and returns the honest envelope when the URL is not configured.
//
// W411 tenant fence: every public function tolerates `opts.tenant` for
// downstream attribution but never reads tenant state directly; the route
// layer in src/router.js does the tenant_id resolution and threads it in.
//
// W604 version stamp: AIRGAP_MODE_VERSION = 'w779-v1'. Consumers MUST match
// /^w779-/ - never an explicit equality so future w779-v2 ships do not
// silently break the contract.
//
// Honesty invariants:
//   - wrapFetch NEVER silently mutates the URL. It either passes through
//     to the original fetch or throws the airgap_blocks_network envelope.
//   - captureFromLocalOllama never falls back to a public model when
//     KOLM_LOCAL_TEACHER_URL is unset - the honest envelope surfaces the
//     missing config so the operator can fix it.
//   - testNetworkLeak with `actuallyProbe:false` (the default) returns the
//     shape envelope without making real network calls. Tests MUST NOT
//     depend on internet availability.

import { URL } from 'node:url';

export const AIRGAP_MODE_VERSION = 'w779-v1';

// Loopback hosts that wrapFetch always allows, even when airgapped. This is
// the air-gap contract: same-host traffic is by definition not a network
// leak. Includes IPv6 loopback and the all-zeros bind address used by some
// local daemons on Linux.
const LOOPBACK_HOSTS = Object.freeze([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
]);

// Read the airgap switch fresh from env on every call. Operators can flip
// KOLM_AIRGAP=1 mid-process (via the daemon endpoint or shell export) and
// the next call MUST honor the new state - caching here would be a bug.
export function isAirgapped() {
  return process.env.KOLM_AIRGAP === '1';
}

// Read the local-teacher URL fresh from env. Returns null when unset so
// callers can branch cleanly. The URL points at a local-Ollama or
// kolm-local-teacher HTTP endpoint - same-host, no internet round trip.
export function localTeacherUrl() {
  const u = process.env.KOLM_LOCAL_TEACHER_URL;
  if (!u || typeof u !== 'string' || !u.trim()) return null;
  return u.trim();
}

// Return true when the given URL host is loopback (localhost, 127.0.0.1,
// 0.0.0.0, ::1). Used by wrapFetch to allow same-host traffic in airgap
// mode without round-tripping to the network.
function isLoopbackUrl(urlStr) {
  let host;
  try {
    const parsed = new URL(urlStr);
    host = parsed.hostname.toLowerCase();
  } catch (_) {
    // Malformed URL - be safe and treat as non-loopback. wrapFetch will
    // block it under airgap. This is the conservative path: if we can't
    // parse the host we can't prove it's local, so we treat it as remote.
    return false;
  }
  // Strip IPv6 brackets if present (URL.hostname already does this but be
  // defensive - some Node versions don't).
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  for (const lh of LOOPBACK_HOSTS) {
    const stripped = lh.startsWith('[') && lh.endsWith(']') ? lh.slice(1, -1) : lh;
    if (host === stripped) return true;
  }
  return false;
}

// Return true when the given URL matches the configured KOLM_LOCAL_TEACHER_URL
// (same scheme, host, and port). Allows airgapped processes to still reach
// the local teacher endpoint when its bind address is non-loopback (e.g. a
// LAN IP behind a firewall).
function matchesLocalTeacher(urlStr) {
  const teacher = localTeacherUrl();
  if (!teacher) return false;
  let a, b;
  try {
    a = new URL(urlStr);
    b = new URL(teacher);
  } catch (_) {
    return false;
  }
  // Same host + same port + same scheme. Path is intentionally ignored - the
  // teacher endpoint may expose multiple paths under the same origin.
  if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
  if (a.protocol !== b.protocol) return false;
  // Default port resolution: if either side omits, both must resolve to the
  // protocol default.
  const portA = a.port || (a.protocol === 'https:' ? '443' : '80');
  const portB = b.port || (b.protocol === 'https:' ? '443' : '80');
  if (portA !== portB) return false;
  return true;
}

// Build the honest envelope that wrapFetch throws when it blocks a call.
// Surfaces the offending URL + a one-line hint so the operator can either
// disable airgap, point KOLM_LOCAL_TEACHER_URL at the right host, or fix
// the caller.
function airgapBlockEnvelope(urlStr) {
  const teacher = localTeacherUrl();
  return {
    ok: false,
    error: 'airgap_blocks_network',
    blocked_url: String(urlStr || ''),
    hint: teacher
      ? `KOLM_AIRGAP=1 is active. Allowed hosts: localhost/127.0.0.1/0.0.0.0 and ${teacher} (KOLM_LOCAL_TEACHER_URL). Set KOLM_AIRGAP=0 to disable.`
      : 'Set KOLM_AIRGAP=0 or capture from local-Ollama at $KOLM_LOCAL_TEACHER_URL',
    version: AIRGAP_MODE_VERSION,
  };
}

// Wrap the given fetch function so calls are blocked when airgapped UNLESS
// the URL is loopback or matches KOLM_LOCAL_TEACHER_URL. When not airgapped
// the wrapper is transparent - passes every call through.
//
// The wrapper does NOT install itself globally; the caller decides where to
// inject it. This keeps the seam testable (DI: pass a stub fetch) and
// avoids the W305 lesson of mutating globalThis.fetch in places that don't
// expect it.
export function wrapFetch(originalFetch) {
  const real = originalFetch || globalThis.fetch;
  if (typeof real !== 'function') {
    throw new Error('wrapFetch: no fetch implementation supplied or available on globalThis');
  }
  return async function airgapWrappedFetch(input, init) {
    // Pass-through when not airgapped.
    if (!isAirgapped()) return real(input, init);
    const urlStr = (typeof input === 'string') ? input : (input && input.url) || String(input);
    // Allow loopback unconditionally.
    if (isLoopbackUrl(urlStr)) return real(input, init);
    // Allow KOLM_LOCAL_TEACHER_URL host.
    if (matchesLocalTeacher(urlStr)) return real(input, init);
    // Block + throw the honest envelope. Throwing (vs returning) keeps the
    // contract sharp: callers MUST catch + decide how to surface the block.
    const env = airgapBlockEnvelope(urlStr);
    const err = new Error(env.error);
    err.envelope = env;
    err.blocked_url = env.blocked_url;
    err.airgap_blocked = true;
    throw err;
  };
}

// Probe for a network leak. Default behavior (actuallyProbe:false) returns
// the shape envelope without making any real network calls - tests use this
// to assert the contract without depending on internet. When actuallyProbe
// is true AND a probe URL is supplied, the function uses the wrapped fetch
// to attempt a call; the throw is caught and reported.
//
// Returns:
//   { ok:true, leaked:false, hits:[], probed_urls:[...], airgap_active:bool,
//     local_teacher_url:string|null, version }
export async function testNetworkLeak(opts = {}) {
  const {
    actuallyProbe = false,
    probeUrls = ['https://example.invalid/airgap-probe'],
    fetch: fetchImpl,
  } = opts;
  const hits = [];
  const probed = [];
  if (actuallyProbe && Array.isArray(probeUrls)) {
    const wrapped = wrapFetch(fetchImpl || globalThis.fetch);
    for (const url of probeUrls) {
      probed.push(url);
      try {
        await wrapped(url, { method: 'HEAD' });
        // If the call succeeded against a non-loopback URL while airgapped,
        // that's a leak (wrapFetch should have thrown). Record it.
        if (isAirgapped() && !isLoopbackUrl(url) && !matchesLocalTeacher(url)) {
          hits.push({ url, leak_reason: 'fetch_did_not_throw_when_airgapped' });
        }
      } catch (e) {
        // Expected when airgapped + non-local. Honest record: this is the
        // shape we want.
        if (!e.airgap_blocked) {
          // Transport-level error (DNS, refused) - still no leak, but record
          // for operator visibility.
          hits.push({ url, leak_reason: 'transport_error', detail: String(e && e.message || e) });
        }
      }
    }
  }
  return {
    ok: true,
    leaked: hits.some(h => h.leak_reason === 'fetch_did_not_throw_when_airgapped'),
    hits,
    probed_urls: probed,
    airgap_active: isAirgapped(),
    local_teacher_url: localTeacherUrl(),
    version: AIRGAP_MODE_VERSION,
  };
}

// Capture a prompt -> response pair from a local Ollama / kolm-local-teacher.
// When KOLM_LOCAL_TEACHER_URL is unset, returns the honest envelope so the
// operator can configure it. When set, POSTs to <url>/api/generate with the
// Ollama request shape (model + prompt). Returns the captured envelope.
//
// W411 tenant fence: opts.tenant is preserved in the envelope so downstream
// capture-stream code can attribute the row to the right tenant. We do NOT
// write to the event store here - the route layer does that after we
// return.
export async function captureFromLocalOllama(opts = {}) {
  const { prompt, model, tenant = null, fetch: fetchImpl, timeoutMs = 30000 } = opts;
  if (!prompt || typeof prompt !== 'string') {
    return {
      ok: false,
      error: 'prompt_required',
      hint: 'pass {prompt: string} - the user message to send to the local teacher',
      version: AIRGAP_MODE_VERSION,
    };
  }
  const teacher = localTeacherUrl();
  if (!teacher) {
    return {
      ok: false,
      error: 'local_teacher_unconfigured',
      hint: 'Set KOLM_LOCAL_TEACHER_URL=http://127.0.0.1:11434 (Ollama default) or your kolm-local-teacher endpoint',
      version: AIRGAP_MODE_VERSION,
    };
  }
  const real = fetchImpl || globalThis.fetch;
  if (typeof real !== 'function') {
    return {
      ok: false,
      error: 'no_fetch_available',
      hint: 'no global fetch and no opts.fetch supplied - Node 18+ ships fetch by default',
      version: AIRGAP_MODE_VERSION,
    };
  }
  // Use the wrapped fetch so even an unconfigured KOLM_AIRGAP=1 honors the
  // contract - the teacher URL is allowed by matchesLocalTeacher() so this
  // is always going to succeed when the URL is reachable.
  const wrapped = wrapFetch(real);
  const endpoint = teacher.replace(/\/$/, '') + '/api/generate';
  const requestBody = {
    model: model || process.env.KOLM_LOCAL_TEACHER_MODEL || 'llama3',
    prompt,
    stream: false,
  };
  const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const resp = await wrapped(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: ctl ? ctl.signal : undefined,
    });
    if (timer) clearTimeout(timer);
    const status = resp.status;
    let body;
    try {
      body = await resp.json();
    } catch (_) {
      body = null;
    }
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        error: 'local_teacher_http_error',
        http_status: status,
        body,
        version: AIRGAP_MODE_VERSION,
      };
    }
    // Ollama response shape: { model, created_at, response, done, ... }.
    // We surface the raw body so callers can adapt to other local-teacher
    // backends without re-wrapping.
    return {
      ok: true,
      response_text: (body && typeof body.response === 'string') ? body.response : null,
      model_used: (body && body.model) || requestBody.model,
      raw: body,
      tenant,
      teacher_url: teacher,
      version: AIRGAP_MODE_VERSION,
    };
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e && e.airgap_blocked) {
      // Should not happen - the teacher URL is allowed. But honest-envelope
      // anyway in case the URL parser rejected it for some reason.
      return e.envelope;
    }
    return {
      ok: false,
      error: 'local_teacher_unreachable',
      hint: `Could not reach ${teacher} - is the local-Ollama daemon running? Try: curl ${teacher}/api/tags`,
      detail: String(e && e.message || e),
      version: AIRGAP_MODE_VERSION,
    };
  }
}

// Return the current airgap status as a structured envelope. Used by the
// CLI `kolm airgap status` and the route GET /v1/airgap/status. Read-only,
// safe to call without auth.
export function airgapStatus() {
  const teacher = localTeacherUrl();
  return {
    ok: true,
    enabled: isAirgapped(),
    mode: isAirgapped() ? 'airgapped' : 'networked',
    local_teacher_url: teacher,
    env: {
      KOLM_AIRGAP: process.env.KOLM_AIRGAP || null,
      TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE || null,
      HF_DATASETS_OFFLINE: process.env.HF_DATASETS_OFFLINE || null,
      HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE || null,
      KOLM_LOCAL_TEACHER_URL: process.env.KOLM_LOCAL_TEACHER_URL || null,
      KOLM_LOCAL_TEACHER_MODEL: process.env.KOLM_LOCAL_TEACHER_MODEL || null,
    },
    version: AIRGAP_MODE_VERSION,
  };
}

// Loopback host list exported for tests + downstream consumers that want to
// re-use the same allow-list (e.g. a daemon admin endpoint).
export const AIRGAP_LOOPBACK_HOSTS = LOOPBACK_HOSTS;
