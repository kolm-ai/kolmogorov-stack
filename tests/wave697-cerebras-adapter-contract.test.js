// W697 - direct contract/security tests for src/device-adapters/cerebras-adapter.js.
//
// The Cerebras device adapter is a provider/device boundary. It must bind a
// local artifact namespace to a Cerebras model without claiming train/upload
// support, reject unsafe operator input before provider initialization, redact
// provider errors, and stay discoverable through the registry, CLI smoke path,
// and platform readiness matrix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CEREBRAS_ADAPTER_CONTRACT_VERSION,
  deploy,
} from '../src/device-adapters/cerebras-adapter.js';
import { adapterFor, ADAPTER_TYPES } from '../src/device-adapters/index.js';
import { deviceCaps } from '../src/device-caps.js';
import { DeviceRegistry, DEVICE_TYPES_LIST } from '../src/device-registry.js';
import {
  detectCloudReadiness,
  listPlatformCapabilities,
  validatePlatformCapabilities,
} from '../src/platform-capabilities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const KOLM_CLI = path.join(REPO_ROOT, 'cli', 'kolm.js');
const TARGET = 'src/device-adapters/cerebras-adapter.js';

function freshDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w697-${label}-`));
}

function fakeArtifact(root, name = 'support-prod.kolm') {
  const p = path.join(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `W697 artifact fixture: ${name}\n`);
  return p;
}

async function withEnv(patch, fn) {
  const saved = new Map();
  for (const key of Object.keys(patch)) saved.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) delete process.env[key];
      else process.env[key] = String(value);
    }
    return await fn();
  } finally {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runCli(argv, extraEnv = {}) {
  const home = freshDir('cli-home');
  try {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      KOLM_API_KEY: '',
      CEREBRAS_API_KEY: '',
      KOLM_CEREBRAS_TOKEN: '',
      ...extraEnv,
    };
    const r = spawnSync(process.execPath, ['--no-warnings', KOLM_CLI, ...argv], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    let body = null;
    const out = (r.stdout || '').trim();
    if (out.startsWith('{') || out.startsWith('[')) body = JSON.parse(out);
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', body };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('W697 source and package verifier wiring pins the Cerebras adapter atom', () => {
  assert.equal(TARGET, 'src/device-adapters/cerebras-adapter.js');
  const src = fs.readFileSync(path.join(REPO_ROOT, TARGET), 'utf8');
  assert.match(src, /CEREBRAS_ADAPTER_CONTRACT_VERSION/);
  assert.match(src, /invalid_namespace/);
  assert.match(src, /adapter_contract_version/);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['verify:cerebras-adapter'],
    'node --test --test-concurrency=1 tests/wave697-cerebras-adapter-contract.test.js',
  );
  assert.match(pkg.scripts['verify:depth'], /verify:cerebras-adapter/);
});

test('W697 Cerebras adapter binds an artifact with proof metadata and shell-safe next actions', async () => {
  const root = freshDir('bind');
  const bindingsDir = path.join(root, 'bindings');
  const artifactPath = fakeArtifact(root);
  const now = '2026-06-18T00:00:00.000Z';
  try {
    await withEnv({
      CEREBRAS_API_KEY: 'csk_test_key_for_local_bind_only',
      KOLM_CEREBRAS_BINDINGS_DIR: bindingsDir,
      KOLM_CEREBRAS_URL: 'https://api.cerebras.ai/v1',
    }, async () => {
      const out = await deploy(
        { id: 'cer-1', type: 'cerebras', label: 'Cerebras Cloud' },
        artifactPath,
        {
          namespace: 'support-prod',
          model: 'llama3.1-8b',
          max_tokens: 512,
          temperature: 0.2,
          now_iso: now,
        },
      );
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.equal(out.adapter_contract_version, CEREBRAS_ADAPTER_CONTRACT_VERSION);
      assert.equal(out.provider, 'cerebras');
      assert.equal(out.namespace, 'support-prod');
      assert.equal(out.cerebras_model, 'llama3.1-8b');
      assert.equal(out.artifact_id, 'support-prod.kolm');
      assert.equal(out.deployed_at, now);
      assert.ok(fs.existsSync(out.binding_path), 'binding file must be written');

      const binding = JSON.parse(fs.readFileSync(out.binding_path, 'utf8'));
      assert.equal(binding.namespace, 'support-prod');
      assert.equal(binding.cerebras_model, 'llama3.1-8b');
      assert.equal(binding.max_tokens, 512);
      assert.equal(binding.temperature, 0.2);
      assert.equal(binding.metadata.deployed_at, now);
      assert.equal(binding.metadata.adapter_contract_version, CEREBRAS_ADAPTER_CONTRACT_VERSION);

      assert.equal(out.proof.adapter_contract_version, CEREBRAS_ADAPTER_CONTRACT_VERSION);
      assert.match(out.proof.manifest_sha256, /^[a-f0-9]{64}$/);
      assert.equal(out.proof.manifest.endpoint, 'https://api.cerebras.ai/v1/chat/completions');
      const commands = out.next_actions.map((a) => a.value).join('\n');
      assert.match(commands, /--namespace 'support-prod'/);
      assert.doesNotMatch(commands, /;|\$\(|`/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W697 Cerebras adapter rejects unsafe input and missing artifacts before provider initialization', async () => {
  const root = freshDir('fail-closed');
  const artifactPath = fakeArtifact(root, 'safe.kolm');
  try {
    const unsafe = await deploy(
      { id: 'cer-unsafe', type: 'cerebras' },
      artifactPath,
      { namespace: 'bad;rm-rf', model: 'llama3.1-8b' },
    );
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.error, 'invalid_namespace');
    assert.equal(unsafe.adapter_contract_version, CEREBRAS_ADAPTER_CONTRACT_VERSION);

    const wrongType = await deploy(
      { id: 'not-cerebras', type: 'ssh' },
      artifactPath,
      { namespace: 'support-prod', model: 'llama3.1-8b' },
    );
    assert.equal(wrongType.ok, false);
    assert.equal(wrongType.error, 'invalid_device_type');

    const missing = await deploy(
      { id: 'cer-missing', type: 'cerebras' },
      path.join(root, 'missing.kolm'),
      { namespace: 'support-prod', model: 'llama3.1-8b' },
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'artifact_not_found');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W697 Cerebras adapter redacts provider bind failures', async () => {
  const root = freshDir('redact');
  const artifactPath = fakeArtifact(root, 'redact.kolm');
  class FailingProvider {
    constructor() {
      this.baseUrl = 'https://api.cerebras.ai/v1';
    }
    async bindArtifact() {
      const err = new Error('upstream rejected Bearer csk-secret123456789 and CEREBRAS_API_KEY=csk-secret987654321');
      err.code = 'cerebras_bind_failed';
      err.install_hint = 'rotate CEREBRAS_API_KEY=csk-secret987654321';
      throw err;
    }
  }
  try {
    const out = await deploy(
      { id: 'cer-redact', type: 'cerebras' },
      artifactPath,
      { namespace: 'support-prod', model: 'llama3.1-8b', ProviderClass: FailingProvider },
    );
    assert.equal(out.ok, false);
    assert.equal(out.error, 'cerebras_bind_failed');
    const serialized = JSON.stringify(out);
    assert.doesNotMatch(serialized, /csk-secret/);
    assert.match(serialized, /\[redacted/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W697 Cerebras is reachable through registry, adapter index, and device probe surfaces', async () => {
  const root = freshDir('registry');
  try {
    assert.ok(DEVICE_TYPES_LIST.includes('cerebras'));
    assert.ok(ADAPTER_TYPES.includes('cerebras'));
    const adapter = await adapterFor('cerebras');
    assert.equal(adapter.deploy, deploy);

    const registry = new DeviceRegistry({ dataDir: root });
    const rec = await registry.register({ id: 'cer-1', type: 'cerebras', tags: ['cloud'] });
    assert.equal(rec.type, 'cerebras');
    assert.equal(rec.host, null);
    assert.equal(rec.port, null);

    const probe = await deviceCaps(rec);
    assert.equal(probe.ok, false);
    assert.equal(probe.error, 'probe_not_supported_for_type');
    assert.match(probe.hint, /HTTP\/API/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W697 platform readiness exposes Cerebras without claiming train/upload support', () => {
  const platform = validatePlatformCapabilities();
  assert.equal(platform.ok, true, JSON.stringify(platform.missing));

  const caps = listPlatformCapabilities();
  assert.ok(caps.model_framework_targets.some((row) => row.id === 'cerebras-cloud-inference'));
  assert.ok(caps.model_family_targets.some((row) => row.id === 'frontier-teacher-cerebras'));
  assert.ok(caps.device_targets.some((row) => row.id === 'cerebras-cloud-inference' && row.class === 'cloud-inference'));

  const cloud = detectCloudReadiness({ CEREBRAS_API_KEY: 'csk_test_key_for_readiness' });
  const row = cloud.providers.find((provider) => provider.id === 'cerebras-inference');
  assert.ok(row, 'cloud readiness must include cerebras-inference');
  assert.equal(row.category, 'teacher-provider');
  assert.equal(row.configured, true);
  assert.match(row.caveats.join(' '), /does not upload or train/i);
});

test('W697 CLI cloud smoke exposes provider:cerebras no-key and dry-run envelopes', () => {
  const noKey = runCli(['test', 'cloud', '--provider', 'cerebras', '--json']);
  assert.ok(noKey.body, noKey.stdout || noKey.stderr);
  assert.equal(noKey.body.ok, false);
  assert.equal(noKey.body.targets[0].target, 'provider:cerebras');
  assert.equal(noKey.body.targets[0].detail.mode, 'no-key');
  assert.match(noKey.body.targets[0].detail.docs_url, /cerebras/i);

  const dryRun = runCli(
    ['test', 'cloud', '--dry-run', '--provider', 'cerebras', '--json'],
    { CEREBRAS_API_KEY: 'csk_test_key_for_dry_run_only' },
  );
  assert.ok(dryRun.body, dryRun.stdout || dryRun.stderr);
  assert.equal(dryRun.body.targets[0].target, 'provider:cerebras');
  assert.equal(dryRun.body.targets[0].detail.mode, 'dry-run');
  assert.match(dryRun.body.targets[0].detail.would_do, /models/);
});
