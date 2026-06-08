// src/extraction-guard.js
//
// W765 - Prompt Extraction Defense: runtime extraction-attempt guard.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 582-586):
//   [W765-2] Runtime guardrails that detect/block extraction attempts
//
// Design contract:
//   - PURE JS regex. NEVER throws on any input. Heavy ML stays OUT - 
//     this is a fast first line of defense in the request pipeline.
//   - HONESTY FLOOR: guardRuntimeRequest NEVER silent-passes a matched
//     attempt. If a match fires and policy is `block` / `log_and_block`
//     / `redirect_to_safe_response`, the action is one of those three - 
//     we never quietly let it through.
//   - DEFENSE LAYERING with W762: W762 (src/adversarial-prompts.js)
//     also catches "ignore previous instructions" via its
//     classifyPromptAdversarial heuristic. W765 catching the same
//     pattern is INTENTIONAL - defense in depth. The two modules cover
//     different threat surfaces (W762 is a broader red-team
//     classifier; W765 is system-prompt-extraction-specific) so
//     overlapping matches are correct, not a bug.
//
// Public surface:
//   - EXTRACTION_GUARD_VERSION
//   - EXTRACTION_PATTERNS                        (Object.freeze)
//   - POLICIES                                   (Object.freeze)
//   - detectExtractionAttempt(text)
//   - guardRuntimeRequest({request_text, policy})

export const EXTRACTION_GUARD_VERSION = 'w765-v1';

// ---------------------------------------------------------------------------
// Extraction-attempt pattern catalog.
//
// 10+ frozen named regex patterns covering the most common shapes of
// system-prompt extraction attacks documented in public security
// research (OWASP LLM Top 10 - "LLM06: Sensitive Information
// Disclosure", and the prompt-injection taxonomy literature).
//
// Naming convention: `<family>_<flavor>` so audit logs and detection
// envelopes can tell operators WHICH pattern fired without leaking the
// regex itself. The patterns themselves stay frozen so a downstream
// caller cannot mutate the contract by accident.
// ---------------------------------------------------------------------------

export const EXTRACTION_PATTERNS = Object.freeze([
  {
    name: 'ask_initial_instructions',
    re: /what\s+(?:were|are)\s+your\s+(?:initial|original|system)\s+(?:instructions|prompt)/i,
  },
  {
    name: 'repeat_text_above',
    re: /repeat\s+(?:the\s+)?(?:text|content)\s+(?:above|before\s+this|that\s+was)\s+(?:starting|beginning)\s+with/i,
  },
  {
    name: 'ignore_previous_instructions',
    re: /ignore\s+(?:all\s+)?(?:previous|prior|earlier)\s+(?:instructions|messages)/i,
  },
  {
    name: 'ask_system_prompt',
    re: /what\s+(?:is|was)\s+your\s+(?:system\s+)?(?:prompt|preamble)/i,
  },
  {
    name: 'tell_me_your_instructions',
    re: /tell\s+me\s+your\s+(?:instructions|prompt|preamble|constitution)/i,
  },
  {
    name: 'inject_role_marker_im_start',
    re: /<\|im_start\|>\s*system/i,
  },
  {
    name: 'inject_pseudo_xml_role',
    re: /<\/?\s*(?:system|instructions?|preamble)\s*>/i,
  },
  {
    name: 'reveal_system_prompt',
    re: /(?:reveal|disclose|share|show)\s+your\s+(?:system|original)\s+(?:prompt|instructions)/i,
  },
  {
    name: 'verbatim_prompt_request',
    // requires both "verbatim" and one of (prompt|instructions|preamble)
    // anywhere in the text. Two passes so we don't need a heavy regex.
    re: /verbatim/i,
    co_re: /(?:prompt|instructions|preamble)/i,
  },
  {
    name: 'base64_extraction_token',
    // base64-encoded "system" → "c3lzdGVt", "instructions" → "aW5zdHJ1Y3Rpb25z"
    re: /\b(?:c3lzdGVt|aW5zdHJ1Y3Rpb25z|cHJvbXB0|cHJlYW1ibGU)\b/i,
  },
  {
    name: 'dump_context',
    re: /(?:dump|print|output|display)\s+(?:your\s+)?(?:full\s+)?(?:context|memory|history)/i,
  },
  {
    name: 'forget_above',
    re: /(?:forget|disregard)\s+(?:everything\s+)?(?:above|prior|before)/i,
  },
]);

// ---------------------------------------------------------------------------
// Policies the runtime guard understands.
//
// Frozen so tests can assert the contract. The W765 spec pins exactly
// these four - the default `log_and_block` combines an audit log entry
// with a blocked action so operators can SEE attempted extractions
// while still refusing them.
// ---------------------------------------------------------------------------

export const POLICIES = Object.freeze([
  'block',
  'log_only',
  'redirect_to_safe_response',
  'log_and_block',
]);

// Default safe-response copy. Operators can override at the route layer.
const DEFAULT_RECOMMENDED_RESPONSE = 'I cannot share my system prompt.';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * detectExtractionAttempt - pure regex pass over `text`. Returns:
 *
 *   {
 *     ok: true,
 *     version,
 *     is_extraction_attempt: Boolean,
 *     confidence: 0..1,
 *     patterns_matched: [{pattern_name, span:[start,end], evidence}]
 *   }
 *
 * Confidence scales with the number of distinct pattern families that
 * fire. NEVER throws - bad input returns is_extraction_attempt:false
 * with an honest empty patterns_matched array.
 */
export function detectExtractionAttempt(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return {
      ok: true,
      version: EXTRACTION_GUARD_VERSION,
      is_extraction_attempt: false,
      confidence: 0,
      patterns_matched: [],
    };
  }
  const patterns_matched = [];
  for (const p of EXTRACTION_PATTERNS) {
    let m;
    try {
      m = p.re.exec(text);
    } catch (_) {
      m = null;
    }
    if (!m) continue;
    // Two-pass families (verbatim + co_re) - require both hits.
    if (p.co_re) {
      let mm;
      try {
        mm = p.co_re.exec(text);
      } catch (_) {
        mm = null;
      }
      if (!mm) continue;
    }
    const start = m.index;
    const end = m.index + m[0].length;
    patterns_matched.push({
      pattern_name: p.name,
      span: [start, end],
      evidence: text.slice(start, end),
    });
  }
  const is_extraction_attempt = patterns_matched.length > 0;
  // Confidence: 1 family → 0.6, 2 → 0.8, 3+ → 0.95. Caps at 0.95 because
  // even a 3-pattern hit isn't ground truth - a sophisticated attacker
  // could craft novel patterns we don't recognize, so we never report 1.0.
  let confidence = 0;
  if (patterns_matched.length === 1) confidence = 0.6;
  else if (patterns_matched.length === 2) confidence = 0.8;
  else if (patterns_matched.length >= 3) confidence = 0.95;
  return {
    ok: true,
    version: EXTRACTION_GUARD_VERSION,
    is_extraction_attempt,
    confidence,
    patterns_matched,
  };
}

/**
 * guardRuntimeRequest - wrap detectExtractionAttempt with a policy
 * decision. Returns:
 *
 *   {
 *     ok: true,
 *     version,
 *     action: 'block' | 'log_only' | 'redirect_to_safe_response' | 'pass',
 *     detection: <detectExtractionAttempt envelope>,
 *     recommended_response?: '...',
 *     logged?: true
 *   }
 *
 * Honesty invariant: if detection.is_extraction_attempt is TRUE, action
 * is NEVER 'pass'. Even under policy='log_only' we still record the
 * attempt - silent passthrough on a matched attack would defeat the
 * purpose of the guard.
 */
export function guardRuntimeRequest({
  request_text,
  policy = 'log_and_block',
} = {}) {
  if (!POLICIES.includes(policy)) {
    return {
      ok: false,
      error: 'unknown_policy',
      hint: 'policy must be one of ' + JSON.stringify(POLICIES),
      version: EXTRACTION_GUARD_VERSION,
    };
  }
  const detection = detectExtractionAttempt(request_text);
  if (!detection.is_extraction_attempt) {
    // No attempt detected - pass through.
    return {
      ok: true,
      version: EXTRACTION_GUARD_VERSION,
      action: 'pass',
      detection,
    };
  }
  // Attempt detected - apply policy.
  if (policy === 'block') {
    return {
      ok: true,
      version: EXTRACTION_GUARD_VERSION,
      action: 'block',
      detection,
      recommended_response: DEFAULT_RECOMMENDED_RESPONSE,
    };
  }
  if (policy === 'log_only') {
    return {
      ok: true,
      version: EXTRACTION_GUARD_VERSION,
      action: 'log_only',
      detection,
      logged: true,
    };
  }
  if (policy === 'redirect_to_safe_response') {
    return {
      ok: true,
      version: EXTRACTION_GUARD_VERSION,
      action: 'redirect_to_safe_response',
      detection,
      recommended_response: DEFAULT_RECOMMENDED_RESPONSE,
    };
  }
  // log_and_block (default) - combine both for production. The action
  // is BLOCK (we refuse to serve the request) AND logged:true so
  // operators can see the attempt in audit logs.
  return {
    ok: true,
    version: EXTRACTION_GUARD_VERSION,
    action: 'block',
    detection,
    recommended_response: DEFAULT_RECOMMENDED_RESPONSE,
    logged: true,
  };
}
