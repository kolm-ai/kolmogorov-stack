// W455 — per-prompt loss telemetry for distill runs.
//
// Closes the audit P1 "per-prompt loss telemetry to /account/distill-runs"
// surface. The contract:
//   - src/distill-pipeline.js writes ~/.kolm/distill-runs/run_*/run-meta.json
//     and progress.jsonl as the worker iterates.
//   - listDistillRuns({tenant_id}) filters by tenant (fail closed on mismatch).
//   - readDistillRun(id, {tenant_id}) validates the id regex and returns the
//     meta + progress + manifest envelope (or null on tenant mismatch).
//   - GET /v1/distill/runs        list (auth-gated, ?limit, ?namespace)
//   - GET /v1/distill/runs/:id    detail (auth-gated, 404 on miss)
//   - cli/kolm.js wires `kolm distill runs` ahead of --from-captures dispatch.
//   - public/account/distill-runs.html exists with the dr-rows table.
//   - sw.js CACHE slug includes wave455 + distill-runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// =============================================================================
// 1) distill-pipeline.js exports listDistillRuns + readDistillRun
// =============================================================================

test('W455 #1 — distill-pipeline.js exports listDistillRuns + readDistillRun', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'distill-pipeline.js'), 'utf8');
  assert.match(src, /export\s+function\s+listDistillRuns\s*\(/, 'listDistillRuns must be exported');
  assert.match(src, /export\s+function\s+readDistillRun\s*\(/, 'readDistillRun must be exported');
  // run-meta.json + progress.jsonl writes happen inside distill().
  assert.match(src, /run-meta\.json/, 'must persist run-meta.json per run');
  assert.match(src, /progress\.jsonl/, 'must persist progress.jsonl per run');
  // The id-regex chokepoint protects against path traversal in readDistillRun.
  assert.match(src, /\/\^run_\[a-z0-9_\]\+\$\/i/, 'readDistillRun must validate id with /^run_[a-z0-9_]+$/i');
});

// =============================================================================
// 2) listDistillRuns tenant-scopes the result
// =============================================================================

test('W455 #2 — listDistillRuns filters by tenant_id (fail closed)', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w455-'));
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  try {
    const runsDir = path.join(tmpdir, '.kolm', 'distill-runs');
    fs.mkdirSync(runsDir, { recursive: true });
    // Two runs, one per tenant.
    for (const [name, tenant] of [['run_alpha_1', 'tenant-a'], ['run_beta_1', 'tenant-b']]) {
      const d = path.join(runsDir, name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'run-meta.json'), JSON.stringify({
        job_id: 'jid-' + name,
        tenant_id: tenant,
        namespace: 'ns-' + tenant,
        student_base: 'phi-3-mini',
        pipeline_mode: 'stub',
        pair_count: 10,
        worker_mode: 'stub',
        teacher: { vendor: 'local', model: 'mock' },
        created_at: new Date().toISOString(),
      }));
      fs.writeFileSync(path.join(d, 'progress.jsonl'),
        '{"i":1,"step":1,"loss":2.5,"k_score":0.10}\n' +
        '{"i":2,"step":2,"loss":1.2,"k_score":0.50}\n');
    }
    const { listDistillRuns } = await import('../src/distill-pipeline.js?w455a=' + Date.now());
    const aList = listDistillRuns({ tenant_id: 'tenant-a' });
    const bList = listDistillRuns({ tenant_id: 'tenant-b' });
    const xList = listDistillRuns({ tenant_id: 'tenant-x' });
    assert.equal(aList.length, 1, 'tenant-a sees exactly its own run');
    assert.equal(bList.length, 1, 'tenant-b sees exactly its own run');
    assert.equal(xList.length, 0, 'an unrelated tenant must see nothing (fail closed)');
    assert.equal(aList[0].id, 'run_alpha_1');
    assert.equal(aList[0].namespace, 'ns-tenant-a');
    assert.equal(aList[0].step_count, 2);
    assert.equal(aList[0].loss_final, 1.2);
    assert.equal(aList[0].k_final, 0.50);
  } finally {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 3) readDistillRun rejects path-traversal-ish ids
// =============================================================================

test('W455 #3 — readDistillRun rejects invalid run ids', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w455-'));
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  try {
    const { readDistillRun } = await import('../src/distill-pipeline.js?w455b=' + Date.now());
    // None of these should match /^run_[a-z0-9_]+$/i, so they all return null.
    for (const bad of ['', '..', '../etc/passwd', 'run_../escape', 'run-with-dash', '/abs/path']) {
      const r = readDistillRun(bad, { tenant_id: 'whoever' });
      assert.equal(r, null, 'id "' + bad + '" must be rejected');
    }
  } finally {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 4) readDistillRun returns the meta + progress envelope for the right tenant
// =============================================================================

test('W455 #4 — readDistillRun returns full envelope for owner; null cross-tenant', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w455-'));
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  try {
    const runsDir = path.join(tmpdir, '.kolm', 'distill-runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const d = path.join(runsDir, 'run_z_42');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'run-meta.json'), JSON.stringify({
      job_id: 'jz',
      tenant_id: 'tenant-z',
      namespace: 'nz',
      student_base: 'phi-3-mini',
      pipeline_mode: 'stub',
      pair_count: 4,
      worker_mode: 'stub',
      teacher: { vendor: 'local', model: 'mock' },
      created_at: '2026-05-19T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(d, 'progress.jsonl'),
      '{"i":1,"step":1,"loss":3.1,"k_score":0.05}\n' +
      '{"i":2,"step":2,"loss":1.8,"k_score":0.40}\n' +
      '{"i":3,"step":3,"loss":0.9,"k_score":0.80}\n');
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ artifact_hash: 'sha256:abc123' }));
    fs.writeFileSync(path.join(d, 'distill.log'), 'started\nstep 1 ok\nstep 2 ok\nstep 3 ok\ndone\n');
    const { readDistillRun } = await import('../src/distill-pipeline.js?w455c=' + Date.now());
    const ok = readDistillRun('run_z_42', { tenant_id: 'tenant-z' });
    assert.ok(ok, 'owner must receive a run record');
    assert.equal(ok.id, 'run_z_42');
    assert.equal(ok.meta.namespace, 'nz');
    assert.equal(Array.isArray(ok.progress), true);
    assert.equal(ok.progress.length, 3, 'progress must include every step recorded');
    assert.equal(ok.manifest.artifact_hash, 'sha256:abc123');
    assert.match(String(ok.log_tail || ''), /done/, 'log_tail must include the tail of distill.log');

    const cross = readDistillRun('run_z_42', { tenant_id: 'tenant-other' });
    assert.equal(cross, null, 'cross-tenant lookup must fail closed');
  } finally {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 5) Router wires /v1/distill/runs + /v1/distill/runs/:id
// =============================================================================

test('W455 #5 — src/router.js wires GET /v1/distill/runs and /:id', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  assert.match(src, /\/v1\/distill\/runs(?!\/)/, 'list route must be present');
  assert.match(src, /\/v1\/distill\/runs\/:id/, 'detail route must be present');
  // Both routes pass through authMiddleware.
  assert.match(src, /r\.get\(['"]\/v1\/distill\/runs['"],\s*authMiddleware/,
    'list route must be auth-gated');
  assert.match(src, /r\.get\(['"]\/v1\/distill\/runs\/:id['"],\s*authMiddleware/,
    'detail route must be auth-gated');
});

// =============================================================================
// 6) /v1/distill/runs is auth-gated (401 without an api key)
// =============================================================================

async function buildApp() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w455app-'));
  process.env.KOLM_DATA_DIR = path.join(tmpdir, '.kolm');
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  process.env.KOLM_ENV = 'test';
  const { buildRouter } = await import('../src/router.js?w455app=' + Date.now());
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(buildRouter());
  return { app, tmpdir };
}

async function listen(app) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('W455 #6 — GET /v1/distill/runs requires auth', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const r = await fetch(`${base}/v1/distill/runs`);
    assert.equal(r.status, 401);
    const j = await r.json();
    assert.ok(/missing api key|auth required/i.test(String(j.error || '')),
      'must surface an auth-error string, got: ' + JSON.stringify(j));
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W455 #7 — GET /v1/distill/runs/:id rejects malformed id', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const { provisionAnonTenant } = await import('../src/auth.js');
    const tenant = await provisionAnonTenant();
    const r = await fetch(`${base}/v1/distill/runs/not-a-run-id`, {
      headers: { authorization: `Bearer ${tenant.api_key}` },
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, 'invalid_run_id');
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 8) CLI wires `kolm distill runs`
// =============================================================================

test('W455 #8 — cli/kolm.js wires cmdDistillRuns ahead of --from-captures', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.match(cli, /async\s+function\s+cmdDistillRuns\s*\(/, 'cmdDistillRuns must exist');
  // Dispatch must check args[0] === 'runs' before the from-captures branch
  // (so `kolm distill runs --from-captures` would not be hijacked).
  const idxRuns = cli.indexOf("args[0] === 'runs'");
  const idxFromCaptures = cli.indexOf("'--from-captures'");
  assert.ok(idxRuns > 0, 'must dispatch on args[0] === "runs"');
  assert.ok(idxFromCaptures > idxRuns,
    '`runs` dispatch must come before the --from-captures dispatch (it does not, runs idx=' + idxRuns + ', from-captures idx=' + idxFromCaptures + ')');
  // Completion is wired.
  assert.match(cli, /distill:\s*\[['"]runs['"]\]/,
    'COMPLETION_SUBS.distill must include "runs"');
  // HELP advertises the subcommand.
  assert.match(cli, /kolm distill runs <run_id>/,
    'HELP.distill must document `kolm distill runs <run_id>`');
});

// =============================================================================
// 9) /account/distill-runs page exists and has the right shape
// =============================================================================

test('W455 #9 — /account/distill-runs.html exists with the loss-curve UI', () => {
  const p = path.join(REPO_ROOT, 'public', 'account', 'distill-runs.html');
  assert.ok(fs.existsSync(p), 'page must exist');
  const html = fs.readFileSync(p, 'utf8');
  // Canonical + sidebar wiring.
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/account\/distill-runs">/);
  assert.match(html, /aria-current=["']?page["']?[^>]*>Distill runs/, 'sidebar must mark this page current');
  // The dr-rows tbody is the lock-in marker the loader writes to.
  assert.match(html, /id="dr-rows"/);
  // Page fetches /v1/distill/runs.
  assert.match(html, /\/v1\/distill\/runs/, 'page must call the list route');
  // SVG sparkline routine present (loss + k_score curves).
  assert.match(html, /function sparkline\(/);
  // vercel.json rewrite present.
  const vercel = fs.readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8');
  assert.match(vercel, /"source":\s*"\/account\/distill-runs"/);
});

// =============================================================================
// 10) sw.js CACHE slug includes wave455
// =============================================================================

test('W455 #10 — sw.js CACHE slug references the W455+ audit-finish family', () => {
  // Relaxed past wave455 once W456+ landed: the slug must reference one of the
  // audit-finish family waves (W455 through W460). Matches the W446 #5 family
  // pattern so the next wave bump does not auto-fail this assertion.
  const sw = fs.readFileSync(path.join(REPO_ROOT, 'public', 'sw.js'), 'utf8');
  const m = sw.match(/const CACHE = '([^']+)'/);
  assert.ok(m, 'sw.js must export a CACHE const');
  const slug = m[1];
  assert.match(slug, /kolm-v7-2026-05-19-/, 'slug must follow the v7-date convention');
  const family = ['wave455', 'wave456', 'wave457', 'wave458', 'wave459', 'wave460'];
  assert.ok(family.some((w) => slug.includes(w)), 'sw.js CACHE slug must reference the W455+ audit-finish family, got: ' + slug);
});
