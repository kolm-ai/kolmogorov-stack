// W744 - direct contract test for src/zip-large.js.
//
// This pins the large-Zip64 reader atom: bounded central-directory parsing,
// Zip64 sentinel resolution, exact reads, CRC verification, streamed extraction,
// oversized-entry refusal for Buffer reads, and direct depth verification.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ZIP_LARGE_CONTRACT_VERSION,
  ZIP_LARGE_LIMITS,
  extractEntryToFile,
  listEntriesFromLargeZip,
  readEntryFromLargeZip,
} from '../src/zip-large.js';

const U32 = 0xFFFFFFFF;
const TWO_GIB_MINUS_1 = 2 * 1024 * 1024 * 1024 - 1;

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC32_TABLE.length; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC32_TABLE[i] = c >>> 0;
}

function read(rel) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w744-zip-large-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeZip(filePath, entries, opts = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data || '');
    const method = entry.method || 0;
    const payload = method === 8 ? zlib.deflateRawSync(data) : data;
    const actualCrc = crc32(data);
    const crc = entry.corruptCrc ? (actualCrc ^ 1) >>> 0 : actualCrc;
    const localOffset = offset;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(entry.forceZip64 ? 45 : 20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length <= U32 ? payload.length : U32, 18);
    lfh.writeUInt32LE(data.length <= U32 ? data.length : U32, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    const localPart = Buffer.concat([lfh, name, payload]);
    localParts.push(localPart);
    offset += localPart.length;

    const fakeCompSize = entry.fakeCompSize ?? payload.length;
    const fakeUncompSize = entry.fakeUncompSize ?? data.length;
    const forceZip64 = entry.forceZip64 || fakeCompSize > U32 || fakeUncompSize > U32 || localOffset > U32;
    const z64BodyParts = [];
    if (forceZip64) {
      const z64Body = Buffer.alloc(24);
      z64Body.writeBigUInt64LE(BigInt(fakeUncompSize), 0);
      z64Body.writeBigUInt64LE(BigInt(fakeCompSize), 8);
      z64Body.writeBigUInt64LE(BigInt(localOffset), 16);
      const z64 = Buffer.alloc(4 + z64Body.length);
      z64.writeUInt16LE(0x0001, 0);
      z64.writeUInt16LE(z64Body.length, 2);
      z64Body.copy(z64, 4);
      z64BodyParts.push(z64);
    }
    const extra = Buffer.concat(z64BodyParts);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(forceZip64 ? 45 : 20, 4);
    cdh.writeUInt16LE(forceZip64 ? 45 : 20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(forceZip64 ? U32 : fakeCompSize, 20);
    cdh.writeUInt32LE(forceZip64 ? U32 : fakeUncompSize, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt16LE(extra.length, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt32LE(forceZip64 ? U32 : localOffset, 42);
    centralParts.push(Buffer.concat([cdh, name, extra]));
  }

  const cd = Buffer.concat(centralParts);
  const cdOffset = offset;
  const cdSize = cd.length;
  const tailParts = [];
  if (opts.zip64Eocd) {
    const z64eocd = Buffer.alloc(56);
    z64eocd.writeUInt32LE(0x06064b50, 0);
    z64eocd.writeBigUInt64LE(BigInt(44), 4);
    z64eocd.writeUInt16LE(45, 12);
    z64eocd.writeUInt16LE(45, 14);
    z64eocd.writeBigUInt64LE(BigInt(entries.length), 24);
    z64eocd.writeBigUInt64LE(BigInt(entries.length), 32);
    z64eocd.writeBigUInt64LE(BigInt(cdSize), 40);
    z64eocd.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    locator.writeUInt32LE(1, 16);
    tailParts.push(z64eocd, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.zip64Eocd ? 0xFFFF : entries.length, 8);
  eocd.writeUInt16LE(opts.zip64Eocd ? 0xFFFF : entries.length, 10);
  eocd.writeUInt32LE(opts.zip64Eocd ? U32 : cdSize, 12);
  eocd.writeUInt32LE(opts.zip64Eocd ? U32 : cdOffset, 16);
  tailParts.push(eocd);

  fs.writeFileSync(filePath, Buffer.concat([...localParts, cd, ...tailParts]));
  return filePath;
}

test('W744 zip-large is wired into direct depth verification', () => {
  const pkg = readJson('package.json');
  const source = read('src/zip-large.js');

  assert.equal(ZIP_LARGE_CONTRACT_VERSION, 'w744-zip-large-v1');
  assert.equal(ZIP_LARGE_LIMITS.max_central_directory_bytes, 64 * 1024 * 1024);
  assert.equal(ZIP_LARGE_LIMITS.read_entry_max_bytes, TWO_GIB_MINUS_1);
  assert.equal(Object.isFrozen(ZIP_LARGE_LIMITS), true);
  assert.equal(
    pkg.scripts['verify:zip-large'],
    'node --test --test-concurrency=1 tests/wave744-zip-large-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:website-status && npm run verify:zip-large && npm run verify:python-onnx-text && npm run verify:fal-backend && npm run verify:vast-backend && npm run verify:browser-extension-popup && npm run verify:langchain-package-manifest && npm run verify:llamaindex-package-manifest && npm run verify:runtime-rs-build-scripts && npm run verify:runtime-rs-wasm-example && npm run verify:distribution-manifests && npm run verify:eval-safety-harnesses && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.match(source, /ZIP_LARGE_LIMITS/);
  assert.match(source, /_verifyCrc/);
  assert.match(source, /maxOutputLength/);
  assert.match(source, /readZip64Extra/);
});

test('W744 reads stored and deflated entries through ZIP64 EOCD and verifies extraction hash', async (t) => {
  const dir = tmpDir(t);
  const zipPath = path.join(dir, 'fixture.kolm');
  const manifest = Buffer.from(JSON.stringify({ task: 'zip-large', version: 1 }));
  const payload = Buffer.from('payload '.repeat(2000));
  writeZip(zipPath, [
    { name: 'manifest.json', data: manifest, forceZip64: true },
    { name: 'nested/payload.bin', data: payload, method: 8, forceZip64: true },
  ], { zip64Eocd: true });

  const listed = listEntriesFromLargeZip(zipPath);
  assert.deepEqual(listed.map((e) => e.name), ['manifest.json', 'nested/payload.bin']);
  assert.equal(listed[0].uncompressed_size, manifest.length);
  assert.equal(listed[0].crc32, crc32(manifest).toString(16).padStart(8, '0'));
  assert.deepEqual(readEntryFromLargeZip(zipPath, 'manifest.json'), manifest);
  assert.deepEqual(readEntryFromLargeZip(zipPath, 'nested/payload.bin'), payload);

  const dest = path.join(dir, 'payload.out');
  const extracted = await extractEntryToFile(zipPath, 'nested/payload.bin', dest, { computeSha256: true });
  assert.deepEqual(extracted, { ok: true, bytes_written: payload.length, sha256: sha256(payload) });
  assert.deepEqual(fs.readFileSync(dest), payload);
});

test('W744 missing entries stay explicit and oversized entries are refused before allocation', async (t) => {
  const dir = tmpDir(t);
  const zipPath = path.join(dir, 'oversized.kolm');
  writeZip(zipPath, [
    {
      name: 'model.gguf',
      data: Buffer.alloc(0),
      forceZip64: true,
      fakeCompSize: 0,
      fakeUncompSize: TWO_GIB_MINUS_1 + 1,
    },
  ], { zip64Eocd: true });

  assert.equal(readEntryFromLargeZip(zipPath, 'absent.json'), null);
  assert.deepEqual(
    await extractEntryToFile(zipPath, 'absent.json', path.join(dir, 'absent.out')),
    { ok: false, reason: 'entry_missing', entry: 'absent.json' },
  );
  assert.throws(
    () => readEntryFromLargeZip(zipPath, 'model.gguf'),
    /use extractEntryToFile\(\) instead/,
  );
});

test('W744 CRC mismatches fail both buffered reads and streamed extraction', async (t) => {
  const dir = tmpDir(t);
  const zipPath = path.join(dir, 'crc.kolm');
  const data = Buffer.from('crc protected bytes');
  writeZip(zipPath, [{ name: 'manifest.json', data, corruptCrc: true }]);

  assert.throws(
    () => readEntryFromLargeZip(zipPath, 'manifest.json'),
    /CRC mismatch/,
  );
  await assert.rejects(
    () => extractEntryToFile(zipPath, 'manifest.json', path.join(dir, 'manifest.out')),
    /CRC mismatch/,
  );
});

test('W744 malformed archives fail before unbounded allocation or unsupported inflation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w744-malformed-'));
  try {
    const hugeCd = path.join(dir, 'huge-cd.zip');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(ZIP_LARGE_LIMITS.max_central_directory_bytes + 1, 12);
    eocd.writeUInt32LE(0, 16);
    fs.writeFileSync(hugeCd, eocd);
    assert.throws(
      () => listEntriesFromLargeZip(hugeCd),
      /central directory is .* exceeding limit/,
    );

    const unsupported = path.join(dir, 'unsupported.zip');
    writeZip(unsupported, [{ name: 'manifest.json', data: Buffer.from('{}'), method: 99 }]);
    assert.throws(
      () => readEntryFromLargeZip(unsupported, 'manifest.json'),
      /unsupported zip compression method 99/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
