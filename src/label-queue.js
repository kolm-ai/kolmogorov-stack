// W369 — label queue.
//
// Pulls the next N events that have no decision in ~/.kolm/labels/approvals.jsonl,
// records a verdict (good / bad / edit) per submission. Verdicts are stored
// both as the dataset-workbench approval row AND as per-event label files at
// ~/.kolm/labels/<event_id>.json so callers (training, audit, replay) can
// look up a single event without scanning the whole jsonl.
//
// Priority: events from accepted local_replacement_candidate opportunities
// surface first; the rest fall back to newest-first order.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listEvents, getEvent } from './event-store.js';
import { approveEvent, rejectEvent, editEvent } from './dataset-workbench.js';
import { loadOpportunitiesState, findOpportunities } from './opportunity-engine.js';

function _home() { return process.env.HOME || process.env.USERPROFILE || os.homedir(); }
function _base() {
  const b = process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
  fs.mkdirSync(b, { recursive: true });
  return b;
}
function _labelsDir() { const p = path.join(_base(), 'labels'); fs.mkdirSync(p, { recursive: true }); return p; }
function _approvalsFile() { return path.join(_labelsDir(), 'approvals.jsonl'); }
function _labelFile(eventId) { return path.join(_labelsDir(), eventId + '.json'); }

function _loadApprovals() {
  const file = _approvalsFile();
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.event_id) out[e.event_id] = e;
    } catch {} // deliberate: cleanup
  }
  return out;
}

// nextToLabel({reviewer, workflowId, namespace, n, tenant}): up to N events
// that have no decision. Prioritises events whose template-signature matches
// an accepted opportunity.
//
// W411 — tenant scope: when `tenant` / `tenant_id` is supplied, the underlying
// listEvents() is restricted to the caller's rows and approval rows for events
// owned by a different tenant are ignored. This prevents tenantA's reviewer
// from ever seeing tenantB's pending events.
export async function nextToLabel(opts = {}) {
  const n = opts.n == null ? 1 : Math.max(1, Math.min(200, Math.trunc(opts.n)));
  const namespace = opts.namespace || opts.workflowId || null;
  const workflowId = opts.workflowId || null;
  const tenantScope = opts.tenant_id || opts.tenant || null;
  const events = await listEvents({
    namespace,
    tenant_id: tenantScope,
    workflow_id: workflowId,
    limit: 1000,
    order: 'desc',
  });
  const approvals = _loadApprovals();
  const undecided = events.filter(e => !approvals[e.event_id]);

  // Boost: events appearing in an accepted opportunity's sample_event_ids
  // bubble up first.
  const state = loadOpportunitiesState();
  const accepted = Object.values(state.byId).filter(s => s.status === 'accepted').map(s => s.id);
  let boost = new Set();
  if (accepted.length) {
    try {
      const opps = await findOpportunities({ namespace, limit: 5000 });
      for (const o of opps) {
        if (accepted.includes(o.id) && Array.isArray(o.sample_event_ids)) {
          for (const id of o.sample_event_ids) boost.add(id);
        }
      }
    } catch {} // deliberate: cleanup
  }
  const head = undecided.filter(e => boost.has(e.event_id));
  const tail = undecided.filter(e => !boost.has(e.event_id));
  return head.concat(tail).slice(0, n);
}

// submitLabel(eventId, {verdict, fixedOutput, sensitive, holdoutOnly, workflow,
//   reviewer, teamApproval, coReviewers})
// verdict: 'good' | 'bad' | 'edit'. 'edit' requires fixedOutput.
//
// W409o additions:
//   - teamApproval / coReviewers : multi-reviewer mode. The label persisted
//     on disk records every reviewer that touched it (not just last-write).
//   - audit trail flows through dataset-workbench.approveEvent which writes
//     {audit: {prior_decision, prior_reviewer, before_output, after_output}}
//     to approvals.jsonl, the append-only log of the decision history.
export async function submitLabel(eventId, opts = {}) {
  if (!eventId) throw new Error('submitLabel requires an event_id');
  const verdict = (opts.verdict || 'good').toLowerCase();
  if (!['good', 'bad', 'edit'].includes(verdict)) throw new Error('verdict must be good|bad|edit');
  const ev = await getEvent(eventId);
  if (!ev) throw new Error('event not found: ' + eventId);
  // W411 — cross-tenant gate. When the caller supplies `tenant`/`tenant_id`,
  // the event's owner MUST match. The deeper approveEvent/rejectEvent enforces
  // the same check, but bailing here returns a cleaner error to the route.
  const callerTenant = opts.tenant_id || opts.tenant || null;
  if (callerTenant && ev.tenant_id && callerTenant !== ev.tenant_id) {
    const err = new Error('cross_tenant_label: caller=' + callerTenant + ' event_owner=' + ev.tenant_id);
    err.code = 'CROSS_TENANT_LABEL';
    throw err;
  }
  const reviewer = opts.reviewer || 'local-user';
  const ts = new Date().toISOString();
  const teamApproval = opts.teamApproval === true;
  const coReviewers = Array.isArray(opts.coReviewers) ? opts.coReviewers : [];

  let approvalRow;
  if (verdict === 'good') {
    approvalRow = await approveEvent(eventId, {
      sensitive: opts.sensitive,
      holdoutOnly: opts.holdoutOnly,
      workflow: opts.workflow,
      reviewer,
      teamApproval,
      coReviewers,
      tenant_id: callerTenant,
    });
  } else if (verdict === 'bad') {
    approvalRow = await rejectEvent(eventId, {
      reason: opts.reason,
      reviewer,
      teamApproval,
      coReviewers,
      tenant_id: callerTenant,
    });
  } else {
    if (opts.fixedOutput == null) throw new Error('verdict=edit requires fixedOutput');
    approvalRow = await editEvent(eventId, String(opts.fixedOutput), {
      sensitive: opts.sensitive,
      holdoutOnly: opts.holdoutOnly,
      workflow: opts.workflow,
      reviewer,
      teamApproval,
      coReviewers,
      tenant_id: callerTenant,
    });
  }

  // Merge any pre-existing label so multi-reviewer mode preserves the
  // earlier reviewer's verdict in `co_reviewers_seen`.
  const prior = getLabel(eventId);
  const priorReviewers = (prior && Array.isArray(prior.co_reviewers_seen) ? prior.co_reviewers_seen : []);
  const seen = new Set([...priorReviewers, ...(prior && prior.reviewer ? [prior.reviewer] : []), ...coReviewers, reviewer]);
  const label = {
    event_id: eventId,
    tenant_id: callerTenant || ev.tenant_id || null,
    verdict,
    fixed_output: opts.fixedOutput != null ? String(opts.fixedOutput) : null,
    sensitive: opts.sensitive === true,
    holdout_only: opts.holdoutOnly === true,
    workflow: opts.workflow || null,
    reviewer,
    labeled_at: ts,
    team_approval: teamApproval,
    co_reviewers: coReviewers,
    co_reviewers_seen: Array.from(seen),
    prior_verdict: prior ? prior.verdict : null,
    prior_reviewer: prior ? prior.reviewer : null,
  };
  fs.writeFileSync(_labelFile(eventId), JSON.stringify(label, null, 2));
  return { label, approval: approvalRow };
}

// labelStats({tenant?}): pending / approved / rejected / edited counts, plus
// per-reviewer and per-workflow rollups. Computes pending by reading all
// events in the store and subtracting decided ones.
//
// W411 — tenant scope: when `tenant`/`tenant_id` is supplied, both the event
// total and the approvals are restricted to rows owned by that tenant. The
// stats a caller sees never mix tenantA's pending with tenantB's approved.
export async function labelStats(opts = {}) {
  const tenantScope = (opts && (opts.tenant_id || opts.tenant)) || null;
  const approvals = _loadApprovals();
  let approved = 0, rejected = 0, edited = 0;
  const byReviewer = {};
  const byWorkflow = {};
  // When a tenant filter is set, drop approvals for events that don't belong
  // to that tenant. Legacy approvals (pre-W411) without a tenant_id stamp are
  // also dropped — fail-closed.
  const filteredApprovals = {};
  for (const [eid, a] of Object.entries(approvals)) {
    if (tenantScope) {
      if (!a.tenant_id) continue;
      if (a.tenant_id !== tenantScope) continue;
    }
    filteredApprovals[eid] = a;
    if (a.decision === 'reject') rejected++;
    else if (a.fixed_output) edited++;
    else approved++;
    const r = a.reviewer || 'unknown';
    byReviewer[r] = (byReviewer[r] || 0) + 1;
    const w = a.workflow || '_none';
    byWorkflow[w] = (byWorkflow[w] || 0) + 1;
  }
  const total = await listEvents({ limit: 0, tenant_id: tenantScope });
  const decided = new Set(Object.keys(filteredApprovals));
  let pending = 0;
  for (const e of total) {
    if (!decided.has(e.event_id)) pending++;
  }
  return {
    pending,
    approved,
    rejected,
    edited,
    total_events: total.length,
    decided: decided.size,
    by_reviewer: byReviewer,
    by_workflow: byWorkflow,
  };
}

// getLabel(eventId): return the persisted label record or null.
export function getLabel(eventId) {
  const file = _labelFile(eventId);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
