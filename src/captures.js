// W829 — Multimodal capture lake.
//
// Distinct from src/capture.js (which is the proxy-forwarding layer for
// Anthropic/OpenAI/OpenRouter) and from src/capture-store.js (which is the
// observation-row database adapter). This module is the FILESYSTEM
// capture-lake plumbing for HETEROGENEOUS captures — image, audio,
// tool-use, multi-turn — that the W454 transcript + W462 image + W464
// audio redactors already process row-by-row.
//
// Storage layout (one JSONL file per (namespace,kind,hash) tuple):
//
//   ~/.kolm/captures/<namespace>/multimodal/<kind>/<hash>.jsonl
//   ~/.kolm/captures/<namespace>/multi-turn/<conversation_id>.jsonl
//
// Honesty contract:
//   - KOLM_NO_RAW_MULTIMODAL=1 strips payload.data_uri before write so a
//     compliance team can demand "hash + redaction receipt only, never the
//     raw pixels/audio." The hash is still computed against the ORIGINAL
//     payload before the strip so dedup + replay still work against the
//     un-stripped reference.
//   - Failure to write surfaces as ok:false (never silent).
//   - Tenant scoping: the namespace path includes the namespace token only;
//     tenants are responsible for namespace allocation upstream (auth.js).
//     We sanitize the namespace + the hash + the kind to a closed set so a
//     path-traversal token can never escape the data dir.
//
// W829-1: recordMultimodalCapture({tenant, namespace, kind, payload, hash, redaction_receipt})
// W829-4: recordMultiTurnCapture({tenant, namespace, conversation, conversation_id, parent_message_id?})

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const W829_VERSION = 'w829-v1';

export const MULTIMODAL_KINDS = ['image', 'audio', 'tool_use', 'multi_turn'];

// Sanitize a namespace label — same closed alphabet as src/capture.js so
// downstream tooling can join across stores without re-encoding. Empty
// resolves to 'default'.
export function sanitizeNamespace(raw) {
  let s = String(raw || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  s = s.replace(/\.+/g, '').slice(0, 64);
  return s || 'default';
}

// Sanitize a hash token. We accept caller-supplied hashes (the caller usually
// already has a content hash from the redactor) but never let one contain
// path separators. Empty → null. Caps at 64 chars (sha256 hex).
export function sanitizeHashToken(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 64);
  return s || null;
}

// Same for conversation_id — closed alphabet so a tenant can't smuggle a
// '../' segment into a JSONL filename.
export function sanitizeConversationId(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 96);
  return s || null;
}

// Resolve ~/.kolm at call time — never at module load — so a test that
// rewrites HOME / USERPROFILE / KOLM_DATA_DIR can isolate its writes.
export function captureLakeRoot() {
  // KOLM_DATA_DIR takes precedence over HOME so the test harness can pin
  // a tmpdir without touching the real home.
  if (process.env.KOLM_DATA_DIR) {
    return path.resolve(process.env.KOLM_DATA_DIR, 'captures');
  }
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.resolve(home, '.kolm', 'captures');
}

// Resolve the path for a multimodal capture row.
//
// Returns {root, dir, file, namespace, kind, hash}. The file is the JSONL
// path the row will be appended to. `root` is the capture-lake root so a
// test that wants to wipe just W829 fixtures can rm-rf that scope.
export function resolveMultimodalPath({ namespace, kind, hash }) {
  const ns = sanitizeNamespace(namespace);
  const k = MULTIMODAL_KINDS.includes(kind) ? kind : null;
  if (!k) throw new Error(`recordMultimodalCapture: kind must be one of ${MULTIMODAL_KINDS.join('|')}, got ${JSON.stringify(kind)}`);
  const h = sanitizeHashToken(hash);
  if (!h) throw new Error('recordMultimodalCapture: hash is required (hex sha256 token)');
  const root = captureLakeRoot();
  const dir = path.join(root, ns, 'multimodal', k);
  const file = path.join(dir, `${h}.jsonl`);
  return { root, dir, file, namespace: ns, kind: k, hash: h };
}

export function resolveMultiTurnPath({ namespace, conversation_id }) {
  const ns = sanitizeNamespace(namespace);
  const cid = sanitizeConversationId(conversation_id);
  if (!cid) throw new Error('recordMultiTurnCapture: conversation_id is required');
  const root = captureLakeRoot();
  const dir = path.join(root, ns, 'multi-turn');
  const file = path.join(dir, `${cid}.jsonl`);
  return { root, dir, file, namespace: ns, conversation_id: cid };
}

// W829-1 — append one heterogeneous capture row to the JSONL.
//
// Returns an honest envelope. Throws ONLY on programmer error (bad kind,
// missing hash) so the caller can distinguish "you passed garbage" from
// "the disk is full" (the latter surfaces as ok:false + the error message).
export function recordMultimodalCapture({ tenant, namespace, kind, payload, hash, redaction_receipt }) {
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: W829_VERSION };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'payload_required', version: W829_VERSION };
  }
  let paths;
  try { paths = resolveMultimodalPath({ namespace, kind, hash }); }
  catch (e) {
    return { ok: false, error: 'invalid_args', detail: String((e && e.message) || e), version: W829_VERSION };
  }
  // Honesty: strip raw data_uri when the operator has opted out of raw
  // multimodal storage. The hash already binds the row to the original
  // payload so replay against the un-stripped reference still works.
  const stripRaw = process.env.KOLM_NO_RAW_MULTIMODAL === '1';
  const stored = {
    tenant_id: String(tenant),
    namespace: paths.namespace,
    kind: paths.kind,
    hash: paths.hash,
    created_at: payload.created_at || new Date().toISOString(),
    redaction_classes_seen: Array.isArray(payload.redaction_classes_seen)
      ? payload.redaction_classes_seen.slice(0, 64)
      : [],
    redaction_receipt: redaction_receipt || null,
    raw_stored: !stripRaw,
  };
  // Optional payload fields preserved verbatim (subject to strip).
  if (payload.weight_ref) stored.weight_ref = String(payload.weight_ref).slice(0, 512);
  if (payload.tool_name) stored.tool_name = String(payload.tool_name).slice(0, 128);
  if (Array.isArray(payload.turns)) {
    // Turn list mirrors multi-turn shape so a single capture can carry
    // both modalities (e.g. a tool-use that triggered mid-conversation).
    stored.turns = payload.turns.slice(0, 256).map((t) => ({
      role: String((t && t.role) || 'user').slice(0, 32),
      content: t && t.content != null ? String(t.content).slice(0, 65536) : '',
    }));
  }
  if (typeof payload.data_uri === 'string' && !stripRaw) {
    // 8 MiB cap per row keeps a runaway pixel-blob from filling the disk;
    // larger blobs should be uploaded out-of-band and referenced via
    // weight_ref.
    stored.data_uri = payload.data_uri.slice(0, 8 * 1024 * 1024);
  }
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.appendFileSync(paths.file, JSON.stringify(stored) + '\n');
  } catch (e) {
    return { ok: false, error: 'write_failed', detail: String((e && e.message) || e), version: W829_VERSION };
  }
  return {
    ok: true,
    version: W829_VERSION,
    file: paths.file,
    namespace: paths.namespace,
    kind: paths.kind,
    hash: paths.hash,
    raw_stored: stored.raw_stored,
    bytes_written: Buffer.byteLength(JSON.stringify(stored) + '\n'),
  };
}

// W829-4 — append a multi-turn conversation row. Append-only: each call
// adds a new line so the JSONL is the full conversation transcript.
//
// `conversation` is the WHOLE turn list as-of-now. Callers that want pure
// incremental append should pass only the new turns + parent_message_id so
// the file is naturally ordered. Either pattern works (full snapshot vs
// incremental) — we don't try to reconcile.
export function recordMultiTurnCapture({ tenant, namespace, conversation, conversation_id, parent_message_id }) {
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: W829_VERSION };
  }
  if (!Array.isArray(conversation)) {
    return { ok: false, error: 'conversation_required', version: W829_VERSION };
  }
  let paths;
  try { paths = resolveMultiTurnPath({ namespace, conversation_id }); }
  catch (e) {
    return { ok: false, error: 'invalid_args', detail: String((e && e.message) || e), version: W829_VERSION };
  }
  const turns = conversation.slice(0, 1024).map((t) => {
    const out = {
      role: String((t && t.role) || 'user').slice(0, 32),
      content: t && t.content != null ? String(t.content).slice(0, 65536) : '',
      timestamp: (t && t.timestamp) || new Date().toISOString(),
    };
    if (t && Array.isArray(t.tool_calls)) {
      // Tool calls preserved as-is, capped at 16 per turn so a runaway loop
      // can't blow the row size.
      out.tool_calls = t.tool_calls.slice(0, 16).map((tc) => ({
        name: tc && tc.name ? String(tc.name).slice(0, 128) : null,
        arguments: tc && tc.arguments != null ? tc.arguments : null,
        id: tc && tc.id ? String(tc.id).slice(0, 128) : null,
      }));
    }
    return out;
  });
  const row = {
    tenant_id: String(tenant),
    namespace: paths.namespace,
    conversation_id: paths.conversation_id,
    parent_message_id: parent_message_id ? String(parent_message_id).slice(0, 256) : null,
    appended_at: new Date().toISOString(),
    turn_count: turns.length,
    conversation: turns,
  };
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.appendFileSync(paths.file, JSON.stringify(row) + '\n');
  } catch (e) {
    return { ok: false, error: 'write_failed', detail: String((e && e.message) || e), version: W829_VERSION };
  }
  return {
    ok: true,
    version: W829_VERSION,
    file: paths.file,
    namespace: paths.namespace,
    conversation_id: paths.conversation_id,
    turn_count: turns.length,
    bytes_written: Buffer.byteLength(JSON.stringify(row) + '\n'),
  };
}

// Read helper for tests + the bake-off path. Returns an array of parsed
// JSONL rows; honest empty array if the file does not yet exist.
export function readMultimodalCaptures({ namespace, kind, hash }) {
  let paths;
  try { paths = resolveMultimodalPath({ namespace, kind, hash }); }
  catch (_) { return []; }
  if (!fs.existsSync(paths.file)) return [];
  try {
    const raw = fs.readFileSync(paths.file, 'utf8');
    return raw.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

export function readMultiTurnCaptures({ namespace, conversation_id }) {
  let paths;
  try { paths = resolveMultiTurnPath({ namespace, conversation_id }); }
  catch (_) { return []; }
  if (!fs.existsSync(paths.file)) return [];
  try {
    const raw = fs.readFileSync(paths.file, 'utf8');
    return raw.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

// Cheap hash for callers that need a hex token but don't have one (e.g.
// the route handler that receives a data_uri). Computes sha256 of the
// canonicalized payload bytes.
export function hashPayload(payload) {
  const canonical = typeof payload === 'string'
    ? payload
    : JSON.stringify(payload, Object.keys(payload || {}).sort());
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}
