#!/usr/bin/env node
// W890-7 — hierarchy resolver end-to-end trace.
// Verifies: flag > env > user TOML > project TOML > defaults.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_URL = 'file:///' + path.join(ROOT, 'src/config.js').split(path.sep).join('/');

async function main() {
  // Set up a fixture filesystem with a project kolm.toml + a fake user TOML.
  const tmp = path.join(os.tmpdir(), 'w890-7-hierarchy-' + Date.now());
  const homeDir = path.join(tmp, 'home');
  const projectDir = path.join(tmp, 'project');
  const emptyDir = path.join(tmp, 'empty');
  fs.mkdirSync(path.join(homeDir, '.kolm'), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(emptyDir, { recursive: true });

  fs.writeFileSync(path.join(projectDir, 'kolm.toml'),
    '[gateway]\ndefault_provider = "project_value"\npii_mode = "hash"\n');

  const userTomlPath = path.join(homeDir, '.kolm', 'config.toml');

  // Override HOME before any import so USER_TOML_PATH binds to our fake dir.
  const origHome = process.env.HOME;
  const origUserprof = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  // Trace key: gateway.default_provider
  const traces = [];

  // Layer 1: defaults only — empty env + dir with no project TOML + no user TOML.
  const m1 = await import(CONFIG_URL + '?reload=1');
  const t0 = await m1.loadConfig({ flags: {}, env: {}, cwd: emptyDir });
  traces.push({
    layer: 'defaults',
    key: 'gateway.default_provider',
    value: t0.gateway.default_provider,
    source: t0._sources['gateway.default_provider'],
    expected_source: 'default',
    expected_value: 'openai',
    pass: t0._sources['gateway.default_provider'] === 'default' && t0.gateway.default_provider === 'openai',
  });

  // Layer 2: project TOML wins over defaults.
  const t1 = await m1.loadConfig({ flags: {}, env: {}, cwd: projectDir });
  traces.push({
    layer: 'project',
    key: 'gateway.default_provider',
    value: t1.gateway.default_provider,
    source: t1._sources['gateway.default_provider'],
    expected_source: 'project',
    expected_value: 'project_value',
    pass: t1._sources['gateway.default_provider'] === 'project' && t1.gateway.default_provider === 'project_value',
  });

  // Layer 3: user TOML wins over project.
  fs.writeFileSync(userTomlPath, '[gateway]\ndefault_provider = "user_value"\n');
  const m2 = await import(CONFIG_URL + '?reload=2');
  const t2 = await m2.loadConfig({ flags: {}, env: {}, cwd: projectDir });
  traces.push({
    layer: 'user',
    key: 'gateway.default_provider',
    value: t2.gateway.default_provider,
    source: t2._sources['gateway.default_provider'],
    expected_source: 'user',
    expected_value: 'user_value',
    pass: t2._sources['gateway.default_provider'] === 'user' && t2.gateway.default_provider === 'user_value',
  });

  // Layer 4: env wins over user.
  const t3 = await m2.loadConfig({ flags: {}, env: { KOLM_GATEWAY_DEFAULT_PROVIDER: 'env_value' }, cwd: projectDir });
  traces.push({
    layer: 'env',
    key: 'gateway.default_provider',
    value: t3.gateway.default_provider,
    source: t3._sources['gateway.default_provider'],
    expected_source: 'env',
    expected_value: 'env_value',
    pass: t3._sources['gateway.default_provider'] === 'env' && t3.gateway.default_provider === 'env_value',
  });

  // Layer 5: flag wins over env.
  const t4 = await m2.loadConfig({
    flags: { 'gateway.default_provider': 'flag_value' },
    env: { KOLM_GATEWAY_DEFAULT_PROVIDER: 'env_value' },
    cwd: projectDir,
  });
  traces.push({
    layer: 'flag',
    key: 'gateway.default_provider',
    value: t4.gateway.default_provider,
    source: t4._sources['gateway.default_provider'],
    expected_source: 'flag',
    expected_value: 'flag_value',
    pass: t4._sources['gateway.default_provider'] === 'flag' && t4.gateway.default_provider === 'flag_value',
  });

  // Second-key trace: storage.type — env should win over user.
  fs.writeFileSync(userTomlPath, '[storage]\ntype = "postgres"\n');
  const m3 = await import(CONFIG_URL + '?reload=3');
  const ts = await m3.loadConfig({ flags: {}, env: { KOLM_STORAGE_TYPE: 's3' }, cwd: projectDir });
  traces.push({
    layer: 'env-wins-secondary-key',
    key: 'storage.type',
    value: ts.storage.type,
    source: ts._sources['storage.type'],
    expected_source: 'env',
    expected_value: 's3',
    pass: ts._sources['storage.type'] === 'env' && ts.storage.type === 's3',
  });

  // Restore real HOME
  process.env.HOME = origHome;
  process.env.USERPROFILE = origUserprof;

  const allPass = traces.every(t => t.pass);
  const result = {
    generated_at: new Date().toISOString(),
    description: 'End-to-end trace of the config hierarchy resolver (src/config.js loadConfig). ' +
                 'Confirms: flag > env > user TOML > project TOML > defaults. ' +
                 'Each row sets up the higher layers and asserts both value and _sources label match.',
    order: ['flag', 'env', 'user (~/.kolm/config.toml)', 'project (./kolm.toml)', 'default'],
    primary_key_traced: 'gateway.default_provider',
    secondary_key_traced: 'storage.type',
    traces,
    pass: allPass,
  };
  fs.writeFileSync(path.join(ROOT, 'data/w890-7-hierarchy.json'), JSON.stringify(result, null, 2));
  console.log('hierarchy trace pass:', allPass, '| layers:', traces.map(t => t.layer).join(','));
  if (!allPass) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
