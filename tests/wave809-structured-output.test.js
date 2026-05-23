// W809 — Structured Output Validation tests.
//
// Atomic items pinned (matches the W809 implementation):
//
//   1)  OUTPUT_SCHEMA_VERSION === 'w809-v1' + OUTPUT_SCHEMA_KINDS frozen.
//   2)  validateOutputSchemaSpec accepts null/undefined/empty as the "no
//       schema" path with no errors.
//   3)  validateOutputSchemaSpec rejects unknown kind + carries stable
//       error code prefixes (kind:, schema:, regex:, strict:).
//   4)  validateOutputSchemaSpec enforces shape rules per-kind:
//         * json   — schema must be object or {$ref}; rejects bare string.
//         * regex  — schema must be a string the RegExp ctor accepts.
//         * xml/grammar — schema must be a non-empty string OR {$ref}.
//         * null   — schema must be null AND strict must be false.
//   5)  canonicalizeOutputSchemaSpec collapses every absence representation
//       (undefined, null, {}, {kind:null}) to the same JSON `null` so the
//       orchestrator's hash chain stays byte-stable (W460 pattern lock-in).
//   6)  hashOutputSchemaSpec returns null for the empty path AND a stable
//       sha256 hex digest for a real spec.
//   7)  parseOutputAgainstSpec round-trips a valid JSON output and emits a
//       stable error code on malformed JSON.
//   8)  Bakeoff summary surfaces `parse_failure_rate` ALONGSIDE pass_rate
//       (never substituted) whenever opts.schema_spec is present.
//   9)  runWithSchemaRetry respects the temperature decay schedule and
//       returns retries_used in {0..maxRetries}.
//  10)  runWithSchemaRetry escalates to onTeacherSplice after retries are
//       exhausted; splice_triggered:true on the result.
//  11)  Constrained-decoder worker shell emits the honest envelope
//       (ok:false, error:'no_constrained_decoder', exit 3) when
//       CONSTRAINED_DECODE_CMD points to a nonexistent binary.
//  12)  cmdCompileOutputSchema + _w809VerifyOutputSchema dispatchers exist
//       in cli/kolm.js (load-bearing CLI surface for --output-schema +
//       --validate-schema).
//  13)  doctorConstrainedDecode wires through src/constrained-decode.js
//       and yields a stable envelope shape.
//
// W604 anti-brittleness: every assertion keys on a stable code/field
// (snake_case error codes, version constants, exit codes, hash equality)
// rather than free-form messages or family arrays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  OUTPUT_SCHEMA_VERSION,
  OUTPUT_SCHEMA_KINDS,
  EMPTY_OUTPUT_SCHEMA_SPEC,
  validateOutputSchemaSpec,
  canonicalizeOutputSchemaSpec,
  hashOutputSchemaSpec,
  parseOutputAgainstSpec,
} from '../src/output-schema.js';

import {
  runWithSchemaRetry,
  DEFAULT_TEMPERATURE_DECAY,
  OUTPUT_RETRY_VERSION,
} from '../src/output-retry.js';

import { doctorConstrainedDecode } from '../src/constrained-decode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SHELL = path.join(__dirname, '..', 'workers', 'constrained', 'constrained.mjs');
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w809-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// =============================================================================
// 1) OUTPUT_SCHEMA_VERSION + OUTPUT_SCHEMA_KINDS
// =============================================================================

test('W809 #1 — OUTPUT_SCHEMA_VERSION is w809-v1 and OUTPUT_SCHEMA_KINDS is frozen', () => {
  freshDir();
  assert.equal(OUTPUT_SCHEMA_VERSION, 'w809-v1');
  for (const k of ['json', 'xml', 'grammar', 'regex']) {
    assert.ok(OUTPUT_SCHEMA_KINDS.includes(k), `OUTPUT_SCHEMA_KINDS missing required kind: ${k}`);
  }
  // Frozen so a runtime mutation can't sneak a new kind in past validateSpec.
  assert.ok(Object.isFrozen(OUTPUT_SCHEMA_KINDS));
  // EMPTY_OUTPUT_SCHEMA_SPEC is the canonical "no schema" sentinel.
  assert.equal(EMPTY_OUTPUT_SCHEMA_SPEC.kind, null);
  assert.equal(EMPTY_OUTPUT_SCHEMA_SPEC.schema, null);
  assert.equal(EMPTY_OUTPUT_SCHEMA_SPEC.strict, false);
});

// =============================================================================
// 2) validateOutputSchemaSpec — null/empty are OK (no errors)
// =============================================================================

test('W809 #2 — validateOutputSchemaSpec accepts null/undefined/empty as no-schema', () => {
  freshDir();
  for (const empty of [null, undefined, {}, { kind: null }, { kind: null, schema: null, strict: false }]) {
    const v = validateOutputSchemaSpec(empty);
    assert.equal(v.ok, true, `expected empty/absent spec to validate; spec=${JSON.stringify(empty)}, errors=${JSON.stringify(v.errors)}`);
    assert.deepEqual(v.errors, []);
  }
});

// =============================================================================
// 3) validateOutputSchemaSpec — unknown kind + stable error code prefixes
// =============================================================================

test('W809 #3 — validateOutputSchemaSpec rejects unknown kind with stable error code', () => {
  freshDir();
  const v = validateOutputSchemaSpec({ kind: 'yaml', schema: 'whatever' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith('kind:')),
    `expected kind:* error code; got ${JSON.stringify(v.errors)}`);
  // Bool-style misuse of strict.
  const v2 = validateOutputSchemaSpec({ kind: 'json', schema: { type: 'object' }, strict: 'yes' });
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => e.startsWith('strict:')),
    `expected strict:* error code; got ${JSON.stringify(v2.errors)}`);
});

// =============================================================================
// 4) validateOutputSchemaSpec — per-kind shape rules
// =============================================================================

test('W809 #4 — validateOutputSchemaSpec enforces per-kind shape rules', () => {
  freshDir();
  // json: must be object or {$ref}; bare string rejected.
  const jsonBare = validateOutputSchemaSpec({ kind: 'json', schema: '"some schema"' });
  assert.equal(jsonBare.ok, false);
  assert.ok(jsonBare.errors.some((e) => e.startsWith('schema:')),
    `expected schema:* for bare-string JSON; got ${JSON.stringify(jsonBare.errors)}`);
  // json with object: ok.
  const jsonGood = validateOutputSchemaSpec({ kind: 'json', schema: { type: 'object', properties: { x: { type: 'string' } } } });
  assert.equal(jsonGood.ok, true);
  // json with $ref: ok.
  const jsonRef = validateOutputSchemaSpec({ kind: 'json', schema: { $ref: 'schemas/out.json' } });
  assert.equal(jsonRef.ok, true);

  // regex: must be a regex-compilable string. '(' is invalid.
  const reBad = validateOutputSchemaSpec({ kind: 'regex', schema: '(' });
  assert.equal(reBad.ok, false);
  assert.ok(reBad.errors.some((e) => e.startsWith('regex:')),
    `expected regex:* error for bad pattern; got ${JSON.stringify(reBad.errors)}`);
  const reGood = validateOutputSchemaSpec({ kind: 'regex', schema: '^[0-9]+$' });
  assert.equal(reGood.ok, true);

  // xml: empty schema rejected.
  const xmlBad = validateOutputSchemaSpec({ kind: 'xml', schema: '' });
  assert.equal(xmlBad.ok, false);
  assert.ok(xmlBad.errors.some((e) => e.startsWith('schema:')));
  // xml: non-empty string ok.
  const xmlGood = validateOutputSchemaSpec({ kind: 'xml', schema: '<xs:schema/>' });
  assert.equal(xmlGood.ok, true);

  // kind:null + non-null schema must error.
  const nullWithSchema = validateOutputSchemaSpec({ kind: null, schema: { type: 'object' } });
  assert.equal(nullWithSchema.ok, false);
  assert.ok(nullWithSchema.errors.some((e) => e.startsWith('schema:')));
  // kind:null + strict:true must error.
  const nullStrict = validateOutputSchemaSpec({ kind: null, schema: null, strict: true });
  assert.equal(nullStrict.ok, false);
  assert.ok(nullStrict.errors.some((e) => e.startsWith('strict:')));
});

// =============================================================================
// 5) canonicalizeOutputSchemaSpec — W460 byte-stability lock-in
// =============================================================================

test('W809 #5 — canonicalizeOutputSchemaSpec collapses every empty representation to null (W460 lock-in)', () => {
  freshDir();
  const empties = [
    undefined,
    null,
    {},
    { kind: null },
    { kind: null, schema: null },
    { kind: null, schema: null, strict: false },
  ];
  for (const e of empties) {
    assert.equal(
      canonicalizeOutputSchemaSpec(e),
      null,
      `expected canonical null for ${JSON.stringify(e)}; got ${JSON.stringify(canonicalizeOutputSchemaSpec(e))}`,
    );
  }
  // A real spec canonicalizes to a 3-key object in stable order.
  const canon = canonicalizeOutputSchemaSpec({ kind: 'json', schema: { type: 'object' }, strict: true });
  assert.deepEqual(canon, { kind: 'json', schema: { type: 'object' }, strict: true });
});

// =============================================================================
// 6) hashOutputSchemaSpec — null for empty + stable digest for real spec
// =============================================================================

test('W809 #6 — hashOutputSchemaSpec returns null for empty + stable sha256 hex for real spec', async () => {
  freshDir();
  assert.equal(await hashOutputSchemaSpec(null), null);
  assert.equal(await hashOutputSchemaSpec({}), null);
  assert.equal(await hashOutputSchemaSpec({ kind: null, schema: null }), null);
  const real = { kind: 'json', schema: { type: 'object' }, strict: true };
  const h1 = await hashOutputSchemaSpec(real);
  const h2 = await hashOutputSchemaSpec(real);
  assert.equal(typeof h1, 'string');
  assert.equal(h1.length, 64);
  assert.equal(h1, h2);
  // A change in schema MUST change the hash.
  const h3 = await hashOutputSchemaSpec({ kind: 'json', schema: { type: 'array' }, strict: true });
  assert.notEqual(h1, h3);
});

// =============================================================================
// 7) parseOutputAgainstSpec — round-trip + stable error code
// =============================================================================

test('W809 #7 — parseOutputAgainstSpec round-trips valid JSON and surfaces stable error code on malformed JSON', () => {
  freshDir();
  const spec = { kind: 'json', schema: { type: 'object' } };
  const ok = parseOutputAgainstSpec('{"a":1}', spec);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.parsed, { a: 1 });
  assert.equal(ok.error, null);

  const bad = parseOutputAgainstSpec('{not json', spec);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'json_parse_error');
  assert.equal(bad.parsed, null);

  // Type mismatch — schema says object, output is array.
  const wrongType = parseOutputAgainstSpec('[1,2,3]', spec);
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.error, 'json_type_mismatch');

  // Regex round-trip.
  const reOk = parseOutputAgainstSpec('hello', { kind: 'regex', schema: '^hello$' });
  assert.equal(reOk.ok, true);
  const reBad = parseOutputAgainstSpec('hey', { kind: 'regex', schema: '^hello$' });
  assert.equal(reBad.ok, false);
  assert.equal(reBad.error, 'regex_no_match');

  // No-schema path — always ok.
  const none = parseOutputAgainstSpec('anything', null);
  assert.equal(none.ok, true);
});

// =============================================================================
// 8) Bakeoff summary surfaces parse_failure_rate ALONGSIDE pass_rate
// =============================================================================

test('W809 #8 — bakeoff summary surfaces parse_failure_rate when schema_spec is passed', async () => {
  freshDir();
  // The cache contestant returns calls with c.got = opts.cacheKeys[r.input]
  // so we use it to drive deterministic outputs (no LLM, no network). We
  // build a mix of valid + invalid JSON to assert parse_failure_rate.
  const { bakeoff } = await import('../src/bakeoff.js');
  const rows = [
    { input: 'i1', output: '{"a":1}' },          // valid JSON object
    { input: 'i2', output: '{"a":2}' },          // valid JSON object
    { input: 'i3', output: 'not json' },         // invalid JSON
    { input: 'i4', output: '[1,2,3]' },          // valid JSON but type mismatch
  ];
  // runCache returns row's cacheKeys value as `got`; mirror outputs verbatim
  // so the parse-validation track sees exactly those strings.
  const cacheKeys = {
    i1: '{"a":1}',
    i2: '{"a":2}',
    i3: 'not json',
    i4: '[1,2,3]',
  };
  const r = await bakeoff(
    rows,
    {
      contestants: ['cache'],
      opts: {
        rows,
        cacheKeys,
        schema_spec: { kind: 'json', schema: { type: 'object' } },
      },
    },
  );
  // pass_rate is preserved; parse_failure_rate is computed alongside.
  const cache = r.contestants.find((c) => c.name === 'cache');
  assert.ok(cache);
  assert.equal(typeof cache.pass_rate, 'number');
  assert.equal(typeof cache.parse_failure_rate, 'number');
  // 2 of 4 rows fail parse against {type:'object'}: 'not json' (parse error)
  // and '[1,2,3]' (type mismatch). expect parse_failure_rate ≈ 0.5.
  assert.ok(cache.parse_failure_rate > 0.4 && cache.parse_failure_rate < 0.6,
    `expected parse_failure_rate near 0.5; got ${cache.parse_failure_rate}`);
  // Critical: pass_rate is preserved verbatim, never substituted.
  // (We don't require pass_rate !== parse_failure_rate because the cache
  //  contestant's pass logic and parse logic can numerically coincide.)
  assert.ok('pass_rate' in cache, 'summary must still carry pass_rate');
  assert.ok('quality' in cache, 'summary must still carry quality alias');

  // No-schema path: parse_failure_rate is null (column present, value honest).
  const r2 = await bakeoff(rows, { contestants: ['cache'], opts: { rows, cacheKeys } });
  const cache2 = r2.contestants.find((c) => c.name === 'cache');
  assert.equal(cache2.parse_failure_rate, null,
    'parse_failure_rate must be null when no schema_spec is passed');
});

// =============================================================================
// 9) runWithSchemaRetry — temperature decay + retries_used in range
// =============================================================================

test('W809 #9 — runWithSchemaRetry respects temperature decay and bounded retries_used', async () => {
  freshDir();
  assert.deepEqual([...DEFAULT_TEMPERATURE_DECAY], [0.7, 0.3, 0.1]);
  assert.equal(OUTPUT_RETRY_VERSION, 'w809-v1');

  // Call records every temperature it sees. Returns invalid JSON for the
  // first 3 calls (initial + first 2 retries) and a valid JSON object on
  // the 3rd retry (attempt index 3).
  const temps = [];
  let attemptIdx = 0;
  const call = async ({ temperature }) => {
    temps.push(temperature);
    attemptIdx += 1;
    if (attemptIdx < 4) return 'still not json';
    return '{"ok":1}';
  };
  const r = await runWithSchemaRetry(call, { kind: 'json', schema: { type: 'object' } });
  assert.equal(r.ok, true);
  assert.equal(r.splice_triggered, false);
  assert.equal(r.retries_used, 3, `expected retries_used:3, got ${r.retries_used}`);
  // attempts[] has 4 entries (initial + 3 retries).
  assert.equal(r.attempts.length, 4);
  // temps[0] is the initial-attempt temperature (undefined); temps[1..3] are
  // the decay 0.7, 0.3, 0.1.
  assert.equal(temps[0], undefined);
  assert.equal(temps[1], 0.7);
  assert.equal(temps[2], 0.3);
  assert.equal(temps[3], 0.1);
  // The successful (final) attempt records ok:true with the matching temperature.
  assert.equal(r.attempts[3].ok, true);
  assert.equal(r.attempts[3].temperature, 0.1);
});

// =============================================================================
// 10) runWithSchemaRetry — splice escalation
// =============================================================================

test('W809 #10 — runWithSchemaRetry escalates to onTeacherSplice after retries exhausted', async () => {
  freshDir();
  let calls = 0;
  const call = async () => {
    calls += 1;
    return 'still not json';
  };
  let spliceCalled = 0;
  const onTeacherSplice = async () => {
    spliceCalled += 1;
    return '{"recovered":true}';
  };
  const r = await runWithSchemaRetry(
    call,
    { kind: 'json', schema: { type: 'object' } },
    { onTeacherSplice },
  );
  assert.equal(r.ok, true);
  assert.equal(r.splice_triggered, true);
  assert.equal(spliceCalled, 1);
  // 1 initial + 3 retries before the splice = 4 user-call invocations.
  assert.equal(calls, 4);
  // attempts[] = 4 user attempts + 1 splice attempt = 5 entries.
  assert.equal(r.attempts.length, 5);
  assert.equal(r.attempts[r.attempts.length - 1].temperature, 'teacher_splice');
  assert.equal(r.attempts[r.attempts.length - 1].ok, true);
});

// =============================================================================
// 11) Worker shell honest envelope when CONSTRAINED_DECODE_CMD is missing
// =============================================================================

test('W809 #11 — worker shell honest envelope on no_constrained_decoder', () => {
  const tmp = freshDir();
  // Stage a minimal valid request.json so we get past the input shape check.
  const reqPath = path.join(tmp, 'req.json');
  const outPath = path.join(tmp, 'resp.json');
  fs.writeFileSync(reqPath, JSON.stringify({
    version: OUTPUT_SCHEMA_VERSION,
    prompt: 'hello',
    schema_spec: { kind: 'json', schema: { type: 'object' }, strict: false },
    base_model: null,
    sampler_opts: {},
  }));
  const fake = path.join(tmp, 'no-binary-' + crypto.randomBytes(4).toString('hex'));
  const env = {
    ...process.env,
    CONSTRAINED_DECODE_CMD: fake,
    // Clear PATH so python(3) isn't found as a fallback and the missing-
    // override branch actually fires.
    PATH: '',
    Path: '',
  };
  const r = spawnSync(process.execPath, [
    WORKER_SHELL,
    '--input', reqPath,
    '--output', outPath,
  ], { env, encoding: 'utf8', timeout: 30_000 });

  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope on stdout; stdout=${stdout.slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)}`);
  const env_out = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(env_out.ok, false);
  assert.equal(env_out.error, 'no_constrained_decoder');
  assert.ok(typeof env_out.hint === 'string' && env_out.hint.length > 0);
  assert.equal(env_out.version, OUTPUT_SCHEMA_VERSION);
  assert.equal(r.status, 3,
    `expected exit 3 on no_constrained_decoder; got ${r.status}`);
});

// =============================================================================
// 12) CLI dispatchers exist (cmdCompileOutputSchema + _w809VerifyOutputSchema)
// =============================================================================

test('W809 #12 — cli/kolm.js carries cmdCompileOutputSchema + _w809VerifyOutputSchema + --output-schema + --validate-schema', () => {
  freshDir();
  // Source-level presence check — we are not running the live CLI here (the
  // CLI exits on its own; we already cover the two helper behaviors directly
  // in tests #3 + #7 via the underlying validators). Source check guards
  // against accidental deletion of the load-bearing dispatchers.
  const src = fs.readFileSync(CLI_PATH, 'utf8');
  assert.ok(src.includes('async function cmdCompileOutputSchema'),
    'cli/kolm.js must define cmdCompileOutputSchema helper for --output-schema');
  assert.ok(src.includes('async function _w809VerifyOutputSchema'),
    'cli/kolm.js must define _w809VerifyOutputSchema helper for --validate-schema');
  // Flag plumbing must be present.
  assert.ok(/--output-schema/.test(src), 'cli/kolm.js must reference --output-schema flag');
  assert.ok(/--validate-schema/.test(src), 'cli/kolm.js must reference --validate-schema flag');
});

// =============================================================================
// 13) doctorConstrainedDecode envelope shape
// =============================================================================

test('W809 #13 — doctorConstrainedDecode returns a stable envelope shape', () => {
  freshDir();
  const r = doctorConstrainedDecode();
  // The doctor itself must always run; ok refers to "the doctor ran" not
  // "the runtime is ready". `ready` is the boolean that flips with library
  // presence.
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(typeof r.ready, 'boolean');
  assert.equal(r.version, OUTPUT_SCHEMA_VERSION);
  // Hint is null when ready, a non-empty string otherwise.
  if (r.ready) {
    assert.equal(r.hint, null);
  } else {
    assert.ok(typeof r.hint === 'string' && r.hint.length > 0,
      `expected install hint when not ready; got ${JSON.stringify(r)}`);
  }
});
