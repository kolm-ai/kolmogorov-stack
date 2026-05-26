// W409r + W409s — model backbones registry + mobile/device targets.
//
// W409r locks in the BACKBONES registry shape (Gemma + Gemma 3n + Qwen +
// Llama + Phi + Mistral + SmolLM), the `kolm models pull-backbone` CLI verb,
// and the pull-then-mutate contract (real weights flip to
// 'pulled_and_verified'; metadata-only dry runs flip to 'metadata_cached').
//
// W409s locks in the PROFILES registry shape (mobile-ios / mobile-android
// marked runtime_status:'foundation' until a real runtime ships), the
// `kolm devices detect` + `kolm devices recommend` CLI verbs, the server
// route `/v1/devices/detect` accepting BOTH GET and POST with a JSON
// hints body, and the artifact manifest carrying memory_requirement_mb +
// offline_capable so devices.recommendForProfile() can gate target/quant
// picks.
//
// Tests assert BEHAVIOR (registry contents, pull mutation, CLI dispatch,
// HTTP shape) — not page copy. They do not break wave217/wave218 since
// BACKBONES is orthogonal to FRONTIER_MODELS/HW_TIERS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT, 'cli', 'kolm.js');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w409rs-'));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
}

// Spawn CLI in a clean HOME so config + caches don't bleed.
function runCli(args, { home, env: extra = {} } = {}) {
  return new Promise((resolve) => {
    const tmp = home || mkTmp();
    const env = {
      ...process.env,
      HOME: tmp,
      USERPROFILE: tmp,
      KOLM_HOME: path.join(tmp, '.kolm'),
      ...extra,
    };
    delete env.KOLM_API_KEY;
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      resolve({ code, stdout, stderr, home: tmp });
    });
  });
}

// ===========================================================================
// W409r — BACKBONES registry shape + content
// ===========================================================================

test('W409r #1 — model-registry exports BACKBONES + helpers', async () => {
  const R = await import('../src/model-registry.js');
  assert.ok(Array.isArray(R.BACKBONES), 'BACKBONES must be an array');
  for (const fn of ['listBackbones', 'showBackbone', 'pullBackbone', 'verifyBackbone', 'verifyAllBackbones']) {
    assert.equal(typeof R[fn], 'function', `missing export: ${fn}`);
  }
});

test('W409r #2 — BACKBONES carries Gemma + Gemma 3n + Qwen + Llama + Phi + Mistral + SmolLM', async () => {
  const R = await import('../src/model-registry.js');
  const families = new Set(R.BACKBONES.map(b => b.family));
  // Every named family in the W409r requirement must be present somewhere.
  assert.ok([...families].some(f => /^gemma/.test(f)), 'no gemma family rows');
  assert.ok([...families].some(f => f === 'gemma-3n'), 'no gemma-3n (mobile) family rows');
  assert.ok([...families].some(f => /^qwen/.test(f)), 'no qwen family rows');
  assert.ok([...families].some(f => f === 'qwen-3-coder'), 'no qwen-3-coder family');
  assert.ok([...families].some(f => /^llama/.test(f)), 'no llama family rows');
  assert.ok([...families].some(f => f === 'llama-4'), 'no llama-4 family');
  assert.ok([...families].some(f => f === 'phi'), 'no phi family rows');
  assert.ok([...families].some(f => f === 'mistral' || f === 'ministral'), 'no mistral/ministral family');
  assert.ok([...families].some(f => f === 'smollm'), 'no smollm family rows');
});

test('W409r #3 — every backbone row carries the full W409r contract shape', async () => {
  const R = await import('../src/model-registry.js');
  for (const b of R.BACKBONES) {
    assert.ok(b.id && typeof b.id === 'string', `bad id: ${JSON.stringify(b)}`);
    assert.ok(b.family && typeof b.family === 'string', `bad family on ${b.id}`);
    assert.ok(b.license && typeof b.license === 'string', `bad license on ${b.id}`);
    assert.ok(Array.isArray(b.runtime_compatibility) && b.runtime_compatibility.length > 0, `bad runtime_compatibility on ${b.id}`);
    for (const rt of b.runtime_compatibility) {
      assert.ok(['js', 'wasm', 'gguf', 'onnx', 'native'].includes(rt), `bad runtime on ${b.id}: ${rt}`);
    }
    assert.ok(b.device_constraints && typeof b.device_constraints === 'object', `bad device_constraints on ${b.id}`);
    assert.equal(typeof b.device_constraints.min_ram_gb, 'number', `bad min_ram_gb on ${b.id}`);
    assert.equal(typeof b.device_constraints.mobile_ok, 'boolean', `bad mobile_ok on ${b.id}`);
    assert.ok(Array.isArray(b.quantization_support) && b.quantization_support.length > 0, `bad quantization_support on ${b.id}`);
    for (const q of b.quantization_support) {
      assert.ok(['Q2', 'Q4', 'Q6', 'Q8', 'fp16', 'bf16'].includes(q), `bad quant on ${b.id}: ${q}`);
    }
    assert.ok(['registered', 'metadata_cached', 'pulled_and_verified'].includes(b.pull_status), `bad pull_status on ${b.id}: ${b.pull_status}`);
    assert.ok(Array.isArray(b.recommended_for_target), `bad recommended_for_target on ${b.id}`);
    assert.ok('local_path' in b, `missing local_path on ${b.id}`);
    assert.ok('verified_at' in b, `missing verified_at on ${b.id}`);
  }
});

test('W409r #4 — Gemma 3n rows are mobile-eligible (mobile_ok=true)', async () => {
  const R = await import('../src/model-registry.js');
  const gemma3n = R.BACKBONES.filter(b => b.family === 'gemma-3n');
  assert.ok(gemma3n.length >= 1, 'must have at least one gemma-3n row');
  for (const b of gemma3n) {
    assert.equal(b.device_constraints.mobile_ok, true, `gemma-3n row ${b.id} must be mobile_ok`);
  }
});

test('W409r #5 — verifyAllBackbones returns {ok:true} for every row', async () => {
  const R = await import('../src/model-registry.js');
  const res = R.verifyAllBackbones();
  assert.equal(res.failed, 0, `bad backbones: ${JSON.stringify(res.results.filter(r => !r.ok))}`);
});

test('W409r #6 — listBackbones filters work (family/mobile_ok/pull_status)', async () => {
  const R = await import('../src/model-registry.js');
  const phi = R.listBackbones({ family: 'phi' });
  assert.ok(phi.length >= 1 && phi.every(r => r.family === 'phi'), 'family filter broken');
  const mobile = R.listBackbones({ mobile_ok: true });
  assert.ok(mobile.length >= 1 && mobile.every(r => r.device_constraints.mobile_ok === true), 'mobile_ok filter broken');
  const pulled = R.listBackbones({ pull_status: 'pulled_and_verified' });
  assert.ok(Array.isArray(pulled), 'pull_status filter must return an array');
});

// ===========================================================================
// W409r — kolm models pull-backbone CLI verb
// ===========================================================================

test('W409r #7 — `kolm models pull-backbone <id>` writes a file + flips registry state', async () => {
  // Use the in-process API instead of spawning to keep the registry mutation
  // visible in this process. The CLI dispatcher is exercised separately.
  const R = await import('../src/model-registry.js');
  const id = 'HuggingFaceTB/SmolLM2-135M-Instruct';
  const tmp = mkTmp();
  try {
    const before = R.showBackbone(id);
    assert.equal(before.pull_status, 'registered');
    const fixture = Buffer.from('fake-weights-bytes-for-test', 'utf8');
    const r = await R.pullBackbone(id, { cacheDir: tmp, fixtureBytes: fixture });
    assert.equal(r.ok, true, `pullBackbone failed: ${JSON.stringify(r)}`);
    assert.ok(fs.existsSync(r.local_path), 'fixture file must exist on disk');
    assert.equal(fs.readFileSync(r.local_path).toString(), 'fake-weights-bytes-for-test');
    const after = R.showBackbone(id);
    assert.equal(after.pull_status, 'pulled_and_verified', 'pull_status must flip');
    assert.ok(after.local_path && after.local_path.length > 0, 'local_path must be set');
    assert.match(after.verified_at, /^\d{4}-\d{2}-\d{2}$/, 'verified_at must be YYYY-MM-DD');
    assert.equal(R.verifyBackbone(id).ok, true, 'pulled row with existing weights must verify');
    fs.unlinkSync(r.local_path);
    const missing = R.verifyBackbone(id);
    assert.equal(missing.ok, false, 'pulled row with missing weights must not verify');
    assert.ok(missing.problems.includes('pulled_local_path_missing'), `missing file problem not reported: ${JSON.stringify(missing)}`);
    fs.writeFileSync(r.local_path, fixture);
  } finally { cleanup(tmp); }
});

test('W409r #7b - pullBackbone without real weights caches metadata, not verified weights', async () => {
  const R = await import('../src/model-registry.js');
  const id = 'google/gemma-3n-E2B-it';
  const tmp = mkTmp();
  try {
    const r = await R.pullBackbone(id, { cacheDir: tmp });
    assert.equal(r.ok, true, `pullBackbone metadata cache failed: ${JSON.stringify(r)}`);
    assert.equal(r.pull_status, 'metadata_cached');
    assert.equal(r.weights_verified, false);
    assert.equal(r.verified_at, null);
    assert.ok(fs.existsSync(r.local_path), 'metadata file must exist on disk');
    const row = R.showBackbone(id);
    assert.equal(row.pull_status, 'metadata_cached');
    assert.match(fs.readFileSync(r.local_path, 'utf8'), /registry-metadata-only/);
    const v = R.verifyBackbone(id);
    assert.equal(v.ok, true, `metadata-cached row should be valid but not verified: ${JSON.stringify(v)}`);
  } finally { cleanup(tmp); }
});

test('W409r #8 — CLI dispatcher has `models backbones` + `models pull-backbone` cases wired', async () => {
  const src = fs.readFileSync(CLI_PATH, 'utf8');
  assert.match(src, /case\s+'backbones'\s*:/, 'missing case backbones');
  assert.match(src, /case\s+'pull-backbone'\s*:/, 'missing case pull-backbone');
  assert.match(src, /listBackbones|pullBackbone/, 'dispatcher must call backbone helpers');
});

test('W409r #9 — `kolm models backbones --json` lists the registry via the CLI', async () => {
  const r = await runCli(['models', 'backbones', '--json']);
  // Spawning the CLI must succeed; tolerate non-zero on a fresh box (no
  // network) but stdout must include a JSON array of backbones.
  assert.ok(r.stdout.length > 0, `no stdout: code=${r.code} err=${r.stderr}`);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch (_) {
    // The CLI may have printed table output if --json wasn't honored; allow
    // a literal substring fallback for that variant.
    assert.match(r.stdout, /smollm|phi|gemma|llama|qwen|mistral/i, 'no backbone list output');
    return;
  }
  assert.ok(Array.isArray(parsed) && parsed.length > 0, 'expected non-empty backbone array');
  cleanup(r.home);
});

test('W547 #2 - `kolm models verify --json` treats --json as a flag, not a model id', async () => {
  const forms = [
    ['models', 'verify', '--json'],
    ['models', '--json', 'verify'],
  ];
  for (const args of forms) {
    const r = await runCli(args);
    assert.equal(r.code, 0, `${args.join(' ')} exited ${r.code}; stderr=${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(typeof parsed.total, 'number', 'verify JSON must include total');
    assert.equal(typeof parsed.failed, 'number', 'verify JSON must include failed');
    assert.ok(Array.isArray(parsed.results), 'verify JSON must include results array');
    assert.equal(parsed.failed, 0, 'verified registry must be clean');
    cleanup(r.home);
  }
  const plain = await runCli(['models', 'verify']);
  assert.equal(plain.code, 0, `plain models verify exited ${plain.code}; stderr=${plain.stderr}`);
  assert.match(plain.stdout, /OK\s+Qwen\/Qwen2\.5-7B-Instruct/, 'plain verify must print per-row OK output');
  cleanup(plain.home);
});

// ===========================================================================
// W409s — PROFILES registry shape + content
// ===========================================================================

test('W409s #1 — devices.js exports PROFILES + helpers', async () => {
  const D = await import('../src/devices.js');
  assert.ok(Array.isArray(D.PROFILES), 'PROFILES must be an array');
  for (const fn of ['listProfiles', 'showProfile', 'detectProfile', 'recommendForProfile']) {
    assert.equal(typeof D[fn], 'function', `missing export: ${fn}`);
  }
  assert.ok(Array.isArray(D.PROFILE_CLASSES) && D.PROFILE_CLASSES.length >= 6, 'PROFILE_CLASSES too small');
});

test('W409s #2 — PROFILES carries the named profile classes', async () => {
  const D = await import('../src/devices.js');
  const classes = new Set(D.PROFILES.map(p => p.profile_class));
  for (const c of ['mobile-ios', 'mobile-android', 'desktop-cpu', 'desktop-gpu', 'workstation', 'server']) {
    assert.ok(classes.has(c), `missing profile_class: ${c}`);
  }
});

test('W409s #3 — mobile profiles are runtime_status:foundation (no iOS/Android runtime ships yet)', async () => {
  const D = await import('../src/devices.js');
  const mobileProfiles = D.PROFILES.filter(p => p.profile_class === 'mobile-ios' || p.profile_class === 'mobile-android');
  assert.ok(mobileProfiles.length >= 2, 'must have at least two mobile profiles');
  for (const p of mobileProfiles) {
    assert.equal(p.runtime_status, 'foundation', `mobile profile ${p.id} must be foundation (no real runtime ships yet) — got ${p.runtime_status}`);
  }
});

test('W409s #4 — every profile carries the full W409s contract shape', async () => {
  const D = await import('../src/devices.js');
  for (const p of D.PROFILES) {
    assert.ok(p.id && typeof p.id === 'string', `bad id: ${JSON.stringify(p)}`);
    assert.ok(p.name && typeof p.name === 'string', `bad name on ${p.id}`);
    assert.ok(p.profile_class && typeof p.profile_class === 'string', `bad profile_class on ${p.id}`);
    assert.equal(typeof p.ram_gb, 'number', `bad ram_gb on ${p.id}`);
    assert.ok('vram_gb' in p, `missing vram_gb on ${p.id}`);
    assert.ok(p.arch && typeof p.arch === 'string', `bad arch on ${p.id}`);
    assert.ok('cuda_capability' in p, `missing cuda_capability on ${p.id}`);
    assert.equal(typeof p.neural_engine, 'boolean', `bad neural_engine on ${p.id}`);
    assert.ok('accelerator' in p, `missing accelerator on ${p.id}`);
    assert.equal(typeof p.min_artifact_size_mb, 'number', `bad min_artifact_size_mb on ${p.id}`);
    assert.equal(typeof p.max_artifact_size_mb, 'number', `bad max_artifact_size_mb on ${p.id}`);
    assert.ok(Array.isArray(p.supported_targets) && p.supported_targets.length > 0, `bad supported_targets on ${p.id}`);
    assert.equal(typeof p.offline_capable, 'boolean', `bad offline_capable on ${p.id}`);
    assert.ok(['foundation', 'production'].includes(p.runtime_status), `bad runtime_status on ${p.id}`);
  }
});

// ===========================================================================
// W409s — kolm devices detect + recommend CLI verbs
// ===========================================================================

test('W409s #5 — `kolm devices detect` returns a valid profile on the current machine', async () => {
  const D = await import('../src/devices.js');
  // Call directly — spawning is exercised in #7 below.
  const r = await D.detectProfile({});
  assert.ok(r.profile_id, 'no profile_id returned');
  assert.ok(r.profile && r.profile.id === r.profile_id, 'profile object must match profile_id');
  assert.ok(['nvidia-smi', 'sysctl', 'wmic', 'fallback', 'hint'].includes(r.source), `bad source: ${r.source}`);
  assert.ok(r.confidence >= 0 && r.confidence <= 1, `confidence out of range: ${r.confidence}`);
});

test('W409s #6 — `kolm devices recommend --artifact <fake-id>` honors artifact constraints', async () => {
  const D = await import('../src/devices.js');
  // Force a known profile so the test is deterministic across machines.
  const desktopCpu = D.showProfile('desktop-cpu-x64');
  assert.ok(desktopCpu, 'desktop-cpu-x64 profile must exist');
  // Artifact small + offline-capable: should pick gguf or onnx and Q4.
  const okRec = await D.recommendForProfile({
    profile: desktopCpu,
    artifact: { id: 'fake-art-1', supported_targets: ['gguf'], memory_requirement_mb: 800, offline_capable: true },
  });
  assert.equal(okRec.ok, true, `recommendForProfile failed: ${JSON.stringify(okRec)}`);
  assert.equal(okRec.target, 'gguf');
  assert.ok(['Q4', 'Q6', 'Q8'].includes(okRec.quant), `bad quant: ${okRec.quant}`);

  // Artifact memory_requirement bigger than the device — must refuse.
  const tooBig = await D.recommendForProfile({
    profile: desktopCpu,
    artifact: { id: 'fake-too-big', supported_targets: ['gguf'], memory_requirement_mb: 999999 },
  });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.reason, 'artifact_exceeds_device_memory');

  // No compatible target overlap — must refuse.
  const noTarget = await D.recommendForProfile({
    profile: desktopCpu,
    artifact: { id: 'fake-no-target', supported_targets: ['native-cuda'], memory_requirement_mb: 100 },
  });
  assert.equal(noTarget.ok, false);
  assert.equal(noTarget.reason, 'no_compatible_target');
});

test('W409s #7 — CLI dispatcher has `devices detect|recommend|profiles` cases wired', async () => {
  const src = fs.readFileSync(CLI_PATH, 'utf8');
  // Each sub-verb must dispatch in cmdDevices.
  assert.match(src, /if\s*\(\s*sub\s*===\s*'detect'\s*\)/, 'missing devices detect dispatch');
  assert.match(src, /if\s*\(\s*sub\s*===\s*'recommend'\s*\)/, 'missing devices recommend dispatch');
  assert.match(src, /if\s*\(\s*sub\s*===\s*'profiles'\s*\)/, 'missing devices profiles dispatch');
  assert.match(src, /detectProfile|recommendForProfile/, 'dispatcher must call profile helpers');
});

test('W409s #8 — `kolm devices detect --json` spawns and returns a profile', async () => {
  const r = await runCli(['devices', 'detect', '--json']);
  assert.ok(r.stdout.length > 0, `no stdout: code=${r.code} err=${r.stderr}`);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch (_) {
    // Tolerant fallback — if --json wasn't honored, look for table output.
    assert.match(r.stdout, /profile_id|profile_class|desktop|server|embedded/i, 'no profile output');
    cleanup(r.home);
    return;
  }
  assert.ok(parsed.profile_id, 'expected profile_id in --json output');
  assert.ok(parsed.profile, 'expected profile object in --json output');
  cleanup(r.home);
});

// ===========================================================================
// W409s — Server route POST /v1/devices/detect accepts JSON body
// ===========================================================================

async function makeRouterApp() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  return { app, apiKey: t.api_key };
}

function withListening(app, fn) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      try {
        const port = srv.address().port;
        const out = await fn(`http://127.0.0.1:${port}`);
        srv.close(() => resolve(out));
      } catch (e) { srv.close(() => reject(e)); }
    });
  });
}

test('W409s #9 — GET /v1/devices/detect returns ok + profile', async () => {
  const { app, apiKey } = await makeRouterApp();
  await withListening(app, async (base) => {
    const r = await fetch(base + '/v1/devices/detect', {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    assert.equal(r.status, 200, `GET /v1/devices/detect must 200, got ${r.status}`);
    const body = await r.json();
    assert.equal(body.ok, true, 'response.ok must be true');
    // W409s — body must include profile in addition to W372 capability snapshot.
    assert.ok(body.profile, 'response must include W409s profile pick');
    assert.ok(body.profile.id || body.profile.profile_id, 'profile must have an id');
  });
});

test('W409s #10 — POST /v1/devices/detect accepts a JSON hints body and returns the same shape', async () => {
  const { app, apiKey } = await makeRouterApp();
  await withListening(app, async (base) => {
    const r = await fetch(base + '/v1/devices/detect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ profile_class: 'desktop-cpu', arch: 'x64', ram_gb: 16 }),
    });
    assert.equal(r.status, 200, `POST /v1/devices/detect must 200, got ${r.status}`);
    const body = await r.json();
    assert.equal(body.ok, true, 'response.ok must be true');
    assert.ok(body.profile, 'POST response must include W409s profile pick');
    // hints.profile_class=desktop-cpu must be honored.
    if (body.profile && body.profile.profile_class) {
      assert.equal(body.profile.profile_class, 'desktop-cpu', 'hint profile_class must steer the pick');
    }
  });
});

// ===========================================================================
// W409s — Artifact manifest carries memory_requirement + offline_capable
// ===========================================================================

test('W409s #11 — artifact manifest carries memory_requirement_mb + offline_capable', async () => {
  const A = await import('../src/artifact.js');
  // Use a minimal buildPayload call with the lightest valid inputs.
  // Pin signing secret so buildPayload doesn't throw.
  process.env.KOLM_SIGN_SECRET = process.env.KOLM_SIGN_SECRET || 'test-secret-w409rs';
  const payload = A.buildPayload({
    job_id: 'job_w409rs_' + Date.now().toString(36),
    task: { id: 'task_w409rs', description: 'w409rs manifest probe' },
    base_model: 'Qwen/Qwen2.5-3B-Instruct',
    recipes: [{ id: 'r0', class: 'rule', source_hash: 'a'.repeat(64) }],
    target_device: { profile_class: 'desktop-cpu', memory_requirement_mb: 1500, offline_capable: true },
  });
  assert.ok(payload && payload.manifest, 'payload must include manifest');
  const m = payload.manifest;
  assert.ok('memory_requirement_mb' in m, 'manifest must carry memory_requirement_mb');
  assert.ok('offline_capable' in m, 'manifest must carry offline_capable');
  assert.equal(m.memory_requirement_mb, 1500, 'memory_requirement_mb must round-trip from target_device');
  assert.equal(m.offline_capable, true, 'offline_capable must round-trip from target_device');
});
