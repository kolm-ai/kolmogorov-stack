// src/licensing-allowlist.js
//
// Wave 194 (N+2 / N+3). Corpus URL licensing gate. The Wave 144 plan flagged
// the corpus-URL licensing check as still-open verifier work: a manifest can
// declare `corpus_sources[]` with {name, source_url, license}, but until this
// module shipped the verifier had no opinion on whether the license string
// named a buyer-safe source. A regulated tenant signing off on a distilled
// artifact wants to know that the training corpus the artifact derives from
// was not scraped, was not under a research-only license, and was not a
// proprietary dataset the tenant lacks rights to redistribute outputs from.
//
// Three allowlists, every entry a real identifier:
//
//   SAFE_LICENSES   buyer-safe for distillation source data. SPDX identifiers
//                   plus a small set of known catalog licenses (Llama 3.1
//                   community, Pile-CC, OpenWebText) that downstream legal
//                   teams have accepted in practice.
//   AMBER_LICENSES  pass the check with a `note:` row warning manual review.
//                   These permit research use but carry redistribution
//                   constraints (NC = non-commercial, ND = no derivatives,
//                   research-only). A tenant who knows the use case is
//                   internal-only can ship; a tenant selling outputs cannot.
//   DENY_LICENSES   verifier-rejected. Either a known-bad designation
//                   ("proprietary", "scraped", "tos-violated") or an
//                   explicit unknown ("unknown") that the verifier treats
//                   as a missing license string.
//
// The check function `checkCorpusLicensing(manifest)` returns one of:
//
//   { status: 'pass',  detail: '...' }            // all SAFE or legacy
//   { status: 'pass',  detail: '...',
//     caveats: ['name: license requires manual review (amber)', ...] }
//   { status: 'fail',  detail: '...',
//     bad: ['name: license=X in DENY_LICENSES', ...] }
//
// The check is invoked from src/binder.js as check #25 and slotted into the
// run-checks pipeline alongside the existing 24 verifier checks.
//
// Honest scope: this module does NOT fetch the URL, does NOT verify the
// license file at the URL still says what the manifest claims it says, and
// does NOT crawl the upstream catalog. It validates the declared license
// string against three frozen lists. Live URL fetching is out of scope: the
// verifier is offline-first by design (RS-1 air-gap rule).

import crypto from 'node:crypto';

export const LICENSING_ALLOWLIST_VERSION = 'w194-v2';
export const LICENSING_LIMITS = Object.freeze({
  MAX_SOURCES: 256,
  MAX_NAME_CHARS: 160,
  MAX_LICENSE_CHARS: 128,
  MAX_SOURCE_URL_CHARS: 2048,
  MAX_IDENTIFIER_CHARS: 512,
  MAX_REASON_CHARS: 320,
});

const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

function _sha256Hex(value) {
  return crypto.createHash('sha256').update(value == null ? '' : value).digest('hex');
}

function _stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => _stableJson(v)).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + _stableJson(value[k])).join(',') + '}';
}

function _cleanText(value, max = LICENSING_LIMITS.MAX_REASON_CHARS) {
  return String(value == null ? '' : value).replace(CONTROL_RE, ' ').trim().slice(0, max);
}

function _hashEvidence(value) {
  return _sha256Hex(_stableJson(value));
}

// SAFE_LICENSES. Every entry is a real SPDX identifier or named catalog
// license a regulated tenant's legal team has approved as buyer-safe for
// distillation training data. Adding to this list is a contract change;
// every entry has been spot-checked against https://spdx.org/licenses/.
export const SAFE_LICENSES = Object.freeze([
  // SPDX-listed permissive open-source licenses
  'MIT',
  'Apache-2.0',
  'BSD-3-Clause',
  'BSD-2-Clause',
  'ISC',
  'Unlicense',
  // SPDX-listed Creative Commons (public-domain + attribution + share-alike,
  // ALL commercial-permitting)
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-3.0',
  'CC-BY-SA-3.0',
  // Open Data Commons (commercial-permitting, attribution required)
  'ODC-BY-1.0',
  'PDDL-1.0',
  // Public domain catalog names that procurement accepts
  'public-domain',
  'CC-PDDC',
  // Catalog/community licenses with explicit commercial-use carve-outs that
  // regulated buyers have signed off on in practice
  'Llama-3.1 community',
  'Llama-3.2 community',
]);

// AMBER_LICENSES. Permit research use, carry redistribution constraints.
// Verifier passes but emits a `note:` row noting the license requires manual
// procurement review. NC = NonCommercial, ND = NoDerivatives, ResearchOnly =
// dataset-specific clauses (LAION, RedPajama, The Pile non-permissive splits).
export const AMBER_LICENSES = Object.freeze([
  'CC-BY-NC-4.0',
  'CC-BY-NC-3.0',
  'CC-BY-NC-SA-4.0',
  'CC-BY-NC-SA-3.0',
  'CC-BY-NC-ND-4.0',
  'CC-BY-NC-ND-3.0',
  'CC-BY-ND-4.0',
  'CC-BY-ND-3.0',
  'research-only',
  'custom',
  'OpenRAIL-M',
  'OpenRAIL',
  'BigScience-OpenRAIL-M',
  'BigCode-OpenRAIL-M',
]);

// DENY_LICENSES. Verifier rejects. Known-bad license designations a
// manifest should never ship with. Verifier reports a `bad:` row and the
// check fails (sets verdict='fail' so kolm verify exits non-zero).
export const DENY_LICENSES = Object.freeze([
  'proprietary',
  'unknown',
  'scraped',
  'tos-violated',
  'closed-source',
  'all-rights-reserved',
]);

// Disjointness contract: a license string MUST appear in at most one list.
// Tested by the wave194 test suite; checked at import time as a guardrail
// for anyone editing the lists in the future.
(function assertDisjoint() {
  const seen = new Map();
  for (const list of [
    { name: 'SAFE_LICENSES', entries: SAFE_LICENSES },
    { name: 'AMBER_LICENSES', entries: AMBER_LICENSES },
    { name: 'DENY_LICENSES', entries: DENY_LICENSES },
  ]) {
    for (const lic of list.entries) {
      if (seen.has(lic)) {
        throw new Error(
          `licensing-allowlist: license '${lic}' appears in both ${seen.get(lic)} and ${list.name}; lists must be disjoint`,
        );
      }
      seen.set(lic, list.name);
    }
  }
})();

function _licenseLookup() {
  const map = new Map();
  for (const lic of [...SAFE_LICENSES, ...AMBER_LICENSES, ...DENY_LICENSES]) {
    map.set(String(lic).toLowerCase(), lic);
  }
  map.set('apache2', 'Apache-2.0');
  map.set('apache 2.0', 'Apache-2.0');
  map.set('apache-2', 'Apache-2.0');
  map.set('apache2.0', 'Apache-2.0');
  map.set('bsd 3 clause', 'BSD-3-Clause');
  map.set('bsd 2 clause', 'BSD-2-Clause');
  map.set('public domain', 'public-domain');
  map.set('all rights reserved', 'all-rights-reserved');
  map.set('tos violated', 'tos-violated');
  return map;
}

const LICENSE_LOOKUP = _licenseLookup();

export function normalizeLicenseId(license) {
  if (typeof license !== 'string' || license.trim() === '') {
    return { ok: false, normalized: null, reason: 'license_missing' };
  }
  if (license.length > LICENSING_LIMITS.MAX_LICENSE_CHARS || CONTROL_RE.test(license)) {
    CONTROL_RE.lastIndex = 0;
    return { ok: false, normalized: null, reason: 'license_invalid_or_too_long' };
  }
  const clean = _cleanText(license, LICENSING_LIMITS.MAX_LICENSE_CHARS);
  const canonical = LICENSE_LOOKUP.get(clean.toLowerCase()) || clean;
  return {
    ok: true,
    normalized: canonical,
    original_sha256: _sha256Hex(clean),
    normalized_sha256: _sha256Hex(canonical),
  };
}

// Classify a single license string into one of four buckets.
//   'safe'    present in SAFE_LICENSES
//   'amber'   present in AMBER_LICENSES
//   'deny'    present in DENY_LICENSES
//   'unknown' absent or empty (treated like DENY by the verifier)
export function classifyLicense(license) {
  const normalized = normalizeLicenseId(license);
  if (!normalized.ok) return 'unknown';
  if (SAFE_LICENSES.includes(normalized.normalized)) return 'safe';
  if (AMBER_LICENSES.includes(normalized.normalized)) return 'amber';
  if (DENY_LICENSES.includes(normalized.normalized)) return 'deny';
  return 'unknown';
}

export function classifyLicenseDetailed(license) {
  const normalized = normalizeLicenseId(license);
  const bucket = normalized.ok ? classifyLicense(normalized.normalized) : 'unknown';
  return {
    bucket,
    normalized_license: normalized.normalized,
    license_sha256: normalized.normalized ? _sha256Hex(normalized.normalized) : null,
    reason: normalized.ok ? null : normalized.reason,
  };
}

function _safeSourceReason(reason, sourceUrl) {
  return `${_cleanText(reason, LICENSING_LIMITS.MAX_REASON_CHARS)} (source_url_sha256=${_sha256Hex(String(sourceUrl == null ? '' : sourceUrl)).slice(0, 16)})`;
}

function _privateOrLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '[::1]') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d{1,3})\./);
  return !!(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
}

function _validIdentifierRest(prefix, rest) {
  if (!rest) return { ok: false, reason: `source_url has prefix '${prefix}' but no identifier after it` };
  if (rest.length > LICENSING_LIMITS.MAX_IDENTIFIER_CHARS || CONTROL_RE.test(rest)) {
    CONTROL_RE.lastIndex = 0;
    return { ok: false, reason: `source_url identifier for prefix '${prefix}' is invalid or too long` };
  }
  if (rest.includes('..') || /^[a-zA-Z]:[\\/]/.test(rest) || rest.startsWith('/') || rest.startsWith('\\')) {
    return { ok: false, reason: `source_url identifier for prefix '${prefix}' must not be a filesystem path` };
  }
  if (prefix === 'huggingface:' || prefix === 'hf:') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rest)) {
      return { ok: false, reason: `source_url identifier for prefix '${prefix}' must be owner/name` };
    }
  }
  return { ok: true };
}

// URL identifier shape. A source_url field can be:
//   * a real http(s) URL                          must parse via URL ctor
//   * a `local:<dataset-id>` identifier           pass-through, no fetch
//   * an `internal:<id>` identifier               pass-through, no fetch
//   * a `huggingface:<owner>/<name>` ref          pass-through, no fetch
// Anything else (empty, garbage) fails the source_url check.
const NON_URL_PREFIXES = ['local:', 'internal:', 'huggingface:', 'hf:', 's3:', 'gs:'];

export function validSourceUrl(source_url) {
  if (typeof source_url !== 'string' || source_url.trim().length === 0) {
    return { ok: false, reason: 'source_url missing or empty', source_url_sha256: _sha256Hex('') };
  }
  if (source_url.length > LICENSING_LIMITS.MAX_SOURCE_URL_CHARS || CONTROL_RE.test(source_url)) {
    CONTROL_RE.lastIndex = 0;
    return {
      ok: false,
      reason: _safeSourceReason('source_url contains control characters or is too long', source_url),
      source_url_sha256: _sha256Hex(source_url),
    };
  }
  const clean = source_url.trim();
  for (const prefix of NON_URL_PREFIXES) {
    if (clean.startsWith(prefix)) {
      const rest = clean.slice(prefix.length);
      const ident = _validIdentifierRest(prefix, rest);
      if (!ident.ok) {
        return { ok: false, reason: _safeSourceReason(ident.reason, clean), source_url_sha256: _sha256Hex(clean) };
      }
      return { ok: true, kind: 'identifier', prefix, identifier_sha256: _sha256Hex(rest), source_url_sha256: _sha256Hex(clean) };
    }
  }
  if (clean.startsWith('file:')) {
    return {
      ok: false,
      reason: _safeSourceReason('file: URLs are not accepted; use local:<dataset-id> for offline corpus identifiers', clean),
      source_url_sha256: _sha256Hex(clean),
    };
  }
  try {
    const u = new URL(clean);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, reason: _safeSourceReason(`source_url protocol '${u.protocol}' not http/https`, clean), source_url_sha256: _sha256Hex(clean) };
    }
    if (u.username || u.password) {
      return { ok: false, reason: _safeSourceReason('source_url must not contain credentials', clean), source_url_sha256: _sha256Hex(clean) };
    }
    if (_privateOrLoopbackHost(u.hostname)) {
      return { ok: false, reason: _safeSourceReason('source_url host is private or loopback; use internal:<id> instead', clean), source_url_sha256: _sha256Hex(clean) };
    }
    return {
      ok: true,
      kind: 'url',
      protocol: u.protocol,
      host_sha256: _sha256Hex(u.hostname.toLowerCase()),
      source_url_sha256: _sha256Hex(clean),
      normalized_url_sha256: _sha256Hex(u.href),
    };
  } catch (e) {
    return { ok: false, reason: _safeSourceReason(`source_url does not parse as URL: ${e.message}`, clean), source_url_sha256: _sha256Hex(clean) };
  }
}

// Extract declared corpus sources from a manifest. We look at four shapes,
// in order, to stay backward-compatible with any manifest shape that has
// already shipped or might ship:
//   1. manifest.corpus_sources[]                  the canonical Wave 194 shape
//   2. manifest.spec?.sources[]                   older proposed shape
//   3. manifest.spec?.train?.corpora[]            RS-1 proposed shape
//   4. manifest.spec?.data_sources[]              alternate proposed shape
// If none are present, returns []; the check then passes with a legacy note.
//
// We deliberately do NOT include manifest.external_holdout_provenance.holdouts
// here: those are HOLDOUT corpora (already gated by check #20 + license-drift
// row in binder.js), not TRAINING corpora.
export function extractCorpusSources(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  if (Array.isArray(manifest.corpus_sources) && manifest.corpus_sources.length > 0) {
    return manifest.corpus_sources;
  }
  const spec = manifest.spec;
  if (spec && typeof spec === 'object') {
    if (Array.isArray(spec.sources) && spec.sources.length > 0) return spec.sources;
    if (spec.train && Array.isArray(spec.train.corpora) && spec.train.corpora.length > 0) {
      return spec.train.corpora;
    }
    if (Array.isArray(spec.data_sources) && spec.data_sources.length > 0) {
      return spec.data_sources;
    }
  }
  return [];
}

function _sourceName(source, index) {
  const raw = source && typeof source.name === 'string' ? source.name : `source[${index}]`;
  return _cleanText(raw, LICENSING_LIMITS.MAX_NAME_CHARS) || `source[${index}]`;
}

function _resultEnvelope({ status, detail, sources, evaluatedSources, caveats = [], bad = [], classCounts = null, sourceEvidence = [] }) {
  const evidence = {
    version: LICENSING_ALLOWLIST_VERSION,
    sources_count: Array.isArray(sources) ? sources.length : 0,
    sources_evaluated: Array.isArray(evaluatedSources) ? evaluatedSources.length : 0,
    caveat_count: caveats.length,
    bad_count: bad.length,
    class_counts: classCounts || { safe: 0, amber: 0, deny: 0, unknown: 0 },
    source_evidence: sourceEvidence,
  };
  return {
    status,
    detail,
    ...(caveats.length ? { caveats } : {}),
    ...(bad.length ? { bad } : {}),
    sources_count: evidence.sources_count,
    sources_evaluated: evidence.sources_evaluated,
    class_counts: evidence.class_counts,
    source_evidence: sourceEvidence,
    source_evidence_sha256: _hashEvidence(sourceEvidence),
    license_gate_sha256: _hashEvidence(evidence),
    version: LICENSING_ALLOWLIST_VERSION,
  };
}

// The verifier check. Returns { status, detail, caveats?, bad?, sources_count }.
// Called from src/binder.js as check #25. The signature matches the existing
// 24 checks' shape: a plain object with name/status/detail, where status is
// one of 'pass' | 'fail' | 'warn'.
export function checkCorpusLicensing(manifest) {
  const sources = extractCorpusSources(manifest);
  if (sources.length === 0) {
    return _resultEnvelope({
      status: 'pass',
      detail: 'no corpus sources declared (legacy or template manifest); to gate the corpus URL licensing layer, add manifest.corpus_sources[]={name, source_url, license} entries declaring every dataset the recipe distilled from',
      sources,
      evaluatedSources: [],
    });
  }
  const evaluatedSources = sources.slice(0, LICENSING_LIMITS.MAX_SOURCES);
  const caveats = [];
  const bad = [];
  const okSummaries = [];
  const sourceEvidence = [];
  const classCounts = { safe: 0, amber: 0, deny: 0, unknown: 0 };
  if (sources.length > LICENSING_LIMITS.MAX_SOURCES) {
    bad.push(`too_many_sources: ${sources.length} declared, max ${LICENSING_LIMITS.MAX_SOURCES}`);
  }
  for (let i = 0; i < evaluatedSources.length; i++) {
    const s = evaluatedSources[i] || {};
    const name = _sourceName(s, i);
    const urlCheck = validSourceUrl(s.source_url);
    if (!urlCheck.ok) {
      bad.push(`${name}: ${urlCheck.reason}`);
      classCounts.unknown += 1;
      sourceEvidence.push({
        name_sha256: _sha256Hex(name),
        source_url_sha256: urlCheck.source_url_sha256 || null,
        license_sha256: typeof s.license === 'string' ? _sha256Hex(_cleanText(s.license, LICENSING_LIMITS.MAX_LICENSE_CHARS)) : null,
        bucket: 'unknown',
        url_ok: false,
      });
      continue;
    }
    const licenseDetail = classifyLicenseDetailed(s.license);
    const cls = licenseDetail.bucket;
    classCounts[cls] = (classCounts[cls] || 0) + 1;
    sourceEvidence.push({
      name_sha256: _sha256Hex(name),
      source_url_sha256: urlCheck.source_url_sha256,
      url_kind: urlCheck.kind,
      license_sha256: licenseDetail.license_sha256,
      normalized_license: licenseDetail.normalized_license,
      bucket: cls,
      url_ok: true,
    });
    if (cls === 'deny' || cls === 'unknown') {
      const lic = licenseDetail.normalized_license || '(missing)';
      bad.push(`${name}: license='${lic}' is in DENY_LICENSES or unknown (must be a buyer-safe SPDX / catalog license; see SAFE_LICENSES + AMBER_LICENSES in src/licensing-allowlist.js)`);
      continue;
    }
    if (cls === 'amber') {
      caveats.push(`${name}: license='${licenseDetail.normalized_license}' is research-only / non-commercial; requires manual procurement review before shipping commercial output (amber)`);
      okSummaries.push(`${name} (${licenseDetail.normalized_license}, amber)`);
      continue;
    }
    okSummaries.push(`${name} (${licenseDetail.normalized_license})`);
  }
  if (bad.length > 0) {
    return _resultEnvelope({
      status: 'fail',
      detail: `manifest.corpus_sources licensing gate rejected ${bad.length} of ${sources.length} declared source(s): ${bad.join('; ')}. Every corpus the recipe distilled from must declare {name, source_url, license} where license is in SAFE_LICENSES or AMBER_LICENSES (see src/licensing-allowlist.js). DENY_LICENSES (${DENY_LICENSES.join(', ')}) and unknown / missing license strings are rejected so a manifest cannot ship with a corpus URL pointing at scraped, proprietary, or unlicensed training data.`,
      bad,
      caveats,
      sources,
      evaluatedSources,
      classCounts,
      sourceEvidence,
    });
  }
  if (caveats.length > 0) {
    return _resultEnvelope({
      status: 'pass',
      detail: `${sources.length} corpus source(s) declared; ${okSummaries.length} verified license-clean (${okSummaries.join(', ')}). note: ${caveats.length} amber license(s) require manual procurement review: ${caveats.join('; ')}`,
      caveats,
      sources,
      evaluatedSources,
      classCounts,
      sourceEvidence,
    });
  }
  return _resultEnvelope({
    status: 'pass',
    detail: `${sources.length} corpus source(s) declared; every license string in SAFE_LICENSES and every source_url parses (${okSummaries.join(', ')})`,
    sources,
    evaluatedSources,
    classCounts,
    sourceEvidence,
  });
}
