// W738 - kolm.pipeline.yaml schema + parser.
//
// Purpose
// -------
// W738 ("Artifact Composition") lets a team chain small specialist artifacts
// (intake -> support|billing|escalation) instead of one giant generalist
// model. A pipeline yaml pins the cid of every artifact it composes, so:
//
//   - each artifact stays independently versioned (re-distill the classifier
//     without touching the routes, etc.)
//   - the runtime route table is reproducible from a single declarative file
//   - the W739 diff path can show "intake.kolm bumped, routes unchanged" or
//     "billing.kolm re-distilled" cleanly
//
// Why hand-rolled (and not js-yaml)
// ---------------------------------
// Reuses the W732 hand-rolled YAML parser (src/kolm-yaml.js) so we do NOT
// add a js-yaml dependency. package.json supply-chain surface stays clean.
// The W732 parser covers everything the W738 schema needs (mappings, nested
// mappings, scalar values, comments) - we just bolt on a W738-shaped
// validator.
//
// Schema (`PIPELINE_YAML_VERSION = 'w738-v1'`)
// --------------------------------------------
//
//   version: w738-v1
//   name: support-triage
//   classifier:
//     artifact_cid: bafk...intake
//   routes:
//     support:    { artifact_cid: bafk...support }
//     billing:    { artifact_cid: bafk...billing }
//     escalation: { teacher: claude-sonnet-4-6 }
//
// `classifier.artifact_cid` is required and must look like a real cid
// (bafk... or sha256-... - we accept both shapes).
//
// `routes` is a mapping of label -> target. Each target is exactly ONE of:
//   * `{ artifact_cid: <cid> }` - load that artifact and run it on the input.
//   * `{ teacher: <model_id> }` - escalate to a hosted teacher (no local
//                                  artifact required).
//
// Honesty contract
// ----------------
// validatePipelineYaml() returns { ok, errors } - every error surfaced (not
// just the first) so a CI run prints the full repair list. parsePipelineYaml
// throws an Error with .code in snake_case (matches the W732 contract).
//
// We do NOT silently coerce. If `routes` is absent we say so. If a route
// has both `artifact_cid` AND `teacher` we reject (ambiguous intent). If
// the same artifact_cid appears twice we accept (operator may legitimately
// route two labels to the same model).

import { parseKolmYaml } from './kolm-yaml.js';

export const PIPELINE_YAML_VERSION = 'w738-v1';

// Loose cid shape - accepts the two cid flavours kolm currently emits:
//   * IPFS-style "bafk..." or "bafy..." (base32-ish identifiers)
//   * sha256-prefixed hex ("sha256-<64 hex>")
//
// We deliberately keep this loose because the W707-W835 plan still lets
// each layer pick its own cid encoding; the load-bearing check is "looks
// like a content-address, not an empty string or a file path".
const CID_RE = /^(?:baf[a-z0-9]{4,}|sha256-[0-9a-f]{32,}|[0-9a-f]{32,})$/i;

function _isLikelyCid(s) {
  return typeof s === 'string' && s.length >= 8 && CID_RE.test(s.trim());
}

// =============================================================================
// parser
// =============================================================================
//
// The W732 parser already handles every YAML feature we need; parsePipelineYaml
// is a thin wrapper that fixes up the surface shape (we always return an
// object with the W738 top-level keys present, even when the input omits an
// optional section, so callers can branch on `.routes` without `?.`).

export function parsePipelineYaml(yamlText) {
  if (typeof yamlText !== 'string') {
    const err = new Error('parsePipelineYaml requires a string input');
    err.code = 'pipeline_yaml_input_not_string';
    err.line = 0;
    throw err;
  }
  // The W732 parser throws snake_case .code errors on malformed input; we
  // let them propagate unchanged so the CLI / route handlers can switch on
  // the same codes ('yaml_parse_failed', 'inconsistent_indent', etc).
  const parsed = parseKolmYaml(yamlText);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('pipeline yaml root must be a mapping');
    err.code = 'pipeline_root_must_be_mapping';
    err.line = 1;
    throw err;
  }
  // Surface shape: ensure version/name/classifier/routes are present (or
  // null) so validatePipelineYaml can give an honest "required" error for
  // each missing field instead of crashing on a property access.
  const out = {
    version: parsed.version != null ? parsed.version : null,
    name: parsed.name != null ? parsed.name : null,
    classifier: (parsed.classifier && typeof parsed.classifier === 'object' && !Array.isArray(parsed.classifier))
      ? {
          artifact_cid: parsed.classifier.artifact_cid != null ? parsed.classifier.artifact_cid : null,
          version: parsed.classifier.version != null ? parsed.classifier.version : null,
        }
      : null,
    routes: (parsed.routes && typeof parsed.routes === 'object' && !Array.isArray(parsed.routes))
      ? parsed.routes
      : null,
  };
  return out;
}

// =============================================================================
// validator
// =============================================================================
//
// Reports every error, not just the first. The path format mirrors jq:
// `routes.support.artifact_cid`, `classifier.artifact_cid`, etc.

function _push(errs, p, code) { errs.push({ path: p, error: code }); }

export function validatePipelineYaml(parsed) {
  const errors = [];
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: [{ path: '', error: 'root_must_be_mapping' }] };
  }
  // version: required, must equal PIPELINE_YAML_VERSION.
  if (parsed.version == null) {
    _push(errors, 'version', 'required');
  } else if (typeof parsed.version !== 'string') {
    _push(errors, 'version', 'must_be_string');
  } else if (parsed.version !== PIPELINE_YAML_VERSION) {
    _push(errors, 'version', 'must_equal_' + PIPELINE_YAML_VERSION);
  }
  // name: required string. Used by humans + the W739 lineage chain so we
  // require it (silent "untitled-pipeline" would be a footgun).
  if (parsed.name == null) {
    _push(errors, 'name', 'required');
  } else if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    _push(errors, 'name', 'must_be_non_empty_string');
  }
  // classifier: required mapping with at minimum a real-looking artifact_cid.
  if (parsed.classifier == null) {
    _push(errors, 'classifier', 'required');
  } else if (typeof parsed.classifier !== 'object' || Array.isArray(parsed.classifier)) {
    _push(errors, 'classifier', 'must_be_mapping');
  } else {
    if (parsed.classifier.artifact_cid == null) {
      _push(errors, 'classifier.artifact_cid', 'required');
    } else if (typeof parsed.classifier.artifact_cid !== 'string') {
      _push(errors, 'classifier.artifact_cid', 'must_be_string');
    } else if (!_isLikelyCid(parsed.classifier.artifact_cid)) {
      _push(errors, 'classifier.artifact_cid', 'must_look_like_cid');
    }
    if (parsed.classifier.version != null && typeof parsed.classifier.version !== 'string') {
      _push(errors, 'classifier.version', 'must_be_string');
    }
  }
  // routes: required mapping of label -> target.
  if (parsed.routes == null) {
    _push(errors, 'routes', 'required');
  } else if (typeof parsed.routes !== 'object' || Array.isArray(parsed.routes)) {
    _push(errors, 'routes', 'must_be_mapping');
  } else {
    const labels = Object.keys(parsed.routes);
    if (labels.length === 0) {
      _push(errors, 'routes', 'must_be_non_empty');
    }
    for (const label of labels) {
      const base = `routes.${label}`;
      const target = parsed.routes[label];
      if (target === null || typeof target !== 'object' || Array.isArray(target)) {
        _push(errors, base, 'must_be_mapping');
        continue;
      }
      const hasCid = target.artifact_cid != null;
      const hasTeacher = target.teacher != null;
      if (!hasCid && !hasTeacher) {
        _push(errors, base, 'must_have_artifact_cid_or_teacher');
        continue;
      }
      if (hasCid && hasTeacher) {
        // Ambiguous intent - surface loud so the operator picks one.
        _push(errors, base, 'must_not_have_both_artifact_cid_and_teacher');
        continue;
      }
      if (hasCid) {
        if (typeof target.artifact_cid !== 'string') {
          _push(errors, `${base}.artifact_cid`, 'must_be_string');
        } else if (!_isLikelyCid(target.artifact_cid)) {
          _push(errors, `${base}.artifact_cid`, 'must_look_like_cid');
        }
      }
      if (hasTeacher) {
        if (typeof target.teacher !== 'string' || target.teacher.length === 0) {
          _push(errors, `${base}.teacher`, 'must_be_non_empty_string');
        }
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// =============================================================================
// helpers
// =============================================================================
//
// collectReferencedCids() walks a validated pipeline and returns every cid
// it touches (classifier first, then route cids in route-label order). The
// W738-3 compilePipeline path feeds this into the .kolm.pipeline sidecar's
// parent_cids array so the W739 lineage chain is pre-wired.

export function collectReferencedCids(parsed) {
  const out = [];
  if (parsed && parsed.classifier && typeof parsed.classifier.artifact_cid === 'string') {
    out.push(parsed.classifier.artifact_cid);
  }
  if (parsed && parsed.routes && typeof parsed.routes === 'object') {
    for (const label of Object.keys(parsed.routes)) {
      const t = parsed.routes[label];
      if (t && typeof t.artifact_cid === 'string') out.push(t.artifact_cid);
    }
  }
  return out;
}

// Starter pipeline yaml for `kolm pipeline init` and the docs example. Kept
// here (not in cli/kolm.js) so the docs page can render the exact same text
// the CLI emits without duplicating the string.
export function starterPipelineYaml() {
  return [
    '# kolm.pipeline.yaml - compose specialist artifacts into a routed pipeline.',
    '# Schema: ' + PIPELINE_YAML_VERSION + '. Run `kolm pipeline validate` to lint.',
    'version: ' + PIPELINE_YAML_VERSION,
    'name: support-triage',
    '',
    'classifier:',
    '  artifact_cid: bafkreigh2akiscaildc3xy7p4nntwvjp7m5kw5kbsmm5kkkkkkkkkkkkkk',
    '  version: v1',
    '',
    'routes:',
    '  support:',
    '    artifact_cid: bafkreig5ssssssspport4qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    '  billing:',
    '    artifact_cid: bafkreib1lling4qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    '  escalation:',
    '    teacher: claude-sonnet-4-6',
    '',
  ].join('\n');
}
