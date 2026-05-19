// W470 P1-6 release-verify driver.
//
// One script that re-runs every acceptance gate the audit/DoD pinned to
// "must be green before we ship." Each gate exits non-zero on the first
// failure with a structured summary line so CI can grep.
//
// Gates, in order:
//   1.  npm run lint:refs                (static-ref + href integrity)
//   2.  npm test                         (full test suite, --test-concurrency=1)
//   3.  SDK smoke against local server   (boots PORT=3939, then runs
//                                         sdk/node/test/sdk.test.mjs)
//   4.  kolm doctor --json               (CLI must emit parseable JSON)
//   5.  kolm whoami --json               (CLI logged-in / logged-out envelope)
//   6.  kolm verify <kolm> --json        (claims-redactor.kolm artifact)
//   7.  kolm billing tiers --json        (offline-safe local fallback)
//
// Invocation:
//   node scripts/release-verify.cjs               # all gates
//   node scripts/release-verify.cjs --skip=test   # skip a gate by name
//   node scripts/release-verify.cjs --json        # one machine-readable line
//
// Designed to be safe to run on a fresh checkout — never touches git, never
// pushes, never writes outside /tmp + the repo's normal test scratch.

// Suppress Node's DEP0190 warning about shell:true + argv concatenation.
// We only ever pass shell:true to invoke npm.cmd with a fixed argv we control
// (e.g. ['run', 'lint:refs']), so the security caveat (untrusted user input
// getting concatenated into a shell string) doesn't apply here. We filter the
// specific warning rather than blanket-suppressing all warnings.
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
const skipFlag = args.find(a => a.startsWith('--skip='));
const skipSet = new Set(skipFlag ? skipFlag.slice('--skip='.length).split(',').map(s => s.trim()) : []);

const isWin = process.platform === 'win32';
const npmBin = isWin ? 'npm.cmd' : 'npm';
const nodeBin = process.execPath;

const SERVER_PORT = parseInt(process.env.KOLM_RELEASE_VERIFY_PORT || '3939', 10);
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;

function log(...m) { if (!jsonMode) console.log(...m); }
function logErr(...m) { if (!jsonMode) console.error(...m); }

function runSync(cmd, argv, opts = {}) {
  // On Windows, .cmd / .bat shims (npm.cmd) require shell:true to be located
  // and executed correctly by spawnSync — otherwise the process either fails
  // to spawn or exits non-zero with empty stdout/stderr.
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
  server.stdout.on('data', (b) => { /* swallow boot chatter unless jsonMode is false and verbose */ });
  server.stderr.on('data', (b) => { /* same */ });
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

async function gateLintRefs() {
  if (!shouldRun('lint:refs')) return recordResult('lint:refs', true, { skipped: true });
  const r = runSync(npmBin, ['run', 'lint:refs'], { silent: true });
  const ok = r.status === 0;
  recordResult('lint:refs', ok, { detail: ok ? '' : (r.stderr || r.stdout).slice(-400) });
  return ok;
}

async function gateTests() {
  if (!shouldRun('test')) return recordResult('test', true, { skipped: true });
  const r = runSync(npmBin, ['test'], { silent: true });
  const ok = r.status === 0;
  // Last few lines carry the test-runner summary (`# tests N`, `# pass N`).
  const tail = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).slice(-12).join('\n');
  recordResult('test', ok, { detail: tail });
  return ok;
}

async function gateSdkSmoke() {
  if (!shouldRun('sdk-smoke')) return recordResult('sdk-smoke', true, { skipped: true });
  const server = bootServer();
  try {
    const up = await waitForServer(SERVER_BASE, 30_000);
    if (!up) {
      recordResult('sdk-smoke', false, { detail: 'server failed to come up on ' + SERVER_BASE });
      return false;
    }
    const r = runSync(nodeBin, ['--test', SDK_TEST], {
      silent: true,
      env: { KOLM_BASE_URL: SERVER_BASE, RECIPE_BASE_URL: SERVER_BASE },
      timeoutMs: 120_000,
    });
    const ok = r.status === 0;
    const tail = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).slice(-12).join('\n');
    recordResult('sdk-smoke', ok, { detail: tail });
    return ok;
  } finally {
    try { server.kill('SIGTERM'); } catch (_) {}
  }
}

function gateCliJson(name, argv) {
  if (!shouldRun(name)) { recordResult(name, true, { skipped: true }); return true; }
  const r = runSync(nodeBin, [KOLM_CLI, ...argv], { silent: true, timeoutMs: 60_000 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (_) {}
  const ok = parsed !== null;
  const detail = ok
    ? 'json fields: ' + Object.keys(parsed).slice(0, 10).join(',')
    : 'non-JSON stdout (first 200): ' + (r.stdout || '').slice(0, 200);
  recordResult(name, ok, { detail });
  return ok;
}

(async function main() {
  const t0 = Date.now();
  await gateLintRefs();
  await gateTests();
  await gateSdkSmoke();
  gateCliJson('doctor', ['doctor', '--json']);
  gateCliJson('whoami', ['whoami', '--json']);
  // verify wants a known artifact; --json is the structured envelope path.
  if (!fs.existsSync(CLAIMS_KOLM)) {
    recordResult('verify-claims', false, { detail: 'missing artifact: ' + CLAIMS_KOLM });
  } else {
    gateCliJson('verify-claims', ['verify', CLAIMS_KOLM, '--json']);
  }
  gateCliJson('billing-tiers', ['billing', 'tiers', '--json']);

  const allOk = results.every((r) => r.ok || r.skipped);
  const duration_ms = Date.now() - t0;
  const summary = {
    ok: allOk,
    duration_ms,
    gates: results,
  };
  if (jsonMode) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    log('');
    log('---');
    log((allOk ? 'PASS' : 'FAIL') + '  release-verify  (' + duration_ms + ' ms)');
    for (const r of results) log('  ' + (r.skipped ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL')) + '  ' + r.gate);
  }
  process.exit(allOk ? 0 : 1);
})().catch((e) => {
  if (jsonMode) process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }) + '\n');
  else logErr('release-verify error:', e && e.stack || e);
  process.exit(2);
});
