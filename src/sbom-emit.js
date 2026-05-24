// W763 — SBOM emission + verification (pure JS, no heavy deps).
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 569-574):
//   [W763-1] "SBOM for every .kolm artifact and every kolm release"
//   [W763-2] "Pin all dependency versions with hash verification"
//   [W763-3] "Snyk/Dependabot on every release"
//   [W763-4] /security/sbom.html published
//
// Why: a signed .kolm receipt proves the artifact's bytes are what was
// minted, but it tells you nothing about WHAT WAS IN THE BUILD CHAIN.
// A compromised dependency in the build pipeline produces a perfectly
// valid signature on a tainted artifact. SBOMs (CycloneDX + SPDX) emit
// the full dep graph + integrity hashes alongside the artifact so an
// auditor can verify the supply chain matches a known-good snapshot.
//
// Design contract:
//   - PURE shape utilities — NO disk IO that touches the artifact, NO
//     mutation of package-lock.json, NO modification of artifact.js
//     (the SBOM is a SIBLING export, not woven into artifact-hash).
//   - TWO formats: CycloneDX 1.5 + SPDX 2.3. Both are JSON-shape only;
//     XML and tag-value variants are out of scope for W763.
//   - HONEST envelopes everywhere: empty deps → ok:true + component_count:0
//     (no silent fabrication); missing input → ok:false + structured error.
//   - W604 ANTI-BRITTLE: version stamp matches /^w763-/ — callers MUST
//     regex-match, not literal-compare.
//   - DO NOT EDIT package-lock.json — pinning every transitive dep is a
//     sustained audit, not a one-shot ship. We DOCUMENT the recommendation
//     in /security/sbom.html and EMIT SBOMs that surface what's pinned vs not.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SBOM_VERSION = 'w763-v1';
export const SBOM_FORMATS = Object.freeze(['cyclonedx-json', 'spdx-json']);

// CycloneDX spec version we emit. 1.5 is the most-widely-tooled stable
// release as of 2026-05; bump only with a coordinated test-rev.
const CYCLONEDX_SPEC = '1.5';
// SPDX spec version we emit. 2.3 mirrors the SPDX-License-List/PEP-639 line.
const SPDX_VERSION = 'SPDX-2.3';

// Schema URLs are informational only — we DO NOT fetch them at runtime
// (offline-friendly contract). Callers can pin against them downstream.
const CYCLONEDX_SCHEMA_URL = 'http://cyclonedx.org/schema/bom-1.5.schema.json';
const SPDX_SCHEMA_URL = 'https://spdx.github.io/spdx-spec/v2.3/';

// =============================================================================
// Internal: normalize an integrity string into a {alg, hex} pair.
//   - npm package-lock integrity strings are of shape "sha512-<b64>".
//   - We convert to the CycloneDX hash shape {alg:'SHA-512', content:<hex>}.
//   - On parse failure we emit {alg:'SHA-512', content:'unknown'} rather
//     than throwing — never crash the SBOM emit over one bad row.
// =============================================================================
function _normalizeIntegrity(integrity) {
  if (typeof integrity !== 'string' || !integrity.includes('-')) return null;
  const [alg, b64] = integrity.split('-', 2);
  const algNorm = String(alg || '').toUpperCase().replace(/^SHA/, 'SHA-');
  let hex;
  try {
    hex = Buffer.from(b64, 'base64').toString('hex');
  } catch (_) {
    hex = 'unknown';
  }
  return { alg: algNorm, content: hex };
}

// =============================================================================
// Internal: emit a CycloneDX 1.5 JSON document from a normalized component list.
//
// CycloneDX 1.5 minimum required fields:
//   - bomFormat: "CycloneDX"
//   - specVersion: "1.5"
//   - version: integer (the BOM revision, not the package version)
//   - components: array of {type, name, version}
//
// Hashes are an optional but strongly-recommended field that auditors look
// for; we always emit them when integrity strings are available.
// =============================================================================
function _emitCycloneDX(components, opts) {
  const serial = (opts && opts.serial) || ('urn:uuid:' + crypto.randomUUID());
  return {
    bomFormat: 'CycloneDX',
    specVersion: CYCLONEDX_SPEC,
    serialNumber: serial,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [
        { vendor: 'kolm.ai', name: 'kolm-sbom-emit', version: SBOM_VERSION },
      ],
      component: opts && opts.root_component
        ? opts.root_component
        : { type: 'application', name: 'kolm-stack', version: SBOM_VERSION },
    },
    components,
    _schema_url: CYCLONEDX_SCHEMA_URL,
  };
}

// =============================================================================
// Internal: emit an SPDX 2.3 JSON document from a normalized component list.
//
// SPDX 2.3 minimum required fields:
//   - spdxVersion: "SPDX-2.3"
//   - dataLicense: "CC0-1.0"  (spec mandates this exact string)
//   - SPDXID: "SPDXRef-DOCUMENT"
//   - name: document title
//   - documentNamespace: unique URI
//   - creationInfo: { created, creators }
//   - packages: array of {SPDXID, name, downloadLocation}
//
// We populate checksums and packageVersion when known; NOASSERTION when not
// (the SPDX-canonical honest sentinel — never invent a value).
// =============================================================================
function _emitSPDX(components, opts) {
  const docName = (opts && opts.doc_name) || 'kolm-stack-sbom';
  const docNs = (opts && opts.doc_namespace)
    || 'https://kolm.ai/sbom/' + crypto.randomUUID();
  const packages = components.map((c, i) => {
    const pkg = {
      SPDXID: 'SPDXRef-Package-' + i,
      name: c.name,
      versionInfo: c.version || 'NOASSERTION',
      downloadLocation: c.purl ? c.purl : 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: c.licenses && c.licenses[0]
        ? (c.licenses[0].license && c.licenses[0].license.id) || 'NOASSERTION'
        : 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    };
    if (Array.isArray(c.hashes) && c.hashes.length > 0) {
      pkg.checksums = c.hashes.map((h) => ({
        algorithm: String(h.alg || '').replace(/-/g, ''),
        checksumValue: h.content,
      }));
    }
    return pkg;
  });
  return {
    spdxVersion: SPDX_VERSION,
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: docName,
    documentNamespace: docNs,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ['Tool: kolm-sbom-emit-' + SBOM_VERSION],
    },
    packages,
    _schema_url: SPDX_SCHEMA_URL,
  };
}

// =============================================================================
// Internal: build a normalized component list from a package-lock.json object.
//
// package-lock.json v3 layout:
//   packages: { "": {root}, "node_modules/foo": {version, integrity, ...}, ... }
//
// We skip the root entry "" and any optional-dep entries that have no
// version (npm marks those as `{}` placeholders for hoisted-but-unused deps).
// =============================================================================
function _componentsFromLock(lock) {
  if (!lock || typeof lock !== 'object' || !lock.packages) return [];
  const out = [];
  for (const [pkgPath, meta] of Object.entries(lock.packages)) {
    if (!pkgPath) continue; // skip root
    if (!meta || typeof meta !== 'object') continue;
    if (!meta.version) continue; // skip placeholders
    // Derive npm-style package name from path.
    // node_modules/@scope/name → @scope/name
    // node_modules/foo/node_modules/bar → bar (nested, hoist-aware)
    const segments = pkgPath.split('node_modules/').filter(Boolean);
    const last = segments[segments.length - 1] || '';
    let name = last;
    if (!name.startsWith('@') && name.includes('/')) {
      name = name.split('/')[0];
    }
    if (!name) continue;
    const hash = _normalizeIntegrity(meta.integrity);
    const component = {
      type: 'library',
      'bom-ref': 'pkg:npm/' + encodeURIComponent(name) + '@' + meta.version,
      name,
      version: meta.version,
      purl: 'pkg:npm/' + encodeURIComponent(name) + '@' + meta.version,
      scope: meta.dev ? 'optional' : 'required',
    };
    if (hash) component.hashes = [hash];
    if (meta.license) {
      component.licenses = [{ license: { id: String(meta.license) } }];
    }
    out.push(component);
  }
  return out;
}

// =============================================================================
// Internal: build a normalized component list from a kolm manifest object.
//
// A kolm manifest may carry dependency declarations in any of:
//   manifest.deps          → array of {name, version, hash?}
//   manifest.dependencies  → object {name: version}
//   manifest.bom           → pre-shaped array of {name, version, hash?}
//
// We accept all three to match historical artifact-shape variation. Missing
// dep block → empty components list (NOT an error — many recipe-tier
// artifacts genuinely have no runtime deps).
// =============================================================================
function _componentsFromManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  const out = [];
  const seen = new Set();
  function _push(name, version, hash, ecosystem) {
    if (!name || typeof name !== 'string') return;
    const key = name + '@' + (version || 'unknown');
    if (seen.has(key)) return;
    seen.add(key);
    const eco = ecosystem || 'npm';
    const c = {
      type: 'library',
      'bom-ref': 'pkg:' + eco + '/' + encodeURIComponent(name) + '@' + (version || 'unknown'),
      name,
      version: version || 'unknown',
      purl: 'pkg:' + eco + '/' + encodeURIComponent(name) + '@' + (version || 'unknown'),
    };
    if (typeof hash === 'string' && hash.length > 0) {
      // Manifest hashes might be raw hex or sha-prefixed. Normalize.
      let alg = 'SHA-256';
      let content = hash;
      if (hash.includes('-')) {
        const [a, h] = hash.split('-', 2);
        alg = String(a || '').toUpperCase().replace(/^SHA/, 'SHA-');
        try {
          content = Buffer.from(h, 'base64').toString('hex');
        } catch (_) { content = h || 'unknown'; }
      }
      c.hashes = [{ alg, content }];
    }
    out.push(c);
  }
  if (Array.isArray(manifest.deps)) {
    for (const d of manifest.deps) _push(d && d.name, d && d.version, d && d.hash, d && d.ecosystem);
  }
  if (Array.isArray(manifest.bom)) {
    for (const d of manifest.bom) _push(d && d.name, d && d.version, d && d.hash, d && d.ecosystem);
  }
  if (manifest.dependencies && typeof manifest.dependencies === 'object'
      && !Array.isArray(manifest.dependencies)) {
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      _push(name, typeof version === 'string' ? version : null, null, 'npm');
    }
  }
  return out;
}

// =============================================================================
// Internal: parse a requirements.txt file and return components.
//
// We accept pip's "hash pinning" form:
//   pkg==1.2.3 --hash=sha256:<hex>
//   pkg==1.2.3 \
//       --hash=sha256:<hex> \
//       --hash=sha256:<hex>
//
// Lines without hash pinning are still included but flagged with
// no_hash=true so the caller can surface the audit gap honestly.
// =============================================================================
function _componentsFromRequirements(text) {
  if (typeof text !== 'string') return { components: [], hashed_count: 0, unhashed_count: 0 };
  // Normalize line continuations.
  const flat = text.replace(/\\\s*\n/g, ' ');
  const lines = flat.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const out = [];
  let hashed = 0;
  let unhashed = 0;
  for (const line of lines) {
    // Strip inline pip flags like --index-url, --extra-index-url.
    if (line.startsWith('-')) continue;
    // Match "pkg==1.2.3"  OR  "pkg>=1.2.3"  OR  "pkg"
    const m = line.match(/^([A-Za-z0-9_.\-\[\]]+)\s*(==|>=|<=|~=|!=)?\s*([^\s;]+)?/);
    if (!m) continue;
    const name = m[1];
    const version = m[3] || null;
    // Pull hashes (zero or more).
    const hashes = [];
    const hashRe = /--hash=([a-z0-9]+):([a-fA-F0-9]+)/g;
    let hm;
    while ((hm = hashRe.exec(line)) !== null) {
      hashes.push({ alg: String(hm[1]).toUpperCase().replace(/^SHA/, 'SHA-'), content: hm[2] });
    }
    const c = {
      type: 'library',
      'bom-ref': 'pkg:pypi/' + encodeURIComponent(name) + '@' + (version || 'unknown'),
      name,
      version: version || 'unknown',
      purl: 'pkg:pypi/' + encodeURIComponent(name) + '@' + (version || 'unknown'),
    };
    if (hashes.length > 0) {
      c.hashes = hashes;
      hashed++;
    } else {
      c.properties = [{ name: 'kolm:no_hash', value: 'true' }];
      unhashed++;
    }
    out.push(c);
  }
  return { components: out, hashed_count: hashed, unhashed_count: unhashed };
}

// =============================================================================
// PUBLIC: emitSbomFromManifest({manifest, format})
//
// Manifest can be either an object or a string path to a JSON file. We do
// the path-read here (NOT inside artifact.js — keeps SBOM as a sibling
// export) and emit the requested shape.
// =============================================================================
export function emitSbomFromManifest(opts) {
  const o = opts || {};
  const format = o.format || 'cyclonedx-json';
  if (!SBOM_FORMATS.includes(format)) {
    return {
      ok: false,
      error: 'unsupported_format',
      hint: 'format must be one of ' + JSON.stringify(SBOM_FORMATS),
      version: SBOM_VERSION,
    };
  }
  let manifest = o.manifest;
  if (typeof manifest === 'string') {
    let raw;
    try { raw = fs.readFileSync(manifest, 'utf8'); }
    catch (e) {
      return {
        ok: false,
        error: 'manifest_read_failed',
        detail: e && e.message,
        version: SBOM_VERSION,
      };
    }
    try { manifest = JSON.parse(raw); }
    catch (e) {
      return {
        ok: false,
        error: 'manifest_parse_failed',
        detail: e && e.message,
        version: SBOM_VERSION,
      };
    }
  }
  if (!manifest || typeof manifest !== 'object') {
    return {
      ok: false,
      error: 'manifest_required',
      hint: 'pass a manifest object or a path to manifest.json',
      version: SBOM_VERSION,
    };
  }
  const components = _componentsFromManifest(manifest);
  let sbom;
  if (format === 'cyclonedx-json') {
    sbom = _emitCycloneDX(components, {
      root_component: {
        type: 'application',
        name: manifest.name || manifest.job_id || 'kolm-artifact',
        version: manifest.version || manifest.spec_hash || SBOM_VERSION,
      },
    });
  } else {
    sbom = _emitSPDX(components, {
      doc_name: manifest.name || manifest.job_id || 'kolm-artifact-sbom',
    });
  }
  return {
    ok: true,
    version: SBOM_VERSION,
    format,
    sbom,
    component_count: components.length,
    source: 'manifest',
  };
}

// =============================================================================
// PUBLIC: emitSbomFromPackageLock({lock_path, format})
//
// Reads a package-lock.json file and emits an SBOM. Tenant-agnostic — this
// is meta-information about the kolm install itself, not about any
// tenant's compiled artifact.
// =============================================================================
export function emitSbomFromPackageLock(opts) {
  const o = opts || {};
  const format = o.format || 'cyclonedx-json';
  if (!SBOM_FORMATS.includes(format)) {
    return {
      ok: false,
      error: 'unsupported_format',
      hint: 'format must be one of ' + JSON.stringify(SBOM_FORMATS),
      version: SBOM_VERSION,
    };
  }
  let lockPath = o.lock_path;
  if (!lockPath || typeof lockPath !== 'string') {
    return {
      ok: false,
      error: 'lock_path_required',
      hint: 'pass {lock_path: "/abs/path/to/package-lock.json"}',
      version: SBOM_VERSION,
    };
  }
  let raw;
  try { raw = fs.readFileSync(lockPath, 'utf8'); }
  catch (e) {
    return {
      ok: false,
      error: 'lock_read_failed',
      detail: e && e.message,
      version: SBOM_VERSION,
    };
  }
  let lock;
  try { lock = JSON.parse(raw); }
  catch (e) {
    return {
      ok: false,
      error: 'lock_parse_failed',
      detail: e && e.message,
      version: SBOM_VERSION,
    };
  }
  const components = _componentsFromLock(lock);
  let sbom;
  if (format === 'cyclonedx-json') {
    sbom = _emitCycloneDX(components, {
      root_component: {
        type: 'application',
        name: lock.name || 'kolm-stack',
        version: lock.version || SBOM_VERSION,
      },
    });
  } else {
    sbom = _emitSPDX(components, {
      doc_name: (lock.name || 'kolm-stack') + '-sbom',
    });
  }
  return {
    ok: true,
    version: SBOM_VERSION,
    format,
    sbom,
    component_count: components.length,
    source: 'package-lock.json',
    source_path: lockPath,
  };
}

// =============================================================================
// PUBLIC: emitSbomFromPython({requirements_txt_path, format})
//
// Reads a pip requirements.txt (hash-pinned or not) and emits an SBOM.
// HONEST envelope when no hash-pinned reqs: ok:true but the response
// surfaces `unhashed_count` so the caller knows the audit gap.
// =============================================================================
export function emitSbomFromPython(opts) {
  const o = opts || {};
  const format = o.format || 'cyclonedx-json';
  if (!SBOM_FORMATS.includes(format)) {
    return {
      ok: false,
      error: 'unsupported_format',
      hint: 'format must be one of ' + JSON.stringify(SBOM_FORMATS),
      version: SBOM_VERSION,
    };
  }
  const reqPath = o.requirements_txt_path;
  if (!reqPath || typeof reqPath !== 'string') {
    return {
      ok: false,
      error: 'requirements_txt_path_required',
      hint: 'pass {requirements_txt_path: "/abs/path/to/requirements.txt"}',
      version: SBOM_VERSION,
    };
  }
  let text;
  try { text = fs.readFileSync(reqPath, 'utf8'); }
  catch (e) {
    return {
      ok: false,
      error: 'requirements_read_failed',
      detail: e && e.message,
      version: SBOM_VERSION,
    };
  }
  const { components, hashed_count, unhashed_count } = _componentsFromRequirements(text);
  // Honest envelope on empty-reqs OR fully-unhashed-reqs.
  if (components.length === 0) {
    return {
      ok: true,
      version: SBOM_VERSION,
      format,
      sbom: null,
      component_count: 0,
      source: 'requirements.txt',
      source_path: reqPath,
      hashed_count: 0,
      unhashed_count: 0,
      note: 'no_components_parsed',
      hint: 'requirements.txt parsed to zero components — check the file for valid pip lines',
    };
  }
  if (hashed_count === 0) {
    // Still emit the SBOM but flag the audit gap clearly.
    let sbom;
    if (format === 'cyclonedx-json') {
      sbom = _emitCycloneDX(components, {});
    } else {
      sbom = _emitSPDX(components, { doc_name: 'kolm-python-deps' });
    }
    return {
      ok: true,
      version: SBOM_VERSION,
      format,
      sbom,
      component_count: components.length,
      source: 'requirements.txt',
      source_path: reqPath,
      hashed_count: 0,
      unhashed_count,
      note: 'no_hashed_requirements',
      hint: 'requirements.txt has NO --hash=sha256:... pins. Run pip-compile --generate-hashes to add them. SBOM emitted without integrity hashes.',
    };
  }
  let sbom;
  if (format === 'cyclonedx-json') {
    sbom = _emitCycloneDX(components, {
      root_component: { type: 'application', name: 'kolm-python-deps', version: SBOM_VERSION },
    });
  } else {
    sbom = _emitSPDX(components, { doc_name: 'kolm-python-deps' });
  }
  return {
    ok: true,
    version: SBOM_VERSION,
    format,
    sbom,
    component_count: components.length,
    source: 'requirements.txt',
    source_path: reqPath,
    hashed_count,
    unhashed_count,
  };
}

// =============================================================================
// PUBLIC: verifySbomShape(sbom_obj)
//
// Static structural validation. Returns {ok, valid, errors[]}.
//   ok:true means the call itself succeeded (input was an object).
//   valid:true means the SBOM passed all required-field checks.
//
// CycloneDX 1.5 required: bomFormat, specVersion, version, components.
// SPDX 2.3 required: spdxVersion, dataLicense, SPDXID, name,
//                    documentNamespace, creationInfo, packages.
// =============================================================================
export function verifySbomShape(sbom) {
  const errors = [];
  // Reject primitives (null, undefined, number, string, boolean) AND non-plain
  // containers (Array). An SBOM is canonically a plain JSON object — anything
  // else is a caller bug, not a malformed SBOM, so ok:false is the honest signal.
  if (
    sbom === null ||
    sbom === undefined ||
    typeof sbom !== 'object' ||
    Array.isArray(sbom)
  ) {
    return { ok: false, valid: false, errors: ['sbom_required'], version: SBOM_VERSION };
  }
  // Detect format from shape.
  if (sbom.bomFormat === 'CycloneDX' || sbom.specVersion) {
    if (sbom.bomFormat !== 'CycloneDX') errors.push('cyclonedx_missing_bomFormat');
    if (!sbom.specVersion) errors.push('cyclonedx_missing_specVersion');
    if (typeof sbom.version !== 'number') errors.push('cyclonedx_missing_version');
    if (!Array.isArray(sbom.components)) errors.push('cyclonedx_missing_components');
    return {
      ok: true,
      valid: errors.length === 0,
      format: 'cyclonedx-json',
      component_count: Array.isArray(sbom.components) ? sbom.components.length : 0,
      errors,
      version: SBOM_VERSION,
    };
  }
  if (sbom.spdxVersion || sbom.SPDXID) {
    if (!sbom.spdxVersion) errors.push('spdx_missing_spdxVersion');
    if (sbom.dataLicense !== 'CC0-1.0') errors.push('spdx_missing_or_invalid_dataLicense');
    if (sbom.SPDXID !== 'SPDXRef-DOCUMENT') errors.push('spdx_missing_or_invalid_SPDXID');
    if (!sbom.name) errors.push('spdx_missing_name');
    if (!sbom.documentNamespace) errors.push('spdx_missing_documentNamespace');
    if (!sbom.creationInfo || !sbom.creationInfo.created) errors.push('spdx_missing_creationInfo');
    if (!Array.isArray(sbom.packages)) errors.push('spdx_missing_packages');
    return {
      ok: true,
      valid: errors.length === 0,
      format: 'spdx-json',
      component_count: Array.isArray(sbom.packages) ? sbom.packages.length : 0,
      errors,
      version: SBOM_VERSION,
    };
  }
  return {
    ok: true,
    valid: false,
    format: 'unknown',
    component_count: 0,
    errors: ['unrecognized_sbom_shape'],
    version: SBOM_VERSION,
  };
}

// Default export for the rare consumer that wants the whole module by name.
export default {
  SBOM_VERSION,
  SBOM_FORMATS,
  emitSbomFromManifest,
  emitSbomFromPackageLock,
  emitSbomFromPython,
  verifySbomShape,
};
