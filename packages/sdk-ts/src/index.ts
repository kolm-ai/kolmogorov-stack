// kolm SDK — one-line embed for .kolm artifacts (TypeScript / JavaScript).
//
// Public surface, intentionally tiny:
//
//   import { load } from "kolm";
//   const m = await load("artifact.kolm");
//   const out = await m.predict("input text");
//
// Anything beyond `load` / `predict` is opt-in via options. The skeleton is
// pure-stdlib (node:crypto + node:fs + node:zlib + jszip-equivalent inline
// reader): no third-party deps, runs in Node ≥ 18 and any bundler that polyfills
// `node:` modules. Browser builds get a thin shim via `loadBuffer`.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync } from "node:zlib";

export const VERSION = "0.1.0";

export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationError";
  }
}

export interface KolmOutput {
  text: string;
  cid?: string;
  credential?: string;
  latency_ms: number;
}

export interface ManifestHashes {
  [path: string]: string;
}

export interface Manifest {
  cid?: string;
  spec?: string;
  hashes?: ManifestHashes;
  task?: string;
  base_model?: string;
  [k: string]: unknown;
}

export interface Receipt {
  signature?: string;
  manifest_cid?: string;
  [k: string]: unknown;
}

export interface LoadOptions {
  // HMAC secret used to verify the receipt body. Optional: when omitted, only
  // CID-vs-hashes consistency is checked. Mirrors the Python SDK contract.
  secret?: string | Buffer;
  // Remote endpoint for `.predict()`. If set, predict() POSTs to
  // `${endpoint}/v1/run` with { artifact_cid, input }. If omitted, predict()
  // throws unless a runtime is wired separately.
  endpoint?: string;
  // Bearer token paired with `endpoint`.
  apiKey?: string;
  // Skip the per-file hash recomputation pass. Use only for trusted local
  // files; the default is to verify every entry against manifest.hashes.
  skipHashCheck?: boolean;
}

// Canonical JSON serializer matching the Node + Python + Rust reference impls.
// Sorted keys at every object level, no whitespace, UTF-8 output. The exact
// byte output is what HMACs are computed over — DO NOT reformat.
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + canonicalJson((obj as Record<string, unknown>)[k]));
  }
  return "{" + parts.join(",") + "}";
}

function sha256Hex(data: Uint8Array | string): string {
  const h = createHash("sha256");
  h.update(data);
  return h.digest("hex");
}

function cidForManifest(manifest: Manifest): string {
  const payload = canonicalJson({ hashes: manifest.hashes ?? {} });
  return "cidv1:sha256:" + sha256Hex(payload);
}

function verifyReceipt(receipt: Receipt, secret: Buffer | undefined): void {
  if (!secret) return;
  const sig = receipt.signature;
  if (typeof sig !== "string" || sig.length === 0) {
    throw new VerificationError("receipt has no signature field");
  }
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(receipt)) {
    if (k !== "signature") body[k] = v;
  }
  const expect = createHmac("sha256", secret).update(canonicalJson(body)).digest();
  const actual = Buffer.from(sig, "hex");
  if (actual.length !== expect.length || !timingSafeEqual(actual, expect)) {
    throw new VerificationError("receipt signature mismatch");
  }
}

// Minimal ZIP central-directory reader. .kolm artifacts are stored uncompressed
// or deflate-compressed; we handle both. Pure-stdlib (zlib's `unzipSync` covers
// deflate). Avoids pulling jszip / adm-zip as runtime deps.
function readZipEntries(buf: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries = new Map<string, Uint8Array>();
  // End-of-central-directory record: scan from tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
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
    // Local file header
    const lhNameLen = view.getUint16(localOff + 26, true);
    const lhExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let content: Uint8Array;
    if (compMethod === 0) {
      content = raw;
    } else if (compMethod === 8) {
      content = unzipSync(raw, { finishFlush: 2 /* Z_SYNC_FLUSH */ });
    } else {
      throw new VerificationError(`unsupported zip compression method ${compMethod} for ${name}`);
    }
    entries.set(name, content);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export class KolmModel {
  readonly cid?: string;
  readonly manifest: Manifest;
  readonly credential?: Record<string, unknown>;
  private readonly endpoint?: string;
  private readonly apiKey?: string;

  constructor(
    manifest: Manifest,
    credential: Record<string, unknown> | undefined,
    endpoint: string | undefined,
    apiKey: string | undefined,
  ) {
    this.manifest = manifest;
    this.cid = manifest.cid;
    this.credential = credential;
    this.endpoint = endpoint;
    this.apiKey = apiKey;
  }

  async predict(input: string): Promise<KolmOutput> {
    const t0 = performance.now();
    if (!this.endpoint) {
      throw new Error(
        "kolm: predict() requires either a remote endpoint or a local runtime. " +
          "Pass { endpoint: 'https://kolm.ai' } to load(), or run `kolm serve --http` and " +
          "pass { endpoint: 'http://127.0.0.1:7411' }.",
      );
    }
    const url = this.endpoint.replace(/\/+$/, "") + "/v1/run";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = "Bearer " + this.apiKey;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ artifact_cid: this.cid, input }),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text); } catch { body = { _raw: text }; }
    if (!res.ok) {
      const msg = typeof body["error"] === "string" ? (body["error"] as string) : `http ${res.status}`;
      throw new Error("kolm.predict: " + msg);
    }
    const out: KolmOutput = {
      text: typeof body["output"] === "string" ? (body["output"] as string) : String(body["output"] ?? ""),
      cid: typeof body["artifact_cid"] === "string" ? (body["artifact_cid"] as string) : this.cid,
      credential: typeof body["credential"] === "string" ? (body["credential"] as string) : undefined,
      latency_ms: performance.now() - t0,
    };
    return out;
  }
}

// Load a .kolm artifact from a filesystem path.
export async function load(pathOrBuffer: string | Uint8Array, options: LoadOptions = {}): Promise<KolmModel> {
  const buf = typeof pathOrBuffer === "string" ? new Uint8Array(await readFile(pathOrBuffer)) : pathOrBuffer;
  return loadBuffer(buf, options);
}

// Browser-safe variant: takes the artifact bytes directly.
export async function loadBuffer(buf: Uint8Array, options: LoadOptions = {}): Promise<KolmModel> {
  const entries = readZipEntries(buf);
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new VerificationError("artifact missing manifest.json");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;

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
      if (!entry) {
        throw new VerificationError(`manifest lists ${name} but artifact does not contain it`);
      }
      const actual = sha256Hex(entry);
      if (actual !== expected) {
        throw new VerificationError(`hash mismatch for ${name}: expected ${expected} actual ${actual}`);
      }
    }
  }

  let credential: Record<string, unknown> | undefined;
  const credBytes = entries.get("credential.json");
  if (credBytes) credential = JSON.parse(new TextDecoder().decode(credBytes));

  const receiptBytes = entries.get("receipt.json");
  if (receiptBytes) {
    const receipt = JSON.parse(new TextDecoder().decode(receiptBytes)) as Receipt;
    const secret = options.secret
      ? (typeof options.secret === "string" ? Buffer.from(options.secret, "utf-8") : options.secret)
      : undefined;
    verifyReceipt(receipt, secret);
  }

  return new KolmModel(manifest, credential, options.endpoint, options.apiKey);
}

// Default export mirrors the Python SDK shape so users can do
// `import kolm from "kolm"; const m = await kolm.load("x.kolm")`.
const _default = { load, loadBuffer, canonicalJson, VERSION, VerificationError, KolmModel };
export default _default;
