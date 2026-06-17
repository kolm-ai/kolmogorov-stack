// W649 - direct contract/security test for src/device-daemon.js.
//
// The device daemon is the edge update boundary: it polls for a signed model
// version, downloads bytes, and must refuse to install anything that fails
// offline sha256 + Ed25519 verification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import {
  applyUpdate,
  compareSemver,
  pollOnce,
  runDaemon,
  sha256File,
  signingPayload,
  verifyLocal,
} from '../src/device-daemon.js';

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w649-${name}-`));
}

function keypair() {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function signPayload(privateKey, payload) {
  return cryptoSign(null, Buffer.from(payload), privateKey).toString('base64url');
}

function signedManifest({ privateKey, modelId = 'edge-classifier', version = '1.2.0', sha256 }) {
  const unsigned = {
    model_id: modelId,
    version,
    sha256,
    created_at: '2026-06-18T00:00:00.000Z',
  };
  const signature = signPayload(privateKey, signingPayload({ manifest: unsigned }));
  return { ...unsigned, signature, signed_url: 'https://updates.example/artifact.kolm' };
}

function responseBytes(bytes) {
  const buf = Buffer.from(bytes);
  return {
    ok: true,
    status: 200,
    body: null,
    arrayBuffer: async () => buf,
  };
}

test('W649 device-daemon verifyLocal accepts signed manifests and rejects tampered artifacts', async () => {
  const dir = tmpDir('verify');
  try {
    const artifactPath = path.join(dir, 'model.kolm');
    fs.writeFileSync(artifactPath, 'verified edge model bytes', 'utf8');
    const sha256 = await sha256File(artifactPath);
    const { publicKey, privateKey } = keypair();
    const manifest = signedManifest({ privateKey, sha256 });

    const ok = await verifyLocal({
      artifact_path: artifactPath,
      manifest,
      pubkey: publicKey,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.sha256, sha256);

    fs.writeFileSync(artifactPath, 'tampered bytes', 'utf8');
    const badHash = await verifyLocal({
      artifact_path: artifactPath,
      manifest,
      pubkey: publicKey,
    });
    assert.equal(badHash.ok, false);
    assert.match(badHash.reason, /sha256 mismatch/);

    fs.writeFileSync(artifactPath, 'verified edge model bytes', 'utf8');
    const wrongKey = keypair();
    const badSig = await verifyLocal({
      artifact_path: artifactPath,
      manifest,
      pubkey: wrongKey.publicKey,
    });
    assert.equal(badSig.ok, false);
    assert.equal(badSig.reason, 'ed25519 signature verification failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W649 device-daemon applyUpdate installs only after offline verification', async () => {
  const dir = tmpDir('apply');
  try {
    const destPath = path.join(dir, 'live-model.kolm');
    fs.writeFileSync(destPath, 'old model', 'utf8');
    const updateBytes = Buffer.from('new verified model', 'utf8');
    const stagingPath = path.join(dir, 'staged.kolm');
    fs.writeFileSync(stagingPath, updateBytes);
    const sha256 = await sha256File(stagingPath);
    fs.rmSync(stagingPath, { force: true });

    const { publicKey, privateKey } = keypair();
    const manifest = signedManifest({ privateKey, sha256 });
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url: String(url), headers: opts.headers || {} });
      return responseBytes(updateBytes);
    };

    const applied = await applyUpdate({
      signed_url: manifest.signed_url,
      manifest,
      pubkey: publicKey,
      dest_path: destPath,
      fetchImpl,
      apiKey: 'ks_device',
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.sha256, sha256);
    assert.equal(fs.readFileSync(destPath, 'utf8'), 'new verified model');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, manifest.signed_url);
    assert.equal(calls[0].headers.Authorization, 'Bearer ks_device');

    fs.writeFileSync(destPath, 'old model restored', 'utf8');
    const forged = { ...manifest, signature: signPayload(keypair().privateKey, signingPayload({ manifest })) };
    await assert.rejects(
      () => applyUpdate({
        signed_url: manifest.signed_url,
        manifest: forged,
        pubkey: publicKey,
        dest_path: destPath,
        fetchImpl,
      }),
      /unverified artifact/,
    );
    assert.equal(fs.readFileSync(destPath, 'utf8'), 'old model restored');
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.kolm-update-'));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W649 device-daemon polling picks the newest semver update and stays on the gateway endpoint', async () => {
  assert.equal(compareSemver('1.2.0-rc1', '1.2.0'), -1);
  assert.equal(compareSemver('2.11', '2.10.9'), 1);

  const seenUrls = [];
  const fetchImpl = async (url, opts) => {
    seenUrls.push(String(url));
    assert.equal(opts.headers.Authorization, 'Bearer ks_edge');
    assert.equal(opts.headers.Accept, 'application/json');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        versions: [
          { version: '1.1.0', signed_url: 'https://updates.example/old.kolm' },
          { version: '1.2.0-rc1', signed_url: 'https://updates.example/rc.kolm' },
          { version: '1.2.0', signed_url: 'https://updates.example/final.kolm' },
        ],
      }),
    };
  };

  const one = await pollOnce({
    base: 'https://gateway.example/',
    apiKey: 'ks_edge',
    model_id: 'edge/model',
    current_version: '1.1.5',
    fetchImpl,
  });
  assert.equal(one.latest, '1.2.0');
  assert.equal(one.update.signed_url, 'https://updates.example/final.kolm');
  assert.deepEqual(seenUrls, ['https://gateway.example/v1/models/edge%2Fmodel/updates']);

  let daemonUpdate = null;
  const ctrl = runDaemon({
    base: 'https://gateway.example/',
    apiKey: 'ks_edge',
    model_id: 'edge/model',
    current_version: '1.1.5',
    interval_ms: 60 * 60 * 1000,
    immediate: false,
    fetchImpl,
    on_update: async (manifest, helpers) => {
      daemonUpdate = { manifest, current_version: helpers.current_version };
      assert.equal(typeof helpers.applyUpdate, 'function');
    },
  });
  try {
    await ctrl.poll();
    assert.equal(daemonUpdate.manifest.version, '1.2.0');
    assert.equal(daemonUpdate.current_version, '1.1.5');
  } finally {
    ctrl.stop();
  }
});
