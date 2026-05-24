// W774 — Multi-language artifact bake-off.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 643-648):
//   [W774-4] Bakeoff multi-lang pairs
//
// Why: src/bakeoff.js compares HOSTED MODELS across a dataset (text-only,
// pooled scoring). src/multimodal-bakeoff.js (W466) compares ARTIFACTS
// across CAPTURES by media_kind. W774 runXlangBakeoff() compares TWO
// COMPILED ARTIFACTS head-to-head on captures partitioned BY DETECTED
// LANGUAGE — the missing axis for cross-lingual distillation.
//
// Use case: you distill an English teacher into two student variants —
// one with language-balanced sampling (W774-1), one without. runXlang-
// Bakeoff() tells you which variant wins on Spanish, which on Chinese,
// and emits a "multilingual_consistency_score" reflecting how uniform
// the winner is across languages.
//
// Design contract:
//   - DI seams (runOnArtifact, judge, lang_detect, storeMod) mirror
//     src/cross-lingual-eval.js so a single test fixture exercises both.
//   - W411 defense-in-depth tenant fence — read tenant_id from arg AND
//     re-filter every listEvents row by tenant_id.
//   - HONESTY FLOOR: no captures, or no MULTILINGUAL captures (only one
//     language detected), or missing DI seams all surface as honest
//     envelopes — never silent-pass to a bogus winner.
//
// Public surface:
//   - XLANG_BAKEOFF_VERSION
//   - runXlangBakeoff({tenant_id, namespace, artifact_a, artifact_b, opts})

export const XLANG_BAKEOFF_VERSION = 'w774-v1';

// Minimum distinct languages in the capture pool to call this a
// MULTILINGUAL bakeoff. With <2 languages the comparison degenerates
// to a pooled bakeoff (use src/bakeoff.js instead).
const MIN_DISTINCT_LANGS = 2;

// =============================================================================
// runXlangBakeoff
//
// Head-to-head compare two artifacts on multilingual captures.
//
// Input:
//   args.tenant_id:           canonical tenant id (W411 mandatory)
//   args.namespace:           capture namespace
//   args.artifact_a:          path to first compiled .kolm artifact
//   args.artifact_b:          path to second compiled .kolm artifact
//   args.opts.runOnArtifact:  async (artifact, capture) => {output, ...}
//   args.opts.judge:          async ({input, expected, actual, lang}) =>
//                                {score:0..1}
//   args.opts.lang_detect:    sync (text) => {lang, fallback}
//   args.opts.storeMod:       {listEvents} DI for event store
//
// Output (ok:true shape):
//   { ok:true, version, tenant_id, namespace,
//     artifact_a, artifact_b,
//     by_lang:{
//       en:{ wins_a, wins_b, ties, n, score_a, score_b, winner },
//       es:{ wins_a, wins_b, ties, n, score_a, score_b, winner },
//       ...
//     },
//     overall_winner:'artifact_a'|'artifact_b'|'tie',
//     multilingual_consistency_score:0..1, // fraction of langs where
//                                          // overall winner also wins
//     languages_compared:[<iso>...],
//   }
//
// Honest envelopes:
//   - tenant_id_required
//   - artifact_paths_required
//   - no_runner_or_judge_configured
//   - no_multilingual_captures   (<2 distinct detected languages)
// =============================================================================

export async function runXlangBakeoff(args) {
  const a = args || {};
  const tenant_id = a.tenant_id;
  const namespace = (typeof a.namespace === 'string' && a.namespace.length > 0)
    ? a.namespace.slice(0, 128)
    : 'default';
  const artifact_a = a.artifact_a;
  const artifact_b = a.artifact_b;
  const opts = a.opts || {};

  // W411 defense-in-depth — tenant_id mandatory.
  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'pass {tenant_id:"<canonical tenant id>"} — W411 tenant-fence is mandatory',
      version: XLANG_BAKEOFF_VERSION,
    };
  }
  if (!artifact_a || typeof artifact_a !== 'string' ||
      !artifact_b || typeof artifact_b !== 'string') {
    return {
      ok: false,
      error: 'artifact_paths_required',
      hint: 'pass {artifact_a:"path/a.kolm", artifact_b:"path/b.kolm"}',
      version: XLANG_BAKEOFF_VERSION,
    };
  }

  const lang_detect = await _resolveDetect(opts.lang_detect);
  const runOnArtifact = (typeof opts.runOnArtifact === 'function') ? opts.runOnArtifact : null;
  const judge = (typeof opts.judge === 'function') ? opts.judge : null;
  const storeMod = opts.storeMod || (await import('./event-store.js'));

  if (!runOnArtifact || !judge) {
    return {
      ok: false,
      error: 'no_runner_or_judge_configured',
      hint: 'pass opts.runOnArtifact + opts.judge — hosted route has no runner ' +
            'DI by default; production wires both via req.app.locals',
      version: XLANG_BAKEOFF_VERSION,
    };
  }

  let captures = [];
  try {
    captures = await storeMod.listEvents({
      tenant_id,
      namespace,
      limit: 5000,
      order: 'desc',
    });
  } catch (_) { captures = []; }
  // W411 defense-in-depth — re-filter.
  captures = (captures || []).filter((rr) => rr && rr.tenant_id === tenant_id);

  if (captures.length === 0) {
    return {
      ok: false,
      error: 'no_captures',
      hint: 'this namespace has no captures under the tenant fence',
      version: XLANG_BAKEOFF_VERSION,
    };
  }

  // Partition captures by detected language of the input.
  const byLangCaps = new Map();
  for (const cap of captures) {
    if (!cap || typeof cap !== 'object') continue;
    const text = cap.prompt_redacted || cap.prompt || cap.input || '';
    if (typeof text !== 'string' || text.length === 0) continue;
    const d = lang_detect(text) || {};
    const lang = d.lang;
    if (!lang || d.fallback) continue;
    if (!byLangCaps.has(lang)) byLangCaps.set(lang, []);
    byLangCaps.get(lang).push(cap);
  }

  // HONESTY: require at least 2 distinct detected languages — otherwise
  // this isn't a multilingual bakeoff.
  if (byLangCaps.size < MIN_DISTINCT_LANGS) {
    return {
      ok: false,
      error: 'no_multilingual_captures',
      hint: 'need >=' + MIN_DISTINCT_LANGS + ' distinct detected languages in this namespace; ' +
            'use src/bakeoff.js for single-language bakeoffs',
      detected_langs: Array.from(byLangCaps.keys()),
      version: XLANG_BAKEOFF_VERSION,
    };
  }

  // Per-language head-to-head. For every capture we run both artifacts +
  // judge both outputs; the higher score wins (ties on equal scores).
  const byLangOut = {};
  let totalWinsA = 0;
  let totalWinsB = 0;
  let totalTies = 0;
  let totalRows = 0;
  for (const [lang, caps] of byLangCaps.entries()) {
    let winsA = 0;
    let winsB = 0;
    let ties = 0;
    const scoresA = [];
    const scoresB = [];
    for (const cap of caps) {
      const input = cap.prompt_redacted || cap.prompt || cap.input || '';
      const expected = cap.response_redacted || cap.response || cap.output || '';
      let ranA, ranB;
      try { ranA = await runOnArtifact(artifact_a, cap); } catch (_) { continue; }
      try { ranB = await runOnArtifact(artifact_b, cap); } catch (_) { continue; }
      if (!ranA || !ranB) continue;
      let jA, jB;
      try {
        jA = await judge({ input, expected, actual: ranA.output, lang });
        jB = await judge({ input, expected, actual: ranB.output, lang });
      } catch (_) { continue; }
      if (!jA || !jB || !Number.isFinite(jA.score) || !Number.isFinite(jB.score)) continue;
      scoresA.push(jA.score);
      scoresB.push(jB.score);
      if (jA.score > jB.score) winsA += 1;
      else if (jB.score > jA.score) winsB += 1;
      else ties += 1;
    }
    const n = scoresA.length;
    const meanA = n > 0 ? scoresA.reduce((s, v) => s + v, 0) / n : null;
    const meanB = n > 0 ? scoresB.reduce((s, v) => s + v, 0) / n : null;
    let winner = 'tie';
    if (winsA > winsB) winner = 'artifact_a';
    else if (winsB > winsA) winner = 'artifact_b';
    byLangOut[lang] = {
      wins_a: winsA,
      wins_b: winsB,
      ties,
      n,
      score_a: meanA == null ? null : _round4(meanA),
      score_b: meanB == null ? null : _round4(meanB),
      winner,
    };
    totalWinsA += winsA;
    totalWinsB += winsB;
    totalTies += ties;
    totalRows += n;
  }

  let overallWinner = 'tie';
  if (totalWinsA > totalWinsB) overallWinner = 'artifact_a';
  else if (totalWinsB > totalWinsA) overallWinner = 'artifact_b';

  // Multilingual consistency score: fraction of languages where the
  // overall winner is ALSO the per-language winner. 1.0 means the winner
  // is uniformly better; 0.0 means the wins are completely scattered.
  let consistentLangs = 0;
  const compared = Object.keys(byLangOut);
  for (const lang of compared) {
    if (byLangOut[lang].winner === overallWinner) consistentLangs += 1;
  }
  const consistency = compared.length > 0
    ? Math.round((consistentLangs / compared.length) * 10000) / 10000
    : 0;

  return {
    ok: true,
    version: XLANG_BAKEOFF_VERSION,
    tenant_id,
    namespace,
    artifact_a,
    artifact_b,
    by_lang: byLangOut,
    overall_winner: overallWinner,
    overall_wins_a: totalWinsA,
    overall_wins_b: totalWinsB,
    overall_ties: totalTies,
    overall_rows: totalRows,
    multilingual_consistency_score: consistency,
    languages_compared: compared.sort(),
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

function _round4(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

export default {
  XLANG_BAKEOFF_VERSION,
  runXlangBakeoff,
};
