#!/usr/bin/env node
// scripts/mirror-trust-anchors.mjs - GAP-7: trust-anchor mirror.
//
// THE GAP. Every verification surface (public/verify.html, the SDKs, the CLI)
// ultimately trusts three anchors kolm publishes: the signed transparency-log
// tree head, the issuer keyring (public/keys/kolm-issuers.json), and the
// issuer-key lifecycle statuses. If kolm's origin is the ONLY place those live,
// a compromised origin can serve a split view (one tree head to the victim,
// another to everyone else) and nobody can prove it later. The fix is the
// standard CT one: independent parties run this script on a schedule and keep
// their OWN append-only mirror of the anchors. A split view then becomes two
// mirrored files with the same tree_size and different root_hash - durable,
// portable evidence.
//
// USAGE
//   node scripts/mirror-trust-anchors.mjs            # capture current anchors
//   node scripts/mirror-trust-anchors.mjs --check    # audit the mirror, no write
//
// ENV
//   KOLM_TRUST_MIRROR_DIR  where anchor files live (default ./trust-anchors)
//   KOLM_TRUST_MIRROR_URL  optional base URL of a LIVE kolm deployment (e.g.
//                          https://kolm.ai). When set, the signed tree head and
//                          keyring are fetched over HTTPS - run this from a
//                          machine kolm does not control. When unset, anchors
//                          are assembled from the local store + repo (operator
//                          self-mirror mode).
//
// WRITE-ONCE SEMANTICS. Each capture is written to
//   anchor-<origin>-size-<tree_size>.json
// keyed by tree_size. If that file already exists, it is NEVER overwritten:
// an identical root is a clean no-op; a DIFFERENT root for the same size is a
// split view and the script exits 2 with both roots printed. latest.json is a
// convenience pointer and is the only file that gets rewritten.
//
// --check MODE re-reads every mirrored anchor and fails (exit 1) on: malformed
// files, two anchors sharing a tree_size with different roots, a current head
// whose tree_size went BACKWARD versus the newest mirrored anchor, or a current
// head matching a mirrored size with a different root. Cron-friendly: exit 0
// means the mirror and the log agree.
//
// No new dependencies; node:fs + node:path + global fetch only. Never prints
// key material or env secret values.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR_DIR = process.env.KOLM_TRUST_MIRROR_DIR || path.join(ROOT, 'trust-anchors');
// Env URL values can carry a U+FEFF BOM (see the hub's urlEnv trap) - strip it.
const BASE_URL = (process.env.KOLM_TRUST_MIRROR_URL || '').replace(/^\uFEFF/, '').trim().replace(/\/+$/, '');
const CHECK_ONLY = process.argv.includes('--check');

export const TRUST_ANCHOR_VERSION = 'kolm-trust-anchor-mirror/0.1';

function die(code, msg) {
  console.error('[mirror-trust-anchors] ' + msg);
  process.exit(code);
}

function info(msg) {
  console.log('[mirror-trust-anchors] ' + msg);
}

function sanitizeOrigin(origin) {
  return String(origin || 'kolm-tlog').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

function anchorFilename(origin, treeSize) {
  return `anchor-${sanitizeOrigin(origin)}-size-${treeSize}.json`;
}

function readJsonFile(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// Anchor assembly - remote (independent witness) or local (operator self-mirror).
// ---------------------------------------------------------------------------
async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function assembleRemote() {
  const cp = await fetchJson(BASE_URL + '/v1/transparency-log/checkpoints/latest');
  const head = cp && cp.checkpoint ? cp.checkpoint : null;
  if (!head || !Number.isFinite(Number(head.tree_size)) || typeof head.root_hash !== 'string') {
    throw new Error('checkpoints/latest returned no usable signed tree head');
  }
  let issuers = null;
  try {
    const k = await fetchJson(BASE_URL + '/keys/kolm-issuers.json');
    if (k && Array.isArray(k.issuers)) issuers = k.issuers;
  } catch (e) {
    info('keyring fetch failed (' + e.message + '); mirroring tree head without issuers');
  }
  return {
    version: TRUST_ANCHOR_VERSION,
    generated_at: new Date().toISOString(),
    source: BASE_URL,
    mode: 'remote',
    signed_tree_head: head,
    issuers,
    key_statuses: null, // lifecycle listing is store-backed; not exposed publicly
  };
}

async function assembleLocal() {
  // Local mode reads the SAME modules the live routes serve from, so the mirror
  // is byte-faithful to what /v1/transparency-log/checkpoints/latest would say.
  const { getPublicTransparencyLog } = await import('../src/transparency-log-routes.js');
  const { signTreeHead, cosignTreeHead } = await import('../src/transparency-log.js');
  const { loadOrCreateDefaultSigner } = await import('../src/ed25519.js');
  const { listKeyStatuses } = await import('../src/key-revocation.js');

  const log = getPublicTransparencyLog();
  const head = log.treeHead();
  let signedHead;
  try {
    const signer = loadOrCreateDefaultSigner();
    signedHead = cosignTreeHead(signTreeHead(head, signer));
  } catch {
    signedHead = { origin: head.origin, tree_size: head.tree_size, root_hash: head.root_hash, root_b64: head.root_b64, signed: false, reason: 'no_signer_configured' };
  }

  let issuers = null;
  try {
    const k = readJsonFile(path.join(ROOT, 'public', 'keys', 'kolm-issuers.json'));
    if (k && Array.isArray(k.issuers)) issuers = k.issuers;
  } catch { /* keyring file absent in some deployments */ }

  let keyStatuses = null;
  try {
    const rows = listKeyStatuses();
    if (Array.isArray(rows)) {
      keyStatuses = rows.map((r) => ({
        fingerprint: r.fingerprint || r.fp || null,
        status: r.status || null,
        reason: r.reason || null,
        at: r.at || r.updated_at || null,
      }));
    }
  } catch { /* store unavailable - statuses are additive */ }

  return {
    version: TRUST_ANCHOR_VERSION,
    generated_at: new Date().toISOString(),
    source: 'local-store',
    mode: 'local',
    signed_tree_head: signedHead,
    issuers,
    key_statuses: keyStatuses,
  };
}

// ---------------------------------------------------------------------------
// Mirror read + audit.
// ---------------------------------------------------------------------------
function loadMirroredAnchors() {
  if (!fs.existsSync(MIRROR_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(MIRROR_DIR)) {
    if (!/^anchor-.*-size-\d+\.json$/.test(name)) continue;
    const p = path.join(MIRROR_DIR, name);
    let doc;
    try { doc = readJsonFile(p); }
    catch (e) { out.push({ file: name, error: 'unreadable: ' + e.message }); continue; }
    const h = doc && doc.signed_tree_head;
    if (!h || !Number.isFinite(Number(h.tree_size)) || typeof h.root_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(h.root_hash)) {
      out.push({ file: name, error: 'malformed signed_tree_head' });
      continue;
    }
    out.push({ file: name, origin: h.origin || null, tree_size: Number(h.tree_size), root_hash: h.root_hash.toLowerCase() });
  }
  return out;
}

function auditMirror(anchors, currentHead) {
  const problems = [];
  for (const a of anchors) {
    if (a.error) problems.push(`${a.file}: ${a.error}`);
  }
  // Same tree_size MUST mean same root - two roots at one size is a split view.
  const bySize = new Map();
  for (const a of anchors) {
    if (a.error) continue;
    const key = `${a.origin}|${a.tree_size}`;
    const prev = bySize.get(key);
    if (prev && prev.root_hash !== a.root_hash) {
      problems.push(`SPLIT VIEW: ${prev.file} and ${a.file} both claim tree_size ${a.tree_size} with different roots (${prev.root_hash.slice(0, 16)} vs ${a.root_hash.slice(0, 16)})`);
    } else if (!prev) {
      bySize.set(key, a);
    }
  }
  if (currentHead) {
    const size = Number(currentHead.tree_size);
    const root = String(currentHead.root_hash || '').toLowerCase();
    const sameOrigin = anchors.filter((a) => !a.error && (!a.origin || !currentHead.origin || a.origin === currentHead.origin));
    const newest = sameOrigin.reduce((m, a) => (a.tree_size > (m ? m.tree_size : -1) ? a : m), null);
    if (newest && size < newest.tree_size) {
      problems.push(`ROLLBACK: current head tree_size ${size} is SMALLER than mirrored ${newest.file} (${newest.tree_size}); an append-only log never shrinks`);
    }
    const match = sameOrigin.find((a) => a.tree_size === size);
    if (match && match.root_hash !== root) {
      problems.push(`SPLIT VIEW: current head at tree_size ${size} has root ${root.slice(0, 16)} but mirrored ${match.file} recorded ${match.root_hash.slice(0, 16)}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main() {
  let anchor;
  try {
    anchor = BASE_URL ? await assembleRemote() : await assembleLocal();
  } catch (e) {
    die(1, 'could not assemble trust anchors: ' + (e && e.message));
  }
  const head = anchor.signed_tree_head;
  const treeSize = Number(head.tree_size);
  const rootHash = String(head.root_hash || '').toLowerCase();
  if (!Number.isFinite(treeSize) || !/^[0-9a-f]{64}$/.test(rootHash)) {
    die(1, 'assembled head is malformed (tree_size=' + head.tree_size + ')');
  }
  info(`current head: origin=${head.origin || '?'} tree_size=${treeSize} root=${rootHash.slice(0, 16)}...`);

  const anchors = loadMirroredAnchors();

  if (CHECK_ONLY) {
    const problems = auditMirror(anchors, head);
    if (problems.length) {
      for (const p of problems) console.error('[mirror-trust-anchors] FAIL: ' + p);
      die(1, `check FAILED: ${problems.length} problem(s) across ${anchors.length} mirrored anchor(s)`);
    }
    info(`check passed: ${anchors.length} mirrored anchor(s) consistent with the current head`);
    return;
  }

  // Capture mode: write-once per tree_size.
  fs.mkdirSync(MIRROR_DIR, { recursive: true });
  const file = path.join(MIRROR_DIR, anchorFilename(head.origin, treeSize));
  if (fs.existsSync(file)) {
    let prior;
    try { prior = readJsonFile(file); } catch { prior = null; }
    const priorRoot = prior && prior.signed_tree_head ? String(prior.signed_tree_head.root_hash || '').toLowerCase() : null;
    if (priorRoot && priorRoot !== rootHash) {
      console.error(`[mirror-trust-anchors] SPLIT VIEW at tree_size ${treeSize}: mirrored root ${priorRoot.slice(0, 16)} vs current ${rootHash.slice(0, 16)}`);
      die(2, 'refusing to overwrite a write-once anchor; preserve ' + file + ' as evidence');
    }
    info(`anchor for tree_size ${treeSize} already mirrored (same root); no-op`);
  } else {
    fs.writeFileSync(file, JSON.stringify(anchor, null, 2) + '\n', { flag: 'wx' });
    info('wrote ' + file);
  }
  // latest.json is a convenience pointer (the only rewritable file).
  fs.writeFileSync(path.join(MIRROR_DIR, 'latest.json'), JSON.stringify(anchor, null, 2) + '\n');

  const problems = auditMirror(loadMirroredAnchors(), head);
  if (problems.length) {
    for (const p of problems) console.error('[mirror-trust-anchors] FAIL: ' + p);
    die(1, 'mirror audit found problems after capture');
  }
  info('mirror consistent');
}

main().catch((e) => die(1, 'unexpected failure: ' + (e && e.stack || e)));
