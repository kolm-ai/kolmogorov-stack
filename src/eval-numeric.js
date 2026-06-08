// W759 - Numerical Accuracy Eval.
//
// Extract numbers from model outputs and verify mathematical correctness.
// Used by:
//   - POST /v1/numeric/eval - pre-flight a response against an
//                                            expected answer + arithmetic check
//   - GET  /v1/numeric/namespace-flag/:ns - flag namespaces with high numeric
//                                            content so distillation gets the
//                                            calculator tool wired in
//   - `kolm numeric eval|calc|flag-namespace`
//
// SCOPE / HONESTY CONTRACT:
//   - We extract NUMBERS, equations, and arithmetic expressions. We do NOT
//     attempt to derive truth from prose. "The Eiffel Tower is 330 meters"
//     yields one extracted number (330) with unit:'meters'; the truth of the
//     claim is the caller's problem.
//   - All arithmetic is delegated to src/calculator-tool.js evalSafeArithmetic.
//     We NEVER call eval(), new Function(), vm.runInNewContext, or any other
//     dynamic-code path. The DRY re-export is the security contract - a single
//     audit on calculator-tool.js covers both surfaces.
//   - When extractEquations sees `2 + 3 = 5`, it parses BOTH sides via the
//     safe evaluator. If either side fails to parse, the equation is dropped
//     (not silently passed). This is conservative on purpose: a malformed
//     equation is not evidence of correctness.
//
// W735 INTEGRATION:
//   - The calculator tool spec is re-exported from src/calculator-tool.js so
//     a W735 tool-use distillation run can wire the calculator without
//     touching this module's surface.
//
// W709 INTEGRATION (confidence routing):
//   - flagHighNumericNamespace is the upstream signal for the confidence
//     router: namespaces with mean numericContentRatio > 0.10 default-route
//     to the teacher with calculator-tool augmentation until the student
//     model demonstrates parity on a numeric eval split.
//
// ANTI-BRITTLENESS (W604):
//   - NUMERIC_EVAL_VERSION is `w759-v1` and consumers MUST match with a regex
//     (/^w759-/) NOT literal equality.

import { findByTenant } from './store.js';
import {
  CALCULATOR_VERSION,
  evalSafeArithmetic,
} from './calculator-tool.js';

export const NUMERIC_EVAL_VERSION = 'w759-v1';

// Re-export so callers can import the calc surface from a single module if
// they prefer. The W735 path uses calculator-tool.js directly; the eval API
// keeps this convenience alias.
export { CALCULATOR_VERSION, evalSafeArithmetic };

// ─── number extraction ────────────────────────────────────────────────────────
//
// We support seven shapes, dispatched by a small set of regexes that fire in
// priority order (currency first because `$1,234.56` would otherwise be
// captured by the thousands-separator path with the leading `$` lost):
//
//   currency   $1,234.56   $42    (£/€/¥ optional)
//   percent    15%         3.5%
//   scientific 1.5e-3      6.022E23
//   thousands  1,234,567               -> 1234567
//   float      -42.5       0.5   3.14
//   int        42          -7
//   unit       5 kg        3 inches    -> 5 (kind:int|float; unit:'kg'|'inches')
//
// Returns [{value, raw, span:[start,end], unit, kind}].
//
// The extraction is intentionally permissive on the LHS (`-` and `+` are
// stripped, thousands separators normalised) and conservative on the RHS
// (a trailing letter without a space - e.g. `5x` - is NOT treated as a unit
// because `x` is far more often an algebraic variable than a unit).
export function extractNumbers(text) {
  if (typeof text !== 'string' || !text) return [];
  const hits = [];
  const claimed = new Set(); // [start,end] spans already taken; later passes skip them.

  function _claim(start, end) {
    for (let i = start; i < end; i++) claimed.add(i);
  }
  function _spanFree(start, end) {
    for (let i = start; i < end; i++) if (claimed.has(i)) return false;
    return true;
  }

  // 1) Currency. `$`, `£`, `€`, `¥` followed by digits (optionally with
  //    thousands separators + decimal). We parse the inner number with the
  //    thousands-separator stripped.
  const currencyRe = /([$£€¥])\s*(-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = currencyRe.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (!_spanFree(start, end)) continue;
    const raw = m[0];
    const numericPart = m[2].replace(/,/g, '');
    const value = Number(numericPart);
    if (!Number.isFinite(value)) continue;
    hits.push({
      value,
      raw,
      span: [start, end],
      unit: m[1], // currency symbol IS the unit
      kind: 'currency',
    });
    _claim(start, end);
  }

  // 2) Percent. Number followed by `%`.
  const percentRe = /(-?\d+(?:\.\d+)?)\s*%/g;
  while ((m = percentRe.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (!_spanFree(start, end)) continue;
    const value = Number(m[1]) / 100;
    if (!Number.isFinite(value)) continue;
    hits.push({
      value,
      raw: m[0],
      span: [start, end],
      unit: '%',
      kind: 'pct',
    });
    _claim(start, end);
  }

  // 3) Scientific notation. e.g. `1.5e-3`, `6.022E23`.
  const sciRe = /(-?\d+(?:\.\d+)?[eE][-+]?\d+)/g;
  while ((m = sciRe.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (!_spanFree(start, end)) continue;
    const value = Number(m[1]);
    if (!Number.isFinite(value)) continue;
    hits.push({
      value,
      raw: m[0],
      span: [start, end],
      unit: null,
      kind: 'sci',
    });
    _claim(start, end);
  }

  // 4) Thousands-separated integer / float. e.g. `1,234,567` or `1,234.56`.
  //    We require at least one comma so plain `1234` falls through to step 5.
  const thousandsRe = /(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?)/g;
  while ((m = thousandsRe.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (!_spanFree(start, end)) continue;
    const stripped = m[1].replace(/,/g, '');
    const value = Number(stripped);
    if (!Number.isFinite(value)) continue;
    const kind = stripped.includes('.') ? 'float' : 'int';
    hits.push({
      value,
      raw: m[0],
      span: [start, end],
      unit: null,
      kind,
    });
    _claim(start, end);
  }

  // 5) Plain float / int - possibly followed by a unit token.
  //    The unit is a whitespace-separated word made of letters. We are
  //    conservative on purpose: arbitrary English words like "maybe" or
  //    "things" must NOT be treated as units, so we use a curated allow-list
  //    for BOTH the 2-char and the longer cases. Anything not on the list is
  //    extracted as a unitless number - the prose surrounding the number is
  //    the caller's problem, not the extractor's.
  const numberRe = /(-?\d+(?:\.\d+)?)(\s+)?([A-Za-z]+)?/g;
  const SHORT_UNITS = new Set([
    'kg', 'mg', 'lb', 'oz', 'ft', 'in', 'mi', 'km', 'mm', 'cm', 'sq',
    'hr', 'hp', 'kw', 'mw', 'gw', 'pa', 'pi', 'ps', 'ns', 'us', 'ms',
  ]);
  const LONG_UNITS = new Set([
    // length
    'inches', 'inch', 'feet', 'foot', 'yards', 'yard', 'miles', 'mile',
    'meters', 'meter', 'metres', 'metre',
    'kilometers', 'kilometer', 'kilometres', 'kilometre',
    'centimeters', 'centimeter', 'centimetres', 'centimetre',
    'millimeters', 'millimeter', 'millimetres', 'millimetre',
    'nanometers', 'nanometer', 'micrometers', 'micrometer',
    // mass
    'kilograms', 'kilogram', 'grams', 'gram', 'milligrams', 'milligram',
    'pounds', 'pound', 'ounces', 'ounce', 'tons', 'tonnes',
    // volume
    'liters', 'liter', 'litres', 'litre', 'gallons', 'gallon',
    'milliliters', 'milliliter', 'millilitres', 'millilitre',
    // time
    'seconds', 'second', 'minutes', 'minute', 'hours', 'hour',
    'days', 'day', 'weeks', 'week', 'months', 'month', 'years', 'year',
    'milliseconds', 'microseconds', 'nanoseconds',
    // energy / power / frequency
    'joules', 'joule', 'watts', 'watt', 'kilowatts', 'megawatts',
    'volts', 'volt', 'amps', 'amp', 'amperes', 'hertz', 'kilohertz', 'megahertz', 'gigahertz',
    // temperature / pressure
    'celsius', 'fahrenheit', 'kelvin', 'pascals', 'pascal',
    // bytes / bits
    'bytes', 'byte', 'bits', 'bit', 'kilobytes', 'megabytes', 'gigabytes', 'terabytes',
    // misc science
    'degrees', 'radians', 'mol', 'moles', 'mole',
    // throughput / common prose units
    'requests', 'tokens', 'token', 'users', 'people', 'items', 'rows', 'records',
    'dollars', 'dollar', 'cents', 'cent', 'euros', 'euro',
  ]);
  while ((m = numberRe.exec(text)) !== null) {
    const start = m.index;
    const numEnd = start + m[1].length;
    if (!_spanFree(start, numEnd)) continue;
    const rawNum = m[1];
    const sep = m[2] || '';
    const unitCandidate = m[3] || null;
    const value = Number(rawNum);
    if (!Number.isFinite(value)) continue;
    let unit = null;
    let end = numEnd;
    let raw = rawNum;
    if (sep && unitCandidate) {
      // Both short and long units must be on the allow-list; an arbitrary
      // English word adjacent to a number is NOT a unit. This is conservative
      // by design - the test "the answer is 42 maybe" must yield unit:null.
      const lower = unitCandidate.toLowerCase();
      const isUnit = SHORT_UNITS.has(lower) || LONG_UNITS.has(lower);
      if (isUnit) {
        unit = unitCandidate;
        end = start + m[0].length;
        raw = m[0];
      }
    }
    const kind = rawNum.includes('.') ? 'float' : 'int';
    hits.push({
      value,
      raw,
      span: [start, end],
      unit,
      kind,
    });
    _claim(start, end);
  }

  // Stable ordering: by span start.
  hits.sort((a, b) => a.span[0] - b.span[0]);
  return hits;
}

// ─── equation extraction ─────────────────────────────────────────────────────
// Find `<lhs> = <rhs>` patterns where both sides parse as numbers OR
// arithmetic. Returns [{lhs_expr, rhs_expr, lhs_value, rhs_value, span}].
// Both sides go through evalSafeArithmetic - no eval, no Function.
export function extractEquations(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  // LHS / RHS are runs of digits / operators / parens / spaces / e-exp.
  // We bound by non-arithmetic surroundings so `x = 5` does NOT match (x is
  // not arithmetic) but `2 + 3 = 5` does.
  const re = /([\d.\s+\-*/()eE]+?)\s*=\s*([\d.\s+\-*/()eE]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lhsRaw = m[1].trim();
    const rhsRaw = m[2].trim();
    if (!lhsRaw || !rhsRaw) continue;
    // Reject when LHS or RHS is empty after trim or contains only operators.
    if (!/\d/.test(lhsRaw) || !/\d/.test(rhsRaw)) continue;
    const lhs = evalSafeArithmetic(lhsRaw);
    const rhs = evalSafeArithmetic(rhsRaw);
    if (!lhs.ok || !rhs.ok) continue;
    out.push({
      lhs_expr: lhsRaw,
      rhs_expr: rhsRaw,
      lhs_value: lhs.value,
      rhs_value: rhs.value,
      span: [m.index, m.index + m[0].length],
    });
  }
  return out;
}

// ─── equation verification ───────────────────────────────────────────────────
// Returns {ok, error, abs_diff, pct_diff}.
//   ok==true  when |lhs - rhs| <= max(tolerance_pct * |lhs|, tolerance_pct)
// pct_diff is computed against max(|lhs|, |rhs|, 1) to avoid divide-by-zero.
export function verifyEquation({ lhs_value, rhs_value, tolerance_pct = 0.001 } = {}) {
  const lhs = Number(lhs_value);
  const rhs = Number(rhs_value);
  if (!Number.isFinite(lhs) || !Number.isFinite(rhs)) {
    return {
      ok: false,
      error: 'non_finite_value',
      abs_diff: null,
      pct_diff: null,
    };
  }
  const abs_diff = Math.abs(lhs - rhs);
  const denom = Math.max(Math.abs(lhs), Math.abs(rhs), 1);
  const pct_diff = abs_diff / denom;
  const tol_abs = Math.max(Math.abs(lhs) * tolerance_pct, tolerance_pct);
  if (abs_diff > tol_abs) {
    return { ok: false, error: 'mismatch', abs_diff, pct_diff };
  }
  return { ok: true, error: null, abs_diff, pct_diff };
}

// ─── arithmetic verification (DRY re-export) ─────────────────────────────────
// verifyArithmetic is the public name for evalSafeArithmetic. The DRY
// re-export keeps the security contract on a single function in
// calculator-tool.js - both surfaces go through the same audited evaluator.
export function verifyArithmetic(expr) {
  return evalSafeArithmetic(expr);
}

// ─── public: evalNumericResponse ─────────────────────────────────────────────
// Top-level evaluation entry-point used by the API + CLI.
//
//   response_text     model output to evaluate
//   expected_answer   optional ground truth (a number); when provided we also
//                     set match_with_expected:true|false based on tolerance
//   tolerance_pct     fractional tolerance (default 0.1%)
//
// Returns {ok, has_numbers, numbers:[...], equations_found, equations_verified,
// errors:[], match_with_expected?, version}. Honest envelope on bad input.
export function evalNumericResponse({
  response_text,
  expected_answer = null,
  tolerance_pct = 0.001,
} = {}) {
  if (typeof response_text !== 'string') {
    return {
      ok: false,
      error: 'response_text_must_be_string',
      version: NUMERIC_EVAL_VERSION,
    };
  }
  const numbers = extractNumbers(response_text);
  const equations = extractEquations(response_text);
  const errors = [];
  let verified = 0;
  for (const eq of equations) {
    const v = verifyEquation({
      lhs_value: eq.lhs_value,
      rhs_value: eq.rhs_value,
      tolerance_pct,
    });
    if (v.ok) {
      verified++;
    } else {
      errors.push({
        kind: 'equation_mismatch',
        lhs_expr: eq.lhs_expr,
        rhs_expr: eq.rhs_expr,
        lhs_value: eq.lhs_value,
        rhs_value: eq.rhs_value,
        abs_diff: v.abs_diff,
        pct_diff: v.pct_diff,
        span: eq.span,
      });
    }
  }
  const out = {
    ok: errors.length === 0,
    has_numbers: numbers.length > 0,
    numbers,
    equations_found: equations.length,
    equations_verified: verified,
    errors,
    version: NUMERIC_EVAL_VERSION,
  };
  if (expected_answer !== null && expected_answer !== undefined) {
    const expected = Number(expected_answer);
    if (!Number.isFinite(expected)) {
      out.match_with_expected = false;
      out.expected_answer = expected_answer;
      out.expected_answer_error = 'expected_answer_not_finite';
    } else {
      out.expected_answer = expected;
      // Match is true when ANY extracted number is within tolerance of expected.
      const tol_abs = Math.max(Math.abs(expected) * tolerance_pct, tolerance_pct);
      const match = numbers.some((n) => Math.abs(n.value - expected) <= tol_abs);
      out.match_with_expected = match;
      if (!match) {
        // Surface the closest number for debugging.
        let closest = null;
        let closestDiff = Infinity;
        for (const n of numbers) {
          const d = Math.abs(n.value - expected);
          if (d < closestDiff) { closestDiff = d; closest = n; }
        }
        out.closest_number = closest;
        out.closest_diff = closestDiff;
      }
    }
  }
  return out;
}

// ─── public: numericContentRatio ─────────────────────────────────────────────
// Returns fraction of whitespace-separated tokens that look numeric in a text.
// "The price is $5.99 today" -> 1 numeric (`$5.99`) / 5 tokens = 0.2.
// "Hello world" -> 0. Pure prose returns 0. Used by flagHighNumericNamespace
// as the per-capture signal that drives the namespace mean.
export function numericContentRatio(text) {
  if (typeof text !== 'string' || !text) return 0;
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  // A token is "numeric" if extractNumbers, applied to JUST that token, yields
  // at least one hit AND the hit's span covers most of the token (>= 50%).
  // This is a cheap proxy that avoids the per-token allocation cost of
  // running the full extractNumbers - we use a regex pre-check.
  const numericLike = /^[-]?[$£€¥]?\d[\d.,]*(?:[eE][-+]?\d+)?%?$/;
  let count = 0;
  for (const tok of tokens) {
    if (numericLike.test(tok)) count++;
  }
  return count / tokens.length;
}

// ─── public: flagHighNumericNamespace ────────────────────────────────────────
// Sample up to `sample_n` captures from the given namespace + tenant; compute
// mean numericContentRatio across (prompt + response); flag when above
// `threshold` (default 0.10 = 10% numeric tokens).
//
// Returns:
//   {ok:true, namespace, mean_ratio, threshold, flagged, sample_n,
//    captures_seen, hint}
//   {ok:true, namespace, ..., flagged:false, captures_seen:0,
//    note:'empty_namespace'}   when no captures exist
//
// Honesty contract - we ALWAYS return ok:true with a structured envelope on
// empty namespaces (matches the "honest envelope vs silent fallthrough"
// pattern from W462/W464). The caller distinguishes "no data" from
// "low-numeric" via captures_seen.
//
// The hint string is intentionally specific so the operator knows what to do
// next: wire the calculator tool into the W735 tool-use distillation path for
// this namespace.
export function flagHighNumericNamespace({
  tenant_id,
  namespace,
  threshold = 0.10,
  sample_n = 100,
} = {}) {
  if (!tenant_id) {
    return {
      ok: false,
      error: 'tenant_id_required',
      version: NUMERIC_EVAL_VERSION,
    };
  }
  if (!namespace) {
    return {
      ok: false,
      error: 'namespace_required',
      version: NUMERIC_EVAL_VERSION,
    };
  }
  const ns = String(namespace);
  let rows = [];
  try {
    rows = findByTenant('observations', tenant_id) || [];
  } catch (_) {
    rows = [];
  }
  // Defense-in-depth tenant fence inside the loop - never trust the upstream
  // table filter alone (W465 trap).
  const filtered = rows.filter((r) => {
    if (!r) return false;
    if (String(r.tenant_id ?? r.tenant) !== String(tenant_id)) return false;
    const rowNs = r.corpus_namespace || r.namespace || 'default';
    return rowNs === ns;
  });
  // Newest first by created_at (string ISO compare is fine).
  filtered.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const sample = filtered.slice(0, Math.max(1, sample_n));
  if (sample.length === 0) {
    return {
      ok: true,
      namespace: ns,
      mean_ratio: 0,
      threshold,
      flagged: false,
      sample_n: 0,
      captures_seen: 0,
      note: 'empty_namespace',
      hint: 'no captures found in this namespace yet - flag is informational',
      version: NUMERIC_EVAL_VERSION,
    };
  }
  let total = 0;
  for (const r of sample) {
    const prompt = typeof r.prompt === 'string' ? r.prompt
      : (typeof r.variable_input === 'string' ? r.variable_input : '');
    const response = typeof r.response === 'string' ? r.response : '';
    const combined = prompt + '\n' + response;
    total += numericContentRatio(combined);
  }
  const mean = total / sample.length;
  const flagged = mean > threshold;
  return {
    ok: true,
    namespace: ns,
    mean_ratio: Math.round(mean * 1e6) / 1e6,
    threshold,
    flagged,
    sample_n: sample.length,
    captures_seen: filtered.length,
    hint: 'Distillation of numerical content requires calculator tool - see W759 docs',
    version: NUMERIC_EVAL_VERSION,
  };
}

export default {
  NUMERIC_EVAL_VERSION,
  CALCULATOR_VERSION,
  extractNumbers,
  extractEquations,
  verifyEquation,
  verifyArithmetic,
  evalSafeArithmetic,
  evalNumericResponse,
  numericContentRatio,
  flagHighNumericNamespace,
};
