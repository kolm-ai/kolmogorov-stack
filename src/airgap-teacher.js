// W831-2 — Local-only teacher gateway.
//
// Purpose
// -------
// Verifies a teacher endpoint URL refers to a local inference server (Ollama,
// vLLM, llama.cpp, or any unix-socket / loopback HTTP daemon) BEFORE any
// inference call goes out. This is the "you cannot accidentally configure a
// cloud teacher in air-gap mode" guard.
//
// The function is the first thing the distill pipeline calls when it picks
// the teacher; failing here aborts the distill run with a typed PolicyBlockError
// rather than letting a misconfigured URL leak prompts to the public internet.
//
// Local hosts allowed (no other host MAY be configured in air-gap mode):
//   - 127.0.0.1  (canonical IPv4 loopback)
//   - localhost  (the hostname that resolves to loopback)
//   - ::1        (canonical IPv6 loopback; with or without [...] brackets)
//   - 0.0.0.0    (bind-all sentinel — some local daemons bind to this; from
//                 the caller's perspective this still resolves to loopback)
//   - unix:/...  (unix-domain-socket pseudo-URL used by llama.cpp local mode)
//
// Anything else throws PolicyBlockError. This is INTENTIONALLY narrower than
// W779's wrapFetch (which also allows KOLM_LOCAL_TEACHER_URL — that flag is
// for non-airgap convenience). W831 air-gap mode does NOT trust an env var
// to override the policy; the URL itself MUST be local.
//
// W411 tenant fence: this module has no tenant state — it's a pure URL
// predicate. The route layer enforces auth before calling.
//
// W604 version stamp: AIRGAP_TEACHER_VERSION = 'w831-v1'. Consumers MUST
// match /^w831-/.
//
// Honesty invariants:
//   - PolicyBlockError carries a `code` field so callers can programmatically
//     route the error (e.g. surface a clean banner in the TUI).
//   - We do NOT attempt DNS resolution. "localhost" is treated as local by
//     name; if an operator has hijacked /etc/hosts to point localhost at a
//     public IP, they have bigger problems than our predicate.
//   - We do NOT trust the protocol (http vs https) — the policy is host-based.

import { URL } from 'node:url';

export const AIRGAP_TEACHER_VERSION = 'w831-v1';

// Typed error so callers can `if (e instanceof PolicyBlockError)` rather than
// string-matching on err.message. Subclassing Error keeps the stack trace.
export class PolicyBlockError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'PolicyBlockError';
    this.code = opts.code || 'teacher_not_local';
    if (opts.teacher_url) this.teacher_url = opts.teacher_url;
    if (opts.detail) this.detail = opts.detail;
  }
}

// Canonical list of local hosts. Kept tight on purpose. We strip IPv6 brackets
// before comparison so '[::1]' and '::1' both match.
const LOCAL_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

// Verify the teacher URL is local. Throws PolicyBlockError on violation.
// Returns {ok:true, host, scheme, port, kind, version} on accept so callers
// have a structured ack to log.
//
// kind ∈ {'unix-socket', 'loopback-ipv4', 'loopback-ipv6', 'localhost',
//        'bind-all'} so the audit trail can record the specific allow-reason.
export function verifyTeacherIsLocal(opts = {}) {
  const { teacher_url } = opts;
  if (!teacher_url || typeof teacher_url !== 'string') {
    throw new PolicyBlockError(
      'teacher_not_local: teacher_url is required (got ' + JSON.stringify(teacher_url) + ')',
      { code: 'teacher_not_local', teacher_url }
    );
  }
  const url = teacher_url.trim();

  // Unix-domain-socket pseudo-URL: 'unix:/var/run/llama.sock' or
  // 'unix:///var/run/llama.sock'. By definition this is local — sockets are
  // bound to a path on the same filesystem.
  if (/^unix:/.test(url)) {
    return {
      ok: true,
      host: 'unix-socket',
      scheme: 'unix',
      port: null,
      kind: 'unix-socket',
      teacher_url: url,
      version: AIRGAP_TEACHER_VERSION,
    };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new PolicyBlockError(
      `teacher_not_local: could not parse URL ${JSON.stringify(url)}`,
      { code: 'teacher_not_local', teacher_url: url, detail: String((e && e.message) || e) }
    );
  }
  let host = parsed.hostname.toLowerCase();
  // Strip IPv6 brackets if present (URL.hostname does this in current Node,
  // but be defensive — some old Node versions don't).
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  // Allow scheme = file: as a (rare) local mode where llama.cpp embeds the
  // teacher in-process. file: has no host concept; treat as local.
  if (parsed.protocol === 'file:') {
    return {
      ok: true,
      host: '',
      scheme: 'file',
      port: null,
      kind: 'unix-socket', // close enough — "no network, local resource"
      teacher_url: url,
      version: AIRGAP_TEACHER_VERSION,
    };
  }

  let kind;
  if (host === '127.0.0.1' || host.startsWith('127.')) kind = 'loopback-ipv4';
  else if (host === '::1') kind = 'loopback-ipv6';
  else if (host === 'localhost') kind = 'localhost';
  else if (host === '0.0.0.0' || host === '::') kind = 'bind-all';
  else {
    throw new PolicyBlockError(
      `teacher_not_local: host ${JSON.stringify(host)} is not in the local-allow-list`,
      { code: 'teacher_not_local', teacher_url: url, detail: 'allowed=' + LOCAL_HOSTS.join(',') + ' (plus 127.* range, unix:, file:)' }
    );
  }

  return {
    ok: true,
    host,
    scheme: parsed.protocol.replace(/:$/, ''),
    port: parsed.port || null,
    kind,
    teacher_url: url,
    version: AIRGAP_TEACHER_VERSION,
  };
}

// Non-throwing predicate variant. Returns true/false so callers that just
// want a boolean don't have to wrap in try/catch.
export function isTeacherLocal({ teacher_url } = {}) {
  try {
    verifyTeacherIsLocal({ teacher_url });
    return true;
  } catch (_) {
    return false;
  }
}

// Exposed for tests + downstream consumers that want to render the allow-list
// in a CLI / TUI help screen.
export const AIRGAP_TEACHER_LOCAL_HOSTS = LOCAL_HOSTS;
