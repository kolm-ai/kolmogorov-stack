// Streaming Zip64 reader for .kolm archives that exceed Node's 2 GiB Buffer
// cap (Trinity-500 Q4_K_M ships ~4.6 GB of GGUF bytes inside the zip).
//
// Shared by:
//   - src/artifact-runner.js   loadArtifact() for large .kolm
//   - src/production-ready.js  manifest + executable-bundle probes
//   - src/deploy-generators.js airgap bundler streaming
//   - cli/kolm.js              `kolm export --format ollama-modelfile` GGUF stage
//
// Why hand-rolled: adm-zip (the rest of the codebase's zip lib) calls
// fs.readFileSync internally and inflates the whole file in memory. yauzl
// would work but adds a runtime dep. The zip spec we need is small:
// EOCD scan -> Zip64 EOCD locator -> Zip64 EOCD record -> central directory
// walk -> local file header -> data offset.

import fs from 'node:fs';
import zlib from 'node:zlib';

// Read a single named entry from a (potentially >4 GiB Zip64) archive.
// Returns the decompressed bytes as a Buffer, or null when the entry is
// missing. Throws when the archive is structurally invalid.
//
// NOTE: this reads the entry's decompressed bytes into a Buffer. For entries
// whose decompressed size exceeds 2 GiB (Trinity-500 model.gguf at 4.68 GB
// is the canonical case), use extractEntryToFile() instead — it streams the
// entry to disk and never holds the full payload in memory.
export function readEntryFromLargeZip(artifactPath, wantName) {
  const fd = fs.openSync(artifactPath, 'r');
  try {
    const loc = locateEntry(fd, wantName);
    if (!loc) return null;
    if (loc.uncompSize > 2 * 1024 * 1024 * 1024 - 1) {
      throw new Error(`entry ${wantName} is ${loc.uncompSize} bytes (>2 GiB); use extractEntryToFile() instead of readEntryFromLargeZip()`);
    }
    const compBuf = Buffer.alloc(loc.compSize);
    fs.readSync(fd, compBuf, 0, loc.compSize, loc.dataOffset);
    if (loc.compMethod === 0) return compBuf;
    if (loc.compMethod === 8) return zlib.inflateRawSync(compBuf);
    throw new Error(`unsupported zip compression method ${loc.compMethod} for ${wantName}`);
  } finally {
    fs.closeSync(fd);
  }
}

// Stream-extract a single named entry to disk. Returns
// { ok, bytes_written, sha256? } on success or { ok:false, reason } when the
// entry is missing. Never holds more than 1 MiB in memory regardless of entry
// size — the canonical use is the 4.68 GB Trinity GGUF.
export async function extractEntryToFile(artifactPath, wantName, destPath, opts = {}) {
  const wantSha = opts && opts.computeSha256 === true;
  const crypto = wantSha ? await import('node:crypto') : null;
  const fd = fs.openSync(artifactPath, 'r');
  let outFd = null;
  try {
    const loc = locateEntry(fd, wantName);
    if (!loc) return { ok: false, reason: 'entry_missing', entry: wantName };
    outFd = fs.openSync(destPath, 'w');
    const CHUNK = 1024 * 1024;
    const buf = Buffer.alloc(CHUNK);
    const hash = wantSha ? crypto.createHash('sha256') : null;
    let written = 0;
    if (loc.compMethod === 0) {
      let remaining = loc.compSize;
      let srcOffset = loc.dataOffset;
      while (remaining > 0) {
        const toRead = Math.min(CHUNK, remaining);
        const got = fs.readSync(fd, buf, 0, toRead, srcOffset);
        if (got <= 0) break;
        const slice = buf.subarray(0, got);
        fs.writeSync(outFd, slice);
        if (hash) hash.update(slice);
        written += got;
        srcOffset += got;
        remaining -= got;
      }
    } else if (loc.compMethod === 8) {
      const inflater = zlib.createInflateRaw();
      let remaining = loc.compSize;
      let srcOffset = loc.dataOffset;
      await new Promise((resolve, reject) => {
        inflater.on('data', (chunk) => {
          fs.writeSync(outFd, chunk);
          if (hash) hash.update(chunk);
          written += chunk.length;
        });
        inflater.on('end', resolve);
        inflater.on('error', reject);
        (async () => {
          try {
            while (remaining > 0) {
              const toRead = Math.min(CHUNK, remaining);
              const got = fs.readSync(fd, buf, 0, toRead, srcOffset);
              if (got <= 0) break;
              if (!inflater.write(buf.subarray(0, got))) {
                await new Promise(r => inflater.once('drain', r));
              }
              srcOffset += got;
              remaining -= got;
            }
            inflater.end();
          } catch (e) {
            inflater.destroy(e);
          }
        })();
      });
    } else {
      throw new Error(`unsupported zip compression method ${loc.compMethod} for ${wantName}`);
    }
    return wantSha
      ? { ok: true, bytes_written: written, sha256: hash.digest('hex') }
      : { ok: true, bytes_written: written };
  } finally {
    if (outFd !== null) fs.closeSync(outFd);
    fs.closeSync(fd);
  }
}

// List all entry names + sizes from a (potentially >4 GiB) zip without
// loading any payload bytes. Cheap — walks the central directory only.
export function listEntriesFromLargeZip(artifactPath) {
  const fd = fs.openSync(artifactPath, 'r');
  try {
    const cd = readCentralDirectory(fd);
    const out = [];
    let p = 0;
    for (let i = 0; i < cd.totalEntries; i++) {
      if (cd.buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central directory entry ${i} bad signature`);
      let compSize = cd.buf.readUInt32LE(p + 20);
      let uncompSize = cd.buf.readUInt32LE(p + 24);
      const nameLen = cd.buf.readUInt16LE(p + 28);
      const extraLen = cd.buf.readUInt16LE(p + 30);
      const commentLen = cd.buf.readUInt16LE(p + 32);
      const name = cd.buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
      if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF) {
        const extraStart = p + 46 + nameLen;
        let ep = extraStart;
        const extraEnd = extraStart + extraLen;
        while (ep + 4 <= extraEnd) {
          const tag = cd.buf.readUInt16LE(ep);
          const size = cd.buf.readUInt16LE(ep + 2);
          if (tag === 0x0001) {
            let q = ep + 4;
            if (uncompSize === 0xFFFFFFFF) { uncompSize = Number(cd.buf.readBigUInt64LE(q)); q += 8; }
            if (compSize === 0xFFFFFFFF) { compSize = Number(cd.buf.readBigUInt64LE(q)); q += 8; }
            break;
          }
          ep += 4 + size;
        }
      }
      out.push({ name, compressed_size: compSize, uncompressed_size: uncompSize });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

// --- internals ---

function readCentralDirectory(fd) {
  const fileSize = fs.fstatSync(fd).size;
  const TAIL = Math.min(65536 + 22, fileSize);
  const tailOffset = fileSize - TAIL;
  const tail = Buffer.alloc(TAIL);
  fs.readSync(fd, tail, 0, TAIL, tailOffset);
  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw new Error('zip EOCD record not found');
  let cdSize = tail.readUInt32LE(eocdPos + 12);
  let cdOffset = tail.readUInt32LE(eocdPos + 16);
  let totalEntries = tail.readUInt16LE(eocdPos + 10);
  if (cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF || totalEntries === 0xFFFF) {
    const locatorPos = eocdPos - 20;
    if (locatorPos < 0 || tail.readUInt32LE(locatorPos) !== 0x07064b50) {
      throw new Error('zip64 EOCD locator missing on a >4GiB archive');
    }
    const z64EocdOffset = Number(tail.readBigUInt64LE(locatorPos + 8));
    const z64Header = Buffer.alloc(56);
    fs.readSync(fd, z64Header, 0, 56, z64EocdOffset);
    if (z64Header.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64 EOCD record signature mismatch');
    totalEntries = Number(z64Header.readBigUInt64LE(32));
    cdSize = Number(z64Header.readBigUInt64LE(40));
    cdOffset = Number(z64Header.readBigUInt64LE(48));
  }
  const buf = Buffer.alloc(cdSize);
  fs.readSync(fd, buf, 0, cdSize, cdOffset);
  return { buf, totalEntries };
}

function locateEntry(fd, wantName) {
  const cd = readCentralDirectory(fd);
  let p = 0;
  for (let i = 0; i < cd.totalEntries; i++) {
    if (cd.buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central directory entry ${i} bad signature`);
    const compMethod = cd.buf.readUInt16LE(p + 10);
    let compSize = cd.buf.readUInt32LE(p + 20);
    let uncompSize = cd.buf.readUInt32LE(p + 24);
    const nameLen = cd.buf.readUInt16LE(p + 28);
    const extraLen = cd.buf.readUInt16LE(p + 30);
    const commentLen = cd.buf.readUInt16LE(p + 32);
    let localHeaderOffset = cd.buf.readUInt32LE(p + 42);
    const name = cd.buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF || localHeaderOffset === 0xFFFFFFFF) {
      const extraStart = p + 46 + nameLen;
      let ep = extraStart;
      const extraEnd = extraStart + extraLen;
      while (ep + 4 <= extraEnd) {
        const tag = cd.buf.readUInt16LE(ep);
        const size = cd.buf.readUInt16LE(ep + 2);
        if (tag === 0x0001) {
          let q = ep + 4;
          if (uncompSize === 0xFFFFFFFF) { uncompSize = Number(cd.buf.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xFFFFFFFF) { compSize = Number(cd.buf.readBigUInt64LE(q)); q += 8; }
          if (localHeaderOffset === 0xFFFFFFFF) { localHeaderOffset = Number(cd.buf.readBigUInt64LE(q)); q += 8; }
          break;
        }
        ep += 4 + size;
      }
    }
    if (name === wantName) {
      const lfhFixed = Buffer.alloc(30);
      fs.readSync(fd, lfhFixed, 0, 30, localHeaderOffset);
      if (lfhFixed.readUInt32LE(0) !== 0x04034b50) throw new Error(`local file header signature mismatch for ${name}`);
      const lfhNameLen = lfhFixed.readUInt16LE(26);
      const lfhExtraLen = lfhFixed.readUInt16LE(28);
      const dataOffset = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
      return { compMethod, compSize, uncompSize, dataOffset };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
