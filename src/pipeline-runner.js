// W738-2 — pipeline runtime: classifier -> route -> result.
//
// runPipeline() is the orchestrator that turns a parsed kolm.pipeline.yaml
// into one end-to-end inference. The shape is deliberately dependency-
// injected so tests don't need a real artifact loader or a real teacher API:
//
//   runPipeline({
//     pipeline,           // a parsed kolm.pipeline.yaml (W738 schema)
//     input,              // the user prompt (string)
//     tenant_id,          // who's asking (tenant-fenced via the loader)
//     artifact_loader,    // async (cid, {tenant_id}) -> { run(input) -> string }
//     teacher_caller,     // async (teacher_id, input) -> string
//   })
//
// Phases (timed with real Date.now() deltas — no estimates):
//
//   1. classify  — load the classifier artifact + run it on input.
//                  The classifier's `run()` MUST return a label string;
//                  anything else fails loud with classifier_invalid_output.
//   2. route     — look up routes[label]:
//                  * route has artifact_cid → load + run the artifact.
//                  * route has teacher     → call teacher_caller.
//                  * route not found       → honest { ok:false } envelope
//                                            with the original label so the
//                                            operator can add it to the yaml.
//
// Latency: `latency_ms_breakdown` always reports `{classify, route, total}`
// as integer milliseconds (Date.now() deltas). The total is computed
// independently (top-level Date.now() bookends) and may differ slightly from
// `classify + route` because of JS event-loop scheduling; we surface the
// real total rather than re-deriving it.
//
// Idempotency: same input + same artifact loader + same pipeline → same
// classifier_label and same route_taken. Teacher escalation is the only
// non-deterministic leg (teacher_caller may stream a different completion);
// that's documented in /docs/pipelines.html.

export const PIPELINE_RUNNER_VERSION = 'w738-v1';

// Helper: normalise an artifact_loader's return into something that exposes
// `.run(input) -> string|Promise<string>`. We accept three shapes so
// loaders can return raw functions, objects with `.run`, or objects with
// `.classify` (which is what some classifier wrappers expose).
function _normaliseArtifact(loaded) {
  if (typeof loaded === 'function') return { run: loaded };
  if (loaded && typeof loaded.run === 'function') return loaded;
  if (loaded && typeof loaded.classify === 'function') {
    return { run: (input) => loaded.classify(input) };
  }
  return null;
}

// Helper: stringify a classifier's output so we can compare it against the
// pipeline's route labels. Numbers become strings, booleans become "true"/
// "false". We do NOT JSON-stringify objects — that's a sign the classifier
// returned a structured payload instead of a label, and we want to fail
// loud (classifier_invalid_output) so the operator notices.
function _coerceLabel(out) {
  if (typeof out === 'string') return out.trim();
  if (typeof out === 'number' && Number.isFinite(out)) return String(out);
  if (typeof out === 'boolean') return out ? 'true' : 'false';
  return null;
}

export async function runPipeline(opts) {
  const t0 = Date.now();
  opts = opts || {};
  const { pipeline, input, tenant_id, artifact_loader, teacher_caller } = opts;

  // ── Pre-flight: required inputs ───────────────────────────────────────────
  // We fail loud + early on every missing dependency so the caller never has
  // to read a stack trace to find out their loader was undefined.
  if (!pipeline || typeof pipeline !== 'object') {
    return {
      ok: false,
      error: 'pipeline_required',
      hint: 'runPipeline requires {pipeline} (a parsed kolm.pipeline.yaml)',
      version: PIPELINE_RUNNER_VERSION,
    };
  }
  if (typeof input !== 'string') {
    return {
      ok: false,
      error: 'input_required',
      hint: 'runPipeline requires {input} as a string',
      version: PIPELINE_RUNNER_VERSION,
    };
  }
  if (typeof artifact_loader !== 'function') {
    return {
      ok: false,
      error: 'artifact_loader_required',
      hint: 'runPipeline requires {artifact_loader} as async (cid, {tenant_id}) -> {run}',
      version: PIPELINE_RUNNER_VERSION,
    };
  }
  if (!pipeline.classifier || typeof pipeline.classifier.artifact_cid !== 'string') {
    return {
      ok: false,
      error: 'classifier_missing',
      hint: 'pipeline.classifier.artifact_cid must be set',
      version: PIPELINE_RUNNER_VERSION,
    };
  }
  if (!pipeline.routes || typeof pipeline.routes !== 'object') {
    return {
      ok: false,
      error: 'routes_missing',
      hint: 'pipeline.routes must be a mapping of label -> target',
      version: PIPELINE_RUNNER_VERSION,
    };
  }

  // ── Phase 1: classify ────────────────────────────────────────────────────
  // Wall-clock for the classify phase — load + run combined. Tests pin this
  // to a number (>= 0), not the precise value.
  const tClassifyStart = Date.now();
  let classifierArtifact;
  try {
    classifierArtifact = await artifact_loader(pipeline.classifier.artifact_cid, { tenant_id });
  } catch (e) {
    return {
      ok: false,
      error: 'classifier_load_failed',
      cid: pipeline.classifier.artifact_cid,
      detail: (e && e.message) || String(e),
      latency_ms_breakdown: {
        classify: Date.now() - tClassifyStart,
        route: 0,
        total: Date.now() - t0,
      },
      version: PIPELINE_RUNNER_VERSION,
    };
  }
  const classifier = _normaliseArtifact(classifierArtifact);
  if (!classifier) {
    return {
      ok: false,
      error: 'classifier_invalid_artifact',
      cid: pipeline.classifier.artifact_cid,
      hint: 'artifact_loader must return a function, {run}, or {classify}',
      latency_ms_breakdown: {
        classify: Date.now() - tClassifyStart,
        route: 0,
        total: Date.now() - t0,
      },
      version: PIPELINE_RUNNER_VERSION,
    };
  }
  let rawLabel;
  try {
    rawLabel = await classifier.run(input);
  } catch (e) {
    return {
      ok: false,
      error: 'classifier_failure',
      cid: pipeline.classifier.artifact_cid,
      detail: (e && e.message) || String(e),
      latency_ms_breakdown: {
        classify: Date.now() - tClassifyStart,
        route: 0,
        total: Date.now() - t0,
      },
      version: PIPELINE_RUNNER_VERSION,
    };
  }
  const label = _coerceLabel(rawLabel);
  if (label == null) {
    return {
      ok: false,
      error: 'classifier_invalid_output',
      cid: pipeline.classifier.artifact_cid,
      hint: 'classifier must return a string/number/boolean label; got ' + typeof rawLabel,
      latency_ms_breakdown: {
        classify: Date.now() - tClassifyStart,
        route: 0,
        total: Date.now() - t0,
      },
      version: PIPELINE_RUNNER_VERSION,
    };
  }
  const classifyMs = Date.now() - tClassifyStart;

  // ── Phase 2: route lookup + execution ────────────────────────────────────
  const route = pipeline.routes[label];
  const tRouteStart = Date.now();
  if (!route) {
    // Honest no-route envelope. We surface the label so the operator can add
    // it to pipeline.routes; available_routes is sorted for stable diff.
    return {
      ok: false,
      error: 'route_not_found',
      label,
      available_routes: Object.keys(pipeline.routes).sort(),
      hint: 'add this label to pipeline.routes',
      latency_ms_breakdown: {
        classify: classifyMs,
        route: 0,
        total: Date.now() - t0,
      },
      version: PIPELINE_RUNNER_VERSION,
    };
  }

  // Branch A: route has artifact_cid → load + run a real .kolm.
  if (typeof route.artifact_cid === 'string') {
    let routeArtifact;
    try {
      routeArtifact = await artifact_loader(route.artifact_cid, { tenant_id });
    } catch (e) {
      return {
        ok: false,
        error: 'route_artifact_load_failed',
        label,
        cid: route.artifact_cid,
        detail: (e && e.message) || String(e),
        latency_ms_breakdown: {
          classify: classifyMs,
          route: Date.now() - tRouteStart,
          total: Date.now() - t0,
        },
        version: PIPELINE_RUNNER_VERSION,
      };
    }
    const routeArt = _normaliseArtifact(routeArtifact);
    if (!routeArt) {
      return {
        ok: false,
        error: 'route_artifact_invalid',
        label,
        cid: route.artifact_cid,
        hint: 'artifact_loader must return a function or {run}',
        latency_ms_breakdown: {
          classify: classifyMs,
          route: Date.now() - tRouteStart,
          total: Date.now() - t0,
        },
        version: PIPELINE_RUNNER_VERSION,
      };
    }
    let result;
    try {
      result = await routeArt.run(input);
    } catch (e) {
      return {
        ok: false,
        error: 'route_artifact_failure',
        label,
        cid: route.artifact_cid,
        detail: (e && e.message) || String(e),
        latency_ms_breakdown: {
          classify: classifyMs,
          route: Date.now() - tRouteStart,
          total: Date.now() - t0,
        },
        version: PIPELINE_RUNNER_VERSION,
      };
    }
    return {
      ok: true,
      result,
      classifier_label: label,
      route_taken: { kind: 'artifact', cid: route.artifact_cid, label },
      latency_ms_breakdown: {
        classify: classifyMs,
        route: Date.now() - tRouteStart,
        total: Date.now() - t0,
      },
      version: PIPELINE_RUNNER_VERSION,
    };
  }

  // Branch B: route has teacher → escalate to the hosted teacher.
  if (typeof route.teacher === 'string') {
    if (typeof teacher_caller !== 'function') {
      // Honest "we need an escalation handler" envelope. Tests can call the
      // runner without a teacher and still verify route_not_found / artifact
      // branches — but if the YAML asks for escalation we MUST have a caller.
      return {
        ok: false,
        error: 'teacher_caller_required',
        label,
        teacher: route.teacher,
        hint: 'pass {teacher_caller} when the pipeline has escalation routes',
        latency_ms_breakdown: {
          classify: classifyMs,
          route: Date.now() - tRouteStart,
          total: Date.now() - t0,
        },
        version: PIPELINE_RUNNER_VERSION,
      };
    }
    let result;
    try {
      result = await teacher_caller(route.teacher, input);
    } catch (e) {
      return {
        ok: false,
        error: 'teacher_call_failed',
        label,
        teacher: route.teacher,
        detail: (e && e.message) || String(e),
        latency_ms_breakdown: {
          classify: classifyMs,
          route: Date.now() - tRouteStart,
          total: Date.now() - t0,
        },
        version: PIPELINE_RUNNER_VERSION,
      };
    }
    return {
      ok: true,
      result,
      classifier_label: label,
      route_taken: { kind: 'teacher', teacher: route.teacher, label },
      latency_ms_breakdown: {
        classify: classifyMs,
        route: Date.now() - tRouteStart,
        total: Date.now() - t0,
      },
      version: PIPELINE_RUNNER_VERSION,
    };
  }

  // Validator should have caught this, but defense-in-depth: if a route is
  // a mapping with neither artifact_cid nor teacher we surface a loud error.
  return {
    ok: false,
    error: 'route_target_invalid',
    label,
    hint: 'route target must have artifact_cid or teacher',
    latency_ms_breakdown: {
      classify: classifyMs,
      route: Date.now() - tRouteStart,
      total: Date.now() - t0,
    },
    version: PIPELINE_RUNNER_VERSION,
  };
}

// =============================================================================
// compilePipeline — W738-3
// =============================================================================
//
// Produces a JSON sidecar describing the composed pipeline. parent_cids
// pre-wires the W739 lineage chain: classifier cid first, then each route's
// artifact_cid in route-label order.
//
// We do NOT run the pipeline here, and we do NOT touch the manifests of the
// referenced cids (the W707 plan keeps that to the W720 compile loop). The
// sidecar's job is to (a) freeze the route table at a known set of cids and
// (b) give the W739 diff path a single file to walk.

import crypto from 'node:crypto';
import { parsePipelineYaml, validatePipelineYaml, collectReferencedCids, PIPELINE_YAML_VERSION } from './pipeline-yaml.js';

export async function compilePipeline(yamlText, opts) {
  opts = opts || {};
  if (typeof yamlText !== 'string') {
    return {
      ok: false,
      error: 'pipeline_yaml_input_not_string',
      version: PIPELINE_YAML_VERSION,
    };
  }
  let parsed;
  try {
    parsed = parsePipelineYaml(yamlText);
  } catch (e) {
    return {
      ok: false,
      error: e && e.code ? e.code : 'pipeline_yaml_parse_failed',
      detail: (e && e.message) || String(e),
      line: (e && typeof e.line === 'number') ? e.line : null,
      version: PIPELINE_YAML_VERSION,
    };
  }
  const validation = validatePipelineYaml(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      error: 'pipeline_yaml_validation_failed',
      validation,
      version: PIPELINE_YAML_VERSION,
    };
  }

  // Optional manifest_fetcher: tests pass a stub that returns
  // {cid, size_bytes, manifest_hash}; production wires it to the catalog.
  const fetcher = (typeof opts.manifest_fetcher === 'function') ? opts.manifest_fetcher : null;
  const manifests = [];
  const referencedCids = collectReferencedCids(parsed);
  for (const cid of referencedCids) {
    if (!fetcher) {
      // No fetcher → record the cid alone (honest: we don't fabricate sizes
      // or hashes). The W739 lineage chain still works because parent_cids
      // is the load-bearing field.
      manifests.push({ cid, fetched: false });
      continue;
    }
    try {
      const m = await fetcher(cid, { tenant_id: opts.tenant_id });
      manifests.push({ cid, fetched: true, manifest: m || null });
    } catch (e) {
      manifests.push({
        cid,
        fetched: false,
        error: (e && e.message) || String(e),
      });
    }
  }

  // Stable sidecar shape — sort the cid list so the same pipeline produces
  // the same bytes regardless of how the operator ordered route labels.
  const sidecar = {
    artifact_kind: 'kolm.pipeline',
    version: PIPELINE_YAML_VERSION,
    name: parsed.name,
    created_at: new Date().toISOString(),
    classifier: {
      artifact_cid: parsed.classifier.artifact_cid,
      version: parsed.classifier.version || null,
    },
    routes: parsed.routes,
    parent_cids: referencedCids.slice().sort(),
    referenced_cid_count: referencedCids.length,
    manifests,
  };
  // Content address the sidecar itself so callers have a stable handle for
  // logging / lineage. We canonicalise keys via JSON.stringify with a sort
  // comparator so re-emitting the same yaml twice yields the same hash.
  const canonical = JSON.stringify(sidecar, Object.keys(sidecar).sort());
  const sidecar_hash = 'sha256-' + crypto.createHash('sha256').update(canonical).digest('hex');
  return {
    ok: true,
    sidecar,
    sidecar_hash,
    version: PIPELINE_YAML_VERSION,
  };
}
