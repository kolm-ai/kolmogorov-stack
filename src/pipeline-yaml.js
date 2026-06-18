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
export const PIPELINE_YAML_CONTRACT_VERSION = 'w713-v1';
export const PIPELINE_YAML_LIMITS = Object.freeze({
  max_yaml_chars: 64_000,
  max_name_chars: 128,
  max_routes: 128,
  max_route_label_chars: 128,
  max_cid_chars: 256,
  max_teacher_id_chars: 160,
});

// Loose cid shape - accepts the two cid flavours kolm currently emits:
//   * IPFS-style "bafk..." or "bafy..." (base32-ish identifiers)
//   * sha256-prefixed hex ("sha256-<64 hex>")
//
// We deliberately keep this loose because the W707-W835 plan still lets
// each layer pick its own cid encoding; the load-bearing check is "looks
// like a content-address, not an empty string or a file path".
const CID_RE = /^(?:baf[a-z0-9]{4,}|sha256-[0-9a-f]{32,}|[0-9a-f]{32,})$/i;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.: -]{0,127}$/;
const SAFE_ROUTE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_TEACHER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TOP_LEVEL_KEYS = new Set(['version', 'name', 'classifier', 'routes']);
const CLASSIFIER_KEYS = new Set(['artifact_cid', 'version']);
const ROUTE_TARGET_KEYS = new Set(['artifact_cid', 'teacher']);
const UNSAFE_PATHS = Symbol('pipeline_yaml_unsafe_paths');

function _isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function _hasSafePrototype(value) {
  if (!_isMapping(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function _ownKeys(value) {
  return _isMapping(value) ? Object.keys(value) : [];
}

function _isReservedKey(key) {
  return RESERVED_KEYS.has(String(key));
}

function _normaliseCid(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (s.length < 8 || s.length > PIPELINE_YAML_LIMITS.max_cid_chars) return null;
  return CID_RE.test(s) ? s : null;
}

function _normaliseCidIfValid(value) {
  return _normaliseCid(value) || value;
}

function _normaliseTeacherIfString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function _isLikelyCid(s) {
  return _normaliseCid(s) !== null;
}

function _attachUnsafePaths(out, unsafePaths) {
  Object.defineProperty(out, UNSAFE_PATHS, {
    value: unsafePaths,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function _unsafePaths(parsed) {
  return _isMapping(parsed) && Array.isArray(parsed[UNSAFE_PATHS]) ? parsed[UNSAFE_PATHS] : [];
}

function _recordUnsafeMapping(value, path, unsafePaths) {
  if (_isMapping(value) && !_hasSafePrototype(value)) unsafePaths.push(path);
}

function _copyUnknownTopLevel(parsed, out, unsafePaths) {
  for (const key of _ownKeys(parsed)) {
    if (TOP_LEVEL_KEYS.has(key)) continue;
    if (_isReservedKey(key)) {
      unsafePaths.push(key);
      continue;
    }
    out[key] = parsed[key];
  }
}

function _normaliseClassifier(raw, unsafePaths) {
  if (!_isMapping(raw)) return null;
  _recordUnsafeMapping(raw, 'classifier', unsafePaths);
  const out = {};
  for (const key of _ownKeys(raw)) {
    if (_isReservedKey(key)) unsafePaths.push(`classifier.${key}`);
    out[key] = key === 'artifact_cid' ? _normaliseCidIfValid(raw[key]) : raw[key];
  }
  if (!Object.prototype.hasOwnProperty.call(out, 'artifact_cid')) out.artifact_cid = null;
  if (!Object.prototype.hasOwnProperty.call(out, 'version')) out.version = null;
  return out;
}

function _normaliseRouteTarget(raw, path, unsafePaths) {
  if (!_isMapping(raw)) return raw;
  _recordUnsafeMapping(raw, path, unsafePaths);
  const out = {};
  for (const key of _ownKeys(raw)) {
    if (_isReservedKey(key)) unsafePaths.push(`${path}.${key}`);
    if (key === 'artifact_cid') out[key] = _normaliseCidIfValid(raw[key]);
    else if (key === 'teacher') out[key] = _normaliseTeacherIfString(raw[key]);
    else out[key] = raw[key];
  }
  return out;
}

function _normaliseRoutes(raw, unsafePaths) {
  if (!_isMapping(raw)) return null;
  _recordUnsafeMapping(raw, 'routes', unsafePaths);
  const out = Object.create(null);
  for (const label of _ownKeys(raw)) {
    if (_isReservedKey(label)) unsafePaths.push(`routes.${label}`);
    out[label] = _normaliseRouteTarget(raw[label], `routes.${label}`, unsafePaths);
  }
  return out;
}

function _validateUnknownKeys(errors, obj, allowed, basePath) {
  for (const key of _ownKeys(obj)) {
    if (_isReservedKey(key)) {
      _push(errors, basePath ? `${basePath}.${key}` : key, 'reserved_key');
      continue;
    }
    if (!allowed.has(key)) {
      _push(errors, basePath ? `${basePath}.${key}` : key, 'unknown_key');
    }
  }
}

function _validateCid(errors, path, value) {
  if (typeof value !== 'string') {
    _push(errors, path, 'must_be_string');
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length > PIPELINE_YAML_LIMITS.max_cid_chars) {
    _push(errors, path, 'too_long');
  } else if (!_isLikelyCid(value)) {
    _push(errors, path, 'must_look_like_cid');
  }
}

function _validateRouteLabel(errors, label) {
  const path = `routes.${label}`;
  if (_isReservedKey(label)) {
    _push(errors, path, 'reserved_key');
    return;
  }
  if (label.length > PIPELINE_YAML_LIMITS.max_route_label_chars) {
    _push(errors, path, 'label_too_long');
    return;
  }
  if (!SAFE_ROUTE_LABEL_RE.test(label)) {
    _push(errors, path, 'label_must_match_safe_pattern');
  }
}

function _validateTeacher(errors, path, value) {
  if (typeof value !== 'string') {
    _push(errors, path, 'must_be_string');
    return;
  }
  if (value.length === 0) {
    _push(errors, path, 'must_be_non_empty_string');
  } else if (value.length > PIPELINE_YAML_LIMITS.max_teacher_id_chars) {
    _push(errors, path, 'too_long');
  } else if (!SAFE_TEACHER_ID_RE.test(value)) {
    _push(errors, path, 'must_match_safe_teacher_id');
  }
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
  if (yamlText.length > PIPELINE_YAML_LIMITS.max_yaml_chars) {
    const err = new Error('pipeline yaml exceeds max size');
    err.code = 'pipeline_yaml_too_large';
    err.line = 0;
    err.max_chars = PIPELINE_YAML_LIMITS.max_yaml_chars;
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
  // each missing field instead of crashing on a property access. Unknown keys
  // are preserved so validatePipelineYaml can reject them explicitly instead
  // of silently dropping operator intent.
  const unsafePaths = [];
  _recordUnsafeMapping(parsed, '', unsafePaths);
  const out = {
    version: parsed.version != null ? parsed.version : null,
    name: parsed.name != null ? parsed.name : null,
    classifier: _normaliseClassifier(parsed.classifier, unsafePaths),
    routes: _normaliseRoutes(parsed.routes, unsafePaths),
  };
  _copyUnknownTopLevel(parsed, out, unsafePaths);
  _attachUnsafePaths(out, unsafePaths);
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
  for (const path of _unsafePaths(parsed)) {
    _push(errors, path, 'unsafe_mapping_prototype');
  }
  _validateUnknownKeys(errors, parsed, TOP_LEVEL_KEYS, '');
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
  } else if (parsed.name.length > PIPELINE_YAML_LIMITS.max_name_chars) {
    _push(errors, 'name', 'too_long');
  } else if (!SAFE_NAME_RE.test(parsed.name)) {
    _push(errors, 'name', 'must_match_safe_name');
  }
  // classifier: required mapping with at minimum a real-looking artifact_cid.
  if (parsed.classifier == null) {
    _push(errors, 'classifier', 'required');
  } else if (typeof parsed.classifier !== 'object' || Array.isArray(parsed.classifier)) {
    _push(errors, 'classifier', 'must_be_mapping');
  } else {
    if (!_hasSafePrototype(parsed.classifier)) _push(errors, 'classifier', 'unsafe_mapping_prototype');
    _validateUnknownKeys(errors, parsed.classifier, CLASSIFIER_KEYS, 'classifier');
    if (parsed.classifier.artifact_cid == null) {
      _push(errors, 'classifier.artifact_cid', 'required');
    } else {
      _validateCid(errors, 'classifier.artifact_cid', parsed.classifier.artifact_cid);
    }
    if (parsed.classifier.version != null && typeof parsed.classifier.version !== 'string') {
      _push(errors, 'classifier.version', 'must_be_string');
    } else if (typeof parsed.classifier.version === 'string' && parsed.classifier.version.length > 64) {
      _push(errors, 'classifier.version', 'too_long');
    }
  }
  // routes: required mapping of label -> target.
  if (parsed.routes == null) {
    _push(errors, 'routes', 'required');
  } else if (typeof parsed.routes !== 'object' || Array.isArray(parsed.routes)) {
    _push(errors, 'routes', 'must_be_mapping');
  } else {
    if (!_hasSafePrototype(parsed.routes)) _push(errors, 'routes', 'unsafe_mapping_prototype');
    const labels = Object.keys(parsed.routes);
    if (labels.length === 0) {
      _push(errors, 'routes', 'must_be_non_empty');
    }
    if (labels.length > PIPELINE_YAML_LIMITS.max_routes) {
      _push(errors, 'routes', 'too_many');
    }
    for (const label of labels) {
      const base = `routes.${label}`;
      _validateRouteLabel(errors, label);
      const target = parsed.routes[label];
      if (target === null || typeof target !== 'object' || Array.isArray(target)) {
        _push(errors, base, 'must_be_mapping');
        continue;
      }
      if (!_hasSafePrototype(target)) _push(errors, base, 'unsafe_mapping_prototype');
      _validateUnknownKeys(errors, target, ROUTE_TARGET_KEYS, base);
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
        _validateCid(errors, `${base}.artifact_cid`, target.artifact_cid);
      }
      if (hasTeacher) {
        _validateTeacher(errors, `${base}.teacher`, target.teacher);
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
  const classifierCid = parsed && parsed.classifier ? _normaliseCid(parsed.classifier.artifact_cid) : null;
  if (classifierCid) {
    out.push(classifierCid);
  }
  if (parsed && parsed.routes && typeof parsed.routes === 'object') {
    for (const label of Object.keys(parsed.routes).slice(0, PIPELINE_YAML_LIMITS.max_routes)) {
      if (_isReservedKey(label) || !SAFE_ROUTE_LABEL_RE.test(label)) continue;
      const t = parsed.routes[label];
      const routeCid = t && _normaliseCid(t.artifact_cid);
      if (routeCid) out.push(routeCid);
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
