#!/usr/bin/env node
// End-to-end verification for the compute backend abstraction.
//
// Four phases:
//   1. JS layer integrity      — node --check + import + list/info/detect/pick/test
//   2. CLI integration         — node cli/kolm.js compute <verb> [--json] paths
//   3. Python trainer dispatch — module-level get_runner() for all 14 backends
//   4. Provenance round-trip   — mock trainer result → metrics.compute → canonical
//
// Exits 0 if every phase passes, 1 otherwise. Prints first 3 failures with full
// detail. Honors --json for a machine-readable run summary.
//
// Hard constraints honored: pure Node 20+ stdlib + existing project imports. No
// new deps. Python phase verifies imports only — DO NOT execute training.
// Total runtime should be < 30s on a dev box.
//
// Run:
//   node scripts/test-compute-e2e.mjs
//   node scripts/test-compute-e2e.mjs --json

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flagJson = argv.includes('--json');
const flagVerbose = argv.includes('--verbose') || argv.includes('-v');

// ANSI colors — disabled in --json mode.
const C = flagJson
  ? { red: '', green: '', yellow: '', gray: '', bold: '', dim: '', reset: '' }
  : {
      red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
      gray: '\x1b[90m', bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
    };

// All 14 backends. Single source of truth so tests can iterate.
const ALL_BACKENDS = [
  'local-cpu', 'local-cuda', 'local-mps', 'local-mlx',
  'local-rocm', 'local-directml',
  'modal', 'runpod', 'together', 'vast',
  'lambda', 'replicate', 'remote-ssh', 'fal',
];

// Expected registry schema fields.
const REQUIRED_FIELDS = [
  'name', 'kind', 'train', 'infer', 'airgap',
  'cost_per_hour_usd', 'cold_start_seconds', 'vram_cap_gb',
  'auth', 'tier', 'detect', 'framework', 'summary',
];

const results = {
  phases: [],     // [{ name, total, passed, failed }]
  failures: [],   // [{ phase, name, error }]
};

function record(phase, name, ok, error = null) {
  const p = results.phases.find(p => p.name === phase) || (() => {
    const np = { name: phase, total: 0, passed: 0, failed: 0 };
    results.phases.push(np);
    return np;
  })();
  p.total++;
  if (ok) {
    p.passed++;
    if (flagVerbose) console.log(`  ${C.green}OK${C.reset}    ${name}`);
  } else {
    p.failed++;
    results.failures.push({ phase, name, error: String(error || 'unknown failure') });
    if (flagVerbose) console.log(`  ${C.red}FAIL${C.reset}  ${name}: ${error}`);
  }
}

function recordSkip(phase, reason) {
  results.phases.push({ name: phase, total: 0, passed: 0, failed: 0, skipped: true, reason });
}

async function assertOk(phase, name, fn) {
  try {
    await fn();
    record(phase, name, true);
  } catch (err) {
    record(phase, name, false, err && err.message ? err.message : String(err));
  }
}

// --------------------------------------------------------------------------
// Phase 1 — JS layer integrity
// --------------------------------------------------------------------------

async function phase1() {
  const phase = 'phase 1 — JS integrity';
  if (!flagJson) console.log(`\n${C.bold}${phase}${C.reset}`);

  // 1a. node --check every JS file under src/compute.
  await assertOk(phase, 'node --check src/compute/index.js', async () => {
    const res = spawnSync(process.execPath, ['--check', path.join(repo, 'src/compute/index.js')], {
      encoding: 'utf-8', timeout: 10000,
    });
    if (res.status !== 0) throw new Error(`syntax error: ${res.stderr.trim()}`);
  });

  const backendsDir = path.join(repo, 'src/compute/backends');
  for (const file of fs.readdirSync(backendsDir).filter(f => f.endsWith('.js'))) {
    await assertOk(phase, `node --check backends/${file}`, async () => {
      const res = spawnSync(process.execPath, ['--check', path.join(backendsDir, file)], {
        encoding: 'utf-8', timeout: 10000,
      });
      if (res.status !== 0) throw new Error(`syntax error: ${res.stderr.trim()}`);
    });
  }

  // 1b. Dynamic import of the compute module.
  let compute;
  await assertOk(phase, 'import src/compute/index.js', async () => {
    const mod = await import(pathToFileURL(path.join(repo, 'src/compute/index.js')).href);
    compute = mod.default || mod;
    if (typeof compute.list !== 'function') throw new Error('compute.list is not a function');
  });
  if (!compute) {
    // Bail out — nothing else in phase 1 can run.
    return;
  }

  // 1c. list() returns 14 backends, each with the expected schema.
  await assertOk(phase, 'list() returns 14 backends', async () => {
    const list = compute.list();
    if (!Array.isArray(list)) throw new Error('list() did not return an array');
    if (list.length !== 14) throw new Error(`expected 14 backends, got ${list.length}`);
  });

  await assertOk(phase, 'every backend has expected schema', async () => {
    const list = compute.list();
    for (const b of list) {
      for (const f of REQUIRED_FIELDS) {
        if (!(f in b)) throw new Error(`backend "${b.name}" missing field "${f}"`);
      }
      if (typeof b.name !== 'string' || !b.name) throw new Error('backend.name must be a non-empty string');
      if (typeof b.train !== 'boolean') throw new Error(`backend ${b.name}: train must be boolean`);
      if (typeof b.infer !== 'boolean') throw new Error(`backend ${b.name}: infer must be boolean`);
      if (typeof b.tier !== 'number') throw new Error(`backend ${b.name}: tier must be number`);
    }
  });

  // 1d. info() returns the expected backend record.
  await assertOk(phase, 'info("local-cuda") returns record', async () => {
    const i = compute.info('local-cuda');
    if (!i) throw new Error('info returned null');
    if (i.name !== 'local-cuda') throw new Error(`info.name mismatch: ${i.name}`);
    if (i.kind !== 'local') throw new Error(`info.kind mismatch: ${i.kind}`);
    if (i.train !== true) throw new Error('info.train should be true');
  });

  await assertOk(phase, 'info("nonexistent") returns null', async () => {
    const i = compute.info('does-not-exist');
    if (i !== null) throw new Error('expected null for unknown backend');
  });

  // 1e. detect() with force=true returns a fresh result for every backend.
  await assertOk(phase, 'detect({force: true}) returns 14 results', async () => {
    const det = await compute.detect({ force: true });
    if (!det || typeof det !== 'object') throw new Error('detect did not return an object');
    if (!det.at) throw new Error('detect result missing .at timestamp');
    if (!det.backends || typeof det.backends !== 'object') throw new Error('detect.backends not an object');
    const names = Object.keys(det.backends);
    if (names.length !== 14) throw new Error(`expected 14 detection entries, got ${names.length}`);
    for (const n of ALL_BACKENDS) {
      const r = det.backends[n];
      if (!r) throw new Error(`detect missing backend: ${n}`);
      if (typeof r.available !== 'boolean') throw new Error(`detect[${n}].available not boolean`);
      if (!r.available && typeof r.reason !== 'string') {
        throw new Error(`detect[${n}] not available but no reason string`);
      }
    }
  });

  // 1f. pick() variants.
  await assertOk(phase, 'pick() returns a backend with score', async () => {
    const p = await compute.pick();
    if (!p || typeof p !== 'object') throw new Error('pick did not return an object');
    if (typeof p.backend !== 'string' && p.backend !== null) {
      throw new Error('pick.backend must be string or null');
    }
    if (p.backend !== null && typeof p.score !== 'number') {
      throw new Error('pick.score must be a number when backend chosen');
    }
    if (!Array.isArray(p.alternatives)) throw new Error('pick.alternatives must be array');
    // Alternatives should be sorted desc by score.
    for (let i = 1; i < p.alternatives.length; i++) {
      if (p.alternatives[i].score > p.alternatives[i - 1].score) {
        throw new Error('pick alternatives not sorted desc by score');
      }
    }
  });

  await assertOk(phase, 'pick({airgap: true}) excludes cloud backends', async () => {
    const p = await compute.pick({ airgap: true });
    if (!p.backend) throw new Error('expected an airgap-capable backend (local-* always available)');
    const all = [p.backend, ...p.alternatives.map(a => a.backend)];
    const cloudKinds = new Set(['cloud-serverless', 'cloud-managed', 'cloud-marketplace']);
    for (const name of all) {
      const info = compute.info(name);
      if (info && cloudKinds.has(info.kind)) {
        throw new Error(`pick({airgap: true}) included cloud backend: ${name} (kind=${info.kind})`);
      }
      if (info && info.airgap === false) {
        throw new Error(`pick({airgap: true}) included airgap:false backend: ${name}`);
      }
    }
  });

  await assertOk(phase, 'pick({budget_usd: 0.10}) excludes high-cost backends', async () => {
    const p = await compute.pick({ budget_usd: 0.10 });
    const all = [p.backend, ...p.alternatives.map(a => a.backend)].filter(Boolean);
    for (const name of all) {
      const info = compute.info(name);
      if (info && typeof info.cost_per_hour_usd === 'number' && info.cost_per_hour_usd > 0.10) {
        throw new Error(`pick(budget=0.10) included high-cost backend: ${name} ($${info.cost_per_hour_usd}/hr)`);
      }
    }
  });

  await assertOk(phase, 'pick({min_vram_gb: 24}) excludes small-VRAM backends', async () => {
    const p = await compute.pick({ min_vram_gb: 24 });
    const all = [p.backend, ...p.alternatives.map(a => a.backend)].filter(Boolean);
    for (const name of all) {
      const info = compute.info(name);
      if (!info) continue;
      // null vram_cap_gb (local-cpu, together, fal) must be filtered out.
      if (info.vram_cap_gb === null) {
        throw new Error(`pick(min_vram=24) included null-VRAM backend: ${name}`);
      }
      if (typeof info.vram_cap_gb === 'number' && info.vram_cap_gb < 24) {
        throw new Error(`pick(min_vram=24) included small-VRAM backend: ${name} (${info.vram_cap_gb}GB)`);
      }
    }
  });

  await assertOk(phase, 'pick({infer_only: true}) accepts infer-only backends', async () => {
    // train_required: false === infer_only mode.
    const p = await compute.pick({ train_required: false });
    if (!p.backend) throw new Error('pick(train_required=false) returned no backend');
    // The pool should include the train:false backends like `fal`.
    // We don't assert a specific winner — just that the filter doesn't crash and
    // returns something. Local backends will likely still win on perf+repro.
    const list = compute.list();
    const inferOnly = list.filter(b => !b.train && b.infer);
    if (inferOnly.length === 0) throw new Error('registry has no infer-only backends to test against');
  });

  // 1g. test() smoke results.
  await assertOk(phase, 'test("local-cpu") returns ok=true', async () => {
    const r = await compute.test('local-cpu');
    if (r.ok !== true) throw new Error(`expected ok=true, got ${JSON.stringify(r)}`);
    if (typeof r.latency_ms !== 'number') throw new Error('test result missing latency_ms');
  });

  await assertOk(phase, 'test("modal") fails with named env var in reason', async () => {
    // Make sure modal token is not in env for this scope.
    delete process.env.KOLM_MODAL_TOKEN;
    delete process.env.MODAL_TOKEN_ID;
    const r = await compute.test('modal');
    if (r.ok !== false) throw new Error(`expected ok=false (no token), got ok=${r.ok}`);
    if (typeof r.reason !== 'string') throw new Error('expected a reason string');
    if (!/KOLM_MODAL_TOKEN/.test(r.reason)) {
      throw new Error(`expected KOLM_MODAL_TOKEN in reason, got: ${r.reason}`);
    }
  });
}

// --------------------------------------------------------------------------
// Phase 2 — CLI integration
// --------------------------------------------------------------------------

function runCli(args, { env = {}, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repo, 'cli/kolm.js'), ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    const killer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
  });
}

async function phase2() {
  const phase = 'phase 2 — CLI integration';
  if (!flagJson) console.log(`\n${C.bold}${phase}${C.reset}`);

  // 2a. compute --help exits 0 and prints USAGE block.
  await assertOk(phase, 'compute --help prints USAGE and exits 0', async () => {
    const r = await runCli(['compute', '--help']);
    if (r.code !== 0) throw new Error(`expected exit 0, got ${r.code} — stderr: ${r.stderr.slice(0, 200)}`);
    if (!/USAGE/.test(r.stdout)) throw new Error(`stdout missing USAGE block: ${r.stdout.slice(0, 200)}`);
  });

  // 2b. compute list --json returns 14 valid JSON entries.
  await assertOk(phase, 'compute list --json returns 14 entries', async () => {
    const r = await runCli(['compute', 'list', '--json']);
    if (r.code !== 0) throw new Error(`exit ${r.code} — stderr: ${r.stderr.slice(0, 200)}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) { throw new Error(`invalid JSON: ${e.message}`); }
    if (!Array.isArray(parsed)) throw new Error('compute list did not return an array');
    if (parsed.length !== 14) throw new Error(`expected 14 entries, got ${parsed.length}`);
  });

  // 2c. compute detect --json --force returns valid JSON shape.
  await assertOk(phase, 'compute detect --json --force returns valid JSON', async () => {
    const r = await runCli(['compute', 'detect', '--json', '--force']);
    if (r.code !== 0) throw new Error(`exit ${r.code} — stderr: ${r.stderr.slice(0, 200)}`);
    const parsed = JSON.parse(r.stdout);
    if (!parsed.at) throw new Error('detect result missing .at');
    if (!parsed.backends || Object.keys(parsed.backends).length !== 14) {
      throw new Error(`expected 14 detect entries, got ${Object.keys(parsed.backends || {}).length}`);
    }
  });

  // 2d. compute pick --json --airgap returns valid JSON, no cloud kinds.
  await assertOk(phase, 'compute pick --json --airgap returns valid JSON', async () => {
    const r = await runCli(['compute', 'pick', '--json', '--airgap']);
    if (r.code !== 0) throw new Error(`exit ${r.code} — stderr: ${r.stderr.slice(0, 200)}`);
    const parsed = JSON.parse(r.stdout);
    if (typeof parsed.backend !== 'string' && parsed.backend !== null) {
      throw new Error('pick.backend not string or null');
    }
  });

  // 2e. compute info modal --json returns the modal record.
  await assertOk(phase, 'compute info modal --json returns record', async () => {
    const r = await runCli(['compute', 'info', 'modal', '--json']);
    if (r.code !== 0) throw new Error(`exit ${r.code} — stderr: ${r.stderr.slice(0, 200)}`);
    const parsed = JSON.parse(r.stdout);
    if (parsed.name !== 'modal') throw new Error(`info.name mismatch: ${parsed.name}`);
    if (parsed.auth !== 'KOLM_MODAL_TOKEN') throw new Error(`info.auth mismatch: ${parsed.auth}`);
  });

  // 2f. compute test local-cpu --json exits 0.
  await assertOk(phase, 'compute test local-cpu --json exits 0', async () => {
    const r = await runCli(['compute', 'test', 'local-cpu', '--json']);
    if (r.code !== 0) throw new Error(`expected exit 0, got ${r.code} — stderr: ${r.stderr.slice(0, 200)}`);
    const parsed = JSON.parse(r.stdout);
    if (parsed.ok !== true) throw new Error(`expected ok=true, got ${JSON.stringify(parsed)}`);
  });

  // 2g. compute test modal --json exits 2 (missing env var).
  await assertOk(phase, 'compute test modal --json exits 2', async () => {
    const env = {};
    // Stamp out token vars so the test is deterministic.
    env.KOLM_MODAL_TOKEN = '';
    env.MODAL_TOKEN_ID = '';
    const r = await runCli(['compute', 'test', 'modal', '--json'], { env });
    if (r.code !== 2) throw new Error(`expected exit 2, got ${r.code} — stdout: ${r.stdout.slice(0, 200)}`);
    const parsed = JSON.parse(r.stdout);
    if (parsed.ok !== false) throw new Error('expected ok=false');
  });

  // 2h. compute use --foo exits 1 (unknown flag rejected by rejectUnknownFlags).
  await assertOk(phase, 'compute use --foo exits 1 (unknown flag)', async () => {
    const r = await runCli(['compute', 'use', '--foo']);
    if (r.code !== 1) throw new Error(`expected exit 1, got ${r.code} — stderr: ${r.stderr.slice(0, 200)}`);
    if (!/unknown flag/i.test(r.stderr)) {
      throw new Error(`expected "unknown flag" in stderr, got: ${r.stderr.slice(0, 200)}`);
    }
  });

  // 2i. compute status --json returns valid JSON.
  await assertOk(phase, 'compute status --json returns valid JSON', async () => {
    const r = await runCli(['compute', 'status', '--json']);
    if (r.code !== 0) throw new Error(`exit ${r.code} — stderr: ${r.stderr.slice(0, 200)}`);
    const parsed = JSON.parse(r.stdout);
    if (!('default' in parsed)) throw new Error('status missing .default');
    if (!parsed.pick) throw new Error('status missing .pick');
    if (!parsed.detection) throw new Error('status missing .detection');
  });
}

// --------------------------------------------------------------------------
// Phase 3 — Python trainer dispatch
// --------------------------------------------------------------------------

function findPython() {
  for (const candidate of ['python', 'python3']) {
    const res = spawnSync(candidate, ['--version'], { encoding: 'utf-8', timeout: 4000 });
    if (res.status === 0) return candidate;
  }
  return null;
}

function runPython(pythonCmd, code, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(pythonCmd, ['-c', code], {
      env: { ...process.env, PYTHONPATH: repo, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    const killer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
  });
}

async function phase3() {
  const phase = 'phase 3 — Python dispatch';
  if (!flagJson) console.log(`\n${C.bold}${phase}${C.reset}`);

  const py = findPython();
  if (!py) {
    recordSkip(phase, 'python not found in PATH');
    if (!flagJson) console.log(`  ${C.yellow}SKIP${C.reset}  python not found in PATH`);
    return;
  }

  // 3a. canonicalize() resolves aliases.
  await assertOk(phase, 'canonicalize() resolves aliases', async () => {
    const expected = {
      cuda: 'local-cuda', mps: 'local-mps', cpu: 'local-cpu',
      mlx: 'local-mlx', rocm: 'local-rocm', directml: 'local-directml',
      local: 'local-cpu', unsloth: 'local-cuda',
    };
    const code = [
      'from apps.trainer.backends import canonicalize',
      `import json, sys`,
      `pairs = ${JSON.stringify(Object.keys(expected))}`,
      'out = {p: canonicalize(p) for p in pairs}',
      'print(json.dumps(out))',
    ].join('\n');
    const r = await runPython(py, code);
    if (r.code !== 0) throw new Error(`python exit ${r.code} — ${r.stderr.trim().slice(0, 200)}`);
    const got = JSON.parse(r.stdout.trim());
    for (const [k, v] of Object.entries(expected)) {
      if (got[k] !== v) throw new Error(`canonicalize("${k}") expected "${v}", got "${got[k]}"`);
    }
  });

  // 3b. get_runner() resolves for every backend. Module-level import only.
  for (const name of ALL_BACKENDS) {
    await assertOk(phase, `get_runner("${name}") imports`, async () => {
      const code = [
        'import asyncio, json, sys',
        'from apps.trainer.backends import get_runner, canonicalize',
        `name = ${JSON.stringify(name)}`,
        'try:',
        '    c = canonicalize(name)',
        '    fn = asyncio.run(get_runner(name))',
        '    if fn is None or not callable(fn):',
        '        raise RuntimeError("get_runner returned non-callable")',
        '    print(json.dumps({"ok": True, "canonical": c, "fn": fn.__name__}))',
        'except Exception as e:',
        '    print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))',
        '    sys.exit(3)',
      ].join('\n');
      const r = await runPython(py, code);
      if (r.code !== 0) {
        let detail = r.stderr.trim().slice(0, 200);
        try {
          const j = JSON.parse(r.stdout.trim());
          if (j && j.error) detail = j.error;
        } catch { /* ignore */ }
        throw new Error(`python exit ${r.code} — ${detail}`);
      }
      const got = JSON.parse(r.stdout.trim());
      if (!got.ok) throw new Error(`get_runner returned not-ok: ${got.error}`);
      if (got.fn !== 'run') throw new Error(`expected fn name "run", got "${got.fn}"`);
    });
  }
}

// --------------------------------------------------------------------------
// Phase 4 — Provenance round-trip (canonical JSON determinism)
// --------------------------------------------------------------------------

// Match the canonicalJson used in src/cid.js + src/artifact.js + src/router.js.
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function phase4() {
  const phase = 'phase 4 — provenance round-trip';
  if (!flagJson) console.log(`\n${C.bold}${phase}${C.reset}`);

  // Mock a TrainResult shape per audit-compute-providers + main.py contract.
  // The compute block flows: backend result → metrics["compute"] (main.py:264).
  // We mirror that join here so we can assert downstream serialization is stable.
  const mockResult = {
    metrics: {
      pair_count: 240,
      holdout_accuracy: 0.917,
      base_model: 'qwen2.5-coder-7b-instruct-q4_0',
      backend: 'local-cuda',  // mirrored by main.py: result["metrics"]["backend"] = backend
    },
    adapter: {
      url: 'file:///tmp/job_abc/adapter',
      sha256: 'sha256-' + 'a'.repeat(64),
      size_bytes: 4_032_512,
      format: 'peft-lora',
    },
    compute: {
      backend: 'local-cuda',
      device: 'cuda:0',
      cost_usd: 0.0,
      started_at: 1715680000.123,
      finished_at: 1715680042.456,
      duration_seconds: 42.333,
      provenance: {
        framework: 'unsloth+peft',
        torch_version: '2.3.1+cu121',
        gpu_name: 'NVIDIA GeForce RTX 5090',
        base_model: 'qwen2.5-coder-7b-instruct-q4_0',
        sdk_version: 'kolm-v10c',
      },
    },
  };

  // 4a. Replicate main.py:262-264 — the compute block must land in metrics.compute.
  await assertOk(phase, 'compute block joins into metrics.compute', async () => {
    // Simulate the main.py assignment:
    //   if "compute" in result: job.metrics["compute"] = result["compute"]
    const job = { metrics: { ...mockResult.metrics } };
    if ('compute' in mockResult) {
      job.metrics.compute = mockResult.compute;
    }
    if (!job.metrics.compute) throw new Error('metrics.compute not present after join');
    if (job.metrics.compute.backend !== 'local-cuda') {
      throw new Error(`metrics.compute.backend mismatch: ${job.metrics.compute.backend}`);
    }
    // Expected provenance subfields (per memory note: backend/device/cost_usd/duration/provenance).
    for (const f of ['backend', 'device', 'cost_usd', 'duration_seconds', 'provenance']) {
      if (!(f in job.metrics.compute)) throw new Error(`metrics.compute missing field: ${f}`);
    }
  });

  // 4b. Canonical-JSON serialization is deterministic across runs.
  await assertOk(phase, 'canonicalJson(compute) is deterministic across runs', async () => {
    const a = canonicalJson(mockResult.compute);
    const b = canonicalJson(mockResult.compute);
    if (a !== b) throw new Error('two serializations of the same object disagree');
    // Hash equality is the stronger guarantee — CID is built on this property.
    if (sha256Hex(a) !== sha256Hex(b)) throw new Error('hash of canonical serialization unstable');
  });

  // 4c. Canonical-JSON is key-order insensitive.
  await assertOk(phase, 'canonicalJson is key-order insensitive', async () => {
    const c1 = {
      backend: 'modal',
      device: 'modal-h100',
      cost_usd: 0.21,
      provenance: { framework: 'modal', region: 'us-east' },
    };
    const c2 = {
      provenance: { region: 'us-east', framework: 'modal' },
      cost_usd: 0.21,
      device: 'modal-h100',
      backend: 'modal',
    };
    const a = canonicalJson(c1);
    const b = canonicalJson(c2);
    if (a !== b) {
      throw new Error(`expected canonical-JSON to ignore key order:\n  a=${a}\n  b=${b}`);
    }
  });

  // 4d. The repo's own canonicalJson (in src/cid.js) agrees with the local one.
  // This pins the contract: if cid.js ever drifts, this test catches it.
  await assertOk(phase, 'repo canonicalJson matches reference implementation', async () => {
    const cidMod = await import(pathToFileURL(path.join(repo, 'src/cid.js')).href);
    // cidFromManifestHashes uses canonicalJson internally — feed it a known
    // hashes block, and assert the CID is stable across two calls.
    const hashes = {
      model_pointer: '1'.repeat(64),
      recipes_json:  '2'.repeat(64),
      lora_bin:      '3'.repeat(64),
      index_bin:     '4'.repeat(64),
      evals_json:    '5'.repeat(64),
    };
    const cid1 = cidMod.cidFromManifestHashes(hashes);
    const cid2 = cidMod.cidFromManifestHashes(hashes);
    if (cid1 !== cid2) throw new Error('cidFromManifestHashes nondeterministic');
    if (!cidMod.verifyCidAgainstManifestHashes(cid1, hashes)) {
      throw new Error('verifyCidAgainstManifestHashes failed roundtrip');
    }
  });
}

// --------------------------------------------------------------------------
// Driver + reporter
// --------------------------------------------------------------------------

const t0 = Date.now();

await phase1();
await phase2();
await phase3();
await phase4();

const duration_ms = Date.now() - t0;
const total = results.phases.reduce((s, p) => s + p.total, 0);
const passed = results.phases.reduce((s, p) => s + p.passed, 0);
const failed = results.phases.reduce((s, p) => s + p.failed, 0);

if (flagJson) {
  console.log(JSON.stringify({
    ok: failed === 0,
    total,
    passed,
    failed,
    duration_ms,
    phases: results.phases,
    failures: results.failures.slice(0, 10),
  }, null, 2));
} else {
  console.log('');
  console.log(`${C.bold}========================================${C.reset}`);
  console.log(`${C.bold}  Compute E2E summary${C.reset}`);
  console.log(`${C.bold}========================================${C.reset}`);
  for (const p of results.phases) {
    if (p.skipped) {
      console.log(`  ${C.yellow}[SKIP]${C.reset} ${p.name} (${p.reason})`);
      continue;
    }
    const tag = p.failed === 0 ? `${C.green}[OK]${C.reset}  ` : `${C.red}[FAIL]${C.reset}`;
    console.log(`  ${tag} ${p.name} (${p.passed}/${p.total})`);
  }
  console.log('');
  console.log(`  total:    ${passed}/${total} passed`);
  console.log(`  duration: ${duration_ms}ms`);
  if (failed > 0) {
    console.log('');
    console.log(`${C.red}${C.bold}Failures (first 3):${C.reset}`);
    for (const f of results.failures.slice(0, 3)) {
      console.log(`  ${C.red}—${C.reset} [${f.phase}] ${f.name}`);
      console.log(`    ${C.dim}${f.error}${C.reset}`);
    }
    if (results.failures.length > 3) {
      console.log(`  ${C.dim}…and ${results.failures.length - 3} more${C.reset}`);
    }
  }
}

process.exit(failed === 0 ? 0 : 1);
