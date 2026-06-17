import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { leafHash, buildTree } from '../src/merkle.js';
import { verifyRekorInclusionProof } from '../src/sigstore.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIGSTORE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'sigstore.js'), 'utf8');
const SPEC_SRC = fs.readFileSync(path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md'), 'utf8');

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function sigstoreLeaf(digestB64, sigB64) {
  return leafHash(Buffer.concat([
    Buffer.from(digestB64, 'base64'),
    Buffer.from(sigB64, 'base64'),
  ]));
}

function proofFor({ index = 6, rootEncoding = 'base64' } = {}) {
  const digestB64 = b64('target-digest-w612');
  const sigB64 = b64('target-signature-w612');
  const leaves = [
    leafHash('leaf-0'),
    leafHash('leaf-1'),
    leafHash('leaf-2'),
    leafHash('leaf-3'),
    leafHash('leaf-4'),
    leafHash('leaf-5'),
    sigstoreLeaf(digestB64, sigB64),
  ];
  const tree = buildTree(leaves, { preHashed: true });
  const proof = tree.proof(index);
  return {
    digestB64,
    sigB64,
    root: proof.root,
    rekor: {
      uuid: 'w612-right-edge',
      logIndex: index,
      inclusionProof: {
        logIndex: index,
        treeSize: tree.size,
        hashes: proof.inclusionPath.map((h) => h.toString('base64')),
        rootHash: rootEncoding === 'hex' ? proof.root.toString('hex') : proof.root.toString('base64'),
      },
    },
  };
}

test('W612 #1 - sigstore verifier delegates Merkle proof math to src/merkle.js', () => {
  assert.match(SIGSTORE_SRC, /from\s+['"]\.\/merkle\.js['"]/);
  assert.match(SIGSTORE_SRC, /verifyInclusion\s*\(/);
  assert.doesNotMatch(SIGSTORE_SRC, /function\s+rfc6962LeafHash\s*\(/);
  assert.doesNotMatch(SIGSTORE_SRC, /function\s+rfc6962InnerHash\s*\(/);
});

test('W612 #2 - Rekor right-edge unbalanced proof verifies through shared Merkle implementation', () => {
  const { rekor, digestB64, sigB64 } = proofFor({ index: 6 });
  const result = verifyRekorInclusionProof(rekor, digestB64, sigB64);
  assert.deepEqual(result, { present: true, verified: true, reason: 'ok' });
});

test('W612 #3 - Rekor rootHash accepts hex while proof hashes stay base64', () => {
  const { rekor, digestB64, sigB64 } = proofFor({ index: 6, rootEncoding: 'hex' });
  const result = verifyRekorInclusionProof(rekor, digestB64, sigB64);
  assert.equal(result.verified, true, result.reason);
});

test('W612 #4 - overlong rootHash is rejected instead of truncated', () => {
  const { rekor, digestB64, sigB64, root } = proofFor({ index: 6 });
  rekor.inclusionProof.rootHash = Buffer.concat([root, Buffer.from([0])]).toString('base64');
  const result = verifyRekorInclusionProof(rekor, digestB64, sigB64);
  assert.equal(result.present, true);
  assert.equal(result.verified, false);
  assert.match(result.reason, /expected 32|root/i);
});

test('W612 #5 - backend spec records sigstore Merkle migration closure', () => {
  assert.match(SPEC_SRC, /\| 11 \| verifiable-inference \| 8 \| S\/low \| CLOSED W612: migrate sigstore inclusion verification to merkle\.js/i);
  assert.match(SPEC_SRC, /W612 migrated verifyRekorInclusionProof to src\/merkle\.js verifyInclusion/i);
});
