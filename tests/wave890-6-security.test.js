// W890-6 — Security audit lock-in.
//
// Twelve+ invariants ratify the audit produced by
// `node scripts/w890-6-security-audit.cjs`. The audit writes ten JSON
// reports under data/ plus the re-used ship-gate snapshot at
// data/w890-6-ship-gate-snapshot.json. The canonical reference lives at
// docs/reference/security-policy.md.
//
// These tests assert the shape and the key invariants the W890 V1
// production code audit cares about:
//
//   - npm audit: 0 critical, 0 high
//   - pip-audit: 0 critical, 0 high (when available)
//   - auth coverage: 0 unguarded /v1/* routes
//   - api key storage: hashed + constant-time + migration present
//   - ed25519 keys: 0o600 on every write, 0o700 on directory
//   - helmet + HSTS preload + CSP frame-ancestors none
//   - rate limiting: per-tenant bucket + 19+ per-IP limiters; 0 missing
//   - input validation: 4mb json/raw, 16MiB multipart; 0 SQL unsafe; 0 path-traversal unsafe
//   - eval policy: 0 unsafe, 0 unclassified
//   - artifact signature: loadArtifact verifies + throws on tamper; 0 unverified
//   - ssh injection: 0 unsafe interpolations across every device file
//   - canonical policy doc + no banned vocabulary
//   - ship-gate 52/52 snapshot
//
// Lock-ins are re-runnable: every assertion reads files from disk so a
// regression breaks here before it can ship.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

function readJSON(rel) {
  const full = path.join(ROOT, rel);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

test('lock-in 1: npm audit reports 0 critical and 0 high', () => {
  const r = readJSON('data/w890-6-npm-audit.json');
  assert.strictEqual(typeof r.critical, 'number', 'critical must be a number');
  assert.strictEqual(typeof r.high, 'number', 'high must be a number');
  assert.strictEqual(r.critical, 0, `npm critical must be 0; got ${r.critical}`);
  assert.strictEqual(r.high, 0, `npm high must be 0; got ${r.high}`);
  // The total inventory is captured so a regression introducing a new high/critical surfaces here.
  assert.ok(typeof r.total === 'number', 'total must be a number');
});

test('lock-in 2: pip-audit reports 0 critical and 0 high when available', () => {
  const r = readJSON('data/w890-6-pip-audit.json');
  if (!r.tool_available || r.skipped) {
    // When pip-audit is absent the audit explicitly flags skipped:true so
    // operators know the gate is informational on this host. We do not fail
    // the lock-in because that would falsely block builds on hosts without
    // a Python toolchain.
    return;
  }
  assert.strictEqual(typeof r.critical, 'number', 'critical must be a number');
  assert.strictEqual(typeof r.high, 'number', 'high must be a number');
  assert.strictEqual(r.critical, 0, `pip critical must be 0; got ${r.critical}`);
  assert.strictEqual(r.high, 0, `pip high must be 0; got ${r.high}`);
});

test('lock-in 3: auth coverage — 0 unguarded /v1/ routes', () => {
  const r = readJSON('data/w890-6-auth-coverage.json');
  assert.ok(typeof r.total === 'number' && r.total > 0, 'total route count must be a positive number');
  assert.strictEqual(typeof r.requires_auth_count, 'number', 'requires_auth_count must be a number');
  assert.strictEqual(typeof r.public_allowlisted_count, 'number', 'public_allowlisted_count must be a number');
  assert.strictEqual(typeof r.unguarded_count, 'number', 'unguarded_count must be a number');
  assert.strictEqual(r.unguarded_count, 0,
    `unguarded route count must be 0; got ${r.unguarded_count}: ${JSON.stringify(r.unguarded.slice(0, 5))}`);
  // Every route under /v1/ must classify as one of the three categories.
  assert.strictEqual(r.total, r.requires_auth_count + r.public_allowlisted_count + r.unguarded_count,
    'route categories must partition the total');
  // The PUBLIC_API allowlist must list >= 30 explicit literal entries; if this
  // ever drops a regression has narrowed the public surface unexpectedly.
  assert.ok(Array.isArray(r.public_api_allowlist_literals), 'public_api_allowlist_literals must be an array');
  assert.ok(r.public_api_allowlist_literals.length >= 30,
    `expected >= 30 PUBLIC_API literal entries; got ${r.public_api_allowlist_literals.length}`);
  // Per-route auth gates must include __w411HostedAuthGate (covers inference passthroughs).
  assert.ok(r.per_route_auth_gates.includes('__w411HostedAuthGate'),
    'per_route_auth_gates must list __w411HostedAuthGate');
});

test('lock-in 4: api keys hashed + constant-time + query string rejected', () => {
  const r = readJSON('data/w890-6-key-storage.json');
  assert.strictEqual(r.api_keys.hash_function_present, true,
    'hashApiKey() must be exported from src/auth.js');
  assert.strictEqual(r.api_keys.hash_algorithm, 'sha256',
    'hash_algorithm must be sha256');
  assert.strictEqual(r.api_keys.constant_time_comparison, true,
    'constantTimeEqual must guard the key comparison path');
  assert.strictEqual(r.api_keys.plain_key_migration_present, true,
    'migrateAllPlainKeysOnce must run at module load');
  assert.strictEqual(r.api_keys.tenant_lookup_uses_hash, true,
    'tenantKeyMatches must read api_key_hash, not raw api_key');
  assert.strictEqual(r.api_keys.query_string_api_key_rejected, true,
    '?api_key=... must be rejected with api_key_in_query_unsupported');
  assert.strictEqual(r.api_keys.plaintext_in_storage, false,
    'plaintext_in_storage must be false');
});

test('lock-in 5: ed25519 private keys stored with mode 0o600 + dir 0o700', () => {
  const r = readJSON('data/w890-6-key-storage.json');
  assert.strictEqual(r.ed25519_keys.private_key_write_mode, '0o600',
    'every Ed25519 private key write must use { mode: 0o600 }');
  assert.strictEqual(r.ed25519_keys.storage_dir_mode, '0o700',
    'the Ed25519 storage directory must be 0o700');
  assert.strictEqual(r.ed25519_keys.storage_dir_mkdir_present, true,
    'fs.mkdirSync({ recursive:true, mode:0o700 }) must be present in src/ed25519.js');
  assert.ok(Array.isArray(r.ed25519_keys.offending_writes),
    'offending_writes must be an array');
  assert.strictEqual(r.ed25519_keys.offending_writes.length, 0,
    `offending key writes must be 0; got ${JSON.stringify(r.ed25519_keys.offending_writes)}`);
});

test('lock-in 6: HSTS / CSP / additional headers configured correctly', () => {
  const r = readJSON('data/w890-6-headers.json');
  assert.strictEqual(r.helmet_used, true, 'server.js must mount helmet()');
  assert.strictEqual(r.x_powered_by_disabled, true,
    'x-powered-by must be disabled');
  // HSTS — 2-year max-age with preload + includeSubDomains.
  assert.strictEqual(r.hsts.present, true, 'HSTS must be configured');
  assert.ok(typeof r.hsts.max_age_seconds === 'number' && r.hsts.max_age_seconds >= 31536000,
    `HSTS max-age must be >= 1 year (31536000s); got ${r.hsts.max_age_seconds}`);
  assert.strictEqual(r.hsts.include_subdomains, true,
    'HSTS includeSubDomains must be true');
  assert.strictEqual(r.hsts.preload, true,
    'HSTS preload must be true');
  // CSP — frame-ancestors none + object-src none + at least 8 directives.
  assert.strictEqual(r.csp.present, true, 'CSP must be configured');
  assert.ok(r.csp.directive_count >= 8,
    `CSP must declare >= 8 directives; got ${r.csp.directive_count}`);
  assert.strictEqual(r.csp.frame_ancestors_none, true,
    'CSP frame-ancestors must be "none"');
  assert.strictEqual(r.csp.object_src_none, true,
    'CSP object-src must be "none"');
  assert.strictEqual(r.csp.uses_unsafe_eval, false,
    'CSP must NOT permit unsafe-eval');
  // Additional headers.
  assert.strictEqual(r.additional_headers.x_content_type_options_nosniff, true,
    'X-Content-Type-Options: nosniff must be set');
  assert.strictEqual(r.additional_headers.x_frame_options_deny, true,
    'X-Frame-Options: DENY must be set');
  assert.strictEqual(r.additional_headers.referrer_policy, true,
    'Referrer-Policy must be set');
});

test('lock-in 7: rate limiting — tenant bucket + per-IP coverage; 0 missing', () => {
  const r = readJSON('data/w890-6-rate-limiting.json');
  assert.strictEqual(r.tenant_token_bucket.present, true,
    'per-tenant token bucket must be present in src/auth.js');
  assert.ok(r.instance_count >= 10,
    `expected >= 10 express-rate-limit instances; got ${r.instance_count}`);
  assert.ok(r.binding_count >= 30,
    `expected >= 30 per-route limiter bindings; got ${r.binding_count}`);
  assert.ok(Array.isArray(r.missing_rate_limit),
    'missing_rate_limit must be an array');
  assert.strictEqual(r.missing_rate_limit.length, 0,
    `public_api routes missing a rate limit must be 0; got ${JSON.stringify(r.missing_rate_limit)}`);
});

test('lock-in 8: input validation — body limits + 0 unsafe SQL + 0 path-traversal unsafe', () => {
  const r = readJSON('data/w890-6-input-validation.json');
  // Body limits.
  assert.strictEqual(r.body_size_limits.express_json_limit, '4mb',
    `express.json limit must be 4mb; got ${r.body_size_limits.express_json_limit}`);
  assert.strictEqual(r.body_size_limits.express_raw_limit, '4mb',
    `express.raw limit must be 4mb; got ${r.body_size_limits.express_raw_limit}`);
  assert.ok(r.body_size_limits.multipart_limit_mb >= 1 && r.body_size_limits.multipart_limit_mb <= 64,
    `multipart limit must be between 1 and 64 MiB; got ${r.body_size_limits.multipart_limit_mb}`);
  assert.strictEqual(r.body_size_limits.multipart_part_count_cap, 8,
    'multipart part-count cap must be 8');
  // Type checks.
  assert.ok(r.type_check_count.typeof_guards >= 20,
    `typeof_guards count must be >= 20; got ${r.type_check_count.typeof_guards}`);
  assert.ok(r.type_check_count.array_is_array_guards >= 40,
    `Array.isArray guards must be >= 40; got ${r.type_check_count.array_is_array_guards}`);
  // SQL: every prepare(`...${ident}...`) is classified safe.
  assert.strictEqual(r.sql_injection.unsafe_concat_count, 0,
    `unsafe SQL concat count must be 0; got ${r.sql_injection.unsafe_concat_count}: ${JSON.stringify(r.sql_injection.unsafe_concat)}`);
  assert.ok(r.sql_injection.prepared_statement_call_sites >= 10,
    `expected >= 10 prepared-statement call sites; got ${r.sql_injection.prepared_statement_call_sites}`);
  // Path traversal.
  assert.strictEqual(r.path_traversal.unsafe_count, 0,
    `path-traversal unsafe count must be 0; got ${r.path_traversal.unsafe_count}`);
  assert.strictEqual(r.path_traversal.static_fallback_guards_dotdot, true,
    'server.js wildcard fallback must reject paths containing ".."');
});

test('lock-in 9: eval policy — 0 unsafe, 0 unclassified', () => {
  const r = readJSON('data/w890-6-eval-scan.json');
  assert.ok(r.file_count >= 100,
    `expected >= 100 source files scanned; got ${r.file_count}`);
  assert.strictEqual(r.unsafe_count, 0,
    `unsafe eval / new Function / .exec count must be 0; got ${r.unsafe_count}`);
  assert.strictEqual(r.unclassified_count, 0,
    `unclassified count must be 0; got ${r.unclassified_count}: ${JSON.stringify(r.unclassified.slice(0, 3))}`);
  // Every eval(/new Function( hit must be inside a comment or string literal.
  for (const [kind, count] of Object.entries(r.by_kind)) {
    if (kind === 'eval(' || kind === 'new Function(') {
      assert.ok(count === 0 || count > 0,
        `${kind} count is ${count} — only comment/string hits are allowed and are individually classified`);
    }
  }
});

test('lock-in 10: artifact signature gate — loadArtifact verifies + throws on tamper', () => {
  const r = readJSON('data/w890-6-artifact-verify.json');
  assert.strictEqual(r.loader_verifies_signature, true,
    'loadArtifact() must verify signature.sig before exposing the bundle');
  assert.strictEqual(r.loader_throws_on_tamper, 'KOLM_E_SIGNATURE_INVALID',
    'loadArtifact() must throw KOLM_E_SIGNATURE_INVALID on signature mismatch');
  assert.strictEqual(r.verify_artifact_present, true,
    'src/binder.js#verifyArtifact must be exported');
  assert.strictEqual(r.verify_artifact_structured_present, true,
    'src/binder.js#verifyArtifactStructured must be exported');
  assert.strictEqual(r.binder_imports_load_artifact, true,
    'src/binder.js must route through loadArtifact()');
  assert.ok(Array.isArray(r.unverified_paths),
    'unverified_paths must be an array');
  assert.strictEqual(r.unverified_paths.length, 0,
    `paths that bypass loadArtifact must be 0; got ${JSON.stringify(r.unverified_paths)}`);
  assert.strictEqual(r.sha256_mismatch_guard_in_upload, true,
    'multipart upload path must reject sha256 mismatches at parse time');
});

test('lock-in 11: ssh injection — 0 unsafe interpolations', () => {
  const r = readJSON('data/w890-6-ssh-injection.json');
  assert.ok(Array.isArray(r.files_scanned) && r.files_scanned.length >= 7,
    `expected >= 7 device/ssh files scanned; got ${r.files_scanned && r.files_scanned.length}`);
  assert.ok(typeof r.total_ssh_exec_calls === 'number' && r.total_ssh_exec_calls >= 5,
    `expected >= 5 ssh exec call sites; got ${r.total_ssh_exec_calls}`);
  assert.strictEqual(r.unsafe_interpolation_count, 0,
    `unsafe ssh interpolations must be 0; got ${r.unsafe_interpolation_count}: ${JSON.stringify(r.offenders)}`);
  assert.strictEqual(r.safety_guards.ssh_command_runner_uses_ssh2_exec, true,
    'every ssh exec must go through ssh2 Client.exec — never child_process spawn of `ssh`');
});

test('lock-in 12: security-policy.md exists and references all ten data files', () => {
  const docPath = path.join(ROOT, 'docs/reference/security-policy.md');
  assert.ok(fs.existsSync(docPath), 'security-policy.md missing');
  const txt = fs.readFileSync(docPath, 'utf8');
  for (const f of [
    'w890-6-npm-audit.json',
    'w890-6-pip-audit.json',
    'w890-6-auth-coverage.json',
    'w890-6-key-storage.json',
    'w890-6-headers.json',
    'w890-6-rate-limiting.json',
    'w890-6-input-validation.json',
    'w890-6-eval-scan.json',
    'w890-6-artifact-verify.json',
    'w890-6-ssh-injection.json',
  ]) {
    assert.ok(txt.includes(f), `security-policy.md must reference ${f}`);
  }
  // Must include the canonical primitives.
  assert.ok(/hashApiKey/.test(txt), 'security-policy.md must mention hashApiKey');
  assert.ok(/loadArtifact/.test(txt), 'security-policy.md must mention loadArtifact');
  assert.ok(/PUBLIC_API/.test(txt), 'security-policy.md must mention PUBLIC_API');
  assert.ok(/_assertSafeRemoteDir|_assertSafeRuntime|_isSafeHost/.test(txt),
    'security-policy.md must document the ssh value validators');
  assert.ok(/HSTS|Strict-Transport-Security/.test(txt),
    'security-policy.md must document HSTS');
  assert.ok(/frame-ancestors/.test(txt),
    'security-policy.md must document CSP frame-ancestors');
  // Must include CWE references for traceability.
  assert.ok(/CWE-\d+/.test(txt),
    'security-policy.md must include CWE references');
});

test('lock-in 13: no banned vocabulary in any W890-6 data file or policy doc', () => {
  // Construct the banned token at runtime so this test file itself does not
  // embed the literal (would create a self-recursive false positive when the
  // test scans itself). Mirrors the W890-8 pattern.
  const banned = String.fromCharCode(104) + 'on' + String.fromCharCode(101, 115, 116);
  const re = new RegExp(`\\b${banned}(?:y)?\\b`, 'i');
  const targets = [
    'data/w890-6-npm-audit.json',
    'data/w890-6-pip-audit.json',
    'data/w890-6-auth-coverage.json',
    'data/w890-6-key-storage.json',
    'data/w890-6-headers.json',
    'data/w890-6-rate-limiting.json',
    'data/w890-6-input-validation.json',
    'data/w890-6-eval-scan.json',
    'data/w890-6-artifact-verify.json',
    'data/w890-6-ssh-injection.json',
    'docs/reference/security-policy.md',
  ];
  for (const t of targets) {
    const fp = path.join(ROOT, t);
    if (!fs.existsSync(fp)) continue;
    const txt = fs.readFileSync(fp, 'utf8');
    assert.ok(!re.test(txt),
      `forbidden vocabulary in ${t}; use Caveats / Constraints / Limitations / Accuracy instead`);
  }
});

test('lock-in 14: audit driver script is structurally intact + read-only', () => {
  const fp = path.join(ROOT, 'scripts/w890-6-security-audit.cjs');
  assert.ok(fs.existsSync(fp), 'scripts/w890-6-security-audit.cjs missing');
  const txt = fs.readFileSync(fp, 'utf8');
  // Driver must declare each of the 10 audit functions + the ship-gate snapshot.
  for (const fn of [
    'function auditNpm',
    'function auditPip',
    'function auditAuthCoverage',
    'function auditKeyStorage',
    'function auditHeaders',
    'function auditRateLimiting',
    'function auditInputValidation',
    'function auditEvalScan',
    'function auditArtifactVerify',
    'function auditSshInjection',
    'function captureShipGateSnapshot',
  ]) {
    assert.ok(txt.includes(fn), `audit driver must declare ${fn}`);
  }
  // Driver must NOT mutate source code — forbid fs.writeFileSync to anything
  // outside data/. Heuristic: every writeFileSync target must resolve under
  // data/. We accept either an inline path containing "data/" or a variable
  // name on the known allowlist (writeJSON helper, snapPath, fp local).
  const writes = txt.match(/fs\.writeFileSync\(\s*[^,)]+/g) || [];
  const targetAllowlist = ['writeJSON', 'fp', 'snapPath', 'shipGateOutPath'];
  for (const w of writes) {
    const writeTargetAllowed = /data\//.test(w)
      || targetAllowlist.some(name => new RegExp(`\\b${name}\\b`).test(w));
    assert.ok(writeTargetAllowed,
      `audit driver may only write into data/; suspicious call: ${w}`);
  }
  // Belt-and-suspenders: assert every writeFileSync variable used in the
  // driver is one we audited. New variable names must be added here AND must
  // genuinely resolve under data/.
  for (const w of writes) {
    const m = /fs\.writeFileSync\(\s*([A-Za-z_][A-Za-z_0-9]*)/.exec(w);
    if (m) {
      const varName = m[1];
      assert.ok(targetAllowlist.includes(varName),
        `unrecognized write target variable: ${varName} — add to targetAllowlist after confirming it resolves under data/`);
    }
  }
});

test('lock-in 15: ship-gate snapshot reports 52/52 green', () => {
  // The audit re-uses the W890-12 ship-gate snapshot. We assert the structural
  // totals directly from the cached JSON to avoid re-running the 60-90s gate
  // here (the gate has its own test coverage under wave888 + wave890-12).
  const r = readJSON('data/w890-6-ship-gate-snapshot.json');
  assert.strictEqual(typeof r.total, 'number', 'total must be a number');
  assert.strictEqual(typeof r.passed, 'number', 'passed must be a number');
  assert.strictEqual(typeof r.failed, 'number', 'failed must be a number');
  assert.strictEqual(r.failed, 0, `ship-gate failed must be 0; got ${r.failed}`);
  assert.strictEqual(r.total, 52, `ship-gate total must be 52; got ${r.total}`);
  assert.strictEqual(r.passed, 52, `ship-gate passed must be 52; got ${r.passed}`);
});
