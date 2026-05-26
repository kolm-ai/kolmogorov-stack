// W457 — auth-state surface reconciliation (P0 release blocker).
//
// The audit found four CLI surfaces disagreed about auth + cloud state:
//
//   1) `kolm whoami` said logged_in:false but `kolm config show` said true,
//      because whoami round-tripped /v1/account (which 401s on revoked keys)
//      while config show only checked the local config file. Fix: whoami JSON
//      now includes BOTH `config_has_key` and `server_validated` and computes
//      logged_in = (config_has_key && server_validated). config show is
//      unchanged — but the truth that disambiguates is now in whoami.
//
//   2) `kolm doctor` printed "api key ok" any time the config held a key,
//      hiding that the cloud might reject it. Fix: split into two checks,
//      "api key (config)" and "api key (server)", so a stale key shows
//      "config holds key" + "server rejected the key".
//
//   3) `kolm capture status` crashed with AggregateError / "fetch failed"
//      when the cloud was unreachable. Fix: try/catch the api() call and
//      fall back to counting local capture files under ~/.kolm/capture/
//      and ~/.kolm/captures/. Always print "(offline)" + a useful hint.
//
//   4) `kolm distill runs` died with "fetch failed" against an unreachable
//      base. Fix: mirror the W456 cmdChangelog offline-fallback pattern —
//      on any non-{ok:true,...} response (or any network error), read
//      ~/.kolm/distill-runs/run_*/{run-meta.json,progress.jsonl} directly
//      via src/distill-pipeline.js. Print "(offline)" header marker.
//
// Tests assert BEHAVIOR (envelope shape, exit codes, presence of offline
// markers), NOT page copy or specific human-readable strings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'cli', 'kolm.js');

// runCli spawns the kolm CLI in a clean $HOME so the test cannot accidentally
// pick up the developer's real ~/.kolm/config.json. The fresh HOME doubles as
// the directory that the CLI's `~/.kolm/...` paths resolve under, so all the
// offline-fallback file reads land in the temp tree.
function runCli(args, { base, apiKey, home, env: extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const tmp = home || fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w457-'));
    if (apiKey) {
      const cfgDir = path.join(tmp, '.kolm');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ base, api_key: apiKey }));
    }
    const env = {
      ...process.env,
      HOME: tmp,
      USERPROFILE: tmp,
      KOLM_HOME: path.join(tmp, '.kolm'),
      ...extraEnv,
    };
    if (base !== undefined) env.KOLM_BASE = base || '';
    delete env.KOLM_API_KEY;
    if (apiKey) env.KOLM_API_KEY = apiKey;
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      if (!home) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} } // deliberate: cleanup
      resolve({ code, stdout, stderr, home: tmp });
    });
  });
}

// ============================================================================
// FIX 1 — `kolm whoami` augmented envelope
// ============================================================================

test('W457 #1 — whoami --json with no key emits config_has_key:false + server_validated:false', async () => {
  const r = await runCli(['whoami', '--json']);
  assert.notEqual(r.code, 0, 'whoami without a key must exit non-zero');
  const env = JSON.parse(r.stdout.trim());
  assert.equal(env.logged_in, false, 'logged_in must be false with no key');
  assert.equal(env.config_has_key, false, 'config_has_key field must be present and false');
  assert.equal(env.server_validated, false, 'server_validated field must be present and false');
  assert.ok('tenant' in env, 'tenant field must be present even when null');
});

test('W457 #2 — whoami --json with key but unreachable cloud emits config_has_key:true + server_validated:false', async () => {
  // base points at a port nothing is listening on -> ECONNREFUSED -> server_validated:false.
  // Use a numbered TEST-NET-1 address so we get a fast connection refusal, not a DNS hang.
  const r = await runCli(['whoami', '--json'], {
    base: 'http://127.0.0.1:1',
    apiKey: 'ks_test_w457_2_abcdef',
  });
  assert.notEqual(r.code, 0, 'whoami with unreachable cloud must exit non-zero');
  const env = JSON.parse(r.stdout.trim());
  assert.equal(env.logged_in, false, 'logged_in must be false when server cannot validate');
  assert.equal(env.config_has_key, true, 'config_has_key must be true (the key is on disk)');
  assert.equal(env.server_validated, false, 'server_validated must be false when cloud is unreachable');
  assert.ok(env.key_fingerprint, 'key_fingerprint must still be emitted (config side has the key)');
  assert.ok(!String(env.key_fingerprint).includes('abcdef'),
    'fingerprint must NOT include the middle of the key (only prefix+suffix)');
});

// ============================================================================
// FIX 2 — `kolm doctor` splits api-key into config vs server checks
// ============================================================================

test('W457 #3 — doctor --json splits api key check into "config" and "server" rows', async () => {
  // Point at a port nothing is bound to so /health AND /v1/account both fail.
  // We want "api key (config)" to report ok (the key is on disk) and "api key
  // (server)" to report warn (cloud unreachable -> cannot validate).
  const r = await runCli(['doctor', '--json'], {
    base: 'http://127.0.0.1:1',
    apiKey: 'ks_test_w457_3_zzzzz',
  });
  // doctor without --loop exits 0 even on warnings (no blockers).
  const env = JSON.parse(r.stdout.trim());
  assert.ok(Array.isArray(env.checks), 'doctor --json must return a checks array');
  const names = env.checks.map((c) => c.name);
  assert.ok(names.includes('api key (config)'),
    'doctor must include an "api key (config)" row, got: ' + JSON.stringify(names));
  assert.ok(names.includes('api key (server)'),
    'doctor must include an "api key (server)" row, got: ' + JSON.stringify(names));
  const configRow = env.checks.find((c) => c.name === 'api key (config)');
  const serverRow = env.checks.find((c) => c.name === 'api key (server)');
  assert.equal(configRow.status, 'ok', 'config row must be ok when key is on disk');
  assert.equal(serverRow.status, 'warn',
    'server row must be warn when cloud cannot validate the key (no false "ok")');
});

// ============================================================================
// FIX 3 — `kolm capture status` falls back to local count instead of crashing
// ============================================================================

test('W457 #4 — capture status --json falls back to local count on cloud failure (never AggregateError)', async () => {
  // Seed a couple of local capture files so the fallback has something to count.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w457-cap-'));
  try {
    const captureDir = path.join(tmp, '.kolm', 'captures');
    fs.mkdirSync(captureDir, { recursive: true });
    fs.writeFileSync(
      path.join(captureDir, 'default.jsonl'),
      '{"input":"hi","output":"hello"}\n{"input":"bye","output":"see you"}\n',
    );
    // Also seed a partial canonical event-store row. The CLI must reconcile
    // event-store + legacy jsonl by max(counts), not return the first non-zero
    // event-store count and hide rows the user can see on disk.
    const eventsDir = path.join(tmp, '.kolm', 'events');
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.writeFileSync(path.join(eventsDir, 'events.jsonl'), JSON.stringify({
      event_id: 'evt_w457_partial_1',
      tenant_id: 'local',
      namespace: 'default',
      created_at: new Date().toISOString(),
      schema_version: 1,
    }) + '\n');
    const r = await runCli(['capture', 'status', '--json'], {
      base: 'http://127.0.0.1:1',         // cloud unreachable
      apiKey: 'ks_test_w457_4_zzzz',
      home: tmp,
      env: {
        KOLM_DATA_DIR: path.join(tmp, '.kolm'),
        KOLM_EVENT_STORE_DRIVER: 'jsonl',
      },
    });
    assert.equal(r.code, 0,
      'capture status must exit 0 with offline fallback (was: AggregateError -> non-zero). stderr: ' + r.stderr);
    assert.ok(!/AggregateError/.test(r.stderr + r.stdout),
      'must NOT leak an unwrapped AggregateError. stderr: ' + r.stderr);
    const env = JSON.parse(r.stdout.trim());
    assert.equal(env.ok, true);
    assert.equal(env.source, 'local', 'source must be "local" when cloud unreachable');
    assert.equal(env.offline, true, 'offline must be true when falling back to local');
    assert.equal(env.count, 2, 'count must reflect the local jsonl rows (got: ' + env.count + ')');
    assert.equal(env.threshold, 1000, 'threshold must default to 1000 in the fallback');
    assert.ok(env.hint, 'hint must point users at starting the capture daemon');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

test('W547 #1 - capture setup --json emits a parseable, redacted setup envelope', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w547-capture-json-'));
  const apiKey = 'ks_test_w547_capture_json_secret_1234567890';
  try {
    const r = await runCli(
      ['capture', '--provider', 'openai', '--as', 'ticket-router', '--namespace', 'tickets', '--json'],
      {
        base: 'https://kolm.ai',
        apiKey,
        home: tmp,
      },
    );
    assert.equal(r.code, 0, 'capture setup --json must exit 0. stderr: ' + r.stderr);
    assert.equal(r.stderr.trim(), '', 'capture setup --json should not write stderr on success');
    const env = JSON.parse(r.stdout.trim());
    assert.equal(env.ok, true);
    assert.equal(env.provider, 'openai');
    assert.equal(env.task, 'ticket-router');
    assert.equal(env.namespace, 'tickets');
    assert.equal(env.base_url, 'https://kolm.ai/v1/capture/openai');
    assert.equal(env.upstream_key_env, 'OPENAI_API_KEY');
    assert.equal(env.client_env.OPENAI_BASE_URL, env.base_url);
    assert.equal(env.required_headers['x-kolm-namespace'], 'tickets');
    assert.ok(env.key_fingerprint.startsWith('ks_test_w5'), 'must expose only the standard key fingerprint');
    assert.ok(!r.stdout.includes(apiKey), 'JSON stdout must not leak the full API key');
    assert.ok(fs.existsSync(env.config_path), 'capture config file must be written');
    const diskCfg = JSON.parse(fs.readFileSync(env.config_path, 'utf8'));
    assert.equal(diskCfg.kolm_api_key, apiKey, 'private config file still needs the real key for local setup');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

test('W547 #3 - capture setup supports OpenRouter as a first-class provider', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w547-openrouter-json-'));
  const apiKey = 'ks_test_w547_openrouter_capture_secret_1234567890';
  try {
    const r = await runCli(
      ['capture', '--provider', 'openrouter', '--as', 'router-lake', '--namespace', 'router', '--json'],
      { base: 'https://kolm.ai', apiKey, home: tmp },
    );
    assert.equal(r.code, 0, 'openrouter capture setup --json must exit 0. stderr: ' + r.stderr);
    const env = JSON.parse(r.stdout.trim());
    assert.equal(env.ok, true);
    assert.equal(env.provider, 'openrouter');
    assert.equal(env.base_url, 'https://kolm.ai/v1/capture/openrouter/v1');
    assert.equal(env.upstream_key_env, 'OPENROUTER_API_KEY');
    assert.equal(env.client_env.OPENAI_BASE_URL, env.base_url);
    assert.equal(env.client_env.OPENROUTER_BASE_URL, env.base_url);
    assert.equal(env.required_headers['x-upstream-api-key'], 'sk-or-...');
    assert.ok(!r.stdout.includes(apiKey), 'JSON stdout must not leak the full API key');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

// ============================================================================
// FIX 4 — `kolm distill runs` offline-fallback reads ~/.kolm/distill-runs/
// ============================================================================

test('W457 #5 — distill runs --json offline-fallback returns local runs envelope', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w457-runs-'));
  try {
    const runsDir = path.join(tmp, '.kolm', 'distill-runs');
    fs.mkdirSync(runsDir, { recursive: true });
    // Seed a local run so the fallback has something to enumerate. Use
    // tenant_id:'local' so listDistillRuns({tenant_id:'local'}) finds it.
    const d = path.join(runsDir, 'run_w457_offline_1');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'run-meta.json'), JSON.stringify({
      job_id: 'jid-w457',
      tenant_id: 'local',
      namespace: 'ns-w457',
      student_base: 'phi-3-mini',
      pipeline_mode: 'stub',
      pair_count: 4,
      worker_mode: 'stub',
      teacher: { vendor: 'local', model: 'mock' },
      created_at: new Date().toISOString(),
    }));
    fs.writeFileSync(
      path.join(d, 'progress.jsonl'),
      '{"i":1,"step":1,"loss":2.3,"k_score":0.20}\n{"i":2,"step":2,"loss":1.1,"k_score":0.60}\n',
    );
    const r = await runCli(['distill', 'runs', '--json'], {
      base: 'http://127.0.0.1:1',         // cloud unreachable
      apiKey: 'ks_test_w457_5_zzzz',
      home: tmp,
    });
    assert.equal(r.code, 0,
      'distill runs must exit 0 with offline fallback (was: "fetch failed" -> non-zero). stderr: ' + r.stderr);
    assert.ok(!/fetch failed/.test(r.stderr),
      'must NOT leak a bare "fetch failed". stderr: ' + r.stderr);
    const env = JSON.parse(r.stdout.trim());
    assert.equal(env.ok, true);
    assert.equal(env.source, 'local', 'source must be "local" when cloud unreachable');
    assert.ok(Array.isArray(env.runs), 'runs must be an array');
    assert.equal(env.runs.length, 1, 'must find the seeded local run');
    assert.equal(env.runs[0].id, 'run_w457_offline_1');
    assert.equal(env.runs[0].namespace, 'ns-w457');
    assert.equal(env.runs[0].step_count, 2);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

test('W457 #6 — distill runs --json on empty local store returns ok:true with runs:[]', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w457-runs-empty-'));
  try {
    const r = await runCli(['distill', 'runs', '--json'], {
      base: 'http://127.0.0.1:1',
      apiKey: 'ks_test_w457_6_zzzz',
      home: tmp,
    });
    assert.equal(r.code, 0, 'empty offline list must still exit 0. stderr: ' + r.stderr);
    const env = JSON.parse(r.stdout.trim());
    assert.equal(env.ok, true);
    assert.equal(env.source, 'local');
    assert.ok(Array.isArray(env.runs));
    assert.equal(env.runs.length, 0);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});
