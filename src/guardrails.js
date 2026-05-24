// W736 — Guardrail Compilation.
//
// Purpose
// -------
// Tenants declare brand-safety rules at capture time (`never recommend
// competitor products`, `block PII patterns`, `rewrite price quotes that
// reference USD into EUR`). The rules ride INSIDE the .kolm artifact as
// hard constraints, NOT as training signal. That distinction is load-
// bearing:
//
//   * Training signal = soft. The student learns the policy approximately;
//     a sufficiently adversarial prompt at runtime can still elicit the
//     forbidden output.
//   * Hard constraint = bound at artifact build time, replayed at every
//     /v1/chat/completions response, and re-checked at `kolm verify` time
//     against the artifact's example traces.
//
// Why a separate module
// ---------------------
// `src/router.js` calls enforceGuardrails on every model response; mixing
// this logic into the runtime hot path would bloat the router file and
// make the guardrail surface untestable in isolation. Keeping it here
// also means the same module powers (a) the runtime fence, (b) the
// `kolm verify --guardrails` replay, and (c) the `kolm guardrails test`
// CLI dry-run. One source of truth, three callers.
//
// Honesty contract
// ----------------
// validateGuardrailRules returns { ok:false, errors:[] } with snake_case
// codes — never throws. The runtime fence returns the canonical
// `blocked_by_guardrail` envelope on a `block` action; warn/rewrite
// actions pass the response through with an annotation so the caller
// can surface "we substituted X for Y" or "this response tripped rule N"
// in UI. Rule pattern compilation is cached via a Map keyed on the
// canonical serialised rules string so a hot-path POST does not re-
// compile the same regex set on every request.

import crypto from 'node:crypto';

export const GUARDRAILS_VERSION = 'w736-v1';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const ALLOWED_ACTIONS = new Set(['block', 'warn', 'rewrite']);

// Glob → RegExp translation. We support the subset shells actually use:
//   *   any-chars (no newline)
//   ?   single char
//   [a-z] character class
// Everything else is escaped so a literal `.` in a glob does not become
// "match any char" by accident.
function globToRegex(g) {
  let out = '';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*') { out += '.*'; i++; continue; }
    if (c === '?') { out += '.'; i++; continue; }
    if (c === '[') {
      // copy raw character class through unchanged (caller's burden)
      let j = i;
      while (j < g.length && g[j] !== ']') j++;
      out += g.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // Escape every regex meta char so the glob behaves literally.
    if (/[.+^${}()|\\]/.test(c)) {
      out += '\\' + c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ----------------------------------------------------------------------------
// Rule parser
// ----------------------------------------------------------------------------
//
// A rule is { name, pattern, action }. Pattern accepts three forms — keyword,
// glob, or raw regex (the bare string is treated as a regex). Action is one
// of block/warn/rewrite. Rewrite rules MAY carry a `replacement` field; the
// default replacement is `[redacted]` so an honest rewrite is observable.
//
// parseGuardrailRules returns the raw array unchanged when valid (so callers
// can pass the result straight back into enforceGuardrails). It throws on
// non-array input — that path is reserved for "developer literally passed
// the wrong type"; tenant input goes through validateGuardrailRules below.

export function parseGuardrailRules(rules) {
  if (rules === null || rules === undefined) return [];
  if (!Array.isArray(rules)) {
    const err = new Error('guardrail rules must be an array of {name,pattern,action}');
    err.code = 'guardrails_not_array';
    throw err;
  }
  return rules.map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      const err = new Error('each guardrail rule must be a mapping');
      err.code = 'guardrail_rule_not_mapping';
      throw err;
    }
    return {
      name: String(r.name || ''),
      pattern: String(r.pattern || ''),
      action: String(r.action || ''),
      replacement: (typeof r.replacement === 'string' && r.action === 'rewrite')
        ? r.replacement
        : (r.action === 'rewrite' ? '[redacted]' : null),
    };
  });
}

// ----------------------------------------------------------------------------
// Schema validator
// ----------------------------------------------------------------------------
//
// Reports EVERY error (not just the first) — same pattern as
// validateKolmYaml so a CI run surfaces the full repair list. Codes are
// snake_case for programmable callers.

export function validateGuardrailRules(rules) {
  const errors = [];
  if (rules === null || rules === undefined) {
    // Absent guardrails are valid (the artifact simply ships without a
    // runtime fence). The W736 contract: absent vs empty vs null all
    // collapse to a no-op so legacy artifacts that never carried a
    // guardrail block stay byte-identical when rebuilt.
    return { ok: true, errors: [] };
  }
  if (!Array.isArray(rules)) {
    return { ok: false, errors: [{ path: '', error: 'guardrails_must_be_array' }] };
  }
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const base = `guardrails[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      errors.push({ path: base, error: 'must_be_mapping' });
      continue;
    }
    if (!('name' in r)) errors.push({ path: `${base}.name`, error: 'required' });
    else if (typeof r.name !== 'string' || r.name.length === 0) {
      errors.push({ path: `${base}.name`, error: 'must_be_non_empty_string' });
    }
    if (!('pattern' in r)) errors.push({ path: `${base}.pattern`, error: 'required' });
    else if (typeof r.pattern !== 'string' || r.pattern.length === 0) {
      errors.push({ path: `${base}.pattern`, error: 'must_be_non_empty_string' });
    }
    if (!('action' in r)) errors.push({ path: `${base}.action`, error: 'required' });
    else if (typeof r.action !== 'string') {
      errors.push({ path: `${base}.action`, error: 'must_be_string' });
    } else if (!ALLOWED_ACTIONS.has(r.action)) {
      errors.push({ path: `${base}.action`, error: 'must_be_block_or_warn_or_rewrite' });
    }
    // Try to actually compile the pattern so a bad regex is caught here
    // rather than at the first runtime hit. The compileRule helper throws
    // on bad input; we wrap that into a structured error code.
    if (typeof r.pattern === 'string' && r.pattern.length > 0) {
      try { compileRule(r); }
      catch (e) {
        errors.push({ path: `${base}.pattern`, error: e.code || 'guardrail_pattern_invalid' });
      }
    }
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

// ----------------------------------------------------------------------------
// Rule compilation (one-time, cached)
// ----------------------------------------------------------------------------
//
// The first call with a given rule shape compiles it to a RegExp; subsequent
// calls re-use the compiled form. Hot-path responses re-enter enforce on
// every request, and re-compiling a regex on every request is a real
// allocator-pressure tax at 10krps.

function compileRule(rule) {
  const patternRaw = String(rule.pattern || '');
  // Form 1: keyword:foo → case-insensitive substring of "foo"
  if (patternRaw.startsWith('keyword:')) {
    const kw = patternRaw.slice('keyword:'.length);
    if (kw.length === 0) {
      const err = new Error('keyword: prefix with empty keyword');
      err.code = 'guardrail_keyword_empty';
      throw err;
    }
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
  }
  // Form 2: glob:foo*bar → translated glob
  if (patternRaw.startsWith('glob:')) {
    const g = patternRaw.slice('glob:'.length);
    if (g.length === 0) {
      const err = new Error('glob: prefix with empty glob');
      err.code = 'guardrail_glob_empty';
      throw err;
    }
    return new RegExp('^' + globToRegex(g) + '$', 'i');
  }
  // Form 3: bare string → regex with case-insensitive flag.
  try {
    return new RegExp(patternRaw, 'i');
  } catch (e) {
    const err = new Error(`guardrail pattern is not a valid regex: ${e.message}`);
    err.code = 'guardrail_pattern_invalid';
    throw err;
  }
}

// Map keyed on the canonical JSON of the rules array; value is the
// compiled array of { rule, regex } pairs. Bounded at 256 entries — past
// that we evict the oldest (Map iteration order is insertion order) so a
// long-running router process does not accumulate compiled rule sets for
// every tenant forever.
const COMPILE_CACHE = new Map();
const COMPILE_CACHE_MAX = 256;

function compileRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  const key = canonical(rules);
  const hit = COMPILE_CACHE.get(key);
  if (hit) return hit;
  const compiled = rules.map((r) => ({ rule: r, regex: compileRule(r) }));
  if (COMPILE_CACHE.size >= COMPILE_CACHE_MAX) {
    const oldest = COMPILE_CACHE.keys().next().value;
    COMPILE_CACHE.delete(oldest);
  }
  COMPILE_CACHE.set(key, compiled);
  return compiled;
}

// ----------------------------------------------------------------------------
// Runtime enforcement
// ----------------------------------------------------------------------------
//
// enforceGuardrails(response_text, rules) returns one of two envelope shapes:
//
//   { ok:true,  response, enforcements:[...] }      // pass-through (no block)
//   { ok:false, error:'blocked_by_guardrail', rule_name, hint, matched_at }
//
// The `enforcements` array on the pass-through path lists every warn/rewrite
// that fired during evaluation — empty when no rule matched. Rewrites are
// applied left-to-right (rule order is canonical, set by the tenant in
// kolm.yaml) and the response string is mutated incrementally so callers
// see the final post-rewrite text.

export function enforceGuardrails(response_text, rules) {
  const text = response_text === null || response_text === undefined
    ? '' : String(response_text);
  const compiled = compileRules(parseGuardrailRules(rules));
  if (compiled.length === 0) {
    return { ok: true, response: text, enforcements: [] };
  }
  let current = text;
  const enforcements = [];
  for (const { rule, regex } of compiled) {
    const m = current.match(regex);
    if (!m) continue;
    if (rule.action === 'block') {
      return {
        ok: false,
        error: 'blocked_by_guardrail',
        rule_name: rule.name,
        matched_at: typeof m.index === 'number' ? m.index : null,
        hint: `response matched rule "${rule.name}" with action=block; refuse the response or have the model retry`,
      };
    }
    if (rule.action === 'warn') {
      enforcements.push({
        rule_name: rule.name,
        action: 'warn',
        matched_at: typeof m.index === 'number' ? m.index : null,
      });
      continue;
    }
    if (rule.action === 'rewrite') {
      const replacement = typeof rule.replacement === 'string'
        ? rule.replacement : '[redacted]';
      // Re-compile with the global flag so .replace substitutes ALL hits.
      const globalRe = new RegExp(regex.source, regex.flags.includes('g')
        ? regex.flags
        : regex.flags + 'g');
      const before = current;
      current = current.replace(globalRe, replacement);
      enforcements.push({
        rule_name: rule.name,
        action: 'rewrite',
        matched_at: typeof m.index === 'number' ? m.index : null,
        bytes_changed: before.length - current.length,
      });
      continue;
    }
  }
  return { ok: true, response: current, enforcements };
}

// ----------------------------------------------------------------------------
// Manifest binding — hashGuardrails
// ----------------------------------------------------------------------------
//
// Canonical sha256 over the sorted-key JSON of the rules array. Used as
// `guardrails_hash` inside artifact_hash_input so a post-build mutation
// of any rule (added entry, dropped one, swapped action/pattern, edited
// name) breaks the receipt chain. Mirrors the W460 conditional-slot
// pattern: callers should ONLY add the hash when rules.length > 0 so
// pre-W736 artifacts rebuilt without guardrails remain byte-identical.

export function hashGuardrails(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  return crypto.createHash('sha256').update(canonical(rules)).digest('hex');
}

// Canonical JSON serializer (object keys sorted, arrays preserved). The
// same canonicalisation is used for both the cache key and the hash so
// "equal-looking" rule sets always compile/hash identically.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

// ----------------------------------------------------------------------------
// Verify-time replay — verifyGuardrailsAgainstTraces
// ----------------------------------------------------------------------------
//
// Used by `kolm verify --guardrails`. Given a (rules, traces) pair, replays
// every rule against every trace.output and returns a structured verdict:
//
//   { ok:true, total, violations:[] }                          // all clean
//   { ok:false, total, violations:[{trace_idx, rule_name, ...}] }
//
// Traces is whatever the artifact's `example_traces` block (or analogous
// fixture array) carries — each entry must have a string `.output`. We
// tolerate missing/malformed entries (skip them) so a partial fixture set
// does not crash verify; the count goes into `total` so callers see the
// denominator.

export function verifyGuardrailsAgainstTraces(rules, traces) {
  const out = { ok: true, total: 0, violations: [], version: GUARDRAILS_VERSION };
  if (!Array.isArray(rules) || rules.length === 0) {
    return { ok: true, total: 0, violations: [], skipped: 'no_guardrails_defined', version: GUARDRAILS_VERSION };
  }
  if (!Array.isArray(traces) || traces.length === 0) {
    return { ok: true, total: 0, violations: [], skipped: 'no_example_traces', version: GUARDRAILS_VERSION };
  }
  for (let i = 0; i < traces.length; i++) {
    const t = traces[i];
    if (!t || typeof t !== 'object') continue;
    const txt = typeof t.output === 'string'
      ? t.output
      : (typeof t.response === 'string' ? t.response : null);
    if (txt === null) continue;
    out.total += 1;
    const r = enforceGuardrails(txt, rules);
    if (r.ok === false) {
      out.violations.push({
        trace_idx: i,
        rule_name: r.rule_name,
        matched_at: r.matched_at,
        action: 'block',
      });
      continue;
    }
    for (const enf of (r.enforcements || [])) {
      if (enf.action === 'warn') {
        out.violations.push({
          trace_idx: i,
          rule_name: enf.rule_name,
          matched_at: enf.matched_at,
          action: 'warn',
        });
      }
    }
  }
  if (out.violations.length > 0) out.ok = false;
  return out;
}
