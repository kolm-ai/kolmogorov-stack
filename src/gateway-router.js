// W-B + W-E / wrapper-completion — gateway provider router with confidence-
// aware local-first dispatch and frontier fallback chain.
//
// Pulls together:
//   - src/provider-registry.js      (PROVIDERS table + resolveAdapter)
//   - src/capture.js                (forwardAnthropic / forwardOpenAI /
//                                    forwardOpenRouter — existing primitives)
//   - src/providers/*.js            (8 W-B adapters)
//   - src/pii-redactor.js           (4-mode applyMode)
//   - src/receipt-schema.js +
//     src/gateway-receipt.js        (kolm-audit-1 signed receipts)
//
// The 11-stage pipeline (auth → namespace → input-PII → route → forward →
// response → output-PII → sign → capture → meter → telemetry) is split
// across this module + the existing capture lake. Here we implement the
// dispatch + fallback half (steps 4-5-6), with hooks at 3/7/8 for the
// PII redactor + signer to plug into.
//
// Public surface:
//   - dispatchToProvider({provider, body, upstreamKey, ...}) -> result
//   - dispatchWithFallback({chain, body, ..., onAttempt?})  -> result
//   - selectRoute({namespaceConfig, confidence}) -> {provider, route_decision}
//   - shouldFallback(result) -> boolean
//
// Each result envelope has the SAME shape regardless of which adapter
// fired:
//   {
//     ok: boolean,                  // status < 500 AND status !== 429
//     status: number,               // raw HTTP status from the adapter
//     provider: string,             // resolved provider id
//     route_decision: 'local'|'frontier',
//     attempt: number,              // 1-based; 1 = primary, 2+ = fallbacks
//     fallback_reason?: string,     // why we left the previous attempt
//     elapsed_us: number,           // adapter-side latency
//     json: object | {_raw: string},
//   }

import { PROVIDERS, resolveAdapter } from './provider-registry.js';
import {
  forwardAnthropic,
  forwardOpenAI,
  forwardOpenRouter,
} from './capture.js';

// --------------------------------------------------------------------------
// Resolve an adapter for any of the 11 supported providers. We use the
// existing forwardX primitives for the providers that already had them
// (anthropic / openai / openrouter) so we don't duplicate cost basis,
// and dynamic-import the 8 W-B adapters for the others.
// --------------------------------------------------------------------------

const _LEGACY_ADAPTERS = {
  anthropic:  ({ url, body, upstreamKey }) => forwardAnthropic({ url, body, upstreamKey }),
  openai:     ({ url, body, upstreamKey }) => forwardOpenAI({ url, body, upstreamKey }),
  openrouter: ({ url, body, upstreamKey }) => forwardOpenRouter({ url, body, upstreamKey }),
};

async function _getForward(providerId) {
  if (_LEGACY_ADAPTERS[providerId]) return _LEGACY_ADAPTERS[providerId];
  const mod = await resolveAdapter(providerId);
  if (mod && typeof mod.forward === 'function') return mod.forward;
  return null;
}

// Pick the upstream URL for a provider. Adapters know their own default,
// but the namespace config can override (e.g. for self-hosted vLLM at
// http://10.0.0.5:8000/v1/chat/completions).
function _resolveUrl(providerId, override) {
  if (override) return override;
  const cfg = PROVIDERS[providerId];
  if (!cfg || !cfg.upstream) return null;
  // Default to the chat-completions path the most-used path table entry.
  // Anthropic uses /v1/messages; everything else uses /v1/chat/completions
  // (or the provider-specific variant Groq/Fireworks/Google use).
  if (providerId === 'anthropic') return `${cfg.upstream}/v1/messages`;
  if (providerId === 'google')    return `${cfg.upstream}/v1beta/openai/chat/completions`;
  if (providerId === 'groq')      return `${cfg.upstream}/openai/v1/chat/completions`;
  if (providerId === 'fireworks') return `${cfg.upstream}/inference/v1/chat/completions`;
  return `${cfg.upstream}/v1/chat/completions`;
}

// --------------------------------------------------------------------------
// dispatchToProvider — fire ONE attempt and shape the envelope.
// --------------------------------------------------------------------------

/**
 * dispatchToProvider — call exactly one upstream.
 *
 * @param provider  one of SUPPORTED_PROVIDER_IDS
 * @param body      raw request body (OpenAI-compat ChatCompletionsRequest)
 * @param upstreamKey  the customer's own provider key (may be null for
 *                     local-* providers)
 * @param url       optional URL override
 * @param route_decision  'local' (artifact path) or 'frontier' (network)
 *
 * Returns a shaped envelope (see top-of-file shape). Adapter throws are
 * caught and surfaced as ok:false / status:0 / json:{error:{...}}.
 */
export async function dispatchToProvider({
  provider,
  body,
  upstreamKey = null,
  url = null,
  route_decision = 'frontier',
  attempt = 1,
  fallback_reason = null,
} = {}) {
  const fwd = await _getForward(provider);
  if (!fwd) {
    return {
      ok: false,
      status: 501,
      provider,
      route_decision,
      attempt,
      fallback_reason,
      elapsed_us: 0,
      json: {
        error: {
          type: 'provider_not_wired',
          message: `gateway-router: no forward() adapter resolved for provider "${provider}"`,
        },
      },
    };
  }
  const target = _resolveUrl(provider, url);
  const t0 = process.hrtime.bigint();
  let raw;
  try {
    raw = await fwd({ url: target, body, upstreamKey });
  } catch (e) {
    const elapsed_us = Math.round(Number(process.hrtime.bigint() - t0) / 1000);
    return {
      ok: false,
      status: 0,
      provider,
      route_decision,
      attempt,
      fallback_reason,
      elapsed_us,
      json: {
        error: {
          type: 'transport_error',
          message: e && e.message ? String(e.message) : String(e),
        },
      },
    };
  }
  const status = Number(raw && raw.status) || 0;
  const ok = status > 0 && status < 500 && status !== 429;
  const elapsed_us = (raw && raw.elapsed_us)
    || Math.round(Number(process.hrtime.bigint() - t0) / 1000);
  return {
    ok,
    status,
    provider,
    route_decision,
    attempt,
    fallback_reason,
    elapsed_us,
    json: (raw && raw.json) || {},
  };
}

// --------------------------------------------------------------------------
// shouldFallback — the predicate that decides "advance to the next chain
// entry on this failure". Mirrors the fallback contract in the wrapper
// spec (timeout / 429 / 5xx → fallback chain).
// --------------------------------------------------------------------------

const _FALLBACK_REASON_BY_STATUS = (status) => {
  if (status === 429) return 'upstream_429';
  if (status >= 500 && status < 600) return 'upstream_5xx';
  if (status === 0) return 'upstream_timeout';
  return null;
};

export function shouldFallback(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.ok === true) return false;
  return _FALLBACK_REASON_BY_STATUS(result.status) !== null;
}

// --------------------------------------------------------------------------
// dispatchWithFallback — run through a chain of [{provider, upstreamKey,
// url?, route_decision?}] entries until one succeeds or we exhaust them.
// --------------------------------------------------------------------------

/**
 * dispatchWithFallback — walk a fallback chain.
 *
 * @param chain       Array of dispatch entries. Each entry needs at least
 *                    {provider}; optionally url, upstreamKey, route_decision.
 * @param body        OpenAI-compat request body.
 * @param onAttempt   Optional callback fired after each attempt with the
 *                    attempt's shaped envelope. The gateway uses this to
 *                    write per-attempt rows to the capture lake even when
 *                    only the final success row ships back to the client.
 *
 * Returns the LAST envelope (success on first success, or final failure
 * envelope if every entry failed). The envelope's `attempt` field tells
 * the caller how many tries it took; `fallback_reason` on attempt > 1
 * names why we left the previous entry.
 */
export async function dispatchWithFallback({
  chain,
  body,
  onAttempt = null,
} = {}) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return {
      ok: false,
      status: 400,
      provider: null,
      route_decision: 'frontier',
      attempt: 0,
      fallback_reason: 'empty_chain',
      elapsed_us: 0,
      json: {
        error: { type: 'empty_chain', message: 'gateway-router: dispatchWithFallback requires non-empty chain' },
      },
    };
  }
  let lastResult = null;
  let lastReason = null;
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i] || {};
    const result = await dispatchToProvider({
      provider:       entry.provider,
      body,
      upstreamKey:    entry.upstreamKey || null,
      url:            entry.url || null,
      route_decision: entry.route_decision || 'frontier',
      attempt:        i + 1,
      fallback_reason: i === 0 ? null : lastReason,
    });
    if (typeof onAttempt === 'function') {
      try { onAttempt(result); } catch (_) { /* never break the chain on callback error */ }
    }
    lastResult = result;
    if (result.ok) return result;
    if (!shouldFallback(result)) return result;
    lastReason = _FALLBACK_REASON_BY_STATUS(result.status) || 'unknown';
  }
  return lastResult;
}

// --------------------------------------------------------------------------
// selectRoute — decide whether this namespace should attempt LOCAL first
// (W807 ConfidenceRouter) or go straight to FRONTIER. The decision plus
// the resolved provider id becomes the first entry in the chain.
// --------------------------------------------------------------------------

/**
 * selectRoute — apply the ConfidenceRouter (W807) policy.
 *
 * @param namespaceConfig  per-namespace gateway.toml config:
 *                         { primary: 'local:trinity-500'|'anthropic:claude-...',
 *                           fallback: ['anthropic:claude-...', 'openai:gpt-4o-mini'],
 *                           confidence_threshold: 0.7 }
 * @param confidence       optional pre-scored confidence (0..1). When
 *                         undefined we don't second-guess the namespace's
 *                         primary — the local artifact will score itself
 *                         inside its own forward() and the result may
 *                         later trigger fallback via shouldFallback.
 *
 * Returns { route_decision: 'local'|'frontier', provider, model, threshold }.
 */
export function selectRoute({ namespaceConfig, confidence } = {}) {
  const cfg = namespaceConfig || {};
  const threshold = typeof cfg.confidence_threshold === 'number'
    ? cfg.confidence_threshold
    : 0.7;
  const primary = String(cfg.primary || '');
  const [primaryProvider, ...modelParts] = primary.split(':');
  const primaryModel = modelParts.join(':');
  const isLocal = primaryProvider === 'local' || /^local-/.test(primaryProvider);
  const route_decision = isLocal ? 'local' : 'frontier';

  // Pre-scored override: if the caller already has a confidence score
  // (e.g. last-call moving average), short-circuit when it's below the
  // threshold — go straight to frontier without firing the local first.
  if (isLocal && typeof confidence === 'number' && confidence < threshold) {
    const fb = parseChainEntry((cfg.fallback || [])[0] || '');
    return {
      route_decision: 'frontier',
      provider: fb.provider || 'openai',
      model: fb.model || '',
      threshold,
      pre_routed_to_fallback: true,
      fallback_reason: 'low_confidence_prior',
    };
  }

  return {
    route_decision,
    provider: isLocal ? `local-${primaryProvider === 'local' ? 'kolm' : primaryProvider.replace(/^local-/, '')}` : primaryProvider,
    model: primaryModel,
    threshold,
    pre_routed_to_fallback: false,
  };
}

// Parse a chain entry like "anthropic:claude-opus-4-7" into {provider, model}.
export function parseChainEntry(s) {
  const str = String(s || '');
  if (!str.includes(':')) return { provider: str, model: '' };
  const [provider, ...modelParts] = str.split(':');
  // local:<artifact> resolves to provider id 'local-kolm'
  if (provider === 'local') return { provider: 'local-kolm', model: modelParts.join(':') };
  return { provider, model: modelParts.join(':') };
}

// Build the full chain for the gateway pipeline from a namespace config.
// Returns [{provider, model, route_decision, upstreamKey?}, ...] suitable
// for dispatchWithFallback. The caller (gateway middleware) fills in
// upstreamKey by reading the per-tenant key vault.
export function buildChainFromNamespace(namespaceConfig) {
  const cfg = namespaceConfig || {};
  const chain = [];
  const primary = parseChainEntry(cfg.primary || '');
  if (primary.provider) {
    chain.push({
      provider: primary.provider,
      model: primary.model,
      route_decision: primary.provider.startsWith('local') ? 'local' : 'frontier',
    });
  }
  for (const f of (cfg.fallback || [])) {
    const e = parseChainEntry(f);
    if (e.provider) {
      chain.push({
        provider: e.provider,
        model: e.model,
        route_decision: e.provider.startsWith('local') ? 'local' : 'frontier',
      });
    }
  }
  return chain;
}
