// Recall - the unified retrieval SDK for kolm compile and the HTTP surface.
//
// One small interface that wraps two substrates:
//   - services/index/qmd.js          → BM25 + vector + RRF + reranker (the search)
//   - services/embed/multimodal.js   → multimodal-to-Markdown sidecar tokenizer
//
// qmd indexes Markdown. Our multimodal tokenizer makes every modality look
// like Markdown by writing a `<file>.md` sidecar for non-text inputs (image
// caption, audio transcript, video keyframes, PDF text). qmd then treats the
// whole corpus uniformly and the same hybrid query that finds the right
// paragraph also finds the right photo.
//
// Tenant isolation: every namespace seen on the wire is prefixed with the
// tenant id before it ever reaches qmd, so two tenants asking for the
// "notes" namespace never collide.
//
// Sprint 1 surfaces:
//   recall.ingest({ tenant, namespace, paths, force })  → tokenize + add + embed
//   recall.query({ tenant, namespace, query, k })       → top-k chunks
//   recall.status({ tenant, namespace })                → index health
//   recall.tokenize({ file, force })                    → single-file passthrough
//   recall.isAvailable()                                → does the user have qmd?

import * as qmd from '../services/index/qmd.js';
import { tokenize, tokenizeDir, detectModality } from '../services/embed/multimodal.js';
import fs from 'node:fs';
import path from 'node:path';

function nsFor(tenant, namespace) {
  // Tenant ids are short hashes; namespaces are user-supplied strings.
  // Sanitize the user-supplied piece so a tenant can't escape their bucket
  // by passing "../" or shell metacharacters.
  const t = String(tenant || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'anon';
  const n = String(namespace || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
  return `kolm-${t}-${n}`;
}

export async function isAvailable() {
  return qmd.isAvailable();
}

// Ingest a directory or list of files. Walks the tree, writes Markdown
// sidecars for every multimodal file, then registers the directory with
// qmd and triggers an embed pass. Returns { added, skipped, errors,
// by_modality } summary.
export async function ingest({ tenant, namespace, paths, force = false, onProgress }) {
  const ns = nsFor(tenant, namespace);
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('ingest: paths must be a non-empty array');
  }

  // Phase 1 - tokenize. For each path: if it's a directory, walk it;
  // otherwise tokenize the single file. Sidecars land next to originals.
  const tok = { added: 0, skipped: 0, errors: [], by_modality: {} };
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      tok.errors.push({ file: p, error: 'not found' });
      continue;
    }
    const st = fs.statSync(p);
    try {
      if (st.isDirectory()) {
        const r = await tokenizeDir(p, { force, onProgress });
        tok.added += r.added; tok.skipped += r.skipped;
        tok.errors.push(...r.errors);
        for (const [k, v] of Object.entries(r.by_modality)) tok.by_modality[k] = (tok.by_modality[k] || 0) + v;
      } else {
        const r = await tokenize(p, { force });
        tok.by_modality[r.modality] = (tok.by_modality[r.modality] || 0) + 1;
        if (r.skipped) tok.skipped++; else tok.added++;
        if (onProgress) onProgress({ file: p, ...r });
      }
    } catch (e) {
      tok.errors.push({ file: p, error: String(e.message || e) });
    }
  }

  // Phase 2 - register with qmd if it's available; otherwise we still
  // succeeded at writing sidecars and the user can `qmd collection add`
  // by hand later.
  let registered = false;
  let embedded = false;
  let embed_error = null;
  try {
    const av = await qmd.isAvailable();
    if (av.available) {
      await qmd.addCollection({ name: ns, paths });
      registered = true;
      try {
        await qmd.embed({ name: ns });
        embedded = true;
      } catch (e) {
        embed_error = String(e.message || e);
      }
    }
  } catch (e) {
    embed_error = String(e.message || e);
  }

  return { namespace: ns, tokenized: tok, registered, embedded, embed_error };
}

// Hybrid query - returns the top-k chunks. Fast path through qmd's MCP HTTP
// transport when available, CLI fallback otherwise.
export async function query({ tenant, namespace, query: q, k = 12 }) {
  if (!q || typeof q !== 'string') return [];
  const ns = nsFor(tenant, namespace);
  try {
    return await qmd.query({ namespace: ns, query: q, k });
  } catch (e) {
    // qmd not present or failed - return empty so the compile pipeline
    // degrades gracefully instead of failing the whole job.
    return [];
  }
}

export async function status({ tenant, namespace } = {}) {
  const ns = namespace ? nsFor(tenant, namespace) : null;
  return qmd.status({ name: ns });
}

// Single-file tokenize convenience. Useful for the /v1/embed endpoint that
// accepts an upload - the caller writes to /tmp, we tokenize, sidecar lands
// next to it.
export async function tokenizeFile(file, opts = {}) {
  return tokenize(file, opts);
}

export { detectModality };
