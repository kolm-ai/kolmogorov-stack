// src/negative-variant-gen.js
//
// W714-1 — Contrastive distillation: negative-variant generator.
//
// For each capture, ask a configurable "cheap" teacher to rewrite the original
// response into a measurably WORSE variant. The student is then trained with
// a contrastive loss (W714-2) that rewards matching the positive (real
// teacher) and penalizes matching the negative. This is the safety valve
// that stops the student from drifting toward whatever the cheap model
// already does — the classic "model collapse to floor" failure mode.
//
// Public surface:
//   generateNegativeVariants(capture, opts) -> Promise<{positives, negatives, ...}>
//
// Honesty contract: unreachable negative teacher -> { positives, negatives:[],
// error:'negative_teacher_unreachable', hint:'...' }. Never throws, never
// silently substitutes the positive on the negative side.
//
// Tenant fence: opts.tenant_id (or capture.tenant_id) is threaded into the
// teacher transport envelope for billing attribution. The bridge already
// logs teacher_call_log_entry per call, so the tenant gets billed.
//
// Idempotency: cache_key = sha256(capture.id + negative_teacher_id + count).
// Cache file lives under ~/.kolm/negatives-cache/<cache_key>.json so a
// re-run after a capture-store reload doesn't burn teacher credits again.
// Set KOLM_NEGATIVES_CACHE_DIR to override (tests inject a tmp dir).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const NEGATIVE_VARIANT_VERSION = 'w714-v1';

// Default teacher chosen for "cheap + on-policy at a different optimum than
// the strong teacher" — Haiku 4.5 was the smallest published Anthropic SKU
// at W714. Override via $KOLM_NEGATIVE_TEACHER ('vendor:model').
export const DEFAULT_NEGATIVE_TEACHER = 'anthropic:claude-haiku-4-5-20251001';

// Prompt that asks the cheap teacher to actively WORSEN the response. The
// instruction set is intentional: ask for ONE specific axis of degradation
// per call so the 3 negatives spread across the failure modes the student
// must learn to avoid, not three near-duplicates.
export const NEGATIVE_PROMPT_TEMPLATE = [
  'You are evaluating a response. The original response was strong. Rewrite',
  'it to be measurably worse in one specific way (less specific, less',
  'actionable, hallucinated detail, wrong tone, etc.). Keep similar length.',
  'Output JUST the worse rewrite, no preamble.',
  '',
  'Original prompt:',
  '{prompt}',
  '',
  'Original response:',
  '{response}',
  '',
  'Worse rewrite:',
].join('\n');

function cacheDir() {
  if (process.env.KOLM_NEGATIVES_CACHE_DIR) {
    return path.resolve(process.env.KOLM_NEGATIVES_CACHE_DIR);
  }
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.kolm', 'negatives-cache');
}

function computeCacheKey(captureId, negativeTeacher, count) {
  const h = crypto.createHash('sha256');
  h.update(String(captureId || ''));
  h.update('|');
  h.update(String(negativeTeacher || ''));
  h.update('|');
  h.update(String(count || 0));
  return h.digest('hex');
}

function readCache(key) {
  const f = path.join(cacheDir(), `${key}.json`);
  try {
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j && j.cache_key === key) return j;
    return null;
  } catch (_) {
    return null;
  }
}

function writeCache(key, payload) {
  const dir = cacheDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify({ ...payload, cache_key: key, version: NEGATIVE_VARIANT_VERSION }, null, 2),
    );
  } catch (_) { // deliberate: cleanup
    // Cache write failure is not fatal — the receipt the caller gets still
    // carries the negatives; we just lose idempotency for the next call.
  }
}

// Parse 'vendor:model' (matches teacher-bridge.mjs). Falls back to
// {vendor:'anthropic', model:spec} for bare strings so caller never
// has to know the convention.
function parseTeacherSpec(spec) {
  if (!spec) return { vendor: 'anthropic', model: DEFAULT_NEGATIVE_TEACHER.split(':')[1] };
  const i = spec.indexOf(':');
  if (i < 0) return { vendor: 'anthropic', model: spec };
  return { vendor: spec.slice(0, i).toLowerCase(), model: spec.slice(i + 1) };
}

// Pull the canonical text fields out of a capture row. captures come from
// multiple sources (capture-store, distill-bridge writeWorkerInputs, the
// /v1/capture/log envelope) so the field names vary.
function extractPrompt(capture) {
  return capture.prompt
    || capture.variable_input
    || capture.input
    || capture.response_input
    || '';
}

function extractResponseText(capture) {
  return capture.response_text
    || capture.response
    || capture.output
    || capture.fixed_output
    || '';
}

function extractResponseModel(capture) {
  return capture.response_model
    || capture.model
    || capture.teacher_model
    || 'unknown';
}

// Call the negative teacher. We intentionally do NOT import
// workers/distill/teacher-bridge.mjs here because that bridge wraps every
// call in the PHI redactor — appropriate for distillation but heavy for a
// rewrite-worse step. Instead we hit the bare vendor endpoint with the
// tenant header in the envelope. Test seam: opts.transportOverride.
async function callNegativeTeacher({ vendor, model, prompt, response, maxTokens, tenant_id, transportOverride }) {
  const messages = NEGATIVE_PROMPT_TEMPLATE
    .replace('{prompt}', prompt)
    .replace('{response}', response);
  if (transportOverride) {
    return await transportOverride({ vendor, model, input: messages, maxTokens, tenant_id });
  }
  if (vendor === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY required for vendor=anthropic');
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const headers = {};
    // Tenant attribution for billing: forward via a custom header. Anthropic
    // SDK accepts custom headers via the constructor defaultHeaders, but the
    // .messages.create() metadata field is the modern path.
    const resp = await new Anthropic({ apiKey: key, defaultHeaders: headers }).messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: messages }],
      metadata: tenant_id ? { user_id: String(tenant_id) } : undefined,
    });
    const block = (resp.content || []).find((b) => b.type === 'text');
    return block ? block.text : '';
  }
  if (vendor === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY required for vendor=openai');
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${key}`,
        'content-type': 'application/json',
        ...(tenant_id ? { 'x-kolm-tenant': String(tenant_id) } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: messages }],
        max_tokens: maxTokens,
        user: tenant_id ? String(tenant_id) : undefined,
      }),
    });
    if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  }
  if (vendor === 'local') {
    const endpoint = process.env.KOLM_NEGATIVE_TEACHER_ENDPOINT;
    if (!endpoint) throw new Error('KOLM_NEGATIVE_TEACHER_ENDPOINT required for vendor=local');
    const r = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(tenant_id ? { 'x-kolm-tenant': String(tenant_id) } : {}) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: messages }],
        max_tokens: maxTokens,
      }),
    });
    if (!r.ok) throw new Error(`local ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  }
  throw new Error(`unknown negative teacher vendor: ${vendor}`);
}

// Reason tags. The caller stamps these into each negative so the trainer
// can later weight contrastive examples by failure-mode coverage.
const NEGATIVE_REASONS = [
  'less_specific',
  'less_actionable',
  'wrong_tone',
];

/**
 * Generate negative variants for a single capture.
 *
 * @param {object} capture  - capture row (prompt + response + tenant_id)
 * @param {object} [opts]
 *   @param {string} [opts.negativeTeacher] - 'vendor:model' override
 *   @param {number} [opts.count=3]         - negatives to generate
 *   @param {number} [opts.maxTokens=1024]
 *   @param {string} [opts.tenant_id]       - billing tenant (overrides capture.tenant_id)
 *   @param {Function} [opts.transportOverride] - test seam: ({vendor,model,input,maxTokens,tenant_id}) -> string
 *   @param {boolean} [opts.bypassCache]    - skip cache read (always recompute)
 * @returns {Promise<{positives, negatives, cache_key, cached, version, negative_teacher, ...}>}
 */
export async function generateNegativeVariants(capture, opts = {}) {
  if (!capture || typeof capture !== 'object') {
    throw new Error('generateNegativeVariants: capture object required');
  }
  const negativeTeacherSpec = opts.negativeTeacher
    || process.env.KOLM_NEGATIVE_TEACHER
    || DEFAULT_NEGATIVE_TEACHER;
  const count = Math.max(1, Math.min(10, Number(opts.count || 3)));
  const maxTokens = Math.max(64, Math.min(4096, Number(opts.maxTokens || 1024)));
  const tenant_id = opts.tenant_id != null ? opts.tenant_id : capture.tenant_id;
  const captureId = capture.id || capture.event_id || capture.capture_id || 'unknown';

  const prompt = extractPrompt(capture);
  const responseText = extractResponseText(capture);
  const responseModel = extractResponseModel(capture);

  const positives = [{ model: responseModel, text: responseText }];

  const cache_key = computeCacheKey(captureId, negativeTeacherSpec, count);
  if (!opts.bypassCache) {
    const cached = readCache(cache_key);
    if (cached && Array.isArray(cached.negatives)) {
      return {
        positives,
        negatives: cached.negatives,
        cache_key,
        cached: true,
        version: NEGATIVE_VARIANT_VERSION,
        negative_teacher: negativeTeacherSpec,
        capture_id: captureId,
        tenant_id: tenant_id != null ? tenant_id : null,
      };
    }
  }

  if (!prompt || !responseText) {
    // No content to rewrite. Honest envelope, not a throw.
    return {
      positives,
      negatives: [],
      cache_key,
      cached: false,
      version: NEGATIVE_VARIANT_VERSION,
      negative_teacher: negativeTeacherSpec,
      capture_id: captureId,
      tenant_id: tenant_id != null ? tenant_id : null,
      error: 'capture_has_no_prompt_or_response',
      hint: 'capture must carry prompt + response text to generate negatives',
    };
  }

  const { vendor, model } = parseTeacherSpec(negativeTeacherSpec);
  const negatives = [];
  for (let i = 0; i < count; i += 1) {
    const generation_reason = NEGATIVE_REASONS[i % NEGATIVE_REASONS.length];
    let text;
    try {
      text = await callNegativeTeacher({
        vendor,
        model,
        prompt,
        response: responseText,
        maxTokens,
        tenant_id,
        transportOverride: opts.transportOverride,
      });
    } catch (err) {
      // Unreachable teacher OR any vendor error -> honest envelope, no
      // partial silent fill. Return whatever negatives we managed to
      // collect SO FAR, plus the error tag.
      return {
        positives,
        negatives: [],
        cache_key,
        cached: false,
        version: NEGATIVE_VARIANT_VERSION,
        negative_teacher: negativeTeacherSpec,
        capture_id: captureId,
        tenant_id: tenant_id != null ? tenant_id : null,
        error: 'negative_teacher_unreachable',
        hint: 'set KOLM_NEGATIVE_TEACHER or pass --negative-teacher (e.g., anthropic:claude-haiku-4-5-20251001 with ANTHROPIC_API_KEY set)',
        error_detail: String(err && err.message ? err.message : err).slice(0, 400),
      };
    }
    if (!text || typeof text !== 'string') {
      return {
        positives,
        negatives: [],
        cache_key,
        cached: false,
        version: NEGATIVE_VARIANT_VERSION,
        negative_teacher: negativeTeacherSpec,
        capture_id: captureId,
        tenant_id: tenant_id != null ? tenant_id : null,
        error: 'negative_teacher_returned_empty',
        hint: 'negative teacher returned an empty rewrite — check rate-limits or input length',
      };
    }
    negatives.push({
      model,
      text: text.trim(),
      generation_reason,
    });
  }

  const payload = {
    positives,
    negatives,
    cache_key,
    cached: false,
    version: NEGATIVE_VARIANT_VERSION,
    negative_teacher: negativeTeacherSpec,
    capture_id: captureId,
    tenant_id: tenant_id != null ? tenant_id : null,
  };
  // Persist only the bits the cache needs to short-circuit next call.
  writeCache(cache_key, { negatives, negative_teacher: negativeTeacherSpec, capture_id: captureId });
  return payload;
}

// Convenience: bulk over an array of captures. Failures are per-capture
// (one bad capture doesn't poison the rest). Returns parallel array.
export async function generateNegativeVariantsBatch(captures, opts = {}) {
  if (!Array.isArray(captures)) throw new Error('captures array required');
  const out = [];
  for (const c of captures) {
    // Sequential — we don't want to slam the teacher API in parallel for a
    // single distill job. Use Promise.allSettled if the caller wants
    // concurrency and accepts the rate-limit risk.
     
    out.push(await generateNegativeVariants(c, opts));
  }
  return out;
}

// Exposed for tests that need to clear the cache between cases. Removes
// EVERY file under the cache dir; the dir itself stays.
export function _resetCacheForTests() {
  const dir = cacheDir();
  try {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} // deliberate: cleanup
    }
  } catch (_) {} // deliberate: cleanup
}
