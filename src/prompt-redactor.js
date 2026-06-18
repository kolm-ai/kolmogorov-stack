// src/prompt-redactor.js
//
// W765 - Prompt Extraction Defense: build-time system-prompt redactor.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 582-586):
//   [W765-1] System prompt obfuscation during distillation (behavior not literal text)
//
// Design contract:
//   - PURE JS. No model files, no Python, no native deps. Heavy ML stays
//     OUT - paraphrase intentionally returns an honest envelope when a
//     teacher caller isn't wired, rather than hallucinating a fake
//     paraphrase from a rule engine.
//   - HONESTY FLOOR: when a strategy cannot run (e.g. paraphrase without
//     a teacher), we return {ok:false, error:..., hint:...}. NEVER silently
//     return the literal system prompt unchanged.
//   - SEPARATION OF CONCERNS: this module is a PURE library. The W765
//     spec is explicit that wiring this into src/distill-pipeline.js is a
//     follow-up ship - distill-pipeline.js is FORBIDDEN territory for
//     this wave's editor (parallel wave conflicts).
//   - DEFENSE-LAYER ROLE: this is the BUILD-TIME half of the W765
//     defense. The RUNTIME half lives in src/extraction-guard.js. Both
//     halves are needed; neither alone is sufficient.
//
// Public surface:
//   - PROMPT_REDACTOR_VERSION
//   - REDACTION_STRATEGIES                       (Object.freeze)
//   - redactSystemPrompt({system_prompt, strategy, allow_list})
//   - prepareForDistillation({captures, strategy})

import crypto from 'node:crypto';

export const PROMPT_REDACTOR_VERSION = 'w765-v1';

// The four redaction strategies the W765 spec pins. Frozen so tests can
// assert the contract and downstream callers cannot mutate the taxonomy.
export const REDACTION_STRATEGIES = Object.freeze([
  'placeholder',
  'paraphrase',
  'remove_literal_constraints',
  'extract_behavior_only',
]);

// ---------------------------------------------------------------------------
// Concrete-string detectors.
//
// These power the `placeholder` strategy. Order matters - more specific
// patterns must run before more generic ones (URLs before plain "https",
// emails before plain words containing '@', etc.). Each producer returns
// {pattern, kind} so the redactor can emit [PLACEHOLDER:<kind>] tokens.
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS = Object.freeze([
  // API keys / secrets - match common token shapes (sk_, pk_, ks_, AKIA, ghp_,
  // tok_, key_, secret_). Conservative: 16+ chars in the trailing body to avoid
  // false positives. Allows multi-segment prefixes like sk_live_<body> (Stripe).
  { kind: 'API_KEY', re: /\b(?:sk|pk|ks|ghp|gho|ghu|ghs|tok|key|secret|api[_-]?key)[_-](?:[A-Za-z0-9]+[_-])?[A-Za-z0-9]{16,}\b/g },
  // AWS-style access keys (AKIA + 16 chars).
  { kind: 'API_KEY', re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Bearer tokens.
  { kind: 'API_KEY', re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
  // UUIDs.
  { kind: 'UUID', re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
  // URLs (http/https) - placed BEFORE bare-domain matching so a full URL
  // is captured as URL not as DOMAIN.
  { kind: 'URL', re: /\bhttps?:\/\/[^\s<>"'`]+/g },
  // Email addresses.
  { kind: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // Phone numbers (loose: + and 7+ digits).
  { kind: 'PHONE', re: /\+?\d[\d\s().-]{7,}\d/g },
  // Quoted concrete names (single or double quotes around 2+ words, e.g.
  // company names, product names). Conservative to avoid eating
  // legitimate quoted technical terms.
  { kind: 'NAME', re: /"[A-Z][A-Za-z0-9 .&-]{2,40}"/g },
  // Bare domains (e.g. "kolm.ai", "example.com") - last because the URL
  // pattern above already grabs full URLs.
  { kind: 'DOMAIN', re: /\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}\b/g },
]);

// ---------------------------------------------------------------------------
// Literal-constraint patterns.
//
// These power `remove_literal_constraints`. The goal is to strip phrases
// that pin EXACT output strings into the prompt - those phrases imprint
// onto distilled weights in a way that makes the literal trivially
// recoverable from the student. Behavior-level instructions ("be polite",
// "answer concisely") are deliberately NOT stripped - those describe
// behavior, not literal text.
// ---------------------------------------------------------------------------

const LITERAL_CONSTRAINT_PATTERNS = Object.freeze([
  // "respond with exactly ..." / "respond with exactly the following: ..."
  { kind: 'respond_with_exactly', re: /respond\s+with\s+exactly[^.!?]*[.!?]/gi },
  // "always respond with ..."
  { kind: 'always_respond_with', re: /always\s+respond\s+with[^.!?]*[.!?]/gi },
  // "output exactly ..."
  { kind: 'output_exactly', re: /output\s+exactly[^.!?]*[.!?]/gi },
  // "your response must be exactly ..."
  { kind: 'response_must_be_exactly', re: /your\s+response\s+must\s+be\s+exactly[^.!?]*[.!?]/gi },
  // "say verbatim ..."
  { kind: 'say_verbatim', re: /say\s+verbatim[^.!?]*[.!?]/gi },
  // "the answer is ..." (when followed by quoted literal)
  { kind: 'the_answer_is', re: /the\s+answer\s+is\s+["'][^"']*["']/gi },
  // "you must say ..."
  { kind: 'you_must_say', re: /you\s+must\s+say[^.!?]*[.!?]/gi },
  // Block of quoted literal directly after "with" or "as" or "saying"
  { kind: 'quoted_literal_directive', re: /(?:with|as|saying)\s+["']([^"']{8,})["']/gi },
]);

// ---------------------------------------------------------------------------
// Imperative verbs we recognize for behavior extraction.
//
// `extract_behavior_only` walks sentences, finds imperative verbs, and
// emits a behavior summary that names only the VERB and a generalized
// TARGET (e.g. "user", "request", "data") - never the literal target
// from the source prompt. This is the strongest redaction strategy
// because no literal token survives.
// ---------------------------------------------------------------------------

const IMPERATIVE_VERBS = Object.freeze([
  'answer', 'reply', 'respond', 'explain', 'describe', 'summarize',
  'translate', 'classify', 'extract', 'identify', 'analyze', 'evaluate',
  'list', 'enumerate', 'compare', 'contrast', 'rank', 'sort',
  'refuse', 'decline', 'ignore', 'avoid', 'never', 'always',
  'be', 'act', 'behave', 'remain', 'stay',
  'use', 'apply', 'follow', 'enforce',
  'provide', 'give', 'return', 'output', 'produce',
  'check', 'verify', 'validate', 'confirm',
  'help', 'assist', 'support', 'guide',
  'maintain', 'preserve', 'protect',
  'cite', 'reference', 'attribute',
]);

// Map specific verbs to a generalized behavior class so the output looks
// less like the input (e.g. "translate to French" → "perform translation"
// instead of "translate"). Falls back to the verb itself when not mapped.
const BEHAVIOR_CLASSES = Object.freeze({
  translate: 'perform translation',
  classify: 'perform classification',
  extract: 'perform extraction',
  summarize: 'perform summarization',
  analyze: 'perform analysis',
  evaluate: 'perform evaluation',
  answer: 'answer questions',
  reply: 'reply to messages',
  respond: 'reply to messages',
  explain: 'provide explanations',
  describe: 'provide descriptions',
  refuse: 'refuse out-of-scope requests',
  decline: 'decline out-of-scope requests',
  ignore: 'ignore irrelevant content',
  cite: 'cite sources',
  reference: 'cite sources',
  attribute: 'cite sources',
  help: 'assist the user',
  assist: 'assist the user',
  support: 'assist the user',
  guide: 'assist the user',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _tokenDigest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function _removedToken(kind, value) {
  return {
    kind: String(kind || 'unknown').slice(0, 80),
    sha256: _tokenDigest(value),
    length: String(value || '').length,
  };
}

function _normalizeAllowList(allow_list) {
  if (!Array.isArray(allow_list)) return [];
  return allow_list
    .filter((x) => typeof x === 'string' && x.length > 0)
    .map((s) => s);
}

// Walk the placeholder pattern table. Returns
// {redacted, removed_tokens:[{kind, sha256, length}]}.
function _applyPlaceholderStrategy(text, allow_list) {
  const allow = _normalizeAllowList(allow_list);
  const removed_tokens = [];
  let redacted = text;
  for (const { kind, re } of PLACEHOLDER_PATTERNS) {
    redacted = redacted.replace(re, (match) => {
      // Honor allow_list - caller can pin specific concrete strings
      // (e.g. a public docs URL) that should NOT be redacted.
      if (allow.includes(match)) return match;
      removed_tokens.push(_removedToken(kind, match));
      return '[PLACEHOLDER:' + kind + ']';
    });
  }
  return { redacted, removed_tokens };
}

// Walk literal-constraint pattern table. Returns
// {redacted, removed_tokens:[{kind, sha256, length}]}.
function _applyRemoveLiteralConstraintsStrategy(text) {
  const removed_tokens = [];
  let redacted = text;
  for (const { kind, re } of LITERAL_CONSTRAINT_PATTERNS) {
    redacted = redacted.replace(re, (match) => {
      removed_tokens.push(_removedToken(kind, match));
      return '[REDACTED:' + kind + ']';
    });
  }
  return { redacted, removed_tokens };
}

// Walk sentences, find imperative verbs, emit behavior summary.
// Returns ONLY a behavior description - NEVER literal content from
// the input. removed_tokens carries only hashes of matched verbs.
function _applyExtractBehaviorOnlyStrategy(text) {
  const removed_tokens = [];
  const sentences = String(text || '').split(/[.!?\n]/).map((s) => s.trim()).filter(Boolean);
  const behaviors = new Set();
  for (const sent of sentences) {
    const tokens = sent.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    for (const tok of tokens) {
      if (IMPERATIVE_VERBS.includes(tok)) {
        const cls = BEHAVIOR_CLASSES[tok] || tok;
        behaviors.add(cls);
        removed_tokens.push(_removedToken('behavior_verb', tok));
      }
    }
  }
  if (behaviors.size === 0) {
    // No imperatives detected - emit a placeholder behavior summary
    // so the output is NEVER the literal input.
    return {
      redacted: '[BEHAVIOR:assist_user_with_requests]',
      removed_tokens,
    };
  }
  const list = Array.from(behaviors).slice(0, 16);
  return {
    redacted: 'System behavior: ' + list.join('; ') + '.',
    removed_tokens,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * redactSystemPrompt - apply a named redaction strategy to a system
 * prompt before distillation.
 *
 * Strategies:
 *   - 'placeholder' - replace concrete strings (API keys,
 *                                     URLs, names, emails, UUIDs) with
 *                                     `[PLACEHOLDER:<KIND>]` tokens.
 *   - 'paraphrase' - HONESTY envelope. Real paraphrase
 *                                     requires a teacher caller (LLM).
 *                                     We do NOT fake paraphrasing.
 *   - 'remove_literal_constraints' - strip explicit "respond with
 *                                     exactly..." patterns.
 *   - 'extract_behavior_only' - return ONLY a rule-based behavior
 *                                     description. NO literal content
 *                                     from the input survives.
 *
 * Returns {ok:true, version, strategy, original_length, redacted_length,
 *          redacted_prompt, removed_tokens:[]}.
 *
 * Honesty invariant: NEVER returns the literal system prompt unchanged
 * in any strategy other than allow_list passthrough.
 */
export function redactSystemPrompt({
  system_prompt,
  strategy = 'extract_behavior_only',
  allow_list = [],
} = {}) {
  if (typeof system_prompt !== 'string') {
    return {
      ok: false,
      error: 'system_prompt_required',
      hint: 'pass {system_prompt: "<string>", strategy?, allow_list?}',
      version: PROMPT_REDACTOR_VERSION,
    };
  }
  if (!REDACTION_STRATEGIES.includes(strategy)) {
    return {
      ok: false,
      error: 'unknown_strategy',
      hint: 'strategy must be one of ' + JSON.stringify(REDACTION_STRATEGIES),
      version: PROMPT_REDACTOR_VERSION,
    };
  }

  const original_length = system_prompt.length;

  if (strategy === 'paraphrase') {
    // HONESTY CONTRACT: paraphrase requires an LLM. We do NOT fake it
    // with a rule engine - a faked paraphrase would silently leak
    // literal phrases the rules don't recognize.
    return {
      ok: false,
      error: 'paraphrase_requires_teacher_caller',
      hint: 'Set redactor_caller for LLM-based paraphrase. ' +
        'A faked rule-based paraphrase would silently leak literal phrases.',
      version: PROMPT_REDACTOR_VERSION,
      strategy,
      original_length,
    };
  }

  let result;
  if (strategy === 'placeholder') {
    result = _applyPlaceholderStrategy(system_prompt, allow_list);
  } else if (strategy === 'remove_literal_constraints') {
    result = _applyRemoveLiteralConstraintsStrategy(system_prompt);
  } else /* extract_behavior_only */ {
    result = _applyExtractBehaviorOnlyStrategy(system_prompt);
  }

  return {
    ok: true,
    version: PROMPT_REDACTOR_VERSION,
    strategy,
    original_length,
    redacted_length: result.redacted.length,
    redacted_prompt: result.redacted,
    removed_tokens: result.removed_tokens,
  };
}

/**
 * prepareForDistillation - apply redactSystemPrompt to every capture's
 * system_prompt field. Returns a batch envelope with redacted rows +
 * processed_count + unchanged_count (rows that had no system_prompt).
 *
 * This is the PRE-PROCESSOR a distill pipeline COULD call before sending
 * captures to a teacher / student. Wiring into src/distill-pipeline.js
 * is a follow-up ship (FORBIDDEN territory for the W765 editor).
 */
export function prepareForDistillation({
  captures,
  strategy = 'extract_behavior_only',
} = {}) {
  if (!Array.isArray(captures)) {
    return {
      ok: false,
      error: 'captures_required',
      hint: 'pass {captures: [...rows], strategy?}',
      version: PROMPT_REDACTOR_VERSION,
    };
  }
  const redacted_rows = [];
  let processed_count = 0;
  let unchanged_count = 0;
  for (const row of captures) {
    const r = row && typeof row === 'object' ? { ...row } : { _original: row };
    const sp = r.system_prompt;
    if (typeof sp === 'string' && sp.length > 0) {
      const env = redactSystemPrompt({ system_prompt: sp, strategy });
      if (env && env.ok) {
        r.system_prompt = env.redacted_prompt;
        r.system_prompt_redacted = true;
        r.system_prompt_redaction_strategy = strategy;
        r.system_prompt_removed_tokens = env.removed_tokens;
        processed_count++;
      } else {
        // Could not redact (e.g. paraphrase without teacher) - keep the
        // honesty envelope on the row so a downstream consumer can SEE
        // that redaction failed and decide whether to drop the row.
        r.system_prompt_redacted = false;
        r.system_prompt_redaction_error = env && env.error;
        unchanged_count++;
      }
    } else {
      unchanged_count++;
    }
    redacted_rows.push(r);
  }
  return {
    ok: true,
    version: PROMPT_REDACTOR_VERSION,
    strategy,
    processed_count,
    unchanged_count,
    redacted_rows,
  };
}
