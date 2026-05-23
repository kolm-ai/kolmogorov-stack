// W809-4 — Runtime auto-retry on parse failure.
//
// Standalone retry harness used by the runtime-wrap loop. We DO NOT edit
// src/runtime-wrap.js here — the orchestrator wires this function into the
// shared runtime-wrap path (shared with W807 teacher splice). This module
// owns:
//
//   * The temperature decay schedule (0.7 → 0.3 → 0.1).
//   * The 3-retries-then-splice escalation policy.
//   * The honest envelope shape the orchestrator can stamp into receipts.
//
// Public surface:
//
//   runWithSchemaRetry(call, schema_spec, options) →
//     { ok, output, parsed, retries_used, splice_triggered, attempts:[] }
//
// Where:
//   call(opts)      : async (opts:{temperature, attempt}) → string | {output, ...}
//                     The caller's existing inference path; we just bump
//                     temperature + count retries.
//   schema_spec     : the W809-1 spec block; if null/empty we no-op and
//                     return the first call's output unchanged.
//   options:
//     maxRetries:   integer ≥ 0 — defaults to 3. The 4th attempt is the
//                   teacher splice fallback (caller-injected).
//     temperatures: optional array overriding the [0.7, 0.3, 0.1] decay.
//                   Tests inject [1, 2, 3] to assert wiring.
//     onTeacherSplice: optional async () → string | {output} — called when
//                   maxRetries+1 attempts have been exhausted. Returns its
//                   output through unchanged. The W807 hook lives here.
//     spec_validator: optional (output, spec) → {ok, parsed, error} override
//                   for tests (defaults to parseOutputAgainstSpec).
//
// W604 anti-brittleness: attempts[] entries carry stable codes
// {temperature, ok, parse_error|null}. No regex on free-form messages.

import {
  parseOutputAgainstSpec,
  canonicalizeOutputSchemaSpec,
} from './output-schema.js';

export const DEFAULT_TEMPERATURE_DECAY = Object.freeze([0.7, 0.3, 0.1]);
export const OUTPUT_RETRY_VERSION = 'w809-v1';

function extractOutput(callResult) {
  if (callResult == null) return '';
  if (typeof callResult === 'string') return callResult;
  if (typeof callResult === 'object' && typeof callResult.output === 'string') {
    return callResult.output;
  }
  if (typeof callResult === 'object' && typeof callResult.text === 'string') {
    return callResult.text;
  }
  return String(callResult);
}

export async function runWithSchemaRetry(call, schema_spec, options = {}) {
  if (typeof call !== 'function') {
    throw new TypeError('runWithSchemaRetry: call must be a function');
  }

  const canon = canonicalizeOutputSchemaSpec(schema_spec);
  // No schema → one call, no retries, no parsing.
  if (canon === null) {
    const out = extractOutput(await call({ temperature: undefined, attempt: 0 }));
    return {
      ok: true,
      output: out,
      parsed: out,
      retries_used: 0,
      splice_triggered: false,
      attempts: [{ temperature: undefined, ok: true, parse_error: null }],
      version: OUTPUT_RETRY_VERSION,
    };
  }

  const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 3;
  const temps = Array.isArray(options.temperatures) && options.temperatures.length
    ? options.temperatures
    : DEFAULT_TEMPERATURE_DECAY;
  const validator = typeof options.spec_validator === 'function'
    ? options.spec_validator
    : parseOutputAgainstSpec;
  const onTeacherSplice = typeof options.onTeacherSplice === 'function'
    ? options.onTeacherSplice
    : null;

  const attempts = [];
  let lastOutput = '';
  let lastParsed = null;

  // 1 initial attempt + maxRetries retries = (maxRetries+1) call attempts
  // BEFORE the teacher splice escalation. Each retry uses temps[i-1] (i is
  // 1-based for the retry count) — temps[0] is the first retry's temperature
  // because attempt 0 uses the caller-supplied temperature (or undefined).
  for (let i = 0; i <= maxRetries; i += 1) {
    const temperature = i === 0
      ? options.initial_temperature !== undefined ? options.initial_temperature : undefined
      : temps[Math.min(i - 1, temps.length - 1)];
    const result = await call({ temperature, attempt: i });
    const output = extractOutput(result);
    const check = validator(output, schema_spec);
    attempts.push({
      temperature,
      ok: !!check.ok,
      parse_error: check.error || null,
    });
    lastOutput = output;
    if (check.ok) {
      lastParsed = check.parsed;
      return {
        ok: true,
        output,
        parsed: check.parsed,
        retries_used: i,
        splice_triggered: false,
        attempts,
        version: OUTPUT_RETRY_VERSION,
      };
    }
  }

  // All retries exhausted. Try the teacher splice if wired.
  if (onTeacherSplice) {
    try {
      const sResult = await onTeacherSplice();
      const sOutput = extractOutput(sResult);
      const sCheck = validator(sOutput, schema_spec);
      attempts.push({
        temperature: 'teacher_splice',
        ok: !!sCheck.ok,
        parse_error: sCheck.error || null,
      });
      if (sCheck.ok) {
        return {
          ok: true,
          output: sOutput,
          parsed: sCheck.parsed,
          retries_used: maxRetries,
          splice_triggered: true,
          attempts,
          version: OUTPUT_RETRY_VERSION,
        };
      }
      // Even the teacher splice failed to parse. Surface the raw text but
      // ok:false so the receipt records the dishonest outcome.
      return {
        ok: false,
        output: sOutput,
        parsed: null,
        retries_used: maxRetries,
        splice_triggered: true,
        error: 'splice_parse_failed',
        attempts,
        version: OUTPUT_RETRY_VERSION,
      };
    } catch (e) {
      attempts.push({
        temperature: 'teacher_splice',
        ok: false,
        parse_error: 'splice_threw',
      });
      return {
        ok: false,
        output: lastOutput,
        parsed: null,
        retries_used: maxRetries,
        splice_triggered: true,
        error: 'splice_threw',
        detail: String(e && e.message || e),
        attempts,
        version: OUTPUT_RETRY_VERSION,
      };
    }
  }

  // No splice configured: return the final un-parseable output with ok:false.
  return {
    ok: false,
    output: lastOutput,
    parsed: lastParsed,
    retries_used: maxRetries,
    splice_triggered: false,
    error: attempts[attempts.length - 1]?.parse_error || 'parse_failed',
    attempts,
    version: OUTPUT_RETRY_VERSION,
  };
}

export default {
  runWithSchemaRetry,
  DEFAULT_TEMPERATURE_DECAY,
  OUTPUT_RETRY_VERSION,
};
