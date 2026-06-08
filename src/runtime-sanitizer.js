// src/runtime-sanitizer.js
//
// W762 - Adversarial Red-Team Framework: runtime input sanitizer.
//
// Closes KOLM_W707_SYSTEM_UPGRADE_PLAN.md W762-3 + W762-4:
//   3) Runtime input sanitization layer.
//   4) Fallback to teacher when input matches adversarial pattern.
//
// Shape: classifyPromptAdversarial() (W762-2) sits in front of every
// request. The sanitizer wraps a user-supplied handler with one of
// four policies, chosen by the operator at deploy time:
//
//   block - return 4xx-style envelope, NEVER forward
//   redact - strip matched spans, forward sanitized text
//   fallback_to_teacher - route adversarial requests to the W709
//                         entropy-aware confidence router (caller
//                         supplies fallback_handler). When no handler
//                         is configured, emit an honest
//                         no_fallback_handler_configured envelope - 
//                         we NEVER silently passthrough.
//   passthrough - record classification but forward unchanged.
//                         For honest A/B experiments only.
//
// W709 routing integration point: production wires
// fallback_handler = require('./confidence-routing.js').routeToTeacher
// so adversarial requests get re-routed to a teacher with stronger
// safety alignment. That wiring is done by the OPERATOR, never by
// this module (DI seam).

import { classifyPromptAdversarial } from './adversarial-prompts.js';

export const SANITIZER_VERSION = 'w762-v1';

export const SANITIZE_POLICIES = Object.freeze([
  'block',
  'redact',
  'fallback_to_teacher',
  'passthrough',
]);

export const DEFAULT_POLICY = 'fallback_to_teacher';

// Replace each matched span in `text` with `[REDACTED]`. Spans may
// overlap because multiple patterns can hit the same region - 
// we merge overlapping spans before substitution to avoid double
// replacements / index drift.
function _redactSpans(text, evidence) {
  if (!evidence || !evidence.length) return text;
  // Pull spans, sort by start asc.
  const spans = evidence
    .map((e) => Array.isArray(e.span) ? e.span : null)
    .filter((s) => Array.isArray(s) && s.length === 2 && Number.isFinite(s[0]) && Number.isFinite(s[1]))
    .sort((a, b) => a[0] - b[0]);
  if (!spans.length) return text;

  // Merge overlapping spans.
  const merged = [spans[0].slice()];
  for (let i = 1; i < spans.length; i++) {
    const last = merged[merged.length - 1];
    const cur = spans[i];
    if (cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      merged.push(cur.slice());
    }
  }

  // Substitute right-to-left to keep indices stable.
  let out = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const [s, e] = merged[i];
    if (s >= 0 && e <= out.length && s < e) {
      out = out.slice(0, s) + '[REDACTED]' + out.slice(e);
    }
  }
  return out;
}

// Main public API. Returns an envelope describing what we did and
// the consequence. NEVER throws - defensive try/catch in every branch
// because this sits on the request hot-path.
export async function sanitizeInput({
  text,
  policy = DEFAULT_POLICY,
  fallback_handler = null,
} = {}) {
  // Defensive input normalization.
  const inputText = typeof text === 'string' ? text : (text == null ? '' : String(text));

  // Validate policy. Unknown policies are NOT silently coerced - we
  // return an honest envelope so the operator notices the typo.
  if (!SANITIZE_POLICIES.includes(policy)) {
    return {
      ok: false,
      error: 'unknown_policy',
      hint: `policy must be one of: ${SANITIZE_POLICIES.join(', ')}`,
      version: SANITIZER_VERSION,
    };
  }

  // Run the classifier. classifyPromptAdversarial guarantees no
  // throw and a stable envelope shape.
  let classification;
  try {
    classification = classifyPromptAdversarial(inputText);
  } catch (e) {
    // Should be unreachable - classifier is supposed to NEVER throw.
    classification = {
      ok: false,
      is_adversarial: false,
      categories_matched: [],
      confidence: 0,
      evidence: [],
      classifier_error: String(e && e.message || e),
    };
  }

  // Benign input: passthrough regardless of policy.
  if (!classification.is_adversarial) {
    return {
      ok: true,
      action: 'allow',
      original: inputText,
      sanitized: inputText,
      classification,
      fallback_invoked: false,
      fallback_result: null,
      version: SANITIZER_VERSION,
    };
  }

  // Adversarial input - branch on policy.
  switch (policy) {
    case 'block':
      return {
        ok: true,
        action: 'block',
        original: inputText,
        sanitized: null,
        classification,
        fallback_invoked: false,
        fallback_result: null,
        version: SANITIZER_VERSION,
      };

    case 'redact': {
      const redacted = _redactSpans(inputText, classification.evidence);
      return {
        ok: true,
        action: 'redact',
        original: inputText,
        sanitized: redacted,
        classification,
        fallback_invoked: false,
        fallback_result: null,
        version: SANITIZER_VERSION,
      };
    }

    case 'fallback_to_teacher': {
      if (typeof fallback_handler !== 'function') {
        return {
          ok: false,
          error: 'no_fallback_handler_configured',
          hint: 'policy=fallback_to_teacher requires a fallback_handler callable wired to your W709 routing layer',
          classification,
          version: SANITIZER_VERSION,
        };
      }
      let fallbackResult = null;
      let fallbackError = null;
      try {
        fallbackResult = await fallback_handler({
          input: inputText,
          classification,
        });
      } catch (e) {
        fallbackError = String(e && e.message || e);
      }
      return {
        ok: fallbackError == null,
        action: 'fallback_to_teacher',
        original: inputText,
        sanitized: inputText,
        classification,
        fallback_invoked: true,
        fallback_result: fallbackResult,
        fallback_error: fallbackError,
        version: SANITIZER_VERSION,
      };
    }

    case 'passthrough':
    default:
      return {
        ok: true,
        action: 'passthrough',
        original: inputText,
        sanitized: inputText,
        classification,
        fallback_invoked: false,
        fallback_result: null,
        warning: 'adversarial input forwarded unchanged; configure block/redact/fallback_to_teacher for production',
        version: SANITIZER_VERSION,
      };
  }
}

// wrapForRuntime - turn an arbitrary request handler into a sanitizer-
// gated handler. The wrapped handler receives {sanitized, original,
// classification, sanitizer_action} as additional context.
//
// Returns a new async function: (request) => Promise<response>. The
// request must expose a `text` (or `input` / `prompt`) property the
// classifier can examine.
export function wrapForRuntime(handler, opts = {}) {
  if (typeof handler !== 'function') {
    throw new Error('wrapForRuntime requires a handler callable');
  }
  const policy = (opts && opts.policy) || DEFAULT_POLICY;
  const fallback_handler = opts && opts.fallback_handler ? opts.fallback_handler : null;

  return async function _sanitized(request) {
    const req = request || {};
    const text = (typeof req.text === 'string') ? req.text
      : (typeof req.input === 'string') ? req.input
      : (typeof req.prompt === 'string') ? req.prompt
      : '';
    const env = await sanitizeInput({ text, policy, fallback_handler });

    // Block / fallback / unknown-policy paths short-circuit - the
    // underlying handler is NEVER reached.
    if (env.action === 'block' || env.action === 'fallback_to_teacher' || env.error) {
      return {
        ok: env.ok,
        sanitizer_action: env.action || 'error',
        sanitizer: env,
        forwarded: false,
      };
    }

    // For allow / redact / passthrough, we forward with the sanitized
    // text in place of the original.
    const forwardReq = { ...req, text: env.sanitized, original_text: env.original };
    let inner;
    try {
      inner = await handler(forwardReq);
    } catch (e) {
      return {
        ok: false,
        sanitizer_action: env.action,
        sanitizer: env,
        forwarded: true,
        handler_error: String(e && e.message || e),
      };
    }
    return {
      ok: true,
      sanitizer_action: env.action,
      sanitizer: env,
      forwarded: true,
      response: inner,
    };
  };
}

export default {
  SANITIZER_VERSION,
  SANITIZE_POLICIES,
  DEFAULT_POLICY,
  sanitizeInput,
  wrapForRuntime,
};
