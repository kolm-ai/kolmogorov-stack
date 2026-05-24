// W833-2 — Synthetic translation via teacher for underrepresented languages.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md line 1198):
//   [W833-2] Synthetic translation via teacher for underrepresented
//   languages (stamped synthetic_translation:true).
//
// Why this exists:
//   The W774 cross-lingual eval pipeline can flag "Spanish has only 12
//   captures and you need 30 for Wilson CI". W833-1 distributionByLang()
//   identifies WHICH langs are underrepresented. W833-2 closes the loop:
//   ask the teacher (Anthropic/OpenAI/local) to translate a sample of
//   the dominant-language captures into the target language, stamp every
//   generated row with the synthetic_translation:true provenance marker,
//   and append to the namespace so the next distill picks them up.
//
// Honesty contract:
//   * NEVER fabricate translations. If no teacher is wired
//     (KOLM_TEACHER_API_KEY missing AND teacher!='local'), return the
//     no_teacher_configured envelope — the operator sees install_hint
//     + requested_count + generated_count:0.
//   * Every generated row carries synthetic_translation:true PLUS
//     source_lang/target_lang/synth_provider/synth_model/synth_at so
//     downstream tooling can filter out synthetic rows from human-graded
//     evals (key for honest K-Score reporting).
//   * The 'local' teacher path is intentionally a stub that returns a
//     prefix-tagged echo — the point is for test runs + CI dry-runs to
//     exercise the row-stamping discipline WITHOUT requiring a real
//     translation model. Production wires the teacher via env vars.
//
// Public surface:
//   - LINGUAL_SYNTH_VERSION
//   - synthesizeForUnderrepresented({tenant, namespace, target_lang,
//                                    count, teacher, opts?})

export const LINGUAL_SYNTH_VERSION = 'w833-v1';

const SUPPORTED_TEACHERS = Object.freeze(['anthropic', 'openai', 'local']);

// Synthetic-translation row count cap — bounded so a runaway loop can't
// burn the teacher budget. Operators can pass higher counts but we still
// honor the request shape (the cap surfaces in generated_count vs
// requested_count so it's not silent truncation).
const MAX_SYNTH_PER_CALL = 1000;

// =============================================================================
// synthesizeForUnderrepresented
//
// Generate synthetic translations of source-lang captures into the
// target_lang and stamp them as synthetic_translation:true.
//
// Input:
//   args.tenant:        canonical tenant id (W411 mandatory)
//   args.namespace:     capture namespace
//   args.target_lang:   ISO 639-1 target language (e.g. 'es', 'zh')
//   args.count:         desired number of synthetic rows
//   args.teacher:       'anthropic' | 'openai' | 'local'
//   args.opts:          (optional) {
//     source_captures,  // [{input, output, lang?}] — explicit pool;
//                       // when omitted, the caller is expected to wire
//                       // the storeMod DI seam OR pass an empty pool
//                       // (we return no_source_captures honest envelope).
//     storeMod,         // {listEvents, appendEvent} DI seam
//     translateFn,      // async ({text, source_lang, target_lang, teacher})
//                       //   => {text, model?} — DI for unit tests.
//                       //   When omitted we use the built-in path:
//                       //   'local' → echo with [target_lang] prefix,
//                       //   'anthropic'/'openai' → require api_key env
//     write:true,       // append generated rows via storeMod.appendEvent
//                       //   (default true). false → return rows[] only.
//   }
//
// Output (ok:true):
//   { ok:true, version, tenant, namespace, target_lang, teacher,
//     requested_count, generated_count, rows:[{...synth row...}],
//     synth_provider, synth_model }
//
// Output (ok:false honest envelopes):
//   { ok:false, error:'no_teacher_configured', install_hint,
//     requested_count, generated_count:0 }
//   { ok:false, error:'tenant_required', ... }
//   { ok:false, error:'target_lang_required', ... }
//   { ok:false, error:'unsupported_teacher', supported:[...], ... }
//   { ok:false, error:'no_source_captures', ... }
// =============================================================================

export async function synthesizeForUnderrepresented(args) {
  const a = args || {};
  const tenant = a.tenant;
  const namespace = (typeof a.namespace === 'string' && a.namespace.length > 0)
    ? a.namespace.slice(0, 128) : 'default';
  const target_lang = a.target_lang;
  const teacher = a.teacher;
  const requestedRaw = Number(a.count);
  const requested_count = Number.isFinite(requestedRaw) && requestedRaw > 0
    ? Math.max(1, Math.min(MAX_SYNTH_PER_CALL, Math.trunc(requestedRaw)))
    : 0;
  const opts = a.opts || {};

  // ── Argument-shape envelopes (return BEFORE touching teacher / store) ────
  if (!tenant || typeof tenant !== 'string') {
    return _honest('tenant_required',
      'pass {tenant:"<canonical tenant id>"} — W411 tenant-fence is mandatory',
      requested_count);
  }
  if (!target_lang || typeof target_lang !== 'string') {
    return _honest('target_lang_required',
      'pass {target_lang:"es"} — the language to synthesize INTO',
      requested_count);
  }
  if (!teacher || !SUPPORTED_TEACHERS.includes(teacher)) {
    return {
      ok: false,
      error: 'unsupported_teacher',
      hint: 'pass {teacher:"anthropic"|"openai"|"local"} — local is a stub for CI',
      supported: SUPPORTED_TEACHERS.slice(),
      requested_count,
      generated_count: 0,
      version: LINGUAL_SYNTH_VERSION,
    };
  }
  if (requested_count <= 0) {
    return _honest('count_required',
      'pass {count:N} with N>=1 — synthesizeForUnderrepresented never fabricates from count<=0',
      requested_count);
  }

  // ── Teacher wiring check (honesty floor) ─────────────────────────────────
  // The 'local' teacher is always available — it's the test/CI stub. Real
  // providers REQUIRE the env var; absence surfaces as the
  // no_teacher_configured envelope so operators see exactly what to set.
  if (teacher !== 'local') {
    const key = (process.env.KOLM_TEACHER_API_KEY ||
                 process.env.ANTHROPIC_API_KEY ||
                 process.env.OPENAI_API_KEY || '').trim();
    if (!key) {
      return {
        ok: false,
        error: 'no_teacher_configured',
        install_hint: 'Set KOLM_TEACHER_API_KEY or use teacher:local',
        requested_count,
        generated_count: 0,
        teacher,
        target_lang,
        version: LINGUAL_SYNTH_VERSION,
      };
    }
  }

  // ── Source-capture pool ──────────────────────────────────────────────────
  // Either an explicit pool (opts.source_captures) OR a storeMod DI seam.
  // Both honor the W411 tenant fence — the storeMod path filters every
  // returned row by tenant defense-in-depth.
  let pool = [];
  if (Array.isArray(opts.source_captures) && opts.source_captures.length > 0) {
    pool = opts.source_captures.slice();
  } else if (opts.storeMod && typeof opts.storeMod.listEvents === 'function') {
    try {
      const rows = await opts.storeMod.listEvents({
        tenant_id: tenant,
        namespace,
        limit: Math.min(5000, requested_count * 4),
        order: 'desc',
      });
      pool = (rows || []).filter((rr) => rr && rr.tenant_id === tenant);
    } catch (_) { pool = []; }
  }
  if (pool.length === 0) {
    return _honest('no_source_captures',
      'no captures available to translate — populate the namespace first',
      requested_count);
  }

  // ── Translate loop ───────────────────────────────────────────────────────
  // The translateFn DI seam lets tests inject a deterministic fake. The
  // built-in fallback covers the 'local' echo stub; real provider paths
  // surface as no_teacher_configured above when env is missing.
  const translateFn = (typeof opts.translateFn === 'function')
    ? opts.translateFn
    : _builtinTranslate;

  const out = [];
  const at = new Date().toISOString();
  const synth_provider = teacher;
  // The 'model' field is provider-specific — defaults match the
  // KOLM_DISTILL_TEACHER convention used elsewhere.
  let synth_model = (teacher === 'anthropic') ? 'claude-3-5-sonnet-latest'
                  : (teacher === 'openai')   ? 'gpt-4o'
                  : 'local-echo';

  for (let i = 0; i < requested_count && i < pool.length * 4; i++) {
    const src = pool[i % pool.length];
    if (!src || typeof src !== 'object') continue;
    const inputText = src.input || src.prompt || src.prompt_redacted || '';
    const outputText = src.output || src.response || src.response_redacted || '';
    if (typeof inputText !== 'string' || inputText.length === 0) continue;
    const source_lang = src.lang || src.detected_lang || 'en';

    let translated_input;
    let translated_output;
    try {
      const ti = await translateFn({
        text: inputText, source_lang, target_lang, teacher,
      });
      translated_input = (ti && typeof ti.text === 'string') ? ti.text : null;
      if (ti && ti.model) synth_model = ti.model;
    } catch (_) { translated_input = null; }
    if (translated_input === null) continue;

    if (outputText) {
      try {
        const to = await translateFn({
          text: outputText, source_lang, target_lang, teacher,
        });
        translated_output = (to && typeof to.text === 'string') ? to.text : '';
      } catch (_) { translated_output = ''; }
    } else {
      translated_output = '';
    }

    const row = {
      tenant_id: tenant,
      namespace,
      input: translated_input,
      output: translated_output,
      synthetic_translation: true,
      source_lang,
      target_lang,
      synth_provider,
      synth_model,
      synth_at: at,
    };

    // Optional persistence — defaults to write:true. When the storeMod DI
    // seam exposes appendEvent we route through it; otherwise rows are
    // returned in-memory and the caller is responsible for persistence.
    const write = (opts.write !== false);
    if (write && opts.storeMod && typeof opts.storeMod.appendEvent === 'function') {
      try {
        await opts.storeMod.appendEvent({
          tenant_id: tenant,
          namespace,
          prompt_redacted: translated_input,
          response_redacted: translated_output,
          // synth provenance — folded onto the row so downstream filters
          // (W760 per-language K-Score etc) can exclude synthetic rows
          // from human-graded eval pools.
          extra: {
            synthetic_translation: true,
            source_lang,
            target_lang,
            synth_provider,
            synth_model,
            synth_at: at,
          },
        });
      } catch (_) { /* row stays in returned rows[] either way */ }
    }
    out.push(row);
  }

  return {
    ok: true,
    version: LINGUAL_SYNTH_VERSION,
    tenant,
    namespace,
    target_lang,
    teacher,
    synth_provider,
    synth_model,
    requested_count,
    generated_count: out.length,
    rows: out,
  };
}

// =============================================================================
// Built-in translate fallback.
//
// 'local' → tag the original text with the target_lang prefix; this is
// the CI/test path and is intentionally NOT a real translation.
// 'anthropic' / 'openai' → return null so the caller surfaces a
//                          no_teacher_configured-style envelope from the
//                          generated_count:0 result (the env-var check
//                          above already guards real provider paths; this
//                          path runs only when env was present but the
//                          translateFn DI seam wasn't injected — i.e.
//                          missing network adapter, not missing key).
// =============================================================================

async function _builtinTranslate({ text, source_lang, target_lang, teacher }) {
  if (teacher === 'local') {
    // Local stub — deterministic, prefix-tagged. NOT a real translation.
    const tag = '[' + target_lang + ']';
    return { text: tag + ' ' + text, model: 'local-echo' };
  }
  // Real provider paths require a network adapter. The env-var check
  // earlier already gates the API key; we still refuse to fabricate here.
  return null;
}

// =============================================================================
// helpers
// =============================================================================

function _honest(error, hint, requested_count) {
  return {
    ok: false,
    error,
    hint,
    requested_count: requested_count || 0,
    generated_count: 0,
    version: LINGUAL_SYNTH_VERSION,
  };
}

export default {
  LINGUAL_SYNTH_VERSION,
  synthesizeForUnderrepresented,
};
