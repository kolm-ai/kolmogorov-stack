// Wave W888-J — config layer (src/config.js) tests.
//
// What this wave locks in:
//   1. Hierarchy resolves correctly: flag > env > user TOML > project TOML > defaults.
//   2. TOML round-trip works (saveConfig writes -> loadConfig reads -> same value).
//   3. Secret keys redact by default (api_key, postgres_url) — only revealed with --show-secrets.
//   4. Legacy ~/.kolm/config.json migrates into ~/.kolm/config.toml on first read,
//      and the JSON file is left in place for back-compat with older CLIs.
//   5. Env-var binding pattern: KOLM_<SECTION>_<KEY> maps to <section>.<key>.
//   6. `kolm config list/get/set/unset` end-to-end via spawnSync.
//
// Every test runs in an isolated HOME so the user's real ~/.kolm is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const KOLM_CLI = path.join(REPO, 'cli', 'kolm.js');
const CFG_MOD_URL = 'file://' + path.join(REPO, 'src', 'config.js').replace(/\\/g, '/');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w888j-'));
}

function envFor(home, extra = {}) {
  // Scrub every env-var binding the resolver might pick up so each test's
  // baseline is deterministic. Tests that need a specific binding set it
  // explicitly via `extra`.
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    KOLM_API_KEY: '',
    KOLM_GATEWAY_DEFAULT_PROVIDER: '',
    KOLM_GATEWAY_PII_MODE: '',
    KOLM_GATEWAY_CAPTURE_RATE: '',
    KOLM_COMPILE_DEFAULT_TARGET: '',
    KOLM_COMPILE_KSCORE_GATE: '',
    KOLM_SERVE_DEFAULT_PORT: '',
    KOLM_CLOUD_PROVIDER: '',
    KOLM_CLOUD_API_KEY: '',
    KOLM_STORAGE_TYPE: '',
    KOLM_STORAGE_POSTGRES_URL: '',
    KOLM_TELEMETRY_ENABLED: '',
    ...extra,
  };
  // Strip any leftover KOLM_*_DEFAULT_* keys from the inherited env to keep
  // tests reproducible on developer boxes.
  for (const k of Object.keys(env)) {
    if (k.startsWith('KOLM_') && env[k] === '') env[k] = '';
  }
  return env;
}

function runCli(argv, home, extraEnv = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', KOLM_CLI, ...argv], {
    cwd: home,
    env: envFor(home, extraEnv),
    encoding: 'utf8',
    timeout: 30_000,
  });
  let body = null;
  const trimmed = (r.stdout || '').trim();
  if (trimmed && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try { body = JSON.parse(trimmed); } catch (_) { /* not json */ }
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', body };
}

// ---------------------------------------------------------------------------
// MODULE-LEVEL TESTS — exercise the loadConfig/saveConfig/etc API directly so
// failures point at the resolver, not the CLI wiring.
// ---------------------------------------------------------------------------

test('W888-J #1 — defaults are returned when no TOML or env override exists', async () => {
  const home = freshHome();
  try {
    // Re-import the module fresh so the in-process HOME flip is honored.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const cfg = await import(CFG_MOD_URL + '?w888j1=' + Date.now());
    const merged = await cfg.loadConfig({ env: { HOME: home, USERPROFILE: home } });
    assert.equal(merged.gateway.default_provider, 'openai',
      'default gateway.default_provider must be "openai"');
    assert.equal(merged.serve.default_port, 8765,
      'default serve.default_port must be 8765');
    assert.equal(merged.compile.default_target, 'gguf-q4km',
      'default compile.default_target must be "gguf-q4km"');
    assert.equal(merged._sources['gateway.default_provider'], 'default',
      'gateway.default_provider source must be "default"');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('W888-J #2 — hierarchy: flag > env > user > project > default', async () => {
  const home = freshHome();
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  // Project TOML — lowest priority above default.
  fs.writeFileSync(
    path.join(projectDir, 'kolm.toml'),
    '[gateway]\ndefault_provider = "from-project"\n',
  );
  // User TOML — beats project.
  fs.mkdirSync(path.join(home, '.kolm'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.kolm', 'config.toml'),
    '[gateway]\ndefault_provider = "from-user"\n',
  );
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const cfg = await import(CFG_MOD_URL + '?w888j2=' + Date.now());

    // 1) User TOML wins over project.
    const merged1 = await cfg.loadConfig({ cwd: projectDir, env: { HOME: home, USERPROFILE: home } });
    assert.equal(merged1.gateway.default_provider, 'from-user',
      'user TOML must beat project TOML');
    assert.equal(merged1._sources['gateway.default_provider'], 'user');

    // 2) Env beats user TOML.
    const merged2 = await cfg.loadConfig({
      cwd: projectDir,
      env: { HOME: home, USERPROFILE: home, KOLM_GATEWAY_DEFAULT_PROVIDER: 'from-env' },
    });
    assert.equal(merged2.gateway.default_provider, 'from-env',
      'env must beat user TOML');
    assert.equal(merged2._sources['gateway.default_provider'], 'env');

    // 3) Flag beats env.
    const merged3 = await cfg.loadConfig({
      cwd: projectDir,
      env: { HOME: home, USERPROFILE: home, KOLM_GATEWAY_DEFAULT_PROVIDER: 'from-env' },
      flags: { 'gateway.default_provider': 'from-flag' },
    });
    assert.equal(merged3.gateway.default_provider, 'from-flag',
      'flag must beat env');
    assert.equal(merged3._sources['gateway.default_provider'], 'flag');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('W888-J #3 — saveConfig writes TOML, loadConfig reads it back (round-trip)', async () => {
  const home = freshHome();
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const cfg = await import(CFG_MOD_URL + '?w888j3=' + Date.now());

    await cfg.saveConfig('gateway.default_provider', 'anthropic', { scope: 'user' });
    await cfg.saveConfig('serve.default_port', '9000', { scope: 'user' });
    await cfg.saveConfig('telemetry.enabled', 'true', { scope: 'user' });
    await cfg.saveConfig('gateway.fallback_providers', 'openai,anthropic,kolm', { scope: 'user' });

    const merged = await cfg.loadConfig({ env: { HOME: home, USERPROFILE: home } });
    assert.equal(merged.gateway.default_provider, 'anthropic',
      'saved string value must round-trip');
    assert.equal(merged.serve.default_port, 9000,
      'saved number value must coerce to number via schema');
    assert.equal(merged.telemetry.enabled, true,
      'saved boolean value must coerce to bool via schema');
    assert.deepEqual(merged.gateway.fallback_providers, ['openai', 'anthropic', 'kolm'],
      'saved array value must split on commas via schema');
    assert.equal(merged._sources['gateway.default_provider'], 'user',
      'source must be "user" after saveConfig at user scope');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('W888-J #4 — secret keys redact in flattenConfig + isSecretKey heuristic', async () => {
  const home = freshHome();
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const cfg = await import(CFG_MOD_URL + '?w888j4=' + Date.now());

    await cfg.saveConfig('account.api_key', 'ks_supersecret_1234567890abcdef', { scope: 'user' });
    await cfg.saveConfig('storage.postgres_url', 'postgres://user:pass@host:5432/db', { scope: 'user' });
    await cfg.saveConfig('gateway.default_provider', 'openai', { scope: 'user' });

    assert.equal(cfg.isSecretKey('account.api_key'), true, 'account.api_key must be flagged secret');
    assert.equal(cfg.isSecretKey('storage.postgres_url'), true, 'postgres_url must be flagged secret');
    assert.equal(cfg.isSecretKey('cloud.api_key'), true, 'cloud.api_key must be flagged secret');
    assert.equal(cfg.isSecretKey('gateway.default_provider'), false, 'non-secret keys must not be flagged');

    // Redaction shape: long values show 6-prefix + '...' + 4-suffix.
    const redacted = cfg.redactValue('ks_supersecret_1234567890abcdef');
    assert.match(redacted, /^ks_sup\.\.\.cdef$/, 'long secret should be 6-prefix + ... + 4-suffix');
    // Short values show ***.
    assert.equal(cfg.redactValue('hi'), '***', 'short values redact to ***');

    const merged = await cfg.loadConfig({ env: { HOME: home, USERPROFILE: home } });
    const flat = cfg.flattenConfig(merged);
    const apiRow = flat.find(r => r.key === 'account.api_key');
    assert.ok(apiRow, 'account.api_key must appear in flattenConfig output');
    assert.equal(apiRow.secret, true, 'account.api_key row must carry secret:true');
    assert.equal(apiRow.value, 'ks_supersecret_1234567890abcdef',
      'flattenConfig itself returns the raw value — redaction is the printer\'s job');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('W888-J #5 — env-var binding KOLM_<SECTION>_<KEY> maps to dotted key (envToDotted + dottedToEnv)', async () => {
  const cfg = await import(CFG_MOD_URL + '?w888j5=' + Date.now());

  assert.equal(cfg.envToDotted('KOLM_GATEWAY_DEFAULT_PROVIDER'), 'gateway.default_provider');
  assert.equal(cfg.envToDotted('KOLM_STORAGE_S3_ENDPOINT'), 'storage.s3_endpoint');
  assert.equal(cfg.envToDotted('KOLM_TELEMETRY_ENABLED'), 'telemetry.enabled');
  // Non-KOLM_ envs ignored.
  assert.equal(cfg.envToDotted('PATH'), null);
  // KOLM_ var pointing at an unknown section ignored.
  assert.equal(cfg.envToDotted('KOLM_UNKNOWN_SECTION_KEY'), null);

  // Round-trip via dottedToEnv.
  assert.equal(cfg.dottedToEnv('gateway.default_provider'), 'KOLM_GATEWAY_DEFAULT_PROVIDER');
  assert.equal(cfg.dottedToEnv('storage.s3_endpoint'), 'KOLM_STORAGE_S3_ENDPOINT');
});

test('W888-J #6 — legacy ~/.kolm/config.json migrates to TOML on first load (file stays for back-compat)', async () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.kolm'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.kolm', 'config.json'),
    JSON.stringify({ base: 'https://kolm.ai', api_key: 'ks_legacy_2222' }, null, 2),
  );
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const cfg = await import(CFG_MOD_URL + '?w888j6=' + Date.now());

    const merged = await cfg.loadConfig({ env: { HOME: home, USERPROFILE: home } });
    assert.equal(merged.account.api_key, 'ks_legacy_2222',
      'legacy api_key must be migrated into account.api_key');
    assert.ok(fs.existsSync(path.join(home, '.kolm', 'config.toml')),
      'migration must write the TOML file');
    assert.ok(fs.existsSync(path.join(home, '.kolm', 'config.json')),
      'legacy JSON file MUST NOT be deleted (back-compat with older CLIs)');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('W888-J #7 — unsetConfig removes a key and is idempotent on missing keys', async () => {
  const home = freshHome();
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const cfg = await import(CFG_MOD_URL + '?w888j7=' + Date.now());

    await cfg.saveConfig('gateway.default_provider', 'anthropic', { scope: 'user' });
    const r1 = await cfg.unsetConfig('gateway.default_provider', { scope: 'user' });
    assert.equal(r1.ok, true, 'first unset must succeed');

    const merged = await cfg.loadConfig({ env: { HOME: home, USERPROFILE: home } });
    assert.equal(merged.gateway.default_provider, 'openai',
      'after unset, the default must take effect again');

    // Idempotent — a second unset returns ok:false with reason not_set, never throws.
    const r2 = await cfg.unsetConfig('gateway.default_provider', { scope: 'user' });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'not_set');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('W888-J #8 — minimal TOML parser round-trips strings, numbers, bools, arrays, sections', async () => {
  const cfg = await import(CFG_MOD_URL + '?w888j8=' + Date.now());

  const tree = {
    gateway: {
      default_provider: 'openai',
      capture_rate: 0.5,
    },
    telemetry: { enabled: true },
    compile: { teacher_council: ['claude-opus-4', 'gpt-5'] },
  };
  const text = cfg.stringifyTomlMinimal(tree);
  const parsed = cfg.parseTomlMinimal(text);
  assert.equal(parsed.gateway.default_provider, 'openai');
  assert.equal(parsed.gateway.capture_rate, 0.5);
  assert.equal(parsed.telemetry.enabled, true);
  assert.deepEqual(parsed.compile.teacher_council, ['claude-opus-4', 'gpt-5']);
});

// ---------------------------------------------------------------------------
// CLI-LEVEL TESTS — exercise `kolm config <verb>` via spawnSync.
// ---------------------------------------------------------------------------

test('W888-J #9 — `kolm config set` writes user TOML; `kolm config get` reads it back', () => {
  const home = freshHome();
  try {
    const setR = runCli(['config', 'set', 'gateway.default_provider', 'anthropic'], home);
    assert.equal(setR.status, 0, 'set must exit 0; stderr=' + setR.stderr);
    assert.ok(fs.existsSync(path.join(home, '.kolm', 'config.toml')),
      'set must write ~/.kolm/config.toml');

    const getR = runCli(['config', 'get', 'gateway.default_provider'], home);
    assert.equal(getR.status, 0, 'get must exit 0; stderr=' + getR.stderr);
    assert.match(getR.stdout, /anthropic/, 'get must print the value');
    assert.match(getR.stderr, /\(source:\s*user\)/, 'get must annotate source attribution');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('W888-J #10 — `kolm config list --json` includes source attribution per entry', () => {
  const home = freshHome();
  try {
    runCli(['config', 'set', 'serve.default_port', '9001'], home);
    const r = runCli(['config', 'list', '--json'], home);
    assert.equal(r.status, 0, 'list --json must exit 0');
    assert.ok(r.body, 'list --json must emit parseable JSON, got: ' + r.stdout.slice(0, 200));
    assert.ok(Array.isArray(r.body.entries), '.entries must be an array');
    const port = r.body.entries.find(e => e.key === 'serve.default_port');
    assert.ok(port, 'serve.default_port must appear in entries');
    assert.equal(port.source, 'user', 'port we set must have source=user');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('W888-J #11 — `kolm config list` redacts secrets unless --show-secrets is passed', () => {
  const home = freshHome();
  try {
    runCli(['config', 'set', 'account.api_key', 'ks_supersecret_1234567890abcdef'], home);
    // Redacted by default.
    const r1 = runCli(['config', 'list'], home);
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, /ks_sup\.\.\.cdef/, 'redacted secret should show 6-prefix...4-suffix');
    assert.doesNotMatch(r1.stdout, /1234567890ab/, 'middle bytes of secret MUST NOT leak');
    // Revealed with --show-secrets.
    const r2 = runCli(['config', 'list', '--show-secrets'], home);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /ks_supersecret_1234567890abcdef/,
      '--show-secrets must reveal the full value');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('W888-J #12 — legacy `kolm config show` keeps working (back-compat)', () => {
  const home = freshHome();
  try {
    const r = runCli(['config', 'show'], home);
    assert.equal(r.status, 0, 'legacy `config show` must still exit 0');
    assert.match(r.stdout, /base:/, 'show output must still include legacy `base:` line');
    assert.match(r.stdout, /logged_in:/, 'show output must still include `logged_in:` line');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('W888-J #13 — `kolm config unset` removes the key from user TOML', () => {
  const home = freshHome();
  try {
    runCli(['config', 'set', 'gateway.default_provider', 'anthropic'], home);
    const before = fs.readFileSync(path.join(home, '.kolm', 'config.toml'), 'utf-8');
    assert.match(before, /default_provider/, 'value must be written before unset');
    const r = runCli(['config', 'unset', 'gateway.default_provider'], home);
    assert.equal(r.status, 0, 'unset must exit 0');
    const after = fs.readFileSync(path.join(home, '.kolm', 'config.toml'), 'utf-8');
    assert.doesNotMatch(after, /default_provider/,
      'value must be removed from TOML after unset');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('W888-J #14 — env var override is visible to `kolm config get` and tagged source=env', () => {
  const home = freshHome();
  try {
    const r = runCli(
      ['config', 'get', 'gateway.default_provider'],
      home,
      { KOLM_GATEWAY_DEFAULT_PROVIDER: 'from-test-env' },
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /from-test-env/, 'env-driven value must surface via get');
    assert.match(r.stderr, /\(source:\s*env\)/, 'source line must mention env');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
