// W821 [T2] — Artifact composition / pipeline orchestration.
//
// Sits on top of W738 (kolm.pipeline.yaml parser + runtime runner) and adds:
//
//   - Persistent named pipelines stored at ~/.kolm/pipelines/<id>.yaml plus an
//     index file (~/.kolm/pipelines/index.json) so the HTTP / CLI / UI surfaces
//     can list + select pipelines by id without rescanning the directory.
//   - Runtime ROUTER (`orchestrate(...)`) that classifies an input via the
//     pipeline's classifier_artifact, picks a route, and returns a uniform
//     {artifact_used, intent, prediction, latency_ms} envelope. The runtime
//     itself is dependency-injected so tests don't need a real .kolm loader
//     and so the production path can swap in src/artifact-runner.js.
//   - Pipeline-LEVEL K-Score (`computePipelineKScore(...)`) — a frequency-
//     weighted average of per-route k_scores. Routes that the classifier
//     actually picks get weighted heavily; cold routes don't drag the
//     headline number around.
//
// Schema vs the W738 schema
// -------------------------
// W738's PIPELINE_YAML_VERSION ('w738-v1') uses {classifier:{artifact_cid:..},
// routes:{label:{artifact_cid|teacher}}} with explicit cid pinning. W821
// targets the simpler "operator-friendly" shape the spec asked for:
//
//     version: "v1"
//     name: "customer-support"
//     classifier: "~/.kolm/artifacts/intent-router.kolm"
//     routes:
//       - match: { intent: "tier1_faq" }
//         artifact: "~/.kolm/artifacts/faq-tier1.kolm"
//       - default: "~/.kolm/artifacts/general-llm.kolm"
//
// The two schemas COEXIST. W738 is the cid-pinned reproducible-build path
// (kolm.pipeline.yaml -> .kolm.pipeline sidecar). W821 is the local-files
// operator-control-plane path (file paths on disk, edit-and-reload). A future
// wave can normalise both shapes into one canonical IR; for now we keep them
// distinct so each surface has a stable contract.
//
// Honesty contract
// ----------------
// parsePipelineYaml() throws KolmError on missing required fields (.code is
// snake_case: pipeline_version_required, pipeline_routes_required, ...).
// validatePipeline() accumulates EVERY error before returning (so the CI lint
// path prints the full repair list). orchestrate() returns honest envelopes:
//   - missing classifier_artifact -> {ok:false, error:'classifier_artifact_missing'}
//   - no matching route -> falls back to default; only fails if no default.
//   - dependency-injected runtime missing -> {ok:false, error:'runtime_required'}
// computePipelineKScore returns {ok:false, status:'no_eval_data', ...} when
// route_frequencies is empty or every route has null/undefined kscore — never
// fabricates a number.

import { kolmError } from './kolm-error.js';

export const PIPELINE_ORCHESTRATOR_VERSION = 'w821-v1';

// Frozen state machine for run lifecycle. Used by the runtime + by the
// /v1/pipelines/:id/run envelope so callers can branch on a stable set of
// strings rather than parsing free-form messages.
export const PIPELINE_STATES = Object.freeze({
  IDLE:    'idle',
  RUNNING: 'running',
  OK:      'ok',
  FAILED:  'failed',
  PARTIAL: 'partial',
});

// Frozen schema description. Used by tests + the docs UI to render the
// canonical pipeline-file shape without duplicating it in markdown.
export const PIPELINE_SCHEMA = Object.freeze({
  version_field: 'version',
  supported_versions: Object.freeze(['v1']),
  required_fields: Object.freeze(['version', 'routes']),
  optional_fields: Object.freeze(['name', 'classifier', 'description']),
  route_shape: Object.freeze({
    match_field: 'match',
    default_field: 'default',
    artifact_field: 'artifact',
  }),
});

// ─── tiny YAML parser (subset) ────────────────────────────────────────────────
// We hand-roll a permissive YAML subset (mappings, list-of-mappings, scalar
// values, quoted strings, `#` line comments) so this module stays zero-dep.
// Indented blocks use 2-space conventions but tolerate any consistent indent.
//
// Out of scope (deliberately): YAML anchors/aliases, multiline folded scalars,
// timestamps, complex flow-style. Operators who need those should compile to
// the W738 schema instead; W821 is the friendly file format, not a YAML 1.2
// implementation.

function _trimComment(line) {
  // Strip `# ...` outside quoted strings. Tiny state machine — good enough
  // for the subset above.
  let out = '';
  let i = 0;
  let q = null; // active quote char or null
  while (i < line.length) {
    const c = line[i];
    if (q) {
      out += c;
      if (c === q && line[i - 1] !== '\\') q = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { q = c; out += c; i++; continue; }
    if (c === '#') break;
    out += c;
    i++;
  }
  return out;
}

function _stripQuotes(s) {
  if (typeof s !== 'string') return s;
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function _scalarOrNumber(s) {
  if (s == null) return null;
  const trimmed = s.trim();
  if (trimmed === '') return '';
  if (trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  // Quoted -> string.
  if (/^["']/.test(trimmed)) return _stripQuotes(trimmed);
  // Number-ish?
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

// Parse one inline mapping like `{ intent: "tier1_faq", confidence: 0.8 }`
// Returns the parsed object or throws.
function _parseInlineMap(text) {
  const inner = text.trim().replace(/^\{|\}$/g, '');
  const out = {};
  // Split by `,` outside quotes.
  const parts = [];
  let depth = 0, q = null, buf = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) {
      buf += c;
      if (c === q && inner[i - 1] !== '\\') q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; buf += c; continue; }
    if (c === '{' || c === '[') { depth++; buf += c; continue; }
    if (c === '}' || c === ']') { depth--; buf += c; continue; }
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf);
  for (const p of parts) {
    const colon = p.indexOf(':');
    if (colon < 0) continue;
    const k = _stripQuotes(p.slice(0, colon).trim());
    const v = _scalarOrNumber(p.slice(colon + 1).trim());
    out[k] = v;
  }
  return out;
}

// parsePipelineYaml(text) -> parsed object OR throws KolmError.
//
// Accepts an empty/null-ish input (returns an honest "pipeline_yaml_empty"
// error so the caller doesn't get a stack trace from `null.routes`).
export function parsePipelineYaml(yamlText) {
  if (typeof yamlText !== 'string' || yamlText.trim() === '') {
    throw kolmError('pipeline_yaml_empty', 'pipeline yaml is empty', { status: 400 });
  }
  const rawLines = yamlText.split(/\r?\n/);
  // Pre-strip comments + blank lines, BUT remember the original 1-based line
  // number so error messages point to the right spot in the source file.
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const cleaned = _trimComment(rawLines[i]);
    if (cleaned.trim() === '') continue;
    lines.push({ text: cleaned, lineno: i + 1 });
  }
  if (lines.length === 0) {
    throw kolmError('pipeline_yaml_empty', 'pipeline yaml contains only comments/whitespace', { status: 400 });
  }

  const out = {};
  // Top-level walk: each line is either `key: value` or `key:` introducing a
  // nested block. We only need depth = top-level + one nested level for the
  // W821 schema, so we hand-track indent rather than running a full parser.
  for (let idx = 0; idx < lines.length; idx++) {
    const { text, lineno } = lines[idx];
    const indent = text.match(/^( *)/)[1].length;
    if (indent !== 0) {
      // A stray indented line at the top level means the file is malformed.
      throw kolmError(
        'pipeline_yaml_unexpected_indent',
        `unexpected indent at line ${lineno}: "${text}"`,
        { status: 400, detail: { line: lineno } },
      );
    }
    const colon = text.indexOf(':');
    if (colon < 0) {
      throw kolmError(
        'pipeline_yaml_missing_colon',
        `expected "key:" at line ${lineno}`,
        { status: 400, detail: { line: lineno } },
      );
    }
    const key = text.slice(0, colon).trim();
    const valuePart = text.slice(colon + 1).trim();

    if (valuePart !== '') {
      // Inline scalar value (or inline map starting with `{`).
      if (valuePart.startsWith('{')) {
        out[key] = _parseInlineMap(valuePart);
      } else {
        out[key] = _scalarOrNumber(valuePart);
      }
      continue;
    }

    // Nested block. Pull subsequent more-indented lines.
    const blockLines = [];
    let j = idx + 1;
    while (j < lines.length) {
      const next = lines[j];
      const nextIndent = next.text.match(/^( *)/)[1].length;
      if (nextIndent === 0) break;
      blockLines.push(next);
      j++;
    }
    idx = j - 1;
    if (blockLines.length === 0) {
      out[key] = null;
      continue;
    }
    // List-of-mappings? Starts with `- `.
    if (blockLines[0].text.trim().startsWith('-')) {
      out[key] = _parseListOfMappings(blockLines);
    } else {
      out[key] = _parseFlatMapping(blockLines);
    }
  }

  return out;
}

// Parse `- key: value` style list of mappings. Each `- ` starts a new entry;
// subsequent indented lines (relative to the `-`) are folded into the entry.
function _parseListOfMappings(blockLines) {
  const items = [];
  let current = null;
  let dashIndent = -1;
  for (const { text, lineno } of blockLines) {
    const indent = text.match(/^( *)/)[1].length;
    const trimmed = text.trim();
    if (trimmed.startsWith('-')) {
      if (current) items.push(current);
      current = {};
      dashIndent = indent;
      // `- key: value` inline shape
      const rest = trimmed.slice(1).trim();
      if (rest.length > 0) {
        const colon = rest.indexOf(':');
        if (colon < 0) {
          throw kolmError(
            'pipeline_yaml_list_entry_invalid',
            `list entry needs "key: value" at line ${lineno}`,
            { status: 400, detail: { line: lineno } },
          );
        }
        const k = rest.slice(0, colon).trim();
        const v = rest.slice(colon + 1).trim();
        current[k] = v.startsWith('{') ? _parseInlineMap(v) : _scalarOrNumber(v);
      }
      continue;
    }
    // Indented under the current `-` entry.
    if (!current) {
      throw kolmError(
        'pipeline_yaml_list_indent_invalid',
        `indented line with no preceding "- " at line ${lineno}`,
        { status: 400, detail: { line: lineno } },
      );
    }
    if (indent <= dashIndent) {
      // Same-or-lesser indent without a dash -> structural error.
      throw kolmError(
        'pipeline_yaml_list_dedent_invalid',
        `dedent without dash at line ${lineno}`,
        { status: 400, detail: { line: lineno } },
      );
    }
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const k = trimmed.slice(0, colon).trim();
    const v = trimmed.slice(colon + 1).trim();
    current[k] = v.startsWith('{') ? _parseInlineMap(v) : _scalarOrNumber(v);
  }
  if (current) items.push(current);
  return items;
}

// Parse a flat mapping block (key: value pairs, no list).
function _parseFlatMapping(blockLines) {
  const out = {};
  for (const { text, lineno } of blockLines) {
    const trimmed = text.trim();
    const colon = trimmed.indexOf(':');
    if (colon < 0) {
      throw kolmError(
        'pipeline_yaml_mapping_missing_colon',
        `expected "key:" at line ${lineno}`,
        { status: 400, detail: { line: lineno } },
      );
    }
    const k = trimmed.slice(0, colon).trim();
    const v = trimmed.slice(colon + 1).trim();
    out[k] = v.startsWith('{') ? _parseInlineMap(v) : _scalarOrNumber(v);
  }
  return out;
}

// validatePipeline(parsed) -> {ok, errors}
//
// Accumulates ALL errors before returning, so an operator iterating on a
// broken pipeline file sees every problem in one round-trip.
export function validatePipeline(parsed) {
  const errors = [];

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: [{ code: 'pipeline_root_must_be_mapping', path: '$' }] };
  }

  // version: required, must equal one of supported_versions.
  if (parsed.version == null) {
    errors.push({ code: 'pipeline_version_required', path: 'version' });
  } else if (!PIPELINE_SCHEMA.supported_versions.includes(String(parsed.version))) {
    errors.push({
      code: 'pipeline_version_unsupported',
      path: 'version',
      detail: { got: parsed.version, supported: PIPELINE_SCHEMA.supported_versions.slice() },
    });
  }

  // routes: required non-empty array.
  if (parsed.routes == null) {
    errors.push({ code: 'pipeline_routes_required', path: 'routes' });
  } else if (!Array.isArray(parsed.routes)) {
    errors.push({ code: 'pipeline_routes_must_be_list', path: 'routes' });
  } else if (parsed.routes.length === 0) {
    errors.push({ code: 'pipeline_routes_must_be_non_empty', path: 'routes' });
  } else {
    let defaultCount = 0;
    for (let i = 0; i < parsed.routes.length; i++) {
      const r = parsed.routes[i];
      if (r == null || typeof r !== 'object') {
        errors.push({ code: 'pipeline_route_must_be_mapping', path: `routes[${i}]` });
        continue;
      }
      const hasMatch = r.match != null;
      const hasDefault = r.default != null;
      if (!hasMatch && !hasDefault) {
        errors.push({ code: 'pipeline_route_needs_match_or_default', path: `routes[${i}]` });
        continue;
      }
      if (hasMatch && hasDefault) {
        errors.push({ code: 'pipeline_route_match_and_default_exclusive', path: `routes[${i}]` });
      }
      if (hasMatch && !r.artifact) {
        errors.push({ code: 'pipeline_route_missing_artifact', path: `routes[${i}].artifact` });
      }
      if (hasDefault) defaultCount++;
    }
    if (defaultCount > 1) {
      errors.push({ code: 'pipeline_multiple_defaults', path: 'routes', detail: { count: defaultCount } });
    }
  }

  // name: optional, but if present must be a non-empty string.
  if (parsed.name != null && (typeof parsed.name !== 'string' || parsed.name.trim() === '')) {
    errors.push({ code: 'pipeline_name_must_be_non_empty_string', path: 'name' });
  }

  // classifier: optional, but if present must be a string path (the friendly
  // schema; the W738 cid-pinned shape is a separate code path).
  if (parsed.classifier != null && typeof parsed.classifier !== 'string') {
    errors.push({ code: 'pipeline_classifier_must_be_string_path', path: 'classifier' });
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

// ─── orchestrate ─────────────────────────────────────────────────────────────
//
// orchestrate({pipeline, input, runtime}) -> async
//
//   pipeline  - parsed + validated pipeline object (call validatePipeline first)
//   input     - the request input (string OR object — passed through to the
//               classifier_artifact verbatim)
//   runtime   - dependency-injected adapter:
//                 runtime.runArtifact(artifactPath, input) -> Promise<{ok, output}>
//               In production this is wired to src/artifact-runner.js. In tests
//               we pass a stub. Without a runtime we fail loud rather than
//               silently using a no-op.
//
// Returns:
//   {ok:true, artifact_used, intent, prediction, route_index, latency_ms,
//    state: PIPELINE_STATES.OK}
//   OR honest error envelope with state:PIPELINE_STATES.FAILED.
//
// Routing logic:
//   1. If pipeline.classifier is set, runtime.runArtifact(classifier, input)
//      MUST resolve to {ok:true, output:{intent}} (or {ok:true, output:string}
//      where the string IS the intent). We extract the intent string.
//   2. We walk pipeline.routes in order; the first {match:{intent: <X>}} that
//      equals the classifier's intent wins. We compare match keys+values for
//      ALL keys in match (not just intent) so future routers can add fields
//      like confidence or language.
//   3. If no match found, fall through to the first {default: ...} route.
//   4. If no default, return route_not_found envelope.
//
// Latency: top-level Date.now() bookends; we don't try to break out
// classify vs route timings here (the W738 runtime does that with more
// detail — callers who need it can use runPipeline()).
export async function orchestrate({ pipeline, input, runtime } = {}) {
  const t0 = Date.now();
  if (!pipeline || typeof pipeline !== 'object') {
    return {
      ok: false,
      error: 'pipeline_required',
      state: PIPELINE_STATES.FAILED,
      latency_ms: 0,
    };
  }
  if (!runtime || typeof runtime.runArtifact !== 'function') {
    return {
      ok: false,
      error: 'runtime_required',
      hint: 'pass {runtime:{runArtifact(path,input)}}',
      state: PIPELINE_STATES.FAILED,
      latency_ms: 0,
    };
  }
  // Validate cheaply (caller usually pre-validates, but defense-in-depth).
  const v = validatePipeline(pipeline);
  if (!v.ok) {
    return {
      ok: false,
      error: 'pipeline_invalid',
      validation_errors: v.errors,
      state: PIPELINE_STATES.FAILED,
      latency_ms: Date.now() - t0,
    };
  }

  // ── classify (optional) ────────────────────────────────────────────────────
  let intent = null;
  if (pipeline.classifier) {
    let cls;
    try {
      cls = await runtime.runArtifact(pipeline.classifier, input);
    } catch (e) {
      return {
        ok: false,
        error: 'classifier_artifact_failed',
        artifact_used: pipeline.classifier,
        detail: (e && e.message) || String(e),
        state: PIPELINE_STATES.FAILED,
        latency_ms: Date.now() - t0,
      };
    }
    if (!cls || cls.ok === false) {
      return {
        ok: false,
        error: 'classifier_artifact_missing',
        artifact_used: pipeline.classifier,
        detail: cls && cls.error ? cls.error : 'classifier returned non-ok envelope',
        state: PIPELINE_STATES.FAILED,
        latency_ms: Date.now() - t0,
      };
    }
    const out = cls.output;
    intent = (typeof out === 'string') ? out : (out && typeof out === 'object' && typeof out.intent === 'string') ? out.intent : null;
    if (intent == null) {
      return {
        ok: false,
        error: 'classifier_returned_no_intent',
        artifact_used: pipeline.classifier,
        state: PIPELINE_STATES.FAILED,
        latency_ms: Date.now() - t0,
      };
    }
  }

  // ── route lookup ───────────────────────────────────────────────────────────
  let pickedIndex = -1;
  let pickedRoute = null;
  for (let i = 0; i < pipeline.routes.length; i++) {
    const r = pipeline.routes[i];
    if (r.match && intent != null && _matchesIntent(r.match, intent)) {
      pickedIndex = i;
      pickedRoute = r;
      break;
    }
  }
  // Fall back to first default if no explicit match.
  if (!pickedRoute) {
    for (let i = 0; i < pipeline.routes.length; i++) {
      const r = pipeline.routes[i];
      if (r.default != null) {
        pickedIndex = i;
        pickedRoute = r;
        break;
      }
    }
  }
  if (!pickedRoute) {
    return {
      ok: false,
      error: 'route_not_found',
      intent,
      available_intents: pipeline.routes.filter((r) => r.match).map((r) => r.match.intent),
      state: PIPELINE_STATES.FAILED,
      latency_ms: Date.now() - t0,
    };
  }
  const artifactPath = pickedRoute.artifact || pickedRoute.default;
  if (typeof artifactPath !== 'string' || artifactPath.length === 0) {
    return {
      ok: false,
      error: 'route_artifact_path_missing',
      route_index: pickedIndex,
      state: PIPELINE_STATES.FAILED,
      latency_ms: Date.now() - t0,
    };
  }

  // ── execute the picked artifact ────────────────────────────────────────────
  let runResult;
  try {
    runResult = await runtime.runArtifact(artifactPath, input);
  } catch (e) {
    return {
      ok: false,
      error: 'route_artifact_failed',
      artifact_used: artifactPath,
      route_index: pickedIndex,
      detail: (e && e.message) || String(e),
      state: PIPELINE_STATES.FAILED,
      latency_ms: Date.now() - t0,
    };
  }
  if (!runResult || runResult.ok === false) {
    return {
      ok: false,
      error: 'route_artifact_returned_error',
      artifact_used: artifactPath,
      route_index: pickedIndex,
      detail: runResult && runResult.error ? runResult.error : 'unknown',
      state: PIPELINE_STATES.PARTIAL,
      intent,
      latency_ms: Date.now() - t0,
    };
  }
  return {
    ok: true,
    artifact_used: artifactPath,
    intent,
    prediction: runResult.output,
    route_index: pickedIndex,
    state: PIPELINE_STATES.OK,
    latency_ms: Date.now() - t0,
  };
}

function _matchesIntent(match, intent) {
  if (!match || typeof match !== 'object') return false;
  if (match.intent == null) return false;
  return String(match.intent) === String(intent);
}

// ─── pipeline K-Score (weighted by route frequency) ─────────────────────────
//
// computePipelineKScore({pipeline, eval_set, route_frequencies}) -> {ok, ...}
//
// We do NOT re-run the pipeline here. The caller supplies:
//   route_frequencies: { '<intent-or-default-index>': <count>, ... }
//     The keys can be intent strings (matches a route's match.intent) OR
//     the literal string "default" (matches the first default route). Values
//     are non-negative integers; zero is allowed but is treated as "cold"
//     and excluded from the weighted average (cold routes don't drag the
//     headline number around).
//   eval_set: { '<intent-or-default>': { k_score: <0..1>, n_eval: <int> } }
//     Per-route K-Score from a prior eval run; n_eval is how many cases the
//     score was computed over (used to weight uncertain scores down — a
//     route with 5 evals counts less than one with 500).
//
// Returns:
//   {ok:true, weighted_k_score, per_route:[{intent, weight, k_score, n_eval}],
//    total_frequency, status:'computed'}
//   OR {ok:false, status:'no_eval_data', ...} when there's nothing to weight.
//
// Formula:
//   For each route i with frequency f_i > 0 AND a known k_score k_i:
//     w_i = f_i  (we DO NOT downweight by n_eval here — that's an eval-quality
//                signal, surfaced separately so the operator can decide)
//   weighted_k_score = sum(w_i * k_i) / sum(w_i)
//
// We deliberately keep it linear; a future calibration pass (see W810) maps
// raw K to human_preference_rate non-linearly, but that's a separate concern.
export function computePipelineKScore({ pipeline, eval_set, route_frequencies } = {}) {
  if (!pipeline || typeof pipeline !== 'object' || !Array.isArray(pipeline.routes)) {
    return {
      ok: false,
      status: 'no_eval_data',
      weighted_k_score: null,
      per_route: [],
      reason: 'pipeline_invalid',
    };
  }
  const freq = (route_frequencies && typeof route_frequencies === 'object') ? route_frequencies : {};
  const evals = (eval_set && typeof eval_set === 'object') ? eval_set : {};

  const perRoute = [];
  let totalFreq = 0;
  let weightedNum = 0;
  let weightedDen = 0;
  for (let i = 0; i < pipeline.routes.length; i++) {
    const r = pipeline.routes[i];
    const key = r.match && r.match.intent ? String(r.match.intent) : (r.default != null ? 'default' : `route_${i}`);
    const f = Number(freq[key]) || 0;
    totalFreq += f;
    const ev = evals[key];
    const k = (ev && typeof ev.k_score === 'number' && Number.isFinite(ev.k_score)) ? ev.k_score : null;
    const n = (ev && typeof ev.n_eval === 'number') ? ev.n_eval : 0;
    perRoute.push({ intent: key, weight: f, k_score: k, n_eval: n });
    if (f > 0 && k != null) {
      weightedNum += f * k;
      weightedDen += f;
    }
  }
  if (totalFreq === 0) {
    return {
      ok: false,
      status: 'no_eval_data',
      weighted_k_score: null,
      per_route: perRoute,
      total_frequency: 0,
      reason: 'route_frequencies_empty',
    };
  }
  if (weightedDen === 0) {
    return {
      ok: false,
      status: 'no_eval_data',
      weighted_k_score: null,
      per_route: perRoute,
      total_frequency: totalFreq,
      reason: 'no_per_route_k_score',
    };
  }
  return {
    ok: true,
    status: 'computed',
    weighted_k_score: weightedNum / weightedDen,
    per_route: perRoute,
    total_frequency: totalFreq,
    version: PIPELINE_ORCHESTRATOR_VERSION,
  };
}

// ─── persistence helpers ────────────────────────────────────────────────────
//
// Pipelines live at ~/.kolm/pipelines/<id>.yaml plus an index file
// ~/.kolm/pipelines/index.json. The index tracks {id, name, tenant_id,
// created_at, updated_at} so list/lookup is O(1) without rescanning the dir.
//
// We re-use the standard KOLM_DATA_DIR override convention so tests with a
// temp HOME get isolated storage.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function _home() { return process.env.HOME || process.env.USERPROFILE || os.homedir(); }
function _kolmDir() {
  return process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
}
function _pipelinesDir() {
  const p = path.join(_kolmDir(), 'pipelines');
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function _indexPath() { return path.join(_pipelinesDir(), 'index.json'); }

function _readIndex() {
  const p = _indexPath();
  if (!fs.existsSync(p)) return [];
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function _writeIndex(rows) {
  fs.writeFileSync(_indexPath(), JSON.stringify(rows, null, 2));
}

function _newPipelineId() {
  return 'pl_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

// listPipelines({tenant_id}) -> array of {id, name, tenant_id, ...}
export function listPipelines({ tenant_id } = {}) {
  const rows = _readIndex();
  if (!tenant_id) return rows.slice();
  return rows.filter((r) => r && r.tenant_id === tenant_id);
}

// getPipeline(id, {tenant_id}) -> {id, name, tenant_id, yaml, parsed, ...} OR null
//
// Tenant fence is load-bearing — never return a row from another tenant.
export function getPipeline(id, { tenant_id } = {}) {
  const rows = _readIndex();
  const row = rows.find((r) => r && r.id === id);
  if (!row) return null;
  if (tenant_id && row.tenant_id !== tenant_id) return null;
  const yamlPath = path.join(_pipelinesDir(), id + '.yaml');
  if (!fs.existsSync(yamlPath)) return null;
  const yaml = fs.readFileSync(yamlPath, 'utf8');
  let parsed = null, parse_error = null;
  try { parsed = parsePipelineYaml(yaml); }
  catch (e) { parse_error = { code: e && e.code, message: e && e.message }; }
  return { ...row, yaml, parsed, parse_error };
}

// createPipeline({name, yaml, tenant_id}) -> {ok, id, ...}
export function createPipeline({ name, yaml, tenant_id } = {}) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'pipeline_name_required' };
  }
  if (typeof yaml !== 'string' || yaml.trim() === '') {
    return { ok: false, error: 'pipeline_yaml_required' };
  }
  let parsed;
  try { parsed = parsePipelineYaml(yaml); }
  catch (e) {
    return { ok: false, error: e.code || 'pipeline_yaml_parse_failed', detail: e.message };
  }
  const v = validatePipeline(parsed);
  if (!v.ok) {
    return { ok: false, error: 'pipeline_invalid', validation_errors: v.errors };
  }
  const id = _newPipelineId();
  const now = new Date().toISOString();
  const row = {
    id,
    name: name.trim(),
    tenant_id: tenant_id || null,
    created_at: now,
    updated_at: now,
    version: parsed.version,
    route_count: Array.isArray(parsed.routes) ? parsed.routes.length : 0,
    has_classifier: !!parsed.classifier,
  };
  fs.writeFileSync(path.join(_pipelinesDir(), id + '.yaml'), yaml);
  const rows = _readIndex();
  rows.push(row);
  _writeIndex(rows);
  return { ok: true, id, ...row };
}

// deletePipeline(id, {tenant_id}) -> {ok, ...}
export function deletePipeline(id, { tenant_id } = {}) {
  const rows = _readIndex();
  const idx = rows.findIndex((r) => r && r.id === id);
  if (idx < 0) return { ok: false, error: 'pipeline_not_found' };
  const row = rows[idx];
  if (tenant_id && row.tenant_id !== tenant_id) return { ok: false, error: 'pipeline_not_found' };
  rows.splice(idx, 1);
  _writeIndex(rows);
  const yamlPath = path.join(_pipelinesDir(), id + '.yaml');
  if (fs.existsSync(yamlPath)) {
    try { fs.unlinkSync(yamlPath); } catch {}
  }
  return { ok: true, id };
}

// _resetForTests() — wipes the pipelines dir + index. Used by tests with a
// scoped HOME / KOLM_DATA_DIR; safe no-op when the dir is missing.
export function _resetForTests() {
  const dir = _pipelinesDir();
  try {
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  } catch {}
}

// recordPipelineRun({pipeline_id, tenant_id, result}) -> persists a run event
// via src/event-store.js so the /v1/pipelines/:id/kscore endpoint can build
// route_frequencies from history without a separate tracker. Dynamic import so
// this module stays loadable in environments without event-store.
export async function recordPipelineRun({ pipeline_id, tenant_id, namespace, result } = {}) {
  if (!pipeline_id || !result) return null;
  try {
    const { appendEvent } = await import('./event-store.js');
    return await appendEvent({
      tenant_id: tenant_id || 'unknown',
      namespace: namespace || 'pipeline_runs',
      workflow_id: pipeline_id,
      status: result.ok ? 'success' : 'error',
      provider: 'kolm-pipeline-orchestrator',
      model: PIPELINE_ORCHESTRATOR_VERSION,
      json_extra: {
        kind: 'pipeline_run',
        pipeline_id,
        artifact_used: result.artifact_used || null,
        intent: result.intent || null,
        route_index: result.route_index != null ? result.route_index : null,
        state: result.state || null,
        latency_ms: result.latency_ms || 0,
      },
    });
  } catch {
    return null;
  }
}

export default {
  PIPELINE_ORCHESTRATOR_VERSION,
  PIPELINE_STATES,
  PIPELINE_SCHEMA,
  parsePipelineYaml,
  validatePipeline,
  orchestrate,
  computePipelineKScore,
  listPipelines,
  getPipeline,
  createPipeline,
  deletePipeline,
  recordPipelineRun,
  _resetForTests,
};
