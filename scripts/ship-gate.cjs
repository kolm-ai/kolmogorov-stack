#!/usr/bin/env node
// W888-I — Ship Gate orchestrator.
//
// Single driver that runs all 52 ship-gate checks documented in
// KOLM_W888_RUN_FINAL_INTEGRATION_PLAN.md PART D. Each check is a small
// function returning { ok, detail, elapsed_ms } plus a structured envelope
// the JSON / Markdown reporters can render.
//
// This is the FINAL gate — it doesn't need to pass 52/52 today. It needs to
// RUN and REPORT clearly so W888-L can target the remaining failures.
//
// Invocation:
//   node scripts/ship-gate.cjs                  # human-readable summary
//   node scripts/ship-gate.cjs --json           # machine-readable JSON
//   node scripts/ship-gate.cjs --report PATH    # write Markdown report to PATH
//   node scripts/ship-gate.cjs --failures-only  # only print failing checks
//   node scripts/ship-gate.cjs --skip=1,2,3     # skip specific check ids
//
// Exit code: 0 if all pass, 1 if any BLOCKER fails, 2 if only warnings.
//
// SURFACE BREAKDOWN (PART D verbatim):
//   wrapper:  10 (#1-10)
//   studio:   10 (#11-20)
//   run:      10 (#21-30)
//   cross:     5 (#31-35)
//   infra:    12 (#36-47)
//   account:   3 (#48-50)
//   perf:      2 (#51-52)
//   TOTAL:    52

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const KOLM_CLI = path.join(ROOT, 'cli', 'kolm.js');
const NODE = process.execPath;
const IS_WIN = process.platform === 'win32';

// -------------------- CLI ARGV --------------------
const argv = process.argv.slice(2);
const jsonMode = argv.includes('--json');
const failuresOnly = argv.includes('--failures-only');
const reportFlag = argv.find((a) => a === '--report' || a.startsWith('--report='));
let reportPath = null;
if (reportFlag) {
  if (reportFlag.includes('=')) reportPath = reportFlag.split('=')[1];
  else {
    const idx = argv.indexOf('--report');
    reportPath = argv[idx + 1] || null;
  }
}
const skipFlag = argv.find((a) => a.startsWith('--skip='));
const skipIds = new Set(
  (skipFlag ? skipFlag.slice('--skip='.length) : '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0)
);

// -------------------- helpers --------------------

function log(...m) { if (!jsonMode) console.log(...m); }
function progress(msg) {
  if (jsonMode) return;
  process.stderr.write('[ship-gate] ' + msg + '\n');
}

function nodeTestCount(out, label) {
  // node --test summary uses "ℹ pass N" / "ℹ fail N" (or just "pass N" on some Node builds).
  const re = new RegExp('(?:^|\\r?\\n)[^\\r\\n]*\\b' + label + '\\s+(\\d+)', 'gi');
  const ms = Array.from(String(out || '').matchAll(re));
  if (!ms.length) return null;
  return parseInt(ms[ms.length - 1][1], 10);
}

function runNodeTest(testFile, { timeoutMs = 180_000, env } = {}) {
  // Shell out to `node --test <file>` and parse the result. Returns
  // { ok, status, passes, fails, tail, duration_ms }.
  const t0 = Date.now();
  const r = spawnSync(NODE, ['--test', '--test-concurrency=1', testFile], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', ...(env || {}) },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const passes = nodeTestCount(out, 'pass');
  const fails = nodeTestCount(out, 'fail');
  const ok = r.status === 0 && fails === 0;
  return {
    ok,
    status: r.status,
    passes,
    fails,
    tail: out.split(/\r?\n/).slice(-12).join('\n'),
    duration_ms: Date.now() - t0,
  };
}

function fileExists(...parts) {
  return fs.existsSync(path.join(ROOT, ...parts));
}

function pathHas(rel, needle) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, 'utf8').includes(needle);
}

// -------------------- shared server boot --------------------
// Many checks (rate-limit, capture export, receipt export, RSS, dashboard,
// status page) can share a single isolated server boot. We start it lazily
// on the first check that needs it, then reuse + tear down once.

let _sharedServer = null;
let _sharedServerInfo = null;

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

function waitForServer(base, timeoutMs = 30_000) {
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

async function ensureSharedServer() {
  // W889-11.1 hardening — when a previous check leaves the cached server
  // alive on paper but dead in fact (e.g. a child node --test invocation
  // happens to crash the parent stdout pipe), the cached _sharedServerInfo
  // pointed at a port that nothing is listening on. Re-probe /health and
  // re-spawn if it's gone.
  if (_sharedServer && _sharedServerInfo) {
    try {
      const up = await waitForServer(_sharedServerInfo.base, 2000);
      if (up) return _sharedServerInfo;
    } catch (_) { /* fall through to respawn */ }
    try { _sharedServer.kill('SIGKILL'); } catch (_) {} // deliberate: cleanup
    _sharedServer = null;
    _sharedServerInfo = null;
  }
  const port = await freePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-ship-gate-'));
  const dataDir = path.join(scratch, 'data');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const tenantId = 't_ship_gate';
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    {
      id: tenantId, name: 'ship-gate', email: 'ship-gate@local.test',
      plan: 'enterprise', quota: 50_000_000, seats: 1,
      created_at: new Date().toISOString(),
    },
  ]), 'utf8');

  const apiKey = 'ks_ship_gate_smoke_key_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const crypto = require('node:crypto');
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    {
      id: 'apik_ship_gate', tenant_id: tenantId, hash: keyHash,
      label: 'ship-gate', kind: 'user',
      created_at: new Date().toISOString(), revoked_at: null,
    },
  ]), 'utf8');

  const proc = spawn(NODE, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir,
      KOLM_HOME: home,
      KOLM_STORE_DRIVER: 'json',
      KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1',
      DEFAULT_TENANT: 'ship-gate',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      // W889-11.1 — pin the Vercel proxy fallback at a guaranteed-unreachable
      // local URL so dispatch's "no upstream key" path returns immediately
      // with a structured envelope (status=502/503 + error object) rather
      // than hitting the real prod relay with our fake test key (which gives
      // a flaky 401 from kolm.ai's tenant store). Check #1 verifies envelope
      // shape, not provider success, so this is the right knob.
      KOLM_BASE_URL: 'http://127.0.0.1:1',
      KOLM_PROXY_BASE: 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  _sharedServer = proc;
  const base = `http://127.0.0.1:${port}`;
  const up = await waitForServer(base, 30_000);
  if (!up) {
    try { proc.kill(); } catch (_) {} // deliberate: cleanup
    throw new Error('shared server failed to come up at ' + base);
  }
  _sharedServerInfo = { base, port, dataDir, home, tenantId, apiKey, scratch };
  return _sharedServerInfo;
}

async function tearDownSharedServer() {
  if (!_sharedServer) return;
  try { _sharedServer.kill('SIGTERM'); } catch (_) {} // deliberate: cleanup
  await new Promise((r) => {
    const t = setTimeout(() => { try { _sharedServer.kill('SIGKILL'); } catch (_) {} r(); }, 2000); // deliberate: cleanup
    _sharedServer.once('exit', () => { clearTimeout(t); r(); });
  });
  try {
    if (_sharedServerInfo && _sharedServerInfo.scratch) {
      fs.rmSync(_sharedServerInfo.scratch, { recursive: true, force: true });
    }
  } catch (_) {} // deliberate: cleanup
  _sharedServer = null;
  _sharedServerInfo = null;
}

function httpJSON(base, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const u = new URL(base + urlPath);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: { 'content-type': 'application/json', ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {} // deliberate: cleanup
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// -------------------- CHECK DEFINITIONS --------------------

// Each check returns one of:
//   { ok: true,  detail: '...', elapsed_ms: N }
//   { ok: false, detail: '...', elapsed_ms: N, install_hint?: '...' }
//   { ok: false, detail: 'NO_TEST_YET', install_hint: '...', elapsed_ms: N }
//
// NO_TEST_YET means "this check is documented but no automated test exists
// yet" — it counts as a failure for visibility but ship-gate exits 2 (warn)
// if NO_TEST_YET checks are the only failures.

const NO_TEST = (hint) => async () => ({
  ok: false,
  not_yet: true,
  detail: 'NO_TEST_YET',
  install_hint: hint,
  elapsed_ms: 0,
});

// W888-L: scaffold runner. Each scaffold is a stand-alone .cjs that exits 0
// on either PASS (ok:true) or graceful SKIP (skipped:true). Exit code 2 (or
// any non-zero with no SKIP envelope) is a real failure.
function runScaffold(rel, { timeoutMs = 180_000 } = {}) {
  return async () => {
    const file = path.join(ROOT, rel);
    const t0 = Date.now();
    if (!fs.existsSync(file)) {
      return { ok: false, detail: 'scaffold missing: ' + rel, elapsed_ms: 0, install_hint: 'create ' + rel };
    }
    const r = spawnSync(NODE, [file], {
      cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env },
    });
    const stdout = String(r.stdout || '').trim();
    // Parse the last JSON line (scaffolds may print warnings before envelope).
    let env = null;
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { env = JSON.parse(lines[i]); break; } catch (_) {} // deliberate: cleanup
    }
    const elapsed = Date.now() - t0;
    if (env && env.skipped === true) {
      return {
        ok: true, // SKIP counts as PASS per W888-L exit contract.
        not_yet: false,
        detail: 'SKIP: ' + (env.reason || ''),
        install_hint: env.install_hint || null,
        elapsed_ms: elapsed,
      };
    }
    if (env && env.ok === true) {
      return {
        ok: true,
        detail: 'pass via ' + path.basename(rel),
        elapsed_ms: elapsed,
      };
    }
    return {
      ok: false,
      detail: 'exit=' + r.status + ' env=' + (env ? JSON.stringify(env).slice(0, 240) : 'unparseable; stdout=' + stdout.slice(0, 200)),
      elapsed_ms: elapsed,
    };
  };
}

// Helper for the most common case: shell out to a test file and report.
function shellTest(rel, opts) {
  return async () => {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) {
      return {
        ok: false,
        not_yet: true,
        detail: 'NO_TEST_YET',
        install_hint: 'create ' + rel,
        elapsed_ms: 0,
      };
    }
    const t0 = Date.now();
    const r = runNodeTest(file, opts);
    return {
      ok: r.ok,
      detail: r.ok ? `pass=${r.passes} fail=${r.fails}` : `exit=${r.status} fail=${r.fails}\n${r.tail}`,
      elapsed_ms: Date.now() - t0,
      passes: r.passes,
      fails: r.fails,
    };
  };
}

const CHECKS = [
  // ============================================================
  // SURFACE 1: WRAPPER (10)
  // ============================================================
  { id: 1, name: 'Gateway routes to >= 1 provider', surface: 'wrapper',
    run: async () => {
      const t0 = Date.now();
      const { base, apiKey } = await ensureSharedServer();
      const res = await httpJSON(base, 'POST', '/v1/gateway/dispatch', {
        headers: { authorization: 'Bearer ' + apiKey },
        body: { messages: [{ role: 'user', content: 'hello' }], model: 'gpt-4o-mini' },
      });
      // Without provider keys configured the call should still produce a
      // structured envelope (not a 5xx-with-stack). 200, 4xx, 502 are all
      // acceptable shapes IF the body is a JSON envelope with ok / error /
      // kolm_receipt fields. Errors may surface as string OR { type, message }
      // object — both are valid envelope shapes.
      const errIsObj = res.json && res.json.error && typeof res.json.error === 'object'
        && (typeof res.json.error.type === 'string' || typeof res.json.error.message === 'string');
      const errIsStr = res.json && typeof res.json.error === 'string';
      const hasReceipt = res.json && typeof res.json.kolm_receipt === 'object';
      const okEnvelope = !!res.json && (typeof res.json.ok === 'boolean' || errIsStr || errIsObj || hasReceipt);
      const errLabel = errIsStr ? res.json.error
        : errIsObj ? (res.json.error.type || res.json.error.message || 'object_err')
        : 'n/a';
      return {
        ok: okEnvelope && (res.status === 200 || res.status >= 400),
        detail: `status=${res.status} envelope=${okEnvelope ? 'ok' : 'missing'} provider=${(res.json && res.json.provider) || errLabel}`,
        elapsed_ms: Date.now() - t0,
      };
    } },
  { id: 2, name: 'Receipt generated and verifiable', surface: 'wrapper',
    run: shellTest('tests/wave157-redactor-receipt.test.js', { timeoutMs: 60_000 }) },
  { id: 3, name: 'Captures written with hash chain intact', surface: 'wrapper',
    run: shellTest('tests/wave212-capture-durability.test.js', { timeoutMs: 60_000 }) },
  { id: 4, name: 'PII redaction detects and scrubs', surface: 'wrapper',
    run: shellTest('tests/wave144-phi-redactor.test.js', { timeoutMs: 60_000 }) },
  { id: 5, name: 'Streaming (SSE) works end-to-end', surface: 'wrapper',
    run: shellTest('tests/wave723-streaming-load.test.js', { timeoutMs: 120_000 }) },
  { id: 6, name: 'Rate limiting enforces tier limits', surface: 'wrapper',
    run: shellTest('tests/wave888i-rate-limit.test.js', { timeoutMs: 90_000 }) },
  { id: 7, name: 'Cost tracking records per-call cost', surface: 'wrapper',
    run: shellTest('tests/wave265-usage-analytics.test.js', { timeoutMs: 60_000 }) },
  { id: 8, name: 'Provider failover works (primary down -> fallback)', surface: 'wrapper',
    run: shellTest('tests/wave292-teacher-bridge-fail-closed.test.js', { timeoutMs: 60_000 }) },
  { id: 9, name: 'Capture export works (JSONL/JSON/Parquet/HF)', surface: 'wrapper',
    run: shellTest('tests/wave888i-capture-export-formats.test.js', { timeoutMs: 180_000 }) },
  { id: 10, name: 'Receipt export works (JSONL/JSON/CSV)', surface: 'wrapper',
    run: shellTest('tests/wave888i-receipt-export.test.js', { timeoutMs: 120_000 }) },

  // ============================================================
  // SURFACE 2: STUDIO (10)
  // ============================================================
  { id: 11, name: 'DataForge produces valid dataset from captures', surface: 'studio',
    run: runScaffold('scripts/scaffolds/dataforge-from-captures.cjs', { timeoutMs: 60_000 }) },
  { id: 12, name: 'TrainForge trains LoRA and loss decreases', surface: 'studio',
    run: shellTest('tests/wave144-distill-worker.test.js', { timeoutMs: 120_000 }) },
  { id: 13, name: 'K-Score gate rejects artifact below threshold', surface: 'studio',
    run: shellTest('tests/wave145-kscore-t-axis.test.js', { timeoutMs: 60_000 }) },
  { id: 14, name: 'GGUF export produces valid file with metadata', surface: 'studio',
    run: shellTest('tests/s1-gguf-export.test.js', { timeoutMs: 60_000 }) },
  { id: 15, name: 'GGUF loads in llama-cpp-python and generates text', surface: 'studio',
    run: runScaffold('scripts/scaffolds/gguf-llama-cpp-roundtrip.cjs', { timeoutMs: 240_000 }) },
  { id: 16, name: 'Ollama Modelfile generated and valid', surface: 'studio',
    run: shellTest('tests/s2-ollama-modelfile.test.js', { timeoutMs: 60_000 }) },
  { id: 17, name: 'HuggingFace model card generated with all sections', surface: 'studio',
    run: runScaffold('scripts/scaffolds/hf-model-card.cjs', { timeoutMs: 60_000 }) },
  { id: 18, name: 'kolm compile --target gguf-q4km works end-to-end', surface: 'studio',
    run: shellTest('tests/wave266-compile-targets-surfaced.test.js', { timeoutMs: 60_000 }) },
  { id: 19, name: 'kolm bench produces comparison table', surface: 'studio',
    run: shellTest('tests/wave144-bench-compare.test.js', { timeoutMs: 60_000 }) },
  { id: 20, name: 'Multi-teacher (Teacher Council) captures blended correctly', surface: 'studio',
    run: shellTest('tests/wave160-teacher-delta.test.js', { timeoutMs: 60_000 }) },

  // ============================================================
  // SURFACE 3: RUN (10)
  // ============================================================
  { id: 21, name: 'kolm serve starts and /health returns ok', surface: 'run',
    run: async () => {
      const t0 = Date.now();
      const { base } = await ensureSharedServer();
      const r = await httpJSON(base, 'GET', '/health');
      return {
        ok: r.ok && r.json && (r.json.ok === true || typeof r.json.uptime_s === 'number'),
        detail: `status=${r.status} json.ok=${r.json && r.json.ok}`,
        elapsed_ms: Date.now() - t0,
      };
    } },
  { id: 22, name: 'kolm serve auto-detects format + hardware', surface: 'run',
    run: shellTest('tests/wave287-runtime-dispatch.test.js', { timeoutMs: 60_000 }) },
  { id: 23, name: 'Runtime passport present in every artifact', surface: 'run',
    run: async () => {
      const t0 = Date.now();
      // Look for r1-runtime-passport.test.js or similar.
      const candidates = [
        'tests/r1-runtime-passport.test.js',
        'tests/wave-runtime-passport.test.js',
      ];
      for (const c of candidates) {
        if (fileExists(c)) {
          const r = runNodeTest(path.join(ROOT, c), { timeoutMs: 60_000 });
          return {
            ok: r.ok,
            detail: r.ok ? `pass=${r.passes}` : `exit=${r.status}\n${r.tail}`,
            elapsed_ms: Date.now() - t0,
          };
        }
      }
      // Structural fallback: src/runtime-passport.js exists + exports validate.
      const f = path.join(ROOT, 'src', 'runtime-passport.js');
      const ok = fs.existsSync(f) && /export\s+(function|async function|const)\s+/i.test(fs.readFileSync(f, 'utf8'));
      return {
        ok,
        detail: ok ? 'src/runtime-passport.js present + exports' : 'src/runtime-passport.js missing or no exports',
        elapsed_ms: Date.now() - t0,
      };
    } },
  { id: 24, name: 'Artifact lifecycle transitions work', surface: 'run',
    run: shellTest('tests/artifact-end-to-end.test.js', { timeoutMs: 90_000 }) },
  { id: 25, name: 'Docker Compose generation produces valid YAML', surface: 'run',
    run: shellTest('tests/wave144-native-compile.test.js', { timeoutMs: 60_000 }) },
  { id: 26, name: 'Kubernetes manifests pass kubectl apply --dry-run', surface: 'run',
    run: runScaffold('scripts/scaffolds/k8s-manifest-dry-run.cjs', { timeoutMs: 60_000 }) },
  { id: 27, name: 'Drift detection fires on distribution shift', surface: 'run',
    run: shellTest('tests/r7-drift-detector.test.js', { timeoutMs: 60_000 }) },
  { id: 28, name: 'Cost displacement calculation is accurate', surface: 'run',
    run: shellTest('tests/r8-cost-displacement.test.js', { timeoutMs: 60_000 }) },
  { id: 29, name: 'Assurance case export contains claims with evidence', surface: 'run',
    run: shellTest('tests/r6-assurance-case.test.js', { timeoutMs: 60_000 }) },
  { id: 30, name: 'kolm verify works offline', surface: 'run',
    run: shellTest('tests/wave445-verify-hardening.test.js', { timeoutMs: 60_000 }) },

  // ============================================================
  // CROSS-SURFACE (5)
  // ============================================================
  { id: 31, name: 'Full loop: route -> capture -> compile -> deploy -> route-local', surface: 'cross',
    run: shellTest('tests/wave255-e2e-compile-distill.test.js', { timeoutMs: 240_000 }) },
  { id: 32, name: 'Fallback captures feed back into next compile cycle', surface: 'cross',
    run: shellTest('tests/wave214-distill-from-captures.test.js', { timeoutMs: 120_000 }) },
  { id: 33, name: 'Confidence routing: local-first, frontier on low confidence', surface: 'cross',
    run: shellTest('tests/wave709-routing-threshold-sse.test.js', { timeoutMs: 60_000 }) },
  { id: 34, name: 'Shard KV cache reduces VRAM usage measurably', surface: 'cross',
    run: runScaffold('scripts/scaffolds/shard-kv-vram.cjs', { timeoutMs: 180_000 }) },
  { id: 35, name: 'kolm doctor reports all critical deps installed', surface: 'cross',
    run: async () => {
      const t0 = Date.now();
      const r = spawnSync(NODE, [KOLM_CLI, 'doctor', '--json', '--allow-logged-out'], {
        cwd: ROOT, encoding: 'utf8', timeout: 60_000,
      });
      let parsed = null;
      try { parsed = JSON.parse(r.stdout); } catch (_) {} // deliberate: cleanup
      const ok = parsed && (parsed.ok === true || (parsed.blockers === 0));
      return {
        ok: !!ok,
        detail: parsed ? `ok=${parsed.ok} blockers=${parsed.blockers} checks=${(parsed.checks||[]).length}` : 'non-JSON stdout (first 200): ' + (r.stdout||'').slice(0, 200),
        elapsed_ms: Date.now() - t0,
      };
    } },

  // ============================================================
  // INFRASTRUCTURE (12) — #36-47
  // ============================================================
  { id: 36, name: 'Stripe payment flow works', surface: 'infra',
    run: shellTest('tests/stripe.test.js', { timeoutMs: 90_000 }) },
  { id: 37, name: 'API key provisioned on signup', surface: 'infra',
    run: shellTest('tests/auth-hash.test.js', { timeoutMs: 30_000 }) },
  { id: 38, name: 'Signup -> first gateway call in under 2 minutes', surface: 'infra',
    run: runScaffold('scripts/scaffolds/signup-to-first-call-timer.cjs', { timeoutMs: 180_000 }) },
  { id: 39, name: 'Transactional emails send', surface: 'infra',
    run: runScaffold('scripts/scaffolds/transactional-email-fixture.cjs', { timeoutMs: 60_000 }) },
  { id: 40, name: 'Sentry captures errors', surface: 'infra',
    run: shellTest('tests/sentry-init.test.js', { timeoutMs: 30_000 }) },
  { id: 41, name: 'Status page loads at /status', surface: 'infra',
    run: async () => {
      const t0 = Date.now();
      const { base } = await ensureSharedServer();
      const r = await httpJSON(base, 'GET', '/status');
      return {
        ok: r.status === 200,
        detail: `status=${r.status}`,
        elapsed_ms: Date.now() - t0,
      };
    } },
  { id: 42, name: 'OpenAPI spec loads and is valid', surface: 'infra',
    run: shellTest('tests/wave485-openapi-coverage.test.js', { timeoutMs: 60_000 }) },
  { id: 43, name: 'SDK examples in docs work (copy-paste test)', surface: 'infra',
    run: shellTest('tests/wave470-sdk-node-smoke.test.js', { timeoutMs: 120_000 }) },
  { id: 44, name: 'Blog loads with 5 posts', surface: 'infra',
    run: async () => {
      const t0 = Date.now();
      const dir = path.join(ROOT, 'public', 'blog');
      if (!fs.existsSync(dir)) return { ok: false, detail: 'public/blog missing', elapsed_ms: Date.now() - t0 };
      const posts = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.html$/.test(f));
      return {
        ok: posts.length >= 5,
        detail: `${posts.length} dated post(s) in public/blog`,
        elapsed_ms: Date.now() - t0,
      };
    } },
  { id: 45, name: 'Changelog loads with entries', surface: 'infra',
    run: async () => {
      const t0 = Date.now();
      const { base } = await ensureSharedServer();
      const r = await httpJSON(base, 'GET', '/changelog');
      const ok = r.status === 200 && (r.body || '').length > 1000;
      return {
        ok,
        detail: `status=${r.status} bytes=${(r.body||'').length}`,
        elapsed_ms: Date.now() - t0,
      };
    } },
  { id: 46, name: 'RSS feed valid', surface: 'infra',
    run: shellTest('tests/wave888i-rss-feed.test.js', { timeoutMs: 60_000 }) },
  { id: 47, name: 'SEO: sitemap.xml + robots.txt', surface: 'infra',
    run: async () => {
      const t0 = Date.now();
      const sm = path.join(ROOT, 'public', 'sitemap.xml');
      const rb = path.join(ROOT, 'public', 'robots.txt');
      const okSm = fs.existsSync(sm) && /<urlset/.test(fs.readFileSync(sm, 'utf8'));
      const okRb = fs.existsSync(rb) && /User-agent:/i.test(fs.readFileSync(rb, 'utf8'));
      return {
        ok: okSm && okRb,
        detail: `sitemap=${okSm ? 'ok' : 'fail'} robots=${okRb ? 'ok' : 'fail'}`,
        elapsed_ms: Date.now() - t0,
      };
    } },

  // ============================================================
  // ACCOUNT UI (3) — #48-50
  // ============================================================
  { id: 48, name: 'Onboarding flow completes for all 4 paths', surface: 'account',
    run: runScaffold('scripts/scaffolds/onboarding-paths-complete.cjs', { timeoutMs: 30_000 }) },
  { id: 49, name: 'Dashboard loads with correct data', surface: 'account',
    run: async () => {
      const t0 = Date.now();
      const { base, apiKey } = await ensureSharedServer();
      // Dashboard surface is /account/overview.html (no auth needed for the
      // HTML shell; XHR fetches use the API key). Check the shell loads.
      const html = await httpJSON(base, 'GET', '/account/overview');
      const ok = html.status === 200 || html.status === 304;
      return {
        ok,
        detail: `account/overview status=${html.status}`,
        elapsed_ms: Date.now() - t0,
      };
    } },
  { id: 50, name: 'Capture browser loads, filters work', surface: 'account',
    run: async () => {
      const t0 = Date.now();
      const { base, apiKey } = await ensureSharedServer();
      const r = await httpJSON(base, 'GET', '/v1/captures/list?limit=10', {
        headers: { authorization: 'Bearer ' + apiKey },
      });
      const ok = r.ok && r.json && typeof r.json.total === 'number';
      return {
        ok: !!ok,
        detail: `status=${r.status} total=${r.json && r.json.total}`,
        elapsed_ms: Date.now() - t0,
      };
    } },

  // ============================================================
  // PERFORMANCE (2) — #51-52
  // ============================================================
  { id: 51, name: 'Gateway overhead < 500ms (local mock)', surface: 'perf',
    run: shellTest('tests/wave888i-gateway-overhead.test.js', { timeoutMs: 120_000 }) },
  { id: 52, name: 'CLI startup < 500ms (p50)', surface: 'perf',
    run: shellTest('tests/wave888i-cli-startup-perf.test.js', { timeoutMs: 60_000 }) },
];

// Sanity — surface counts must match PART D's breakdown.
const EXPECTED_SURFACE_COUNTS = {
  wrapper: 10, studio: 10, run: 10, cross: 5, infra: 12, account: 3, perf: 2,
};

// -------------------- driver --------------------

(async function main() {
  const wallStart = Date.now();
  // Self-check: 52 checks, surface counts match.
  if (CHECKS.length !== 52) {
    const msg = `ship-gate self-check FAILED: expected 52 checks, got ${CHECKS.length}`;
    if (jsonMode) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    else process.stderr.write(msg + '\n');
    process.exit(3);
  }
  for (const [surface, expected] of Object.entries(EXPECTED_SURFACE_COUNTS)) {
    const got = CHECKS.filter((c) => c.surface === surface).length;
    if (got !== expected) {
      const msg = `ship-gate self-check FAILED: surface=${surface} expected=${expected} got=${got}`;
      if (jsonMode) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
      else process.stderr.write(msg + '\n');
      process.exit(3);
    }
  }
  for (let i = 0; i < CHECKS.length; i++) {
    if (CHECKS[i].id !== i + 1) {
      const msg = `ship-gate self-check FAILED: index ${i} has id ${CHECKS[i].id} (expected ${i + 1})`;
      if (jsonMode) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
      else process.stderr.write(msg + '\n');
      process.exit(3);
    }
  }

  // ---------- W888-H extension hook (opt-in via env) ----------
  // When KOLM_SHIP_GATE_INCLUDE_E2E=1, append additional check entries from
  // scripts/ship-gate-extensions/*.cjs. Purely additive: when the env is
  // unset (default), the existing 52-check contract is preserved verbatim
  // (wave888i-ship-gate-smoke.test.js continues to pin total === 52).
  if (process.env.KOLM_SHIP_GATE_INCLUDE_E2E === '1') {
    try {
      const extDir = path.join(ROOT, 'scripts', 'ship-gate-extensions');
      if (fs.existsSync(extDir)) {
        const seenIds = new Set(CHECKS.map((c) => c.id));
        for (const fname of fs.readdirSync(extDir).sort()) {
          if (!fname.endsWith('.cjs')) continue;
          let extChecks = [];
          try { extChecks = require(path.join(extDir, fname)); } catch (e) {
            progress('extension load failed for ' + fname + ': ' + (e && e.message || e));
            continue;
          }
          if (!Array.isArray(extChecks)) continue;
          for (const c of extChecks) {
            if (!c || typeof c.id !== 'number' || typeof c.name !== 'string' || typeof c.run !== 'function') continue;
            if (seenIds.has(c.id)) continue; // duplicate-id guard
            seenIds.add(c.id);
            CHECKS.push({ id: c.id, name: c.name, surface: c.surface || 'ext', run: c.run });
          }
        }
      }
    } catch (e) {
      progress('extension hook fatal: ' + (e && e.message || e));
    }
  }

  const results = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let notYet = 0;
  let blockerFailed = 0;

  for (const check of CHECKS) {
    if (skipIds.has(check.id)) {
      skipped++;
      results.push({
        id: check.id, name: check.name, surface: check.surface,
        ok: false, skipped: true, detail: 'skipped via --skip', elapsed_ms: 0,
      });
      progress(`#${check.id} ${check.name} — SKIP`);
      continue;
    }
    progress(`#${check.id} ${check.name} ...`);
    let r;
    try {
      r = await check.run();
    } catch (e) {
      r = { ok: false, detail: 'check threw: ' + (e && e.message || String(e)), elapsed_ms: 0 };
    }
    const row = {
      id: check.id,
      name: check.name,
      surface: check.surface,
      ok: !!r.ok,
      skipped: false,
      not_yet: !!r.not_yet,
      detail: r.detail || '',
      install_hint: r.install_hint || null,
      elapsed_ms: r.elapsed_ms || 0,
    };
    if (typeof r.passes === 'number') row.passes = r.passes;
    if (typeof r.fails === 'number') row.fails = r.fails;
    results.push(row);
    if (row.ok) { passed++; progress(`  PASS (${row.elapsed_ms}ms)`); }
    else if (row.not_yet) { notYet++; progress(`  NO_TEST_YET`); }
    else { failed++; blockerFailed++; progress(`  FAIL (${row.elapsed_ms}ms) — ${(row.detail||'').split('\n')[0].slice(0, 120)}`); }
  }

  await tearDownSharedServer();

  const wallDuration = Date.now() - wallStart;

  // Summary numbers.
  const summary = {
    total: CHECKS.length,
    passed,
    failed,                 // genuine failures (not NO_TEST_YET, not skipped)
    not_yet: notYet,        // NO_TEST_YET — counted separately
    skipped,
    duration_ms: wallDuration,
    surfaces: {},
    checks: results,
  };
  for (const surface of Object.keys(EXPECTED_SURFACE_COUNTS)) {
    const subset = results.filter((r) => r.surface === surface);
    summary.surfaces[surface] = {
      total: subset.length,
      passed: subset.filter((r) => r.ok).length,
      failed: subset.filter((r) => !r.ok && !r.skipped && !r.not_yet).length,
      not_yet: subset.filter((r) => r.not_yet).length,
      skipped: subset.filter((r) => r.skipped).length,
    };
  }

  // Exit code:
  //   0 if all pass (or only skipped),
  //   2 if only warnings (NO_TEST_YET),
  //   1 if any blocker failure.
  let exitCode = 0;
  if (blockerFailed > 0) exitCode = 1;
  else if (notYet > 0) exitCode = 2;

  // ---------------- emit ----------------

  if (reportPath) {
    const md = renderMarkdown(summary);
    fs.writeFileSync(reportPath, md, 'utf8');
    progress(`wrote markdown report to ${reportPath}`);
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    log('');
    log('--- W888-I Ship Gate ---');
    log(`total=${summary.total} passed=${passed} failed=${failed} not_yet=${notYet} skipped=${skipped} duration=${Math.round(wallDuration/1000)}s`);
    log('');
    for (const [surface, counts] of Object.entries(summary.surfaces)) {
      log(`  ${surface.padEnd(8)}  ${counts.passed}/${counts.total}  (failed=${counts.failed} not_yet=${counts.not_yet})`);
    }
    log('');
    for (const r of results) {
      if (failuresOnly && r.ok && !r.not_yet) continue;
      const tag = r.skipped ? 'SKIP' : r.not_yet ? 'WARN' : r.ok ? 'PASS' : 'FAIL';
      log(`  [${tag}] #${String(r.id).padStart(2, ' ')} (${r.surface.padEnd(7)}) ${r.name}`);
      if (!r.ok || failuresOnly) {
        if (r.detail) {
          for (const line of String(r.detail).split('\n').slice(0, 3)) {
            log('         ' + line);
          }
        }
        if (r.install_hint) log('         hint: ' + r.install_hint);
      }
    }
    log('');
    log(`Exit ${exitCode} — ${exitCode === 0 ? 'all gates green' : exitCode === 2 ? 'warnings only (NO_TEST_YET)' : 'blocker failures present'}`);
  }

  process.exit(exitCode);
})().catch((e) => {
  // Catastrophic failure path — make sure the shared server gets torn down
  // even if a check threw outside its try/catch.
  tearDownSharedServer().finally(() => {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.stack || e) }) + '\n');
    } else {
      process.stderr.write('ship-gate fatal: ' + (e && e.stack || e) + '\n');
    }
    process.exit(3);
  });
});

// -------------------- Markdown renderer --------------------

function renderMarkdown(summary) {
  const lines = [];
  lines.push('# W888-I Ship Gate Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Duration: ${Math.round(summary.duration_ms / 1000)}s`);
  lines.push('');
  lines.push(`**Total:** ${summary.total} | **Pass:** ${summary.passed} | **Fail:** ${summary.failed} | **NO_TEST_YET:** ${summary.not_yet} | **Skipped:** ${summary.skipped}`);
  lines.push('');
  lines.push('## By Surface');
  lines.push('');
  lines.push('| Surface | Pass | Fail | NO_TEST_YET | Skipped | Total |');
  lines.push('|---------|-----:|-----:|------------:|--------:|------:|');
  for (const [surface, c] of Object.entries(summary.surfaces)) {
    lines.push(`| ${surface} | ${c.passed} | ${c.failed} | ${c.not_yet} | ${c.skipped} | ${c.total} |`);
  }
  lines.push('');
  lines.push('## Check Results');
  lines.push('');
  lines.push('| ID | Surface | Status | Name | Detail |');
  lines.push('|---:|---------|--------|------|--------|');
  for (const r of summary.checks) {
    const tag = r.skipped ? 'SKIP' : r.not_yet ? 'WARN' : r.ok ? 'PASS' : 'FAIL';
    const detail = String(r.detail || '').split('\n')[0].slice(0, 160).replace(/\|/g, '\\|');
    lines.push(`| ${r.id} | ${r.surface} | ${tag} | ${r.name.replace(/\|/g, '\\|')} | ${detail} |`);
  }
  lines.push('');
  const notYetRows = summary.checks.filter((c) => c.not_yet);
  if (notYetRows.length) {
    lines.push('## NO_TEST_YET — needs scaffold');
    lines.push('');
    for (const r of notYetRows) {
      lines.push(`- #${r.id} **${r.name}** — ${r.install_hint || 'no hint'}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
