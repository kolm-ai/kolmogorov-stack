// src/evidence-store.js
//
// R-5 - Per-artifact evidence DAG persistence.
//
// The DAG itself rides inside the .kolm manifest, but the router endpoints
// (/v1/evidence/:id, /v1/artifacts/:id/evidence-trace) need a stable
// lookup of "which artifact does this evidence node belong to" without
// having to walk every signed .kolm on disk at request time. We mirror the
// artifact-lifecycle.json pattern: one JSON file per artifact at
// data/artifacts/<artifact_id>/evidence-dag.json.
//
// The store is intentionally thin: it validates the DAG shape on write
// (delegating to buildDag in src/evidence-dag.js) and emits a per-node
// reverse index file at data/evidence/index.json so /v1/evidence/:id can
// resolve a node id to its owning artifact_id in O(1).

import fs from 'node:fs';
import path from 'node:path';
import { buildDag, toJSON as dagToJSON } from './evidence-dag.js';

const ON_VERCEL = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const BUNDLED_DATA_DIR = path.resolve('data');
const DATA_DIR = process.env.KOLM_DATA_DIR
  ? path.resolve(process.env.KOLM_DATA_DIR)
  : (ON_VERCEL ? '/tmp/data' : BUNDLED_DATA_DIR);

function _validArtifactId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_:.-]{1,128}$/.test(id);
}

function _evidencePath(artifact_id) {
  if (!_validArtifactId(artifact_id)) {
    throw new Error('invalid artifact_id: must match /^[a-zA-Z0-9_:.-]{1,128}$/');
  }
  return path.join(DATA_DIR, 'artifacts', artifact_id, 'evidence-dag.json');
}

function _indexPath() {
  return path.join(DATA_DIR, 'evidence', 'index.json');
}

function _readIndex() {
  const p = _indexPath();
  if (!fs.existsSync(p)) return { by_node: {}, by_artifact: {} };
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!obj || typeof obj !== 'object') return { by_node: {}, by_artifact: {} };
    if (!obj.by_node || typeof obj.by_node !== 'object') obj.by_node = {};
    if (!obj.by_artifact || typeof obj.by_artifact !== 'object') obj.by_artifact = {};
    return obj;
  } catch {
    return { by_node: {}, by_artifact: {} };
  }
}

function _writeIndex(obj) {
  const p = _indexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * Write the evidence DAG for an artifact + re-index its node ids. The input
 * is validated via buildDag, so a malformed graph is rejected here before
 * touching disk.
 */
export function writeEvidenceDag(artifact_id, dagInput) {
  const dag = buildDag(dagInput);
  const json = dagToJSON(dag);
  const p = _evidencePath(artifact_id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
  fs.renameSync(tmp, p);
  // Rebuild the per-node reverse index for this artifact.
  const idx = _readIndex();
  // Drop any stale entries from a previous write for this artifact.
  const prior = Array.isArray(idx.by_artifact[artifact_id]) ? idx.by_artifact[artifact_id] : [];
  for (const old of prior) {
    if (idx.by_node[old] === artifact_id) delete idx.by_node[old];
  }
  // Stamp the new entries.
  const ids = json.nodes.map((n) => n.id);
  idx.by_artifact[artifact_id] = ids;
  for (const id of ids) idx.by_node[id] = artifact_id;
  _writeIndex(idx);
  return { artifact_id, dag: json };
}

/**
 * Read the evidence DAG JSON for an artifact. Returns null when no record
 * exists; throws only on disk I/O errors so callers can branch on absence.
 */
export function readEvidenceDag(artifact_id) {
  const p = _evidencePath(artifact_id);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * Resolve a node id back to its owning artifact_id. Returns null when the
 * node id has not been indexed (no artifact carries it).
 */
export function findArtifactForNode(node_id) {
  const idx = _readIndex();
  return idx.by_node[node_id] || null;
}

/**
 * Pull a single node record from the stored DAG. Returns null when either
 * the node id is unknown or the artifact's DAG has been deleted on disk.
 */
export function readNode(node_id) {
  const owner = findArtifactForNode(node_id);
  if (!owner) return null;
  const dag = readEvidenceDag(owner);
  if (!dag) return null;
  const node = (dag.nodes || []).find((n) => n.id === node_id);
  if (!node) return null;
  return { artifact_id: owner, node };
}

/**
 * Test helper - wipe a single artifact's evidence record. Production callers
 * should rely on the artifact-lifecycle archive path; this exists so unit
 * tests can run hermetically without touching real lake state.
 */
export function _resetForTests(artifact_id) {
  try { fs.unlinkSync(_evidencePath(artifact_id)); } catch {} // deliberate: cleanup
  const idx = _readIndex();
  const ids = idx.by_artifact[artifact_id] || [];
  for (const id of ids) {
    if (idx.by_node[id] === artifact_id) delete idx.by_node[id];
  }
  delete idx.by_artifact[artifact_id];
  _writeIndex(idx);
}
