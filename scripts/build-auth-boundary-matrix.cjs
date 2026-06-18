#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'auth-boundary-matrix.json');
const SCHEMA = 'kolm.auth_boundary_matrix.v1';
const UPDATED_AT = '2026-06-18';

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const SUMMARY = args.has('--summary');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stable(value), null, 2) + '\n';
}

function lineNumber(text, idx) {
  return text.slice(0, Math.max(0, idx)).split(/\r?\n/).length;
}

function extractPublicPages(authSrc) {
  const m = authSrc.match(/const PUBLIC_PAGES = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) return [];
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).sort();
}

function publicApiBlock(authSrc) {
  const start = authSrc.indexOf('const PUBLIC_API = (p) =>');
  const end = authSrc.indexOf('export function isPublicApiPath', start);
  return start >= 0 && end > start ? authSrc.slice(start, end) : '';
}

function parseRegexLiteral(line, start) {
  let escaped = false;
  let inClass = false;
  for (let i = start + 1; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === ']') {
      inClass = false;
      continue;
    }
    if (ch === '/' && !inClass) {
      let end = i + 1;
      while (/[a-z]/i.test(line[end] || '')) end++;
      return line.slice(start, end);
    }
  }
  return null;
}

function extractPublicApiRules(authSrc) {
  const block = publicApiBlock(authSrc);
  const exact = [...block.matchAll(/p === ['"]([^'"]+)['"]/g)].map((m) => ({ path: m[1], line: lineNumber(authSrc, authSrc.indexOf(m[0])) }));
  const prefixes = [...block.matchAll(/p\.startsWith\(['"]([^'"]+)['"]\)/g)].map((m) => ({ prefix: m[1], line: lineNumber(authSrc, authSrc.indexOf(m[0])) }));
  const regexes = [];
  const blockStart = authSrc.indexOf(block);
  let offset = 0;
  for (const line of block.split(/\r?\n/)) {
    if (line.includes('.test(p)')) {
      const start = line.indexOf('/');
      const literal = start >= 0 ? parseRegexLiteral(line, start) : null;
      if (literal && line.slice(start + literal.length).startsWith('.test(p)')) {
        regexes.push({ regex: literal, line: lineNumber(authSrc, blockStart + offset + start) });
      }
    }
    offset += line.length + 1;
  }
  return {
    exact: exact.sort((a, b) => a.path.localeCompare(b.path)),
    prefixes: prefixes.sort((a, b) => a.prefix.localeCompare(b.prefix)),
    regexes: regexes.sort((a, b) => a.regex.localeCompare(b.regex)),
  };
}

function extractExports(authSrc) {
  const functions = [...authSrc.matchAll(/^export function ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const constants = [...authSrc.matchAll(/^export const ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  return {
    functions: [...new Set(functions)].sort(),
    constants: [...new Set(constants)].sort(),
  };
}

function scopeBlock(routerSrc) {
  const start = routerSrc.indexOf('function _scopeRequiredForRoute(req)');
  const end = routerSrc.indexOf('async function _assertComputeSlot', start);
  return start >= 0 && end > start ? routerSrc.slice(start, end) : '';
}

function extractScopePolicy(routerSrc) {
  const block = scopeBlock(routerSrc);
  const rules = [];
  const returns = [...block.matchAll(/return (?:method === 'GET' \? '([^']+)' : '([^']+)'|'([^']+)'|null)/g)];
  for (const m of returns) {
    const scopes = [m[1], m[2], m[3]].filter(Boolean);
    const idx = routerSrc.indexOf(m[0]);
    for (const scope of scopes) {
      rules.push({
        scope,
        family: scope === '*' ? '*' : scope.split(':')[0],
        line: lineNumber(routerSrc, idx),
      });
    }
  }
  const uniqueRules = [];
  const seen = new Set();
  for (const rule of rules) {
    const key = `${rule.scope}:${rule.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueRules.push(rule);
  }
  const families = [...new Set(uniqueRules.map((r) => r.family))].sort();
  return {
    families,
    rules: uniqueRules.sort((a, b) => a.scope.localeCompare(b.scope) || a.line - b.line),
  };
}

function authMiddlewareGuards(authSrc) {
  const middlewareStart = authSrc.indexOf('export function authMiddleware');
  const middlewareEnd = authSrc.indexOf('// W258-BE-4', middlewareStart);
  const block = middlewareStart >= 0 && middlewareEnd > middlewareStart ? authSrc.slice(middlewareStart, middlewareEnd) : '';
  const lockedOutKeysCannotMatch = /function tenantKeyMatches[\s\S]*if \(!tenant\.api_key_hash\) return false/.test(authSrc);
  return {
    public_api_bypass: /PUBLIC_API\(p\)/.test(block),
    bearer_header: /authorization/i.test(block) && /Bearer/i.test(block),
    x_api_key_header: /x-api-key/i.test(block),
    admin_key_bypass: /adminApiKey\(\)/.test(block) && /req\.is_admin/.test(block),
    tenant_record_stamped: /req\.tenant_record\s*=\s*t/.test(block),
    expired_anon_rejected: /anonymous workspace expired/.test(block) && /expired_at:\s*t\.expires_at/.test(block),
    locked_out_rejected: /findTenantByApiKey\(key\)/.test(block) && /if \(!t\) return res\.status\(401\)\.json\(\{ error: 'invalid api key' \}\)/.test(block) && lockedOutKeysCannotMatch,
    rate_limit_enforced: /takeToken\(t\)/.test(block) && /X-RateLimit-Limit/.test(block),
    quota_enforced: /X-Quota-Limit/.test(block) && /monthly quota exceeded/.test(block),
    scoped_key_scopes_attached: /req\.key_scopes\s*=\s*scopesForKey\(key\)/.test(block),
    last_used_tracking_hook: /recordKeyLastUsed/.test(block),
  };
}

function requiredExportSets() {
  return {
    credential_lifecycle: [
      'hashApiKey',
      'findTenantByApiKey',
      'migrateAllPlainKeysOnce',
      'provisionTenant',
      'provisionAnonTenant',
      'claimAnonTenant',
      'claimAnonTenantAtomic',
      'findOrCreateTenantByEmail',
      'rotateTenantKey',
      'recoverKeyByEmail',
    ],
    scoped_keys: [
      'mintScopedKey',
      'listScopedKeys',
      'revokeScopedKey',
      'renewScopedKey',
      'scopesForKey',
      '_scopedKeyExpired',
      'keyHasScope',
      'recordKeyLastUsed',
      'flushKeyLastUsed',
      'startKeyLastUsedFlusher',
      'stopKeyLastUsedFlusher',
    ],
    middleware_and_policy: [
      'authMiddleware',
      'requirePlan',
      'chargeUsage',
      'adminApiKey',
      'rateLimitStats',
      'isPublicApiPath',
      'isGeoFenced',
      'ofacDenylistStaleness',
      'ofacDenylistStartupCheck',
    ],
  };
}

function testEvidence() {
  const required = [
    'tests/auth-hash.test.js',
    'tests/finalized-c9-capability-scopes.test.js',
    'tests/sota-auth.test.js',
    'tests/billing-completeness.test.js',
    'tests/saml-scim.test.js',
    'tests/wave934-provider-compliance-contracts.test.js',
  ];
  return required.map((rel) => ({ path: rel, present: fs.existsSync(path.join(ROOT, rel)) }));
}

function buildMatrix() {
  const authSrc = read('src/auth.js');
  const routerSrc = read('src/router.js');
  const apiMatrix = readJson('docs/internal/api-contract-matrix.json');
  const ofac = readJson('src/ofac-denylist.json');
  const exports = extractExports(authSrc);
  const exportedNames = new Set([...exports.functions, ...exports.constants]);
  const required = requiredExportSets();
  const publicApiRules = extractPublicApiRules(authSrc);
  const scopePolicy = extractScopePolicy(routerSrc);
  const guards = authMiddlewareGuards(authSrc);
  const tests = testEvidence();

  const missingExports = [];
  for (const [group, names] of Object.entries(required)) {
    for (const name of names) {
      if (!exportedNames.has(name)) missingExports.push({ group, name });
    }
  }

  const expectedScopeFamilies = ['*', 'account', 'billing', 'identity', 'lake', 'provider_keys', 'team', 'webhook'];
  const missingScopeFamilies = expectedScopeFamilies.filter((family) => !scopePolicy.families.includes(family));
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
  const missingTests = tests.filter((row) => !row.present).map((row) => row.path);

  const ofacVersionMs = new Date(ofac.version_date || '').getTime();
  const ofacAgeDays = Number.isFinite(ofacVersionMs)
    ? Math.floor((new Date(`${UPDATED_AT}T00:00:00Z`).getTime() - ofacVersionMs) / 86400000)
    : null;

  const summary = {
    exported_functions: exports.functions.length,
    exported_constants: exports.constants.length,
    public_pages: extractPublicPages(authSrc).length,
    public_api_exact_rules: publicApiRules.exact.length,
    public_api_prefix_rules: publicApiRules.prefixes.length,
    public_api_regex_rules: publicApiRules.regexes.length,
    public_api_total_rules: publicApiRules.exact.length + publicApiRules.prefixes.length + publicApiRules.regexes.length,
    api_matrix_public_routes: apiMatrix.summary.public_routes,
    api_matrix_authenticated_routes: apiMatrix.summary.authenticated_routes,
    scope_gate_rules: scopePolicy.rules.length,
    scope_families: scopePolicy.families.length,
    required_export_groups: Object.keys(required).length,
    missing_required_exports: missingExports.length,
    failed_middleware_guards: failedGuards.length,
    missing_scope_families: missingScopeFamilies.length,
    missing_test_evidence: missingTests.length,
    ofac_country_count: Array.isArray(ofac.countries) ? ofac.countries.length : 0,
    ofac_age_days: ofacAgeDays,
  };

  const failures = [];
  if (!apiMatrix || apiMatrix.schema !== 'kolm.api_contract_matrix.v1' || !apiMatrix.gates || apiMatrix.gates.ok !== true) {
    failures.push({ gate: 'api_contract_matrix_dependency', reason: 'api contract matrix missing or not green' });
  }
  if (summary.public_api_total_rules < 80) failures.push({ gate: 'public_api_policy_extract', count: summary.public_api_total_rules });
  if (missingExports.length) failures.push({ gate: 'required_auth_exports', count: missingExports.length, sample: missingExports.slice(0, 10) });
  if (failedGuards.length) failures.push({ gate: 'auth_middleware_guards', count: failedGuards.length, guards: failedGuards });
  if (summary.scope_gate_rules < 10) failures.push({ gate: 'scope_gate_rules', count: summary.scope_gate_rules });
  if (missingScopeFamilies.length) failures.push({ gate: 'scope_families', missing: missingScopeFamilies });
  if (missingTests.length) failures.push({ gate: 'auth_test_evidence', missing: missingTests });
  if (!ofac.version_date || !ofac.source_url || summary.ofac_country_count < 5 || ofac.review_cadence_days > 90 || ofacAgeDays == null || ofacAgeDays > ofac.review_cadence_days) {
    failures.push({ gate: 'ofac_denylist_freshness', version_date: ofac.version_date || null, age_days: ofacAgeDays, review_cadence_days: ofac.review_cadence_days || null });
  }

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    sources: [
      'src/auth.js',
      'src/router.js',
      'src/ofac-denylist.json',
      'docs/internal/api-contract-matrix.json',
      ...tests.map((row) => row.path),
    ],
    summary,
    gates: {
      ok: failures.length === 0,
      failures,
      warnings: [],
    },
    public_pages: extractPublicPages(authSrc),
    public_api_policy: publicApiRules,
    required_exports: required,
    missing_required_exports: missingExports,
    middleware_guards: guards,
    scope_policy: scopePolicy,
    credential_lifecycle: {
      primary_tenant_key: {
        storage: 'sha256 hash plus prefix only',
        rotation: 'rotateTenantKey invalidates old primary key and returns a new raw key once',
        recovery: 'recoverKeyByEmail rotates locked-out tenants after email verification path',
      },
      scoped_keys: {
        storage: 'api_keys rows store sha256 hex hash, key_prefix, scopes, label, created_at, last_used_at, revoked_at, expires_at',
        issuance: 'mintScopedKey returns the raw key exactly once with key_prefix and expires_at',
        revocation: 'revokeScopedKey tenant-fences by tenant_id and marks revoked_at',
        renewal: 'renewScopedKey extends or clears expires_at and refuses revoked rows',
      },
      session_keys: {
        source: 'OAuth and magic-link session credentials are minted via scoped keys with full-scope and TTL',
        authentication: 'findTenantByApiKey resolves live, unexpired api_keys rows back to tenant records',
      },
    },
    ofac_denylist: {
      version_date: ofac.version_date || null,
      source_url: ofac.source_url || null,
      review_cadence_days: ofac.review_cadence_days || null,
      countries: Array.isArray(ofac.countries) ? ofac.countries.slice().sort() : [],
      age_days: ofacAgeDays,
    },
    test_evidence: tests,
  };
}

function main() {
  const matrix = buildMatrix();
  const body = stableStringify(matrix);
  if (CHECK) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== body) {
      console.error('auth-boundary-matrix: docs/internal/auth-boundary-matrix.json is out of date');
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, body, 'utf8');
  }
  if (SUMMARY) {
    console.log(JSON.stringify({
      ok: matrix.gates.ok,
      schema: matrix.schema,
      summary: matrix.summary,
      failures: matrix.gates.failures,
    }, null, 2));
  } else {
    const action = CHECK ? 'ok' : 'wrote';
    console.log(`auth-boundary-matrix: ${action} docs/internal/auth-boundary-matrix.json public_rules=${matrix.summary.public_api_total_rules} scope_rules=${matrix.summary.scope_gate_rules} failures=${matrix.gates.failures.length}`);
  }
  if (!matrix.gates.ok) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
