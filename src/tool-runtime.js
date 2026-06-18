// W735 - Agent / Tool-Use distillation: runtime adapter scaffold.
//
// Closes W735-3 + W735-4 from KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 394-395:
//
//   W735-3: "Runtime execute tool calls against real APIs with appropriate
//           auth" → tool-runtime adapter scaffold. Tenants register their
//           own tool handlers via registerTool({name, handler, auth_schema}).
//           No built-in tool registry - kolm.ai doesn't ship a default
//           weather/search/etc. adapter (would be a security hazard +
//           scope creep). The honest scaffold lets tenants wire their
//           own tools without us reimplementing every SaaS API.
//
//   W735-4: "Distilled agent handles 90% of tool-calling patterns locally"
//           → HONEST acceptance measurement, not aspirational. The
//           accumulateAcceptanceMetrics() function returns the local-
//           handling rate ONLY when the sample size is large enough
//           (≥100 captures) to be statistically meaningful. Below that
//           threshold, it returns `null` with the `insufficient_signal`
//           reason rather than extrapolating from a tiny sample.
//
// Design contract:
//
//   * Per-tenant registries. Different tenants register different tools
//     (one might have a Slack adapter; another might have a Salesforce
//     adapter). The tool_registry argument is supplied per-call so the
//     scaffold never leaks tools across tenant boundaries.
//   * Honest errors. executeToolCall() never throws - it returns a
//     discriminated-union envelope {ok:true, result} OR {ok:false,
//     error:'tool_not_found'|'auth_failed'|'tool_threw', detail}.
//   * 90% is a goal, not a claim. accumulateAcceptanceMetrics() returns
//     null for the rate when sample_size < 100. The W735-4 plan item
//     pins this as "honest measurement, not aspirational"; the public
//     /docs/agents.html page tells operators the same thing.
//   * Sandboxing is the tenant's job. The runtime calls the registered
//     handler with the parsed arguments - it does NOT sandbox arbitrary
//     code, sign URLs, validate JSON Schema, or rate-limit the upstream
//     API. Those concerns belong in the tenant's handler implementation
//     (where they have the auth context to do them safely).
//
// Public surface:
//
//   TOOL_RUNTIME_VERSION
//   executeToolCall({tool_call, tool_registry, auth_context})
//   registerTool(tool_registry, {name, handler, auth_schema?})
//   accumulateAcceptanceMetrics({captures, n_handled_locally,
//                                n_escalated_to_teacher})

export const TOOL_RUNTIME_VERSION = 'w735-v1';
export const TOOL_RUNTIME_LIMITS = Object.freeze({
  max_tool_name_chars: 128,
  max_required_fields: 50,
  max_error_detail_chars: 240,
  max_argument_json_bytes: 256 * 1024,
  max_sample_size: 10_000_000,
});

// Statistical floor for the W735-4 90% acceptance claim. Below this
// sample size, the local_handling_rate is reported as `null` - 
// extrapolating from <100 captures is dishonest. This number is the
// "honest measurement" backstop the spec calls for.
const ACCEPTANCE_MIN_SAMPLE = 100;
const UNSAFE_TOOL_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function _safeDetail(v) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s.length > TOOL_RUNTIME_LIMITS.max_error_detail_chars
    ? s.slice(0, TOOL_RUNTIME_LIMITS.max_error_detail_chars)
    : s;
}

function _safeToolName(v) {
  if (typeof v !== 'string') return null;
  const name = v.trim().slice(0, TOOL_RUNTIME_LIMITS.max_tool_name_chars);
  if (!name || UNSAFE_TOOL_NAMES.has(name)) return null;
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) ? name : null;
}

function _isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function _safeRequiredFields(required) {
  if (!Array.isArray(required)) return [];
  const out = [];
  for (const field of required) {
    const key = _safeToolName(field);
    if (key && !out.includes(key)) out.push(key);
    if (out.length >= TOOL_RUNTIME_LIMITS.max_required_fields) break;
  }
  return out;
}

function _safeArguments(args) {
  if (args == null) return { ok: true, value: {} };
  if (!_isPlainObject(args)) return { ok: false, error: 'tool_call.arguments must be a plain object' };
  let json = '';
  try {
    json = JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return { ok: false, error: 'tool_call.arguments must be JSON-serializable' };
  }
  if (Buffer.byteLength(json, 'utf8') > TOOL_RUNTIME_LIMITS.max_argument_json_bytes) {
    return { ok: false, error: 'tool_call.arguments too large' };
  }
  return { ok: true, value: JSON.parse(json) };
}

function _capCount(v, max = TOOL_RUNTIME_LIMITS.max_sample_size) {
  const n = Math.floor(Number(v) || 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

// =============================================================================
// registerTool
// =============================================================================

/**
 * Register a tool on a per-tenant registry.
 *
 * The registry is a plain Map (or any Map-like object supporting `set`
 * and `has`) that the caller owns. The runtime does not maintain a
 * process-wide registry - that would leak tools across tenants. Each
 * tenant scope (typically authMiddleware → req.tenant_record) is
 * responsible for instantiating its own Map and passing it through.
 *
 * Throws TypeError on shape violations so registration-time mistakes
 * fail loud (registration is rare and synchronous; this is the right
 * place to throw rather than return an envelope).
 *
 * Returns the registry for convenient chaining.
 */
export function registerTool(tool_registry, tool) {
  if (!tool_registry || typeof tool_registry.set !== 'function' || typeof tool_registry.has !== 'function') {
    throw new TypeError('tool_registry must be a Map (or Map-like with .set and .has)');
  }
  if (!_isPlainObject(tool)) throw new TypeError('tool must be a plain object');
  const name = _safeToolName(tool.name);
  if (!name) throw new TypeError('tool.name must be a safe non-empty string');
  if (typeof tool.handler !== 'function') throw new TypeError('tool.handler must be a function');
  if (tool.auth_schema != null && !_isPlainObject(tool.auth_schema)) {
    throw new TypeError('tool.auth_schema must be a plain object when present');
  }
  const auth_schema = tool.auth_schema
    ? { ...tool.auth_schema, required: _safeRequiredFields(tool.auth_schema.required) }
    : null;
  tool_registry.set(name, {
    name,
    handler: tool.handler,
    auth_schema,
  });
  return tool_registry;
}

// =============================================================================
// executeToolCall
// =============================================================================

/**
 * Execute a single tool call against a per-tenant registry.
 *
 * Honest discriminated-union envelope - never throws (handler exceptions
 * are caught and surfaced as `tool_threw`):
 *
 *   {ok: true,  result: <whatever handler returned>}
 *   {ok: false, error: 'tool_not_found',  detail: 'tool "x" not registered'}
 *   {ok: false, error: 'invalid_tool_call', detail: '...'}
 *   {ok: false, error: 'auth_failed',     detail: 'missing required scope ...'}
 *   {ok: false, error: 'tool_threw',      detail: <stringified error>}
 *
 * The handler is invoked as `handler({arguments, auth_context, tool_call})`
 * so it gets the parsed arguments, the request-time auth context (api
 * keys, OAuth tokens - whatever the tenant put there), and the raw
 * tool_call record for advanced cases (id, etc.).
 *
 * The auth_schema check is a light shape gate: if `auth_schema` declares
 * `required: ['api_key', 'workspace_id']`, executeToolCall verifies
 * those keys exist on auth_context before invoking the handler. The
 * handler is still expected to revalidate - defense in depth.
 */
export async function executeToolCall(opts) {
  const { tool_call, tool_registry, auth_context } = opts || {};

  if (!tool_call || typeof tool_call !== 'object'
      || typeof tool_call.name !== 'string' || !tool_call.name) {
    return {
      ok: false,
      error: 'invalid_tool_call',
      detail: 'tool_call must be {name: string, arguments?: object}',
    };
  }
  const toolName = _safeToolName(tool_call.name);
  if (!toolName) {
    return {
      ok: false,
      error: 'invalid_tool_call',
      detail: 'tool_call.name must be a safe tool identifier',
    };
  }
  const args = _safeArguments(tool_call.arguments);
  if (!args.ok) {
    return {
      ok: false,
      error: 'invalid_tool_call',
      detail: args.error,
    };
  }
  if (!tool_registry
      || (typeof tool_registry.get !== 'function' && typeof tool_registry.has !== 'function')) {
    return {
      ok: false,
      error: 'tool_not_found',
      detail: 'no tool_registry supplied - registerTool() must be called first',
    };
  }
  const hasTool = typeof tool_registry.has === 'function'
    ? tool_registry.has(toolName)
    : (typeof tool_registry.get === 'function' && tool_registry.get(toolName) != null);
  if (!hasTool) {
    return {
      ok: false,
      error: 'tool_not_found',
      detail: `tool "${toolName}" not registered in this tenant's tool_registry`,
    };
  }
  const tool = typeof tool_registry.get === 'function'
    ? tool_registry.get(toolName)
    : null;
  if (!tool || typeof tool.handler !== 'function') {
    return {
      ok: false,
      error: 'tool_not_found',
      detail: `tool "${toolName}" entry has no handler function`,
    };
  }

  // Light auth-shape gate. The handler should re-validate - this is
  // defense-in-depth so misregistered tools fail loud before the handler
  // runs (cheaper to debug at this boundary than inside the handler).
  if (tool.auth_schema && Array.isArray(tool.auth_schema.required)) {
    const ctx = auth_context || {};
    const required = _safeRequiredFields(tool.auth_schema.required);
    const missing = required.filter((k) => !(k in ctx) || ctx[k] == null || ctx[k] === '');
    if (missing.length > 0) {
      return {
        ok: false,
        error: 'auth_failed',
        detail: `missing required auth_context fields: ${missing.join(',')}`,
      };
    }
  }

  // Invoke the handler. Caught exceptions become tool_threw envelopes - 
  // we NEVER propagate handler errors up. The capture-side audit log
  // gets a complete record of what failed.
  try {
    const result = await tool.handler({
      arguments: args.value,
      auth_context: auth_context || {},
      tool_call: { ...tool_call, name: toolName, arguments: args.value },
    });
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      error: 'tool_threw',
      detail: _safeDetail((e && e.message) ? e.message : String(e)),
    };
  }
}

// =============================================================================
// accumulateAcceptanceMetrics  (W735-4 honest measurement)
// =============================================================================

/**
 * Aggregate captures into the honest local-handling rate for the W735-4
 * "90% of tool-calling patterns locally" target.
 *
 * Inputs:
 *
 *   captures - full set considered (used for sample_size).
 *   n_handled_locally - how many were answered by the distilled
 *                              student without escalation.
 *   n_escalated_to_teacher - how many fell back to the teacher LLM.
 *
 * Output:
 *
 *   {
 *     sample_size:           Number,
 *     local_handling_rate:   Number | null,    // null when sample_size < 100
 *     target:                0.90,             // the W735-4 spec target
 *     honest_acceptance:     Number | null,    // null when sample_size < 100
 *     confidence_band_95:    {lo, hi} | null,  // Wilson CI when n >= 30
 *     reason:                String | undefined, // why we returned null
 *   }
 *
 * The HONEST CONTRACT is: when sample_size < 100, local_handling_rate is
 * `null` with reason `'insufficient_signal_n<100'`. We do not extrapolate
 * a 95% rate from 4/4 captures or a 50% rate from 1/2 captures.
 *
 * Wilson 95% confidence band is computed when sample_size ≥ 30 (rule of
 * thumb for the normal approximation to the binomial). Below that, the
 * confidence band is `null`.
 */
export function accumulateAcceptanceMetrics(opts) {
  const o = opts || {};
  const captures = Array.isArray(o.captures) ? o.captures : [];
  const sampleSize = (typeof o.sample_size === 'number' && o.sample_size > 0)
    ? _capCount(o.sample_size)
    : _capCount(captures.length);
  let handledLocally = _capCount(o.n_handled_locally);
  let escalated = _capCount(o.n_escalated_to_teacher);
  if (sampleSize > 0) {
    handledLocally = Math.min(handledLocally, sampleSize);
    escalated = Math.min(escalated, Math.max(0, sampleSize - handledLocally));
  }

  const out = {
    sample_size: sampleSize,
    n_handled_locally: handledLocally,
    n_escalated_to_teacher: escalated,
    target: 0.90,
    local_handling_rate: null,
    honest_acceptance: null,
    confidence_band_95: null,
  };

  if (sampleSize < ACCEPTANCE_MIN_SAMPLE) {
    out.reason = `insufficient_signal_n<${ACCEPTANCE_MIN_SAMPLE}`;
    return out;
  }

  // Honest denominator - we only count captures that actually attempted a
  // tool call (handled OR escalated). Captures with no tool intent don't
  // tell us anything about the local-handling rate.
  const denom = handledLocally + escalated;
  if (denom === 0) {
    out.reason = 'no_tool_calls_observed';
    return out;
  }

  const rate = handledLocally / denom;
  out.local_handling_rate = rate;
  out.honest_acceptance = rate;

  // Wilson 95% confidence interval for a binomial proportion.
  // z = 1.96; this gives the canonical 95% CI without normal approximation.
  //
  //   center    = (k + z²/2) / (n + z²)
  //   halfWidth = z · √(k(n-k)/n + z²/4) / (n + z²)
  //
  // Reference: Wilson EB (1927), "Probable inference, the law of succession,
  // and statistical inference". JASA 22(158):209-212.
  if (denom >= 30) {
    const z = 1.96;
    const z2 = z * z;
    const k = handledLocally;
    const n = denom;
    const center = (k + z2 / 2) / (n + z2);
    const halfWidth = (z * Math.sqrt(k * (n - k) / n + z2 / 4)) / (n + z2);
    out.confidence_band_95 = {
      lo: Math.max(0, center - halfWidth),
      hi: Math.min(1, center + halfWidth),
    };
  }

  return out;
}
