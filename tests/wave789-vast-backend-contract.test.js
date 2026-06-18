// W789 - direct contract test for src/compute/backends/vast.js.
//
// This pins the Vast.ai compute backend atom: secret-safe detect output,
// redacted provider errors, bounded instance listings, safe host/port filters,
// shell-quoted SSH handles, and direct depth verification.

import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VAST_BACKEND_CONTRACT_VERSION,
  VAST_BACKEND_LIMITS,
  detect,
  run,
} from '../src/compute/backends/vast.js';

function read(rel) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function withEnv(vars, fn) {
  const old = {};
  for (const [key, value] of Object.entries(vars)) {
    old[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(old)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function instancesText(rows) {
  return JSON.stringify({ instances: rows });
}

test('W789 vast backend is wired into direct depth verification', () => {
  const pkg = readJson('package.json');
  const source = read('src/compute/backends/vast.js');

  assert.equal(VAST_BACKEND_CONTRACT_VERSION, 'w789-vast-backend-v1');
  assert.equal(VAST_BACKEND_LIMITS.max_instances, 200);
  assert.equal(VAST_BACKEND_LIMITS.max_command_args, 64);
  assert.equal(Object.isFrozen(VAST_BACKEND_LIMITS), true);
  assert.equal(
    pkg.scripts['verify:vast-backend'],
    'node --test --test-concurrency=1 tests/wave789-vast-backend-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:fal-backend && npm run verify:vast-backend && npm run verify:browser-extension-popup && npm run verify:langchain-package-manifest && npm run verify:llamaindex-package-manifest && npm run verify:runtime-rs-build-scripts && npm run verify:runtime-rs-wasm-example && npm run verify:distribution-manifests && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.match(source, /VAST_BACKEND_CONTRACT_VERSION/);
  assert.match(source, /_safeHost/);
  assert.match(source, /_safePort/);
  assert.match(source, /_quoteArg/);
  assert.match(source, /_providerFailure/);
  assert.match(source, /secret_values_included: false/);
});

test('W789 detect does not expose raw local SSH key paths', async () => {
  await withEnv({
    KOLM_VAST_TOKEN: null,
    VAST_API_KEY: null,
    KOLM_VAST_SSH_KEY: null,
  }, async () => {
    const missingToken = await detect();
    assert.equal(missingToken.available, false);
    assert.equal(missingToken.reason, 'KOLM_VAST_TOKEN env var not set');
    assert.equal(missingToken.secret_values_included, false);
  });

  await withEnv({
    KOLM_VAST_TOKEN: 'test-vast-token',
    KOLM_VAST_SSH_KEY: 'C:/Users/private/alice/.ssh/id_ed25519',
  }, async () => {
    const missingKey = await detect();
    const json = JSON.stringify(missingKey);
    assert.equal(missingKey.available, false);
    assert.equal(missingKey.reason, 'SSH key not found');
    assert.match(missingKey.ssh_key_sha256, /^[a-f0-9]{64}$/);
    assert.equal(missingKey.secret_values_included, false);
    assert.doesNotMatch(json, /alice|id_ed25519|C:\\/);
  });
});

test('W789 list mode sends token only in request path and returns bounded public handle', async () => {
  await withEnv({ KOLM_VAST_TOKEN: 'test-vast-token' }, async () => {
    const calls = [];
    const text = instancesText([{ id: 1, actual_status: 'running', ssh_host: '203.0.113.10', ssh_port: 2222 }]);
    const out = await run({
      request: async (method, pathname, headers) => {
        calls.push({ method, pathname, headers });
        return { status: 200, text };
      },
      now: () => 1000,
    });

    assert.equal(out.ok, true);
    assert.equal(out.contract_version, VAST_BACKEND_CONTRACT_VERSION);
    assert.equal(out.mode, 'list-instances');
    assert.equal(out.artifact_url, 'https://console.vast.ai/api/v0/instances');
    assert.equal(out.secret_values_included, false);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].pathname, '/api/v0/instances?api_key=test-vast-token');
    assert.equal(calls[0].headers['Content-Type'], 'application/json');
    assert.equal(JSON.stringify(out).includes('test-vast-token'), false);
  });
});

test('W789 command mode filters unsafe provider hosts and shell-quotes user command args', async () => {
  await withEnv({ KOLM_VAST_TOKEN: 'test-vast-token' }, async () => {
    const rows = [
      { id: 'ok', actual_status: 'running', ssh_host: '203.0.113.10', ssh_port: 2222 },
      { id: 'bad-host', actual_status: 'running', ssh_host: 'bad;rm -rf', ssh_port: 2223 },
      { id: 'bad-port', actual_status: 'running', ssh_host: '198.51.100.5', ssh_port: 70000 },
      { id: 'stopped', actual_status: 'stopped', ssh_host: '198.51.100.6', ssh_port: 22 },
    ];
    const out = await run({
      command: ['echo', "hello'; rm -rf /"],
      request: async () => ({ status: 200, text: instancesText(rows) }),
      now: () => 1000,
    });

    assert.equal(out.ok, true);
    assert.equal(out.mode, 'ssh-handles');
    assert.equal(out.instance_count, 4);
    assert.equal(out.ssh_handle_count, 1);
    assert.match(out.stdout, /^ssh -p 2222 root@203\.0\.113\.10 /);
    assert.match(out.stdout, /'echo'/);
    assert.match(out.stdout, /'hello'"'"'; rm -rf \/'/);
    assert.doesNotMatch(out.stdout, /bad;rm|198\.51\.100\.5|198\.51\.100\.6/);
  });
});

test('W789 provider failures and bad JSON are redacted and hash-backed', async () => {
  await withEnv({ KOLM_VAST_TOKEN: 'test-vast-token' }, async () => {
    const providerError = await run({
      request: async () => ({
        status: 500,
        text: 'api_key=supersecret customer@example.com failed',
      }),
    });
    const json = JSON.stringify(providerError);

    assert.equal(providerError.ok, false);
    assert.equal(providerError.reason, 'vast 500');
    assert.match(providerError.stderr, /api_key=\[redacted\]/);
    assert.match(providerError.error_sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(json, /supersecret|customer@example\.com|test-vast-token/);

    const badJson = await run({
      command: ['uptime'],
      request: async () => ({ status: 200, text: 'not json token=supersecret' }),
    });
    assert.equal(badJson.ok, false);
    assert.equal(badJson.reason, 'vast instances response was not JSON');
    assert.match(badJson.error_sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(badJson), /supersecret/);
  });
});
