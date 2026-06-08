// Wave 168 — two SOTA-audit hardening items:
//
//   A. transparency-log.js: a stand-alone, fully offline verifyInclusionProof()
//      that any browser/SDK can call to confirm an entry is in the log
//      committed by a signed checkpoint — without trusting kolm.
//   B. secrets-vault.js: write secret material with owner-only perms and VERIFY
//      the mode on POSIX (no more silent `catch {}` that could leave the vault
//      key world-readable).
//
// Coverage:
//   1. valid inclusion proof verifies offline
//   2. tampered leaf_hash is rejected
//   3. tampered audit_path is rejected
//   4. camelCase (merkle.js) proof shape is accepted
//   5. signed-checkpoint binding: matching STH verifies (incl. signature)
//   6. signed-checkpoint binding: root mismatch is rejected
//   7. malformed proof returns ok:false (never throws)
//   8. vault put/get/list/delete round-trips in an isolated data dir
//   9. on POSIX the vault key + json files are mode 0o600 (skipped on win32)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateKeyPair } from '../src/ed25519.js';
import {
  TransparencyLog,
  signTreeHead,
  verifyInclusionProof,
} from '../src/transparency-log.js';

function freshLog() {
  const log = new TransparencyLog({ origin: 'kolm.ai/test/v1' });
  for (let i = 0; i < 7; i++) log.append('event', { i, msg: `entry-${i}` });
  return log;
}

test('1. valid inclusion proof verifies offline', () => {
  const log = freshLog();
  const proof = log.inclusionProof(3);
  const res = verifyInclusionProof(proof);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.leaf_index, 3);
  assert.equal(res.tree_size, 7);
});

test('2. tampered leaf_hash is rejected', () => {
  const log = freshLog();
  const proof = log.inclusionProof(3);
  proof.leaf_hash = proof.leaf_hash.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
  const res = verifyInclusionProof(proof);
  assert.equal(res.ok, false);
});

test('3. tampered audit_path is rejected', () => {
  const log = freshLog();
  const proof = log.inclusionProof(5);
  proof.audit_path[0] = proof.audit_path[0].replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
  const res = verifyInclusionProof(proof);
  assert.equal(res.ok, false);
});

test('4. camelCase (merkle.js) proof shape is accepted', () => {
  const log = freshLog();
  const p = log.inclusionProof(2);
  const camel = {
    leafHash: p.leaf_hash,
    leafIndex: p.leaf_index,
    treeSize: p.tree_size,
    inclusionPath: p.audit_path,
    root: p.root_hash,
  };
  assert.equal(verifyInclusionProof(camel).ok, true);
});

test('5. signed-checkpoint binding: matching STH verifies including signature', () => {
  const log = freshLog();
  const signer = generateKeyPair();
  const sth = signTreeHead(log.treeHead(), signer);
  const proof = log.inclusionProof(4);
  const res = verifyInclusionProof(proof, { signedTreeHead: sth });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.checkpoint.verified, true);
});

test('6. signed-checkpoint binding: root mismatch is rejected', () => {
  const log = freshLog();
  const signer = generateKeyPair();
  const sth = signTreeHead(log.treeHead(), signer);
  const proof = log.inclusionProof(4);
  // Mutate the proof's root to something that won't match the signed head.
  proof.root_hash = '0'.repeat(64);
  const res = verifyInclusionProof(proof, { signedTreeHead: sth });
  assert.equal(res.ok, false);
});

test('7. malformed proof returns ok:false (never throws)', () => {
  assert.equal(verifyInclusionProof(null).ok, false);
  assert.equal(verifyInclusionProof({}).ok, false);
  assert.equal(verifyInclusionProof({ ok: false, reason: 'x' }).ok, false);
  assert.equal(verifyInclusionProof({ leaf_hash: 'aa', root_hash: 'bb', audit_path: 'notarray' }).ok, false);
});

test('8/9. vault round-trips and (POSIX) files are 0o600', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-vault-w168-'));
  const prev = process.env.KOLM_DATA_DIR;
  process.env.KOLM_DATA_DIR = dir;
  // Import after setting KOLM_DATA_DIR; the module reads it lazily per-call.
  const vault = await import('../src/secrets-vault.js');
  try {
    vault.putSecret({ id: 'OPENAI_API_KEY', value: 'sk-secret-123', note: 'test' });
    const got = vault.getSecret('OPENAI_API_KEY');
    assert.equal(got.value, 'sk-secret-123');
    const refs = vault.listSecretRefs();
    assert.ok(refs.some((r) => r.ref === 'local:OPENAI_API_KEY'));
    const del = vault.deleteSecret('OPENAI_API_KEY');
    assert.equal(del.deleted, true);
    assert.equal(vault.getSecret('OPENAI_API_KEY'), null);

    if (process.platform !== 'win32') {
      // Re-create to force a key + vault file on disk, then check perms.
      vault.putSecret({ id: 'X', value: 'y' });
      const keyFile = path.join(dir, 'secrets-vault.key');
      const jsonFile = path.join(dir, 'secrets-vault.json');
      assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, 'key file must be 0o600');
      assert.equal(fs.statSync(jsonFile).mode & 0o777, 0o600, 'vault json must be 0o600');
      assert.equal(fs.statSync(dir).mode & 0o077, 0, 'vault dir must not be group/other-accessible');
    }
  } finally {
    if (prev === undefined) delete process.env.KOLM_DATA_DIR; else process.env.KOLM_DATA_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
