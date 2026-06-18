// W738-2 - pipeline runtime: classifier -> route -> result.
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
// Phases (timed with real Date.now() deltas - no estimates):
//
//   1. classify - load the classifier artifact + run it on input.
//                  The classifier's `run()` MUST return a label string;
//                  anything else fails loud with classifier_invalid_output.
//   2. route - look up routes[label]:
//                  * route has artifact_cid -> load + run the artifact.
//                  * route has teacher     -> call teacher_caller.
//                  * route not found       -> honest { ok:false } envelope
//                                            with the original label so the
//                                            operator can add it to the yaml.
//
// Latency: `latency_ms_breakdown` always reports `{classify, route, total}`
// as integer milliseconds (Date.now() deltas). The total is computed
// independently (top-level Date.now() bookends) and may differ slightly from
// `classify + route` because of JS event-loop scheduling; we surface the
// real total rather than re-deriving it.
//
// Idempotency: same input + same artifact loader + same pipeline -> same
// classifier_label and same route_taken. Teacher escalation is the only
// non-deterministic leg (teacher_caller may stream a different completion);
// that's documented in /docs/pipelines.html.

import crypto from 'node:crypto';
import { parsePipelineYaml, validatePipelineYaml, collectReferencedCids, PIPELINE_YAML_VERSION } from './pipeline-yaml.js';

export const PIPELINE_RUNNER_VERSION = 'w738-v2';

export const PIPELINE_RUNNER_LIMITS = Object.freeze({
  MAX_INPUT_CHARS: 32_000,
  MAX_LABEL_CHARS: 128,
  MAX_ROUTES: 128,
  MAX_CID_CHARS: 256,
  MAX_TEACHER_ID_CHARS: 160,
  MAX_ERROR_DETAIL_CHARS: 240,
});

function _sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function _stableJson(value) {
  const sortRecursive = (v) => {
    if (Array.isArray(v)) return v.map(sortRecursive);
    if (v && typeof v === 'object') {
      const out = {};
      for (const key of Object.keys(v).sort()) out[key] = sortRecursive(v[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortRecursive(value));
}

function _cleanText(value, maxChars) {
  const s = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

function _safeErrorDetail(err) {
  const message = _cleanText((err && err.message) || err || 'error', PIPELINE_RUNNER_LIMITS.MAX_ERROR_DETAIL_CHARS);
  return message
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted_ssn]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted_email]')
    .replace(/\b(?:sk|ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{16,}\b/g, '[redacted_secret]');
}

function _validateRuntimeId(value, field, maxChars) {
  if (typeof value !== 'string') return { ok: false, error: `${field}_must_be_string` };
  const clean = _cleanText(value, maxChars);
  if (!clean) return { ok: false, error: `${field}_required` };
  if (clean.length !== value.trim().length) return { ok: false, error: `${field}_too_long` };
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: `${field}_control_chars` };
  if (/[\\/]|(?:^|[.])\.\.(?:[.]|$)/.test(clean)) return { ok: false, error: `${field}_must_not_be_path` };
  return { ok: true, value: clean };
}

function _validateLabel(value) {
  const clean = _cleanText(value, PIPELINE_RUNNER_LIMITS.MAX_LABEL_CHARS);
  if (!clean) return { ok: false, error: 'classifier_label_empty' };
  if (clean.length !== String(value).trim().length) return { ok: false, error: 'classifier_label_too_long' };
  if (/[\u0000-\u001f\u007f]/.test(String(value))) return { ok: false, error: 'classifier_label_control_chars' };
  return { ok: true, value: clean };
}

function _runtimePipelineSpec(pipeline) {
  if (!pipeline || typeof pipeline !== 'object') return null;
  return {
    version: pipeline.version || null,
    name: pipeline.name || null,
    classifier: pipeline.classifier || null,
    routes: pipeline.routes || null,
  };
}

function _pipelineSpecSha256(pipeline) {
  const spec = _runtimePipelineSpec(pipeline);
  return spec ? _sha256Hex(_stableJson(spec)) : null;
}

function _validateRuntimeRoutes(routes) {
  const labels = Object.keys(routes || {});
  if (labels.length > PIPELINE_RUNNER_LIMITS.MAX_ROUTES) {
    return { ok: false, error: 'routes_too_many' };
  }
  const normalized = Object.create(null);
  for (const rawLabel of labels) {
    const label = _validateLabel(rawLabel);
    if (!label.ok) return { ok: false, error: label.error, label: rawLabel };
    const target = routes[rawLabel];
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      return { ok: false, error: 'route_target_invalid', label: label.value };
    }
    const hasCid = typeof target.artifact_cid === 'string';
    const hasTeacher = typeof target.teacher === 'string';
    if (hasCid === hasTeacher) return { ok: false, error: 'route_target_ambiguous', label: label.value };
    if (hasCid) {
      const cid = _validateRuntimeId(target.artifact_cid, 'artifact_cid', PIPELINE_RUNNER_LIMITS.MAX_CID_CHARS);
      if (!cid.ok) return { ok: false, error: cid.error, label: label.value };
      normalized[label.value] = { artifact_cid: cid.value };
    } else {
      const teacher = _validateRuntimeId(target.teacher, 'teacher', PIPELINE_RUNNER_LIMITS.MAX_TEACHER_ID_CHARS);
      if (!teacher.ok) return { ok: false, error: teacher.error, label: label.value };
      normalized[label.value] = { teacher: teacher.value };
    }
  }
  return { ok: true, routes: normalized };
}

function _buildRunReceipt({ pipeline, input, tenant_id, classifier_label, route_taken, status, error, latency_ms_breakdown, result }) {
  const resultString = result == null ? null : String(result);
  const body = {
    version: PIPELINE_RUNNER_VERSION,
    pipeline_spec_sha256: _pipelineSpecSha256(pipeline),
    input_sha256: _sha256Hex(input),
    tenant_id_sha256: tenant_id == null ? null : _sha256Hex(tenant_id),
    classifier_label,
    route_taken,
    status,
    error: error || null,
    latency_ms_breakdown,
    result_sha256: resultString == null ? null : _sha256Hex(resultString),
    result_chars: resultString == null ? 0 : resultString.length,
  };
  return {
    ...body,
    receipt_sha256: _sha256Hex(_stableJson(body)),
  };
}

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
// "false". We do NOT JSON-stringify objects - that's a sign the classifier
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

  // Pre-flight: required inputs
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
  if (input.length > PIPELINE_RUNNER_LIMITS.MAX_INPUT_CHARS) {
    return {
      ok: false,
      error: 'input_too_large',
      input_chars: input.length,
      max_input_chars: PIPELINE_RUNNER_LIMITS.MAX_INPUT_CHARS,
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
  const classifierCid = _validateRuntimeId(
    pipeline.classifier.artifact_cid,
    'artifact_cid',
    PIPELINE_RUNNER_LIMITS.MAX_CID_CHARS,
  );
  if (!classifierCid.ok) {
    return {
      ok: false,
      error: classifierCid.error,
      hint: 'pipeline.classifier.artifact_cid must be a bounded content id, not a path',
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
  const routeValidation = _validateRuntimeRoutes(pipeline.routes);
  if (!routeValidation.ok) {
    return {
      ok: false,
      error: routeValidation.error,
      label: routeValidation.label || null,
      hint: 'pipeline route labels and targets must be bounded and unambiguous',
      version: PIPELINE_RUNNER_VERSION,
    };
  }
  const routes = routeValidation.routes;

  // Phase 1: classify
  // Wall-clock for the classify phase - load + run combined. Tests pin this
  // to a number (>= 0), not the precise value.
  const tClassifyStart = Date.now();
  let classifierArtifact;
  try {
    classifierArtifact = await artifact_loader(classifierCid.value, { tenant_id });
  } catch (e) {
    return {
      ok: false,
      error: 'classifier_load_failed',
      cid: classifierCid.value,
      detail: _safeErrorDetail(e),
      detail_sha256: _sha256Hex((e && e.message) || e || 'classifier_load_failed'),
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
      cid: classifierCid.value,
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
      cid: classifierCid.value,
      detail: _safeErrorDetail(e),
      detail_sha256: _sha256Hex((e && e.message) || e || 'classifier_failure'),
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
      cid: classifierCid.value,
      hint: 'classifier must return a string/number/boolean label; got ' + typeof rawLabel,
      latency_ms_breakdown: {
        classify: Date.now() - tClassifyStart,
        route: 0,
        total: Date.now() - t0,
      },
      version: PIPELINE_RUNNER_VERSION,
    };
  }
  const labelValidation = _validateLabel(label);
  if (!labelValidation.ok) {
    return {
      ok: false,
      error: labelValidation.error,
      cid: classifierCid.value,
      hint: 'classifier label must be bounded printable text',
      latency_ms_breakdown: {
        classify: Date.now() - tClassifyStart,
        route: 0,
        total: Date.now() - t0,
      },
      version: PIPELINE_RUNNER_VERSION,
    };
  }
  const safeLabel = labelValidation.value;
  const classifyMs = Date.now() - tClassifyStart;

  // Phase 2: route lookup + execution
  const route = routes[safeLabel];
  const tRouteStart = Date.now();
  if (!route) {
    // Honest no-route envelope. We surface the label so the operator can add
    // it to pipeline.routes; available_routes is sorted for stable diff.
    return {
      ok: false,
      error: 'route_not_found',
      label: safeLabel,
      available_routes: Object.keys(routes).sort(),
      hint: 'add this label to pipeline.routes',
      latency_ms_breakdown: {
        classify: classifyMs,
        route: 0,
        total: Date.now() - t0,
      },
      version: PIPELINE_RUNNER_VERSION,
    };
  }

  // Branch A: route has artifact_cid -> load + run a real .kolm.
  if (typeof route.artifact_cid === 'string') {
    let routeArtifact;
    try {
      routeArtifact = await artifact_loader(route.artifact_cid, { tenant_id });
    } catch (e) {
      return {
        ok: false,
        error: 'route_artifact_load_failed',
        label: safeLabel,
        cid: route.artifact_cid,
        detail: _safeErrorDetail(e),
        detail_sha256: _sha256Hex((e && e.message) || e || 'route_artifact_load_failed'),
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
        label: safeLabel,
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
        label: safeLabel,
        cid: route.artifact_cid,
        detail: _safeErrorDetail(e),
        detail_sha256: _sha256Hex((e && e.message) || e || 'route_artifact_failure'),
        latency_ms_breakdown: {
          classify: classifyMs,
          route: Date.now() - tRouteStart,
          total: Date.now() - t0,
        },
        version: PIPELINE_RUNNER_VERSION,
      };
    }
    const latency_ms_breakdown = {
      classify: classifyMs,
      route: Date.now() - tRouteStart,
      total: Date.now() - t0,
    };
    const route_taken = { kind: 'artifact', cid: route.artifact_cid, label: safeLabel };
    const pipeline_receipt = _buildRunReceipt({
      pipeline,
      input,
      tenant_id,
      classifier_label: safeLabel,
      route_taken,
      status: 'ok',
      latency_ms_breakdown,
      result,
    });
    return {
      ok: true,
      result,
      classifier_label: safeLabel,
      route_taken,
      latency_ms_breakdown,
      pipeline_spec_sha256: pipeline_receipt.pipeline_spec_sha256,
      input_sha256: pipeline_receipt.input_sha256,
      pipeline_receipt,
      pipeline_receipt_sha256: pipeline_receipt.receipt_sha256,
      version: PIPELINE_RUNNER_VERSION,
    };
  }

  // Branch B: route has teacher -> escalate to the hosted teacher.
  if (typeof route.teacher === 'string') {
    if (typeof teacher_caller !== 'function') {
      // Honest "we need an escalation handler" envelope. Tests can call the
      // runner without a teacher and still verify route_not_found / artifact
      // branches - but if the YAML asks for escalation we MUST have a caller.
      return {
        ok: false,
        error: 'teacher_caller_required',
        label: safeLabel,
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
        label: safeLabel,
        teacher: route.teacher,
        detail: _safeErrorDetail(e),
        detail_sha256: _sha256Hex((e && e.message) || e || 'teacher_call_failed'),
        latency_ms_breakdown: {
          classify: classifyMs,
          route: Date.now() - tRouteStart,
          total: Date.now() - t0,
        },
        version: PIPELINE_RUNNER_VERSION,
      };
    }
    const latency_ms_breakdown = {
      classify: classifyMs,
      route: Date.now() - tRouteStart,
      total: Date.now() - t0,
    };
    const route_taken = { kind: 'teacher', teacher: route.teacher, label: safeLabel };
    const pipeline_receipt = _buildRunReceipt({
      pipeline,
      input,
      tenant_id,
      classifier_label: safeLabel,
      route_taken,
      status: 'ok',
      latency_ms_breakdown,
      result,
    });
    return {
      ok: true,
      result,
      classifier_label: safeLabel,
      route_taken,
      latency_ms_breakdown,
      pipeline_spec_sha256: pipeline_receipt.pipeline_spec_sha256,
      input_sha256: pipeline_receipt.input_sha256,
      pipeline_receipt,
      pipeline_receipt_sha256: pipeline_receipt.receipt_sha256,
      version: PIPELINE_RUNNER_VERSION,
    };
  }

  // Validator should have caught this, but defense-in-depth: if a route is
  // a mapping with neither artifact_cid nor teacher we surface a loud error.
  return {
    ok: false,
    error: 'route_target_invalid',
    label: safeLabel,
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
// compilePipeline - W738-3
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
      detail: _safeErrorDetail(e),
      detail_sha256: _sha256Hex((e && e.message) || e || 'pipeline_yaml_parse_failed'),
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
      // No fetcher -> record the cid alone (honest: we don't fabricate sizes
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
        error: _safeErrorDetail(e),
        error_sha256: _sha256Hex((e && e.message) || e || 'manifest_fetch_failed'),
      });
    }
  }

  const created_at = (typeof opts.created_at === 'string' && !Number.isNaN(Date.parse(opts.created_at)))
    ? new Date(opts.created_at).toISOString()
    : new Date().toISOString();
  const parent_cids = referencedCids.slice().sort();

  // Stable sidecar shape - sort the cid list so the same pipeline produces
  // the same replay DAG regardless of how the operator ordered route labels.
  const sidecar = {
    artifact_kind: 'kolm.pipeline',
    version: PIPELINE_YAML_VERSION,
    name: parsed.name,
    created_at,
    classifier: {
      artifact_cid: parsed.classifier.artifact_cid,
      version: parsed.classifier.version || null,
    },
    routes: parsed.routes,
    parent_cids,
    referenced_cid_count: referencedCids.length,
    manifests,
  };
  // Content address the replayable payload, excluding created_at so operators
  // can re-emit the same yaml without rotating the lineage handle.
  const sidecar_content = {
    artifact_kind: sidecar.artifact_kind,
    version: sidecar.version,
    name: sidecar.name,
    classifier: sidecar.classifier,
    routes: sidecar.routes,
    parent_cids: sidecar.parent_cids,
    referenced_cid_count: sidecar.referenced_cid_count,
    manifests: sidecar.manifests,
  };
  const sidecar_hash = 'sha256-' + _sha256Hex(_stableJson(sidecar_content));
  return {
    ok: true,
    sidecar,
    sidecar_hash,
    sidecar_content_sha256: sidecar_hash,
    version: PIPELINE_YAML_VERSION,
  };
}
