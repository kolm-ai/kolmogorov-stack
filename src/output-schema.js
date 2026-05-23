// W809-1 — Structured output schema spec for .kolm artifacts.
//
// Defines the canonical shape of the `output_schema` block that flows into
// the .kolm manifest, plus a pure validator. NO ARTIFACT EDITS HERE — this
// module exports the schema contract + version constant + validator. The
// orchestrator owns the buildPayload integration (output_schema_hash chain
// slot via the W460 byte-stability pattern); this file is the source of
// truth for what a legal spec looks like.
//
// Canonical spec shape (the contract artifact.js will canonicalize):
//
//   {
//     kind:   'json' | 'xml' | 'grammar' | 'regex' | null,
//     schema: <inline-string-or-object> | { $ref: '<path>' } | null,
//     strict: boolean (default false),
//   }
//
// Rules:
//   * kind === null  → the artifact opts out of structured output; schema must
//     be null and strict must be false (or absent → treated as false). This
//     is the W460 "no profile" path: an `output_schema:null` spec MUST
//     canonicalize byte-identically to omitting the field entirely so legacy
//     pre-W809 artifacts do not drift their artifact_hash on rebuild.
//   * kind === 'json' → schema is either a JSON Schema object (draft-07 keys
//     respected at validate time) OR a `{$ref}` pointer to an external file.
//     A bare string is rejected — JSON kind requires structure.
//   * kind === 'xml' → schema is an XSD string OR `{$ref}`. We do not parse
//     XSD here; the runtime validator (workers/constrained or downstream)
//     does that. Spec-level check: schema is a non-empty string OR a $ref.
//   * kind === 'grammar' → schema is a GBNF/Lark grammar string OR `{$ref}`.
//     Same shape check as XML.
//   * kind === 'regex' → schema is a string the JS RegExp constructor accepts.
//     We try `new RegExp(schema)` and emit a typed error if it throws.
//   * strict → boolean; when true the runtime MUST reject any unparseable
//     output instead of falling back to text. Default false.
//
// W604 anti-brittleness: errors[] uses stable error codes (snake_case) so
// downstream tests assert on codes not free-form messages.

export const OUTPUT_SCHEMA_VERSION = 'w809-v1';

export const OUTPUT_SCHEMA_KINDS = Object.freeze([
  'json',
  'xml',
  'grammar',
  'regex',
]);

// The canonical "no schema" spec. canonicalizeOutputSchemaSpec collapses
// every "absence" representation (undefined, null, {}, {kind:null}, ...) to
// this single object so the orchestrator's hash chain stays byte-stable.
export const EMPTY_OUTPUT_SCHEMA_SPEC = Object.freeze({
  kind: null,
  schema: null,
  strict: false,
});

// ---------------------------------------------------------------------------
// validateOutputSchemaSpec
//
// Returns { ok:boolean, errors:string[] }.
//
// errors[] entries are stable snake_case codes prefixed with the field they
// flag, e.g. 'kind:unknown', 'schema:must_be_object_or_ref', 'regex:invalid'.
// Tests assert on substring match against the code, never the full message.
// ---------------------------------------------------------------------------
export function validateOutputSchemaSpec(spec) {
  const errors = [];

  // Absence is legal — treat as empty spec. The canonicalizer downstream
  // collapses absence to EMPTY_OUTPUT_SCHEMA_SPEC; here we just say OK.
  if (spec == null) {
    return { ok: true, errors: [] };
  }

  if (typeof spec !== 'object' || Array.isArray(spec)) {
    return {
      ok: false,
      errors: ['spec:must_be_object_or_null'],
    };
  }

  // Reject unknown top-level keys so a typo like `kind: 'json', shema: ...`
  // does not silently no-op. Only the three canonical keys are allowed.
  const allowed = new Set(['kind', 'schema', 'strict']);
  for (const k of Object.keys(spec)) {
    if (!allowed.has(k)) errors.push(`spec:unknown_key:${k}`);
  }

  // kind
  const kind = spec.kind;
  if (kind !== null && kind !== undefined && !OUTPUT_SCHEMA_KINDS.includes(kind)) {
    errors.push('kind:unknown');
  }

  // strict — boolean or absent. Reject everything else.
  if (spec.strict !== undefined && typeof spec.strict !== 'boolean') {
    errors.push('strict:must_be_boolean');
  }

  // Schema shape depends on kind.
  if (kind === null || kind === undefined) {
    // No-schema path: schema MUST be null/absent; strict MUST be false/absent.
    if (spec.schema !== null && spec.schema !== undefined) {
      errors.push('schema:must_be_null_when_kind_null');
    }
    if (spec.strict === true) {
      errors.push('strict:must_be_false_when_kind_null');
    }
  } else if (kind === 'json') {
    const s = spec.schema;
    if (s == null) {
      errors.push('schema:required_when_kind_set');
    } else if (typeof s === 'object' && !Array.isArray(s)) {
      // Either {$ref} pointer OR an inline JSON Schema object.
      if (typeof s.$ref === 'string') {
        if (!s.$ref.length) errors.push('schema:ref_empty');
      } else {
        // Inline JSON Schema. Surface a tiny sanity check: it must have a
        // `type` field OR `properties` OR `$schema` OR `oneOf`/`anyOf`/`allOf`.
        // Anything else is almost certainly a misuse.
        const hasShape =
          'type' in s
          || 'properties' in s
          || '$schema' in s
          || 'oneOf' in s
          || 'anyOf' in s
          || 'allOf' in s
          || 'enum' in s;
        if (!hasShape) errors.push('schema:json_schema_missing_shape');
      }
    } else {
      errors.push('schema:must_be_object_or_ref');
    }
  } else if (kind === 'xml' || kind === 'grammar') {
    const s = spec.schema;
    if (s == null) {
      errors.push('schema:required_when_kind_set');
    } else if (typeof s === 'string') {
      if (!s.length) errors.push('schema:empty_string');
    } else if (typeof s === 'object' && typeof s.$ref === 'string') {
      if (!s.$ref.length) errors.push('schema:ref_empty');
    } else {
      errors.push('schema:must_be_string_or_ref');
    }
  } else if (kind === 'regex') {
    const s = spec.schema;
    if (typeof s !== 'string') {
      errors.push('schema:regex_must_be_string');
    } else if (!s.length) {
      errors.push('schema:empty_string');
    } else {
      try {
        // eslint-disable-next-line no-new
        new RegExp(s);
      } catch (e) {
        errors.push('regex:invalid');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// canonicalizeOutputSchemaSpec
//
// Given any legal spec (including null/undefined/{}), returns a JSON object
// the orchestrator can hash. Returns `null` when the spec is the empty path
// so the W460 pattern in src/artifact.js can do:
//
//   const canon = canonicalizeOutputSchemaSpec(spec);
//   if (canon !== null) { /* bind into hash chain */ }
//
// — guaranteeing absence/null/{}/{kind:null} all share the artifact_hash of
// a pre-W809 artifact.
// ---------------------------------------------------------------------------
export function canonicalizeOutputSchemaSpec(spec) {
  if (spec == null) return null;
  if (typeof spec !== 'object' || Array.isArray(spec)) return null;
  const kind = spec.kind === undefined ? null : spec.kind;
  if (kind === null) return null;
  // For real kinds, emit the three canonical keys in fixed order so JSON
  // stringification is stable across hosts.
  return {
    kind,
    schema: spec.schema === undefined ? null : spec.schema,
    strict: spec.strict === true,
  };
}

// ---------------------------------------------------------------------------
// hashOutputSchemaSpec
//
// Returns a stable sha256 hex digest of the canonicalized spec, or null when
// the spec collapses to absent. The orchestrator uses this as
// `output_schema_hash` in the artifact hash chain.
// ---------------------------------------------------------------------------
export async function hashOutputSchemaSpec(spec) {
  const canon = canonicalizeOutputSchemaSpec(spec);
  if (canon === null) return null;
  // Stable stringify: walk the object, sort keys at every level. We can't
  // use JSON.stringify(obj, keysArray) because that whitelists keys instead
  // of ordering them, and we need recursion through nested schema objects.
  const ordered = _stableStringify(canon);
  const crypto = await import('node:crypto');
  return crypto.createHash('sha256').update(ordered).digest('hex');
}

function _stableStringify(v) {
  if (v === null || v === undefined) return JSON.stringify(v);
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '[' + v.map(_stableStringify).join(',') + ']';
  }
  const keys = Object.keys(v).sort();
  const parts = [];
  for (const k of keys) {
    if (v[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + _stableStringify(v[k]));
  }
  return '{' + parts.join(',') + '}';
}

// ---------------------------------------------------------------------------
// parseOutputAgainstSpec
//
// Runtime helper used by both the bakeoff parse-validation track and the
// auto-retry harness. Returns { ok:boolean, parsed:any|null, error:string|null }.
//
// Pure-JS, no external deps. JSON Schema constraint checking is intentionally
// shallow here — full JSON Schema validation is the constrained-decoder's
// job. Spec-level: we check (a) string parses to the declared kind and
// (b) regex matches the entire output when kind === 'regex'.
// ---------------------------------------------------------------------------
export function parseOutputAgainstSpec(output, spec) {
  const canon = canonicalizeOutputSchemaSpec(spec);
  if (canon === null) {
    // No schema → trivially OK (caller decides what to do with the text).
    return { ok: true, parsed: output, error: null };
  }
  const text = output == null ? '' : String(output);
  if (canon.kind === 'json') {
    try {
      const parsed = JSON.parse(text);
      // If schema is an inline JSON Schema object with a required `type`,
      // do a single-level type check. Deep validation belongs to the
      // constrained-decoder + downstream validator.
      const s = canon.schema;
      if (s && typeof s === 'object' && typeof s.type === 'string') {
        if (!matchesJsonSchemaType(parsed, s.type)) {
          return { ok: false, parsed: null, error: 'json_type_mismatch' };
        }
      }
      return { ok: true, parsed, error: null };
    } catch (e) {
      return { ok: false, parsed: null, error: 'json_parse_error' };
    }
  }
  if (canon.kind === 'regex') {
    try {
      const re = new RegExp('^(?:' + canon.schema + ')$');
      if (re.test(text)) {
        return { ok: true, parsed: text, error: null };
      }
      return { ok: false, parsed: null, error: 'regex_no_match' };
    } catch (e) {
      return { ok: false, parsed: null, error: 'regex_invalid' };
    }
  }
  if (canon.kind === 'xml') {
    // Spec-level: well-formedness probe — must start with '<' and end with
    // '>'. Deep XSD validation lives in the constrained decoder.
    if (text.trim().startsWith('<') && text.trim().endsWith('>')) {
      return { ok: true, parsed: text, error: null };
    }
    return { ok: false, parsed: null, error: 'xml_not_well_formed' };
  }
  if (canon.kind === 'grammar') {
    // No pure-JS GBNF parser here — the constrained decoder enforces
    // grammar-guided sampling at generate time. Spec-level: non-empty.
    if (text.length > 0) return { ok: true, parsed: text, error: null };
    return { ok: false, parsed: null, error: 'grammar_empty_output' };
  }
  return { ok: false, parsed: null, error: 'unknown_kind' };
}

function matchesJsonSchemaType(v, t) {
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'string') return typeof v === 'string';
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  if (t === 'boolean') return typeof v === 'boolean';
  if (t === 'null') return v === null;
  return false;
}

export default {
  OUTPUT_SCHEMA_VERSION,
  OUTPUT_SCHEMA_KINDS,
  EMPTY_OUTPUT_SCHEMA_SPEC,
  validateOutputSchemaSpec,
  canonicalizeOutputSchemaSpec,
  hashOutputSchemaSpec,
  parseOutputAgainstSpec,
};
