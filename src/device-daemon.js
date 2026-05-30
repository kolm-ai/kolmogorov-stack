// device-daemon.js — Kolm on-device model update daemon (P2)
//
// Pure Node (no third-party deps). Polls a Kolm gateway for new signed model
// versions, downloads the artifact, and applies it ONLY after an OFFLINE
// ed25519 + sha256 verification passes. An artifact that cannot be verified is
// never written into place — applyUpdate refuses.
//
// Companion to src/model-update-channel.js (publisher side). This module is the
// consumer/edge side and is intentionally self-contained so it can run on a box
// that has nothing but a Node runtime and the model file.
//
// Exports:
//   sha256File(path)                          -> Promise<hex digest>
//   compareSemver(a, b)                       -> -1 | 0 | 1
//   normalizePubkey(pubkey)                   -> crypto.KeyObject (ed25519 public)
//   verifyLocal({ artifact_path, sha256, signature, pubkey, manifest })
//                                             -> { ok, reason }   (NO network)
//   applyUpdate({ signed_url, signature, pubkey, dest_path, sha256,
//                 base, apiKey, fetchImpl })  -> { ok, dest_path, bytes, sha256 }
//   runDaemon({ base, apiKey, model_id, current_version, interval_ms,
//               on_update, fetchImpl })       -> { stop, poll, running }
//   cliDaemon(argv)                           -> Promise<exit code>
//
// Network surface is small and explicit: runDaemon does GET
//   {base}/v1/models/:id/updates
// and applyUpdate does a single GET of the signed artifact URL. verifyLocal
// touches the filesystem and crypto only — never the network.

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';

// SPKI DER prefix for a raw 32-byte ed25519 public key (RFC 8410 §10.1).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// --------------------------------------------------------------------------
// Hashing
// --------------------------------------------------------------------------

/**
 * Stream a file through sha256. Returns the lowercase hex digest.
 * Streaming (not readFileSync) so multi-GB model artifacts don't blow the heap.
 */
export async function sha256File(path) {
  if (!path || typeof path !== 'string') {
    throw new TypeError('sha256File: path must be a string');
  }
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

// --------------------------------------------------------------------------
// Semver compare (mirrors model-update-channel.compareSemver)
// --------------------------------------------------------------------------

/**
 * Compare two semver-ish strings. Missing segments count as 0, so "2.11" is
 * treated as "2.11.0". A pre-release suffix (e.g. -rc1) sorts BEFORE the same
 * core version, matching SemVer §11. Returns -1 | 0 | 1.
 */
export function compareSemver(a, b) {
  const parse = (v) => {
    const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
    const [core, pre = ''] = s.split('-', 2);
    const nums = core.split('.').map((n) => {
      const x = parseInt(n, 10);
      return Number.isFinite(x) ? x : 0;
    });
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] > pb.nums[i]) return 1;
    if (pa.nums[i] < pb.nums[i]) return -1;
  }
  // Equal core: a version WITH a pre-release is lower than one without.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre < pb.pre ? -1 : 1;
}

// --------------------------------------------------------------------------
// Public key normalization
// --------------------------------------------------------------------------

/**
 * Accept an ed25519 public key in any of the common shapes and return a
 * node crypto KeyObject:
 *   - a KeyObject (passed through)
 *   - PEM string ("-----BEGIN PUBLIC KEY-----...")
 *   - raw 32-byte key as 64-char hex
 *   - raw 32-byte key as base64 / base64url (44 chars w/ padding, 43 w/o)
 *   - a 32-byte Buffer/Uint8Array
 */
export function normalizePubkey(pubkey) {
  if (pubkey == null) throw new TypeError('normalizePubkey: pubkey is required');

  // Already a KeyObject?
  if (typeof pubkey === 'object' && typeof pubkey.export === 'function') {
    return pubkey;
  }

  // Raw bytes.
  if (Buffer.isBuffer(pubkey) || pubkey instanceof Uint8Array) {
    return rawToKeyObject(Buffer.from(pubkey));
  }

  if (typeof pubkey !== 'string') {
    throw new TypeError('normalizePubkey: unsupported pubkey type');
  }

  const s = pubkey.trim();
  if (s.includes('BEGIN') && s.includes('KEY')) {
    return createPublicKey(s);
  }

  // 64-char hex => 32 raw bytes.
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    return rawToKeyObject(Buffer.from(s, 'hex'));
  }

  // base64 / base64url of 32 bytes.
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 32) {
    return rawToKeyObject(buf);
  }
  // Some publishers ship the full DER (SPKI) base64 without PEM armor.
  if (buf.length === 44 && buf.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return createPublicKey({ key: buf, format: 'der', type: 'spki' });
  }

  throw new Error('normalizePubkey: could not parse ed25519 public key');
}

function rawToKeyObject(raw32) {
  if (raw32.length !== 32) {
    throw new Error(`ed25519 raw public key must be 32 bytes, got ${raw32.length}`);
  }
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw32]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function decodeSignature(signature) {
  if (Buffer.isBuffer(signature)) return signature;
  if (signature instanceof Uint8Array) return Buffer.from(signature);
  if (typeof signature !== 'string') {
    throw new TypeError('signature must be hex/base64 string or Buffer');
  }
  const s = signature.trim();
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
    return Buffer.from(s, 'hex');
  }
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// --------------------------------------------------------------------------
// OFFLINE verification — the security boundary
// --------------------------------------------------------------------------

// Envelope/transport fields that are NEVER part of the signed bytes: a
// signature cannot cover itself, and download/key metadata is added after
// signing. Stripped from the manifest before canonicalization so a manifest
// that carries its own signature still verifies.
const NON_SIGNED_MANIFEST_FIELDS = new Set([
  'signature',
  'signature_alg',
  'signed_url',
  'url',
  'artifact_url',
  'pubkey',
  'public_key',
  'key_fingerprint',
  'id',
]);

/**
 * Build the deterministic bytes that were signed by the publisher.
 *
 * Two contracts are supported so this interoperates with the sibling publisher
 * (src/model-update-channel.js) regardless of which signing convention it used:
 *
 *   - manifest present: sign over the canonical JSON of the manifest MINUS the
 *     non-signed envelope fields (signature, signed_url, key material, ...).
 *   - manifest absent:  sign over the lowercase sha256 hex of the artifact (the
 *     minimal contract).
 *
 * Kept here so the daemon never depends on a possibly-missing sibling module.
 */
export function signingPayload({ sha256, manifest }) {
  if (manifest && typeof manifest === 'object') {
    const signed = {};
    for (const k of Object.keys(manifest)) {
      if (!NON_SIGNED_MANIFEST_FIELDS.has(k)) signed[k] = manifest[k];
    }
    return Buffer.from(canonicalJSON(signed), 'utf8');
  }
  if (!sha256) {
    throw new Error('signingPayload: need either manifest or sha256');
  }
  return Buffer.from(String(sha256).toLowerCase(), 'utf8');
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJSON(obj) {
  const seen = new WeakSet();
  const norm = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) throw new Error('canonicalJSON: circular reference');
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
    return out;
  };
  return JSON.stringify(norm(obj));
}

/**
 * Verify a downloaded artifact OFFLINE. Does NO network I/O.
 *
 * Checks, in order:
 *   1. the artifact file exists and is non-empty;
 *   2. its sha256 matches the expected digest (if one was provided);
 *   3. the ed25519 signature over the signing payload verifies against pubkey.
 *
 * Returns { ok:true } or { ok:false, reason } — never throws on a verification
 * failure (only on programmer error / bad inputs).
 */
export async function verifyLocal({ artifact_path, sha256, signature, pubkey, manifest } = {}) {
  try {
    if (!artifact_path) return { ok: false, reason: 'missing artifact_path' };
    if (!existsSync(artifact_path)) return { ok: false, reason: 'artifact not found on disk' };

    const st = statSync(artifact_path);
    if (!st.isFile()) return { ok: false, reason: 'artifact path is not a file' };
    if (st.size === 0) return { ok: false, reason: 'artifact is empty' };

    // From the manifest, fall back to its declared digest.
    const expected = (sha256 || manifest?.sha256 || manifest?.artifact_sha256 || '')
      .toString()
      .toLowerCase();

    const actual = await sha256File(artifact_path);
    if (expected) {
      if (actual !== expected) {
        return { ok: false, reason: `sha256 mismatch: expected ${expected}, got ${actual}` };
      }
    }

    const sig = signature || manifest?.signature;
    if (!sig) return { ok: false, reason: 'missing signature' };
    if (!pubkey) return { ok: false, reason: 'missing pubkey' };

    let keyObj;
    try {
      keyObj = normalizePubkey(pubkey);
    } catch (e) {
      return { ok: false, reason: `bad pubkey: ${e.message}` };
    }

    // Sign over the manifest if we have one, else over the (now-verified) digest.
    const payload = signingPayload({ sha256: actual, manifest });
    let sigBuf;
    try {
      sigBuf = decodeSignature(sig);
    } catch (e) {
      return { ok: false, reason: `bad signature encoding: ${e.message}` };
    }

    const good = edVerify(null, payload, keyObj, sigBuf);
    if (!good) return { ok: false, reason: 'ed25519 signature verification failed' };

    return { ok: true, reason: 'verified', sha256: actual };
  } catch (err) {
    return { ok: false, reason: `verify error: ${err.message}` };
  }
}

// --------------------------------------------------------------------------
// Download + apply
// --------------------------------------------------------------------------

function resolveFetch(fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') {
    throw new Error('no fetch implementation available (Node >=18 or pass fetchImpl)');
  }
  return f;
}

function authHeaders(apiKey, extra) {
  const h = { ...(extra || {}) };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/**
 * Download a signed artifact, verify it OFFLINE, and only then move it into
 * place atomically. Refuses to apply (throws) if verification fails — the
 * unverified temp file is removed.
 *
 * The ONLY network call here is the GET of signed_url. Verification is offline.
 */
export async function applyUpdate({
  signed_url,
  signature,
  pubkey,
  dest_path,
  sha256,
  manifest,
  base,
  apiKey,
  fetchImpl,
} = {}) {
  if (!signed_url) throw new Error('applyUpdate: signed_url is required');
  if (!dest_path) throw new Error('applyUpdate: dest_path is required');
  if (!signature && !manifest?.signature) throw new Error('applyUpdate: signature is required');
  if (!pubkey) throw new Error('applyUpdate: pubkey is required');

  const fetch = resolveFetch(fetchImpl);

  const destDir = dirname(dest_path);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

  // Stage in a sibling temp dir, never under the live dest name.
  const stagingDir = existsSync(destDir) ? destDir : tmpdir();
  const tmpPath = join(
    stagingDir,
    `.kolm-update-${basename(dest_path)}-${process.pid}-${Date.now()}.part`,
  );

  // --- network: download to temp ---
  let bytes = 0;
  try {
    const res = await fetch(signed_url, { headers: authHeaders(apiKey) });
    if (!res || !res.ok) {
      const code = res ? res.status : 'no-response';
      throw new Error(`download failed: HTTP ${code}`);
    }
    if (!res.body) {
      // Fallback for fetch impls without a stream body.
      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      const ws = createWriteStream(tmpPath);
      await new Promise((resolve, reject) => {
        ws.on('error', reject);
        ws.on('finish', resolve);
        ws.end(buf);
      });
      bytes = buf.length;
    } else {
      const ws = createWriteStream(tmpPath);
      await pipeline(res.body, ws);
      bytes = statSync(tmpPath).size;
    }
  } catch (err) {
    safeRm(tmpPath);
    throw new Error(`applyUpdate download error: ${err.message}`);
  }

  // --- OFFLINE verification BEFORE writing into place ---
  const v = await verifyLocal({
    artifact_path: tmpPath,
    sha256: sha256 || manifest?.sha256,
    signature: signature || manifest?.signature,
    pubkey,
    manifest,
  });
  if (!v.ok) {
    safeRm(tmpPath);
    throw new Error(`applyUpdate refused: unverified artifact (${v.reason})`);
  }

  // --- atomic swap into place ---
  try {
    renameSync(tmpPath, dest_path);
  } catch (err) {
    safeRm(tmpPath);
    throw new Error(`applyUpdate install error: ${err.message}`);
  }

  return { ok: true, dest_path, bytes, sha256: v.sha256 };
}

function safeRm(p) {
  try {
    rmSync(p, { force: true });
  } catch {
    /* best effort */
  }
}

// --------------------------------------------------------------------------
// Polling daemon
// --------------------------------------------------------------------------

/**
 * One poll: ask the gateway whether a version newer than current_version exists.
 * Returns { update, manifest } where update is the chosen newer manifest (or
 * null). Tolerates either an envelope { update, manifest } or a bare list of
 * versions from the endpoint.
 */
export async function pollOnce({ base, apiKey, model_id, current_version, fetchImpl } = {}) {
  if (!base) throw new Error('pollOnce: base is required');
  if (!model_id) throw new Error('pollOnce: model_id is required');
  const fetch = resolveFetch(fetchImpl);

  const url = `${String(base).replace(/\/+$/, '')}/v1/models/${encodeURIComponent(model_id)}/updates`;
  const res = await fetch(url, {
    headers: authHeaders(apiKey, { Accept: 'application/json' }),
  });
  if (!res || !res.ok) {
    const code = res ? res.status : 'no-response';
    throw new Error(`updates check failed: HTTP ${code}`);
  }
  const body = await res.json();

  // Normalize to a candidate manifest list.
  let candidates = [];
  if (Array.isArray(body)) candidates = body;
  else if (Array.isArray(body.versions)) candidates = body.versions;
  else if (body.update) candidates = [body.update];
  else if (body.manifest) candidates = [body.manifest];

  let best = null;
  for (const m of candidates) {
    const v = m?.version ?? m?.model_version;
    if (v == null) continue;
    if (compareSemver(v, current_version) > 0) {
      if (!best || compareSemver(v, best.version ?? best.model_version) > 0) best = m;
    }
  }

  return { update: best, manifest: best, latest: best?.version ?? best?.model_version ?? current_version };
}

/**
 * Long-running poll loop. Calls on_update(manifest, helpers) whenever a newer
 * version appears. Returns a controller:
 *   { stop(): void, poll(): Promise<result>, get running(): boolean }
 *
 * on_update receives { manifest, applyUpdate, current_version } so the caller
 * can decide whether/where to install. The daemon NEVER auto-installs; applying
 * is always an explicit caller decision (and always goes through the offline
 * verification in applyUpdate).
 */
export function runDaemon({
  base,
  apiKey,
  model_id,
  current_version,
  interval_ms = 60 * 60 * 1000,
  on_update,
  on_error,
  fetchImpl,
  immediate = true,
} = {}) {
  if (!base) throw new Error('runDaemon: base is required');
  if (!model_id) throw new Error('runDaemon: model_id is required');

  let cur = current_version || '0.0.0';
  let timer = null;
  let running = true;
  let inFlight = false;

  const doPoll = async () => {
    if (!running || inFlight) return null;
    inFlight = true;
    try {
      const result = await pollOnce({ base, apiKey, model_id, current_version: cur, fetchImpl });
      if (result.update && typeof on_update === 'function') {
        await on_update(result.update, {
          applyUpdate: (opts) => applyUpdate({ base, apiKey, fetchImpl, ...opts }),
          current_version: cur,
        });
      }
      return result;
    } catch (err) {
      if (typeof on_error === 'function') on_error(err);
      else process.emitWarning(`runDaemon poll error: ${err.message}`);
      return null;
    } finally {
      inFlight = false;
    }
  };

  const schedule = () => {
    if (!running) return;
    timer = setTimeout(async () => {
      await doPoll();
      schedule();
    }, interval_ms);
    if (typeof timer.unref === 'function') timer.unref();
  };

  if (immediate) {
    // Kick off an initial poll, then start the interval.
    doPoll().finally(schedule);
  } else {
    schedule();
  }

  return {
    poll: doPoll,
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    setCurrentVersion(v) {
      cur = v;
    },
    get running() {
      return running;
    },
  };
}

// --------------------------------------------------------------------------
// Thin CLI
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      a[key] = true; // boolean flag
    } else {
      a[key] = next;
      i++;
    }
  }
  return a;
}

const USAGE = `kolm device-daemon — poll for + verify on-device model updates

Usage:
  kolm device-daemon --base <url> --model <id> --version <semver> [options]

Options:
  --base <url>          Kolm gateway base URL (required)
  --api-key <key>       API key (or set KOLM_API_KEY)
  --model <id>          model id to watch (required)
  --version <semver>    current installed version (default 0.0.0)
  --interval <ms>       poll interval in ms (default 3600000)
  --dest <path>         where to install a verified artifact (enables auto-apply)
  --pubkey <hex|b64|pem> ed25519 public key for offline verification
  --once                check a single time and exit
  --help                show this help

Notes:
  An update is only ever written to --dest after an OFFLINE ed25519 + sha256
  check passes. Unverified artifacts are refused and discarded.`;

/**
 * CLI entrypoint. Returns a process exit code (0 ok, 1 error, 2 usage).
 * Does not call process.exit so it stays testable.
 */
export async function cliDaemon(argv = []) {
  const args = parseArgs(argv);

  if (args.help || argv.length === 0) {
    process.stdout.write(USAGE + '\n');
    return argv.length === 0 ? 2 : 0;
  }

  const base = args.base;
  const model_id = args.model || args['model-id'];
  if (!base || !model_id) {
    process.stderr.write('error: --base and --model are required\n\n' + USAGE + '\n');
    return 2;
  }

  const apiKey = args['api-key'] || process.env.KOLM_API_KEY || '';
  const current_version = args.version || '0.0.0';
  const interval_ms = args.interval ? Number(args.interval) : 60 * 60 * 1000;
  const dest_path = args.dest || null;
  const pubkey = args.pubkey || process.env.KOLM_UPDATE_PUBKEY || null;

  const handleUpdate = async (manifest, { applyUpdate: apply }) => {
    const v = manifest.version ?? manifest.model_version;
    process.stdout.write(`update available: ${model_id} ${current_version} -> ${v}\n`);
    if (!dest_path) {
      process.stdout.write('  (no --dest; not installing)\n');
      return;
    }
    if (!pubkey) {
      process.stderr.write('  refusing to install: no --pubkey for offline verification\n');
      return;
    }
    const url = manifest.signed_url || manifest.url || manifest.artifact_url;
    if (!url) {
      process.stderr.write('  refusing to install: manifest has no signed_url\n');
      return;
    }
    try {
      const r = await apply({
        signed_url: url,
        signature: manifest.signature,
        sha256: manifest.sha256 || manifest.artifact_sha256,
        manifest,
        pubkey,
        dest_path,
      });
      process.stdout.write(`  installed ${r.bytes} bytes -> ${r.dest_path} (sha256 ${r.sha256})\n`);
    } catch (e) {
      process.stderr.write(`  install refused: ${e.message}\n`);
    }
  };

  if (args.once) {
    try {
      const result = await pollOnce({ base, apiKey, model_id, current_version });
      if (result.update) {
        await handleUpdate(result.update, {
          applyUpdate: (opts) => applyUpdate({ base, apiKey, ...opts }),
        });
      } else {
        process.stdout.write(`up to date: ${model_id} @ ${current_version}\n`);
      }
      return 0;
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
  }

  process.stdout.write(
    `kolm device-daemon watching ${model_id} @ ${current_version} every ${interval_ms}ms\n`,
  );
  const ctrl = runDaemon({
    base,
    apiKey,
    model_id,
    current_version,
    interval_ms,
    on_update: handleUpdate,
    on_error: (e) => process.stderr.write(`poll error: ${e.message}\n`),
  });

  // Keep the process alive until signalled.
  await new Promise((resolve) => {
    const shutdown = () => {
      ctrl.stop();
      process.stdout.write('device-daemon stopped\n');
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  return 0;
}

// Allow `node src/device-daemon.js ...` to run the CLI directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('device-daemon.js')) {
  cliDaemon(process.argv.slice(2)).then((code) => process.exit(code));
}
