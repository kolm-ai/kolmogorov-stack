// src/data-provenance.js
//
// KOLM Data Engine - per-pair provenance for the INGEST stage.
//
// Every raw training pair that lands in <ROOT>/.kolm/data/<ns>/raw-pairs.jsonl
// carries a provenance block recording WHERE it came from, WHEN it was
// ingested, and the source reference (file path, adapter name, doc chunk, …).
// This module is the single place that builds, validates, and summarizes that
// block so the rest of the pipeline (CURATE → AUGMENT → TRAIN → EVALUATE →
// FEEDBACK) can trace any pair back to its origin without trusting the writer.
//
// Distinct from src/distill-provenance.js: that module validates a distill
// WORKER output dir (manifest.json + training-pairs.jsonl + lineage) for the
// artifact receipt chain. This module operates one level earlier, on the raw
// ingested PAIRS, before any teacher/student is involved. There is no per-pair
// validator in distill-provenance.js to reuse, so this is a standalone surface
// with its own version tag ('prov-v1'). The distill lineage block consumes the
// summarized output of this module downstream; it is not duplicated here.
//
// Public API (never throws):
//   PROVENANCE_VERSION          - 'prov-v1'
//   recordProvenance(pair, m)   - returns pair with a complete provenance block
//   validateProvenance(pair)    - { ok, missing:[] }
//   summarizeProvenance(pairs)  - { by_source:{...}, total }

export const PROVENANCE_VERSION = 'prov-v1';

// Fields that MUST be present (non-empty) for a pair's provenance to be
// considered complete. Kept here so validate + record agree on the contract.
const REQUIRED_PROVENANCE_FIELDS = ['source_type', 'ingested_at', 'source_ref'];

function _isNonEmpty(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

function _nowIso() {
  return new Date().toISOString();
}

// Build (or complete) the provenance block for a single pair.
//
// `pair`       - { id?, input, output?, source_type?, source_ref?, ingested_at?, provenance? }
// `sourceMeta` - { source_type, source_ref, ingested_at?, extra? } describing
//                the origin. Anything already on the pair wins only when the
//                sourceMeta field is absent, so a caller can override per-pair.
//
// Returns a NEW pair object (does not mutate the input) with:
//   - top-level source_type / source_ref / ingested_at mirrored for cheap
//     filtering (the JSONL line shape the rest of the engine reads), and
//   - a nested provenance:{ source_type, source_ref, ingested_at, extra }.
export function recordProvenance(pair, sourceMeta = {}) {
  const p = (pair && typeof pair === 'object') ? pair : {};
  const meta = (sourceMeta && typeof sourceMeta === 'object') ? sourceMeta : {};
  const existing = (p.provenance && typeof p.provenance === 'object') ? p.provenance : {};

  const source_type = meta.source_type || p.source_type || existing.source_type || 'unknown';
  const source_ref = meta.source_ref != null ? meta.source_ref
    : (p.source_ref != null ? p.source_ref
      : (existing.source_ref != null ? existing.source_ref
        : (p.source != null ? p.source : 'unknown')));
  const ingested_at = meta.ingested_at || p.ingested_at || existing.ingested_at || _nowIso();

  // `extra` merges any caller-supplied detail with whatever was already there,
  // sourceMeta taking precedence. Always an object so downstream readers never
  // hit undefined.
  const extra = {
    ...(existing.extra && typeof existing.extra === 'object' ? existing.extra : {}),
    ...(meta.extra && typeof meta.extra === 'object' ? meta.extra : {}),
  };

  const provenance = {
    source_type,
    source_ref: String(source_ref),
    ingested_at,
    extra,
  };

  return {
    ...p,
    source_type,
    source_ref: String(source_ref),
    ingested_at,
    provenance,
  };
}

// Validate that a pair carries a complete provenance block.
// Returns { ok:boolean, missing:string[] }. Never throws.
//
// A field is considered present if it is non-empty either at the top level OR
// inside the nested provenance block (the writer mirrors both, but a hand-rolled
// pair from an external caller may only set one).
export function validateProvenance(pair) {
  const missing = [];
  if (!pair || typeof pair !== 'object') {
    return { ok: false, missing: [...REQUIRED_PROVENANCE_FIELDS] };
  }
  const prov = (pair.provenance && typeof pair.provenance === 'object') ? pair.provenance : {};
  for (const field of REQUIRED_PROVENANCE_FIELDS) {
    const top = pair[field];
    const nested = prov[field];
    if (!_isNonEmpty(top) && !_isNonEmpty(nested)) missing.push(field);
  }
  return { ok: missing.length === 0, missing };
}

// Summarize provenance across a set of pairs.
// Returns { by_source:{ <source_type>: count, … }, total }. Never throws.
export function summarizeProvenance(pairs) {
  const by_source = {};
  let total = 0;
  const list = Array.isArray(pairs) ? pairs : [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    total++;
    const prov = (p.provenance && typeof p.provenance === 'object') ? p.provenance : {};
    const st = p.source_type || prov.source_type || 'unknown';
    by_source[st] = (by_source[st] || 0) + 1;
  }
  return { by_source, total };
}

export default {
  PROVENANCE_VERSION,
  recordProvenance,
  validateProvenance,
  summarizeProvenance,
};
