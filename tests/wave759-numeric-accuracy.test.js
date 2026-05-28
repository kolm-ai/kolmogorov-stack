// W759 — Numerical Accuracy Eval tests.
//
// Atomic items pinned:
//
//   1) NUMERIC_EVAL_VERSION matches /^w759-/                            (W604 anti-brittleness)
//   2) CALCULATOR_VERSION matches /^w759-/                              (W604 anti-brittleness)
//   3) extractNumbers handles integer / float / sci / pct / currency / thousands / unit
//   4) extractEquations happy path returns lhs+rhs pair
//   5) extractEquations on text with no equation returns []
//   6) verifyArithmetic for +, -, *, /, parentheses
//   7) verifyArithmetic divide_by_zero envelope
//   8) verifyArithmetic syntax_error envelope (malformed)
//   9) verifyArithmetic REJECTS eval/Function attempts (process.exit, etc.)
//  10) evalSafeArithmetic identical results to verifyArithmetic (DRY contract)
//  11) runtimeCalculatorMiddleware finds + corrects mistake in sample text
//  12) CALCULATOR_TOOL_SPEC has name='calculator' + input_schema (W735 compat)
//  13) numericContentRatio 0 on pure prose
//  14) numericContentRatio high on numeric-heavy text
//  15) flagHighNumericNamespace honest envelope on empty namespace
//  16) flagHighNumericNamespace flagged=true above threshold
//  17) POST /v1/numeric/eval 401 without auth
//  18) POST /v1/numeric/calculator 401 without auth
//  19) GET  /v1/numeric/namespace-flag/:namespace 401 without auth
//  20) POST /v1/numeric/eval 400 confirm_required (confirm gate)
//  21) public/docs/numeric-accuracy.html exists w/ brand-lock + calculator-spec anchor
//  22) cli/kolm.js defines cmdW759Numeric exactly once + wired from case 'numeric'
//  23) vercel.json has /docs/numeric-accuracy rewrite
//  24) sibling sw.js family pattern uses wave(\d{3,4}) regex + threshold       (W604)
//
// W604 anti-brittleness: every version assertion uses regex /^w759-/ instead
// of literal equality so a v1.x bump in the same wave does not force a
// coordinated test-rev. Sibling-count assertions use regex + threshold, never
// explicit arrays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
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
} from '../src/eval-numeric.js';

import {
  CALCULATOR_VERSION as CALC_VERSION_FROM_TOOL,
  evalSafeArithmetic as evalSafeFromTool,
  runtimeCalculatorMiddleware,
  CALCULATOR_TOOL_SPEC,
} from '../src/calculator-tool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'numeric-accuracy.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const TESTS_DIR = __dirname;

// Each test seeds an isolated KOLM_DATA_DIR + HOME so the store does not
// leak rows across tests. Same shape as the W750/W751 sibling tests.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w759-' + crypto.randomBytes(4).toString('hex') + '-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_STORE_DRIVER = 'json';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  return tmp;
}

// =============================================================================
// 1) NUMERIC_EVAL_VERSION matches /^w759-/
// =============================================================================

test('W759 #1 — NUMERIC_EVAL_VERSION matches /^w759-/', () => {
  freshDir();
  assert.ok(/^w759-/.test(NUMERIC_EVAL_VERSION),
    `expected NUMERIC_EVAL_VERSION matching /^w759-/; got ${JSON.stringify(NUMERIC_EVAL_VERSION)}`);
});

// =============================================================================
// 2) CALCULATOR_VERSION matches /^w759-/
// =============================================================================

test('W759 #2 — CALCULATOR_VERSION matches /^w759-/ from both modules', () => {
  freshDir();
  assert.ok(/^w759-/.test(CALCULATOR_VERSION),
    `expected CALCULATOR_VERSION (eval-numeric.js) matching /^w759-/; got ${JSON.stringify(CALCULATOR_VERSION)}`);
  assert.ok(/^w759-/.test(CALC_VERSION_FROM_TOOL),
    `expected CALCULATOR_VERSION (calculator-tool.js) matching /^w759-/; got ${JSON.stringify(CALC_VERSION_FROM_TOOL)}`);
  // DRY contract: both re-exports MUST agree.
  assert.equal(CALCULATOR_VERSION, CALC_VERSION_FROM_TOOL,
    'CALCULATOR_VERSION must be identical between eval-numeric.js and calculator-tool.js');
});

// =============================================================================
// 3) extractNumbers handles each format (int / float / sci / pct / currency / thousands / unit)
// =============================================================================

test('W759 #3 — extractNumbers handles int / float / sci / pct / currency / thousands / unit', () => {
  freshDir();
  // 3a) integer
  {
    const nums = extractNumbers('the answer is 42 maybe');
    const v = nums.find((n) => n.value === 42);
    assert.ok(v, `expected integer 42 in ${JSON.stringify(nums)}`);
    assert.equal(v.kind, 'int');
    assert.equal(v.unit, null);
  }
  // 3b) signed integer
  {
    const nums = extractNumbers('temperature -42 degrees');
    const v = nums.find((n) => n.value === -42);
    assert.ok(v, `expected signed -42 in ${JSON.stringify(nums)}`);
  }
  // 3c) float
  {
    const nums = extractNumbers('pi is 3.14 approximately');
    const v = nums.find((n) => n.value === 3.14);
    assert.ok(v, `expected float 3.14 in ${JSON.stringify(nums)}`);
    assert.equal(v.kind, 'float');
  }
  // 3d) scientific
  {
    const nums = extractNumbers('avogadro is 6.022e23');
    const v = nums.find((n) => n.kind === 'sci');
    assert.ok(v, `expected sci kind in ${JSON.stringify(nums)}`);
    assert.ok(Math.abs(v.value - 6.022e23) / 6.022e23 < 1e-9);
  }
  // 3e) negative scientific
  {
    const nums = extractNumbers('rate constant 1.5e-3');
    const v = nums.find((n) => n.kind === 'sci');
    assert.ok(v, `expected sci kind in ${JSON.stringify(nums)}`);
    assert.ok(Math.abs(v.value - 0.0015) < 1e-9);
  }
  // 3f) percentage → fractional
  {
    const nums = extractNumbers('discount 15% applied');
    const v = nums.find((n) => n.kind === 'pct');
    assert.ok(v, `expected pct kind in ${JSON.stringify(nums)}`);
    assert.equal(v.value, 0.15);
    assert.equal(v.unit, '%');
  }
  // 3g) currency (with thousands + decimal)
  {
    const nums = extractNumbers('price was $1,234.56 total');
    const v = nums.find((n) => n.kind === 'currency');
    assert.ok(v, `expected currency kind in ${JSON.stringify(nums)}`);
    assert.equal(v.value, 1234.56);
    assert.equal(v.unit, '$');
  }
  // 3h) plain thousands separator
  {
    const nums = extractNumbers('population is 1,234,567 people');
    const v = nums.find((n) => n.value === 1234567);
    assert.ok(v, `expected thousands 1234567 in ${JSON.stringify(nums)}`);
  }
  // 3i) unit (kg)
  {
    const nums = extractNumbers('weighs 5 kg now');
    const v = nums.find((n) => n.value === 5 && n.unit === 'kg');
    assert.ok(v, `expected {value:5,unit:'kg'} in ${JSON.stringify(nums)}`);
  }
  // 3j) unit (inches — long letter run)
  {
    const nums = extractNumbers('measures 3 inches across');
    const v = nums.find((n) => n.value === 3 && n.unit === 'inches');
    assert.ok(v, `expected {value:3,unit:'inches'} in ${JSON.stringify(nums)}`);
  }
});

// =============================================================================
// 4) extractEquations happy path
// =============================================================================

test('W759 #4 — extractEquations returns lhs/rhs pair on `2 + 3 = 5`', () => {
  freshDir();
  const eqs = extractEquations('the answer is 2 + 3 = 5 always');
  assert.ok(eqs.length >= 1, `expected >=1 equation; got ${JSON.stringify(eqs)}`);
  const eq = eqs[0];
  assert.equal(eq.lhs_value, 5, `lhs value should be 5 (evaluated); got ${eq.lhs_value}`);
  assert.equal(eq.rhs_value, 5, `rhs value should be 5; got ${eq.rhs_value}`);
  assert.ok(typeof eq.lhs_expr === 'string' && eq.lhs_expr.includes('2'));
  assert.ok(typeof eq.rhs_expr === 'string' && eq.rhs_expr.includes('5'));
  assert.ok(Array.isArray(eq.span) && eq.span.length === 2);
});

// =============================================================================
// 5) extractEquations no-match
// =============================================================================

test('W759 #5 — extractEquations returns [] on prose with no equation', () => {
  freshDir();
  const eqs = extractEquations('hello world this is just prose');
  assert.deepEqual(eqs, [], `expected []; got ${JSON.stringify(eqs)}`);
  assert.deepEqual(extractEquations(''), []);
  assert.deepEqual(extractEquations(null), []);
  assert.deepEqual(extractEquations(undefined), []);
});

// =============================================================================
// 6) verifyArithmetic for +, -, *, /, parentheses
// =============================================================================

test('W759 #6 — verifyArithmetic for + - * / and parentheses', () => {
  freshDir();
  assert.equal(verifyArithmetic('2 + 3').value, 5);
  assert.equal(verifyArithmetic('10 - 4').value, 6);
  assert.equal(verifyArithmetic('6 * 7').value, 42);
  assert.equal(verifyArithmetic('20 / 4').value, 5);
  assert.equal(verifyArithmetic('(2 + 3) * 4').value, 20);
  assert.equal(verifyArithmetic('-5 + 10').value, 5);
  assert.equal(verifyArithmetic('1.5 + 2.5').value, 4);
  // associativity + operator precedence
  assert.equal(verifyArithmetic('2 + 3 * 4').value, 14);
  assert.equal(verifyArithmetic('(2 + 3) * 4').value, 20);
  // nested parens
  assert.equal(verifyArithmetic('((1 + 2) * (3 + 4))').value, 21);
  // unary
  assert.equal(verifyArithmetic('--3').value, 3);  // -(-3) = 3
});

// =============================================================================
// 7) verifyArithmetic divide_by_zero envelope
// =============================================================================

test('W759 #7 — verifyArithmetic returns divide_by_zero on / 0', () => {
  freshDir();
  const r = verifyArithmetic('5 / 0');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'divide_by_zero',
    `expected error:'divide_by_zero'; got ${JSON.stringify(r)}`);
  assert.ok(/^w759-/.test(r.version),
    `version stamp must match /^w759-/; got ${JSON.stringify(r.version)}`);
  // Nested div-by-zero
  const r2 = verifyArithmetic('10 / (2 - 2)');
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'divide_by_zero');
});

// =============================================================================
// 8) verifyArithmetic syntax_error envelope
// =============================================================================

test('W759 #8 — verifyArithmetic returns syntax_error on malformed expressions', () => {
  freshDir();
  for (const bad of [
    '',                  // empty
    '2 +',               // trailing operator
    '+ 2 3',             // missing operand
    '(2 + 3',            // unmatched paren
    '2 + 3)',            // extra close paren
    '2 . 3',             // bare dot is not a number
    '2 3',               // two numbers, no operator
    '..',                // bare dots
    '1e',                // malformed exponent
  ]) {
    const r = verifyArithmetic(bad);
    assert.equal(r.ok, false,
      `expected ok:false on bad input ${JSON.stringify(bad)}; got ${JSON.stringify(r)}`);
    assert.equal(r.error, 'syntax_error',
      `expected error:'syntax_error' on ${JSON.stringify(bad)}; got ${JSON.stringify(r)}`);
  }
});

// =============================================================================
// 9) verifyArithmetic REJECTS eval/Function attempts
// =============================================================================

test('W759 #9 — verifyArithmetic rejects eval/Function/identifier injection', () => {
  freshDir();
  const before = global.__w759_canary;
  // These would crash the test process if eval/Function were reached. Each one
  // MUST come back as ok:false with either unsupported_operator OR syntax_error
  // — never ok:true, never a thrown exception, never a side-effect.
  const injections = [
    'process.exit(1)',
    'global.process.exit(1)',
    'require("fs").rmSync("/")',
    'eval("1+1")',
    'new Function("return 1")()',
    'constructor.constructor("return 1")()',
    '({}).constructor.constructor("return 1")()',
    '`${1+1}`',
    '2 ** 10',                                              // exponent op
    '5 % 3',                                                // mod op
    'global.__w759_canary = "PWNED"',                       // assignment
    'this.foo',                                             // identifier + property
    '1; process.exit(1)',                                   // statement sep
    '/regex/.test("x")',                                    // regex literal
    '0x1F',                                                 // hex literal
    '0b101',                                                // binary literal
    '[1,2,3].map(x=>x)',                                    // arrow + array
    'Math.pow(2, 10)',                                      // identifier
    '$',                                                    // bare currency sym
    '\\u002b',                                              // escape attempt
  ];
  for (const inj of injections) {
    let r;
    let threw = false;
    try {
      r = verifyArithmetic(inj);
    } catch (_) {
      threw = true;
    }
    assert.equal(threw, false,
      `verifyArithmetic must NEVER throw on injection ${JSON.stringify(inj)}`);
    assert.equal(r.ok, false,
      `injection ${JSON.stringify(inj)} must return ok:false; got ${JSON.stringify(r)}`);
    assert.ok(
      r.error === 'unsupported_operator' || r.error === 'syntax_error',
      `injection ${JSON.stringify(inj)} must return one of {unsupported_operator, syntax_error}; got ${JSON.stringify(r)}`,
    );
  }
  // Canary did NOT get mutated — assignment was rejected at tokenize.
  assert.equal(global.__w759_canary, before,
    `global state must not be mutated by any injection; canary changed from ${JSON.stringify(before)} to ${JSON.stringify(global.__w759_canary)}`);
});

// =============================================================================
// 10) evalSafeArithmetic identical to verifyArithmetic (DRY contract)
// =============================================================================

test('W759 #10 — evalSafeArithmetic identical to verifyArithmetic (DRY contract)', () => {
  freshDir();
  // Both names are aliases for the same audited evaluator. Quick fuzz on
  // representative expressions.
  for (const expr of [
    '2 + 3',
    '(1 + 2) * 3',
    '5 / 0',
    '2 +',
    '1.5e-3 * 1000',
  ]) {
    const a = evalSafeArithmetic(expr);
    const b = verifyArithmetic(expr);
    const c = evalSafeFromTool(expr);
    assert.deepEqual(a, b, `evalSafeArithmetic === verifyArithmetic for ${JSON.stringify(expr)}`);
    assert.deepEqual(a, c, `cross-module DRY: evalSafeArithmetic (eval-numeric) === evalSafeArithmetic (calculator-tool) for ${JSON.stringify(expr)}`);
  }
});

// =============================================================================
// 11) runtimeCalculatorMiddleware finds + corrects a mistake
// =============================================================================

test('W759 #11 — runtimeCalculatorMiddleware finds + corrects a mistake', () => {
  freshDir();
  const r = runtimeCalculatorMiddleware({
    response_text: 'The order total is 23 * 7 = 162 dollars.',
    auto_eval: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.corrections.length, 1,
    `expected exactly 1 correction; got ${JSON.stringify(r.corrections)}`);
  const c = r.corrections[0];
  assert.equal(c.claimed, 162, `claimed should be 162; got ${c.claimed}`);
  assert.equal(c.computed, 161, `computed should be 161; got ${c.computed}`);
  assert.ok(r.augmented_text.includes('161'),
    `augmented_text should mention the correct value 161; got ${JSON.stringify(r.augmented_text)}`);
  // auto_eval:false returns expressions without rewriting.
  const r2 = runtimeCalculatorMiddleware({
    response_text: 'The order total is 23 * 7 = 161 dollars.',
    auto_eval: false,
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.corrections.length, 0,
    `correct equation should yield 0 corrections; got ${JSON.stringify(r2.corrections)}`);
  assert.equal(r2.augmented_text, 'The order total is 23 * 7 = 161 dollars.',
    `auto_eval:false should NOT rewrite the text`);
});

// =============================================================================
// 12) CALCULATOR_TOOL_SPEC W735-compat
// =============================================================================

test('W759 #12 — CALCULATOR_TOOL_SPEC matches W735 tool-use contract', () => {
  freshDir();
  assert.ok(CALCULATOR_TOOL_SPEC, 'CALCULATOR_TOOL_SPEC must be exported');
  assert.equal(CALCULATOR_TOOL_SPEC.name, 'calculator',
    `tool name must be 'calculator'; got ${JSON.stringify(CALCULATOR_TOOL_SPEC.name)}`);
  assert.ok(typeof CALCULATOR_TOOL_SPEC.description === 'string'
    && CALCULATOR_TOOL_SPEC.description.includes('arithmetic'),
    `description must mention 'arithmetic'; got ${JSON.stringify(CALCULATOR_TOOL_SPEC.description)}`);
  assert.ok(CALCULATOR_TOOL_SPEC.input_schema, 'input_schema must be present');
  assert.equal(CALCULATOR_TOOL_SPEC.input_schema.type, 'object',
    `input_schema.type must be 'object'; got ${JSON.stringify(CALCULATOR_TOOL_SPEC.input_schema.type)}`);
  assert.ok(CALCULATOR_TOOL_SPEC.input_schema.properties
    && CALCULATOR_TOOL_SPEC.input_schema.properties.expression,
    `input_schema.properties.expression must be present; got ${JSON.stringify(CALCULATOR_TOOL_SPEC.input_schema)}`);
  assert.ok(Object.isFrozen(CALCULATOR_TOOL_SPEC),
    `CALCULATOR_TOOL_SPEC must be Object.freeze()d (W604 anti-brittleness)`);
});

// =============================================================================
// 13) numericContentRatio = 0 on prose
// =============================================================================

test('W759 #13 — numericContentRatio returns 0 on pure prose', () => {
  freshDir();
  assert.equal(numericContentRatio('hello world this is prose with no numbers'), 0);
  assert.equal(numericContentRatio(''), 0);
  assert.equal(numericContentRatio(null), 0);
  assert.equal(numericContentRatio(undefined), 0);
});

// =============================================================================
// 14) numericContentRatio high on numeric-heavy text
// =============================================================================

test('W759 #14 — numericContentRatio is high on numeric-heavy text', () => {
  freshDir();
  // 5 of 8 tokens are numeric-shaped.
  const r = numericContentRatio('totals: 100 250 $42 1.5 75% are amounts');
  assert.ok(r > 0.3,
    `expected numericContentRatio > 0.3 on numeric-heavy text; got ${r}`);
  // pure number list
  const r2 = numericContentRatio('1 2 3 4 5 6 7 8 9 10');
  assert.equal(r2, 1, `pure number list must be 1.0; got ${r2}`);
});

// =============================================================================
// 15) flagHighNumericNamespace honest envelope on empty namespace
// =============================================================================

test('W759 #15 — flagHighNumericNamespace returns honest envelope on empty namespace', () => {
  freshDir();
  const r = flagHighNumericNamespace({
    tenant_id: 'tenant_w759_empty',
    namespace: 'w759-empty-ns',
  });
  assert.equal(r.ok, true,
    `empty namespace returns ok:true (honest envelope, not 404); got ${JSON.stringify(r)}`);
  assert.equal(r.flagged, false);
  assert.equal(r.captures_seen, 0);
  assert.equal(r.note, 'empty_namespace');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0,
    `empty namespace must surface a hint string; got ${JSON.stringify(r.hint)}`);
  assert.ok(/^w759-/.test(r.version),
    `version stamp must match /^w759-/; got ${JSON.stringify(r.version)}`);
  // Missing tenant_id is an honest error.
  const r2 = flagHighNumericNamespace({ namespace: 'whatever' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'tenant_id_required');
  // Missing namespace is an honest error.
  const r3 = flagHighNumericNamespace({ tenant_id: 't_w759_missing_ns' });
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'namespace_required');
});

// =============================================================================
// 16) flagHighNumericNamespace flagged=true above threshold
// =============================================================================

test('W759 #16 — flagHighNumericNamespace flagged=true above threshold w/ seeded rows', async () => {
  freshDir();
  const storeMod = await import('../src/store.js');
  const tenant_id = 'tenant_w759_seeded';
  const namespace = 'w759-seeded-numeric';
  // Seed 5 numeric-heavy observation rows.
  for (let i = 0; i < 5; i++) {
    storeMod.insert('observations', {
      id: 'obs_w759_' + i,
      tenant: tenant_id,
      tenant_id,
      namespace,
      corpus_namespace: namespace,
      prompt: `totals: ${100 + i} ${200 + i} $42 1.5 75% are amounts`,
      response: `confirmed ${100 + i} 200 300 400 500`,
      created_at: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  const r = flagHighNumericNamespace({
    tenant_id, namespace, threshold: 0.10,
  });
  assert.equal(r.ok, true);
  assert.ok(r.captures_seen >= 5,
    `expected at least 5 captures seen; got ${r.captures_seen}`);
  assert.ok(r.flagged === true,
    `expected flagged:true on seeded numeric-heavy namespace; got mean_ratio=${r.mean_ratio} threshold=${r.threshold}`);
  assert.ok(r.mean_ratio > 0.10,
    `mean_ratio should exceed threshold 0.10; got ${r.mean_ratio}`);
});

// =============================================================================
// 17) POST /v1/numeric/eval 401 without auth
// =============================================================================

test('W759 #17 — POST /v1/numeric/eval 401 without auth', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/numeric/eval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response_text: 'foo', confirm: true }),
    });
    assert.equal(res.status, 401,
      `expected 401 without auth; got ${res.status}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 18) POST /v1/numeric/calculator 401 without auth
// =============================================================================

test('W759 #18 — POST /v1/numeric/calculator 401 without auth', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/numeric/calculator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expression: '2 + 3' }),
    });
    assert.equal(res.status, 401,
      `expected 401 without auth; got ${res.status}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 19) GET /v1/numeric/namespace-flag/:namespace 401 without auth
// =============================================================================

test('W759 #19 — GET /v1/numeric/namespace-flag/:namespace 401 without auth', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/numeric/namespace-flag/anyns`, {
      method: 'GET',
    });
    assert.equal(res.status, 401,
      `expected 401 without auth; got ${res.status}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 20) POST /v1/numeric/eval 400 confirm_required
// =============================================================================

test('W759 #20 — POST /v1/numeric/eval 400 confirm_required (confirm gate)', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 500 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // Without confirm:true → 400 confirm_required.
    const res = await fetch(`http://127.0.0.1:${port}/v1/numeric/eval`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ response_text: '2 + 3 = 5' }),
    });
    assert.equal(res.status, 400, `expected 400 without confirm; got ${res.status}`);
    const env = await res.json();
    assert.equal(env.ok, false);
    assert.equal(env.error, 'confirm_required',
      `expected error:'confirm_required'; got ${JSON.stringify(env)}`);
    // With confirm:true → 200 + happy envelope.
    const res2 = await fetch(`http://127.0.0.1:${port}/v1/numeric/eval`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ response_text: '2 + 3 = 5', confirm: true }),
    });
    assert.equal(res2.status, 200, `expected 200 with confirm; got ${res2.status}`);
    const env2 = await res2.json();
    assert.equal(env2.ok, true,
      `expected ok:true on valid eval; got ${JSON.stringify(env2)}`);
    assert.equal(env2.equations_found, 1);
    assert.equal(env2.equations_verified, 1);
    assert.ok(/^w759-/.test(env2.version));
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 21) public/docs/numeric-accuracy.html exists w/ brand-lock + calculator-spec anchor
// =============================================================================

test('W759 #21 — public/docs/numeric-accuracy.html exists w/ brand-lock + calculator-spec anchor', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  for (const needle of [
    'kolm.ai',
    'class="ks-nav"',
    'ks-foot',                                   // W902 unified footer class (was ks-footer; w902-unify-footer.cjs across 642 pages)
    'Open-source AI workbench',                  // brand eyebrow lock
    'The open-source AI compiler.',              // W902 unified footer tagline (replaced 'Frontier AI on your own infrastructure.')
    'Numerical accuracy in compiled artifacts',  // page H1 (per spec)
    'w759-v1',                                   // version stamp
    'calculator',                                // tool name shown
    'CALCULATOR_TOOL_SPEC',                      // spec name shown
    'recursive-descent',                         // security disclaimer
    'no eval',                                   // honesty disclaimer
    'kolm numeric calc',                         // CLI surface mention
    '/v1/numeric/eval',                          // API surface mention
    '/v1/numeric/calculator',                    // API surface mention
    '/v1/numeric/namespace-flag',                // API surface mention
    'K-Score',                                   // E-axis cross-reference
    'data-w759="calculator-spec"',               // hidden test anchor
    'data-w759="namespace-flag-docs"',           // hidden test anchor
  ]) {
    assert.ok(html.includes(needle),
      `docs/numeric-accuracy.html must mention ${JSON.stringify(needle)}`);
  }
  // No emojis (spec invariant).
  // Quick check: no surrogate pair / no common emoji code points.
  assert.ok(!/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/u.test(html),
    'docs/numeric-accuracy.html must NOT contain emojis (W759 invariant)');
});

// =============================================================================
// 22) cli/kolm.js defines cmdW759Numeric exactly once + wired
// =============================================================================

test('W759 #22 — cli/kolm.js defines cmdW759Numeric exactly once + wired from case numeric', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW759Numeric\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW759Numeric dispatcher definition; got ${defs.length}`);
  assert.ok(/case\s+['"]numeric['"]/.test(cli),
    `cli must have a case 'numeric' arm`);
  // `num` short alias also wired
  assert.ok(/case\s+['"]num['"]/.test(cli),
    `cli must have a case 'num' arm (short alias for numeric)`);
  assert.ok(cli.includes('cmdW759Numeric(rest)'),
    `cmdW759Numeric must be invoked with the rest args from the dispatch switch`);
  // COMPLETION wiring
  assert.ok(cli.includes("COMPLETION_VERBS.push('numeric'"),
    `COMPLETION_VERBS must include 'numeric'`);
  assert.ok(cli.includes("COMPLETION_SUBS.numeric"),
    `COMPLETION_SUBS.numeric must be configured`);
});

// =============================================================================
// 23) vercel.json has /docs/numeric-accuracy rewrite
// =============================================================================

test('W759 #23 — vercel.json has /docs/numeric-accuracy rewrite', () => {
  freshDir();
  const v = JSON.parse(fs.readFileSync(VERCEL_PATH, 'utf8'));
  const rewrites = v.rewrites || [];
  const docRewrite = rewrites.find((r) => r.source === '/docs/numeric-accuracy');
  assert.ok(docRewrite, '/docs/numeric-accuracy rewrite must exist in vercel.json');
  assert.equal(docRewrite.destination, '/docs/numeric-accuracy.html',
    `destination should be /docs/numeric-accuracy.html; got ${JSON.stringify(docRewrite.destination)}`);
});

// =============================================================================
// 24) sibling sw.js / wave-test family pattern uses regex + threshold (W604)
// =============================================================================

test('W759 #24 — wave759 sibling test count uses regex wave(\\d{3,4}) + threshold (W604)', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this.
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
  // This file itself satisfies the pattern.
  assert.ok(siblings.includes('wave759-numeric-accuracy.test.js'),
    `this test file must match the wave(\\d{3,4}) sibling pattern`);
});

// =============================================================================
// 25) evalNumericResponse end-to-end happy + mismatch envelope
// =============================================================================

test('W759 #25 — evalNumericResponse end-to-end happy + mismatch envelopes', () => {
  freshDir();
  // Happy path.
  const r = evalNumericResponse({
    response_text: 'The answer is 2 + 3 = 5 always.',
  });
  assert.equal(r.ok, true);
  assert.equal(r.has_numbers, true);
  assert.equal(r.equations_found, 1);
  assert.equal(r.equations_verified, 1);
  assert.deepEqual(r.errors, []);
  // Mismatch path.
  const r2 = evalNumericResponse({
    response_text: '23 * 7 = 162',
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.equations_found, 1);
  assert.equal(r2.equations_verified, 0);
  assert.equal(r2.errors.length, 1);
  assert.equal(r2.errors[0].kind, 'equation_mismatch');
  // expected_answer path.
  const r3 = evalNumericResponse({
    response_text: 'The answer is 42.',
    expected_answer: 42,
  });
  assert.equal(r3.match_with_expected, true);
  const r4 = evalNumericResponse({
    response_text: 'The answer is 41.',
    expected_answer: 42,
  });
  assert.equal(r4.match_with_expected, false);
  assert.ok(r4.closest_number,
    `mismatch path should surface closest_number for debugging; got ${JSON.stringify(r4)}`);
  // Bad input → honest envelope.
  const r5 = evalNumericResponse({});
  assert.equal(r5.ok, false);
  assert.equal(r5.error, 'response_text_must_be_string');
});

// =============================================================================
// 26) verifyEquation tolerance handling
// =============================================================================

test('W759 #26 — verifyEquation tolerance handling', () => {
  freshDir();
  // Within tolerance:
  //   tolerance_pct = 0.001 = 0.1%, threshold = max(0.001 * 100, 0.001) = 0.1
  //   abs_diff = |100 - 100.05| = 0.05 < 0.1 → ok:true.
  assert.equal(
    verifyEquation({ lhs_value: 100, rhs_value: 100.05, tolerance_pct: 0.001 }).ok,
    true,
    `0.05 abs diff < 0.1 tolerance abs → ok:true`,
  );
  // Outside tolerance:
  //   abs_diff = |100 - 101| = 1.0 > 0.1 → ok:false.
  assert.equal(
    verifyEquation({ lhs_value: 100, rhs_value: 101, tolerance_pct: 0.001 }).ok,
    false,
    `1.0 abs diff > 0.1 tolerance abs → ok:false`,
  );
  // Tighter custom tolerance — 0.05 abs diff IS outside a 0.0001 (0.01%) tolerance.
  assert.equal(
    verifyEquation({ lhs_value: 100, rhs_value: 100.05, tolerance_pct: 0.0001 }).ok,
    false,
    `0.05 abs diff > 0.01 tolerance abs → ok:false`,
  );
  // Non-finite handling.
  const r3 = verifyEquation({ lhs_value: NaN, rhs_value: 5 });
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'non_finite_value');
});
