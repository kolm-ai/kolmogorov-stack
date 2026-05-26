// W890-13 — deployment / release lock-ins.
//
// Thirteen invariants ratify the audit produced by the W890-13 sub-wave:
//   1. data/w890-13-deploy-pipeline.json: automated === true
//   2. docs/runbook-rollback.md exists + names Vercel + Railway + <5min
//   3. data/w890-13-health-endpoint.json: shape_ok === true + every required field present
//   4. data/w890-13-graceful-shutdown.json: server.js has SIGTERM + close + fallback
//   5. data/w890-13-zero-downtime.json: railway healthcheck + docker healthcheck wired
//   6. data/w890-13-env-parity.json: parity_ok OR documented gap
//   7. data/w890-13-secrets-in-repo.json: secrets_in_repo === 0
//   8. data/w890-13-secrets-in-repo.json: tracked_env_files / *.pem / *.key all empty
//   9. data/w890-13-container.json: dockerfile + gateway pass every row
//  10. data/w890-13-lockfiles.json: npm lockfile committed + exists
//  11. data/w890-13-lockfiles.json: prod-critical pip files use == pins
//  12. docs/reference/deployment-policy.md exists + cross-links siblings
//  13. ship-gate snapshot reports 52/52 green

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}
function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('W890-13 #1 — deploy is automated (Vercel OR Railway OR GHA on push)', () => {
  const r = readJSON('data/w890-13-deploy-pipeline.json');
  assert.equal(r.automated, true,
    `auto-deploy must be wired via at least one of Vercel / Railway / GHA on push; detail: vercel.well_formed=${r.vercel.well_formed}, railway.well_formed=${r.railway.well_formed}`);
  // At least one of Vercel + Railway must be present (the live prod path).
  assert.ok(r.vercel.present || r.railway.present,
    'either vercel.json or railway.toml must be present');
});

test('W890-13 #2 — rollback runbook present + names Vercel + Railway + <5min + git fallback', () => {
  const r = readJSON('data/w890-13-rollback.json');
  assert.equal(r.runbook_present, true,
    'docs/runbook-rollback.md must exist');
  assert.equal(r.has_vercel_recipe, true,
    'rollback runbook must name a Vercel rollback recipe (`vercel rollback` / `vercel alias` / dashboard link)');
  assert.equal(r.has_railway_recipe, true,
    'rollback runbook must name a Railway rollback recipe');
  assert.equal(r.has_time_budget_under_5min, true,
    'rollback runbook must name a <5min time budget');
  assert.equal(r.has_git_fallback, true,
    'rollback runbook must name a git revert / git reset fallback path');
  assert.equal(r.time_budget_minutes, 5,
    'time budget must be 5 minutes');
});

test('W890-13 #3 — /health endpoint returns ok + version + git + uptime_s + gateway + capture_store + signing_key', () => {
  const r = readJSON('data/w890-13-health-endpoint.json');
  assert.equal(r.probed, true,
    `live /health probe must succeed; status=${r.status_code} error=${r.error}`);
  assert.equal(r.shape_ok, true,
    `/health body must contain every required field; missing=${JSON.stringify(r.missing_fields)}`);
  for (const f of ['ok', 'version', 'git', 'uptime_s', 'gateway', 'capture_store', 'signing_key']) {
    assert.ok(r.present_fields.includes(f),
      `/health body must include field '${f}'; got ${JSON.stringify(r.present_fields)}`);
  }
  // ok is true; uptime_s is a number; capture_store is one of ok/degraded/unavailable.
  assert.equal(r.body_sample.ok, true, '/health.ok must be true');
  assert.equal(typeof r.body_sample.uptime_s, 'number', '/health.uptime_s must be a number');
  assert.ok(['ok', 'degraded', 'unavailable'].includes(r.body_sample.capture_store),
    `/health.capture_store must be ok|degraded|unavailable; got ${r.body_sample.capture_store}`);
  assert.ok(['loaded', 'missing', 'disabled', 'unknown'].includes(r.body_sample.signing_key),
    `/health.signing_key must be loaded|missing|disabled|unknown; got ${r.body_sample.signing_key}`);
});

test('W890-13 #4 — graceful shutdown: SIGTERM handler + server.close + fallback timeout in server.js', () => {
  const r = readJSON('data/w890-13-graceful-shutdown.json');
  assert.equal(r.server_js.sigterm_handler, true,
    'server.js must register a SIGTERM handler');
  assert.equal(r.server_js.sigint_handler, true,
    'server.js must register a SIGINT handler');
  assert.equal(r.server_js.server_close_invoked, true,
    'server.js SIGTERM handler must call server.close()');
  assert.equal(r.server_js.fallback_timeout_present, true,
    'server.js SIGTERM handler must have a setTimeout fallback (10s hard exit)');
  assert.equal(r.server_js.unhandled_rejection_handler, true,
    'server.js must register an unhandledRejection handler (W890-3)');
  assert.equal(r.server_js.uncaught_exception_handler, true,
    'server.js must register an uncaughtException handler (W890-3)');
});

test('W890-13 #5 — zero-downtime: Railway healthcheck wired + Dockerfile HEALTHCHECK present', () => {
  const r = readJSON('data/w890-13-zero-downtime.json');
  assert.equal(r.railway.healthcheck_path_set, true,
    'railway.toml must set healthcheckPath = "/health"');
  assert.equal(r.railway.healthcheck_timeout_set, true,
    'railway.toml must set healthcheckTimeout');
  assert.equal(r.docker_image.healthcheck_directive, true,
    'Dockerfile must carry a HEALTHCHECK directive');
  assert.equal(r.docker_image.start_period_set, true,
    'Dockerfile HEALTHCHECK must include --start-period so cold starts do not falsely fail');
  assert.equal(r.new_instance_starts_before_old_stops, true,
    'zero-downtime contract: new instance must start before old one stops (platform-managed)');
});

test('W890-13 #6 — env parity holds after documented-prod-only exclusion + platform-var filter', () => {
  const r = readJSON('data/w890-13-env-parity.json');
  assert.ok(typeof r.example_key_count === 'number', 'example_key_count must be a number');
  assert.ok(r.example_key_count > 0, '.env.example must declare at least one variable');
  assert.equal(r.parity_ok, true,
    `env parity must hold after platform-var filter + expected_prod_only exclusion; only_in_dev=${JSON.stringify(r.only_in_dev)}, unexpected_only_in_prod=${JSON.stringify(r.unexpected_only_in_prod)}`);
  assert.ok(Array.isArray(r.expected_prod_only), 'expected_prod_only must be a documented array');
  assert.equal(r.unexpected_only_in_prod.length, 0,
    `no unexpected prod-only variables permitted; got ${JSON.stringify(r.unexpected_only_in_prod)}`);
});

test('W890-13 #7 — secrets_in_repo === 0 (git history grep, with fixture safelist)', () => {
  const r = readJSON('data/w890-13-secrets-in-repo.json');
  assert.equal(r.git_history_scanned, true,
    'git log -p --all scan must complete');
  assert.equal(r.secrets_in_repo, 0,
    `secrets_in_repo must be 0; got ${r.secrets_in_repo} (git log -p grep of provider key patterns)`);
});

test('W890-13 #8 — no committed .env / *.pem / *.key files outside the documented template safelist', () => {
  const r = readJSON('data/w890-13-secrets-in-repo.json');
  assert.equal(r.tracked_env_files.length, 0,
    `no .env file may be tracked; got ${JSON.stringify(r.tracked_env_files)}`);
  assert.equal(r.tracked_pem_files.length, 0,
    `no .pem file may be tracked; got ${JSON.stringify(r.tracked_pem_files)}`);
  assert.equal(r.tracked_key_files.length, 0,
    `no .key file may be tracked; got ${JSON.stringify(r.tracked_key_files)}`);
});

test('W890-13 #9 — Dockerfile + Dockerfile.gateway pass slim/non-root/HEALTHCHECK/signal-handling', () => {
  const r = readJSON('data/w890-13-container.json');
  assert.equal(r.dockerfile.present, true, 'Dockerfile must exist');
  assert.equal(r.dockerfile.uses_slim_base, true,
    'Dockerfile must use node:22-alpine or node:22-slim base');
  assert.equal(r.dockerfile.non_root_user, true,
    'Dockerfile must drop to USER node before CMD');
  assert.equal(r.dockerfile.healthcheck_directive, true,
    'Dockerfile must carry HEALTHCHECK');
  assert.equal(r.dockerfile.signal_handling, true,
    'Dockerfile must use tini PID 1 OR --init OR exec-form CMD for SIGTERM forwarding');
  assert.equal(r.dockerfile.cmd_well_formed, true,
    'Dockerfile CMD must use exec form ["node", ...] OR ["/sbin/tini", "--"]');

  assert.equal(r.dockerfile_gateway.present, true, 'Dockerfile.gateway must exist');
  assert.equal(r.dockerfile_gateway.uses_slim_base, true,
    'Dockerfile.gateway must use slim base');
  assert.equal(r.dockerfile_gateway.non_root_user, true,
    'Dockerfile.gateway must drop to USER node');
  assert.equal(r.dockerfile_gateway.healthcheck_directive, true,
    'Dockerfile.gateway must carry HEALTHCHECK');
  assert.equal(r.dockerfile_gateway.signal_handling, true,
    'Dockerfile.gateway must use tini PID 1');

  assert.equal(r.all_pass, true,
    'every container-image invariant must pass');
});

test('W890-13 #10 — package-lock.json exists + is committed', () => {
  const r = readJSON('data/w890-13-lockfiles.json');
  assert.equal(r.npm.exists, true, 'package-lock.json must exist at repo root');
  assert.equal(r.npm.committed, true,
    'package-lock.json must be tracked by git');
  assert.ok(r.npm.size_bytes > 1000,
    `package-lock.json must be non-trivial; got ${r.npm.size_bytes} bytes`);
});

test('W890-13 #11 — production-critical pip files use == pins', () => {
  const r = readJSON('data/w890-13-lockfiles.json');
  const replicate = r.python_requirements.find(p => p.path === 'apps/replicate/requirements.txt');
  const bench = r.python_requirements.find(p => p.path === 'bench/requirements.txt');
  assert.ok(replicate && replicate.exists, 'apps/replicate/requirements.txt must exist');
  assert.equal(replicate.floating_count, 0,
    `apps/replicate must pin every dep with ==; floating=${JSON.stringify(replicate.floating)}`);
  assert.ok(bench && bench.exists, 'bench/requirements.txt must exist');
  assert.equal(bench.floating_count, 0,
    `bench must pin every dep with ==; floating=${JSON.stringify(bench.floating)}`);
});

test('W890-13 #12 — deployment-policy.md exists + cross-links sibling policies + names the runbook', () => {
  const docPath = path.join(ROOT, 'docs/reference/deployment-policy.md');
  assert.ok(fs.existsSync(docPath), 'docs/reference/deployment-policy.md missing');
  const txt = fs.readFileSync(docPath, 'utf8');
  // Cross-links to sibling policies.
  assert.ok(/codebase-organization\.md/.test(txt), 'must cross-link codebase-organization.md');
  assert.ok(/code-quality-policy\.md/.test(txt), 'must cross-link code-quality-policy.md');
  assert.ok(/error-handling-policy\.md/.test(txt), 'must cross-link error-handling-policy.md');
  assert.ok(/logging-policy\.md/.test(txt), 'must cross-link logging-policy.md');
  assert.ok(/configuration-policy\.md/.test(txt), 'must cross-link configuration-policy.md');
  assert.ok(/storage-policy\.md/.test(txt), 'must cross-link storage-policy.md');
  assert.ok(/documentation-policy\.md/.test(txt), 'must cross-link documentation-policy.md');
  assert.ok(/runbook-rollback\.md/.test(txt), 'must cross-link runbook-rollback.md');
  // Required topic coverage.
  assert.ok(/Deploy pipeline/i.test(txt), 'must describe the deploy pipeline');
  assert.ok(/Rollback/i.test(txt), 'must describe rollback');
  assert.ok(/health/i.test(txt) && /capture_store/.test(txt) && /signing_key/.test(txt),
    'must describe the /health shape including capture_store + signing_key');
  assert.ok(/Graceful shutdown/i.test(txt), 'must describe graceful shutdown');
  assert.ok(/Zero-downtime/i.test(txt), 'must describe zero-downtime deployment');
  assert.ok(/Environment parity/i.test(txt), 'must describe env parity');
  assert.ok(/Secrets management/i.test(txt) || /secrets posture/i.test(txt),
    'must describe secrets management');
  assert.ok(/Container image/i.test(txt), 'must describe container image baseline');
  assert.ok(/Lock files/i.test(txt) || /Lock-file/.test(txt), 'must describe lock files');
  // All ten data files referenced.
  for (const f of [
    'w890-13-deploy-pipeline.json',
    'w890-13-rollback.json',
    'w890-13-health-endpoint.json',
    'w890-13-graceful-shutdown.json',
    'w890-13-zero-downtime.json',
    'w890-13-env-parity.json',
    'w890-13-secrets-in-repo.json',
    'w890-13-container.json',
    'w890-13-lockfiles.json',
    'w890-13-ship-gate-snapshot.json',
  ]) {
    assert.ok(txt.includes(f), `deployment-policy.md must reference ${f}`);
  }
});

test('W890-13 #13 — ship-gate snapshot reports 52/52 green', () => {
  // Snapshot pattern mirrors every prior W890 sub-wave: nested `node --test`
  // is not reliable on Node 22+, so we read the snapshot captured at audit
  // time. The driver refreshes the snapshot; this lock-in validates it.
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/w890-13-ship-gate-snapshot.json'), 'utf8'));
  assert.equal(snap.total, 52,
    `ship-gate total must be 52; got ${snap.total}`);
  assert.equal(snap.passed, 52,
    `ship-gate passed must be 52; got ${snap.passed}`);
  assert.equal(snap.failed, 0,
    `ship-gate failed must be 0; got ${snap.failed}`);
});

test('W890-13 #14 — no banned vocabulary in any W890-13 data file or policy doc', () => {
  // Construct the banned token at runtime so this file itself does not embed
  // the literal (avoids self-recursive false positive). Mirrors prior W890-* tests.
  const banned = String.fromCharCode(104) + 'on' + String.fromCharCode(101, 115, 116);
  const re = new RegExp(`\\b${banned}(?:y)?\\b`, 'i');
  const targets = [
    'data/w890-13-deploy-pipeline.json',
    'data/w890-13-rollback.json',
    'data/w890-13-health-endpoint.json',
    'data/w890-13-graceful-shutdown.json',
    'data/w890-13-zero-downtime.json',
    'data/w890-13-env-parity.json',
    'data/w890-13-secrets-in-repo.json',
    'data/w890-13-container.json',
    'data/w890-13-lockfiles.json',
    'docs/reference/deployment-policy.md',
    'docs/runbook-rollback.md',
  ];
  for (const t of targets) {
    const fp = path.join(ROOT, t);
    if (!fs.existsSync(fp)) continue;
    const txt = fs.readFileSync(fp, 'utf8');
    assert.ok(!re.test(txt),
      `forbidden vocabulary in ${t}; use Caveats / Constraints / Limitations / Accuracy instead`);
  }
});
