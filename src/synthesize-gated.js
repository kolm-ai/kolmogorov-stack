// src/synthesize-gated.js
//
// Sensitive-data-aware GATED synthesis pipeline.
//
// This is the missing composition layer over two existing primitives:
//   - src/generator-router.js  route()  -> the never-to-hyperscaler decision
//     (clean->hosted-ok / sensitive->forced-local-or-fail-closed) + the local
//     translateFn adapter + provenance stamp + routing assertions.
//   - src/lingual-synthesize.js synthesizeForUnderrepresented() -> the actual
//     row generator (DI translateFn seam).
//
// generator-router.route() is decision-only: it never produces rows. This
// module folds the decision into a real synthesis run so the atom's acceptance
// criteria (generated_count, per-row stampRow over produced rows, local-
// generator-failure row-drop accounting, no-echo output guarantee) are
// satisfiable and provable end to end.
//
// LOAD-BEARING PRIVACY INVARIANT (kolm moat): a sensitive corpus is NEVER sent
// to a hosted teacher. The routing decision is computed BEFORE any teacher
// prompt; on sensitive + hosted-requested with no reachable local generator we
// FAIL CLOSED (loud, with an install hint) instead of falling back to hosted.
//
// Pure JS. No new deps. DI-friendly: every external effect (translateFn,
// event store) is injectable; tests pass programmable fakes and touch no
// network/key. ASCII only.

import {
  route as routeGenerator,
  stampRow,
  buildRoutingAssertions,
  routingCostField,
} from './generator-router.js';
import { synthesizeForUnderrepresented } from './lingual-synthesize.js';

export const SYNTHESIZE_GATED_VERSION = 'synth-gated-v1';

function _fail(error, extra = {}) {
  return {
    ok: false,
    error,
    version: SYNTHESIZE_GATED_VERSION,
    generated_count: 0,
    ...extra,
  };
}

/**
 * gatedSynthesize(args) -> envelope
 *
 * args:
 *   tenant        (required) canonical tenant id (W411 fence)
 *   namespace     capture namespace (default 'default')
 *   target_lang   (required) ISO 639-1 language to synthesize INTO
 *   count         desired synthetic-row count (>=1)
 *   teacher       requested teacher ('anthropic'|'openai'|'local'|slug) - this
 *                 only expresses the REQUESTED locality; the router decides the
 *                 EFFECTIVE locality and may force local.
 *   slug          optional model slug (alternative locality signal)
 *   seeds         the source corpus the sensitivity scan runs over. When
 *                 omitted, opts.source_captures is used as the scan pool too.
 *   opts:
 *     source_captures  explicit translation pool [{input,output,lang?}]
 *     translateFn      DI seam ({text,source_lang,target_lang,teacher})->{text,model}
 *                      When omitted on a forced/clean LOCAL path we inject the
 *                      router's real local adapter (decision.translateFn) so the
 *                      UNWRAPPED echo stub is NEVER reachable here.
 *     storeMod         {listEvents, appendEvent} DI seam (forwarded)
 *     write            persist generated rows (default false here - the route
 *                      caller decides; synthesis preview must not write)
 *     maxScan, allowSampledClean, localRedactMode, localTransport, model,
 *     fetch, ciStub    forwarded to route()/the local adapter
 *
 * Returns ok:true ->
 *   { ok, version, tenant, namespace, target_lang,
 *     decision, routing_assertions, routing_cost,
 *     requested_count, generated_count, dropped_count, rows:[...stamped...],
 *     synth_provider, synth_model }
 *
 * Returns ok:false (loud, fail-closed) ->
 *   { ok:false, error, ... } including the router fail-closed envelope passthrough
 *   for 'sensitive_corpus_requires_local_generator' (carries install_hint).
 */
export async function gatedSynthesize(args = {}) {
  const a = (args && typeof args === 'object') ? args : {};
  const opts = (a.opts && typeof a.opts === 'object') ? a.opts : {};
  const tenant = a.tenant;
  const namespace = (typeof a.namespace === 'string' && a.namespace.length > 0)
    ? a.namespace.slice(0, 128) : 'default';
  const target_lang = a.target_lang;
  const teacher = a.teacher;
  const slug = a.slug;

  if (!tenant || typeof tenant !== 'string') {
    return _fail('tenant_required', {
      hint: 'pass {tenant:"<canonical tenant id>"} - W411 tenant-fence is mandatory',
    });
  }
  if (!target_lang || typeof target_lang !== 'string') {
    return _fail('target_lang_required', {
      hint: 'pass {target_lang:"es"} - the language to synthesize INTO',
    });
  }

  // The sensitivity scan runs over the seed corpus. Prefer an explicit `seeds`
  // pool; otherwise the same captures we are about to translate (the scan must
  // cover whatever text the prompt would carry).
  const scanPool = Array.isArray(a.seeds) && a.seeds.length > 0
    ? a.seeds
    : (Array.isArray(opts.source_captures) ? opts.source_captures : []);

  // 1) ROUTING DECISION (before any teacher prompt). Never throws.
  const decision = routeGenerator({
    seeds: scanPool,
    teacher,
    slug,
    opts: {
      maxScan: opts.maxScan,
      allowSampledClean: opts.allowSampledClean,
      localRedactMode: opts.localRedactMode,
      localTransport: opts.localTransport,
      model: opts.model,
      fetch: opts.fetch,
      ciStub: opts.ciStub,
    },
  });

  if (!decision.ok) {
    // Fail closed. Passthrough the router envelope (carries install_hint,
    // sensitivity_verdict, requested_locality) so the boundary is provable and
    // the operator sees exactly what to set. NEVER fall back to hosted.
    return {
      ...decision,
      gated: true,
      generated_count: 0,
      version: SYNTHESIZE_GATED_VERSION,
      router_version: decision.version,
    };
  }

  const eff = decision.decision || {};

  // 2) Choose the translateFn. On a LOCAL effective locality we use the
  //    router's REAL local adapter (decision.translateFn) UNLESS the caller
  //    injected its own DI translateFn (tests). This guarantees the unwrapped
  //    echo stub in lingual-synthesize.js is never reached for local synthesis:
  //    the adapter throws a typed LocalGeneratorError on misconfig (row drop),
  //    it does not echo. On a HOSTED effective locality the corpus is proven
  //    clean and the existing hosted teacher path handles it.
  let translateFn = (typeof opts.translateFn === 'function') ? opts.translateFn : null;
  if (!translateFn && eff.effectiveLocality === 'local' && typeof decision.translateFn === 'function') {
    translateFn = decision.translateFn;
  }

  // 3) Run the real generator behind the decision.
  const synthArgs = {
    tenant,
    namespace,
    target_lang,
    teacher: eff.effectiveLocality === 'local' ? 'local' : teacher,
    count: a.count,
    opts: {
      source_captures: opts.source_captures,
      storeMod: opts.storeMod,
      write: opts.write === true,
    },
  };
  if (translateFn) synthArgs.opts.translateFn = translateFn;

  let synth;
  try {
    synth = await synthesizeForUnderrepresented(synthArgs);
  } catch (e) {
    // synthesizeForUnderrepresented is defensive, but a translateFn that throws
    // hard (e.g. an unconfigured local adapter) must surface as a loud,
    // non-hosted failure - never an echo, never a hosted retry.
    return _fail('local_synthesis_failed', {
      detail: String((e && e.message) || e),
      decision: eff,
      routing_assertions: buildRoutingAssertions(eff),
      install_hint: (e && e.code === 'local_teacher_unconfigured')
        ? 'Set KOLM_LOCAL_TEACHER_URL=http://127.0.0.1:11434 (Ollama) or a vLLM/llama.cpp endpoint'
        : undefined,
    });
  }

  if (!synth || synth.ok !== true) {
    // Forward the generator's loud envelope, augmented with the routing
    // decision so the caller still sees the (clean/forced-local) verdict.
    return {
      ...(synth || {}),
      ok: false,
      gated: true,
      decision: eff,
      routing_assertions: buildRoutingAssertions(eff),
      version: SYNTHESIZE_GATED_VERSION,
    };
  }

  // 4) Stamp EVERY produced row with the generator-routing provenance block.
  const producedRows = Array.isArray(synth.rows) ? synth.rows : [];
  const stamped = producedRows.map((row) => stampRow(row, eff));

  const requested_count = Number.isFinite(Number(a.count)) && Number(a.count) > 0
    ? Math.trunc(Number(a.count)) : 0;
  const generated_count = stamped.length;
  // Row-drop accounting: the local adapter throws per-row on translate failure,
  // which the synth loop tolerates as a dropped row. dropped = generated short.
  const dropped_count = Math.max(0,
    (Number.isFinite(synth.requested_count) ? synth.requested_count : requested_count) - generated_count);

  return {
    ok: true,
    version: SYNTHESIZE_GATED_VERSION,
    gated: true,
    tenant,
    namespace,
    target_lang,
    teacher,
    decision: eff,
    routing_assertions: buildRoutingAssertions(eff),
    routing_cost: routingCostField(eff, typeof opts.hosted_estimate_usd === 'number' ? opts.hosted_estimate_usd : 0),
    requested_count: requested_count || (synth.requested_count || 0),
    generated_count,
    dropped_count,
    rows: stamped,
    synth_provider: synth.synth_provider || null,
    synth_model: synth.synth_model || null,
  };
}

export default {
  SYNTHESIZE_GATED_VERSION,
  gatedSynthesize,
};
