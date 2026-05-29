// tests/wave921-govern-crypto.test.js
//
// W921 Phase-1 — Govern / Receipts & Compliance crypto primitives.
//   src/merkle.js        — RFC 6962 MTH + RFC 9162 §2.1.3.2 verify_inclusion
//   src/intoto-slsa.js   — in-toto v1 Statement + SLSA Provenance v1 (DSSE)
//
// Vectors are grounded in primary sources:
//   - RFC 6962 published digests (empty tree, leaf-hash of empty, "L123456").
//   - DSSE protocol PAE spec example.
//   - in-toto v1 + SLSA v1 type URIs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  leafHash, nodeHash, computeRoot, inclusionPath, verifyInclusion,
  buildTree, root, proof, verifyProof, hashLeaves,
  LEAF_PREFIX, NODE_PREFIX, MERKLE_SPEC,
} from '../src/merkle.js';

import {
  pae,
  buildInTotoStatement,
  buildSlsaProvenancePredicate,
  resourceDescriptorsFromLineage,
  buildDsseEnvelope,
  verifyDsseEnvelope,
  verifyInTotoAgainstArtifact,
  emitArtifactAttestation,
  INTOTO_STATEMENT_TYPE,
  SLSA_PROVENANCE_PREDICATE_TYPE,
  INTOTO_DSSE_PAYLOAD_TYPE,
  KOLM_BUILD_TYPE,
  KOLM_SLSA_CONFORMANCE,
} from '../src/intoto-slsa.js';

import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';

// ===========================================================================
// MERKLE — RFC 6962 domain separation
// ===========================================================================

test('merkle: leaf/node prefixes are RFC 6962 domain-separation bytes', () => {
  assert.equal(LEAF_PREFIX, 0x00);
  assert.equal(NODE_PREFIX, 0x01);
  assert.equal(MERKLE_SPEC.hash, 'sha256');
});

test('merkle: leafHash matches SHA256(0x00 || data) published vectors', () => {
  // RFC 6962: leaf hash of empty data = SHA256(0x00).
  assert.equal(
    leafHash(Buffer.alloc(0)).toString('hex'),
    '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  );
  // RFC 6962 worked example: leaf "L123456".
  assert.equal(
    leafHash(Buffer.from('4c313233343536', 'hex')).toString('hex'),
    '395aa064aa4c29f7010acfe3f25db9485bbd4b91897b6ad7ad547639252b4d56',
  );
  // String input must coerce to UTF-8 bytes identically to the Buffer.
  assert.deepEqual(leafHash('hello'), leafHash(Buffer.from('hello', 'utf8')));
});

test('merkle: nodeHash matches SHA256(0x01 || L || R)', () => {
  const l = leafHash('a');
  const r = leafHash('b');
  const want = crypto.createHash('sha256')
    .update(Buffer.from([0x01])).update(l).update(r).digest('hex');
  assert.equal(nodeHash(l, r).toString('hex'), want);
});

test('merkle: computeRoot empty tree = SHA256("") (RFC 6962)', () => {
  assert.equal(
    computeRoot([]).toString('hex'),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('merkle: computeRoot n=1 returns the leaf hash itself', () => {
  const leaf = leafHash('only');
  assert.deepEqual(computeRoot([leaf]), leaf);
});

test('merkle: computeRoot n=2 = nodeHash(leaf0, leaf1)', () => {
  const l0 = leafHash('a');
  const l1 = leafHash('b');
  assert.deepEqual(computeRoot([l0, l1]), nodeHash(l0, l1));
});

test('merkle: computeRoot n=4 splits at power-of-two (balanced)', () => {
  const ls = ['a', 'b', 'c', 'd'].map(leafHash);
  const left = nodeHash(ls[0], ls[1]);
  const right = nodeHash(ls[2], ls[3]);
  assert.deepEqual(computeRoot(ls), nodeHash(left, right));
});

test('merkle: computeRoot n=3 splits at largest pow2 < n (unbalanced right edge)', () => {
  // RFC 6962: k = largest 2^x < 3 = 2 -> MTH = node( node(l0,l1), l2 ).
  const ls = ['a', 'b', 'c'].map(leafHash);
  const expected = nodeHash(nodeHash(ls[0], ls[1]), ls[2]);
  assert.deepEqual(computeRoot(ls), expected);
});

// ===========================================================================
// MERKLE — RFC 9162 §2.1.3.2 verify_inclusion
// ===========================================================================

test('merkle: inclusionPath round-trips through verifyInclusion for n in {1,2,3,4,5,7,8,16,17}', () => {
  for (const n of [1, 2, 3, 4, 5, 7, 8, 16, 17]) {
    const leaves = Array.from({ length: n }, (_, i) => leafHash('record-' + i));
    const rootBuf = computeRoot(leaves);
    for (let i = 0; i < n; i++) {
      const path = inclusionPath(leaves, i);
      const res = verifyInclusion({
        leafHash: leaves[i], leafIndex: i, treeSize: n, inclusionPath: path, root: rootBuf,
      });
      assert.equal(res.ok, true, `n=${n} i=${i}: ${res.reason}`);
      assert.equal(res.root, rootBuf.toString('hex'));
    }
  }
});

test('merkle: verifyInclusion rejects the right-edge unbalanced cases the old buggy walk false-rejected', () => {
  // n=7 (unbalanced) — the rightmost leaves are exactly where sigstore.js's
  // `cursor=sib;//unused; continue` branch dropped a sibling. Assert ALL pass.
  const n = 7;
  const leaves = Array.from({ length: n }, (_, i) => leafHash('leaf-' + i));
  const rootBuf = computeRoot(leaves);
  for (let i = 0; i < n; i++) {
    const path = inclusionPath(leaves, i);
    assert.equal(
      verifyInclusion({ leafHash: leaves[i], leafIndex: i, treeSize: n, inclusionPath: path, root: rootBuf }).ok,
      true,
      `right-edge case i=${i} must verify`,
    );
  }
});

test('merkle: verifyInclusion accepts hex-string and base64-string digest forms', () => {
  const leaves = ['a', 'b', 'c', 'd'].map(leafHash);
  const rootBuf = computeRoot(leaves);
  const path = inclusionPath(leaves, 2);
  const asHex = verifyInclusion({
    leafHash: leaves[2].toString('hex'),
    leafIndex: 2, treeSize: 4,
    inclusionPath: path.map((p) => p.toString('hex')),
    root: rootBuf.toString('hex'),
  });
  assert.equal(asHex.ok, true, asHex.reason);
});

test('merkle: verifyInclusion rejects leafIndex >= treeSize', () => {
  const leaves = ['a', 'b', 'c', 'd'].map(leafHash);
  const res = verifyInclusion({
    leafHash: leaves[0], leafIndex: 4, treeSize: 4,
    inclusionPath: inclusionPath(leaves, 0), root: computeRoot(leaves),
  });
  assert.equal(res.ok, false);
});

test('merkle: verifyInclusion rejects tampered leaf, path, and root', () => {
  const leaves = ['a', 'b', 'c', 'd'].map(leafHash);
  const rootBuf = computeRoot(leaves);
  const path = inclusionPath(leaves, 1);

  assert.equal(verifyInclusion({ leafHash: leafHash('TAMPER'), leafIndex: 1, treeSize: 4, inclusionPath: path, root: rootBuf }).ok, false);

  const badPath = [...path];
  badPath[0] = leafHash('TAMPER');
  assert.equal(verifyInclusion({ leafHash: leaves[1], leafIndex: 1, treeSize: 4, inclusionPath: badPath, root: rootBuf }).ok, false);

  assert.equal(verifyInclusion({ leafHash: leaves[1], leafIndex: 1, treeSize: 4, inclusionPath: path, root: leafHash('NOTROOT') }).ok, false);
});

test('merkle: verifyInclusion rejects over-long and too-short paths', () => {
  const leaves = ['a', 'b', 'c', 'd'].map(leafHash);
  const rootBuf = computeRoot(leaves);
  const path = inclusionPath(leaves, 1);
  assert.equal(verifyInclusion({ leafHash: leaves[1], leafIndex: 1, treeSize: 4, inclusionPath: [...path, leafHash('z')], root: rootBuf }).ok, false);
  assert.equal(verifyInclusion({ leafHash: leaves[1], leafIndex: 1, treeSize: 4, inclusionPath: path.slice(0, 1), root: rootBuf }).ok, false);
});

test('merkle: verifyInclusion rejects a root of the wrong byte-length (no truncation false-accept)', () => {
  // The old verifier wrapped both sides in Buffer.alloc(32,0).fill(slice(0,32)),
  // which truncated to 32 bytes and could false-ACCEPT differing 33-byte roots.
  const leaves = ['a', 'b'].map(leafHash);
  const rootBuf = computeRoot(leaves);
  const path = inclusionPath(leaves, 0);
  const overlong = Buffer.concat([rootBuf, Buffer.from([0xff])]); // 33 bytes
  const res = verifyInclusion({ leafHash: leaves[0], leafIndex: 0, treeSize: 2, inclusionPath: path, root: overlong });
  assert.equal(res.ok, false, 'a 33-byte root must NOT verify against a 32-byte recomputed root');
});

test('merkle: verifyInclusion never throws on garbage input', () => {
  assert.doesNotThrow(() => verifyInclusion({}));
  assert.equal(verifyInclusion({}).ok, false);
  assert.equal(verifyInclusion({ leafHash: 123, leafIndex: 0, treeSize: 1, inclusionPath: [], root: 'zzz' }).ok, false);
  assert.equal(verifyInclusion({ leafHash: leafHash('a'), leafIndex: 0, treeSize: 1, inclusionPath: 'not-an-array', root: leafHash('a') }).ok, false);
});

// ===========================================================================
// MERKLE — task-named convenience API (buildTree / root / proof / verifyProof)
// ===========================================================================

test('merkle: buildTree exposes root + per-index proofs that all verify', () => {
  const records = Array.from({ length: 9 }, (_, i) => 'rec-' + i);
  const tree = buildTree(records);
  assert.equal(tree.size, 9);
  assert.equal(tree.rootHex, computeRoot(records.map(leafHash)).toString('hex'));
  for (let i = 0; i < 9; i++) {
    const p = tree.proof(i);
    assert.equal(tree.verifyProof(p).ok, true, `proof ${i} must verify`);
  }
});

test('merkle: root/proof/verifyProof aliases agree with the RFC primitives', () => {
  const records = ['x', 'y', 'z'];
  assert.deepEqual(root(records), computeRoot(hashLeaves(records)));
  const p = proof(records, 2);
  assert.equal(verifyProof(p).ok, true);
});

test('merkle: buildTree with preHashed leaves bypasses re-hashing', () => {
  const leaves = ['a', 'b', 'c', 'd'].map(leafHash);
  const tree = buildTree(leaves, { preHashed: true });
  assert.deepEqual(tree.root, computeRoot(leaves));
  assert.equal(tree.verifyProof(tree.proof(0)).ok, true);
});

// ===========================================================================
// IN-TOTO / SLSA — DSSE PAE
// ===========================================================================

test('intoto: pae() matches the DSSE spec example byte-for-byte', () => {
  const got = pae('http://example.com/HelloWorld', Buffer.from('hello world'));
  const want = Buffer.from('DSSEv1 29 http://example.com/HelloWorld 11 hello world', 'utf8');
  assert.deepEqual(got, want);
});

test('intoto: pae() uses BYTE length, not char length, for multi-byte UTF-8', () => {
  const type = 'https://kolm.ai/\u{1F512}'; // padlock emoji = 4 UTF-8 bytes
  const body = Buffer.from('café', 'utf8'); // é = 2 bytes -> 5 bytes
  const out = pae(type, body).toString('utf8');
  const typeByteLen = Buffer.byteLength(type, 'utf8');
  assert.ok(out.startsWith(`DSSEv1 ${typeByteLen} ${type} ${body.length} `));
  assert.equal(body.length, 5);
});

test('intoto: pae() emits LEN with no leading zeros', () => {
  const out = pae('t', Buffer.from('')).toString('utf8');
  // type "t" = 1 byte, body = 0 bytes -> "DSSEv1 1 t 0 "
  assert.equal(out, 'DSSEv1 1 t 0 ');
});

// ===========================================================================
// IN-TOTO / SLSA — Statement + predicate
// ===========================================================================

test('intoto: buildInTotoStatement rejects a subject with empty/missing digest', () => {
  assert.throws(() => buildInTotoStatement({ subjects: [], predicateType: 'x', predicate: {} }));
  assert.throws(() => buildInTotoStatement({ subjects: [{ name: 'a.kolm' }], predicateType: 'x', predicate: {} }));
  assert.throws(() => buildInTotoStatement({ subjects: [{ name: 'a.kolm', digest: {} }], predicateType: 'x', predicate: {} }));
  assert.throws(() => buildInTotoStatement({ subjects: [{ name: 'a.kolm', digest: { sha256: '' } }], predicateType: 'x', predicate: {} }));
});

test('intoto: buildInTotoStatement sets _type and predicateType for a valid subject', () => {
  const st = buildInTotoStatement({
    subjects: [{ name: 'job.kolm', digest: { sha256: 'a'.repeat(64) } }],
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    predicate: { hi: true },
  });
  assert.equal(st._type, INTOTO_STATEMENT_TYPE);
  assert.equal(st.predicateType, SLSA_PROVENANCE_PREDICATE_TYPE);
  assert.equal(st.subject.length, 1);
});

test('intoto: SLSA predicate populates resolvedDependencies from a distillation lineage', () => {
  const lineage = {
    source: 'distillation',
    teacher: { vendor: 'deepseek', model: 'r1-32b', version: 'int4' },
    student_base: { repo: 'Qwen/Qwen2.5-7B', revision: 'main' },
    training_corpus_hash: 'b'.repeat(64),
    distillation_method: 'lora',
  };
  const pred = buildSlsaProvenancePredicate({
    manifest: { task: 'support', base_model: 'qwen', tier: 'pro' },
    hashes: { recipes_json: 'c'.repeat(64) },
    lineage,
    builderVersion: '2.13.0',
    jobId: 'job_abc',
    startedOn: '2026-05-29T00:00:00.000Z',
    finishedOn: '2026-05-29T00:01:00.000Z',
  });
  assert.equal(pred.buildDefinition.buildType, KOLM_BUILD_TYPE);
  assert.ok(pred.runDetails.builder.id.startsWith('https://kolm.ai/cli/'));
  assert.equal(pred.runDetails.metadata.invocationId, 'job_abc');
  const deps = pred.buildDefinition.resolvedDependencies;
  const roles = deps.map((d) => d.annotations && d.annotations.role).filter(Boolean);
  assert.ok(roles.includes('teacher'), 'teacher material present');
  assert.ok(roles.includes('student_base'), 'student base material present');
  const corpus = deps.find((d) => d.digest && d.digest.sha256 === 'b'.repeat(64));
  assert.ok(corpus, 'training corpus descriptor present');
});

test('intoto: SLSA predicate degrades to recipes/evals (no fabricated deps) without lineage', () => {
  const pred = buildSlsaProvenancePredicate({
    manifest: { task: 'x' },
    hashes: { recipes_json: 'd'.repeat(64), evals_json: 'e'.repeat(64) },
    lineage: null,
    builderVersion: '1.0.0',
  });
  const names = pred.buildDefinition.resolvedDependencies.map((d) => d.name);
  assert.deepEqual(names.sort(), ['evals.json', 'recipes.json']);
  // No fabricated teacher/student entries.
  assert.ok(!pred.buildDefinition.resolvedDependencies.some((d) => d.annotations && d.annotations.role === 'teacher'));
});

test('intoto: resourceDescriptorsFromLineage returns [] for empty/garbage lineage', () => {
  assert.deepEqual(resourceDescriptorsFromLineage(null), []);
  assert.deepEqual(resourceDescriptorsFromLineage({}), []);
  assert.deepEqual(resourceDescriptorsFromLineage(42), []);
});

// ===========================================================================
// IN-TOTO / SLSA — DSSE envelope round-trip + tamper detection
// ===========================================================================

function freshSigner() {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKey, privateKey, key_fingerprint: keyFingerprint(publicKey) };
}

test('intoto: buildDsseEnvelope -> verifyDsseEnvelope round-trip ok=true', () => {
  const signer = freshSigner();
  const st = buildInTotoStatement({
    subjects: [{ name: 'job.kolm', digest: { sha256: 'a'.repeat(64) } }],
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    predicate: { buildDefinition: { buildType: KOLM_BUILD_TYPE } },
  });
  const env = buildDsseEnvelope({ statement: st, privateKey: signer.privateKey, publicKey: signer.publicKey, key_fingerprint: signer.key_fingerprint });
  assert.equal(env.payloadType, INTOTO_DSSE_PAYLOAD_TYPE);
  const res = verifyDsseEnvelope(env, { publicKey: signer.publicKey });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.statement._type, INTOTO_STATEMENT_TYPE);
  assert.equal(res.predicateType, SLSA_PROVENANCE_PREDICATE_TYPE);
});

test('intoto: DSSE signature is STANDARD base64 (no - or _), decodes via base64', () => {
  const signer = freshSigner();
  const st = buildInTotoStatement({
    subjects: [{ name: 'a.kolm', digest: { sha256: 'f'.repeat(64) } }],
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE, predicate: {},
  });
  const env = buildDsseEnvelope({ statement: st, privateKey: signer.privateKey, publicKey: signer.publicKey });
  const sig = env.signatures[0].sig;
  assert.ok(!/[-_]/.test(sig), 'standard base64 must not contain base64url chars - or _');
  assert.equal(Buffer.from(sig, 'base64').length, 64, 'Ed25519 sig is 64 raw bytes');
});

test('intoto: verifyDsseEnvelope rejects a flipped payload byte', () => {
  const signer = freshSigner();
  const st = buildInTotoStatement({
    subjects: [{ name: 'a.kolm', digest: { sha256: '1'.repeat(64) } }],
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE, predicate: {},
  });
  const env = buildDsseEnvelope({ statement: st, privateKey: signer.privateKey, publicKey: signer.publicKey });
  const raw = Buffer.from(env.payload, 'base64');
  raw[0] ^= 0xff;
  env.payload = raw.toString('base64');
  assert.equal(verifyDsseEnvelope(env, { publicKey: signer.publicKey }).ok, false);
});

test('intoto: verifyDsseEnvelope rejects a wrong public key', () => {
  const a = freshSigner();
  const b = freshSigner();
  const st = buildInTotoStatement({
    subjects: [{ name: 'a.kolm', digest: { sha256: '2'.repeat(64) } }],
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE, predicate: {},
  });
  const env = buildDsseEnvelope({ statement: st, privateKey: a.privateKey, publicKey: a.publicKey });
  assert.equal(verifyDsseEnvelope(env, { publicKey: b.publicKey }).ok, false);
});

test('intoto: verifyDsseEnvelope rejects payloadType drift', () => {
  const signer = freshSigner();
  const st = buildInTotoStatement({
    subjects: [{ name: 'a.kolm', digest: { sha256: '3'.repeat(64) } }],
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE, predicate: {},
  });
  const env = buildDsseEnvelope({ statement: st, privateKey: signer.privateKey, publicKey: signer.publicKey });
  env.payloadType = 'application/vnd.evil+json';
  assert.equal(verifyDsseEnvelope(env, { publicKey: signer.publicKey }).ok, false);
});

test('intoto: verifyDsseEnvelope never throws on garbage', () => {
  assert.doesNotThrow(() => verifyDsseEnvelope(null, {}));
  assert.equal(verifyDsseEnvelope(null, {}).ok, false);
  assert.equal(verifyDsseEnvelope({ payloadType: INTOTO_DSSE_PAYLOAD_TYPE, payload: '@@@', signatures: [{ sig: 'x' }] }, { publicKey: freshSigner().publicKey }).ok, false);
});

// ===========================================================================
// IN-TOTO / SLSA — emit + verify against artifact bytes
// ===========================================================================

function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

test('intoto: emitArtifactAttestation -> verifyInTotoAgainstArtifact subjects_matched===total', () => {
  const signer = freshSigner();
  const artifactBytes = Buffer.from('the whole .kolm zip bytes');
  const ggufBytes = Buffer.from('model weights');
  const recipesBytes = Buffer.from('{"recipes":true}');
  const subjectDigests = {
    'job_x.kolm': sha256hex(artifactBytes),
    'model.gguf': sha256hex(ggufBytes),
    'recipes.json': sha256hex(recipesBytes),
  };
  const json = emitArtifactAttestation({
    ed25519Signer: signer,
    manifest: { task: 'support', base_model: 'qwen', tier: 'pro' },
    hashes: { recipes_json: sha256hex(recipesBytes) },
    lineage: { source: 'distillation', teacher: { vendor: 'anthropic', model: 'opus' }, student_base: { repo: 'Qwen/Qwen2.5-7B' }, training_corpus_hash: 'a'.repeat(64) },
    artifact_hash: sha256hex(artifactBytes),
    cid: 'cidv1:sha256:' + 'a'.repeat(64),
    jobId: 'job_x',
    builderVersion: '2.13.0',
    subjectDigests,
  });
  const env = JSON.parse(json);
  const res = verifyInTotoAgainstArtifact(env, subjectDigests, { publicKey: signer.publicKey });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.subjects_matched, 3);
  assert.equal(res.subjects_total, 3);
  assert.equal(res.predicateType, SLSA_PROVENANCE_PREDICATE_TYPE);
  assert.ok(res.slsa_materials.length >= 2);
});

test('intoto: verifyInTotoAgainstArtifact fails (matched<total) on a single-byte subject tamper', () => {
  const signer = freshSigner();
  const aBytes = Buffer.from('artifact');
  const rBytes = Buffer.from('recipes');
  const realDigests = { 'j.kolm': sha256hex(aBytes), 'recipes.json': sha256hex(rBytes) };
  const json = emitArtifactAttestation({
    ed25519Signer: signer,
    manifest: { task: 't' },
    hashes: { recipes_json: sha256hex(rBytes) },
    artifact_hash: sha256hex(aBytes),
    jobId: 'j',
    builderVersion: '1.0.0',
    subjectDigests: realDigests,
  });
  const env = JSON.parse(json);
  // Now present a TAMPERED recipes.json digest at verify time.
  const tamperedDigests = { ...realDigests, 'recipes.json': sha256hex(Buffer.from('recipes-TAMPERED')) };
  const res = verifyInTotoAgainstArtifact(env, tamperedDigests, { publicKey: signer.publicKey });
  assert.equal(res.ok, false);
  assert.ok(res.subjects_matched < res.subjects_total);
});

test('intoto: emitArtifactAttestation falls back to a single artifact subject when no subjectDigests', () => {
  const signer = freshSigner();
  const ah = 'd'.repeat(64);
  const json = emitArtifactAttestation({
    ed25519Signer: signer,
    manifest: { task: 't' },
    hashes: {},
    artifact_hash: ah,
    jobId: 'solo',
    builderVersion: '1.0.0',
  });
  const env = JSON.parse(json);
  const res = verifyInTotoAgainstArtifact(env, { 'solo.kolm': ah }, { publicKey: signer.publicKey });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.subjects_total, 1);
});

test('intoto: emitArtifactAttestation throws without a signer private key', () => {
  assert.throws(() => emitArtifactAttestation({ artifact_hash: 'a'.repeat(64), jobId: 'x' }));
});

test('intoto: re-emitting with identical inputs yields a byte-identical DSSE envelope (deterministic)', () => {
  const signer = freshSigner();
  const args = {
    ed25519Signer: signer,
    manifest: { task: 't', base_model: 'b' },
    hashes: { recipes_json: '9'.repeat(64) },
    lineage: { source: 'distillation', teacher: { vendor: 'v', model: 'm' }, student_base: { repo: 'r' }, training_corpus_hash: '8'.repeat(64) },
    artifact_hash: '7'.repeat(64),
    cid: 'cidv1:sha256:' + '7'.repeat(64),
    jobId: 'det',
    builderVersion: '1.2.3',
    issued_at: '2026-05-29T12:00:00.000Z',
    startedOn: '2026-05-29T11:59:00.000Z',
  };
  const a = emitArtifactAttestation(args);
  const b = emitArtifactAttestation(args);
  assert.equal(a, b, 'identical inputs (fixed timestamps) must produce byte-identical envelopes');
});

test('intoto: spec constants are honest (Build L2 shape, not L3)', () => {
  assert.equal(INTOTO_STATEMENT_TYPE, 'https://in-toto.io/Statement/v1');
  assert.equal(SLSA_PROVENANCE_PREDICATE_TYPE, 'https://slsa.dev/provenance/v1');
  assert.equal(INTOTO_DSSE_PAYLOAD_TYPE, 'application/vnd.in-toto+json');
  assert.equal(KOLM_BUILD_TYPE, 'https://kolm.ai/compile/v1');
  assert.match(KOLM_SLSA_CONFORMANCE, /L2/);
  assert.ok(!/L3/.test(KOLM_SLSA_CONFORMANCE), 'must NOT claim SLSA Build L3');
});
