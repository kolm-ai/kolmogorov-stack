// W652 - direct contract/security test for packages/sdk-ts/src/index.ts.
//
// The TypeScript SDK is a package-distribution boundary for .kolm artifact
// verification. Exercise the checked-in dist entrypoint while pinning the
// source entrypoint contract directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import kolm, {
  VERSION,
  VerificationError,
  canonicalJson,
  loadBuffer,
} from '../packages/sdk-ts/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE_ENTRYPOINT = 'packages/sdk-ts/src/index.ts';
const SECRET = 'w652-sdk-ts-secret';

function sha(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hmacHex(body, secret = SECRET) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(canonicalJson(body)).digest('hex');
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(0),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(0),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdOffset = offset;
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(cdOffset),
    u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

function signedReceipt(body, secret = SECRET) {
  return { ...body, signature: hmacHex(body, secret) };
}

function artifactBytes({
  modelBytes = 'model-bytes',
  hashOverride = null,
  receiptManifestCid = null,
  includeCredential = true,
} = {}) {
  const model = Buffer.from(modelBytes, 'utf8');
  const hashes = { 'model.bin': hashOverride || sha(model) };
  const manifest = {
    spec: 'kolm/test',
    task: 'unit-test',
    hashes,
  };
  manifest.cid = 'cidv1:sha256:' + sha(canonicalJson({ hashes }));
  const receiptBody = {
    manifest_cid: receiptManifestCid || manifest.cid,
    issued_at: '2026-06-18T00:00:00.000Z',
  };
  const entries = [
    ['manifest.json', JSON.stringify(manifest)],
    ['model.bin', model],
    ['receipt.json', JSON.stringify(signedReceipt(receiptBody))],
  ];
  if (includeCredential) entries.push(['credential.json', JSON.stringify({ issued_by: 'w652', scope: 'test' })]);
  return { bytes: zipStore(entries), manifest, receiptBody };
}

test('W652 sdk-ts source and dist expose the verification contract', () => {
  assert.equal(SOURCE_ENTRYPOINT, 'packages/sdk-ts/src/index.ts');
  const src = fs.readFileSync(path.join(ROOT, SOURCE_ENTRYPOINT), 'utf8');
  const dist = fs.readFileSync(path.join(ROOT, 'packages/sdk-ts/dist/index.js'), 'utf8');
  assert.match(src, /verifyReceiptManifestBinding/);
  assert.match(dist, /verifyReceiptManifestBinding/);
  assert.equal(VERSION, '0.2.6');
  assert.equal(typeof kolm.load, 'function');
  assert.equal(canonicalJson({ z: 1, a: { b: 2, a: 1 } }), '{"a":{"a":1,"b":2},"z":1}');
});

test('W652 sdk-ts loads a signed artifact and binds receipt.manifest_cid to manifest.cid', async () => {
  const { bytes, manifest } = artifactBytes();
  const model = await loadBuffer(bytes, {
    secret: SECRET,
    endpoint: 'https://runtime.example///',
    apiKey: 'ks_test',
  });
  assert.equal(model.cid, manifest.cid);
  assert.equal(model.manifest.task, 'unit-test');
  assert.equal(model.credential.issued_by, 'w652');

  const originalFetch = globalThis.fetch;
  let seen = null;
  try {
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({
        output: 'predicted',
        artifact_cid: manifest.cid,
        credential: 'signed-output',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const out = await model.predict('hello');
    assert.equal(out.text, 'predicted');
    assert.equal(out.cid, manifest.cid);
    assert.equal(out.credential, 'signed-output');
    assert.equal(seen.url, 'https://runtime.example/v1/run');
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers.authorization, 'Bearer ks_test');
    assert.deepEqual(JSON.parse(seen.init.body), { artifact_cid: manifest.cid, input: 'hello' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('W652 sdk-ts rejects receipt signatures and manifest-cid substitutions', async () => {
  const mismatchedCid = 'cidv1:sha256:' + '0'.repeat(64);
  const { bytes } = artifactBytes({ receiptManifestCid: mismatchedCid });
  await assert.rejects(
    () => loadBuffer(bytes, { secret: SECRET }),
    (err) => err instanceof VerificationError && /receipt manifest_cid mismatch/.test(err.message),
  );

  const { manifest } = artifactBytes();
  const badReceipt = signedReceipt({ manifest_cid: manifest.cid }, 'wrong-secret');
  const bad = zipStore([
    ['manifest.json', JSON.stringify(manifest)],
    ['model.bin', Buffer.from('model-bytes')],
    ['receipt.json', JSON.stringify(badReceipt)],
  ]);
  await assert.rejects(
    () => loadBuffer(bad, { secret: SECRET }),
    (err) => err instanceof VerificationError && /receipt signature mismatch/.test(err.message),
  );
});

test('W652 sdk-ts enforces manifest file hashes unless explicitly skipped', async () => {
  const badHash = 'f'.repeat(64);
  const { bytes, manifest } = artifactBytes({ hashOverride: badHash });
  await assert.rejects(
    () => loadBuffer(bytes, { secret: SECRET }),
    (err) => err instanceof VerificationError && /hash mismatch for model\.bin/.test(err.message),
  );
  const model = await loadBuffer(bytes, { secret: SECRET, skipHashCheck: true });
  assert.equal(model.cid, manifest.cid);
});
