// Wave W888-B — Cloud provider + storage smoke shape lock-in.
//
// What this wave pins:
//   1) RunPodProvider constructor throws a CLEAR error with code +
//      install_hint when RUNPOD_API_KEY / KOLM_RUNPOD_TOKEN are both
//      missing. The caller must never get a vague stack trace.
//   2) RunPodProvider.detect(env) is non-throwing and returns the
//      {ok,configured,install_hint,docs_url} envelope the CLI surface
//      depends on for dry-run output.
//   3) PostgresCaptureStore constructor throws KOLM_E-style error with
//      install_hint when KOLM_CAPTURE_POSTGRES_URL is missing. We do NOT
//      try to connect to a live DB here — that's the smoke test's job.
//   4) postgres-store SCHEMA_SQL exists, is non-empty, and contains the
//      CREATE TABLE captures statement + all four required indexes.
//   5) smokePostgresStore({ env: {} }) returns ok:false with the
//      install_hint envelope when no URL is set (no throw).
//   6) `kolm test cloud` with no target prints usage + exits non-zero,
//      and `--json` mode emits a parseable JSON error envelope.
//   7) `kolm test cloud --provider runpod --json` (no key set) returns a
//      valid envelope { ok:false, targets:[{target,latency_ms,detail}] }
//      with detail.install_hint and detail.would_do — never throws.
//   8) `kolm test cloud --storage s3 --json` (no AWS creds) returns ok:false
//      with detail.install_hint mentioning the AWS env vars.
//   9) `kolm test cloud --storage postgres --json` (no DB url) returns
//      ok:false with detail.install_hint mentioning KOLM_CAPTURE_POSTGRES_URL.
//  10) ModalProvider.detect(env) is non-throwing and returns the same
//      envelope shape — providers must be swappable at the call site.
//  11) RunPodProvider.RUNPOD_GPU_CATALOG export exists and includes A100,
//      H100, L40S, RTX-4090, RTX-5090 entries.
//  12) smokePostgresStore() (direct call) uses target='postgres'. Note: the
//      CLI's no-url short-circuit path emits 'storage:postgres' before ever
//      calling smokePostgresStore — both labels are valid surface contracts.
//  13) `kolm test cloud --all --json` exercises all five targets and
//      emits an aggregate { ok, targets:[...] } shape with the canonical
//      kind:name labels from _smokeOneCloudTarget().
//  14) `kolm test cloud --dry-run --provider runpod --json` forces
//      dry-run even if the key were set, and tags detail.mode='dry-run'.
//  15) Modal detect() exposes provider:'modal' + docs_url + install_hint.
//  16) RunPod endpoint GraphQL defaults carry versioned docs-backed metadata
//      and no source-level open marker.
//  17) RunPod stopEndpoint scales the endpoint to zero workers using the
//      docs-backed saveEndpoint mutation shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as runpodMod from '../src/cloud-providers/runpod.js';
import * as modalMod  from '../src/cloud-providers/modal.js';
import * as pgStoreMod from '../src/storage/postgres-store.js';
import { RunPodProvider, RUNPOD_GPU_CATALOG, RUNPOD_GRAPHQL_CONTRACT } from '../src/cloud-providers/runpod.js';
import { ModalProvider } from '../src/cloud-providers/modal.js';
import { PostgresCaptureStore, smokePostgresStore, SCHEMA_SQL } from '../src/storage/postgres-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const KOLM_CLI = path.join(REPO_ROOT, 'cli', 'kolm.js');

// Run the CLI with a scrubbed env so cloud + storage probes are deterministic.
function runCli(argv, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w888b-'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    KOLM_API_KEY: '',
    // Scrub every cloud + storage credential so the smoke runs land in dry-run.
    RUNPOD_API_KEY: '',
    KOLM_RUNPOD_TOKEN: '',
    KOLM_RUNPOD_ENDPOINT_ID: '',
    MODAL_TOKEN_ID: '',
    MODAL_TOKEN_SECRET: '',
    KOLM_MODAL_TOKEN: '',
    CEREBRAS_API_KEY: '',
    KOLM_CEREBRAS_TOKEN: '',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    KOLM_S3_BUCKET: '',
    KOLM_R2_BUCKET: '',
    CLOUDFLARE_R2_ACCESS_KEY_ID: '',
    SUPABASE_S3_ACCESS_KEY_ID: '',
    KOLM_CAPTURE_POSTGRES_URL: '',
    DATABASE_URL: '',
    KOLM_BASE_URL: 'http://127.0.0.1:1',
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, ['--no-warnings', KOLM_CLI, ...argv], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {} // deliberate: cleanup
  let body = null;
  const out = (r.stdout || '').trim();
  if (out.startsWith('{') || out.startsWith('[')) {
    try { body = JSON.parse(out); } catch { /* not json */ }
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', body };
}

// ---------------------------------------------------------------------------
// 1) RunPodProvider constructor — missing key
// ---------------------------------------------------------------------------
test('W888-B #1 — RunPodProvider throws with code + install_hint when API key missing', () => {
  const savedKey = process.env.RUNPOD_API_KEY;
  const savedTok = process.env.KOLM_RUNPOD_TOKEN;
  delete process.env.RUNPOD_API_KEY;
  delete process.env.KOLM_RUNPOD_TOKEN;
  try {
    assert.throws(() => new RunPodProvider(), (err) => {
      assert.equal(err.code, 'runpod_api_key_missing',
        `expected code runpod_api_key_missing, got ${err.code}`);
      assert.match(err.message, /RunPod API key missing/i,
        'message must say "RunPod API key missing"');
      assert.ok(err.install_hint && typeof err.install_hint === 'string',
        'must surface install_hint string');
      assert.match(err.install_hint, /RUNPOD_API_KEY/,
        'install_hint must reference RUNPOD_API_KEY env var');
      assert.match(err.install_hint, /runpod\.io/,
        'install_hint must reference docs URL');
      assert.ok(typeof err.docs_url === 'string' && err.docs_url.length > 0,
        'must surface docs_url');
      return true;
    });
  } finally {
    if (savedKey !== undefined) process.env.RUNPOD_API_KEY = savedKey;
    if (savedTok !== undefined) process.env.KOLM_RUNPOD_TOKEN = savedTok;
  }
});

// ---------------------------------------------------------------------------
// 2) RunPodProvider.detect — never throws
// ---------------------------------------------------------------------------
test('W888-B #2 — runpod.detect(env) is non-throwing and returns full envelope', () => {
  // Both with-key and no-key paths must return a structured envelope.
  const noKey = runpodMod.detect({});
  assert.equal(noKey.ok, false, 'no-key detect must be ok:false');
  assert.equal(noKey.provider, 'runpod');
  assert.equal(noKey.configured, false);
  assert.ok(typeof noKey.reason === 'string' && noKey.reason.length > 0);
  assert.ok(typeof noKey.install_hint === 'string' && noKey.install_hint.length > 0);
  assert.ok(typeof noKey.docs_url === 'string' && noKey.docs_url.length > 0);

  const withKey = runpodMod.detect({ RUNPOD_API_KEY: 'rpa_test_key_only' });
  assert.equal(withKey.ok, true, 'with-key detect must be ok:true');
  assert.equal(withKey.provider, 'runpod');
  assert.equal(withKey.configured, true);
  assert.equal(typeof withKey.endpoint_id_configured, 'boolean');
  assert.equal(typeof withKey.graphql_url, 'string');
});

// ---------------------------------------------------------------------------
// 3) PostgresCaptureStore constructor — missing url
// ---------------------------------------------------------------------------
test('W888-B #3 — PostgresCaptureStore throws code + install_hint when no URL set', () => {
  const saved1 = process.env.KOLM_CAPTURE_POSTGRES_URL;
  const saved2 = process.env.DATABASE_URL;
  delete process.env.KOLM_CAPTURE_POSTGRES_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.throws(() => new PostgresCaptureStore(), (err) => {
      assert.equal(err.code, 'pg_no_connection_string',
        `expected code pg_no_connection_string, got ${err.code}`);
      assert.match(err.message, /no connection string/i);
      assert.ok(err.install_hint && typeof err.install_hint === 'string',
        'must surface install_hint string');
      assert.match(err.install_hint, /KOLM_CAPTURE_POSTGRES_URL/,
        'install_hint must reference KOLM_CAPTURE_POSTGRES_URL');
      return true;
    });
  } finally {
    if (saved1 !== undefined) process.env.KOLM_CAPTURE_POSTGRES_URL = saved1;
    if (saved2 !== undefined) process.env.DATABASE_URL = saved2;
  }
});

// ---------------------------------------------------------------------------
// 4) SCHEMA_SQL shape lock
// ---------------------------------------------------------------------------
test('W888-B #4 — SCHEMA_SQL contains CREATE TABLE captures + all required indexes', () => {
  assert.ok(typeof SCHEMA_SQL === 'string' && SCHEMA_SQL.length > 50,
    'SCHEMA_SQL must be a non-trivial string');
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS captures/i,
    'must declare captures table idempotently');
  // Required columns
  for (const col of ['id', 'namespace', 'tenant_id', 'created_at',
                     'request_json', 'response_json', 'prev_chain',
                     'chain_hash', 'pii_mode', 'metadata']) {
    assert.match(SCHEMA_SQL, new RegExp(`\\b${col}\\b`),
      `SCHEMA_SQL must declare column ${col}`);
  }
  // Required indexes
  for (const idx of ['idx_captures_namespace', 'idx_captures_tenant', 'idx_captures_created']) {
    assert.match(SCHEMA_SQL, new RegExp(idx),
      `SCHEMA_SQL must declare index ${idx}`);
  }
  // JSONB + TIMESTAMPTZ — no vendor-specific types
  assert.match(SCHEMA_SQL, /JSONB/i, 'must use JSONB columns');
  assert.match(SCHEMA_SQL, /TIMESTAMPTZ/i, 'must use TIMESTAMPTZ');
});

// ---------------------------------------------------------------------------
// 5) smokePostgresStore — no-url returns structured envelope, never throws
// ---------------------------------------------------------------------------
test('W888-B #5 — smokePostgresStore({env:{}}) returns ok:false with install_hint, no throw', async () => {
  let out;
  try {
    out = await smokePostgresStore({ env: {} });
  } catch (e) {
    assert.fail(`smokePostgresStore must never throw on missing env; threw: ${e.message}`);
  }
  assert.equal(out.ok, false, 'no-url smoke must be ok:false');
  assert.equal(out.target, 'postgres', 'target label must be "postgres"');
  assert.equal(typeof out.latency_ms, 'number');
  assert.ok(out.detail && typeof out.detail === 'object', 'must include .detail');
  assert.ok(out.detail.reason && /KOLM_CAPTURE_POSTGRES_URL/.test(out.detail.reason),
    `detail.reason must reference env var; got: ${out.detail.reason}`);
  assert.ok(out.detail.install_hint && /postgres:/.test(out.detail.install_hint),
    `detail.install_hint must show example connection string; got: ${out.detail.install_hint}`);
});

// ---------------------------------------------------------------------------
// 6) `kolm test cloud` with no target — usage + non-zero
// ---------------------------------------------------------------------------
test('W888-B #6 — `kolm test cloud --json` (no target) emits parseable error JSON + non-zero exit', () => {
  const r = runCli(['test', 'cloud', '--json']);
  assert.notEqual(r.status, 0, 'no-target run must exit non-zero');
  assert.ok(r.body, `must emit parseable JSON even on usage error; got stdout=${r.stdout.slice(0, 200)}`);
  assert.equal(r.body.ok, false, 'envelope must be ok:false');
  assert.ok(typeof r.body.error === 'string' && /target/i.test(r.body.error),
    'error must mention missing target');
  assert.ok(typeof r.body.install_hint === 'string' && /test cloud/.test(r.body.install_hint),
    'install_hint must show the canonical fixed command');
});

// ---------------------------------------------------------------------------
// 7) `kolm test cloud --provider runpod` no key — dry-run envelope
// ---------------------------------------------------------------------------
test('W888-B #7 — `kolm test cloud --provider runpod --json` (no key) returns valid dry-run envelope', () => {
  const r = runCli(['test', 'cloud', '--provider', 'runpod', '--json']);
  // No key means the smoke is supposed to land in ok:false (dry-run / no-key mode).
  // The CLI exits non-zero on any failing target.
  assert.ok(r.body, `must emit parseable JSON; got stdout=${r.stdout.slice(0, 400)}`);
  assert.equal(r.body.ok, false, 'no-key smoke must be ok:false');
  assert.ok(Array.isArray(r.body.targets) && r.body.targets.length === 1);
  const tgt = r.body.targets[0];
  assert.equal(tgt.target, 'provider:runpod', 'target label must be "provider:runpod"');
  assert.equal(typeof tgt.latency_ms, 'number');
  assert.ok(tgt.detail && typeof tgt.detail === 'object', 'must include .detail object');
  assert.ok(['no-key', 'dry-run'].includes(tgt.detail.mode),
    `detail.mode must be no-key or dry-run; got ${tgt.detail.mode}`);
  assert.ok(typeof tgt.detail.install_hint === 'string' && tgt.detail.install_hint.length > 0,
    'detail.install_hint must be present for no-key path');
  assert.ok(typeof tgt.detail.would_do === 'string' && tgt.detail.would_do.length > 0,
    'detail.would_do must describe the would-be call');
});

// ---------------------------------------------------------------------------
// 8) `kolm test cloud --storage s3` no creds — install_hint mentions AWS env
// ---------------------------------------------------------------------------
test('W888-B #8 — `kolm test cloud --storage s3 --json` (no AWS creds) returns install_hint w/ AWS env vars', () => {
  const r = runCli(['test', 'cloud', '--storage', 's3', '--json']);
  assert.ok(r.body, `must emit parseable JSON; got stdout=${r.stdout.slice(0, 400)}`);
  assert.equal(r.body.ok, false, 'no-creds smoke must be ok:false');
  assert.ok(Array.isArray(r.body.targets) && r.body.targets.length === 1);
  const tgt = r.body.targets[0];
  assert.equal(tgt.target, 'storage:s3', 'target label must be "storage:s3"');
  assert.equal(typeof tgt.latency_ms, 'number');
  assert.ok(tgt.detail && typeof tgt.detail === 'object', 'must include .detail object');
  assert.ok(typeof tgt.detail.install_hint === 'string' && tgt.detail.install_hint.length > 0,
    'detail.install_hint must be present');
  assert.match(tgt.detail.install_hint, /AWS_ACCESS_KEY_ID/,
    `detail.install_hint must mention AWS_ACCESS_KEY_ID; got: ${tgt.detail.install_hint}`);
  assert.match(tgt.detail.install_hint, /AWS_SECRET_ACCESS_KEY/,
    'detail.install_hint must mention AWS_SECRET_ACCESS_KEY');
});

// ---------------------------------------------------------------------------
// 9) `kolm test cloud --storage postgres` no url — install_hint mentions env
// ---------------------------------------------------------------------------
test('W888-B #9 — `kolm test cloud --storage postgres --json` (no url) install_hint mentions KOLM_CAPTURE_POSTGRES_URL', () => {
  const r = runCli(['test', 'cloud', '--storage', 'postgres', '--json']);
  assert.ok(r.body, `must emit parseable JSON; got stdout=${r.stdout.slice(0, 400)}`);
  assert.equal(r.body.ok, false, 'no-url smoke must be ok:false');
  assert.ok(Array.isArray(r.body.targets) && r.body.targets.length === 1);
  const tgt = r.body.targets[0];
  // No-url short-circuit path through _smokeOneCloudTarget emits the
  // canonical kind:name label "storage:postgres". Only the live smoke path
  // (smokePostgresStore) emits the bare "postgres" — see lock-in #12.
  assert.equal(tgt.target, 'storage:postgres',
    'no-url path target label must be "storage:postgres"');
  assert.ok(tgt.detail && typeof tgt.detail === 'object');
  assert.match(tgt.detail.install_hint, /KOLM_CAPTURE_POSTGRES_URL/,
    `detail.install_hint must mention KOLM_CAPTURE_POSTGRES_URL; got: ${tgt.detail.install_hint}`);
});

// ---------------------------------------------------------------------------
// 10) Modal detect — same envelope shape as runpod, never throws
// ---------------------------------------------------------------------------
test('W888-B #10 — modal.detect(env) is non-throwing and matches runpod envelope shape', () => {
  const noKey = modalMod.detect({});
  assert.equal(noKey.ok, false);
  assert.equal(noKey.provider, 'modal');
  assert.equal(noKey.configured, false);
  assert.ok(typeof noKey.install_hint === 'string' && noKey.install_hint.length > 0);
  assert.ok(typeof noKey.docs_url === 'string' && noKey.docs_url.length > 0);
  assert.match(noKey.install_hint, /modal token/i,
    'install_hint must reference modal token bootstrap');

  const withTok = modalMod.detect({ MODAL_TOKEN_ID: 'ak-test' });
  assert.equal(withTok.ok, true);
  assert.equal(withTok.provider, 'modal');
  assert.equal(withTok.configured, true);
});

// ---------------------------------------------------------------------------
// 11) RUNPOD_GPU_CATALOG export — known SKUs
// ---------------------------------------------------------------------------
test('W888-B #11 — RUNPOD_GPU_CATALOG exposes A100, H100, L40S, RTX-4090, RTX-5090', () => {
  assert.ok(RUNPOD_GPU_CATALOG && typeof RUNPOD_GPU_CATALOG === 'object');
  for (const sku of ['A100', 'H100', 'L40S', 'RTX-4090', 'RTX-5090']) {
    assert.ok(typeof RUNPOD_GPU_CATALOG[sku] === 'string' && RUNPOD_GPU_CATALOG[sku].length > 0,
      `RUNPOD_GPU_CATALOG must include ${sku}`);
  }
  // The catalog is frozen so downstream code can rely on stable values.
  assert.ok(Object.isFrozen(RUNPOD_GPU_CATALOG),
    'RUNPOD_GPU_CATALOG must be Object.freeze()d to prevent runtime mutation');
});

// ---------------------------------------------------------------------------
// 12) Postgres smoke output uses target='postgres'
// ---------------------------------------------------------------------------
test('W888-B #12 — smokePostgresStore() direct call uses target="postgres" (live path label)', async () => {
  // Direct calls to smokePostgresStore() bypass the CLI's _smokeOneCloudTarget
  // shim and produce the bare "postgres" target label. The ship-gate aggregator
  // accepts either "postgres" (live path) or "storage:postgres" (no-url path).
  const out = await smokePostgresStore({ env: {} });
  assert.equal(out.target, 'postgres',
    `direct smoke target label must be "postgres"; got "${out.target}"`);
});

// ---------------------------------------------------------------------------
// 13) `kolm test cloud --all --json` covers all five targets
// ---------------------------------------------------------------------------
test('W888-B #13 — `kolm test cloud --all --json` emits an aggregate of all five targets', () => {
  const r = runCli(['test', 'cloud', '--all', '--json']);
  assert.ok(r.body, `must emit parseable JSON; got stdout=${r.stdout.slice(0, 400)}`);
  assert.equal(typeof r.body.ok, 'boolean');
  assert.ok(Array.isArray(r.body.targets), '.targets must be an array');
  // All five targets present. The CLI's _smokeOneCloudTarget shim emits the
  // canonical kind:name labels for the no-url short-circuit path — the
  // direct-call live path label is asserted in lock-in #12.
  const labels = r.body.targets.map((t) => t.target).sort();
  assert.deepEqual(labels, ['provider:cerebras', 'provider:modal', 'provider:runpod', 'storage:postgres', 'storage:s3'],
    `--all must hit exactly the five canonical targets; got: ${JSON.stringify(labels)}`);
  for (const t of r.body.targets) {
    assert.equal(typeof t.latency_ms, 'number');
    assert.ok(t.detail && typeof t.detail === 'object');
  }
  assert.equal(typeof r.body.ts, 'string', 'envelope must include ISO ts');
});

// ---------------------------------------------------------------------------
// 14) `kolm test cloud --dry-run` forces dry-run mode
// ---------------------------------------------------------------------------
test('W888-B #14 — `kolm test cloud --dry-run --provider runpod --json` tags mode="dry-run"', () => {
  // Force the dry-run path even when the env has a fake key set, so the test
  // never makes an upstream call.
  const r = runCli(['test', 'cloud', '--dry-run', '--provider', 'runpod', '--json'],
    { RUNPOD_API_KEY: 'rpa_test_key_for_dry_run_only' });
  assert.ok(r.body, `must emit parseable JSON; got stdout=${r.stdout.slice(0, 400)}`);
  const tgt = r.body.targets && r.body.targets[0];
  assert.ok(tgt, 'must have at least one target row');
  assert.equal(tgt.detail.mode, 'dry-run',
    `dry-run must force detail.mode=dry-run; got ${tgt.detail.mode}`);
});

// ---------------------------------------------------------------------------
// 15) Modal detect — surface contract
// ---------------------------------------------------------------------------
test('W888-B #15 — modal detect envelope includes provider, docs_url, install_hint, reason', () => {
  const d = modalMod.detect({});
  for (const field of ['provider', 'docs_url', 'install_hint', 'reason']) {
    assert.ok(d[field] && typeof d[field] === 'string',
      `modal detect envelope must include string field "${field}"; got ${JSON.stringify(d[field])}`);
  }
  assert.equal(d.provider, 'modal');
  assert.match(d.docs_url, /modal\.com/);
});

// ---------------------------------------------------------------------------
// 16) RunPod GraphQL defaults carry explicit contract metadata
// ---------------------------------------------------------------------------
test('W888-B #16 - RunPod GraphQL defaults are versioned, docs-backed, and marker-free', () => {
  assert.match(RUNPOD_GRAPHQL_CONTRACT.version, /^w976-runpod-graphql-contract-v\d+$/);
  assert.match(RUNPOD_GRAPHQL_CONTRACT.endpoints_docs_url, /docs\.runpod\.io\/sdks\/graphql\/manage-endpoints/);
  assert.match(RUNPOD_GRAPHQL_CONTRACT.docs_url, /docs\.runpod\.io\/sdks\/graphql\/configurations/);
  assert.match(RUNPOD_GRAPHQL_CONTRACT.schema_url, /graphql-spec\.runpod\.io/);

  const provider = new RunPodProvider('rpa_test_key_for_contract_only', {
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: {} }),
    }),
  });
  for (const name of ['createEndpoint', 'listEndpoints', 'stopEndpoint', 'endpointMetrics']) {
    const mutation = provider.mutations[name];
    const contract = RUNPOD_GRAPHQL_CONTRACT.operations[name];
    assert.ok(mutation, `mutation ${name} must be present`);
    assert.equal(mutation.docs_url, contract.docs_url, `${name} docs_url must come from contract`);
    assert.equal(mutation.upstream_operation, contract.upstream_operation,
      `${name} upstream_operation must come from contract`);
    assert.equal(mutation.contract_status, contract.contract_status,
      `${name} contract_status must come from contract`);
    assert.equal(typeof mutation.query, 'string', `${name} must include GraphQL query text`);
  }

  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cloud-providers', 'runpod.js'), 'utf8');
  const openMarkerPattern = new RegExp(`\\b${'TO'}${'DO'}\\b`);
  assert.doesNotMatch(source, openMarkerPattern,
    'RunPod provider must not carry an unowned open marker after contract pinning');
  assert.doesNotMatch(source, /serverless\/endpoints\/manage-endpoints/,
    'RunPod provider must not point at the retired endpoint docs URL');
});

// ---------------------------------------------------------------------------
// 17) stopEndpoint uses docs-backed scale-to-zero semantics
// ---------------------------------------------------------------------------
test('W888-B #17 - RunPod stopEndpoint scales workers to zero through saveEndpoint', async () => {
  const calls = [];
  const provider = new RunPodProvider('rpa_test_key_for_stop_only', {
    fetch: async (_url, opts) => {
      calls.push(JSON.parse(opts.body));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: { saveEndpoint: { id: 'ep_test_123', workersMin: 0, workersMax: 0 } },
        }),
      };
    },
  });

  const out = await provider.stopEndpoint('ep_test_123');
  assert.equal(out.ok, true);
  assert.equal(out.endpoint_id, 'ep_test_123');
  assert.equal(calls.length, 1, 'stopEndpoint must make exactly one GraphQL call');
  assert.match(calls[0].query, /saveEndpoint/, 'stopEndpoint must use saveEndpoint');
  assert.doesNotMatch(calls[0].query, /stopEndpoint\s*\(/,
    'stopEndpoint must not call the undocumented stopEndpoint mutation');
  assert.deepEqual(calls[0].variables, {
    input: { id: 'ep_test_123', workersMin: 0, workersMax: 0 },
  });
  assert.equal(out.raw.saveEndpoint.workersMin, 0);
  assert.equal(out.raw.saveEndpoint.workersMax, 0);
});
