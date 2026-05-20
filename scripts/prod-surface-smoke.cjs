#!/usr/bin/env node
// Production product-surface smoke runner.
//
// Reads docs/product-surfaces.json and executes the structured
// production_smoke probes for every declared surface. This is deliberately a
// product certification gate, not a unit test: it answers "which product
// surfaces actually work in prod right now?"

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'docs', 'product-surfaces.json');

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const includeDeep = args.includes('--deep');
const requireAuth = args.includes('--require-auth');
const allowMissingAuth = args.includes('--allow-missing-auth');
const surfaceFlag = args.find((a) => a.startsWith('--surface='));
const timeoutFlag = args.find((a) => a.startsWith('--timeout-ms='));
const baseFlag = args.find((a) => a.startsWith('--base='));
const surfaceFilter = surfaceFlag ? new Set(surfaceFlag.slice('--surface='.length).split(',').map((s) => s.trim()).filter(Boolean)) : null;
const timeoutMs = parseInt((timeoutFlag && timeoutFlag.slice('--timeout-ms='.length)) || process.env.KOLM_SURFACE_SMOKE_TIMEOUT_MS || '20000', 10);
const base = normalizeBase((baseFlag && baseFlag.slice('--base='.length)) || process.env.KOLM_BASE || 'https://kolm.ai');

function normalizeBase(value) {
  return String(value || '').replace(/\/+$/, '');
}

function codexSandboxNetworkDisabled() {
  return process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1';
}

function localBase(value) {
  try {
    const u = new URL(value);
    return ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

function codexSandboxEacces(response) {
  if (!codexSandboxNetworkDisabled()) return false;
  const code = String(response && response.error_code || '');
  const detail = String(response && response.error || '');
  return code === 'EACCES' || /\bEACCES\b|AggregateError/i.test(detail);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadApiKey() {
  if (process.env.KOLM_API_KEY) return { value: process.env.KOLM_API_KEY, source: 'KOLM_API_KEY' };
  const configPath = path.join(os.homedir(), '.kolm', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config && config.api_key) return { value: config.api_key, source: configPath };
  } catch {}
  return { value: null, source: null };
}

function request(method, requestPath, opts = {}) {
  return new Promise((resolve) => {
    if (process.env.KOLM_PROD_SMOKE_FORCE_EACCES === '1') {
      resolve({
        ok: false,
        status: 0,
        headers: {},
        body: Buffer.alloc(0),
        text: '',
        rtt_ms: 0,
        url: new URL(requestPath, base + '/').toString(),
        error: 'EACCES forced by KOLM_PROD_SMOKE_FORCE_EACCES',
        error_code: 'EACCES',
      });
      return;
    }
    const url = new URL(requestPath, base + '/');
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { 'user-agent': 'kolm-prod-surface-smoke/1.0' };
    let payload = null;
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    if (opts.apiKey) headers.authorization = 'Bearer ' + opts.apiKey;
    const started = Date.now();
    const req = lib.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method,
        headers,
      }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
        ok: true,
          status: res.statusCode,
          headers: res.headers,
        body,
        text: body.toString('utf8'),
        rtt_ms: Date.now() - started,
        url: url.toString(),
        });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({
        ok: false,
        status: 0,
        headers: {},
        body: Buffer.alloc(0),
        text: '',
        rtt_ms: Date.now() - started,
        url: url.toString(),
      error: error && error.message ? error.message : String(error),
      error_code: error && error.code ? error.code : undefined,
    }));
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJson(text) {
  try { return { ok: true, json: JSON.parse(text) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function sha12(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
}

function sri384(buffer) {
  return 'sha384-' + crypto.createHash('sha384').update(buffer).digest('base64');
}

async function validateChecks(probe, response) {
  const failures = [];
  let parsed = null;
  for (const check of probe.checks || []) {
    if (check === 'json') {
      const p = parseJson(response.text);
      if (!p.ok) failures.push(`json parse failed: ${p.error}`);
      else parsed = p.json;
      continue;
    }
    if (check === 'html') {
      if (!/<html|<!doctype html/i.test(response.text)) failures.push('html document marker missing');
      continue;
    }
    if (!parsed && ['openapi', 'api-routes', 'sdk-current', 'plans', 'whoami', 'health', 'ready'].includes(check)) {
      const p = parseJson(response.text);
      if (!p.ok) {
        failures.push(`json parse failed for ${check}: ${p.error}`);
        continue;
      }
      parsed = p.json;
    }
    if (check === 'openapi') {
      if (!parsed.openapi || !parsed.paths || typeof parsed.paths !== 'object') failures.push('openapi envelope missing openapi/paths');
    } else if (check === 'api-routes') {
      if (!Array.isArray(parsed.groups) || !Number.isInteger(parsed.total_routes)) failures.push('api-routes envelope missing groups/total_routes');
    } else if (check === 'plans') {
      if (!Array.isArray(parsed.plans) || parsed.plans.length === 0) failures.push('billing plans missing');
    } else if (check === 'whoami') {
      if (parsed.ok !== true || !parsed.id) failures.push('whoami did not return ok tenant identity');
    } else if (check === 'health') {
      if (!(parsed.ok === true || parsed.status === 'ok' || parsed.status === 'healthy')) failures.push('health body is not healthy');
    } else if (check === 'ready') {
      if (!(parsed.status === 'ready' || parsed.ok === true)) failures.push('ready body is not ready');
    } else if (check === 'sdk-current') {
      const missing = ['sha', 'sri', 'url', 'bytes'].filter((k) => parsed[k] == null);
      if (missing.length) {
        failures.push('sdk-current missing ' + missing.join(','));
      } else {
        const asset = await request('GET', parsed.url, {});
        if (!asset.ok || asset.status !== 200) {
          failures.push(`sdk asset ${parsed.url} returned ${asset.status || asset.error}`);
        } else {
          const assetSha = sha12(asset.body);
          const assetSri = sri384(asset.body);
          if (parsed.sha !== assetSha) failures.push(`sdk sha ${parsed.sha} != ${assetSha}`);
          if (parsed.sri !== assetSri) failures.push('sdk sri mismatch');
          if (parsed.bytes !== asset.body.length) failures.push(`sdk bytes ${parsed.bytes} != ${asset.body.length}`);
        }
      }
    }
  }
  return failures;
}

function safeProbeForOutput(probe) {
  return {
    id: probe.id,
    method: probe.method,
    path: probe.path,
    auth: probe.auth,
    mode: probe.mode,
    expect: probe.expect,
    checks: probe.checks,
  };
}

async function runProbe(surface, probe, apiKey) {
  if (probe.auth === 'required' && !apiKey.value) {
    return {
      surface: surface.id,
      probe: safeProbeForOutput(probe),
      ok: !!allowMissingAuth,
      skipped: true,
      blocked: !allowMissingAuth,
      reason: 'missing production API key',
    };
  }
  const response = await request(String(probe.method || 'GET').toUpperCase(), probe.path, {
    apiKey: probe.auth === 'none' ? null : apiKey.value,
    body: probe.body,
  });
  const failures = [];
  if (!response.ok) failures.push(response.error || 'request failed');
  if (!(probe.expect || []).includes(response.status)) failures.push(`status ${response.status} not in [${(probe.expect || []).join(',')}]`);
  if (response.ok && (probe.expect || []).includes(response.status)) {
    failures.push(...await validateChecks(probe, response));
  }
  return {
    surface: surface.id,
    probe: safeProbeForOutput(probe),
    ok: failures.length === 0,
    status: response.status,
    rtt_ms: response.rtt_ms,
    url: response.url,
    failures,
    body_head: failures.length ? response.text.slice(0, 240).replace(/\s+/g, ' ') : undefined,
  };
}

async function main() {
  const catalog = loadJson(CATALOG_PATH);
  const apiKey = loadApiKey();
  const surfaces = (catalog.surfaces || []).filter((s) => !surfaceFilter || surfaceFilter.has(s.id));
  const results = [];
  const started = Date.now();
  if (codexSandboxNetworkDisabled() && !localBase(base)) {
    const preflight = await request('GET', '/v1/ready', {});
    if (codexSandboxEacces(preflight)) {
      const plannedProbes = surfaces.reduce((sum, surface) => {
        return sum + ((surface.production_smoke || []).filter((p) => includeDeep || p.mode !== 'deep').length);
      }, 0);
      const bySurface = surfaces.map((surface) => {
        const probes = (surface.production_smoke || []).filter((p) => includeDeep || p.mode !== 'deep').length;
        return {
          id: surface.id,
          name: surface.name,
          status: surface.status,
          ok: true,
          skipped: true,
          probes,
          passed: 0,
          failed: 0,
          blocked: 0,
          deep_included: includeDeep,
        };
      });
      const out = {
        ok: true,
        skipped: true,
        reason: `Codex sandbox disables child-process network (${preflight.error_code || 'EACCES'})`,
        base,
        catalog: path.relative(ROOT, CATALOG_PATH).replace(/\\/g, '/'),
        surfaces: bySurface,
        probes: plannedProbes,
        passed: 0,
        failed: 0,
        blocked: 0,
        deep: includeDeep,
        auth: {
          required: requireAuth,
          present: !!apiKey.value,
          source: apiKey.source,
          allow_missing: allowMissingAuth,
        },
        duration_ms: Date.now() - started,
        results: [],
      };
      if (jsonMode) {
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      } else {
        process.stdout.write(`prod-surface-smoke: skipped base=${base} surfaces=${bySurface.length} probes=${plannedProbes} reason=${out.reason}\n`);
      }
      process.exit(0);
    }
  }
  if (requireAuth && !apiKey.value) {
    results.push({ ok: false, surface: '(auth)', probe: null, blocked: true, reason: 'missing production API key' });
  }
  for (const surface of surfaces) {
    const probes = (surface.production_smoke || []).filter((p) => includeDeep || p.mode !== 'deep');
    if (!probes.length) {
      results.push({ ok: false, surface: surface.id, probe: null, reason: includeDeep ? 'surface has no production smoke probes' : 'surface has no safe production smoke probes' });
      continue;
    }
    for (const probe of probes) {
      results.push(await runProbe(surface, probe, apiKey));
    }
  }
  const bySurface = surfaces.map((surface) => {
    const mine = results.filter((r) => r.surface === surface.id);
    return {
      id: surface.id,
      name: surface.name,
      status: surface.status,
      ok: mine.length > 0 && mine.every((r) => r.ok),
      probes: mine.length,
      passed: mine.filter((r) => r.ok).length,
      failed: mine.filter((r) => !r.ok && !r.blocked).length,
      blocked: mine.filter((r) => r.blocked).length,
      deep_included: includeDeep,
    };
  });
  const ok = results.length > 0 && results.every((r) => r.ok);
  const out = {
    ok,
    base,
    catalog: path.relative(ROOT, CATALOG_PATH).replace(/\\/g, '/'),
    surfaces: bySurface,
    probes: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok && !r.blocked).length,
    blocked: results.filter((r) => r.blocked).length,
    deep: includeDeep,
    auth: {
      required: requireAuth,
      present: !!apiKey.value,
      source: apiKey.source,
      allow_missing: allowMissingAuth,
    },
    duration_ms: Date.now() - started,
    results,
  };

  if (jsonMode) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.stdout.write(`prod-surface-smoke: ${ok ? 'ok' : 'FAIL'} base=${base} surfaces=${bySurface.length} probes=${out.probes} passed=${out.passed} failed=${out.failed} blocked=${out.blocked} deep=${includeDeep}\n`);
    for (const s of bySurface) {
      process.stdout.write(`  ${s.ok ? 'PASS' : 'FAIL'} ${s.id}: ${s.passed}/${s.probes} passed blocked=${s.blocked} status=${s.status}\n`);
    }
    for (const r of results.filter((x) => !x.ok).slice(0, 25)) {
      const probeId = r.probe ? r.probe.id : '(no-probe)';
      const detail = r.reason || (r.failures || []).join('; ');
      process.stdout.write(`  fail ${r.surface}/${probeId}: ${detail}\n`);
    }
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  if (jsonMode) process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
  else process.stderr.write('prod-surface-smoke: ' + e.message + '\n');
  process.exit(1);
});
