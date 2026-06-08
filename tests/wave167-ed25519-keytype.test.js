// Wave 167 — Ed25519 key-type validation at load.
//
// SOTA-audit P0: crypto.createPrivateKey() accepts RSA/ECDSA/DSA PEMs, so a
// wrong-type signing/auditor key was silently accepted at load and only failed
// later with an opaque sign error. All four key loaders now assert
// asymmetricKeyType === 'ed25519' and throw a clear "ed25519 key required" error.
//
// Coverage:
//   1. loadSignerKeyFromEnv rejects an RSA private key (KOLM_ED25519_PRIVATE_KEY)
//   2. loadSignerKeyFromEnv accepts a real Ed25519 key
//   3. loadAuditorKeyFromEnv rejects an RSA private key
//   4. loadAuditorKeyFromEnv accepts a real Ed25519 key
//   5. loadAuditorKeyFromFile rejects an RSA private key on disk
//   6. loadAuditorKeyFromFile rejects an EC (P-256) private key on disk

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateKeyPair, loadSignerKeyFromEnv } from '../src/ed25519.js';
import { loadAuditorKeyFromEnv, loadAuditorKeyFromFile } from '../src/auditor-attestation.js';

function rsaPem() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey;
}
function ecPem() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey;
}

function withEnv(key, value, fn) {
  const prev = process.env[key];
  process.env[key] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
  }
}

test('1. loadSignerKeyFromEnv rejects an RSA private key', () => {
  withEnv('KOLM_ED25519_PRIVATE_KEY', rsaPem(), () => {
    assert.throws(() => loadSignerKeyFromEnv(), /ed25519 key required, got rsa/);
  });
});

test('2. loadSignerKeyFromEnv accepts a real Ed25519 key', () => {
  withEnv('KOLM_ED25519_PRIVATE_KEY', generateKeyPair().privateKey, () => {
    const signer = loadSignerKeyFromEnv();
    assert.ok(signer && signer.key_fingerprint, 'ed25519 key should load with a fingerprint');
  });
});

test('3. loadAuditorKeyFromEnv rejects an RSA private key', () => {
  withEnv('KOLM_AUDITOR_ED25519_PRIVATE_KEY', rsaPem(), () => {
    assert.throws(() => loadAuditorKeyFromEnv(), /ed25519 key required, got rsa/);
  });
});

test('4. loadAuditorKeyFromEnv accepts a real Ed25519 key', () => {
  withEnv('KOLM_AUDITOR_ED25519_PRIVATE_KEY', generateKeyPair().privateKey, () => {
    const k = loadAuditorKeyFromEnv();
    assert.ok(k && k.key_fingerprint, 'ed25519 auditor key should load with a fingerprint');
  });
});

test('5. loadAuditorKeyFromFile rejects an RSA private key on disk', () => {
  const p = path.join(os.tmpdir(), `kolm-keytype-rsa-${process.pid}.pem`);
  fs.writeFileSync(p, rsaPem());
  try {
    assert.throws(() => loadAuditorKeyFromFile(p), /ed25519 key required.*got rsa/);
  } finally { try { fs.unlinkSync(p); } catch {} }
});

test('6. loadAuditorKeyFromFile rejects an EC (P-256) private key on disk', () => {
  const p = path.join(os.tmpdir(), `kolm-keytype-ec-${process.pid}.pem`);
  fs.writeFileSync(p, ecPem());
  try {
    assert.throws(() => loadAuditorKeyFromFile(p), /ed25519 key required.*got ec/);
  } finally { try { fs.unlinkSync(p); } catch {} }
});
