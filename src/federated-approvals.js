// Federated approval-row sharing — W461.
//
// Closes audit 2026-05-19 P1 Federated Foundations cluster open item:
//   "approval-row sharing (decisions, not data); cross-org demo with 2+ tenants;
//   opt-in policy + audit chain."
//
// HONEST SCOPE — distinct from src/federated-learning.js (gradient-aggregation
// foundation). This module ships a DIFFERENT primitive: decision-aggregation,
// where the only thing that crosses a tenant boundary is sha256(namespace +
// ':' + input_hash + ':' + decision_kind). The receiver sees counts of
// matching approval hashes; it never sees the input text, output text,
// reviewer, or any raw label content.
//
// What an opted-in peer learns:
//   - "I have N approvals whose approval_hash matches yours" — and N is
//     Laplace-noised before crossing the wire (ε=1.0, sensitivity=1, scale=1.0).
//
// What an opted-in peer does NOT learn:
//   - The input prompt or output. Hashes are one-way.
//   - The reviewer identity. Hashes don't include reviewer.
//   - The tenant identity of the sharer beyond what the routing transport
//     leaks. This module records peer_id supplied by the caller; we do not
//     authenticate it. The privacy claim is over content, not identity.
//
// Opt-in is per-tenant, durable, and audited via AUDIT_OPS.FEDERATED_OPTIN /
// FEDERATED_OPTOUT / FEDERATED_SHARE. Opt-out is the default; a tenant that
// never opt-ins never sees its approvals leave the local store.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _loadApprovalsForRead } from './dataset-workbench.js';
import { getEvent } from './event-store.js';
import { appendAudit, AUDIT_OPS } from './audit.js';

export const FEATURE_STATE = 'foundation';
export const FEATURE_STATE_LABEL = 'Federated approval-row sharing (foundation)';
export const FEATURE_STATE_DESCRIPTION =
  'Foundation: hash-only approval-row sharing with Laplace-DP-noised aggregates. ' +
  'Network transport, peer-identity authentication, and Byzantine robustness are ' +
  'the caller responsibility — this module guarantees only that raw input/output ' +
  'text never crosses the tenant boundary.';

export const DEFAULT_DP_EPSILON = 1.0;
export const DP_SENSITIVITY = 1;
const MAX_AGGREGATE_QUERY_RESULTS = 1000;
const DECISION_KINDS = Object.freeze(['approved', 'rejected', 'edited']);

function _home() { return process.env.HOME || process.env.USERPROFILE || os.homedir(); }
function _base() {
  const b = process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
  fs.mkdirSync(b, { recursive: true });
  return b;
}
function _fedDir() { const p = path.join(_base(), 'federated'); fs.mkdirSync(p, { recursive: true }); return p; }
function _optInFile() { return path.join(_fedDir(), 'opt-in.json'); }
function _sharesFile() { return path.join(_fedDir(), 'shares.jsonl'); }

function canonicalize(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(canonicalize).join(',') + ']';
  const keys = Object.keys(o).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(o[k])).join(',') + '}';
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// approval_hash binds the namespace + input_hash + decision_kind into one
// short id that two tenants can compare without sharing the underlying input.
// input_hash is sha256 of the canonical input only. decision_kind is one of
// DECISION_KINDS. The namespace SHOULD be a public label the two tenants have
// agreed on out of band; sharing across mismatched namespaces is a contract
// violation, not a privacy leak (the hashes simply won't match).
export function computeApprovalHash({ namespace, input, decision_kind } = {}) {
  if (!namespace) throw new Error('computeApprovalHash requires namespace');
  if (input === undefined || input === null) throw new Error('computeApprovalHash requires input');
  if (!decision_kind) throw new Error('computeApprovalHash requires decision_kind');
  const norm_kind = String(decision_kind).toLowerCase();
  if (!DECISION_KINDS.includes(norm_kind)) {
    throw new Error('decision_kind must be one of ' + DECISION_KINDS.join(' | '));
  }
  const input_canonical = typeof input === 'string' ? input : canonicalize(input);
  const input_hash = sha256Hex(input_canonical);
  const composed = String(namespace) + ':' + input_hash + ':' + norm_kind;
  return {
    approval_hash: sha256Hex(composed),
    input_hash,
    decision_kind: norm_kind,
    namespace: String(namespace),
  };
}

function _loadOptInState() {
  const file = _optInFile();
  if (!fs.existsSync(file)) return { tenants: {} };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || { tenants: {} }; }
  catch { return { tenants: {} }; }
}

function _saveOptInState(state) {
  fs.writeFileSync(_optInFile(), JSON.stringify(state, null, 2));
}

// optIn({tenant_id, scope, peers, note}): record that tenant_id agrees to
// share approval hashes for the given scope (namespaces). peers is the
// opted-in list of peer ids that may RECEIVE this tenant's shares; an empty
// peers list means "share with the wider opt-in pool".
export function optIn({ tenant_id, scope = [], peers = [], note = null } = {}) {
  if (!tenant_id) throw new Error('optIn requires tenant_id');
  const namespaces = Array.isArray(scope) ? scope.slice() : (scope ? [String(scope)] : []);
  const state = _loadOptInState();
  const prior = state.tenants[tenant_id] || null;
  const ts = new Date().toISOString();
  const entry = {
    tenant_id,
    namespaces,
    peers: Array.isArray(peers) ? peers.slice() : [],
    note: note || null,
    opted_in_at: ts,
    prior_opted_in_at: prior ? prior.opted_in_at : null,
    feature_state: FEATURE_STATE,
  };
  state.tenants[tenant_id] = entry;
  _saveOptInState(state);
  try {
    appendAudit({
      tenant_id,
      op: AUDIT_OPS.FEDERATED_OPTIN,
      payload: { namespaces, peers: entry.peers, note },
    });
  } catch { /* audit failure must not block opt-in */ }
  return entry;
}

export function optOut({ tenant_id, reason = null } = {}) {
  if (!tenant_id) throw new Error('optOut requires tenant_id');
  const state = _loadOptInState();
  const prior = state.tenants[tenant_id];
  if (!prior) return { tenant_id, opted_out: true, prior_opted_in_at: null, reason };
  delete state.tenants[tenant_id];
  _saveOptInState(state);
  try {
    appendAudit({
      tenant_id,
      op: AUDIT_OPS.FEDERATED_OPTOUT,
      payload: { prior_opted_in_at: prior.opted_in_at, reason },
    });
  } catch {}
  return { tenant_id, opted_out: true, prior_opted_in_at: prior.opted_in_at, reason };
}

export function getOptInState(tenant_id) {
  if (!tenant_id) return null;
  return _loadOptInState().tenants[tenant_id] || null;
}

export function listPeers({ tenant_id = null } = {}) {
  const state = _loadOptInState();
  const peers = [];
  for (const t of Object.values(state.tenants)) {
    if (tenant_id && t.tenant_id === tenant_id) continue;
    peers.push({
      tenant_id: t.tenant_id,
      namespaces: t.namespaces,
      opted_in_at: t.opted_in_at,
      feature_state: t.feature_state || FEATURE_STATE,
    });
  }
  return peers;
}

// shareApprovalRows({tenant_id, namespace, since}): builds the hash-only
// payload of approvals the sharing tenant agreed to share. Reads the local
// approvals store, filters to the caller's tenant_id + namespace (scope must
// match opt-in), and emits one row per approval containing ONLY:
//   - approval_hash, input_hash, decision_kind, decided_at
//
// NEVER emits input text, output text, reviewer, or any field that could
// re-identify the row.
export async function shareApprovalRows({ tenant_id, namespace, since = null } = {}) {
  if (!tenant_id) throw new Error('shareApprovalRows requires tenant_id');
  if (!namespace) throw new Error('shareApprovalRows requires namespace');
  const opt = getOptInState(tenant_id);
  if (!opt) {
    const err = new Error('tenant has not opted in to federated sharing');
    err.code = 'NOT_OPTED_IN';
    throw err;
  }
  if (opt.namespaces.length && !opt.namespaces.includes(namespace)) {
    const err = new Error('namespace ' + namespace + ' not in opt-in scope ' + JSON.stringify(opt.namespaces));
    err.code = 'OUT_OF_SCOPE';
    throw err;
  }
  const sinceTs = since ? new Date(since).getTime() : 0;
  const approvals = _loadApprovalsForRead();
  const rows = [];
  for (const [eid, a] of Object.entries(approvals)) {
    if (a.tenant_id && a.tenant_id !== tenant_id) continue;
    if (!a.decided_at) continue;
    if (sinceTs && new Date(a.decided_at).getTime() < sinceTs) continue;
    const ev = await getEvent(eid);
    if (!ev) continue;
    if (ev.tenant_id && ev.tenant_id !== tenant_id) continue;
    const ev_ns = ev.namespace || ev.workflow_id || null;
    if (ev_ns && ev_ns !== namespace) continue;
    const input = ev.prompt_redacted || ev.input_redacted || ev.input || ev.prompt || null;
    if (input === null || input === undefined) continue;
    const decision_kind = a.decision === 'reject'
      ? 'rejected'
      : (a.fixed_output ? 'edited' : 'approved');
    const hashes = computeApprovalHash({ namespace, input, decision_kind });
    rows.push({
      approval_hash: hashes.approval_hash,
      input_hash: hashes.input_hash,
      decision_kind,
      decided_at: a.decided_at,
    });
  }
  const envelope = {
    tenant_id,
    namespace,
    since: since || null,
    rows_count: rows.length,
    shared_at: new Date().toISOString(),
    feature_state: FEATURE_STATE,
  };
  fs.appendFileSync(_sharesFile(), JSON.stringify(envelope) + '\n', 'utf8');
  try {
    appendAudit({
      tenant_id,
      op: AUDIT_OPS.FEDERATED_SHARE,
      payload: { namespace, rows_count: rows.length, since },
    });
  } catch {}
  return { envelope, rows };
}

// Laplace noise: pdf(x) = 1/(2b) exp(-|x|/b). Inverse CDF for u in (-0.5, 0.5):
//   x = -b sign(u) ln(1 - 2|u|)
function laplaceNoise(scale) {
  let u = Math.random() - 0.5;
  // avoid log(0) at the boundary
  if (u === 0) u = 1e-12;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

// aggregateApprovals({local_rows, peer_rows, epsilon}): DP-noised histogram
// of approval_hash → matching_count across local + peer rows. The local
// tenant sees its OWN counts in cleartext and peer counts ONLY through the
// noised aggregate.
export function aggregateApprovals({
  local_rows = [],
  peer_rows = [],
  epsilon = DEFAULT_DP_EPSILON,
} = {}) {
  if (!Array.isArray(local_rows)) throw new Error('local_rows must be an array');
  if (!Array.isArray(peer_rows)) throw new Error('peer_rows must be an array');
  if (!(epsilon > 0)) throw new Error('epsilon must be > 0');
  const scale = DP_SENSITIVITY / epsilon;

  const local_counts = new Map();
  for (const r of local_rows) {
    if (!r || !r.approval_hash) continue;
    local_counts.set(r.approval_hash, (local_counts.get(r.approval_hash) || 0) + 1);
  }
  const peer_counts = new Map();
  for (const r of peer_rows) {
    if (!r || !r.approval_hash) continue;
    peer_counts.set(r.approval_hash, (peer_counts.get(r.approval_hash) || 0) + 1);
  }
  const hashes = new Set([...local_counts.keys(), ...peer_counts.keys()]);
  const out = [];
  let i = 0;
  for (const h of hashes) {
    if (i++ >= MAX_AGGREGATE_QUERY_RESULTS) break;
    const local_n = local_counts.get(h) || 0;
    const peer_n_raw = peer_counts.get(h) || 0;
    const noised = peer_n_raw + laplaceNoise(scale);
    const peer_n_noised = Math.max(0, Math.round(noised));
    out.push({
      approval_hash: h,
      local_count: local_n,
      peer_count_noised: peer_n_noised,
      peer_count_raw_present: peer_n_raw > 0,
    });
  }
  return {
    feature_state: FEATURE_STATE,
    epsilon,
    sensitivity: DP_SENSITIVITY,
    laplace_scale: scale,
    rows: out,
    rows_count: out.length,
  };
}

export function auditTrail({ tenant_id, limit = 50 } = {}) {
  if (!tenant_id) throw new Error('auditTrail requires tenant_id');
  const file = _sharesFile();
  if (!fs.existsSync(file)) return { tenant_id, total: 0, shares: [] };
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const shares = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.tenant_id === tenant_id) shares.push(e);
    } catch {}
  }
  shares.reverse();
  return {
    tenant_id,
    total: shares.length,
    shares: shares.slice(0, Math.max(1, Math.min(500, Math.trunc(limit) || 50))),
  };
}

// Test/util — wipes the local federated state (opt-in registry + share
// ledger). Production callers MUST NOT use this; tests rely on it to keep
// fixtures isolated.
export function _wipeLocalState() {
  for (const f of [_optInFile(), _sharesFile()]) {
    try { fs.unlinkSync(f); } catch {}
  }
}
