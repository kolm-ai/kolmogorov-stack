// W759 - Calculator tool (recursive-descent + - * / parentheses ONLY).
//
// SECURITY CONTRACT - read before editing.
//
//   This module is the ONLY arithmetic evaluator in the W759 path. It is also
//   the source of truth for src/eval-numeric.js (verifyArithmetic re-exports
//   evalSafeArithmetic from here so callers never accidentally diverge).
//
//   We NEVER call eval(), new Function(...), vm.runInNewContext, or any other
//   dynamic-code path. We NEVER pass user-supplied text to a JS interpreter.
//   The only thing we do is tokenise + parse via a hand-written recursive
//   descent that recognises:
//
//     <expr>   ::= <term> (('+'|'-') <term>)*
//     <term>   ::= <factor> (('*'|'/') <factor>)*
//     <factor> ::= NUMBER | '-' <factor> | '+' <factor> | '(' <expr> ')'
//     NUMBER   ::= /-?\d+(\.\d+)?([eE][-+]?\d+)?/  (also '.5' style)
//
//   Anything else (identifiers, function calls, `**`, `%`, bitwise ops,
//   property access, template strings, backticks, semicolons, commas, square
//   brackets, regex literals, comments) is rejected at the tokeniser. The
//   parser never consults a symbol table - there are no symbols.
//
//   Honesty contract on errors: every failure path returns
//   {ok:false, error:'syntax_error'|'divide_by_zero'|'unsupported_operator',
//    detail}. We NEVER throw out of the public surface and we NEVER silently
//   succeed on partial input - `2 + ` returns syntax_error, not 2.
//
// W735 TOOL-USE COMPATIBILITY.
//
//   CALCULATOR_TOOL_SPEC is the frozen handle the W735 tool-use distillation
//   path uses when it wants to compile a tool-aware student model. Schema is
//   {name:'calculator', input_schema:{type:'object', properties:{expression}},
//    description:'Pure arithmetic only: + - * / parentheses. Returns numeric
//    value.'}. Matches the Anthropic tool-use shape so the W735 fanout can
//   register us as an in-process tool without an adapter shim.
//
// ANTI-BRITTLENESS (W604).
//
//   CALCULATOR_VERSION is `w759-v1` and consumers MUST match with a regex
//   (/^w759-/) NOT literal equality. A v1.x bump in the same wave does not
//   force a coordinated test-rev.

export const CALCULATOR_VERSION = 'w759-v1';

// ─── tokenizer ────────────────────────────────────────────────────────────────
// Tiny hand-rolled lexer. The character class is deliberately narrow:
//   digits 0-9, decimal point, exponent markers e/E, signs + / -, the four
//   ASCII arithmetic operators, and the two parentheses. Everything else is
//   `unsupported_operator` even if JS would happily evaluate it (e.g. `**`).
function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '(' || ch === ')') {
      tokens.push({ kind: ch, span: [i, i + 1] });
      i++;
      continue;
    }
    // Number: digits, optional decimal, optional exponent. We also accept the
    // bare-dot form (`.5`).
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      const start = i;
      // integer part
      while (i < n && src[i] >= '0' && src[i] <= '9') i++;
      // fractional part
      if (src[i] === '.') {
        i++;
        while (i < n && src[i] >= '0' && src[i] <= '9') i++;
      }
      // exponent part
      if (src[i] === 'e' || src[i] === 'E') {
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        const expStart = i;
        while (i < n && src[i] >= '0' && src[i] <= '9') i++;
        if (i === expStart) {
          // `1e` with no digits is a syntax error.
          return { ok: false, error: 'syntax_error', detail: 'malformed_exponent', position: start };
        }
      }
      const lexeme = src.slice(start, i);
      // `.` alone is not a number.
      if (lexeme === '.' || lexeme === '') {
        return { ok: false, error: 'syntax_error', detail: 'malformed_number', position: start };
      }
      const value = Number(lexeme);
      if (!Number.isFinite(value)) {
        return { ok: false, error: 'syntax_error', detail: 'unparseable_number', position: start };
      }
      tokens.push({ kind: 'num', value, span: [start, i] });
      continue;
    }
    // Anything else - including `**`, `%`, `<`, `>`, `=`, identifiers,
    // brackets, semicolons, backticks - gets rejected with the specific
    // `unsupported_operator` error so callers can tell apart "your expression
    // is malformed" from "your operator isn't supported".
    return {
      ok: false,
      error: 'unsupported_operator',
      detail: 'unexpected_character:' + JSON.stringify(ch),
      position: i,
    };
  }
  return { ok: true, tokens };
}

// ─── recursive-descent parser ────────────────────────────────────────────────
function parseExpr(state) {
  // <expr> ::= <term> (('+'|'-') <term>)*
  let left = parseTerm(state);
  if (!left.ok) return left;
  while (state.pos < state.tokens.length) {
    const t = state.tokens[state.pos];
    if (t.kind !== '+' && t.kind !== '-') break;
    state.pos++;
    const right = parseTerm(state);
    if (!right.ok) return right;
    left = { ok: true, value: t.kind === '+' ? left.value + right.value : left.value - right.value };
  }
  return left;
}

function parseTerm(state) {
  // <term> ::= <factor> (('*'|'/') <factor>)*
  let left = parseFactor(state);
  if (!left.ok) return left;
  while (state.pos < state.tokens.length) {
    const t = state.tokens[state.pos];
    if (t.kind !== '*' && t.kind !== '/') break;
    state.pos++;
    const right = parseFactor(state);
    if (!right.ok) return right;
    if (t.kind === '/') {
      if (right.value === 0) {
        return { ok: false, error: 'divide_by_zero', detail: 'division_by_zero' };
      }
      left = { ok: true, value: left.value / right.value };
    } else {
      left = { ok: true, value: left.value * right.value };
    }
  }
  return left;
}

function parseFactor(state) {
  // <factor> ::= NUMBER | '-' <factor> | '+' <factor> | '(' <expr> ')'
  if (state.pos >= state.tokens.length) {
    return { ok: false, error: 'syntax_error', detail: 'unexpected_end_of_input' };
  }
  const t = state.tokens[state.pos];
  if (t.kind === 'num') {
    state.pos++;
    return { ok: true, value: t.value };
  }
  if (t.kind === '-') {
    state.pos++;
    const inner = parseFactor(state);
    if (!inner.ok) return inner;
    return { ok: true, value: -inner.value };
  }
  if (t.kind === '+') {
    state.pos++;
    const inner = parseFactor(state);
    if (!inner.ok) return inner;
    return { ok: true, value: inner.value };
  }
  if (t.kind === '(') {
    state.pos++;
    const inner = parseExpr(state);
    if (!inner.ok) return inner;
    if (state.pos >= state.tokens.length || state.tokens[state.pos].kind !== ')') {
      return { ok: false, error: 'syntax_error', detail: 'missing_close_paren' };
    }
    state.pos++;
    return inner;
  }
  return { ok: false, error: 'syntax_error', detail: 'unexpected_token:' + JSON.stringify(t.kind) };
}

// ─── public: evalSafeArithmetic ──────────────────────────────────────────────
// Pure JS evaluator for + - * / parentheses ONLY. Returns
//   {ok:true,  value, version}                              on success
//   {ok:false, error, detail, version}                      on failure
// Never throws. Never invokes eval/Function/vm. Never inspects a symbol table.
export function evalSafeArithmetic(expr) {
  if (typeof expr !== 'string') {
    return { ok: false, error: 'syntax_error', detail: 'expression_must_be_string', version: CALCULATOR_VERSION };
  }
  const trimmed = expr.trim();
  if (!trimmed) {
    return { ok: false, error: 'syntax_error', detail: 'empty_expression', version: CALCULATOR_VERSION };
  }
  const lex = tokenize(trimmed);
  if (!lex.ok) {
    return { ...lex, version: CALCULATOR_VERSION };
  }
  if (lex.tokens.length === 0) {
    return { ok: false, error: 'syntax_error', detail: 'no_tokens', version: CALCULATOR_VERSION };
  }
  const state = { tokens: lex.tokens, pos: 0 };
  const result = parseExpr(state);
  if (!result.ok) {
    return { ...result, version: CALCULATOR_VERSION };
  }
  if (state.pos !== state.tokens.length) {
    return {
      ok: false,
      error: 'syntax_error',
      detail: 'trailing_tokens_after_expression',
      version: CALCULATOR_VERSION,
    };
  }
  if (!Number.isFinite(result.value)) {
    return {
      ok: false,
      error: 'syntax_error',
      detail: 'non_finite_result',
      version: CALCULATOR_VERSION,
    };
  }
  return { ok: true, value: result.value, version: CALCULATOR_VERSION };
}

// ─── public: extract arithmetic expressions from text ────────────────────────
// Finds candidate `<digits/ops/parens>` substrings and tries each through the
// safe evaluator. Returns the list that successfully parse. We do NOT extract
// expressions that contain `=` here - that is handled by extractEquations in
// eval-numeric.js so the responsibilities stay separate.
function _extractArithmeticCandidates(text) {
  if (typeof text !== 'string' || !text) return [];
  // Match runs of digits, operators, parens, dots, spaces, e/E. We bound by
  // a non-arithmetic boundary on either side. The regex is liberal - we lean
  // on evalSafeArithmetic to reject anything that doesn't actually parse.
  const re = /(?:^|[^A-Za-z0-9_])((?:\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|\(|\))(?:\s*[+\-*/]\s*(?:\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|\(|\)))+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    const start = m.index + (m[0].length - raw.length);
    // Skip trivial single-number matches (no operator) - those are caught by
    // extractNumbers, not by the calculator.
    if (!/[+\-*/]/.test(raw)) continue;
    out.push({ raw: raw.trim(), span: [start, start + raw.length] });
  }
  return out;
}

// ─── public: runtimeCalculatorMiddleware ─────────────────────────────────────
// Finds arithmetic expressions in a model response, evaluates them, and either
// emits the augmented text (with corrections appended) or returns the raw
// expression+computed list. Two modes:
//
//   auto_eval:true - append `[calc: <claimed> -> <computed> (correction)]`
//                       to the response text where the model got it wrong.
//   auto_eval:false - return expressions + computed values; caller decides.
//
// Returns {ok:true, augmented_text, corrections:[{expr, claimed, computed,
// correction}]} on success. corrections is the list of mismatches (claimed
// != computed within tolerance); if the model got it right, corrections is [].
export function runtimeCalculatorMiddleware({ response_text, auto_eval = true } = {}) {
  if (typeof response_text !== 'string') {
    return {
      ok: false,
      error: 'response_text_must_be_string',
      version: CALCULATOR_VERSION,
    };
  }
  const corrections = [];
  const expressions = [];
  // Look for `<expr> = <claimed_value>` patterns. The claimed_value can be a
  // bare number or itself an arithmetic expression we can verify.
  const eqRe = /(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?:\s*[+\-*/]\s*(?:\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|\([^)]*\)))+)\s*=\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = eqRe.exec(response_text)) !== null) {
    const lhs = m[1].trim();
    const claimedRaw = m[2].trim();
    const claimed = Number(claimedRaw);
    const computed = evalSafeArithmetic(lhs);
    if (!computed.ok) continue;
    expressions.push({ expr: lhs, claimed, computed: computed.value });
    const tol = Math.max(1e-9, Math.abs(computed.value) * 1e-9);
    if (Math.abs(claimed - computed.value) > tol) {
      corrections.push({
        expr: lhs,
        claimed,
        computed: computed.value,
        correction: `${lhs} = ${computed.value}`,
      });
    }
  }
  // Also surface bare arithmetic expressions (no `=` rhs) the caller asked us
  // to evaluate - we just attach them to expressions without comparing.
  const candidates = _extractArithmeticCandidates(response_text);
  for (const c of candidates) {
    // Skip if this candidate already appears as an equation LHS (avoid double
    // counting). Cheap startswith check.
    if (expressions.some((e) => c.raw.startsWith(e.expr) || e.expr.startsWith(c.raw))) continue;
    const r = evalSafeArithmetic(c.raw);
    if (!r.ok) continue;
    expressions.push({ expr: c.raw, claimed: null, computed: r.value });
  }
  let augmented_text = response_text;
  if (auto_eval && corrections.length > 0) {
    const notes = corrections
      .map((c) => `[calc: ${c.expr} = ${c.claimed} -> ${c.computed} (correction)]`)
      .join('\n');
    augmented_text = response_text + '\n\n' + notes;
  }
  return {
    ok: true,
    augmented_text,
    corrections,
    expressions,
    version: CALCULATOR_VERSION,
  };
}

// ─── public: CALCULATOR_TOOL_SPEC ────────────────────────────────────────────
// Frozen tool-use spec compatible with the W735 contract. Distillation runs
// register us by reference - no adapter shim needed.
export const CALCULATOR_TOOL_SPEC = Object.freeze({
  name: 'calculator',
  description: 'Pure arithmetic only: + - * / parentheses. Returns numeric value.',
  input_schema: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      expression: Object.freeze({
        type: 'string',
        description: 'An arithmetic expression using only + - * / and parentheses.',
      }),
    }),
    required: Object.freeze(['expression']),
  }),
  version: CALCULATOR_VERSION,
});

export default {
  CALCULATOR_VERSION,
  evalSafeArithmetic,
  runtimeCalculatorMiddleware,
  CALCULATOR_TOOL_SPEC,
};
