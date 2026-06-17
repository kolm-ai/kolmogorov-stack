// W657 - direct contract/security tests for src/device-adapters/local-adapter.js.
//
// The local device adapter is a filesystem + optional process-spawn boundary.
// It must keep installs under KOLM_DATA_DIR/installed, reject path-like device
// ids and invalid ports, and never report a runtime start without a PID.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { deploy } from '../src/device-adapters/local-adapter.js';

const TARGET = 'src/device-adapters/local-adapter.js';

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-local-adapter-w657-'));
  process.env.KOLM_DATA_DIR = path.join(dir, '.kolm');
  return dir;
}

function fakeArtifact(root, name = 'demo.kolm', body = 'local adapter bytes\n') {
  const p = path.join(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), `${target} must stay under ${root}`);
}

test('W657 local adapter rejects wrong device type, missing id, path ids, and invalid ports', async () => {
  assert.equal(TARGET, 'src/device-adapters/local-adapter.js');
  const tmp = freshDir();
  const artifact = fakeArtifact(tmp);

  const wrongType = await deploy({ id: 'local-1', type: 'ssh' }, artifact, { startProcess: false });
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.message, /device\.type/);

  const missingId = await deploy({ type: 'local' }, artifact, { startProcess: false });
  assert.equal(missingId.ok, false);
  assert.match(missingId.message, /safe device\.id/);

  const traversal = await deploy({ id: '../outside', type: 'local' }, artifact, { startProcess: false });
  assert.equal(traversal.ok, false);
  assert.match(traversal.message, /safe device\.id/);

  const badPort = await deploy({ id: 'local-1', type: 'local' }, artifact, { port: 0 });
  assert.equal(badPort.ok, false);
  assert.match(badPort.message, /port must be an integer/);
});

test('W657 local adapter copies only inside installed root and records artifact hash', async () => {
  const tmp = freshDir();
  const artifact = fakeArtifact(tmp, 'safe-artifact.kolm', 'hash me\n');
  const installedRoot = path.join(process.env.KOLM_DATA_DIR, 'installed');

  const out = await deploy({ id: 'local-device_1', type: 'local' }, artifact, {
    startProcess: false,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  const copyStep = out.raw.steps.find((s) => s.step === 'copy');
  assert.ok(copyStep, 'copy step must be recorded');
  assertInside(installedRoot, copyStep.dest);
  assert.equal(fs.readFileSync(copyStep.dest, 'utf8'), 'hash me\n');
  assert.equal(copyStep.sha256, sha256File(artifact));
});

test('W657 local adapter dry-run never writes the install copy', async () => {
  const tmp = freshDir();
  const artifact = fakeArtifact(tmp);

  const out = await deploy({ id: 'dry-local', type: 'local' }, artifact, {
    dryRun: true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.raw.steps[0].step, 'dry_run');
  const expected = path.join(process.env.KOLM_DATA_DIR, 'installed', 'dry-local', 'demo.kolm');
  assert.equal(fs.existsSync(expected), false);
});

test('W657 local adapter spawn is injectable and binds llama.cpp to loopback', async () => {
  const tmp = freshDir();
  const artifact = fakeArtifact(tmp);
  const calls = [];
  const spawnImpl = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return {
      pid: 12345,
      once() { return this; },
      unref() { calls.push({ unref: true }); },
    };
  };

  const out = await deploy({ id: 'spawn-local', type: 'local' }, artifact, {
    runtime: 'llama.cpp',
    port: 9090,
    spawnImpl,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(calls[0].cmd, 'llama-server');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-m', path.join(process.env.KOLM_DATA_DIR, 'installed', 'spawn-local', 'demo.kolm')]);
  assert.deepEqual(calls[0].args.slice(2), ['--port', '9090', '--host', '127.0.0.1']);
  assert.equal(calls[0].options.detached, true);
  assert.ok(out.raw.steps.some((s) => s.step === 'start' && s.ok === true && s.pid === 12345));
});

test('W657 local adapter treats spawn without pid as non-fatal install-only result', async () => {
  const tmp = freshDir();
  const artifact = fakeArtifact(tmp);
  const spawnImpl = () => ({
    pid: undefined,
    once() { return this; },
    unref() { throw new Error('must not unref without pid'); },
  });

  const out = await deploy({ id: 'pidless-local', type: 'local' }, artifact, {
    spawnImpl,
  });
  assert.equal(out.ok, true, 'copy is still successful even when runtime spawn cannot start');
  assert.match(out.message, /runtime spawn failed: no pid/);
  assert.ok(out.raw.steps.some((s) => s.step === 'copy' && s.ok === true));
  assert.ok(out.raw.steps.some((s) => s.step === 'start' && s.ok === false && s.error === 'spawn_no_pid'));
});
