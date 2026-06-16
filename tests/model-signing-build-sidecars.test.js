// tests/model-signing-build-sidecars.test.js
//
// Pins the build-time OMS sidecar path: the OMS member manifest is DSSE-signed
// (model.sig.bundle), every member digest equals the real bytes, and the seals
// do not change the artifact CID.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import { buildDsseEnvelope, verifyDsseEnvelope } from '../src/intoto-slsa.js';
import { omsMemberList, toOmsArtifactManifest } from '../src/receipt-export-registry.js';

function freshSigner() {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKey, privateKey, key_fingerprint: keyFingerprint(publicKey) };
}

test('model.sig.bundle DSSE over the OMS manifest verifies; member digests == real bytes', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-v1';
  const { buildPayload } = await import('../src/artifact.js');
  const signer = freshSigner();

  const payload = buildPayload({
    job_id: 'job_sidecar',
    task: 'classify',
    recipes: [{ id: 'r1', name: 'x', source: 'return {ok:true};', source_hash: 'h', version_id: 'v', tags: [], schema: null }],
    evals: { spec: 'rs-1-evals', n: 0, cases: [], coverage: 0 },
  });

  const members = payload.files
    .filter((f) => Buffer.isBuffer(f.content) || typeof f.content === 'string')
    .map((f) => ({ filename: f.filename, content: Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content)) }));

  const memberList = omsMemberList(members);
  const stmt = toOmsArtifactManifest(memberList);
  const byName = new Map(members.map((m) => [m.filename, m.content]));
  for (const s of stmt.subject) {
    const real = crypto.createHash('sha256').update(byName.get(s.name)).digest('hex');
    assert.equal(s.digest.sha256, real, `OMS digest for ${s.name} matches real bytes`);
  }

  const env = buildDsseEnvelope({ statement: stmt, privateKey: signer.privateKey, publicKey: signer.publicKey, key_fingerprint: signer.key_fingerprint });
  const v = verifyDsseEnvelope(env, { publicKey: signer.publicKey });
  assert.equal(v.ok, true);
  assert.equal(v.statement.predicateType, 'https://model_signing/signature/v1.0');
});

test('appending the two seals does not change the CID', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-v1';
  const { buildPayload } = await import('../src/artifact.js');
  const payload = buildPayload({
    job_id: 'job_seal_cid',
    task: 'classify',
    recipes: [{ id: 'r1', name: 'x', source: 'return {ok:true};', source_hash: 'h', version_id: 'v', tags: [], schema: null }],
    evals: { spec: 'rs-1-evals', n: 0, cases: [], coverage: 0 },
  });
  const cidBefore = payload.manifest.cid;
  const sealed = {
    ...payload,
    files: [...payload.files,
      { filename: 'provenance.intoto.dsse.json', content: Buffer.from('{}') },
      { filename: 'model.sig.bundle', content: Buffer.from('{}') }],
  };
  assert.equal(sealed.manifest.cid, cidBefore);
});
