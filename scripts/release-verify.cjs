// W471 release-verify driver (rewrite of W470 P1-6).
//
// One script that re-runs every acceptance gate the audit/DoD pinned to
// "must be green before we ship," with SEMANTIC validation per gate (not
// just "did it emit JSON"), a hard wall-clock ceiling so the driver can
// never hang, and per-gate progress so the user always knows where it is.
//
// Gates, in order:
//   1.  npm run lint:refs                (static-ref + href integrity)
//   2.  npm test                         (full test suite, --test-concurrency=1)
//   3.  SDK smoke against local server   (boots PORT=3939, then runs
//                                         sdk/node/test/sdk.test.mjs)
//   4.  kolm doctor --json               (ok:true + blockers:0 unless --allow-logged-out)
//   5.  kolm whoami --json               (logged_in:true unless --allow-logged-out)
//   6.  kolm verify <kolm> --json        (ok:true + production_ready:true)
//   7.  kolm billing tiers --json        (data is non-empty tier list)
//
// Invocation:
//   node scripts/release-verify.cjs                       # all gates
//   node scripts/release-verify.cjs --skip=test           # skip a gate by name
//   node scripts/release-verify.cjs --json                # one machine-readable line
//   node scripts/release-verify.cjs --allow-logged-out    # accept rejected api-key
//   node scripts/release-verify.cjs --timeout-ms=600000   # wall ceiling (default 10m)
//
// Designed to be safe to run on a fresh checkout — never touches git, never
// pushes, never writes outside /tmp + the repo's normal test scratch.

// Suppress Node's DEP0190 warning (shell:true + argv concatenation) — we only
// pass shell:true to invoke .cmd shims with fixed argv we control.
const _origEmitWarning = process.emitWarning;
process.emitWarning = function (msg, type, code, ...rest) {
  if (code === 'DEP0190') return;
  if (type && type.code === 'DEP0190') return;
  return _origEmitWarning.call(this, msg, type, code, ...rest);
};

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const REPO_ROOT = path.resolve(__dirname, '..');
const KOLM_CLI = path.join(REPO_ROOT, 'cli', 'kolm.js');
const SDK_TEST = path.join(REPO_ROOT, 'sdk', 'node', 'test', 'sdk.test.mjs');
const CLAIMS_KOLM = path.join(REPO_ROOT, 'examples', 'claims-redactor', 'claims-redactor.kolm');

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const allowLoggedOut = args.includes('--allow-logged-out');
const skipFlag = args.find((a) => a.startsWith('--skip='));
const skipSet = new Set(skipFlag ? skipFlag.slice('--skip='.length).split(',').map((s) => s.trim()) : []);
const timeoutFlag = args.find((a) => a.startsWith('--timeout-ms='));
const WALL_TIMEOUT_MS = parseInt((timeoutFlag && timeoutFlag.slice('--timeout-ms='.length)) || process.env.KOLM_RELEASE_VERIFY_TIMEOUT_MS || '600000', 10);

const isWin = process.platform === 'win32';
const npmBin = isWin ? 'npm.cmd' : 'npm';
const nodeBin = process.execPath;

const SERVER_PORT = parseInt(process.env.KOLM_RELEASE_VERIFY_PORT || '3939', 10);
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;

// Progress goes to stderr so --json stdout stays a single clean line.
function progress(msg) { if (!jsonMode || process.env.KOLM_RELEASE_VERIFY_VERBOSE === '1') process.stderr.write('[release-verify] ' + msg + '\n'); }
function log(...m) { if (!jsonMode) console.log(...m); }
function logErr(...m) { if (!jsonMode) console.error(...m); }

// Hard wall-clock ceiling — if the whole run exceeds the timeout, we bail.
const wallStart = Date.now();
const wallTimer = setTimeout(() => {
  const ms = Date.now() - wallStart;
  const partial = { ok: false, duration_ms: ms, error: 'wall_timeout', timeout_ms: WALL_TIMEOUT_MS, gates: results };
  if (jsonMode) process.stdout.write(JSON.stringify(partial) + '\n');
  else logErr(`release-verify: wall timeout (${WALL_TIMEOUT_MS}ms exceeded)`);
  process.exit(124);
}, WALL_TIMEOUT_MS);
wallTimer.unref();

function runSync(cmd, argv, opts = {}) {
  // On Windows, .cmd / .bat shims require shell:true to be located.
  const needsShell = isWin && /\.(cmd|bat)$/i.test(cmd);
  const r = spawnSync(cmd, argv, {
    cwd: REPO_ROOT,
    stdio: opts.silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    shell: needsShell,
    timeout: opts.timeoutMs || 1_800_000,
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function waitForServer(base, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    const ok = await new Promise((resolve) => {
      const req = http.get(base + '/health', (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function bootServer() {
  const server = spawn(nodeBin, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(SERVER_PORT), KOLM_RATE_LIMIT_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  return server;
}

const results = [];

function recordResult(name, ok, details) {
  results.push({ gate: name, ok, ...details });
  if (jsonMode) return;
  const tag = ok ? 'PASS' : 'FAIL';
  log(`[${tag}] ${name}`);
  if (!ok && details && details.detail) log('  detail: ' + details.detail);
}

function shouldRun(name) { return !skipSet.has(name); }

// ---------------- Gates with semantic validation ----------------

async function gateLintRefs() {
  if (!shouldRun('lint:refs')) return recordResult('lint:refs', true, { skipped: true });
  progress('lint:refs running');
  const t = Date.now();
  const r = runSync(npmBin, ['run', 'lint:refs'], { silent: true, timeoutMs: 120_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  // Semantic: exit 0 AND audits report zero missing/broken.
  const exitOk = r.status === 0;
  const missingOk = /missing static refs: 0/.test(out);
  const brokenOk = /broken: 0/.test(out);
  const ok = exitOk && missingOk && brokenOk;
  const fail_reasons = [];
  if (!exitOk) fail_reasons.push('exit ' + r.status);
  if (!missingOk) fail_reasons.push('missing static refs not 0');
  if (!brokenOk) fail_reasons.push('broken refs not 0');
  recordResult('lint:refs', ok, {
    detail: ok ? out.match(/missing.*\n.*broken: \d+/)?.[0] || '' : (fail_reasons.join('; ') + ' :: ' + out.slice(-300)),
    duration_ms: Date.now() - t,
  });
  return ok;
}

async function gateTests() {
  if (!shouldRun('test')) return recordResult('test', true, { skipped: true });
  progress('test (full suite, ~6 min) starting');
  const t = Date.now();
  // Hard per-gate timeout: 12 min (suite is normally ~6 min). If it blows
  // past that, kill the spawned process so we don't hang the wall.
  const r = runSync(npmBin, ['test'], { silent: true, timeoutMs: 720_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  // Semantic: exit 0 AND test runner reports `fail 0`. Note: parsing the
  // node --test summary; "ℹ fail N" where N must be 0.
  const exitOk = r.status === 0;
  const failMatch = out.match(/ℹ?\s*fail\s+(\d+)/);
  const failsReported = failMatch ? parseInt(failMatch[1], 10) : null;
  const passMatch = out.match(/ℹ?\s*pass\s+(\d+)/);
  const passesReported = passMatch ? parseInt(passMatch[1], 10) : null;
  const failsOk = failsReported === 0;
  const ok = exitOk && failsOk;
  const fail_reasons = [];
  if (!exitOk) fail_reasons.push('exit ' + r.status + (r.signal ? ' signal ' + r.signal : ''));
  if (!failsOk) fail_reasons.push('failsReported=' + failsReported);
  const tail = out.split(/\r?\n/).slice(-15).join('\n');
  recordResult('test', ok, {
    detail: ok ? `pass ${passesReported} / fail ${failsReported}` : (fail_reasons.join('; ') + '\n' + tail),
    duration_ms: Date.now() - t,
    passes: passesReported,
    fails: failsReported,
  });
  progress(`test ${ok ? 'PASS' : 'FAIL'} pass=${passesReported} fail=${failsReported} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  return ok;
}

async function gateSdkSmoke() {
  if (!shouldRun('sdk-smoke')) return recordResult('sdk-smoke', true, { skipped: true });
  progress('sdk-smoke booting server on ' + SERVER_BASE);
  const t = Date.now();
  const server = bootServer();
  try {
    const up = await waitForServer(SERVER_BASE, 30_000);
    if (!up) {
      recordResult('sdk-smoke', false, {
        detail: 'server failed to come up on ' + SERVER_BASE + ' within 30s (port already in use? KOLM_RELEASE_VERIFY_PORT override available)',
        duration_ms: Date.now() - t,
      });
      return false;
    }
    progress('sdk-smoke server up; running SDK tests');
    const r = runSync(nodeBin, ['--test', SDK_TEST], {
      silent: true,
      env: { KOLM_BASE_URL: SERVER_BASE, RECIPE_BASE_URL: SERVER_BASE },
      timeoutMs: 120_000,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const exitOk = r.status === 0;
    const failMatch = out.match(/(?:ℹ?\s*fail|fail)\s+(\d+)/);
    const failsReported = failMatch ? parseInt(failMatch[1], 10) : null;
    const failsOk = failsReported === 0;
    const ok = exitOk && failsOk;
    const tail = out.split(/\r?\n/).slice(-12).join('\n');
    recordResult('sdk-smoke', ok, {
      detail: ok ? 'sdk smoke green' : ('exit ' + r.status + ' fails=' + failsReported + '\n' + tail),
      duration_ms: Date.now() - t,
    });
    return ok;
  } finally {
    try { server.kill('SIGTERM'); } catch (_) {}
    // Give the server a beat to release the port, then SIGKILL if still up.
    await new Promise((r) => setTimeout(r, 250));
    try { server.kill('SIGKILL'); } catch (_) {}
  }
}

// Run kolm CLI, parse JSON, hand the parsed envelope to a validator.
// validator(parsed, raw) => { ok: boolean, reason?: string }
function gateCli(name, argv, validator) {
  if (!shouldRun(name)) { recordResult(name, true, { skipped: true }); return true; }
  progress(`${name} running: kolm ${argv.join(' ')}`);
  const t = Date.now();
  const r = runSync(nodeBin, [KOLM_CLI, ...argv], { silent: true, timeoutMs: 60_000 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (_) {}
  if (parsed === null) {
    recordResult(name, false, {
      detail: 'non-JSON stdout (first 300): ' + (r.stdout || '').slice(0, 300) + ' | stderr: ' + (r.stderr || '').slice(0, 200),
      exit: r.status,
      duration_ms: Date.now() - t,
    });
    return false;
  }
  const verdict = validator ? validator(parsed, r) : { ok: true };
  const ok = !!verdict.ok;
  recordResult(name, ok, {
    detail: ok ? (verdict.reason || ('fields: ' + Object.keys(parsed).slice(0, 10).join(','))) : (verdict.reason || 'validator rejected'),
    exit: r.status,
    duration_ms: Date.now() - t,
  });
  return ok;
}

// ---------------- Driver ----------------

(async function main() {
  await gateLintRefs();
  await gateTests();
  await gateSdkSmoke();

  // doctor: ok:true + blockers:0 — unless --allow-logged-out, in which case
  // we accept ok:false PROVIDED the only blocker is the api-key check.
  gateCli('doctor', ['doctor', '--json'], (parsed, r) => {
    if (r.status === 0 && parsed.ok === true && parsed.blockers === 0) {
      return { ok: true, reason: 'ok:true blockers:0' };
    }
    if (allowLoggedOut) {
      // Find non-api-key blockers; if all blockers are auth-related, accept.
      const failing = (parsed.checks || []).filter((c) => c.status === 'missing' || c.status === 'fail' || c.status === 'error');
      const nonAuth = failing.filter((c) => !/api[ -_]?key|auth|logged|signup|login/i.test(c.name || '') && !/api[ -_]?key|auth|logged|signup|login/i.test(c.detail || ''));
      if (nonAuth.length === 0) {
        return { ok: true, reason: '--allow-logged-out: only auth blockers (' + failing.map((c) => c.name).join(', ') + ')' };
      }
      return { ok: false, reason: '--allow-logged-out but non-auth blockers present: ' + nonAuth.map((c) => c.name).join(', ') };
    }
    return { ok: false, reason: `exit=${r.status} ok=${parsed.ok} blockers=${parsed.blockers}` };
  });

  // whoami: shape must be present; if not --allow-logged-out, require logged_in:true.
  gateCli('whoami', ['whoami', '--json'], (parsed) => {
    if (typeof parsed.logged_in !== 'boolean') return { ok: false, reason: 'envelope missing logged_in' };
    if (allowLoggedOut) return { ok: true, reason: '--allow-logged-out (logged_in=' + parsed.logged_in + ')' };
    if (parsed.logged_in === true) return { ok: true, reason: 'logged_in:true' };
    return { ok: false, reason: 'logged_in:false (rerun with --allow-logged-out to ignore)' };
  });

  // verify: ok:true AND production_ready:true (claims-redactor is real).
  if (!fs.existsSync(CLAIMS_KOLM)) {
    recordResult('verify-claims', false, { detail: 'missing artifact: ' + CLAIMS_KOLM });
  } else {
    gateCli('verify-claims', ['verify', CLAIMS_KOLM, '--json'], (parsed, r) => {
      if (r.status !== 0) return { ok: false, reason: 'verify exit=' + r.status };
      if (parsed.ok !== true) return { ok: false, reason: 'verify ok!=true (' + parsed.ok + ')' };
      if (parsed.production_ready !== true) return { ok: false, reason: 'production_ready!=true (' + parsed.production_ready + ')' };
      return { ok: true, reason: 'ok:true production_ready:true verdict=' + parsed.verdict };
    });
  }

  // billing-tiers: envelope must expose a non-empty plans array. Cloud shape:
  // {sub:"tiers",fallback:false,data:{source,plans:[...],stripe:{ready,...}}}.
  // Offline fallback acceptable (fallback:true) as long as plans is non-empty.
  gateCli('billing-tiers', ['billing', 'tiers', '--json'], (parsed) => {
    const plans = (parsed.data && Array.isArray(parsed.data.plans)) ? parsed.data.plans
                : (Array.isArray(parsed.plans) ? parsed.plans
                : (Array.isArray(parsed.data) ? parsed.data
                : (Array.isArray(parsed.tiers) ? parsed.tiers : null)));
    if (!plans) return { ok: false, reason: 'no plans array on envelope (looked at data.plans, plans, data, tiers)' };
    if (plans.length === 0) return { ok: false, reason: 'plans array empty' };
    const stripe = parsed.data && parsed.data.stripe;
    const stripeOk = !stripe || stripe.ready !== false;
    if (!stripeOk) return { ok: false, reason: 'stripe.ready:false (paid links not configured)' };
    return { ok: true, reason: plans.length + ' plans' + (parsed.fallback ? ' (offline fallback)' : ' (cloud)') + (stripe ? ', stripe.ready=' + stripe.ready : '') };
  });

  clearTimeout(wallTimer);
  const allOk = results.every((r) => r.ok || r.skipped);
  const duration_ms = Date.now() - wallStart;
  const summary = { ok: allOk, duration_ms, gates: results, allow_logged_out: allowLoggedOut };
  if (jsonMode) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    log('');
    log('---');
    log((allOk ? 'PASS' : 'FAIL') + '  release-verify  (' + duration_ms + ' ms)');
    for (const r of results) log('  ' + (r.skipped ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL')) + '  ' + r.gate + (r.duration_ms ? `  (${r.duration_ms}ms)` : '') + (r.detail && !r.ok ? `  -- ${r.detail.split('\n')[0]}` : ''));
  }
  process.exit(allOk ? 0 : 1);
})().catch((e) => {
  clearTimeout(wallTimer);
  if (jsonMode) process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e), gates: results }) + '\n');
  else logErr('release-verify error:', e && e.stack || e);
  process.exit(2);
});
