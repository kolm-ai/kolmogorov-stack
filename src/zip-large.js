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

const U32_MAX = 0xFFFFFFFF;
const TWO_GIB_MINUS_1 = 2 * 1024 * 1024 * 1024 - 1;

export const ZIP_LARGE_CONTRACT_VERSION = 'w744-zip-large-v1';
export const ZIP_LARGE_LIMITS = Object.freeze({
  eocd_tail_bytes: 65536 + 22,
  max_central_directory_bytes: 64 * 1024 * 1024,
  max_entries: 200000,
  max_entry_name_bytes: 4096,
  read_entry_max_bytes: TWO_GIB_MINUS_1,
  chunk_bytes: 1024 * 1024,
});

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC32_TABLE.length; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC32_TABLE[i] = c >>> 0;
}

// Read a single named entry from a (potentially >4 GiB Zip64) archive.
// Returns the decompressed bytes as a Buffer, or null when the entry is
// missing. Throws when the archive is structurally invalid.
//
// NOTE: this reads the entry's decompressed bytes into a Buffer. For entries
// whose decompressed size exceeds 2 GiB (Trinity-500 model.gguf at 4.68 GB
// is the canonical case), use extractEntryToFile() instead - it streams the
// entry to disk and never holds the full payload in memory.
export function readEntryFromLargeZip(artifactPath, wantName) {
  const fd = fs.openSync(artifactPath, 'r');
  try {
    const loc = locateEntry(fd, wantName);
    if (!loc) return null;
    const safeName = _safeEntryName(wantName);
    if (loc.uncompSize > ZIP_LARGE_LIMITS.read_entry_max_bytes) {
      throw new Error(`entry ${safeName} is ${loc.uncompSize} bytes (>2 GiB); use extractEntryToFile() instead of readEntryFromLargeZip()`);
    }
    if (loc.compSize > ZIP_LARGE_LIMITS.read_entry_max_bytes) {
      throw new Error(`entry ${safeName} compressed payload is ${loc.compSize} bytes (>2 GiB); use extractEntryToFile() instead of readEntryFromLargeZip()`);
    }
    const compBuf = Buffer.alloc(loc.compSize);
    _readExact(fd, compBuf, 0, loc.compSize, loc.dataOffset, `entry data for ${safeName}`);
    let out;
    if (loc.compMethod === 0) out = compBuf;
    else if (loc.compMethod === 8) {
      out = zlib.inflateRawSync(compBuf, { maxOutputLength: Math.max(1, loc.uncompSize) });
    } else {
      throw new Error(`unsupported zip compression method ${loc.compMethod} for ${safeName}`);
    }
    _verifyEntryBytes(out, loc, safeName);
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

// Stream-extract a single named entry to disk. Returns
// { ok, bytes_written, sha256? } on success or { ok:false, reason } when the
// entry is missing. Never holds more than 1 MiB in memory regardless of entry
// size - the canonical use is the 4.68 GB Trinity GGUF.
export async function extractEntryToFile(artifactPath, wantName, destPath, opts = {}) {
  const wantSha = opts && opts.computeSha256 === true;
  const crypto = wantSha ? await import('node:crypto') : null;
  const fd = fs.openSync(artifactPath, 'r');
  let outFd = null;
  try {
    const loc = locateEntry(fd, wantName);
    if (!loc) return { ok: false, reason: 'entry_missing', entry: wantName };
    const safeName = _safeEntryName(wantName);
    outFd = fs.openSync(destPath, 'w');
    const CHUNK = ZIP_LARGE_LIMITS.chunk_bytes;
    const buf = Buffer.alloc(CHUNK);
    const hash = wantSha ? crypto.createHash('sha256') : null;
    let crcState = _crc32Start();
    let written = 0;
    if (loc.compMethod === 0) {
      let remaining = loc.compSize;
      let srcOffset = loc.dataOffset;
      while (remaining > 0) {
        const toRead = Math.min(CHUNK, remaining);
        const got = fs.readSync(fd, buf, 0, toRead, srcOffset);
        if (got <= 0) throw new Error(`entry data for ${safeName} truncated`);
        const slice = buf.subarray(0, got);
        if (written + slice.length > loc.uncompSize) {
          throw new Error(`zip entry size exceeded central directory claim for ${safeName}`);
        }
        fs.writeSync(outFd, slice);
        if (hash) hash.update(slice);
        crcState = _crc32Update(crcState, slice);
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
          if (written + chunk.length > loc.uncompSize) {
            inflater.destroy(new Error(`zip entry size exceeded central directory claim for ${safeName}`));
            return;
          }
          fs.writeSync(outFd, chunk);
          if (hash) hash.update(chunk);
          crcState = _crc32Update(crcState, chunk);
          written += chunk.length;
        });
        inflater.on('end', resolve);
        inflater.on('error', reject);
        (async () => {
          try {
            while (remaining > 0) {
              const toRead = Math.min(CHUNK, remaining);
              const got = fs.readSync(fd, buf, 0, toRead, srcOffset);
              if (got <= 0) throw new Error(`entry data for ${safeName} truncated`);
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
      throw new Error(`unsupported zip compression method ${loc.compMethod} for ${safeName}`);
    }
    if (written !== loc.uncompSize) {
      throw new Error(`zip entry size mismatch for ${safeName}: wrote ${written}, expected ${loc.uncompSize}`);
    }
    _verifyCrc(_crc32Digest(crcState), loc.crc32, safeName);
    return wantSha
      ? { ok: true, bytes_written: written, sha256: hash.digest('hex') }
      : { ok: true, bytes_written: written };
  } finally {
    if (outFd !== null) fs.closeSync(outFd);
    fs.closeSync(fd);
  }
}

// List all entry names + sizes from a (potentially >4 GiB) zip without
// loading any payload bytes. Cheap - walks the central directory only.
export function listEntriesFromLargeZip(artifactPath) {
  const fd = fs.openSync(artifactPath, 'r');
  try {
    const cd = readCentralDirectory(fd);
    const out = [];
    let p = 0;
    for (let i = 0; i < cd.totalEntries; i++) {
      const ent = parseCentralDirectoryEntry(cd.buf, p, i);
      out.push({
        name: ent.name,
        compressed_size: ent.compSize,
        uncompressed_size: ent.uncompSize,
        crc32: _hex32(ent.crc32),
      });
      p = ent.next;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

// --- internals ---

function readCentralDirectory(fd) {
  const fileSize = _safeFileSize(fd);
  const TAIL = Math.min(ZIP_LARGE_LIMITS.eocd_tail_bytes, fileSize);
  const tailOffset = fileSize - TAIL;
  const tail = Buffer.alloc(TAIL);
  _readExact(fd, tail, 0, TAIL, tailOffset, 'zip EOCD tail');
  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw new Error('zip EOCD record not found');
  let cdSize = tail.readUInt32LE(eocdPos + 12);
  let cdOffset = tail.readUInt32LE(eocdPos + 16);
  let totalEntries = tail.readUInt16LE(eocdPos + 10);
  if (cdSize === U32_MAX || cdOffset === U32_MAX || totalEntries === 0xFFFF) {
    const locatorPos = eocdPos - 20;
    if (locatorPos < 0 || tail.readUInt32LE(locatorPos) !== 0x07064b50) {
      throw new Error('zip64 EOCD locator missing on a >4GiB archive');
    }
    const z64EocdOffset = _u64ToSafeNumber(tail, locatorPos + 8, 'zip64 EOCD offset');
    _assertFileRange(z64EocdOffset, 56, fileSize, 'zip64 EOCD record');
    const z64Header = Buffer.alloc(56);
    _readExact(fd, z64Header, 0, 56, z64EocdOffset, 'zip64 EOCD record');
    if (z64Header.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64 EOCD record signature mismatch');
    totalEntries = _u64ToSafeNumber(z64Header, 32, 'zip64 total entries');
    cdSize = _u64ToSafeNumber(z64Header, 40, 'zip64 central directory size');
    cdOffset = _u64ToSafeNumber(z64Header, 48, 'zip64 central directory offset');
  }
  if (totalEntries > ZIP_LARGE_LIMITS.max_entries) {
    throw new Error(`zip central directory has ${totalEntries} entries, exceeding limit ${ZIP_LARGE_LIMITS.max_entries}`);
  }
  if (cdSize > ZIP_LARGE_LIMITS.max_central_directory_bytes) {
    throw new Error(`zip central directory is ${cdSize} bytes, exceeding limit ${ZIP_LARGE_LIMITS.max_central_directory_bytes}`);
  }
  _assertFileRange(cdOffset, cdSize, fileSize, 'zip central directory');
  const buf = Buffer.alloc(cdSize);
  _readExact(fd, buf, 0, cdSize, cdOffset, 'zip central directory');
  return { buf, totalEntries, fileSize };
}

function locateEntry(fd, wantName) {
  if (typeof wantName !== 'string' || wantName.length === 0) {
    throw new Error('zip entry name must be a non-empty string');
  }
  const cd = readCentralDirectory(fd);
  let p = 0;
  for (let i = 0; i < cd.totalEntries; i++) {
    const ent = parseCentralDirectoryEntry(cd.buf, p, i);
    if (ent.name === wantName) {
      const safeName = _safeEntryName(wantName);
      _assertFileRange(ent.localHeaderOffset, 30, cd.fileSize, `local file header for ${safeName}`);
      const lfhFixed = Buffer.alloc(30);
      _readExact(fd, lfhFixed, 0, 30, ent.localHeaderOffset, `local file header for ${safeName}`);
      if (lfhFixed.readUInt32LE(0) !== 0x04034b50) throw new Error(`local file header signature mismatch for ${safeName}`);
      const lfhNameLen = lfhFixed.readUInt16LE(26);
      const lfhExtraLen = lfhFixed.readUInt16LE(28);
      if (lfhNameLen > ZIP_LARGE_LIMITS.max_entry_name_bytes) {
        throw new Error(`local file header entry name too large for ${safeName}`);
      }
      const dataOffset = ent.localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
      _assertFileRange(dataOffset, ent.compSize, cd.fileSize, `entry data for ${safeName}`);
      return {
        compMethod: ent.compMethod,
        compSize: ent.compSize,
        uncompSize: ent.uncompSize,
        crc32: ent.crc32,
        dataOffset,
      };
    }
    p = ent.next;
  }
  return null;
}

function parseCentralDirectoryEntry(buf, p, i) {
  if (p + 46 > buf.length) throw new Error(`central directory entry ${i} truncated`);
  if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central directory entry ${i} bad signature`);
  const compMethod = buf.readUInt16LE(p + 10);
  const crc32 = buf.readUInt32LE(p + 16) >>> 0;
  let compSize = buf.readUInt32LE(p + 20);
  let uncompSize = buf.readUInt32LE(p + 24);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  let localHeaderOffset = buf.readUInt32LE(p + 42);
  if (nameLen > ZIP_LARGE_LIMITS.max_entry_name_bytes) {
    throw new Error(`central directory entry ${i} name is ${nameLen} bytes, exceeding limit ${ZIP_LARGE_LIMITS.max_entry_name_bytes}`);
  }
  const nameStart = p + 46;
  const extraStart = nameStart + nameLen;
  const next = extraStart + extraLen + commentLen;
  if (next > buf.length) throw new Error(`central directory entry ${i} extends beyond central directory`);
  const name = buf.slice(nameStart, extraStart).toString('utf8');
  if (compSize === U32_MAX || uncompSize === U32_MAX || localHeaderOffset === U32_MAX) {
    const z64 = readZip64Extra(buf, extraStart, extraLen, {
      compSize,
      uncompSize,
      localHeaderOffset,
    }, `central directory entry ${i}`);
    compSize = z64.compSize;
    uncompSize = z64.uncompSize;
    localHeaderOffset = z64.localHeaderOffset;
  }
  if (compSize === U32_MAX || uncompSize === U32_MAX || localHeaderOffset === U32_MAX) {
    throw new Error(`zip64 extended information missing for central directory entry ${i}`);
  }
  return { compMethod, crc32, compSize, uncompSize, localHeaderOffset, name, next };
}

function readZip64Extra(buf, extraStart, extraLen, values, context) {
  const extraEnd = extraStart + extraLen;
  if (extraEnd > buf.length) throw new Error(`${context} extra field outside central directory`);
  let ep = extraStart;
  while (ep + 4 <= extraEnd) {
    const tag = buf.readUInt16LE(ep);
    const size = buf.readUInt16LE(ep + 2);
    const bodyStart = ep + 4;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > extraEnd) throw new Error(`${context} extra field truncated`);
    if (tag === 0x0001) {
      let q = bodyStart;
      const out = { ...values };
      if (out.uncompSize === U32_MAX) {
        if (q + 8 > bodyEnd) throw new Error(`${context} zip64 uncompressed size missing`);
        out.uncompSize = _u64ToSafeNumber(buf, q, `${context} zip64 uncompressed size`);
        q += 8;
      }
      if (out.compSize === U32_MAX) {
        if (q + 8 > bodyEnd) throw new Error(`${context} zip64 compressed size missing`);
        out.compSize = _u64ToSafeNumber(buf, q, `${context} zip64 compressed size`);
        q += 8;
      }
      if (out.localHeaderOffset === U32_MAX) {
        if (q + 8 > bodyEnd) throw new Error(`${context} zip64 local header offset missing`);
        out.localHeaderOffset = _u64ToSafeNumber(buf, q, `${context} zip64 local header offset`);
      }
      return out;
    }
    ep = bodyEnd;
  }
  return values;
}

function _safeFileSize(fd) {
  const fileSize = fs.fstatSync(fd).size;
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new Error(`zip file size is not safely representable: ${fileSize}`);
  }
  return fileSize;
}

function _assertFileRange(offset, size, fileSize, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0) {
    throw new Error(`${label} has invalid range offset=${offset} size=${size}`);
  }
  if (offset > fileSize || size > fileSize - offset) {
    throw new Error(`${label} outside file bounds`);
  }
}

function _readExact(fd, buf, offset, length, position, label) {
  let done = 0;
  while (done < length) {
    const got = fs.readSync(fd, buf, offset + done, length - done, position + done);
    if (got <= 0) throw new Error(`${label} truncated`);
    done += got;
  }
}

function _u64ToSafeNumber(buf, offset, label) {
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds JavaScript safe integer range`);
  }
  return Number(value);
}

function _crc32Start() {
  return 0xFFFFFFFF;
}

function _crc32Update(state, chunk) {
  let c = state >>> 0;
  for (let i = 0; i < chunk.length; i++) {
    c = CRC32_TABLE[(c ^ chunk[i]) & 0xFF] ^ (c >>> 8);
  }
  return c >>> 0;
}

function _crc32Digest(state) {
  return (state ^ 0xFFFFFFFF) >>> 0;
}

function _crc32Buffer(buf) {
  return _crc32Digest(_crc32Update(_crc32Start(), buf));
}

function _verifyEntryBytes(buf, loc, safeName) {
  if (buf.length !== loc.uncompSize) {
    throw new Error(`zip entry size mismatch for ${safeName}: got ${buf.length}, expected ${loc.uncompSize}`);
  }
  _verifyCrc(_crc32Buffer(buf), loc.crc32, safeName);
}

function _verifyCrc(actual, expected, safeName) {
  if ((actual >>> 0) !== (expected >>> 0)) {
    throw new Error(`zip entry CRC mismatch for ${safeName}: got ${_hex32(actual)}, expected ${_hex32(expected)}`);
  }
}

function _hex32(n) {
  return (n >>> 0).toString(16).padStart(8, '0');
}

function _safeEntryName(name) {
  return String(name || '')
    .replace(/[\x00-\x1F\x7F]/g, '?')
    .slice(0, 128);
}
