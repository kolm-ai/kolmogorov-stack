// W471 release-verify driver (rewrite of W470 P1-6).
//
// One script that re-runs every acceptance gate the audit/DoD pinned to
// "must be green before we ship," with SEMANTIC validation per gate (not
// just "did it emit JSON"), a hard wall-clock ceiling so the driver can
// never hang, and per-gate progress so the user always knows where it is.
//
// Gates, in order:
//   1.  npm run lint:refs                (static-ref + href integrity)
//   2.  openapi-sync                     (W490: public/openapi.json covers every
//                                         non-stub route in api-routes.json)
//   3.  sdk-manifest                     (current + versioned browser SDK assets
//                                         exist, match hashes/SRI, and are not ignored)
//   4.  npm test                         (full test suite, --test-concurrency=1)
//   5.  SDK smoke against local server   (boots PORT=3939, then runs
//                                         sdk/node/test/sdk.test.mjs)
//   6.  kolm doctor --json               (ok:true + blockers:0 unless --allow-logged-out)
//   7.  kolm whoami --json               (logged_in:true unless --allow-logged-out)
//   8.  kolm verify <kolm> --json        (ok:true + production_ready:true)
//   9.  kolm billing tiers --json        (data is non-empty tier list)
//
// Invocation:
//   node scripts/release-verify.cjs                       # all gates
//   node scripts/release-verify.cjs --skip=test           # skip a gate by name
//   node scripts/release-verify.cjs --json                # one machine-readable line
//   node scripts/release-verify.cjs --allow-logged-out    # accept rejected api-key
//   node scripts/release-verify.cjs --test-timeout-ms=1800000  # full suite gate ceiling
//   node scripts/release-verify.cjs --test-shards=8            # run sorted tests in 8 chunks
//   node scripts/release-verify.cjs --timeout-ms=2100000       # wall ceiling (default = test timeout + 5m)
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
const os = require('node:os');
const crypto = require('node:crypto');

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
const testTimeoutFlag = args.find((a) => a.startsWith('--test-timeout-ms='));
const testShardsFlag = args.find((a) => a.startsWith('--test-shards='));
const TEST_TIMEOUT_MS = parseInt((testTimeoutFlag && testTimeoutFlag.slice('--test-timeout-ms='.length)) || process.env.KOLM_RELEASE_VERIFY_TEST_TIMEOUT_MS || '1800000', 10);
const TEST_SHARDS = Math.max(1, parseInt((testShardsFlag && testShardsFlag.slice('--test-shards='.length)) || process.env.KOLM_RELEASE_VERIFY_TEST_SHARDS || '1', 10) || 1);
const WALL_TIMEOUT_MS = parseInt((timeoutFlag && timeoutFlag.slice('--timeout-ms='.length)) || process.env.KOLM_RELEASE_VERIFY_TIMEOUT_MS || String(Math.max(600000, TEST_TIMEOUT_MS + 300000)), 10);

const isWin = process.platform === 'win32';
const npmBin = isWin ? 'npm.cmd' : 'npm';
const nodeBin = process.execPath;

const SERVER_PORT = parseInt(process.env.KOLM_RELEASE_VERIFY_PORT || '3939', 10);
const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;
let TEST_RUN_ROOT = null;

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
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? { code: r.error.code, message: r.error.message } : null };
}

function nodeTestCount(out, label) {
  const re = new RegExp('(?:^|\\r?\\n)[^\\r\\n]*\\b' + label + '\\s+(\\d+)', 'gi');
  const matches = Array.from(String(out || '').matchAll(re));
  if (matches.length === 0) return null;
  return parseInt(matches[matches.length - 1][1], 10);
}

function failedTestNames(out) {
  const names = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = line.match(/^[\s\S]*?✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/);
    if (m) names.push(m[1].trim());
  }
  return Array.from(new Set(names));
}

function listTestFiles() {
  return fs.readdirSync(path.join(REPO_ROOT, 'tests'))
    .filter((name) => name.endsWith('.test.js'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(REPO_ROOT, 'tests', name));
}

function shardTestFiles(files, shardCount) {
  const shards = Array.from({ length: shardCount }, () => []);
  files.forEach((file, idx) => shards[idx % shardCount].push(file));
  return shards.filter((shard) => shard.length > 0);
}

function rel(file) {
  return path.relative(REPO_ROOT, file).replace(/\\/g, '/');
}

function testRunRoot() {
  if (!TEST_RUN_ROOT) {
    const configured = process.env.KOLM_RELEASE_VERIFY_TEST_ROOT;
    TEST_RUN_ROOT = configured || fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-release-verify-'));
  }
  return TEST_RUN_ROOT;
}

function testEnv(label) {
  const safe = String(label || 'test').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const home = path.join(testRunRoot(), safe, 'home');
  fs.mkdirSync(path.join(home, '.kolm'), { recursive: true });
  return {
    HOME: home,
    USERPROFILE: home,
    NODE_ENV: 'test',
    // Clear operator-level overrides so tests that intentionally switch HOME
    // keep controlling their own storage roots. NODE_ENV=test still keeps
    // shared stores such as event-store out of the real user profile.
    KOLM_HOME: '',
    KOLM_DATA_DIR: '',
    KOLM_ARTIFACT_DIR: '',
  };
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
    env: { ...process.env, ...testEnv('sdk-smoke-server'), PORT: String(SERVER_PORT), KOLM_RATE_LIMIT_DISABLED: '1' },
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
  progress(`test (full suite, timeout ${TEST_TIMEOUT_MS}ms, shards ${TEST_SHARDS}) starting`);
  const t = Date.now();
  if (TEST_SHARDS > 1) {
    const files = listTestFiles();
    const shards = shardTestFiles(files, TEST_SHARDS);
    const shardSummaries = [];
    let passSum = 0;
    let failSum = 0;
    let timedOut = false;
    for (let i = 0; i < shards.length; i++) {
      const elapsed = Date.now() - t;
      const remaining = TEST_TIMEOUT_MS - elapsed;
      const shard = shards[i];
      if (remaining <= 0) {
        timedOut = true;
        shardSummaries.push({
          shard: i + 1,
          total_shards: shards.length,
          files: shard.length,
          first_file: rel(shard[0]),
          last_file: rel(shard[shard.length - 1]),
          ok: false,
          status: null,
          signal: null,
          passes: null,
          fails: null,
          timed_out: true,
          skipped_due_to_timeout: true,
        });
        break;
      }
      progress(`test shard ${i + 1}/${shards.length} (${shard.length} files) starting`);
      const shardStart = Date.now();
      const r = runSync(nodeBin, ['--test', '--test-concurrency=1', ...shard], {
        silent: true,
        timeoutMs: remaining,
        env: testEnv(`shard-${i + 1}`),
      });
      const out = (r.stdout || '') + (r.stderr || '');
      const shardPasses = nodeTestCount(out, 'pass');
      const shardFails = nodeTestCount(out, 'fail');
      const shardTimedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
      const shardOk = r.status === 0 && shardFails === 0 && !shardTimedOut;
      if (Number.isFinite(shardPasses)) passSum += shardPasses;
      if (Number.isFinite(shardFails)) failSum += shardFails;
      if (shardTimedOut) timedOut = true;
      const summary = {
        shard: i + 1,
        total_shards: shards.length,
        files: shard.length,
        first_file: rel(shard[0]),
        last_file: rel(shard[shard.length - 1]),
        ok: shardOk,
        status: r.status,
        signal: r.signal,
        duration_ms: Date.now() - shardStart,
        passes: shardPasses,
        fails: shardFails,
        timed_out: shardTimedOut,
      };
      const failedTests = failedTestNames(out);
      if (failedTests.length) summary.failed_tests = failedTests;
      if (r.error && r.error.code) summary.error = r.error.code;
      if (!shardOk) summary.tail = out.split(/\r?\n/).slice(-12).join('\n');
      shardSummaries.push(summary);
      progress(`test shard ${i + 1}/${shards.length} ${shardOk ? 'PASS' : 'FAIL'} pass=${shardPasses} fail=${shardFails}`);
      if (shardTimedOut) break;
    }
    const bad = shardSummaries.filter((s) => !s.ok);
    const ok = bad.length === 0 && shardSummaries.length === shards.length;
    const detail = ok
      ? `pass ${passSum} / fail ${failSum} across ${shards.length} shards`
      : `${bad.length} failing/timed-out shard(s): ` + bad.slice(0, 5).map((s) => `#${s.shard} ${s.first_file}..${s.last_file} status=${s.status} signal=${s.signal} fails=${s.fails} timed_out=${s.timed_out}`).join('; ');
    recordResult('test', ok, {
      detail,
      duration_ms: Date.now() - t,
      timeout_ms: TEST_TIMEOUT_MS,
      timed_out: timedOut,
      test_shards: TEST_SHARDS,
      shards: shardSummaries,
      passes: passSum,
      fails: failSum,
    });
    progress(`test ${ok ? 'PASS' : 'FAIL'} pass=${passSum} fail=${failSum} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    return ok;
  }
  // Hard per-gate timeout. The suite has grown substantially across W4xx, so
  // keep this configurable instead of freezing the verifier to an old runtime.
    const r = runSync(npmBin, ['test'], { silent: true, timeoutMs: TEST_TIMEOUT_MS, env: testEnv('unsharded') });
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
  if (r.error && r.error.code) fail_reasons.push('spawn error ' + r.error.code);
  if (!failsOk) fail_reasons.push('failsReported=' + failsReported);
  const tail = out.split(/\r?\n/).slice(-15).join('\n');
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  recordResult('test', ok, {
    detail: ok ? `pass ${passesReported} / fail ${failsReported}` : (fail_reasons.join('; ') + '\n' + tail),
    duration_ms: Date.now() - t,
    timeout_ms: TEST_TIMEOUT_MS,
    timed_out: timedOut,
    test_shards: TEST_SHARDS,
    passes: passesReported,
    fails: failsReported,
  });
  progress(`test ${ok ? 'PASS' : 'FAIL'} pass=${passesReported} fail=${failsReported} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  return ok;
}

// W490 — pin public/openapi.json against public/docs/api-routes.json so doc
// drift caught by humans on PR review never makes it to prod. We don't
// rebuild here (that's the build-openapi.cjs step); we only refuse to ship
// if the on-disk OpenAPI is missing routes that api-routes.json declares.
async function gateOpenapiSync() {
  if (!shouldRun('openapi-sync')) return recordResult('openapi-sync', true, { skipped: true });
  progress('openapi-sync checking');
  const t = Date.now();
  try {
    const oa = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'public', 'openapi.json'), 'utf8'));
    const routes = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'public', 'docs', 'api-routes.json'), 'utf8'));
    const missing = [];
    let nonStubTotal = 0;
    for (const g of routes.groups || []) {
      for (const r of g.routes || []) {
        if (r.stub) continue;
        nonStubTotal++;
        const opPath = r.path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
        const m = r.method.toLowerCase();
        if (!oa.paths[opPath] || !oa.paths[opPath][m]) missing.push(`${r.method} ${r.path}`);
      }
    }
    const ok = missing.length === 0;
    recordResult('openapi-sync', ok, {
      detail: ok ? `${nonStubTotal} non-stub routes all present in openapi.json` : `${missing.length} missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''} (re-run scripts/build-openapi.cjs)`,
      duration_ms: Date.now() - t,
    });
    return ok;
  } catch (e) {
    recordResult('openapi-sync', false, { detail: e.message, duration_ms: Date.now() - t });
    return false;
  }
}

function sdkAssetIgnored(relPath) {
  const git = runSync('git', ['check-ignore', '-q', '--', relPath], { silent: true, timeoutMs: 10_000 });
  if (git.status === 0) return true;
  if (git.status === 1) return false;
  const ignorePath = path.join(REPO_ROOT, '.gitignore');
  if (!fs.existsSync(ignorePath)) return false;
  const ignoredByRepoPattern = fs.readFileSync(ignorePath, 'utf8')
    .split(/\r?\n/)
    .some((line) => line.trim() === 'public/sdk-[0-9a-f]*.js');
  return ignoredByRepoPattern && /^public\/sdk-[0-9a-f]+\.js$/.test(relPath);
}

function verifySdkEntry(entry, label, failures) {
  if (!entry || typeof entry !== 'object') {
    failures.push(`${label} missing`);
    return;
  }
  if (!/^\/sdk-[a-f0-9]{12}\.js$/.test(String(entry.url || ''))) {
    failures.push(`${label} url is not a content-addressed SDK URL`);
    return;
  }
  const relPath = 'public/' + path.basename(entry.url);
  const file = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(file)) {
    failures.push(`${label} points at missing ${relPath}`);
    return;
  }
  if (sdkAssetIgnored(relPath)) failures.push(`${relPath} is ignored by git`);
  const body = fs.readFileSync(file);
  const sha = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  const sri = 'sha384-' + crypto.createHash('sha384').update(body).digest('base64');
  if (entry.sha !== sha) failures.push(`${label} sha ${entry.sha} != ${sha}`);
  if (entry.url !== `/sdk-${sha}.js`) failures.push(`${label} url ${entry.url} != /sdk-${sha}.js`);
  if (entry.sri !== sri) failures.push(`${label} sri mismatch`);
  if (entry.bytes !== body.length) failures.push(`${label} bytes ${entry.bytes} != ${body.length}`);
}

async function gateSdkManifest() {
  if (!shouldRun('sdk-manifest')) return recordResult('sdk-manifest', true, { skipped: true });
  progress('sdk-manifest checking');
  const t = Date.now();
  try {
    const current = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'public', 'sdk-current.json'), 'utf8'));
    const versions = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'public', 'sdk-versions.json'), 'utf8'));
    const failures = [];
    verifySdkEntry(current, 'sdk-current', failures);
    if (!Array.isArray(versions.versions) || versions.versions.length === 0) {
      failures.push('sdk-versions has no versions');
    } else {
      versions.versions.forEach((entry, idx) => verifySdkEntry(entry, `sdk-versions[${idx}]`, failures));
      const first = versions.versions[0];
      if (first && current.url !== first.url) failures.push('sdk-current is not sdk-versions[0]');
    }
    if (versions.current) {
      for (const key of ['sha', 'sri', 'url', 'bytes']) {
        if (versions.current[key] !== current[key]) failures.push(`sdk-versions.current.${key} != sdk-current.${key}`);
      }
    } else {
      failures.push('sdk-versions.current missing');
    }
    const ok = failures.length === 0;
    recordResult('sdk-manifest', ok, {
      detail: ok ? `${versions.versions.length} SDK manifest entries verified` : failures.slice(0, 6).join('; '),
      duration_ms: Date.now() - t,
    });
    return ok;
  } catch (e) {
    recordResult('sdk-manifest', false, { detail: e.message, duration_ms: Date.now() - t });
    return false;
  }
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
      env: { ...testEnv('sdk-smoke-client'), KOLM_BASE_URL: SERVER_BASE, RECIPE_BASE_URL: SERVER_BASE },
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
  await gateOpenapiSync();
  await gateSdkManifest();
  await gateTests();
  await gateSdkSmoke();

  // doctor: ok:true + blockers:0 — unless --allow-logged-out, in which case
  // we both pass the flag THROUGH to the CLI (so it demotes the api-key
  // missing rows to warn, exits 0, and reports blockers:0 naturally) and
  // keep the lenient validator below as a defense-in-depth net for any
  // future blocker we forgot to map to --allow-logged-out.
  const doctorArgv = ['doctor', '--json'];
  if (allowLoggedOut) doctorArgv.push('--allow-logged-out');
  gateCli('doctor', doctorArgv, (parsed, r) => {
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
  // When --allow-logged-out is set, pass through so the CLI returns logged_in:false
  // structurally instead of process.exit(MISSING_PREREQ).
  const whoamiArgv = ['whoami', '--json'];
  if (allowLoggedOut) whoamiArgv.push('--allow-logged-out');
  gateCli('whoami', whoamiArgv, (parsed) => {
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
