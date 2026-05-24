// W774 — Per-language artifact evaluation for cross-lingual distillation.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 643-648):
//   [W774-2] Per-language eval
//
// Why: W760 perLanguageKScore() evaluates CAPTURES (the data the student
// will see). W774 evaluatePerLanguage() evaluates an ARTIFACT (the
// student itself) against tenant-fenced captures, per-language, with the
// same Wilson 95% CI gating at n≥30. The two tools answer different
// questions:
//
//   * W760 perLanguageKScore — "does my dataset have enough Spanish?"
//   * W774 evaluatePerLanguage — "does my compiled student score well
//                                on Spanish captures?"
//
// Both honor the n≥30 Wilson floor — never report a CI on <30 rows; the
// language is moved into languages_skipped_below_n30:[] so the operator
// sees WHICH languages need more eval captures.
//
// Design contract:
//   - DI seams (runOnArtifact, judge, lang_detect, storeMod) so unit
//     tests don't need a real artifact OR a real model server.
//   - W411 defense-in-depth tenant fence — read tenant_id from arg AND
//     filter every returned row by tenant_id (never trust the listEvents
//     query alone).
//   - HONESTY FLOOR: every honest envelope on missing tenant_id, missing
//     artifact_path, OR no captures returned — no silent zeros.
//
// Public surface:
//   - XLANG_EVAL_VERSION
//   - evaluatePerLanguage({tenant_id, namespace, artifact_path, opts})
//   - compareLanguageDelta(eval_a, eval_b)

export const XLANG_EVAL_VERSION = 'w774-v1';

// Same Wilson 95% CI floor as W760 + W741 — n>=30 is the load-bearing
// honesty floor for a one-sided proportion estimate. Below 30 the CI
// width swallows the point estimate and reporting it is a "number-shaped
// lie" (W760 phrasing — kept verbatim for grep-cohesion).
const MIN_N_FOR_WILSON = 30;

// =============================================================================
// evaluatePerLanguage
//
// Run an artifact over tenant-fenced captures, partition outputs by
// detected language of the INPUT, score per partition.
//
// Input:
//   opts.tenant_id:       canonical tenant identifier (W411 mandatory)
//   opts.namespace:       capture namespace
//   opts.artifact_path:   path to compiled .kolm artifact
//   opts.opts.runOnArtifact: async (artifact_path, capture) =>
//                            {output, latency_ms, ok?, ...}
//   opts.opts.judge:      async ({input, expected, actual, lang}) =>
//                            {score:0..1, ok?, ...}
//   opts.opts.lang_detect: sync (text) => {lang, fallback}
//   opts.opts.storeMod:   {listEvents:async(q)=>rows[]} DI for event store
//
// Output (ok:true shape):
//   { ok:true, version, tenant_id, namespace, artifact_path,
//     by_lang:{
//       en:{ n, score, ci95_low, ci95_high, judge_failures },
//       es:{ n, score, ci95_low, ci95_high, judge_failures },
//       ...
//     },
//     gated_at_n: 30,                       // Wilson floor
//     pooled_score,                         // mean of all per-row scores
//     pooled_n,
//     languages_evaluated:[<iso>...],       // langs with n>=30
//     languages_skipped_below_n30:[{lang,n}],
//     captures_total,
//   }
//
// On failure:
//   { ok:false, error, hint, version } — honest, never fabricated.
// =============================================================================

export async function evaluatePerLanguage(args) {
  const a = args || {};
  const tenant_id = a.tenant_id;
  const namespace = (typeof a.namespace === 'string' && a.namespace.length > 0)
    ? a.namespace.slice(0, 128)
    : 'default';
  const artifact_path = a.artifact_path;
  const opts = a.opts || {};

  // W411 defense-in-depth — tenant_id is MANDATORY. Surface as honest
  // envelope, NEVER fall through to a tenant-less listEvents call.
  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'pass {tenant_id:"<canonical tenant id>"} — W411 tenant-fence is mandatory',
      version: XLANG_EVAL_VERSION,
    };
  }

  if (!artifact_path || typeof artifact_path !== 'string') {
    return {
      ok: false,
      error: 'artifact_path_required',
      hint: 'pass {artifact_path:"path/to/student.kolm"}',
      version: XLANG_EVAL_VERSION,
    };
  }

  // Resolve DI seams. The lang detector defaults to W760 read-only;
  // runOnArtifact + judge have no defaults — when missing we return an
  // honest envelope rather than fabricating a score.
  const lang_detect = await _resolveDetect(opts.lang_detect);
  const runOnArtifact = (typeof opts.runOnArtifact === 'function') ? opts.runOnArtifact : null;
  const judge = (typeof opts.judge === 'function') ? opts.judge : null;
  const storeMod = opts.storeMod || (await import('./event-store.js'));

  // Pull captures from the namespace under the tenant fence. listEvents
  // is the canonical accessor; we still filter again post-fetch
  // (W411 defense-in-depth: never trust a single fence).
  let captures = [];
  try {
    captures = await storeMod.listEvents({
      tenant_id,
      namespace,
      limit: 5000,
      order: 'desc',
    });
  } catch (_) { captures = []; }
  captures = (captures || []).filter((rr) => rr && rr.tenant_id === tenant_id);

  if (captures.length === 0) {
    return {
      ok: true,
      version: XLANG_EVAL_VERSION,
      tenant_id,
      namespace,
      artifact_path,
      by_lang: {},
      gated_at_n: MIN_N_FOR_WILSON,
      pooled_score: null,
      pooled_n: 0,
      languages_evaluated: [],
      languages_skipped_below_n30: [],
      captures_total: 0,
      hint: 'no captures in this namespace; nothing to evaluate',
    };
  }

  // Without a runOnArtifact DI seam we cannot score honestly. Surface as
  // an honest envelope including the count so the operator sees the
  // hosted-route limitation (and tests can verify it without running a
  // real artifact).
  if (!runOnArtifact) {
    return {
      ok: false,
      error: 'no_run_on_artifact_configured',
      hint: 'pass opts.runOnArtifact:(artifact, capture)=>{output, latency_ms} — hosted route ' +
            'has no runner DI by default; production wires this via req.app.locals',
      captures_total: captures.length,
      version: XLANG_EVAL_VERSION,
    };
  }
  if (!judge) {
    return {
      ok: false,
      error: 'no_judge_configured',
      hint: 'pass opts.judge:({input,expected,actual,lang})=>{score} — judge is the score-source ' +
            'and we never fabricate it',
      captures_total: captures.length,
      version: XLANG_EVAL_VERSION,
    };
  }

  // Run the artifact + judge over every capture, partitioned by detected
  // language of the input. We do NOT short-circuit on judge failures —
  // they are counted (per language) so the operator sees them.
  const byLang = new Map(); // lang -> [score, score, ...]
  const judgeFailuresByLang = new Map();
  let pooledScores = [];
  for (const cap of captures) {
    if (!cap || typeof cap !== 'object') continue;
    const input = cap.prompt_redacted || cap.prompt || cap.input || '';
    const expected = cap.response_redacted || cap.response || cap.output || '';
    if (typeof input !== 'string' || input.length === 0) continue;
    const d = lang_detect(input) || {};
    const lang = d.lang;
    if (!lang || d.fallback) continue;

    let ran;
    try {
      ran = await runOnArtifact(artifact_path, cap);
    } catch (_) { continue; }
    if (!ran || typeof ran !== 'object') continue;

    let judged;
    try {
      judged = await judge({
        input,
        expected,
        actual: ran.output,
        lang,
      });
    } catch (_) {
      if (!judgeFailuresByLang.has(lang)) judgeFailuresByLang.set(lang, 0);
      judgeFailuresByLang.set(lang, judgeFailuresByLang.get(lang) + 1);
      continue;
    }
    if (!judged || typeof judged !== 'object' || !Number.isFinite(judged.score)) {
      if (!judgeFailuresByLang.has(lang)) judgeFailuresByLang.set(lang, 0);
      judgeFailuresByLang.set(lang, judgeFailuresByLang.get(lang) + 1);
      continue;
    }
    const s = Math.max(0, Math.min(1, judged.score));
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang).push(s);
    pooledScores.push(s);
  }

  // Build the by_lang block. Languages with n<30 land in
  // languages_skipped_below_n30 — never reported with a CI.
  const byLangOut = {};
  const evaluated = [];
  const skipped = [];
  for (const [lang, scores] of byLang.entries()) {
    const n = scores.length;
    const mean = scores.reduce((s, v) => s + v, 0) / n;
    if (n < MIN_N_FOR_WILSON) {
      skipped.push({ lang, n });
      byLangOut[lang] = {
        n,
        score: null,
        ci95_low: null,
        ci95_high: null,
        judge_failures: judgeFailuresByLang.get(lang) || 0,
        floor_hit: true,
      };
      continue;
    }
    const ci = _wilson95(mean, n);
    byLangOut[lang] = {
      n,
      score: _round4(mean),
      ci95_low: _round4(ci.lo),
      ci95_high: _round4(ci.hi),
      judge_failures: judgeFailuresByLang.get(lang) || 0,
      floor_hit: false,
    };
    evaluated.push(lang);
  }

  const pooledN = pooledScores.length;
  const pooledScore = pooledN > 0
    ? _round4(pooledScores.reduce((s, v) => s + v, 0) / pooledN)
    : null;

  return {
    ok: true,
    version: XLANG_EVAL_VERSION,
    tenant_id,
    namespace,
    artifact_path,
    by_lang: byLangOut,
    gated_at_n: MIN_N_FOR_WILSON,
    pooled_score: pooledScore,
    pooled_n: pooledN,
    languages_evaluated: evaluated.sort(),
    languages_skipped_below_n30: skipped.sort((a, b) => a.lang < b.lang ? -1 : 1),
    captures_total: captures.length,
  };
}

// =============================================================================
// compareLanguageDelta
//
// Diff two evaluatePerLanguage() outputs. Returns a per-language delta
// plus a `significant` flag (true when the difference exceeds the
// width of either CI band — a conservative heuristic, NOT a t-test).
//
// Input:
//   eval_a:  evaluatePerLanguage() output (ok:true shape)
//   eval_b:  evaluatePerLanguage() output (ok:true shape)
//
// Output:
//   { ok:true, version, by_lang:{
//       en:{ score_a, score_b, delta, significant },
//       es:{ score_a:null|N, score_b:null|N, delta:null|N, significant:false },
//       ...
//     },
//     a_only:[<iso>...], b_only:[<iso>...], shared:[<iso>...],
//     pooled_delta }
//
// Languages absent from BOTH eval sets land in delta:null + significant:false
// — we never fabricate a comparison from missing data.
// =============================================================================

export function compareLanguageDelta(evalA, evalB) {
  const a = (evalA && evalA.by_lang && typeof evalA.by_lang === 'object') ? evalA.by_lang : {};
  const b = (evalB && evalB.by_lang && typeof evalB.by_lang === 'object') ? evalB.by_lang : {};

  const allLangs = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  const aOnly = [];
  const bOnly = [];
  const shared = [];
  const byLang = {};

  for (const lang of allLangs) {
    const ra = a[lang];
    const rb = b[lang];
    if (ra && !rb) { aOnly.push(lang); }
    else if (!ra && rb) { bOnly.push(lang); }
    else if (ra && rb) { shared.push(lang); }

    const sa = (ra && Number.isFinite(ra.score)) ? ra.score : null;
    const sb = (rb && Number.isFinite(rb.score)) ? rb.score : null;
    let delta = null;
    let significant = false;
    if (sa != null && sb != null) {
      delta = _round4(sb - sa);
      // Heuristic: significant when |delta| > the WIDER of the two CIs.
      // This is intentionally conservative — a real t-test is W741 work.
      const widthA = (Number.isFinite(ra.ci95_high) && Number.isFinite(ra.ci95_low))
        ? (ra.ci95_high - ra.ci95_low) : 0;
      const widthB = (Number.isFinite(rb.ci95_high) && Number.isFinite(rb.ci95_low))
        ? (rb.ci95_high - rb.ci95_low) : 0;
      const widerCI = Math.max(widthA, widthB);
      significant = (widerCI > 0) && (Math.abs(delta) > widerCI);
    }
    byLang[lang] = {
      score_a: sa,
      score_b: sb,
      delta,
      significant,
    };
  }

  const pooledA = (evalA && Number.isFinite(evalA.pooled_score)) ? evalA.pooled_score : null;
  const pooledB = (evalB && Number.isFinite(evalB.pooled_score)) ? evalB.pooled_score : null;
  const pooledDelta = (pooledA != null && pooledB != null) ? _round4(pooledB - pooledA) : null;

  return {
    ok: true,
    version: XLANG_EVAL_VERSION,
    by_lang: byLang,
    a_only: aOnly,
    b_only: bOnly,
    shared,
    pooled_delta: pooledDelta,
  };
}

// =============================================================================
// helpers
// =============================================================================

async function _resolveDetect(injected) {
  if (typeof injected === 'function') return injected;
  const { detectLang } = await import('./lang-detect.js');
  return (text) => detectLang(text);
}

// Wilson 95% CI on a 0..1 proportion. Caller enforces n>=30.
function _wilson95(p, n) {
  if (n < 1 || !Number.isFinite(p)) return { lo: 0, hi: 0 };
  const z = 1.96;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfwidth = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    lo: Math.max(0, center - halfwidth),
    hi: Math.min(1, center + halfwidth),
  };
}

function _round4(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

export default {
  XLANG_EVAL_VERSION,
  evaluatePerLanguage,
  compareLanguageDelta,
};
