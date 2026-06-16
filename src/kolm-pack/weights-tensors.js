// src/kolm-pack/weights-tensors.js
//
// ATOM: Signed .kolm Artifact Packaging Format -- real quantized weight tensors.
//
// A safetensors-shaped, content-addressed, range-friendly binary container for
// REAL quantized weight tensors. This is what lives in the
// `weights.tensors` slot of a .kolm package. It is NOT a JSON pointer record
// and NOT a placeholder: it carries actual quantized bytes (int8 / int4-packed
// / fp16) with per-tensor scale+zero-point so the tensors can be dequantized
// back to fp32 on load.
//
// Layout (all little-endian; mirrors HF safetensors so existing tooling reads
// the header offset trick, while the body holds quantized blocks):
//
//   [0..8)    u64  header_len N
//   [8..8+N)  utf8 JSON header:
//              {
//                "__format__": "kolm-tensors/1",
//                "__quant__":  "int8" | "int4" | "fp16" | "fp32",
//                "<name>": {
//                   "dtype": "I8"|"U8"|"F16"|"F32",
//                   "shape": [..],
//                   "data_offsets": [begin, end],   // relative to body start
//                   "quant": { "scheme":"int8-affine"|"int4-affine"|"none",
//                              "scale": <f64>, "zero_point": <int>,
//                              "orig_dtype":"F32" }
//                }
//              }
//   [8+N..)   raw tensor bytes, concatenated in header declaration order.
//
// The single `data_offsets` per tensor means a consumer that knows a tensor's
// (header_len, offset, length) can issue ONE HTTP Range request for exactly
// that tensor's bytes -- lazy/partial fetch of a single weight without
// pulling the whole multi-GB slot. quantizeTensor/dequantizeTensor implement
// real affine int8/int4 quantization (per-tensor scale + zero point).
//
// Deterministic: header keys are emitted in a stable order, JSON is canonical
// (sorted within each tensor entry, declaration order preserved across
// tensors), and quantization is a pure function of the input floats -- so the
// same input weights always produce byte-identical blob bytes.
//
// Pure JS, node:crypto only. ASCII only.

import crypto from 'node:crypto';

export const TENSORS_FORMAT = 'kolm-tensors/1';
const HEADER_KEY = '__format__';
const QUANT_KEY = '__quant__';

function isFloatArray(a) {
  return Array.isArray(a) || a instanceof Float32Array || a instanceof Float64Array;
}

// ---- affine quantization -------------------------------------------------
// Real per-tensor symmetric-range affine quantization.
//   scale = (max-min) / (qmax-qmin)
//   zero_point = round(qmin - min/scale)
//   q = clamp(round(x/scale) + zero_point, qmin, qmax)
//   x_hat = scale * (q - zero_point)
// int8: qmin=-128 qmax=127. int4: qmin=-8 qmax=7 (two nibbles per byte).

export function quantizeAffine(floats, bits) {
  const n = floats.length;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = floats[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 0; }
  const qmin = bits === 4 ? -8 : -128;
  const qmax = bits === 4 ? 7 : 127;
  let scale = (max - min) / (qmax - qmin);
  if (!(scale > 0)) scale = 1; // constant tensor: scale=1, zp absorbs the value
  const zero_point = Math.round(qmin - min / scale);
  const q = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let v = Math.round(floats[i] / scale) + zero_point;
    if (v < qmin) v = qmin;
    if (v > qmax) v = qmax;
    q[i] = v;
  }
  return { q, scale, zero_point, qmin, qmax };
}

export function dequantizeAffine(q, scale, zero_point) {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = scale * (q[i] - zero_point);
  return out;
}

// pack int4 nibbles two-per-byte (low nibble = even index). Values are stored
// offset by +8 so the nibble is unsigned 0..15 on disk.
function packInt4(q) {
  const n = q.length;
  const out = Buffer.alloc(Math.ceil(n / 2));
  for (let i = 0; i < n; i++) {
    const nib = (q[i] + 8) & 0x0f;
    const bi = i >> 1;
    if ((i & 1) === 0) out[bi] = nib;
    else out[bi] |= nib << 4;
  }
  return out;
}
function unpackInt4(buf, n) {
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const bi = i >> 1;
    const nib = (i & 1) === 0 ? (buf[bi] & 0x0f) : (buf[bi] >> 4) & 0x0f;
    out[i] = nib - 8;
  }
  return out;
}

function f16FromF32(x) {
  // minimal float32 -> float16 (round-to-nearest-even-ish, sufficient for weights)
  const f = new Float32Array(1); f[0] = x;
  const i = new Int32Array(f.buffer)[0];
  const sign = (i >> 16) & 0x8000;
  let exp = ((i >> 23) & 0xff) - 127 + 15;
  let mant = i & 0x7fffff;
  if (exp <= 0) { return sign; } // flush subnormals to signed zero
  if (exp >= 0x1f) { return sign | 0x7c00; } // inf/overflow
  return sign | (exp << 10) | (mant >> 13);
}
function f16ToF32(h) {
  const sign = (h & 0x8000) << 16;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  let bits;
  if (exp === 0) { bits = sign; }
  else if (exp === 0x1f) { bits = sign | 0x7f800000 | (mant << 13); }
  else { bits = sign | ((exp - 15 + 127) << 23) | (mant << 13); }
  const i = new Int32Array(1); i[0] = bits;
  return new Float32Array(i.buffer)[0];
}

// Build the tensor blob. `tensors` is an ordered array of
//   { name, data: number[]|Float32Array, shape: number[] }
// `quant` is 'int8' | 'int4' | 'fp16' | 'fp32'. Returns a Buffer.
export function buildTensorBlob(tensors, quant = 'int8') {
  if (!Array.isArray(tensors)) throw new Error('buildTensorBlob: tensors must be an array');
  if (!['int8', 'int4', 'fp16', 'fp32'].includes(quant)) {
    throw new Error(`buildTensorBlob: unknown quant ${quant}`);
  }
  const header = { [HEADER_KEY]: TENSORS_FORMAT, [QUANT_KEY]: quant };
  const bodies = [];
  let offset = 0;
  for (const t of tensors) {
    if (!t || typeof t.name !== 'string') throw new Error('tensor needs a string name');
    if (!isFloatArray(t.data)) throw new Error(`tensor ${t.name}: data must be a numeric array`);
    if (!Array.isArray(t.shape)) throw new Error(`tensor ${t.name}: shape must be an array`);
    const floats = t.data;
    const expected = t.shape.reduce((a, b) => a * b, 1);
    if (floats.length !== expected) {
      throw new Error(`tensor ${t.name}: data length ${floats.length} != product(shape) ${expected}`);
    }
    let body, dtype, quantMeta;
    if (quant === 'fp32') {
      body = Buffer.alloc(floats.length * 4);
      for (let i = 0; i < floats.length; i++) body.writeFloatLE(floats[i], i * 4);
      dtype = 'F32';
      quantMeta = { scheme: 'none', scale: 1, zero_point: 0, orig_dtype: 'F32' };
    } else if (quant === 'fp16') {
      body = Buffer.alloc(floats.length * 2);
      for (let i = 0; i < floats.length; i++) body.writeUInt16LE(f16FromF32(floats[i]), i * 2);
      dtype = 'F16';
      quantMeta = { scheme: 'none', scale: 1, zero_point: 0, orig_dtype: 'F32' };
    } else if (quant === 'int8') {
      const { q, scale, zero_point } = quantizeAffine(floats, 8);
      body = Buffer.alloc(q.length);
      for (let i = 0; i < q.length; i++) body.writeInt8(q[i], i);
      dtype = 'I8';
      quantMeta = { scheme: 'int8-affine', scale, zero_point, orig_dtype: 'F32' };
    } else { // int4
      const { q, scale, zero_point } = quantizeAffine(floats, 4);
      body = packInt4(q);
      dtype = 'U8'; // packed nibbles in unsigned bytes
      quantMeta = { scheme: 'int4-affine', scale, zero_point, orig_dtype: 'F32', packed_len: q.length };
    }
    header[t.name] = {
      dtype,
      shape: t.shape.slice(),
      data_offsets: [offset, offset + body.length],
      quant: quantMeta,
    };
    bodies.push(body);
    offset += body.length;
  }
  // Deterministic header: declaration order preserved (tensors[]), special keys
  // first, JSON serialized without extra whitespace.
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(headerJson.length), 0);
  return Buffer.concat([lenBuf, headerJson, ...bodies]);
}

// Parse the header only (cheap; reads first 8 + header_len bytes). Lets a
// consumer learn each tensor's (offset,length) so it can range-fetch a single
// tensor without loading the body.
export function parseTensorHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) throw new Error('tensor blob too short');
  const headerLen = Number(buf.readBigUInt64LE(0));
  if (8 + headerLen > buf.length) throw new Error('tensor header length exceeds blob');
  const header = JSON.parse(buf.slice(8, 8 + headerLen).toString('utf8'));
  if (header[HEADER_KEY] !== TENSORS_FORMAT) {
    throw new Error(`unexpected tensor format ${header[HEADER_KEY]}`);
  }
  return { header, bodyStart: 8 + headerLen };
}

// Dequantize one named tensor back to Float32Array.
export function readTensor(buf, name) {
  const { header, bodyStart } = parseTensorHeader(buf);
  const entry = header[name];
  if (!entry) throw new Error(`tensor ${name} not in blob`);
  const [begin, end] = entry.data_offsets;
  const slice = buf.slice(bodyStart + begin, bodyStart + end);
  const count = entry.shape.reduce((a, b) => a * b, 1);
  if (entry.dtype === 'F32') {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = slice.readFloatLE(i * 4);
    return { data: out, shape: entry.shape, quant: entry.quant };
  }
  if (entry.dtype === 'F16') {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = f16ToF32(slice.readUInt16LE(i * 2));
    return { data: out, shape: entry.shape, quant: entry.quant };
  }
  if (entry.dtype === 'I8') {
    const q = new Int32Array(count);
    for (let i = 0; i < count; i++) q[i] = slice.readInt8(i);
    return { data: dequantizeAffine(q, entry.quant.scale, entry.quant.zero_point), shape: entry.shape, quant: entry.quant };
  }
  // U8 packed int4
  const q = unpackInt4(slice, count);
  return { data: dequantizeAffine(q, entry.quant.scale, entry.quant.zero_point), shape: entry.shape, quant: entry.quant };
}

// Compute the byte range for a tensor within the WHOLE blob -- the input to an
// HTTP Range header for lazy partial fetch.
export function tensorByteRange(buf, name) {
  const { header, bodyStart } = parseTensorHeader(buf);
  const entry = header[name];
  if (!entry) throw new Error(`tensor ${name} not in blob`);
  const [begin, end] = entry.data_offsets;
  return { start: bodyStart + begin, end: bodyStart + end, length: end - begin };
}

export function tensorNames(buf) {
  const { header } = parseTensorHeader(buf);
  return Object.keys(header).filter((k) => k !== HEADER_KEY && k !== QUANT_KEY);
}

export const __test_internals = { f16FromF32, f16ToF32, packInt4, unpackInt4 };
