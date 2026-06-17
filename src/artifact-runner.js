// .kolm artifact runner - opens a signed zip, verifies the signature, and
// executes one of its recipes against a given input. This is the "Run" leg
// of the four-engine compose: every other engine has fed forward; this is
// the one that actually emits an output for an end-user input.
//
// Hard limits (v0.1):
//   - input payload     : 1 MiB
//   - per-recipe timeout: 1000 ms (cooperative)
//   - max recipes tried : artifact-defined (no upper bound, but each is timed)
//
// Errors carry a stable `code` so MCP clients and SDKs can branch on them:
//   KOLM_E_INPUT_TOO_LARGE   - input bytes exceeded MAX_INPUT_BYTES
//   KOLM_E_NO_RECIPES        - artifact has zero executable recipes
//   KOLM_E_NO_RECIPE_HANDLED - all recipes threw or timed out
//   KOLM_E_RECIPE_TIMEOUT    - a recipe exceeded the per-call timeout
//   KOLM_E_SIGNATURE_INVALID - signature failed to verify (thrown from loadArtifact)
//
// Usage from JS:
//   const r = await runArtifact('./support-triage.kolm', { text: '...' })
//   // r = { output, recipe_id, latency_us, k_score, receipt, audit }
//
// Usage from CLI:
//   kolm run support-triage.kolm '{"text":"..."}'

import AdmZip from 'adm-zip';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileJs } from './verifier.js';
import { readEntryFromLargeZip, listEntriesFromLargeZip, extractEntryToFile } from './zip-large.js';
import { verifyManifestSignature, decodePack, decodeIndex } from './artifact.js';
import { scoreCase } from './case-scorer.js';
import { runWasmTarget } from './runners/wasm-runner.js';
import { runNativeTarget } from './runners/native-runner.js';
import { runGgufTarget, ggufRuntimeAvailable } from './runners/gguf-runner.js';
import { runOnnxTarget, onnxRuntimeConfigAvailable } from './runners/onnx-runner.js';
import { verifySignatureBlock as verifyEd25519Block } from './ed25519.js';
import { canonicalJson } from './cid.js';
import { ragLibFor } from './rag.js';
import { estimateTokens } from './optimization.js';

// W287 - supported runtime_target values for dispatchRuntime. The historical
// default is 'js' (every artifact built before W287 had no runtime_target
// field, which decodes to 'js' for back-compat). The other four route to
// per-target runners in src/runners/. Any value outside this set throws
// KOLM_E_UNSUPPORTED_RUNTIME at dispatch time (loadArtifact does NOT throw;
// structural load is independent of executability so a binder can still
// inspect a manifest whose runner is unavailable on this host).
export const SUPPORTED_RUNTIME_TARGETS = Object.freeze(['js', 'wasm', 'native', 'gguf', 'onnx']);

const MAX_INPUT_BYTES = 1024 * 1024;          // 1 MiB
const DEFAULT_TIMEOUT_MS = 1000;              // 1 s per recipe
const MAX_AUDIT_INPUT_PREVIEW = 200;

// Cloud-trusted artifacts (HMAC verify workaround). Cloud-built .kolms are
// signed with the server's RECIPE_RECEIPT_SECRET which the local CLI does not
// possess - so local HMAC verify would fail with KOLM_E_SIGNATURE_INVALID.
// When `kolm compile` (cloud path) downloads an artifact, it records the
// downloaded file's sha256 in ~/.kolm/cloud-trusted.json. loadArtifact()
// honors that trust list: structural integrity is still checked (manifest_hash
// must bind to the signature payload's claimed manifest_hash, and the
// signature must have the expected shape) but the HMAC step is skipped.
// Users can re-verify any time via `kolm verify --remote` once that is wired.
// Env override: KOLM_TRUST_CLOUD_ARTIFACTS=0 disables this fallback (strict
// mode). KOLM_TRUST_CLOUD_ARTIFACTS=1 (default) keeps the fallback.
// Wave 253 sec#14: cloud-trust file used to be `{trusted: {sha: {meta}}}`. Two
// problems with that: (1) an attacker with write to ~/.kolm could insert any
// sha + bytes pair and the file content was the only "proof"; (2) two-arg
// callers (sha, bytes) had no clean shape to write. New shape carries an
// HMAC over (sha + recorded_at + bytes) using a machine-local secret in
// ~/.kolm/cloud-trust.secret (mode 0600). Tampering with any field
// invalidates the entry. File shape:
//   { version: 2, entries: [{ sha, recorded_at, bytes, hmac }, ...] }
// Old `{trusted:{}}` files are still readable via the back-compat loader so
// existing installs don't lose their trust list - but pre-W253 entries are
// considered unverifiable and not honored unless KOLM_TRUST_CLOUD_LEGACY=1
// is set explicitly.
const CLOUD_TRUST_PATH = path.join(os.homedir(), '.kolm', 'cloud-trusted.json');
const CLOUD_TRUST_SECRET_PATH = path.join(os.homedir(), '.kolm', 'cloud-trust.secret');

function getOrCreateTrustSecret() {
  try {
    if (fs.existsSync(CLOUD_TRUST_SECRET_PATH)) {
      const s = fs.readFileSync(CLOUD_TRUST_SECRET_PATH, 'utf8').trim();
      if (s && s.length >= 32) return s;
    }
    const fresh = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(CLOUD_TRUST_SECRET_PATH), { recursive: true });
    fs.writeFileSync(CLOUD_TRUST_SECRET_PATH, fresh, 'utf8');
    try { fs.chmodSync(CLOUD_TRUST_SECRET_PATH, 0o600); } catch {} // deliberate: cleanup
    return fresh;
  } catch {
    // Memory fallback if we can't write - entries from this session aren't
    // persistable but at least won't crash callers.
    return 'kolm-fallback-' + crypto.randomBytes(16).toString('hex');
  }
}

function hmacEntry(sha, recorded_at, bytes) {
  const secret = getOrCreateTrustSecret();
  const h = crypto.createHmac('sha256', secret);
  h.update(String(sha) + '\n' + String(recorded_at) + '\n' + String(bytes));
  return h.digest('hex');
}

function loadCloudTrust() {
  try {
    if (!fs.existsSync(CLOUD_TRUST_PATH)) return { version: 2, entries: [] };
    const j = JSON.parse(fs.readFileSync(CLOUD_TRUST_PATH, 'utf8'));
    if (Array.isArray(j)) return { version: 2, entries: j };
    if (j && Array.isArray(j.entries)) return { version: j.version || 2, entries: j.entries };
    // Legacy `{trusted: {sha: {meta}}}` shape - migrate in memory but do not
    // persist HMACs we can't recompute (no original `recorded_at` match).
    if (j && j.trusted && typeof j.trusted === 'object') {
      const entries = [];
      for (const [sha, meta] of Object.entries(j.trusted)) {
        entries.push({
          sha,
          recorded_at: meta && meta.recorded_at || null,
          bytes: meta && meta.bytes || null,
          legacy: true,
        });
      }
      return { version: 1, entries };
    }
    return { version: 2, entries: [] };
  } catch { return { version: 2, entries: [] }; }
}

function persistTrust(j) {
  fs.mkdirSync(path.dirname(CLOUD_TRUST_PATH), { recursive: true });
  fs.writeFileSync(CLOUD_TRUST_PATH, JSON.stringify({ version: 2, entries: j.entries }, null, 2));
  try { fs.chmodSync(CLOUD_TRUST_PATH, 0o600); } catch {} // deliberate: cleanup
}

// recordCloudTrusted now supports both call shapes:
//   recordCloudTrusted(sha, bytes)                       <- W253 ML#14 + audit
//   recordCloudTrusted(artifactPath, { ... })            <- legacy callers
// In both shapes we end up with (sha, recorded_at, bytes) which we HMAC and
// append to the entries array.
export function recordCloudTrusted(arg1, arg2 = {}) {
  let sha, bytes;
  try {
    if (typeof arg1 === 'string' && /^(sha256:)?[0-9a-f]{32,}$/i.test(arg1)) {
      sha = arg1.startsWith('sha256:') ? arg1.slice(7) : arg1;
      bytes = typeof arg2 === 'number' ? arg2 : (arg2 && typeof arg2.bytes === 'number' ? arg2.bytes : 0);
    } else if (typeof arg1 === 'string') {
      const buf = fs.readFileSync(arg1);
      sha = crypto.createHash('sha256').update(buf).digest('hex');
      bytes = buf.length;
    } else {
      return null;
    }
    const recorded_at = new Date().toISOString();
    const hmac = hmacEntry(sha, recorded_at, bytes);
    const j = loadCloudTrust();
    j.entries = (j.entries || []).filter(e => e.sha !== sha);
    j.entries.push({ sha, recorded_at, bytes, hmac });
    persistTrust(j);
    return sha;
  } catch {
    return null;
  }
}

// isCloudTrusted accepts EITHER an artifact Buffer OR a string sha. Returns
// true on a verified hit, false on miss or tamper. An entry is "verified"
// only when the on-disk hmac matches a fresh HMAC over its (sha, recorded_at,
// bytes). This prevents an attacker who can write the JSON (but not the
// secret file at mode 0600) from inserting trust entries.
export function isCloudTrusted(input) {
  const flag = process.env.KOLM_TRUST_CLOUD_ARTIFACTS;
  if (flag === '0' || flag === 'false') return false;
  try {
    let sha;
    if (Buffer.isBuffer(input)) {
      sha = crypto.createHash('sha256').update(input).digest('hex');
    } else if (typeof input === 'string') {
      sha = input.startsWith('sha256:') ? input.slice(7) : input;
    } else {
      return false;
    }
    const j = loadCloudTrust();
    for (const e of (j.entries || [])) {
      if (e.sha !== sha) continue;
      if (e.legacy) {
        if (process.env.KOLM_TRUST_CLOUD_LEGACY === '1') return true;
        return false;
      }
      if (!e.hmac) return false;
      const expected = hmacEntry(e.sha, e.recorded_at, e.bytes);
      if (crypto.timingSafeEqual(Buffer.from(e.hmac, 'hex'), Buffer.from(expected, 'hex'))) {
        return true;
      }
      return false;
    }
    return false;
  } catch { return false; }
}

// Convenience wrapper: returns the sha of the artifact at `artifactPath`
// if it is in the cloud-trust list, else null. Used by the verifier so the
// deeper HMAC checks (audit chain, credential) can switch to structural
// integrity mode without duplicating the file-read + sha logic.
export function isArtifactPathCloudTrusted(artifactPath) {
  try {
    const buf = fs.readFileSync(artifactPath);
    return isCloudTrusted(buf);
  } catch { return null; }
}

// Structural-integrity check used when HMAC verification fails but the
// artifact is in the cloud-trust list. Confirms the signature envelope is
// shaped correctly and that manifest_hash inside it matches the actual
// manifest bytes. This is NOT a cryptographic verification - it ensures the
// artifact bytes you have on disk are the bytes whose sha256 was trusted.
function structuralIntegrityOk(manifest_json, signature) {
  try {
    const sig = typeof signature === 'string' ? JSON.parse(signature) : signature;
    if (!sig || typeof sig !== 'object') return { ok: false, reason: 'signature not an object' };
    if (!sig.spec || !sig.hmac || !sig.manifest_hash) return { ok: false, reason: 'signature missing required fields' };
    const manifest_hash = crypto.createHash('sha256').update(Buffer.from(manifest_json)).digest('hex');
    if (manifest_hash !== sig.manifest_hash) return { ok: false, reason: 'manifest_hash mismatch' };
    return { ok: true };
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
}

// W481 - Ed25519 structural-integrity fallback. Used when HMAC verification
// fails (caller does not hold the matching RECIPE_RECEIPT_SECRET) AND the
// artifact is not in the local cloud-trust list. This is the path that lets
// PUBLISHED artifacts (marketplace, fleet-shared, registry-pack) verify on
// any host: the receipt carries its own Ed25519 public key + signature, so a
// verifier can confirm "the holder of THIS key signed THIS receipt body"
// without a shared secret. Returns ok when:
//   (a) the signature envelope binds to the manifest bytes (manifest_hash),
//   (b) receipt.json exists and carries a signature_ed25519 block, AND
//   (c) the Ed25519 signature verifies against the canonical receipt body
//       (stripped of signature_ed25519 + signature_sigstore, matching the
//       sign-time canonicalization in src/artifact.js).
// This is structural integrity - it proves the receipt has not been mangled
// since signing - but it does NOT claim the signing key is the original kolm
// builder's key. binder.js check #17 ("Signature policy (Ed25519)") is where
// callers opt in to the stronger "must be signed by Ed25519" policy gate.
function ed25519IntegrityOk(manifest_json, signature, receipt_json) {
  try {
    const integrity = structuralIntegrityOk(manifest_json, signature);
    if (!integrity.ok) return integrity;
    if (!receipt_json) {
      return { ok: false, reason: 'no receipt.json found - Ed25519 fallback requires a v0.1+ receipt block' };
    }
    let receipt;
    try { receipt = JSON.parse(receipt_json); }
    catch (e) { return { ok: false, reason: `receipt JSON parse failed: ${e.message}` }; }
    if (!receipt || typeof receipt !== 'object' || !receipt.signature_ed25519) {
      return { ok: false, reason: 'receipt has no signature_ed25519 block - re-sign with Ed25519 (unset KOLM_ED25519_DISABLE) or set RECIPE_RECEIPT_SECRET locally to match the issuer' };
    }
    // Match the sign-time canonicalization (src/artifact.js + binder.js check
    // #5): Ed25519 was signed over canonical(receipt WITH HMAC, WITHOUT
    // ed25519 + sigstore blocks). Strip both before verifying.
    const { signature_ed25519, signature_sigstore, ...payload } = receipt;
    void signature_sigstore;
    const result = verifyEd25519Block(signature_ed25519, canonicalJson(payload));
    if (!result.ok) return { ok: false, reason: `Ed25519 verification failed: ${result.reason}` };
    return { ok: true, key_fingerprint: result.key_fingerprint };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

function kolmError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function inputBytes(input) {
  if (input == null) return 0;
  if (typeof input === 'string') return Buffer.byteLength(input, 'utf8');
  try { return Buffer.byteLength(JSON.stringify(input), 'utf8'); }
  catch { return Number.POSITIVE_INFINITY; }
}

function previewInput(input) {
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    return s.length > MAX_AUDIT_INPUT_PREVIEW ? s.slice(0, MAX_AUDIT_INPUT_PREVIEW) + '…' : s;
  } catch { return '[unserializable]'; }
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Streaming sha256 for files larger than the 2 GiB Buffer cap (Trinity-500
// Q4_K_M is ~4.6 GB). Reads in 1 MiB chunks so memory stays bounded.
function streamSha256Hex(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const CHUNK = 1024 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let offset = 0;
    while (true) {
      const got = fs.readSync(fd, buf, 0, CHUNK, offset);
      if (got <= 0) break;
      hash.update(buf.subarray(0, got));
      offset += got;
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

// Open a .kolm and return its contents as a structured bundle. Verifies the
// signature by default; verifier-report callers can opt into a lenient load so
// signature-invalid artifacts still produce explicit failing evidence rows.
//
// W891 2 GiB branch:
//   When the file exceeds Node's 2 GiB Buffer cap (Trinity-500 Q4_K_M is
//   ~4.6 GB), we cannot fs.readFileSync the whole archive. We switch to the
//   streaming Zip64 reader (src/zip-large.js): small structural entries
//   (manifest/recipes/signature/evals/receipt/lora.bin/index.sqlite-vec) are
//   read into Buffers as before, but oversized entries (model.gguf) are
//   declared in `large_entries` instead. Callers (gguf-runner) reach those
//   entries via the streaming extractor on the returned `artifact_path`.
const TWO_GIB_MINUS_1 = 2 * 1024 * 1024 * 1024 - 1;
const STREAM_ENTRY_THRESHOLD = TWO_GIB_MINUS_1;

export function loadArtifact(artifactPath, opts = {}) {
  const allowInvalidSignature = opts && opts.allowInvalidSignature === true;
  const fileSize = fs.statSync(artifactPath).size;
  const useStreaming = fileSize > TWO_GIB_MINUS_1;

  let entries;
  let largeEntries;
  let fileBuf = null;  // hoisted: cloud-trust fallback at line ~386 needs this for the non-streaming branch.
  if (useStreaming) {
    const listed = listEntriesFromLargeZip(artifactPath);
    entries = {};
    largeEntries = {};
    for (const e of listed) {
      if (e.uncompressed_size > STREAM_ENTRY_THRESHOLD) {
        largeEntries[e.name] = { uncompressed_size: e.uncompressed_size, compressed_size: e.compressed_size };
        continue;
      }
      const buf = readEntryFromLargeZip(artifactPath, e.name);
      if (buf) entries[e.name] = buf;
    }
  } else {
    fileBuf = fs.readFileSync(artifactPath);
    const zip = new AdmZip(fileBuf);
    entries = Object.fromEntries(zip.getEntries().map(e => [e.entryName, e.getData()]));
    largeEntries = {};
  }

  const required = ['manifest.json', 'recipes.json', 'signature.sig'];
  for (const f of required) {
    if (!entries[f]) throw new Error(`malformed .kolm: missing ${f}`);
  }

  const manifest_json = entries['manifest.json'].toString('utf8');
  const recipes_json = entries['recipes.json'].toString('utf8');
  const signature = entries['signature.sig'].toString('utf8');
  const evals_json = entries['evals.json']?.toString('utf8') || null;
  const receipt_json = entries['receipt.json']?.toString('utf8') || null;
  const model_pointer = entries['model.gguf'] && entries['model.gguf'].length < 64 * 1024
    ? entries['model.gguf'].toString('utf8')
    : null;

  // Verify HMAC locally first. This works for offline-compiled artifacts
  // (signed with the per-user local_receipt_secret) and for fleet-shared
  // artifacts (signed with the shared RECIPE_RECEIPT_SECRET both sides have).
  const verification = verifyManifestSignature(manifest_json, signature);
  let signatureMode = 'hmac-local';
  let signatureValid = true;
  let signatureError = null;
  if (!verification.valid) {
    // Cloud-trust fallback. When the artifact bytes match an entry recorded
    // by `kolm compile` (cloud path), accept the artifact - the cloud signed
    // it with RECIPE_RECEIPT_SECRET we don't have local access to, but we
    // downloaded it ourselves over an authenticated channel and recorded its
    // sha256. We still confirm structural integrity (signature envelope is
    // well-formed and manifest_hash binds to the manifest we're about to
    // execute) so a swapped-in malicious manifest is still rejected.
    const trustedInput = useStreaming ? streamSha256Hex(artifactPath) : fileBuf;
    const trustedSha = isCloudTrusted(trustedInput);
    if (trustedSha) {
      const integrity = structuralIntegrityOk(manifest_json, signature);
      if (!integrity.ok) {
        const message = `signature invalid (cloud-trust set, but structural integrity failed: ${integrity.reason})`;
        if (allowInvalidSignature) {
          signatureMode = 'invalid';
          signatureValid = false;
          signatureError = message;
        } else {
          throw kolmError('KOLM_E_SIGNATURE_INVALID', message);
        }
      } else {
        signatureMode = 'cloud-trusted';
      }
    } else {
      // W481 - Ed25519 structural-integrity fallback. The artifact carries a
      // self-describing Ed25519 receipt: signature + public key both bundled
      // inside receipt.json. When the local HMAC secret does not match
      // (verifier didn't sign this artifact themselves; bytes weren't
      // downloaded via `kolm compile` so cloud-trust didn't fire either),
      // attempt to verify the Ed25519 signature against the embedded public
      // key over the canonical receipt body. This is the path that lets
      // marketplace/registry-pack artifacts verify on any host without
      // RECIPE_RECEIPT_SECRET in env. Structural integrity (manifest_hash
      // binds to the signature envelope) is enforced in the same check so a
      // tampered manifest still fails. Callers that demand a stronger
      // identity contract (must be signed by the original kolm builder key)
      // set KOLM_REQUIRE_ED25519=1 or manifest.policy.require_ed25519=true;
      // binder.js check #17 enforces that.
      const ed25519Result = ed25519IntegrityOk(manifest_json, signature, receipt_json);
      if (ed25519Result.ok) {
        signatureMode = 'ed25519-public-key';
      } else {
        const message = `signature invalid: ${verification.reason}. Ed25519 fallback also failed: ${ed25519Result.reason}. If this artifact was downloaded via \`kolm compile\` (cloud), make sure the download finished and re-run \`kolm compile\` to refresh the local trust entry. Set KOLM_TRUST_CLOUD_ARTIFACTS=0 to disable the cloud-trust fallback.`;
        if (allowInvalidSignature) {
          signatureMode = 'invalid';
          signatureValid = false;
          signatureError = message;
        } else {
          throw kolmError('KOLM_E_SIGNATURE_INVALID', message);
        }
      }
    }
  }

  const manifest = JSON.parse(manifest_json);
  const recipes = JSON.parse(recipes_json);
  const evals = evals_json ? JSON.parse(evals_json) : null;
  const receipt = receipt_json ? JSON.parse(receipt_json) : null;
  const model = model_pointer ? (() => { try { return JSON.parse(model_pointer); } catch { return null; } })() : null;

  // Optional behaviour-pack and lookup-index slots. Missing or empty buffers
  // are normal for v0.1 'recipe' tier with no pack supplied.
  let pack = null;
  let index = null;
  try { pack = decodePack(entries['lora.bin']); }
  catch (e) { throw kolmError('KOLM_E_PACK_DECODE', `lora.bin pack decode failed: ${e.message}`); }
  try { index = decodeIndex(entries['index.sqlite-vec']); }
  catch (e) { throw kolmError('KOLM_E_INDEX_DECODE', `index.sqlite-vec decode failed: ${e.message}`); }

  return {
    manifest,
    recipes,
    evals,
    receipt,
    model,
    pack,
    index,
    // W287 - raw zip entries so dispatchRuntime + per-target runners can read
    // bytes like target.wasm / target/linux-x64/recipe / model.gguf without
    // re-opening the zip. Keys are entry names; values are Buffers.
    entries,
    // W891 - entries too large for a Buffer (Trinity-500 4.6 GB GGUF) are
    // declared here instead. Runners (gguf-runner) stream them to disk via
    // extractEntryToFile(artifact_path, name, dest).
    large_entries: largeEntries,
    signature_valid: signatureValid,
    signature_mode: signatureMode,
    signature_error: signatureError,
    artifact_path: artifactPath,
  };
}

// W891 - re-exported so runners can stream-extract large entries without
// taking a separate dep on src/zip-large.js.
export { extractEntryToFile as extractArtifactEntryToFile };

// W287 - declarative health probe for a runtime target. Returns
// { ok: true } when the manifest's declared runtime_target is supported on
// this host and its required configuration is present, or
// { ok: false, reason } otherwise. This is the "can I actually run this?"
// gate the binder + UI surface - loadArtifact is structural-only and never
// throws on a missing runner; callers ask runtimeAvailable BEFORE attempting
// dispatchRuntime so they can present a clean "install llama.cpp to run"
// instead of catching KOLM_E_GGUF_RUNTIME_MISSING after the fact.
export function runtimeAvailable(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, reason: 'manifest missing' };
  }
  const target = manifest.runtime_target || 'js';
  if (!SUPPORTED_RUNTIME_TARGETS.includes(target)) {
    return { ok: false, reason: `unsupported runtime_target ${JSON.stringify(target)} (supported: ${SUPPORTED_RUNTIME_TARGETS.join(', ')})` };
  }
  if (target === 'js') return { ok: true };
  if (target === 'wasm') {
    // wasm needs the bytes in the bundle; we cannot probe that without a
    // loaded bundle so we report ok at the manifest level and let
    // runWasmTarget surface KOLM_E_TARGET_MISSING when the bytes are absent.
    return { ok: true };
  }
  if (target === 'native') {
    const ep = manifest.entrypoint || {};
    if (!ep.binary) {
      return { ok: false, reason: 'native runtime_target requires manifest.entrypoint.binary' };
    }
    if (process.platform === 'win32' && !ep.binary.endsWith('.exe')) {
      return { ok: false, reason: 'on Windows, manifest.entrypoint.binary must end in .exe' };
    }
    return { ok: true };
  }
  if (target === 'gguf') {
    const cfg = manifest.runtime_target_config || {};
    if (!cfg.gguf_path) {
      return { ok: false, reason: 'gguf runtime_target requires manifest.runtime_target_config.gguf_path' };
    }
    return ggufRuntimeAvailable();
  }
  if (target === 'onnx') {
    return onnxRuntimeConfigAvailable(manifest);
  }
  return { ok: false, reason: `unhandled runtime_target ${JSON.stringify(target)}` };
}

// W287 - runtime dispatch. Reads manifest.runtime_target (default 'js' for
// back-compat) and routes the call to the matching runner. The JS path
// preserves the historical semantics (compileJs + recipe loop in runArtifact),
// so existing artifacts continue to execute unchanged. Non-JS targets bypass
// the recipe loop entirely; their entrypoint is whatever the manifest declares.
//
// Returns the runner's output shape. Throws KOLM_E_UNSUPPORTED_RUNTIME when
// the target is unknown OR the runtime is not available on this host.
export async function dispatchRuntime(bundle, input, opts = {}) {
  const target = bundle?.manifest?.runtime_target || 'js';
  if (!SUPPORTED_RUNTIME_TARGETS.includes(target)) {
    throw kolmError('KOLM_E_UNSUPPORTED_RUNTIME', `runtime_target ${JSON.stringify(target)} not in [${SUPPORTED_RUNTIME_TARGETS.join(', ')}]`);
  }
  // For non-js targets, gate on runtimeAvailable so missing deps surface as
  // KOLM_E_UNSUPPORTED_RUNTIME with the binder-readable reason. The actual
  // runner can still throw a more specific code (KOLM_E_TARGET_MISSING etc.)
  // when bundle bytes are missing - that is handled inside each runner.
  if (target !== 'js') {
    const probe = runtimeAvailable(bundle.manifest);
    if (!probe.ok) {
      throw kolmError('KOLM_E_UNSUPPORTED_RUNTIME', `runtime_target=${target} not available: ${probe.reason}`);
    }
  }
  if (target === 'js') {
    return runJsTarget(bundle, input, opts);
  }
  if (target === 'wasm') return runWasmTarget(bundle, input, opts);
  if (target === 'native') return runNativeTarget(bundle, input, opts);
  if (target === 'gguf') return runGgufTarget(bundle, input, opts);
  if (target === 'onnx') return runOnnxTarget(bundle, input, opts);
  throw kolmError('KOLM_E_UNSUPPORTED_RUNTIME', `unhandled runtime_target ${JSON.stringify(target)}`);
}

// W287 - JS runner extracted from runArtifact so dispatchRuntime can call
// it directly without re-loading the artifact. Walks the recipe array in
// order, returns the first recipe that compiles + executes within the
// timeout. Output shape matches runArtifact's return value.
async function runJsTarget(bundle, input, opts = {}) {
  const { recipes, manifest, pack, index } = bundle;
  if (!recipes.recipes || !recipes.recipes.length) {
    throw kolmError('KOLM_E_NO_RECIPES', 'artifact has no executable recipes');
  }
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const params = opts.params || null;
  const rag = ragLibFor(bundle.artifact_path);
  const t0 = process.hrtime.bigint();
  const tried = [];
  let lastError = null;
  for (const r of recipes.recipes) {
    if (!r.source) continue;
    let fn;
    try { fn = compileJs(r.source); }
    catch (e) { tried.push({ id: r.id, stage: 'compile', error: e.message }); lastError = `compile ${r.id}: ${e.message}`; continue; }
    try {
      const output = fn(input, { timeout, pack, index, params, rag: rag });
      const us = Number(process.hrtime.bigint() - t0) / 1000;
      return {
        output,
        recipe_id: r.id,
        recipe_name: r.name,
        latency_us: Math.round(us),
        k_score: manifest.k_score || null,
        runtime: 'js',
      };
    } catch (e) {
      tried.push({ id: r.id, stage: 'run', error: e.message });
      lastError = `run ${r.id}: ${e.message}`;
      continue;
    }
  }
  const err = kolmError('KOLM_E_NO_RECIPE_HANDLED', `no recipe in artifact handled the input. tried ${tried.length}; last: ${lastError}`);
  err.tried = tried;
  throw err;
}

// Run the artifact against a single input. Returns { output, recipe_id, latency_us, receipt, audit }.
//
// W409d - runArtifact now routes ALL targets (js + wasm + native + gguf + onnx)
// through dispatchRuntime(). The JS path goes through the same dispatcher as
// non-JS targets, so the runtime_target manifest field is honored end-to-end
// at the primary run/eval entry. Previously runArtifact had its own embedded
// JS recipe loop that bypassed dispatchRuntime, which meant `kolm run
// foo.kolm` always executed the JS recipes even when manifest.runtime_target
// declared native/wasm/gguf/onnx. evalArtifact inherited the bug because it
// calls runArtifact() per case.
//
// Recipe dispatch (JS target): try each recipe in order, return the first
// that compiles + executes within the timeout without throwing. The artifact
// author orders recipes by specificity (most-specific first); the runner
// trusts that order. Non-JS targets have no recipe loop - their entrypoint
// is whatever the manifest declares (entrypoint.binary, target.wasm,
// runtime_target_config.{gguf,onnx}_path).
//
// opts.timeoutMs   - per-recipe timeout (default 1000ms)
// opts.maxBytes    - input size cap (default 1 MiB)
// opts.audit       - optional audit-sink callback({ artifact_job_id, recipe_id, input_sha256, input_bytes, latency_us, ok })
export async function runArtifact(artifactPath, input, opts = {}) {
  const bundle = loadArtifact(artifactPath);
  const { manifest } = bundle;
  const target = manifest.runtime_target || 'js';

  const runtimePolicy = {
    ...(manifest.policy && typeof manifest.policy === 'object' ? manifest.policy : {}),
    ...(manifest.runtime_policy && typeof manifest.runtime_policy === 'object' ? manifest.runtime_policy : {}),
  };
  const maxBytes = opts.maxBytes || Number(runtimePolicy.max_input_bytes || 0) || MAX_INPUT_BYTES;
  const maxTokens = opts.maxTokens || Number(runtimePolicy.max_input_tokens || 0);
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const bytes = inputBytes(input);
  if (bytes > maxBytes) {
    throw kolmError('KOLM_E_INPUT_TOO_LARGE', `input ${bytes}B exceeds limit ${maxBytes}B`);
  }
  if (maxTokens) {
    const tokens = estimateTokens(input);
    if (tokens > maxTokens) {
      throw kolmError('KOLM_E_TOKEN_BUDGET', `input estimated ${tokens} tokens exceeds artifact limit ${maxTokens}`);
    }
  }

  // Tenant-supplied parameters: any buyer can pass per-call config (extra
  // patterns, allowlists, vertical-specific rules) via opts.params or as
  // input.params on a structured input. Tenant params are NEVER persisted
  // by the runtime and never re-signed into the artifact.
  const params = opts.params || (input && typeof input === 'object' && !Array.isArray(input) ? input.params : null) || null;

  const inputSha = sha256Hex(Buffer.from(typeof input === 'string' ? input : JSON.stringify(input ?? null), 'utf8')).slice(0, 16);
  const t0 = process.hrtime.bigint();

  // For the JS target we still want the "tried" trace on KOLM_E_NO_RECIPES /
  // KOLM_E_NO_RECIPE_HANDLED for back-compat (audit-sink callers branch on it).
  // We let dispatchRuntime do the routing, and the JS runner (runJsTarget)
  // throws an Error with `.tried` attached on no-recipe-handled.
  let dispatched;
  try {
    dispatched = await dispatchRuntime(bundle, input, { timeoutMs: timeout, params });
  } catch (e) {
    const us = Number(process.hrtime.bigint() - t0) / 1000;
    if (typeof opts.audit === 'function') {
      try {
        opts.audit({
          spec: 'kolm-audit-1',
          artifact_job_id: manifest.job_id,
          input_sha256_prefix: inputSha,
          input_bytes: bytes,
          input_preview: previewInput(input),
          latency_us: Math.round(us),
          ran_at: new Date().toISOString(),
          ok: false,
          error_code: e.code || 'KOLM_E_RUN_FAILED',
          runtime: target,
          tried: e.tried || null,
        });
      } catch {} // deliberate: cleanup
    }
    throw e;
  }

  // Normalize the dispatcher result into the historical runArtifact return
  // shape. JS path carries recipe_id/recipe_name; non-JS paths set them to
  // null because there is no recipe - the entrypoint is the manifest's
  // declared binary/wasm/gguf/onnx target.
  const us = Number(process.hrtime.bigint() - t0) / 1000;
  const recipe_id = dispatched.recipe_id || null;
  const recipe_name = dispatched.recipe_name || null;
  const audit = {
    spec: 'kolm-audit-1',
    artifact_job_id: manifest.job_id,
    recipe_id,
    recipe_name,
    input_sha256_prefix: inputSha,
    input_bytes: bytes,
    input_preview: previewInput(input),
    latency_us: Math.round(us),
    ran_at: new Date().toISOString(),
    ok: true,
    runtime: dispatched.runtime || target,
  };
  if (typeof opts.audit === 'function') { try { opts.audit(audit); } catch {} } // deliberate: cleanup
  return {
    output: dispatched.output,
    recipe_id,
    recipe_name,
    latency_us: Math.round(us),
    k_score: manifest.k_score || null,
    runtime: dispatched.runtime || target,
    receipt: {
      spec: 'rs-1-run',
      artifact_job_id: manifest.job_id,
      recipe_id,
      version_id: recipe_id ? (bundle.recipes?.recipes?.find(r => r.id === recipe_id)?.version_id ?? null) : null,
      runtime: dispatched.runtime || target,
      ran_at: new Date().toISOString(),
    },
    audit,
  };
}

// Re-run the embedded eval suite against the artifact's recipes. This is
// what backs `kolm eval <artifact>` - recompute K-score axes from scratch
// to confirm the bundle still passes.
//
// opts.cases overrides the embedded cases (used by `kolm eval --examples <file>`
// to test against fresh data without touching the artifact). Pass an array of
// {id?, input, expected, params?} rows. Missing ids get auto-numbered so the
// failure printer always has something to anchor against.
export async function evalArtifact(artifactPath, opts = {}) {
  const bundle = loadArtifact(artifactPath);
  const embedded = bundle.evals?.cases || [];
  const cases = Array.isArray(opts.cases) && opts.cases.length
    ? opts.cases.map((c, i) => ({ id: c.id || `case_${i + 1}`, ...c }))
    : embedded;
  if (!cases.length) {
    return { n: 0, passed: 0, accuracy: 0, latencies_us: [], note: 'no evals embedded' };
  }
  const latencies = [];
  let passed = 0;
  const errors = [];
  // W345 - comparator pulled from artifact manifest so eval and bench score
  // the same artifact identically. Default is 'subset_equal' (the canonical
  // matcher). Embedded evals.comparator wins when set; opts.comparator is the
  // CLI override.
  const comparatorName = opts.comparator || bundle.evals?.comparator || 'subset_equal';
  for (const c of cases) {
    try {
      const r = await runArtifact(artifactPath, c.input, { params: c.params || opts.params });
      latencies.push(r.latency_us);
      const sc = scoreCase({ input: c.input, expected: c.expected }, r.output, { comparator: comparatorName, latency_us: r.latency_us });
      if (sc.pass) passed++;
      else errors.push({ id: c.id, expected: c.expected, got: r.output });
    } catch (e) {
      errors.push({ id: c.id, error: String(e.message || e) });
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  return {
    n: cases.length,
    passed,
    accuracy: cases.length ? passed / cases.length : 0,
    p50_latency_us: p50,
    // Returning all errors so the CLI can decide how many to show (--trace
    // shows everything, default tops out at 5). Used to slice here, which
    // truncated --trace too.
    errors,
    source: Array.isArray(opts.cases) && opts.cases.length ? 'override' : 'embedded',
  };
}

// Subset-equal matcher mirroring verifier.verify's `matches`. Compile-time and
// runtime eval must use the same matcher or the user sees different pass counts
// from `kolm compile --spec` vs `kolm eval`. The verifier's logic is canonical;
// this is a copy because src/artifact-runner.js is the runtime hot path and we
// don't want it to pull the full verifier sandbox (vm, source guards, etc.)
// just for the matcher.
//
// W345: this local copy is retained as a safety reference. The active scoring
// path goes through src/case-scorer.js::scoreCase so eval and bench share one
// implementation - if you change semantics here, also update case-scorer.js.
function matches(actual, expected) {
  if (expected === undefined || expected === null) return actual !== undefined;
  if (typeof expected === 'function') return expected(actual);
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (actual.length !== expected.length) return false;
    return actual.every((a, i) => matches(a, expected[i]));
  }
  if (typeof expected === 'object' && expected && typeof actual === 'object' && actual) {
    return Object.keys(expected).every(k => matches(actual[k], expected[k]));
  }
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(actual - expected) < 1e-6;
  }
  return actual === expected;
}

// Return the manifest + recipe summary + K-score for a UI-style overview.
export function inspectArtifact(artifactPath) {
  const bundle = loadArtifact(artifactPath);
  return {
    artifact_path: artifactPath,
    spec: bundle.manifest.spec,
    job_id: bundle.manifest.job_id,
    task: bundle.manifest.task,
    runtime: bundle.manifest.runtime,
    tier: bundle.manifest.tier || 'recipe',
    base_model: bundle.manifest.base_model,
    created_at: bundle.manifest.created_at,
    recipes_n: bundle.recipes.n || (bundle.recipes.recipes?.length || 0),
    evals_n: bundle.evals?.cases?.length || 0,
    k_score: bundle.manifest.k_score,
    pack_present: !!bundle.pack,
    index_present: !!bundle.index,
    pack_keys: bundle.pack ? Object.keys(bundle.pack).slice(0, 8) : [],
    index_keys: bundle.index ? Object.keys(bundle.index).slice(0, 8) : [],
    signature_valid: bundle.signature_valid,
    signature_mode: bundle.signature_mode || 'hmac-local',
    recipe_names: (bundle.recipes.recipes || []).slice(0, 8).map(r => r.name),
    // Wave 151 - honest taxonomy surface on every inspect result. Callers
    // (CLI text mode, /r/:hash page, the binder, third-party tooling) read
    // artifact_class to know what they are looking at without having to parse
    // recipes.json. artifact_class_breakdown lets them show "6 rule + 1
    // distilled_model" instead of just the rolled-up label.
    artifact_class: bundle.manifest.artifact_class || 'rule',
    artifact_class_breakdown: bundle.manifest.artifact_class_breakdown || null,
    license: bundle.manifest.license || null,
    // R-1 - runtime passports surface. Pre-R-1 artifacts have no key (default []
    // so callers branching on `.length` see "no targets probed" without a
    // separate null check). Post-R-1 artifacts always carry the array.
    runtime_passports: Array.isArray(bundle.manifest.runtime_passports)
      ? bundle.manifest.runtime_passports : [],
    runtime_passports_spec_version: bundle.manifest.runtime_passports_spec_version || null,
  };
}
