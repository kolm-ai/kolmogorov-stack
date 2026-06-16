// tests/nras-verifier.test.js
//
// Unit coverage for src/nras-verifier.js (JS shim) + the env-gate/binding
// contract. The Python worker (workers/nras_verifier.py) is exercised end-to-end
// only when python3 + cryptography + PyJWT are available; otherwise that case is
// skipped (the JS-level contracts still run).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  nonceBinding,
  makeNrasVerifier,
  registerNrasVerifier,
  NRAS_REPLAY_TTL_MS,
  NRAS_VERIFIER_SPEC,
} from '../src/nras-verifier.js';
import {
  verifyAttestation,
  listRegisteredVerifiers,
  clearAttestationVerifier,
  STATES,
} from '../src/confidential-compute.js';

const __filenameTest = fileURLToPath(import.meta.url);

test('nonceBinding = sha256(input_digest||output_digest) over raw bytes', () => {
  const a = crypto.createHash('sha256').update('A').digest('hex');
  const b = crypto.createHash('sha256').update('B').digest('hex');
  const expect = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')])).digest('hex');
  assert.equal(nonceBinding(a, b), expect);
  assert.match(nonceBinding(a, b), /^[0-9a-f]{64}$/);
});

test('env-gate OFF: registration is a no-op, attestation stays shape-only', async () => {
  delete process.env.KOLM_NRAS_VERIFIER;
  clearAttestationVerifier('nras');
  const r = registerNrasVerifier({ gate: undefined });
  assert.equal(r.registered, false);
  assert.ok(!listRegisteredVerifiers().includes('nras'));

  const report = {
    gpu_id: 'GPU-x', driver_version: '550', vbios_version: '96',
    attestation_report: 'ZmFrZQ==', cert_chain: ['-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----'], nonce: 'ab',
  };
  const st = await verifyAttestation('nras', report);
  assert.equal(st.verified, false);
  assert.equal(st.state, STATES.SHAPE_OK);
});

test('env-gate ON + missing root cert: LOUD throw with install hint', () => {
  const missing = path.join(os.tmpdir(), 'nras-missing-' + crypto.randomBytes(4).toString('hex') + '.pem');
  assert.throws(
    () => registerNrasVerifier({ gate: '1', rootCert: missing }),
    /KOLM_NRAS_VERIFIER=1 but the NVIDIA NRAS root cert is missing/,
  );
});

test('verifier fn refuses without digests (cannot compute nonce-binding)', async () => {
  const fn = makeNrasVerifier({ rootCert: __filenameTest });
  const r = await fn({ attestation_report: 'x' }, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing_input_or_output_digest/);
});

test('verifier fn never returns ok:true for an unverifiable token', async () => {
  const fn = makeNrasVerifier({ rootCert: __filenameTest });
  const inDig = crypto.createHash('sha256').update('in').digest('hex');
  const outDig = crypto.createHash('sha256').update('out').digest('hex');
  const r = await fn({ attestation_report: 'garbage', eat_nonce: 'wrong' }, { input_digest: inDig, output_digest: outDig });
  assert.equal(r.ok, false, 'unverifiable token -> ok:false (no fake pass)');
});

test('spec constants', () => {
  assert.equal(NRAS_REPLAY_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(NRAS_VERIFIER_SPEC.binding, 'sha256(input_digest||output_digest)');
});

// --- End-to-end Python worker: nonce-binding + replay-TTL, only when deps present. ---
function pythonHasDeps() {
  const py = process.env.KOLM_PYTHON || process.env.PYTHON || 'python3';
  const res = spawnSync(py, ['-c', 'import jwt, cryptography'], { encoding: 'utf8', timeout: 15000 });
  return res.status === 0;
}

test('worker enforces nonce-binding + 24h replay TTL (when python deps present)', { skip: !pythonHasDeps() ? 'python3 + PyJWT + cryptography not available' : false }, () => {
  const py = process.env.KOLM_PYTHON || process.env.PYTHON || 'python3';
  const worker = path.resolve(path.dirname(__filenameTest), '..', 'workers', 'nras_verifier.py');

  // Build a real self-signed root + leaf cert chain and a real RS256 EAT/JWT in
  // Python (the worker validates it). We do the whole construction inline.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nras-e2e-'));
  const rootPem = path.join(tmp, 'root.pem');
  const inDig = crypto.createHash('sha256').update('IN').digest('hex');
  const outDig = crypto.createHash('sha256').update('OUT').digest('hex');
  const expected = nonceBinding(inDig, outDig);

  const gen = spawnSync(py, ['-c', `
import sys, json, datetime, base64
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import jwt

now = datetime.datetime.now(datetime.timezone.utc)
def mkkey(): return rsa.generate_private_key(public_exponent=65537, key_size=2048)
rootk = mkkey(); leafk = mkkey()
rname = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, u'NVIDIA Root')])
lname = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, u'NVIDIA Leaf')])
root = (x509.CertificateBuilder().subject_name(rname).issuer_name(rname)
        .public_key(rootk.public_key()).serial_number(1)
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365))
        .sign(rootk, hashes.SHA256()))
leaf = (x509.CertificateBuilder().subject_name(lname).issuer_name(rname)
        .public_key(leafk.public_key()).serial_number(2)
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365))
        .sign(rootk, hashes.SHA256()))
root_pem = root.public_bytes(serialization.Encoding.PEM)
leaf_pem = leaf.public_bytes(serialization.Encoding.PEM)
open(${JSON.stringify(rootPem)}, 'wb').write(root_pem)
leaf_priv = leafk.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
import time
iat = int(time.time())
def mktoken(nonce, iat_val):
    return jwt.encode({'eat_nonce': nonce, 'iat': iat_val, 'x-nvidia-overall-att-result': True}, leaf_priv, algorithm='RS256')
good = mktoken(${JSON.stringify(expected)}, iat)
bad_nonce = mktoken('00'*32, iat)
old = mktoken(${JSON.stringify(expected)}, iat - 90000)  # 25h old
print(json.dumps({'leaf_pem': leaf_pem.decode(), 'good': good, 'bad_nonce': bad_nonce, 'old': old}))
`], { encoding: 'utf8', timeout: 30000 });
  assert.equal(gen.status, 0, 'cert/jwt generation ok: ' + (gen.stderr || ''));
  const g = JSON.parse(gen.stdout);

  function runWorker(token) {
    const res = spawnSync(py, [worker, '--root-cert', rootPem], {
      input: JSON.stringify({
        attestation_report: token,
        cert_chain: [g.leaf_pem],
        expected_nonce: expected,
        replay_ttl_ms: NRAS_REPLAY_TTL_MS,
        now_ms: Date.now(),
      }),
      encoding: 'utf8', timeout: 30000,
    });
    return JSON.parse(res.stdout);
  }

  // Good token -> ok:true, nonce bound, chain reaches pinned root.
  const okRes = runWorker(g.good);
  assert.equal(okRes.ok, true, 'good token verifies: ' + JSON.stringify(okRes));
  assert.equal(okRes.verifier, 'nras');
  assert.equal(okRes.eat_nonce, expected);
  assert.ok(okRes.cert_chain_length >= 1);

  // Wrong nonce -> ok:false (nonce-binding enforced).
  assert.equal(runWorker(g.bad_nonce).ok, false, 'mismatched nonce rejected');

  // 25h-old token -> ok:false (replay TTL).
  const oldRes = runWorker(g.old);
  assert.equal(oldRes.ok, false, 'replayed token past 24h TTL rejected');
});
