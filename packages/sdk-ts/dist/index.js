import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

export const VERSION = "0.2.6";

export class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerificationError";
  }
}

export function canonicalJson(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(obj).sort();
  const parts = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + canonicalJson(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}

function sha256Hex(data) {
  const h = createHash("sha256");
  h.update(data);
  return h.digest("hex");
}

function cidForManifest(manifest) {
  const payload = canonicalJson({ hashes: manifest.hashes ?? {} });
  return "cidv1:sha256:" + sha256Hex(payload);
}

function verifyReceipt(receipt, secret) {
  if (!secret) return;
  const sig = receipt.signature;
  if (typeof sig !== "string" || sig.length === 0) {
    throw new VerificationError("receipt has no signature field");
  }
  const body = {};
  for (const [k, v] of Object.entries(receipt)) {
    if (k !== "signature") body[k] = v;
  }
  const expect = createHmac("sha256", secret).update(canonicalJson(body)).digest();
  const actual = Buffer.from(sig, "hex");
  if (actual.length !== expect.length || !timingSafeEqual(actual, expect)) {
    throw new VerificationError("receipt signature mismatch");
  }
}

function verifyReceiptManifestBinding(receipt, manifest) {
  const receiptCid = typeof receipt.manifest_cid === "string" ? receipt.manifest_cid : null;
  const manifestCid = typeof manifest.cid === "string" ? manifest.cid : null;
  if (receiptCid && !manifestCid) {
    throw new VerificationError("receipt manifest_cid present but manifest has no cid");
  }
  if (receiptCid && manifestCid && receiptCid !== manifestCid) {
    throw new VerificationError(`receipt manifest_cid mismatch: receipt=${receiptCid} manifest=${manifestCid}`);
  }
}

function readZipEntries(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new VerificationError("not a zip: missing end-of-central-directory");
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  let p = cdOffset;
  const end = cdOffset + cdSize;
  while (p < end) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const compMethod = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    const lhNameLen = view.getUint16(localOff + 26, true);
    const lhExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let content;
    if (compMethod === 0) {
      content = raw;
    } else if (compMethod === 8) {
      content = inflateRawSync(raw);
    } else {
      throw new VerificationError(`unsupported zip compression method ${compMethod} for ${name}`);
    }
    entries.set(name, content);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export class KolmModel {
  constructor(manifest, credential, endpoint, apiKey) {
    this.manifest = manifest;
    this.cid = manifest.cid;
    this.credential = credential;
    this.endpoint = endpoint;
    this.apiKey = apiKey;
  }

  async predict(input) {
    const t0 = performance.now();
    if (!this.endpoint) {
      throw new Error(
        "kolm: predict() requires either a remote endpoint or a local runtime. " +
          "Pass { endpoint: 'https://kolm.ai' } to load(), or run `kolm serve --http` and " +
          "pass { endpoint: 'http://127.0.0.1:7411' }."
      );
    }
    const url = this.endpoint.replace(/\/+$/, "") + "/v1/run";
    const headers = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = "Bearer " + this.apiKey;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ artifact_cid: this.cid, input }),
    });
    const text = await res.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { _raw: text };
    }
    if (!res.ok) {
      const msg = typeof body.error === "string" ? body.error : `http ${res.status}`;
      throw new Error("kolm.predict: " + msg);
    }
    return {
      text: typeof body.output === "string" ? body.output : String(body.output ?? ""),
      cid: typeof body.artifact_cid === "string" ? body.artifact_cid : this.cid,
      credential: typeof body.credential === "string" ? body.credential : undefined,
      latency_ms: performance.now() - t0,
    };
  }
}

export async function load(pathOrBuffer, options = {}) {
  const buf = typeof pathOrBuffer === "string" ? new Uint8Array(await readFile(pathOrBuffer)) : pathOrBuffer;
  return loadBuffer(buf, options);
}

export async function loadBuffer(buf, options = {}) {
  const entries = readZipEntries(buf);
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new VerificationError("artifact missing manifest.json");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));

  if (manifest.cid) {
    const recomputed = cidForManifest(manifest);
    if (recomputed !== manifest.cid) {
      throw new VerificationError(`manifest.cid mismatch: declared=${manifest.cid} recomputed=${recomputed}`);
    }
  }

  if (!options.skipHashCheck && manifest.hashes) {
    for (const [name, expected] of Object.entries(manifest.hashes)) {
      if (name === "manifest.json") continue;
      const entry = entries.get(name);
      if (!entry) throw new VerificationError(`manifest lists ${name} but artifact does not contain it`);
      const actual = sha256Hex(entry);
      if (actual !== expected) throw new VerificationError(`hash mismatch for ${name}: expected ${expected} actual=${actual}`);
    }
  }

  let credential;
  const credBytes = entries.get("credential.json");
  if (credBytes) credential = JSON.parse(new TextDecoder().decode(credBytes));

  const receiptBytes = entries.get("receipt.json");
  if (receiptBytes) {
    const receipt = JSON.parse(new TextDecoder().decode(receiptBytes));
    const secret = options.secret
      ? typeof options.secret === "string"
        ? Buffer.from(options.secret, "utf-8")
        : options.secret
      : undefined;
    verifyReceipt(receipt, secret);
    verifyReceiptManifestBinding(receipt, manifest);
  }

  return new KolmModel(manifest, credential, options.endpoint, options.apiKey);
}

const _default = { load, loadBuffer, canonicalJson, VERSION, VerificationError, KolmModel };
export default _default;
