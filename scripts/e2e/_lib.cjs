// W888-H — shared e2e helpers.
//
// Common surface used by persona-indie.cjs / persona-enterprise.cjs /
// persona-no-gpu.cjs / full-loop.cjs. Keep this file dependency-free (only
// node:* + the repo's own ESM modules) so e2e scripts stay portable across
// CI environments that lack devDependencies.
//
// Contract:
//   const lib = require('./_lib.cjs');
//   const ctx = await lib.setupIsolatedServer({ tenantPlan: 'pro' });
//   try { ... } finally { await lib.teardown(ctx); }
//
// Each persona script wraps its body in this setup/teardown pair so server
// state (KOLM_DATA_DIR, capture-store driver, event-store driver) never
// leaks between runs. Mirrors the W470 P0-1 setIsolatedHome chokepoint
// from tests/wave409b — same env knobs, same module-reset wiring.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;
const KOLM_CLI = path.join(ROOT, 'cli', 'kolm.js');

// ---------------------------------------------------------------------------
// Step + envelope helpers — every persona records steps in this shape so the
// downstream JSON aggregator in cmdTestE2E + tests can iterate uniformly.
// ---------------------------------------------------------------------------

function stepStart(persona, label) {
  return { persona, label, ok: false, started_at: Date.now(), elapsed_ms: 0, detail: '' };
}
function stepOk(step, detail) {
  step.ok = true;
  step.elapsed_ms = Date.now() - step.started_at;
  step.detail = detail || 'ok';
  return step;
}
function stepFail(step, err) {
  step.ok = false;
  step.elapsed_ms = Date.now() - step.started_at;
  step.detail = err && err.message ? err.message : String(err);
  if (err && err.stack) step.stack = String(err.stack).split('\n').slice(0, 3).join('\n');
  return step;
}
function stepSkip(step, reason, installHint) {
  step.ok = true; // skip is not a failure for the orchestrator
  step.skipped = true;
  step.elapsed_ms = Date.now() - step.started_at;
  step.detail = reason || 'skipped';
  if (installHint) step.install_hint = installHint;
  return step;
}

// ---------------------------------------------------------------------------
// Skip-envelope helper — every persona's "missing env" exit path emits this.
// Caller exits 2 after emitting; cmdTestE2E + ship-gate treat exit 2 as skip.
// ---------------------------------------------------------------------------

function emitSkip(reason, installHint, opts = {}) {
  const envelope = {
    persona: opts.persona || null,
    skipped: true,
    reason,
    install_hint: installHint,
    steps: opts.steps || [],
    elapsed_ms: opts.elapsed_ms || 0,
  };
  process.stdout.write(JSON.stringify(envelope) + '\n');
  return envelope;
}

function emitReport(persona, steps, opts = {}) {
  const allOk = steps.every((s) => s.ok);
  const envelope = {
    persona,
    ok: allOk,
    steps,
    counts: {
      total: steps.length,
      pass: steps.filter((s) => s.ok && !s.skipped).length,
      skipped: steps.filter((s) => s.skipped).length,
      fail: steps.filter((s) => !s.ok).length,
    },
    elapsed_ms: opts.elapsed_ms || steps.reduce((a, s) => a + (s.elapsed_ms || 0), 0),
    started_at: opts.started_at || null,
    finished_at: Date.now(),
  };
  process.stdout.write(JSON.stringify(envelope) + '\n');
  return envelope;
}

// ---------------------------------------------------------------------------
// Isolated home + server boot. Same chokepoint pattern as W470 P0-1.
// Returns ctx { base, port, dataDir, home, apiKey, tenantId, proc, scratch }.
// ---------------------------------------------------------------------------

async function freePort() {
  const net = require('node:net');
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function waitForHealth(base, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const req = http.get(base + '/health', (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 200);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 200);
      });
      req.setTimeout(1500, () => req.destroy());
    };
    tick();
  });
}

async function setupIsolatedServer(opts = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-e2e-'));
  const dataDir = path.join(scratch, 'data');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const tenantId = opts.tenantId || 't_e2e_' + crypto.randomBytes(4).toString('hex');
  const plan = opts.tenantPlan || 'pro';
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    {
      id: tenantId,
      name: opts.tenantName || 'e2e',
      email: 'e2e@local.test',
      plan,
      quota: opts.quota || 5_000_000,
      seats: opts.seats || 1,
      created_at: new Date().toISOString(),
    },
  ]), 'utf8');

  // 32-byte hex key. crypto.randomBytes → constant time vs hashing the same
  // string each run; tests pin shape not value.
  const apiKey = 'ks_e2e_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    {
      id: 'apik_e2e_' + crypto.randomBytes(4).toString('hex'),
      tenant_id: tenantId,
      hash: keyHash,
      label: 'e2e',
      kind: 'user',
      created_at: new Date().toISOString(),
      revoked_at: null,
    },
  ]), 'utf8');

  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    KOLM_DATA_DIR: dataDir,
    KOLM_HOME: home,
    HOME: home,
    USERPROFILE: home,
    KOLM_STORE_DRIVER: 'json',
    KOLM_ALLOW_JSON_STORE: 'true',
    KOLM_RATE_LIMIT_DISABLED: '1',
    // Force fixture/mock mode — no live provider calls.
    KOLM_CONNECTOR_FIXTURE: '1',
    KOLM_RECIPE_RECEIPT_SECRET: 'e2e-secret-32-chars-minimum-len-padding',
    DEFAULT_TENANT: 'e2e',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    ...(opts.env || {}),
  };

  const proc = spawn(NODE, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});

  const base = `http://127.0.0.1:${port}`;
  const up = await waitForHealth(base, 30_000);
  if (!up) {
    try { proc.kill(); } catch (_) {} // deliberate: cleanup
    throw new Error('isolated server failed to come up at ' + base);
  }

  return { base, port, dataDir, home, scratch, apiKey, tenantId, proc, env };
}

async function teardown(ctx) {
  if (!ctx) return;
  if (ctx.proc) {
    try { ctx.proc.kill('SIGTERM'); } catch (_) {} // deliberate: cleanup
    await new Promise((r) => {
      const t = setTimeout(() => { try { ctx.proc.kill('SIGKILL'); } catch (_) {} r(); }, 2000); // deliberate: cleanup
      ctx.proc.once('exit', () => { clearTimeout(t); r(); });
    });
  }
  if (ctx.scratch) {
    try { fs.rmSync(ctx.scratch, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
}

// ---------------------------------------------------------------------------
// HTTP shorthand
// ---------------------------------------------------------------------------

function request(base, method, urlPath, { headers = {}, body = null, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(base + urlPath); }
    catch (e) { return resolve({ ok: false, status: 0, error: 'bad url: ' + e.message }); }
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const hdr = { 'content-type': 'application/json', ...headers };
    if (payload) hdr['content-length'] = Buffer.byteLength(payload);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: hdr,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {} // deliberate: cleanup
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          body: buf,
          json,
        });
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// CLI shorthand — spawn the kolm CLI against the ctx isolated home.
// ---------------------------------------------------------------------------

function runKolm(ctx, args, opts = {}) {
  const env = ctx ? ctx.env : process.env;
  return spawnSync(NODE, [KOLM_CLI, ...args], {
    cwd: ROOT,
    env: { ...env, ...(opts.env || {}) },
    encoding: 'utf8',
    timeout: opts.timeoutMs || 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

// ---------------------------------------------------------------------------
// Smoke spec — tiny rule_class fixture compiles in <30s even with verifier.
// Same shape as W255 fixture so the artifact lifecycle is well-trodden.
// ---------------------------------------------------------------------------

const SMOKE_SPEC = {
  job_id: 'job_e2e_smoke_greeter_v1',
  task: 'Classify whether a string is a greeting (yes/no).',
  base_model: 'none',
  target_device: 'any',
  recipes: [{
    id: 'rcp_greet_smoke_v1',
    name: 'greeting detector (rule)',
    tags: ['classifier', 'greeting'],
    schema: {
      input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      output: { type: 'object', properties: { is_greeting: { type: 'boolean' } } },
    },
    source: "function generate(input, lib) {\n  const s = String((input && input.text) || '').toLowerCase();\n  return { is_greeting: /\\b(hi|hello|hey|howdy|greetings|good (morning|afternoon|evening))\\b/.test(s) };\n}",
  }],
  evals: {
    spec: 'rs-1-evals',
    n: 6,
    coverage: 1.0,
    cases: [
      { id: 'ev_1', input: { text: 'hi there' }, expected: { is_greeting: true } },
      { id: 'ev_2', input: { text: 'good morning team' }, expected: { is_greeting: true } },
      { id: 'ev_3', input: { text: 'hello world' }, expected: { is_greeting: true } },
      { id: 'ev_4', input: { text: 'where is my order' }, expected: { is_greeting: false } },
      { id: 'ev_5', input: { text: 'merge conflict in main' }, expected: { is_greeting: false } },
      { id: 'ev_6', input: { text: 'deploy starts at 3pm' }, expected: { is_greeting: false } },
    ],
  },
  training_stats: { approach: 'rule', regex_count: 1, verifier_accepted: true, latency_p50_us: 40 },
};

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

function probeCudaPresent() {
  // Cheap CUDA probe — nvidia-smi exit 0 = GPU stack present.
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['nvidia-smi'], { encoding: 'utf8', timeout: 4000 });
    if (r.status !== 0) return false;
    const r2 = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8', timeout: 6000 });
    return r2.status === 0 && (r2.stdout || '').trim().length > 0;
  } catch (_) { return false; }
}

function probeDocker() {
  try {
    const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 6000 });
    return r.status === 0;
  } catch (_) { return false; }
}

function probeCommand(cmd) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', timeout: 3000 });
    return r.status === 0;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Argv helpers
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const out = { _: [], json: false, smoke: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--smoke') out.smoke = true;
    // W889-11.1 — --dry-run is a fast probe (no server boot, no real load).
    // Drivers emit the same JSON envelope shape so cmdTestE2E and tests can
    // verify the contract without paying the 5-10s server-boot cost.
    else if (a === '--dry-run' || a === '--dryrun') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else { out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    } else out._.push(a);
  }
  return out;
}

// W889-11.1 — shared dry-run emitter. Each persona driver calls this at the
// top of main() when args.dryRun is set, so all four drivers emit the same
// envelope without booting a server.
function emitDryRun(persona, opts = {}) {
  const envelope = {
    persona,
    ok: true,
    dry_run: true,
    skipped: false,
    reason: opts.reason || 'dry-run shape check',
    steps: [{
      persona, label: 'dry_run_shape_check',
      ok: true, skipped: true,
      detail: 'driver loadable; envelope contract intact',
      elapsed_ms: 0,
    }],
    counts: { total: 1, pass: 0, skipped: 1, fail: 0 },
    elapsed_ms: opts.elapsed_ms || 0,
    started_at: opts.started_at || null,
    finished_at: Date.now(),
  };
  process.stdout.write(JSON.stringify(envelope) + '\n');
  return envelope;
}

// ---------------------------------------------------------------------------

module.exports = {
  ROOT,
  KOLM_CLI,
  NODE,
  SMOKE_SPEC,
  setupIsolatedServer,
  teardown,
  freePort,
  waitForHealth,
  request,
  runKolm,
  stepStart,
  stepOk,
  stepFail,
  stepSkip,
  emitSkip,
  emitReport,
  emitDryRun,
  probeCudaPresent,
  probeDocker,
  probeCommand,
  parseArgv,
};
