// Wave 422 — Direct distill() tenant fence (audit P0-4).
//
// The 2026-05-19 audit (.agent/docs/w415-outstanding-diffs-from-prior-feedback-
// 2026-05-19.md, P0-4) flagged that compileFull() avoids the cross-tenant leak
// by passing explicit train pairs, but direct callers of distill() can still
// ingest cross-tenant rows whenever they supply `teacher_namespace` without
// `pairs_override` — because the underlying prepareDistillCorpus() call did
// not receive a tenant filter.
//
// W422 fix (src/distill-pipeline.js):
//   1. distill() accepts `tenant_id` (canonical) and `tenant` (shorthand alias).
//   2. A new pure helper `_resolveDistillTenant(opts)` collapses the alias and
//      defaults to 'local' when neither is supplied — matching the local-default
//      convention used elsewhere (auth.js anon tenant, intent.js classifier).
//   3. When prepareDistillCorpus() is called inside distill() (no pairs_override),
//      the resolved tenant_id is forwarded so the corpus is fenced.
//
// These tests assert BEHAVIOR (seeds.jsonl contents, helper return values) AND
// the static-source guarantees (signature, call-site) so the fix cannot regress.
// Run with `--test-concurrency=1` to avoid the SQLite parallel-test trap that
// the rest of the distill-pipeline test suite already documents (W311, W319).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const DISTILL_PATH = path.join(REPO, 'src', 'distill-pipeline.js');

// ---------------------------------------------------------------------------
// shared helpers (mirrors wave411-tenant-isolation.test.js)
// ---------------------------------------------------------------------------

function _mkTmp(label = 'w422') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-' + label + '-'));
}

function _snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_DB_PATH: process.env.KOLM_DB_PATH,
    KOLM_DISTILL_WORKER_CMD: process.env.KOLM_DISTILL_WORKER_CMD,
    KOLM_DISTILL_TEACHER: process.env.KOLM_DISTILL_TEACHER,
    KOLM_DISTILL_FULL: process.env.KOLM_DISTILL_FULL,
  };
}

function _setEnv(tmp) {
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  // Use the JSONL backend for the event-store so we never need node:sqlite at
  // test time and we sidestep the parallel-write trap entirely.
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_DB_PATH = path.join(tmp, 'kolm.sqlite');
  // The worker must never actually spawn during these tests. We swap in a
  // no-op script that exits immediately so distill() resolves quickly.
  process.env.KOLM_DISTILL_WORKER_CMD = path.join(REPO, 'tests', '_fixtures-w422-noop-worker.cjs');
  // Force 'stub' mode by clearing the teacher env vars.
  delete process.env.KOLM_DISTILL_TEACHER;
  delete process.env.KOLM_DISTILL_FULL;
}

function _restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

async function _seed(tenantId, namespace, n, label) {
  const { appendEvent } = await import('../src/event-store.js');
  const ids = [];
  for (let i = 0; i < n; i++) {
    const ev = await appendEvent({
      namespace,
      tenant_id: tenantId,
      prompt_redacted: `${label || tenantId} prompt ${i}`,
      response_redacted: `${label || tenantId} reply ${i}`,
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
      estimated_cost_usd: 0.001,
      latency_ms: 42,
    });
    ids.push(ev.event_id);
  }
  return ids;
}

async function _bustModuleCache() {
  const ev = await import('../src/event-store.js');
  if (typeof ev._resetForTests === 'function') ev._resetForTests();
}

// Ensure the no-op worker fixture exists. We write it lazily on first use so a
// repo-wide test run does not need to ship the file separately. The script
// reads the spec/seeds/out args, writes a trivial manifest, and exits 0 —
// distill() only needs the manifest to fall through to the final yield.
function _ensureNoopWorker() {
  const wp = path.join(REPO, 'tests', '_fixtures-w422-noop-worker.cjs');
  if (fs.existsSync(wp)) return wp;
  const body = `#!/usr/bin/env node
// W422 fixture — no-op distill worker. Reads CLI args, writes manifest.json
// into the --out= dir, exits 0. Keeps distill() from hanging on real ML.
const fs = require('fs');
const path = require('path');
const out = (process.argv.find(a => a.startsWith('--out=')) || '').slice('--out='.length);
if (out) {
  try { fs.mkdirSync(out, { recursive: true }); } catch {}
  try {
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
      ok: true, fixture: 'w422-noop', written_at: new Date().toISOString(),
    }, null, 2));
  } catch {}
}
process.exit(0);
`;
  fs.writeFileSync(wp, body, 'utf8');
  return wp;
}

// Drain the async iterator returned by distill() so it actually runs end-to-
// end and the seeds.jsonl write fires. Returns the final {done:true,...} env.
async function _runDistill(opts) {
  const { distill } = await import('../src/distill-pipeline.js');
  let final = null;
  for await (const ev of distill({ emit_progress_every: 0, ...opts })) {
    if (ev && ev.done) final = ev;
  }
  return final;
}

// Read the seeds.jsonl written by distill() into the run dir derived from the
// final yield's artifact_path (which is runDir/out).
function _readSeeds(finalEvent) {
  assert.ok(finalEvent && finalEvent.artifact_path, 'final yield must include artifact_path');
  const runDir = path.dirname(finalEvent.artifact_path);
  const seedsPath = path.join(runDir, 'seeds.jsonl');
  assert.ok(fs.existsSync(seedsPath), 'seeds.jsonl must exist at ' + seedsPath);
  return fs.readFileSync(seedsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// #1 — _resolveDistillTenant pure-helper: alias handling + local default.
// ---------------------------------------------------------------------------
test('W422 #1 — _resolveDistillTenant honors tenant_id, tenant alias, local default', async () => {
  const { _resolveDistillTenant } = await import('../src/distill-pipeline.js');
  assert.equal(typeof _resolveDistillTenant, 'function', '_resolveDistillTenant must be exported');
  assert.equal(_resolveDistillTenant({ tenant_id: 'tA' }), 'tA', 'tenant_id is canonical');
  assert.equal(_resolveDistillTenant({ tenant: 'tB' }), 'tB', 'tenant is shorthand alias');
  assert.equal(_resolveDistillTenant({ tenant_id: 'tCan', tenant: 'tAlias' }), 'tCan',
    'tenant_id wins when both are supplied');
  assert.equal(_resolveDistillTenant({}), 'local', 'empty opts default to local');
  assert.equal(_resolveDistillTenant(), 'local', 'no opts default to local');
  assert.equal(_resolveDistillTenant({ tenant_id: '', tenant: '' }), 'local',
    'empty strings count as missing');
  assert.equal(_resolveDistillTenant({ tenant_id: 123 }), '123', 'non-string tenant_id is coerced');
});

// ---------------------------------------------------------------------------
// #2 — distill({pairs_override}) does NOT call prepareDistillCorpus; the
//      injected pairs land in seeds.jsonl unchanged. Verified via behavior:
//      seeds prompts are exactly the override prompts, never an event prompt.
// ---------------------------------------------------------------------------
test('W422 #2 — distill({pairs_override}) bypasses prepareDistillCorpus', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  _ensureNoopWorker();
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  await _bustModuleCache();

  // Seed events in the namespace under a tenant — these MUST NOT leak into
  // seeds.jsonl when pairs_override is provided.
  await _seed('tenant_seeded', 'ns_override', 4, 'SHOULD_NOT_APPEAR');

  const injected = [
    { prompt: 'OVERRIDE-Q-1', response: 'OVERRIDE-A-1', event_id: 'inj_1' },
    { prompt: 'OVERRIDE-Q-2', response: 'OVERRIDE-A-2', event_id: 'inj_2' },
    { prompt: 'OVERRIDE-Q-3', response: 'OVERRIDE-A-3', event_id: 'inj_3' },
  ];
  const final = await _runDistill({
    teacher_namespace: 'ns_override',
    student_base: 'qwen3:0.5b',
    pairs_override: injected,
    max_steps: 10,
  });
  const seeds = _readSeeds(final);
  assert.equal(seeds.length, 3, 'seeds.jsonl contains exactly the 3 injected pairs');
  const inputs = seeds.map(s => s.input);
  assert.deepEqual(inputs.sort(), ['OVERRIDE-Q-1', 'OVERRIDE-Q-2', 'OVERRIDE-Q-3'],
    'inputs match the injected prompts verbatim');
  for (const s of seeds) {
    assert.ok(!/SHOULD_NOT_APPEAR/.test(s.input),
      'event-store prompts never appear when pairs_override is supplied');
  }
});

// ---------------------------------------------------------------------------
// #3 — distill({teacher_namespace, tenant_id:'tA'}) fences corpus to A only.
//      Two tenants sit in the same namespace; tA's seeds.jsonl never sees tB.
// ---------------------------------------------------------------------------
test('W422 #3 — distill({tenant_id}) fences corpus to the named tenant', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  _ensureNoopWorker();
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  await _bustModuleCache();

  await _seed('tenant_A_w422', 'ns_fence', 5, 'TENANT_A_W422');
  await _seed('tenant_B_w422', 'ns_fence', 5, 'TENANT_B_W422');

  const finalA = await _runDistill({
    teacher_namespace: 'ns_fence',
    student_base: 'qwen3:0.5b',
    tenant_id: 'tenant_A_w422',
    max_steps: 50,
  });
  const seedsA = _readSeeds(finalA);
  assert.ok(seedsA.length > 0, 'tenant A seeds.jsonl is non-empty');
  for (const s of seedsA) {
    assert.match(s.input, /TENANT_A_W422/, 'every seed is from tenant A');
    assert.ok(!/TENANT_B_W422/.test(s.input), 'no tenant B prompt leaks into A seeds');
  }

  const finalB = await _runDistill({
    teacher_namespace: 'ns_fence',
    student_base: 'qwen3:0.5b',
    tenant: 'tenant_B_w422',     // verify shorthand alias path
    max_steps: 50,
  });
  const seedsB = _readSeeds(finalB);
  assert.ok(seedsB.length > 0, 'tenant B seeds.jsonl is non-empty');
  for (const s of seedsB) {
    assert.match(s.input, /TENANT_B_W422/, 'every seed is from tenant B (alias path)');
    assert.ok(!/TENANT_A_W422/.test(s.input), 'no tenant A prompt leaks into B seeds');
  }
});

// ---------------------------------------------------------------------------
// #4 — distill({teacher_namespace}) with NO tenant defaults to 'local'.
//      Other tenants' rows are NOT pulled in. Local-only distill stays usable.
// ---------------------------------------------------------------------------
test('W422 #4 — distill() with no tenant defaults to local; other tenants stay fenced', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  _ensureNoopWorker();
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  await _bustModuleCache();

  // 4 local rows + 6 hosted-tenant rows in the SAME namespace. The default
  // distill() call (no tenant) must surface ONLY the local rows.
  await _seed('local', 'ns_default', 4, 'LOCAL_DEV');
  await _seed('tenant_other', 'ns_default', 6, 'OTHER_TENANT');

  const final = await _runDistill({
    teacher_namespace: 'ns_default',
    student_base: 'qwen3:0.5b',
    // intentionally NO tenant_id / tenant — exercise the local default.
    max_steps: 50,
  });
  const seeds = _readSeeds(final);
  assert.ok(seeds.length > 0, 'local-default seeds.jsonl is non-empty');
  for (const s of seeds) {
    assert.match(s.input, /LOCAL_DEV/, 'every seed is from the local tenant');
    assert.ok(!/OTHER_TENANT/.test(s.input),
      'cross-tenant rows never leak under the local default');
  }
});

// ---------------------------------------------------------------------------
// #5 — Static-source guard: the distill({...}) signature lists tenant_id and
//      tenant params, and the prepareDistillCorpus call inside distill()
//      passes the resolved tenant through.
// ---------------------------------------------------------------------------
test('W422 #5 — static-source: signature + prepareDistillCorpus call carry tenant', () => {
  const src = fs.readFileSync(DISTILL_PATH, 'utf8');

  // Signature must declare tenant_id and tenant params on distill().
  const sigBlock = src.match(/export async function\*\s+distill\(\s*\{([\s\S]{0,1200}?)\}\s*=\s*\{\}\s*\)/);
  assert.ok(sigBlock, 'distill() destructured-options signature must exist');
  assert.match(sigBlock[1], /\btenant_id\b/, 'signature must include tenant_id');
  assert.match(sigBlock[1], /\btenant\b/, 'signature must include tenant alias');

  // The prepareDistillCorpus call inside distill() (the else-if branch on
  // teacher_namespace) must pass tenant_id through. We scope the search to the
  // section after the distill() signature so we don't match the route-handler
  // callers above it.
  const distillIdx = src.indexOf('export async function* distill');
  assert.ok(distillIdx >= 0);
  const distillBody = src.slice(distillIdx);
  const callBlock = distillBody.match(/prepareDistillCorpus\(\s*\{[\s\S]{0,400}?\}\s*\)/);
  assert.ok(callBlock, 'distill() must call prepareDistillCorpus');
  assert.match(callBlock[0], /tenant_id\s*:/, 'prepareDistillCorpus call must forward tenant_id');

  // The _resolveDistillTenant helper must be exported (testability) and used.
  assert.match(src, /export function _resolveDistillTenant/,
    '_resolveDistillTenant must be exported');
  assert.match(src, /_resolveDistillTenant\(\s*\{\s*tenant_id\s*,\s*tenant\s*\}\s*\)/,
    'distill() must call _resolveDistillTenant({tenant_id, tenant})');
});

// ---------------------------------------------------------------------------
// #6 — Static-source guard: the local-default convention is documented in the
//      helper. Future-proof against someone changing the default to null and
//      reintroducing the unbounded-corpus footgun.
// ---------------------------------------------------------------------------
test('W422 #6 — _resolveDistillTenant default is "local" (string literal)', () => {
  const src = fs.readFileSync(DISTILL_PATH, 'utf8');
  const helperIdx = src.indexOf('export function _resolveDistillTenant');
  assert.ok(helperIdx >= 0);
  // Anchor past the signature's `) {` (the body-opening brace) and then
  // brace-balance from there. Walking from the function head naively trips
  // on the `{}` inside `opts = {}` and exits before reaching the body.
  const bodyOpen = src.indexOf(') {', helperIdx);
  assert.ok(bodyOpen >= 0, 'helper signature opener must exist');
  let depth = 1;
  let end = bodyOpen + 3;
  for (let i = bodyOpen + 3; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const helperBody = src.slice(helperIdx, end);
  assert.match(helperBody, /return\s+['"]local['"]/, 'default tenant must be the string "local"');
});
