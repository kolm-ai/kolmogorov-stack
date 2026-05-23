// W732 — kolm.yaml schema + parser + repo walker.
//
// Purpose
// -------
// W732 ("Git-Integrated kolm.yaml + GHA") gives teams a single declarative
// file at the repo root that pins the inputs to the W720 distill loop:
//
//   - which namespaces to distill (one capture store per namespace)
//   - which teacher model owns each namespace
//   - which quality gates a freshly compiled .kolm artifact must clear
//
// The .github/workflows/kolm-distill.yml template reads this file on every
// push to main, re-evaluates K-Score, and re-distills when a gate fails.
// `kolm yaml init|validate` exposes the parser locally; POST /v1/yaml/validate
// exposes it over the auth-gated API for CI providers that prefer to call
// kolm.ai instead of bundling Node.
//
// Why hand-rolled
// ---------------
// package.json deps must stay clean (audit cadence, supply-chain surface).
// We support the smallest YAML subset that satisfies the W732 schema:
//
//   * Top-level scalars      (`version: w732-v1`)
//   * Top-level mappings     (`quality_gates:` + indented children)
//   * Lists of scalars       (`- foo`)
//   * Lists of mappings      (`- name: ns1` + indented siblings)
//   * Nested mappings        (mapping value → indented mapping)
//   * `#` comments and blank lines
//   * Quoted strings ('...' and "...")
//   * Booleans (true/false), null, numbers (int+float), strings
//
// We do NOT support: flow-style ({a:b}), anchors/aliases (&/*), tags (!!),
// block scalars (|/>), multi-doc separators (---/...). If a future kolm.yaml
// needs any of those we add them deliberately; for now they throw a snake_case
// error so users see "unsupported_yaml_feature" instead of silent misparse.
//
// Honesty contract
// ----------------
// Every parse failure throws an Error whose `.code` is a snake_case token
// (e.g. `'yaml_parse_failed'`, `'unsupported_yaml_feature'`,
// `'inconsistent_indent'`) and `.line` is the 1-based source line. The
// HTTP wrapper at POST /v1/yaml/validate returns these verbatim so callers
// can program against them.
//
// findKolmYamlInRepo
// ------------------
// Mirrors git's .gitignore walk: start at `startDir`, return the first
// kolm.yaml found on the way up to the filesystem root. Returns null when
// no file exists (callers branch on null to honest `kolm_yaml_not_found`).

import fs from 'node:fs';
import path from 'node:path';

export const KOLM_YAML_VERSION = 'w732-v1';

// =============================================================================
// Tokenizer
// =============================================================================
//
// First pass: split source into trimmed-right lines, drop full-line `#`
// comments + blank lines, compute leading-indent (spaces only; tabs throw
// `tab_indentation_unsupported` because mixing tabs with the column-counted
// nested mapping logic loses precision). Returns an array of
// { raw, indent, content, lineno } records the second pass consumes.

function tokenize(yamlText) {
  const out = [];
  const lines = String(yamlText).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineno = i + 1;
    // Strip trailing whitespace; lets us treat trailing-blank and pure-blank
    // lines uniformly.
    const trimmed = raw.replace(/\s+$/, '');
    if (trimmed === '') continue;
    // Full-line comments: leading whitespace + #. Don't strip inline `#`
    // comments — values like URLs / hashes may contain them. The W732 schema
    // doesn't need inline-comment support today.
    const noLead = trimmed.replace(/^\s+/, '');
    if (noLead.startsWith('#')) continue;
    // Tab in leading whitespace is a hard fail — column math below assumes
    // single-character indents and silently misnesting a config is a worse UX
    // than a loud error.
    const leading = trimmed.slice(0, trimmed.length - noLead.length);
    if (leading.indexOf('\t') !== -1) {
      const err = new Error('tab characters in indentation are not supported; use spaces');
      err.code = 'tab_indentation_unsupported';
      err.line = lineno;
      throw err;
    }
    out.push({ raw: trimmed, indent: leading.length, content: noLead, lineno });
  }
  return out;
}

// =============================================================================
// Scalar coercion
// =============================================================================
//
// Honest-narrow set: only coerce the literal forms the W732 schema actually
// uses. Strings come in unquoted or quoted (single/double). Numbers/booleans/
// null follow the YAML 1.2 core schema, MINUS the legacy y/yes/n/no aliases
// (those have caused too many real-world bugs in other tools).

function coerceScalar(raw) {
  const s = String(raw);
  if (s.length === 0) return null;
  // Quoted strings: strip the quote pair, do NOT interpret escape sequences
  // (no \n / \t handling). The W732 schema has no string that needs escapes.
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  // Integer / float — strict regex so version strings like `w732-v1` stay
  // as strings (would otherwise look like leading-int + suffix).
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// =============================================================================
// Recursive-descent parser
// =============================================================================
//
// State machine reads tokens at a fixed `indent` column and recurses into
// children whose indent is strictly greater. We never look up — once the
// caller hands us a slice, we own [start..end) and stop the moment we see
// a row whose indent is < ours (returning that row's index to the caller).
//
// `parseBlock(tokens, start, indent)` parses a mapping or a list starting at
// `start`, and returns `[value, nextIndex]` so the caller can continue.

function parseBlock(tokens, start, indent) {
  if (start >= tokens.length) return [null, start];
  const head = tokens[start];
  if (head.indent !== indent) {
    const err = new Error(`expected indent ${indent} but got ${head.indent}`);
    err.code = 'inconsistent_indent';
    err.line = head.lineno;
    throw err;
  }
  // List rows start with `- `. A list of mappings starts with `- key: value`.
  if (head.content.startsWith('- ') || head.content === '-') {
    return parseList(tokens, start, indent);
  }
  return parseMapping(tokens, start, indent);
}

function parseMapping(tokens, start, indent) {
  const out = {};
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.indent < indent) break;
    if (t.indent > indent) {
      const err = new Error(`unexpected child indent ${t.indent} at sibling indent ${indent}`);
      err.code = 'inconsistent_indent';
      err.line = t.lineno;
      throw err;
    }
    const m = t.content.match(/^([^:]+?)\s*:(?:\s+(.*))?$/);
    if (!m) {
      const err = new Error(`mapping row missing ":" separator: ${t.content}`);
      err.code = 'yaml_parse_failed';
      err.line = t.lineno;
      throw err;
    }
    const key = m[1].trim();
    const valueRaw = (m[2] === undefined) ? '' : m[2].trim();
    if (valueRaw === '') {
      // Inline value empty → look at the next token. If its indent is greater,
      // recurse; else this mapping key has value null.
      if (i + 1 < tokens.length && tokens[i + 1].indent > indent) {
        const childIndent = tokens[i + 1].indent;
        const [childVal, nextI] = parseBlock(tokens, i + 1, childIndent);
        out[key] = childVal;
        i = nextI;
        continue;
      }
      out[key] = null;
      i++;
      continue;
    }
    out[key] = coerceScalar(valueRaw);
    i++;
  }
  return [out, i];
}

function parseList(tokens, start, indent) {
  const out = [];
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.indent < indent) break;
    if (t.indent > indent) {
      const err = new Error(`unexpected child indent ${t.indent} in list at indent ${indent}`);
      err.code = 'inconsistent_indent';
      err.line = t.lineno;
      throw err;
    }
    if (!(t.content.startsWith('- ') || t.content === '-')) break;
    const item = t.content === '-' ? '' : t.content.slice(2);
    if (item === '') {
      // Bare `-` with nothing on the row → child block on the next indent.
      if (i + 1 < tokens.length && tokens[i + 1].indent > indent) {
        const childIndent = tokens[i + 1].indent;
        const [childVal, nextI] = parseBlock(tokens, i + 1, childIndent);
        out.push(childVal);
        i = nextI;
        continue;
      }
      out.push(null);
      i++;
      continue;
    }
    // Mapping-on-same-line case: `- name: support-bot`. We synthesize an
    // anchor token at column `indent + 2` so parseMapping can pick up
    // siblings indented two columns past the `-`.
    const mappingMatch = item.match(/^([^:]+?)\s*:(?:\s+(.*))?$/);
    if (mappingMatch) {
      const synth = {
        raw: item,
        indent: indent + 2,
        content: item,
        lineno: t.lineno,
      };
      const synthetic = [synth];
      // Splice in the synthesized row, then any continuation rows whose
      // indent is >= indent + 2 (children of this list-item-mapping).
      let j = i + 1;
      while (j < tokens.length && tokens[j].indent > indent) {
        synthetic.push(tokens[j]);
        j++;
      }
      const [childVal, _consumed] = parseMapping(synthetic, 0, indent + 2);
      out.push(childVal);
      i = j;
      continue;
    }
    // Plain scalar list item.
    out.push(coerceScalar(item));
    i++;
  }
  return [out, i];
}

export function parseKolmYaml(yamlText) {
  if (typeof yamlText !== 'string') {
    const err = new Error('parseKolmYaml requires a string input');
    err.code = 'yaml_input_not_string';
    err.line = 0;
    throw err;
  }
  const tokens = tokenize(yamlText);
  if (tokens.length === 0) {
    // Honest empty-input envelope — caller decides if that's valid.
    return { __empty: true };
  }
  // Top-level indent is whatever the first row has. The spec requires 0 for
  // standard documents; we tolerate any consistent leading width so
  // copy-pasted snippets with leading spaces don't fail spuriously.
  const topIndent = tokens[0].indent;
  const [value, consumed] = parseBlock(tokens, 0, topIndent);
  if (consumed < tokens.length) {
    const t = tokens[consumed];
    const err = new Error(`trailing token at line ${t.lineno} not consumed by top-level block`);
    err.code = 'yaml_parse_failed';
    err.line = t.lineno;
    throw err;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && value.__empty) {
    return {};
  }
  return value;
}

// =============================================================================
// Schema validator
// =============================================================================
//
// Reports EVERY error (not just the first) so a CI run shows the full repair
// list to the operator. Path format mirrors jq: `namespaces[0].name`,
// `quality_gates.min_kscore`, etc.

function _push(errs, p, code) { errs.push({ path: p, error: code }); }

export function validateKolmYaml(parsed) {
  const errors = [];
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: [{ path: '', error: 'root_must_be_mapping' }] };
  }
  // version: required, must equal KOLM_YAML_VERSION ("w732-v1").
  if (!('version' in parsed)) {
    _push(errors, 'version', 'required');
  } else if (typeof parsed.version !== 'string') {
    _push(errors, 'version', 'must_be_string');
  } else if (parsed.version !== KOLM_YAML_VERSION) {
    _push(errors, 'version', 'must_equal_' + KOLM_YAML_VERSION);
  }
  // namespaces: required array, each entry is { name, teacher, min_captures }.
  if (!('namespaces' in parsed)) {
    _push(errors, 'namespaces', 'required');
  } else if (!Array.isArray(parsed.namespaces)) {
    _push(errors, 'namespaces', 'must_be_list');
  } else if (parsed.namespaces.length === 0) {
    _push(errors, 'namespaces', 'must_be_non_empty');
  } else {
    for (let idx = 0; idx < parsed.namespaces.length; idx++) {
      const ns = parsed.namespaces[idx];
      const base = `namespaces[${idx}]`;
      if (ns === null || typeof ns !== 'object' || Array.isArray(ns)) {
        _push(errors, base, 'must_be_mapping');
        continue;
      }
      if (!('name' in ns)) _push(errors, `${base}.name`, 'required');
      else if (typeof ns.name !== 'string') _push(errors, `${base}.name`, 'must_be_string');
      else if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(ns.name)) _push(errors, `${base}.name`, 'must_match_namespace_pattern');
      if (!('teacher' in ns)) _push(errors, `${base}.teacher`, 'required');
      else if (typeof ns.teacher !== 'string') _push(errors, `${base}.teacher`, 'must_be_string');
      if ('min_captures' in ns) {
        if (typeof ns.min_captures !== 'number') _push(errors, `${base}.min_captures`, 'must_be_number');
        else if (!Number.isInteger(ns.min_captures)) _push(errors, `${base}.min_captures`, 'must_be_integer');
        else if (ns.min_captures < 0) _push(errors, `${base}.min_captures`, 'must_be_non_negative');
      }
    }
  }
  // quality_gates: optional, but if present each known key has a typed shape.
  if ('quality_gates' in parsed && parsed.quality_gates !== null) {
    const qg = parsed.quality_gates;
    if (typeof qg !== 'object' || Array.isArray(qg)) {
      _push(errors, 'quality_gates', 'must_be_mapping');
    } else {
      if ('min_kscore' in qg) {
        if (typeof qg.min_kscore !== 'number') _push(errors, 'quality_gates.min_kscore', 'must_be_number');
        else if (qg.min_kscore < 0 || qg.min_kscore > 1) _push(errors, 'quality_gates.min_kscore', 'must_be_between_0_and_1');
      }
      if ('max_cost_per_call_usd' in qg) {
        if (typeof qg.max_cost_per_call_usd !== 'number') _push(errors, 'quality_gates.max_cost_per_call_usd', 'must_be_number');
        else if (qg.max_cost_per_call_usd < 0) _push(errors, 'quality_gates.max_cost_per_call_usd', 'must_be_non_negative');
      }
      if ('block_on_regression' in qg) {
        if (typeof qg.block_on_regression !== 'boolean') _push(errors, 'quality_gates.block_on_regression', 'must_be_boolean');
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// =============================================================================
// Repo walker — find the nearest kolm.yaml
// =============================================================================
//
// Same algorithm as git's .gitignore / .git directory discovery: start at
// `startDir`, walk up one directory at a time, return the first existing
// kolm.yaml. Returns null when the walk reaches the filesystem root without
// finding one. Symlinks are followed via fs.statSync since path.resolve
// already canonicalizes "../" segments.

export function findKolmYamlInRepo(startDir) {
  let dir = path.resolve(String(startDir || process.cwd()));
  // path.parse(dir).root is the platform root: '/' on POSIX, 'C:\\' on win32.
  // The loop terminates when dir === parent (true at the FS root).
  for (;;) {
    const candidate = path.join(dir, 'kolm.yaml');
    try {
      const st = fs.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch (_) { /* not present at this level — keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// =============================================================================
// Starter file emitter (for `kolm yaml init`)
// =============================================================================
//
// Returns a hand-tuned starter the CLI writes to cwd. Kept in this module
// (not in cli/kolm.js) so the GitHub Action template can emit the same
// content via `node -e "require('./src/kolm-yaml.js').starterYaml(...)"`
// if it ever wants to scaffold the file from CI.

export function starterKolmYaml() {
  return [
    '# kolm.yaml — declarative input to the kolm distill loop.',
    '# Schema: ' + KOLM_YAML_VERSION + '. Run `kolm yaml validate` to lint.',
    'version: ' + KOLM_YAML_VERSION,
    '',
    'namespaces:',
    '  - name: support-bot',
    '    teacher: claude-sonnet-4-6',
    '    min_captures: 1000',
    '',
    'quality_gates:',
    '  min_kscore: 0.85',
    '  max_cost_per_call_usd: 0.001',
    '  block_on_regression: true',
    '',
  ].join('\n');
}
