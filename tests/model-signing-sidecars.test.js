// tests/model-signing-sidecars.test.js
//
// Model-signing-standards (frontier-synthesis surgicalNow) - lock-in tests for
// the two build-time sidecars that src/artifact.js now writes into a .kolm:
//
//   1) provenance.intoto.dsse.json - a signed SLSA Provenance v1 DSSE envelope
//      so a .kolm is self-describing to cosign verify-attestation / slsa-verifier
//      offline (item: "Write a build-time OMS/SLSA DSSE sidecar into the .kolm
//      container").
//   2) model.sig.bundle - an OpenSSF Model-Signing (OMS) file manifest whose
//      subjects are (member path, sha256) over the artifact's ACTUAL weight
//      members, so `model-signing verify` accepts a kolm artifact (item: "Add an
//      OMS file-manifest bundle over the artifact's actual weight members").
//
// Both are SEALS over the bytes: emitted AFTER artifact_hash, EXCLUDED from
// artifact_hash_input + the CID (like signature.sig), gated behind the Ed25519
// signer. The byte-stability assertion below proves they do NOT change the
// artifact_hash. No network, no GPU.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { buildPayload } from '../src/artifact.js';
import { verifyDsseEnvelope, SLSA_PROVENANCE_PREDICATE_TYPE, INTOTO_STATEMENT_TYPE } from '../src/intoto-slsa.js';
import {
  verifyInTotoBundle,
  toOmsArtifactManifest,
  OMS_SIGNATURE_PREDICATE_TYPE,
} from '../src/intoto-receipt.js';
import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';

// A per-test temp HOME so loadOrCreateDefaultSigner mints a fresh stable key at
// ~/.kolm/signing-key.pem without touching the developer's real key.
function isolatedHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-ms-sidecar-'));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-public-fixture-v0-1-0';
  delete process.env.KOLM_ED25519_DISABLE;
  return tmp;
}

function ruleArgs(overrides = {}) {
  return {
    job_id: 'job_ms_sidecar_' + Date.now().toString(36),
    task: 'model-signing sidecar smoke',
    base_model: 'none',
    recipes: [{
      id: 'rcp_ms',
      name: 'Echo',
      source: 'function generate(input) { return { echo: String(input.text||input) }; }',
    }],
    training_stats: { verifier_accepted: true, pass_rate_positive: 1.0 },
    judge_id: 'judge-ms',
    eval_score: 1.0,
    ...overrides,
  };
}

function fileBuf(payload, name) {
  const f = payload.files.find((x) => x.filename === name);
  return f ? f.content : null;
}

// ===========================================================================
// (1) SLSA Provenance v1 DSSE sidecar
// ===========================================================================

test('sidecar: a rule-class .kolm carries provenance.intoto.dsse.json that verifies offline', () => {
  isolatedHome();
  const payload = buildPayload(ruleArgs());
  const buf = fileBuf(payload, 'provenance.intoto.dsse.json');
  assert.ok(buf, 'provenance.intoto.dsse.json must be a ZIP member');

  const envelope = JSON.parse(buf.toString('utf8'));
  assert.equal(envelope.payloadType, 'application/vnd.in-toto+json');
  assert.ok(Array.isArray(envelope.signatures) && envelope.signatures.length >= 1);

  // It must verify against the artifact's own (embedded) Ed25519 public key,
  // which the signed receipt records via signed_by ed25519:<fingerprint>.
  const pem = payload.receipt.signature_ed25519 && payload.receipt.signature_ed25519.public_key
    ? payload.receipt.signature_ed25519.public_key
    : null;
  assert.ok(pem, 'receipt must embed the Ed25519 public key to verify the sidecar offline');
  const v = verifyDsseEnvelope(envelope, { publicKey: pem });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.statement._type, INTOTO_STATEMENT_TYPE);
  assert.equal(v.statement.predicateType, SLSA_PROVENANCE_PREDICATE_TYPE);
  // Subjects are the real bundled members, each with a 64-hex byte sha256.
  assert.ok(Array.isArray(v.statement.subject) && v.statement.subject.length >= 1);
  for (const s of v.statement.subject) {
    assert.match(s.digest.sha256, /^[0-9a-f]{64}$/);
  }
});

test('sidecar: DSSE subject digests are the ACTUAL bundled bytes (not lineage-folded model_pointer)', () => {
  isolatedHome();
  // base_model set -> a model.gguf pointer member exists; its byte hash must be
  // sha256(pointer-bytes), NOT manifest.hashes.model_pointer.
  const payload = buildPayload(ruleArgs({ base_model: 'Qwen/Qwen2.5-3B-Instruct' }));
  const envelope = JSON.parse(fileBuf(payload, 'provenance.intoto.dsse.json').toString('utf8'));
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  const byName = Object.fromEntries(statement.subject.map((s) => [s.name, s.digest.sha256]));

  // recipes.json subject == sha256 of the actual recipes.json bytes in the zip.
  const recipesBytes = fileBuf(payload, 'recipes.json');
  const recipesSha = crypto.createHash('sha256').update(recipesBytes).digest('hex');
  assert.equal(byName['recipes.json'], recipesSha);

  // model.gguf subject == sha256 of the pointer bytes, NOT the folded slot.
  const ptrBytes = fileBuf(payload, 'model.gguf');
  if (ptrBytes) {
    const ptrSha = crypto.createHash('sha256').update(ptrBytes).digest('hex');
    assert.equal(byName['model.gguf'], ptrSha, 'model.gguf subject must be the byte hash of the pointer member');
  }
});

// ===========================================================================
// (2) OMS file-manifest bundle over actual weight members
// ===========================================================================

test('sidecar: a weight-class .kolm carries model.sig.bundle whose subjects are the real weight members', () => {
  isolatedHome();
  // A real bundled GGUF weight member triggers the OMS weight manifest.
  const weightBytes = Buffer.from('GGUF\x00fake-weights-for-test', 'binary');
  const payload = buildPayload(ruleArgs({
    base_model: 'Qwen/Qwen2.5-3B-Instruct',
    artifact_class: 'distilled_model',
    runtime_target: 'gguf',
    runtime_target_config: { gguf_path: 'model.gguf' },
    model_weights: { filename: 'model.gguf', content: weightBytes },
  }));

  const buf = fileBuf(payload, 'model.sig.bundle');
  assert.ok(buf, 'model.sig.bundle must be a ZIP member when real weights are bundled');
  const bundle = JSON.parse(buf.toString('utf8'));
  assert.match(bundle.mediaType, /sigstore\.bundle/);

  // It verifies against the embedded key and uses the OMS predicateType.
  const v = verifyInTotoBundle(bundle);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.predicateType, OMS_SIGNATURE_PREDICATE_TYPE);
  assert.equal(v.predicateType, 'https://model_signing/signature/v1.0');

  // The weight member is a subject whose digest is the real byte sha256.
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  const byName = Object.fromEntries(statement.subject.map((s) => [s.name, s.digest.sha256]));
  const weightSha = crypto.createHash('sha256').update(weightBytes).digest('hex');
  assert.equal(byName['model.gguf'], weightSha, 'OMS subject must be the real weight bytes');
  // Predicate is an OMS resource manifest.
  assert.ok(Array.isArray(statement.predicate.resources));
  assert.equal(statement.predicate.model_signing_version, '1.0');
});

test('sidecar: a pure rule-class .kolm (no real weights) emits an OMS manifest over the recipe bundle', () => {
  isolatedHome();
  const payload = buildPayload(ruleArgs());
  // The recipe.bundle.mjs is the executable member; the OMS weight manifest
  // includes it so a model verifier can pin the runnable artifact too.
  const buf = fileBuf(payload, 'model.sig.bundle');
  assert.ok(buf, 'model.sig.bundle present for a rule-class artifact that ships a recipe bundle');
  const bundle = JSON.parse(buf.toString('utf8'));
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  const names = statement.subject.map((s) => s.name);
  assert.ok(names.includes('recipe.bundle.mjs'), 'recipe bundle is an OMS subject');
  const bundleBytes = fileBuf(payload, 'recipe.bundle.mjs');
  const sha = crypto.createHash('sha256').update(bundleBytes).digest('hex');
  const byName = Object.fromEntries(statement.subject.map((s) => [s.name, s.digest.sha256]));
  assert.equal(byName['recipe.bundle.mjs'], sha);
});

// ===========================================================================
// Byte-stability + gating
// ===========================================================================

test('sidecar: the sidecars are SEALED out of artifact_hash + the receipt file list', () => {
  isolatedHome();
  const payload = buildPayload(ruleArgs({ job_id: 'job_ms_stable' }));
  assert.ok(fileBuf(payload, 'provenance.intoto.dsse.json'), 'signer present -> DSSE sidecar present');
  assert.ok(fileBuf(payload, 'model.sig.bundle'), 'signer present -> OMS bundle present');

  // The byte-stability mechanism: like signature.sig / receipt.json /
  // credential.json, neither sidecar is folded into manifest.hashes (the input
  // to the CID + artifact_hash) nor into receipt.artifact_files (the receipt's
  // canonical bundle file list). That exclusion is exactly what keeps the
  // artifact_hash byte-identical to a pre-sidecar build.
  for (const name of ['provenance.intoto.dsse.json', 'model.sig.bundle']) {
    assert.ok(!(name in payload.manifest.hashes), `${name} must NOT be in manifest.hashes`);
    const inReceipt = (payload.receipt.artifact_files || []).some((r) => r.filename === name);
    assert.equal(inReceipt, false, `${name} must NOT be in receipt.artifact_files`);
  }
  // signature.sig is the established precedent for this same exclusion.
  assert.ok(!('signature.sig' in payload.manifest.hashes));
});

test('sidecar: disabling the Ed25519 signer drops BOTH sidecars (gated behind the existing signer)', () => {
  isolatedHome();
  process.env.KOLM_ED25519_DISABLE = '1';
  try {
    const payload = buildPayload(ruleArgs({ job_id: 'job_ms_nosigner' }));
    assert.equal(payload.files.find((f) => f.filename === 'provenance.intoto.dsse.json'), undefined,
      'no Ed25519 signer -> no DSSE sidecar');
    assert.equal(payload.files.find((f) => f.filename === 'model.sig.bundle'), undefined,
      'no Ed25519 signer -> no OMS bundle');
  } finally {
    delete process.env.KOLM_ED25519_DISABLE;
  }
});

test('sidecar: the two reserved sidecar filenames cannot be shadowed by extra_files', () => {
  isolatedHome();
  assert.throws(
    () => buildPayload(ruleArgs({
      extra_files: [{ filename: 'provenance.intoto.dsse.json', content: Buffer.from('x') }],
    })),
    /reserved/,
  );
  assert.throws(
    () => buildPayload(ruleArgs({
      extra_files: [{ filename: 'model.sig.bundle', content: Buffer.from('x') }],
    })),
    /reserved/,
  );
});

// ===========================================================================
// toOmsArtifactManifest unit behaviour (the new src/intoto-receipt.js export)
// ===========================================================================

test('toOmsArtifactManifest: subjects are (path, byte-sha256) and verify; bad hashes are dropped', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const signer = { publicKey, privateKey, key_fingerprint: keyFingerprint(publicKey) };
  const good = 'a'.repeat(64);
  const bundle = toOmsArtifactManifest([
    { name: 'model.safetensors', sha256: good },
    { name: 'short.bin', sha256: 'abc' }, // dropped: not 64-hex
    { name: null, sha256: good },          // dropped: no name
  ], signer);
  const v = verifyInTotoBundle(bundle, { publicKey });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.predicateType, OMS_SIGNATURE_PREDICATE_TYPE);
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  assert.equal(statement.subject.length, 1, 'only the valid member becomes a subject');
  assert.equal(statement.subject[0].name, 'model.safetensors');
});

test('toOmsArtifactManifest: throws when no member has a valid sha256 (never signs an empty manifest)', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const signer = { publicKey, privateKey, key_fingerprint: keyFingerprint(publicKey) };
  assert.throws(() => toOmsArtifactManifest([{ name: 'x.bin', sha256: 'nope' }], signer), /no members/);
  assert.throws(() => toOmsArtifactManifest('not-an-array', signer), /must be an array/);
});
