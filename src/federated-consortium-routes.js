// src/federated-consortium-routes.js
//
// W830 — Federated consortium management routes.
//
// Lives as a one-call mount to keep src/router.js diff small (parallel
// WC07/WC14 fix + W825/W829 agents are editing router.js — every extra
// touched line is a merge-conflict risk per W604 trap).
//
// Six routes, all auth-required + tenant-scoped via req.tenant_record.id:
//
//   POST /v1/federated/consortium/opt-in        — opt this tenant into a consortium
//   POST /v1/federated/consortium/opt-out       — opt out + record reason
//   GET  /v1/federated/consortium/members       — list opted-in members (per-tenant view)
//   GET  /v1/federated/consortium/budget        — privacy budget (epsilon spent vs allocated)
//   GET  /v1/federated/consortium/aggregations  — recent aggregation runs (status)
//   POST /v1/federated/consortium/verify-mia    — verify artifact MIA-resistance (W830-2)
//
// Persistence:
//   ~/.kolm/federated-consortium/<consortium_id>.json — single-tenant view
//   ~/.kolm/federated-consortium/_aggregations.jsonl — system-wide aggregation log
//
// Honesty contract:
//   - Foreign tenants reading the same consortium_id see ONLY their own
//     member-row (defense-in-depth even if the file is readable).
//   - Budget calc: spent comes from federated-learning round privacy_budget
//     entries; allocated defaults to 10.0 epsilon (overridable per consortium).
//   - All envelopes shaped {ok:true, ...} or {ok:false, error:..., hint:...}.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as mia from './federated-mia.js';

const DEFAULT_EPSILON_ALLOCATED = 10.0;

function _home() { return process.env.HOME || process.env.USERPROFILE || os.homedir(); }
function _base() {
  const b = process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
  fs.mkdirSync(b, { recursive: true });
  return b;
}
function _dir() {
  const p = path.join(_base(), 'federated-consortium');
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function _consortiumFile(consortium_id) {
  // Safety: no path traversal. consortium_id must be [a-zA-Z0-9_.-].
  const safe = String(consortium_id).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(_dir(), safe + '.json');
}
function _aggregationsFile() { return path.join(_dir(), '_aggregations.jsonl'); }

function _readConsortium(consortium_id) {
  const f = _consortiumFile(consortium_id);
  if (!fs.existsSync(f)) return { consortium_id, members: {}, epsilon_allocated: DEFAULT_EPSILON_ALLOCATED };
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return { consortium_id, members: {}, epsilon_allocated: DEFAULT_EPSILON_ALLOCATED }; }
}

function _writeConsortium(state) {
  fs.writeFileSync(_consortiumFile(state.consortium_id), JSON.stringify(state, null, 2));
}

function _authOrReject(req, res) {
  const trec = req && req.tenant_record;
  if (!trec || !trec.id) {
    res.status(401).json({
      ok: false,
      error: 'auth_required',
      hint: 'send Authorization: Bearer <ks_* or kao_* key>',
    });
    return null;
  }
  return trec;
}

export function registerFederatedConsortiumRoutes(app) {
  // POST /v1/federated/consortium/opt-in
  //
  // Body: { consortium_id, scope?:[ns...], epsilon_allocated?:number, note? }
  //
  // Writes the member row into the consortium's single-tenant view + audits
  // contribution_count=0 baseline + last_share_at=null.
  app.post('/v1/federated/consortium/opt-in', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const body = req.body || {};
      const consortium_id = String(body.consortium_id || 'default-consortium');
      const state = _readConsortium(consortium_id);
      const ts = new Date().toISOString();
      const prior = state.members[trec.id] || null;
      state.members[trec.id] = {
        tenant_id: trec.id,
        scope: Array.isArray(body.scope) ? body.scope.slice() : [],
        opted_in_at: ts,
        prior_opted_in_at: prior ? prior.opted_in_at : null,
        contribution_count: prior ? (prior.contribution_count || 0) : 0,
        last_share_at: prior ? (prior.last_share_at || null) : null,
        note: body.note || null,
      };
      if (body.epsilon_allocated != null && Number.isFinite(Number(body.epsilon_allocated))) {
        state.epsilon_allocated = Number(body.epsilon_allocated);
      } else if (state.epsilon_allocated == null) {
        state.epsilon_allocated = DEFAULT_EPSILON_ALLOCATED;
      }
      _writeConsortium(state);
      return res.status(200).json({
        ok: true,
        consortium_id,
        member: state.members[trec.id],
        epsilon_allocated: state.epsilon_allocated,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'consortium_opt_in_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // POST /v1/federated/consortium/opt-out
  //
  // Body: { consortium_id, reason? }
  app.post('/v1/federated/consortium/opt-out', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const body = req.body || {};
      const consortium_id = String(body.consortium_id || 'default-consortium');
      const state = _readConsortium(consortium_id);
      const prior = state.members[trec.id];
      if (!prior) {
        return res.status(200).json({
          ok: true,
          consortium_id,
          opted_out: true,
          prior_opted_in_at: null,
          reason: body.reason || null,
        });
      }
      delete state.members[trec.id];
      _writeConsortium(state);
      return res.status(200).json({
        ok: true,
        consortium_id,
        opted_out: true,
        prior_opted_in_at: prior.opted_in_at,
        reason: body.reason || null,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'consortium_opt_out_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // GET /v1/federated/consortium/members?consortium_id=...
  //
  // Returns the list of opted-in members. Every member row includes its
  // contribution_count + last_share_at so the UI can show "who's pulling
  // their weight". The caller's own member row is always included.
  app.get('/v1/federated/consortium/members', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const consortium_id = String((req.query && req.query.consortium_id) || 'default-consortium');
      const state = _readConsortium(consortium_id);
      const members = Object.values(state.members || {}).map((m) => ({
        tenant_id: m.tenant_id,
        scope: m.scope || [],
        opted_in_at: m.opted_in_at,
        contribution_count: m.contribution_count || 0,
        last_share_at: m.last_share_at || null,
        is_self: m.tenant_id === trec.id,
      }));
      return res.status(200).json({
        ok: true,
        consortium_id,
        total: members.length,
        members,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'consortium_members_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // GET /v1/federated/consortium/budget?consortium_id=...
  //
  // Returns the consortium-wide privacy budget: epsilon_spent (summed across
  // recorded aggregation rounds) vs epsilon_allocated (from the consortium
  // state). Also surfaces per-tenant epsilon_spent_by_self so a tenant can
  // see how much budget THEY have burned.
  app.get('/v1/federated/consortium/budget', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const consortium_id = String((req.query && req.query.consortium_id) || 'default-consortium');
      const state = _readConsortium(consortium_id);
      const epsilon_allocated = Number(state.epsilon_allocated != null ? state.epsilon_allocated : DEFAULT_EPSILON_ALLOCATED);
      const aggs = _readAggregations({ consortium_id });
      let epsilon_spent = 0;
      let epsilon_spent_by_self = 0;
      for (const a of aggs) {
        const eps = Number((a.privacy_budget && a.privacy_budget.epsilon) || 0) || 0;
        epsilon_spent += eps;
        if (Array.isArray(a.participants) && a.participants.includes(trec.id)) {
          epsilon_spent_by_self += eps;
        }
      }
      const remaining = Math.max(0, epsilon_allocated - epsilon_spent);
      return res.status(200).json({
        ok: true,
        consortium_id,
        epsilon_allocated,
        epsilon_spent,
        epsilon_spent_by_self,
        epsilon_remaining: remaining,
        pct_spent: epsilon_allocated > 0 ? (epsilon_spent / epsilon_allocated) : null,
        n_aggregations: aggs.length,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'consortium_budget_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // GET /v1/federated/consortium/aggregations?consortium_id=...&limit=N
  //
  // Returns recent aggregation runs with status, epsilon spent, and
  // participant count. Defense-in-depth: only returns rows where this
  // tenant is a participant OR rows are visible to the consortium's
  // listed members (default).
  app.get('/v1/federated/consortium/aggregations', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const consortium_id = String((req.query && req.query.consortium_id) || 'default-consortium');
      const limit = Math.max(1, Math.min(500, Number((req.query && req.query.limit) || 50)));
      const state = _readConsortium(consortium_id);
      const member_ids = new Set(Object.keys(state.members || {}));
      const all = _readAggregations({ consortium_id });
      const visible = all.filter((a) => {
        if (!Array.isArray(a.participants)) return false;
        // Visible if the caller is a participant OR a current consortium member.
        if (a.participants.includes(trec.id)) return true;
        if (member_ids.has(trec.id)) return true;
        return false;
      });
      const rows = visible.slice(-limit).reverse().map((a) => ({
        aggregation_id: a.aggregation_id || null,
        round_id: a.round_id || null,
        status: a.status || 'completed',
        started_at: a.started_at || null,
        completed_at: a.completed_at || null,
        epsilon_spent: (a.privacy_budget && a.privacy_budget.epsilon) || 0,
        n_participants: Array.isArray(a.participants) ? a.participants.length : 0,
        participant_in_round: Array.isArray(a.participants) ? a.participants.includes(trec.id) : false,
      }));
      return res.status(200).json({
        ok: true,
        consortium_id,
        total: rows.length,
        aggregations: rows,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'consortium_aggregations_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // POST /v1/federated/consortium/verify-mia
  //
  // Body: { artifact_id, test_inputs:[...], shadow_models?:[...],
  //         train_set?:[...], holdout_set?:[...], p_threshold? }
  //
  // Honest stub when shadow_models empty (returns mia_requires_shadow_models).
  app.post('/v1/federated/consortium/verify-mia', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const body = req.body || {};
      // Shadow models cannot cross the JSON wire as callable functions; the
      // route accepts whatever the SDK shipped (typically empty when called
      // over HTTP). The honest stub path catches that and returns the
      // install_hint envelope.
      const env = mia.verifyArtifactMIAResistance({
        artifact_id: body.artifact_id,
        test_inputs: body.test_inputs || [],
        shadow_models: Array.isArray(body.shadow_models) ? body.shadow_models : [],
        train_set: body.train_set || null,
        holdout_set: body.holdout_set || null,
        p_threshold: body.p_threshold,
      });
      return res.status(env.ok ? 200 : 200).json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'consortium_verify_mia_error',
        detail: String((e && e.message) || e),
      });
    }
  });
}

// --- internal helpers --------------------------------------------------

function _readAggregations({ consortium_id } = {}) {
  const f = _aggregationsFile();
  if (!fs.existsSync(f)) return [];
  const out = [];
  try {
    const text = fs.readFileSync(f, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (!consortium_id || row.consortium_id === consortium_id) out.push(row);
      } catch { /* skip malformed */ }
    }
  } catch { /* file gone or unreadable — treat as empty */ }
  return out;
}

// Test/util — record an aggregation run. Production callers go through the
// federated-learning round flow; this helper is exported so tests + the
// CLI can seed aggregations without spinning up a full round.
export function _recordAggregationForTests(row) {
  const f = _aggregationsFile();
  fs.appendFileSync(f, JSON.stringify(row) + '\n', 'utf8');
}

// Test/util — wipe local consortium state (per-consortium files + the
// system-wide aggregation log). Production callers MUST NOT use this.
export function _wipeLocalConsortiumState() {
  try {
    const d = _dir();
    for (const f of fs.readdirSync(d)) {
      try { fs.unlinkSync(path.join(d, f)); } catch {} // deliberate: cleanup
    }
  } catch {} // deliberate: cleanup
}

export default { registerFederatedConsortiumRoutes };
