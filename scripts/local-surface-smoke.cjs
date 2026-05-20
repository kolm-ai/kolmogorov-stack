#!/usr/bin/env node
// Local product-surface smoke harness.
//
// Boots the backend with an isolated data/artifact directory, provisions a
// disposable enterprise tenant, then runs the same product-surface probes used
// by scripts/prod-surface-smoke.cjs. This gives local certification the same
// shape as production certification without relying on ~/.kolm/config.json.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const timeoutFlag = args.find((a) => a.startsWith('--timeout-ms='));
const timeoutMs = parseInt(
  (timeoutFlag && timeoutFlag.slice('--timeout-ms='.length)) ||
  process.env.KOLM_LOCAL_SURFACE_SMOKE_TIMEOUT_MS ||
  '20000',
  10,
);

function withoutOwnedFlags(values) {
  return values.filter((arg) => !arg.startsWith('--base='));
}

function log(line) {
  process.stderr.write(line + '\n');
}

function request(url, timeout = timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'user-agent': 'kolm-local-surface-smoke/1.0' },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({
        ok: true,
        status: res.statusCode,
        rtt_ms: Date.now() - started,
      }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({
      ok: false,
      status: 0,
      rtt_ms: Date.now() - started,
      error: error && error.message ? error.message : String(error),
    }));
    req.end();
  });
}

function findOpenPort() {
  const requested = parseInt(process.env.KOLM_LOCAL_SURFACE_SMOKE_PORT || '', 10);
  if (Number.isInteger(requested) && requested > 0) return Promise.resolve(requested);
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(() => {
        if (!port) reject(new Error('could not allocate local port'));
        else resolve(port);
      });
    });
  });
}

async function waitForServer(base, child) {
  const deadline = Date.now() + Math.max(timeoutMs, 10000);
  let last = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before /health became ready (code ${child.exitCode})`);
    }
    last = await request(base + '/health', Math.min(timeoutMs, 5000));
    if (last.ok && last.status === 200) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const detail = last && last.error ? last.error : `status ${last ? last.status : 'n/a'}`;
  throw new Error(`/health did not become ready at ${base}: ${detail}`);
}

function rememberTail(lines, chunk) {
  const text = Buffer.from(chunk).toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    lines.push(line);
    if (lines.length > 80) lines.shift();
  }
}

async function provisionTenant(env) {
  Object.assign(process.env, env);
  const authUrl = pathToFileURL(path.join(ROOT, 'src', 'auth.js')).href + `?surface_smoke=${Date.now()}`;
  const { provisionTenant } = await import(authUrl);
  const plan = process.env.KOLM_LOCAL_SURFACE_SMOKE_PLAN || 'enterprise';
  return provisionTenant(`surface-smoke-${process.pid}-${Date.now()}`, {
    plan,
    quota: 50000000,
    kind: 'user',
    email: `surface-smoke-${process.pid}@local.test`,
  });
}

function cleanupTemp(tempRoot) {
  if (process.env.KOLM_KEEP_SURFACE_SMOKE_TMP === 'true') {
    log(`local-surface-smoke: kept temp directory ${tempRoot}`);
    return;
  }
  const resolved = path.resolve(tempRoot);
  const tmpRoot = path.resolve(os.tmpdir());
  const safePrefix = path.join(tmpRoot, 'kolm-local-surfaces-');
  if (resolved.startsWith(safePrefix)) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
    } catch (error) {
      log(`local-surface-smoke: temp cleanup skipped (${error.message}) at ${resolved}`);
    }
  }
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  const port = await findOpenPort();
  const base = `http://127.0.0.1:${port}`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-local-surfaces-'));
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    KOLM_STORE_DRIVER: 'json',
    KOLM_DATA_DIR: path.join(tempRoot, 'data'),
    KOLM_ARTIFACT_DIR: path.join(tempRoot, 'artifacts'),
    KOLM_HOME: path.join(tempRoot, 'home'),
    KOLM_ALLOW_JSON_STORE: 'true',
    KOLM_RATE_LIMIT_DISABLED: '1',
    KOLM_CONNECTOR_FIXTURE: process.env.KOLM_CONNECTOR_FIXTURE || '1',
    PUBLIC_BASE_URL: base,
    ADMIN_KEY: process.env.ADMIN_KEY || 'local-surface-smoke-admin-key',
    RECIPE_RECEIPT_SECRET: process.env.RECIPE_RECEIPT_SECRET || 'local-surface-smoke-receipt-secret-2026-05-20',
  };
  let server = null;
  const outputTail = [];
  try {
    fs.mkdirSync(env.KOLM_DATA_DIR, { recursive: true });
    fs.mkdirSync(env.KOLM_ARTIFACT_DIR, { recursive: true });
    const tenant = await provisionTenant(env);
    if (!tenant || !tenant.api_key) throw new Error('failed to provision local smoke tenant');

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    server.stdout.on('data', (chunk) => rememberTail(outputTail, chunk));
    server.stderr.on('data', (chunk) => rememberTail(outputTail, chunk));

    await waitForServer(base, server);
    const smokeArgs = [
      path.join('scripts', 'prod-surface-smoke.cjs'),
      `--base=${base}`,
      ...withoutOwnedFlags(args),
    ];
    if (!smokeArgs.includes('--require-auth')) smokeArgs.push('--require-auth');
    const result = spawnSync(process.execPath, smokeArgs, {
      cwd: ROOT,
      env: {
        ...env,
        KOLM_API_KEY: tenant.api_key,
        KOLM_BASE: base,
      },
      stdio: 'inherit',
      windowsHide: true,
    });
    process.exitCode = result.status == null ? 1 : result.status;
  } catch (error) {
    log(`local-surface-smoke: FAIL ${error && error.message ? error.message : String(error)}`);
    if (outputTail.length) {
      log('local-surface-smoke: server output tail:');
      for (const line of outputTail.slice(-25)) log('  ' + line);
    }
    process.exitCode = 1;
  } finally {
    await stopServer(server);
    cleanupTemp(tempRoot);
  }
}

main().catch((error) => {
  process.stderr.write(`local-surface-smoke: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
