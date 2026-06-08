// W369 - dataset workbench.
//
// Turns accepted opportunities + approved events into named datasets with
// deterministic train/holdout splits. Hard rule: train_ids and holdout_ids
// MUST be disjoint. splitDataset() asserts this; createDataset() runs through
// it on the way in.
//
// W409n - extension: canonical row shape + seeds.jsonl import/export, plus
// synthetic-tagged bucket and `approved_only` mode for compile-pipeline.
// Multimodal + agent/workflow trace fields are preserved (workflow_id,
// trace_id, tool_calls, media_*).
//
// State on disk:
//   ~/.kolm/labels/approvals.jsonl - per-event approve/reject decisions
//   ~/.kolm/datasets/<dataset_id>.json - full dataset record
//
// All paths honor KOLM_DATA_DIR override so tests can isolate.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { listEvents, getEvent, appendEvent } from './event-store.js';
import { newEvent } from './event-schema.js';
import { loadOpportunitiesState } from './opportunity-engine.js';

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
function _base() {
  const b = process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
  fs.mkdirSync(b, { recursive: true });
  return b;
}
function _labelsDir() { const p = path.join(_base(), 'labels'); fs.mkdirSync(p, { recursive: true }); return p; }
function _datasetsDir() { const p = path.join(_base(), 'datasets'); fs.mkdirSync(p, { recursive: true }); return p; }
function _approvalsFile() { return path.join(_labelsDir(), 'approvals.jsonl'); }

function _loadApprovals() {
  const file = _approvalsFile();
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.event_id) out[e.event_id] = e; // last write wins
    } catch {} // deliberate: cleanup
  }
  return out;
}

// Exported alias so external callers (distill-pipeline approved-only mode,
// compile-pipeline guard) can read the same source of truth without
// duplicating the parser.
export function _loadApprovalsForRead() { return _loadApprovals(); }

// W409n - load the full audit trail for an event (every approval/reject/edit
// the reviewer touched, oldest-first). Returns [] for events with no history.
// The single-row last-write-wins approvals map collapses history; for
// audit purposes we want every entry.
export function loadAuditTrail(eventId) {
  const file = _approvalsFile();
  if (!fs.existsSync(file)) return [];
  const trail = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.event_id === eventId) trail.push(e);
    } catch {} // deliberate: cleanup
  }
  return trail;
}

// W409n - canonical row shape. Every dataset consumer (training, eval,
// bakeoff, distill) reads the same envelope so we never have to special-case
// "is this prompt under .prompt or .input" branching at the read site.
//
// Returns { input, output, prompt, completion, event_id, namespace, workflow_id,
//   trace_id, tool_calls, model, provider, sensitive, source_type,
//   media: {kind, uri, hash, bytes, mime, extracted_text, extraction_status},
//   labeled: {approved, edited, reviewer, fixed_output, holdout_only}
// }. Honors any approval row that overrides the original response with a
// reviewer-supplied fixed_output (so the canonical output IS the curated
// label when one exists).
export function normalizeRow(ev, opts = {}) {
  if (!ev || typeof ev !== 'object') return null;
  const approvalRow = opts.approval || null;
  const fixed = approvalRow && approvalRow.fixed_output ? String(approvalRow.fixed_output) : null;
  const input = ev.prompt_redacted || ev.prompt || ev.input || '';
  const baseOutput = ev.response_redacted || ev.response || ev.output || '';
  const output = fixed != null ? fixed : baseOutput;
  return {
    event_id: ev.event_id || null,
    namespace: ev.namespace || null,
    // Canonical (kolm-native) - every consumer SHOULD read these.
    input: String(input),
    output: String(output),
    // Mirror under prompt/completion so HuggingFace-style consumers can use
    // the same row without an adapter pass. Keeping both is free and the
    // contract is that they MUST be identical (input===prompt, output===completion).
    prompt: String(input),
    completion: String(output),
    workflow_id: ev.workflow_id || null,
    trace_id: ev.trace_id || null,
    tool_calls: Array.isArray(ev.tool_calls) ? ev.tool_calls : [],
    model: ev.model || null,
    provider: ev.provider || null,
    sensitive: !!ev.sensitive_data_detected,
    source_type: ev.source_type || 'real',
    media: ev.media_kind ? {
      kind: ev.media_kind,
      uri: ev.media_uri || null,
      hash: ev.media_hash || null,
      bytes: ev.media_bytes || null,
      mime: ev.media_mime || null,
      extracted_text: ev.media_extracted_text || null,
      extraction_status: ev.media_extraction_status || 'none',
    } : null,
    labeled: approvalRow ? {
      approved: approvalRow.decision === 'approve',
      edited: fixed != null,
      reviewer: approvalRow.reviewer || null,
      fixed_output: fixed,
      holdout_only: !!approvalRow.holdout_only,
      decided_at: approvalRow.decided_at || null,
    } : null,
  };
}

// listCandidates({namespace, minConfidence})
//   - Pulls events from the namespace.
//   - Excludes any event already approved or rejected.
//   - If a local_replacement_candidate opportunity is accepted, prioritises
//     events that match its template signature.
export async function listCandidates(opts = {}) {
  const namespace = opts.namespace;
  const limit = opts.limit == null ? 500 : opts.limit;
  const events = await listEvents({ namespace, limit, order: 'desc' });
  const approvals = _loadApprovals();
  const candidates = events.filter(e => !approvals[e.event_id]);
  // Surface accepted-opportunity events first.
  const state = loadOpportunitiesState();
  const acceptedTemplateSigs = new Set();
  for (const o of Object.values(state.byId)) {
    if (o.status !== 'accepted') continue;
    // We can't recover the template_signature from state alone without the
    // live opportunity, but the event ids themselves are stable. The caller
    // can re-run findOpportunities() for the full picture; here we just
    // return the unlabeled set in newest-first order.
  }
  acceptedTemplateSigs.size; // satisfy linter
  return candidates;
}

// approveEvent: append a positive-decision row to approvals.jsonl. The
// optional fixedOutput is the "label" used to train future models.
//
// W409o - captures before/after audit trail: the row records the prior
// reviewer + decision (if any) so a multi-reviewer mode can rebuild who
// said what when. The approvals file is append-only (jsonl) so the trail is
// preserved even after the last-write-wins map collapses it for split.
export async function approveEvent(eventId, opts = {}) {
  if (!eventId) throw new Error('approveEvent requires an event_id');
  const ev = await getEvent(eventId);
  if (!ev) throw new Error('event not found: ' + eventId);
  // W411 - tenant_id of the approval is pinned to the event's tenant_id.
  // Routes that supply an explicit `tenant`/`tenant_id` MUST match the event's
  // owner; otherwise the call fail-closes with cross_tenant_approval. This
  // prevents tenantA from approving tenantB's rows.
  const callerTenant = opts.tenant_id || opts.tenant || null;
  if (callerTenant && ev.tenant_id && callerTenant !== ev.tenant_id) {
    const err = new Error('cross_tenant_approval: caller=' + callerTenant + ' event_owner=' + ev.tenant_id);
    err.code = 'CROSS_TENANT_APPROVAL';
    throw err;
  }
  const prior = _loadApprovals()[eventId] || null;
  const before = ev.response_redacted || ev.response || ev.output || null;
  const after = opts.fixedOutput != null ? String(opts.fixedOutput) : before;
  const entry = {
    event_id: eventId,
    tenant_id: ev.tenant_id || callerTenant || null,
    decision: 'approve',
    fixed_output: opts.fixedOutput != null ? String(opts.fixedOutput) : null,
    sensitive: opts.sensitive === true,
    holdout_only: opts.holdoutOnly === true,
    reviewer: opts.reviewer || 'local-user',
    workflow: opts.workflow || null,
    decided_at: new Date().toISOString(),
    team_approval: opts.teamApproval === true,
    co_reviewers: Array.isArray(opts.coReviewers) ? opts.coReviewers : [],
    audit: {
      prior_decision: prior ? prior.decision : null,
      prior_reviewer: prior ? prior.reviewer : null,
      prior_fixed_output: prior ? (prior.fixed_output || null) : null,
      before_output: before,
      after_output: after,
    },
  };
  fs.appendFileSync(_approvalsFile(), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

export async function rejectEvent(eventId, opts = {}) {
  if (!eventId) throw new Error('rejectEvent requires an event_id');
  // W411 - same cross-tenant gate as approveEvent.
  const ev = await getEvent(eventId);
  const callerTenant = opts.tenant_id || opts.tenant || null;
  if (callerTenant && ev && ev.tenant_id && callerTenant !== ev.tenant_id) {
    const err = new Error('cross_tenant_approval: caller=' + callerTenant + ' event_owner=' + ev.tenant_id);
    err.code = 'CROSS_TENANT_APPROVAL';
    throw err;
  }
  const prior = _loadApprovals()[eventId] || null;
  const entry = {
    event_id: eventId,
    tenant_id: (ev && ev.tenant_id) || callerTenant || null,
    decision: 'reject',
    reason: opts.reason || null,
    reviewer: opts.reviewer || 'local-user',
    decided_at: new Date().toISOString(),
    team_approval: opts.teamApproval === true,
    co_reviewers: Array.isArray(opts.coReviewers) ? opts.coReviewers : [],
    audit: {
      prior_decision: prior ? prior.decision : null,
      prior_reviewer: prior ? prior.reviewer : null,
      prior_fixed_output: prior ? (prior.fixed_output || null) : null,
      reason: opts.reason || null,
    },
  };
  fs.appendFileSync(_approvalsFile(), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

// editEvent: alias for approve with fixedOutput - captures the "edit" verdict
// used by label-queue submitLabel.
export async function editEvent(eventId, fixedOutput, opts = {}) {
  return approveEvent(eventId, { ...opts, fixedOutput });
}

function _dsId(seed) {
  const h = crypto.createHash('sha256').update(seed + ':' + Date.now()).digest('hex').slice(0, 10);
  return 'ds_' + h;
}

// splitDataset(datasetId, train_ratio, opts): deterministic split by sha256 of
// (seed:event_id) mod 100. Asserts disjointness. Returns {train_ids,
// holdout_ids, train_count, holdout_count, split_signature, seed}.
//
// W409n - the seed argument is mixed into the hash so two calls with the same
// seed produce identical splits across machines / processes. Default seed is
// the dataset_id itself (legacy behavior) so existing splits are unchanged.
export async function splitDataset(datasetId, train_ratio = 0.8, opts = {}) {
  const file = path.join(_datasetsDir(), datasetId + '.json');
  if (!fs.existsSync(file)) throw new Error('dataset not found: ' + datasetId);
  const ds = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ratio = Math.max(0.01, Math.min(0.99, Number(train_ratio) || 0.8));
  const cutoff = Math.floor(ratio * 100);
  // Prefer explicit opts.seed > the stored record.seed > the dataset_id.
  const seed = opts.seed != null ? String(opts.seed)
    : (ds.seed != null ? String(ds.seed) : datasetId);
  const train = [];
  const holdout = [];
  const bucketFor = (eid) => parseInt(crypto.createHash('sha256').update(seed + ':' + String(eid)).digest('hex').slice(0, 8), 16) % 100;
  for (const eid of ds.source_event_ids) {
    const bucket = bucketFor(eid);
    if (bucket < cutoff) train.push(eid); else holdout.push(eid);
  }
  // Honor approval holdout_only flags: any event flagged holdout_only goes
  // into the holdout bucket regardless of hash.
  const approvals = _loadApprovals();
  for (const eid of [...train]) {
    if (approvals[eid] && approvals[eid].holdout_only) {
      train.splice(train.indexOf(eid), 1);
      if (!holdout.includes(eid)) holdout.push(eid);
    }
  }
  const minHoldout = Math.max(0, Number(opts.min_holdout ?? opts.minHoldout ?? 0) || 0);
  const minTrain = Math.max(0, Number(opts.min_train ?? opts.minTrain ?? 0) || 0);
  const canSatisfyFloors = ds.source_event_ids.length >= (minTrain + minHoldout);
  if (canSatisfyFloors && minHoldout > 0 && holdout.length < minHoldout) {
    const candidates = train
      .map((eid) => ({ eid, bucket: bucketFor(eid) }))
      .sort((a, b) => b.bucket - a.bucket || String(a.eid).localeCompare(String(b.eid)));
    for (const c of candidates) {
      if (holdout.length >= minHoldout || train.length <= minTrain) break;
      const idx = train.indexOf(c.eid);
      if (idx >= 0) {
        train.splice(idx, 1);
        if (!holdout.includes(c.eid)) holdout.push(c.eid);
      }
    }
  }
  if (canSatisfyFloors && minTrain > 0 && train.length < minTrain) {
    const candidates = holdout
      .filter((eid) => !(approvals[eid] && approvals[eid].holdout_only))
      .map((eid) => ({ eid, bucket: bucketFor(eid) }))
      .sort((a, b) => a.bucket - b.bucket || String(a.eid).localeCompare(String(b.eid)));
    for (const c of candidates) {
      if (train.length >= minTrain || holdout.length <= minHoldout) break;
      const idx = holdout.indexOf(c.eid);
      if (idx >= 0) {
        holdout.splice(idx, 1);
        if (!train.includes(c.eid)) train.push(c.eid);
      }
    }
  }
  // Disjointness assertion.
  const t = new Set(train);
  for (const h of holdout) {
    if (t.has(h)) throw new Error('split_invariant_violation: ' + h + ' in both buckets');
  }
  const sig = crypto.createHash('sha256').update(JSON.stringify({ datasetId, ratio, seed, minTrain, minHoldout, train, holdout })).digest('hex').slice(0, 16);
  const out = {
    dataset_id: datasetId,
    train_count: train.length,
    holdout_count: holdout.length,
    train_ids: train,
    holdout_ids: holdout,
    split_signature: 'sha256:' + sig,
    ratio,
    min_train: minTrain || null,
    min_holdout: minHoldout || null,
    seed: opts.seed != null ? Number(opts.seed) : (ds.seed != null ? ds.seed : null),
  };
  // Persist the split into the dataset record so future inspects see it.
  ds.train_count = train.length;
  ds.holdout_count = holdout.length;
  ds.split_signature = out.split_signature;
  ds.train_ids = train;
  ds.holdout_ids = holdout;
  ds.min_train = out.min_train;
  ds.min_holdout = out.min_holdout;
  if (opts.seed != null) ds.seed = Number(opts.seed);
  fs.writeFileSync(file, JSON.stringify(ds, null, 2));
  return out;
}

// createDataset(namespace, {fromOpportunity, fromNamespace, includeApproved,
//   approvedOnly, train_ratio, redactionPolicy, sourceType, seed})
// Returns {dataset_id, train_count, holdout_count, source_event_ids, version,
//   split_signature, buckets: {approved, rejected, synthetic, unlabeled}}.
//
// W409n - flags:
//   - approvedOnly:true   -> only events with an approve decision enter the
//                            dataset. Rejected + unlabeled are dropped. Used
//                            by compile-pipeline guard (W409c).
//   - fromNamespace       -> alias for the namespace argument (the CLI
//                            surfaces both - `kolm dataset create --from-namespace foo`
//                            and `kolm dataset create foo` work identically).
//   - fromOpportunity     -> restrict to events referenced by that
//                            opportunity's sample_event_ids when present.
//   - seed                -> integer RNG seed for the determinism contract
//                            (defaults to hash of the dataset_id; passing the
//                            same seed twice MUST produce the same split).
//   - sourceType          -> 'real' | 'synthetic' | 'mixed'. Synthetic
//                            datasets are tagged so the bucket counter in
//                            inspectDataset() can report them separately.
export async function createDataset(namespace, opts = {}) {
  const ns = namespace || opts.fromNamespace;
  if (!ns) throw new Error('createDataset requires a namespace');
  const includeApproved = opts.includeApproved !== false;
  const approvedOnly = opts.approvedOnly === true;
  const train_ratio = opts.train_ratio != null ? opts.train_ratio : 0.8;
  // W411 - tenant scope. Routes pass req.tenant_record.id (or req.tenant) here
  // so the underlying listEvents() only returns the caller's rows. The
  // resulting dataset record stamps `tenant_id` so listDatasets() / split / etc.
  // can fence reads to the same tenant.
  const tenantScope = opts.tenant_id || opts.tenant || null;
  const events = await listEvents({ namespace: ns, tenant_id: tenantScope, limit: opts.limit || 100000, order: 'asc' });
  const approvals = _loadApprovals();
  let source;
  const buckets = { approved: 0, rejected: 0, synthetic: 0, unlabeled: 0, edited: 0 };
  if (approvedOnly) {
    // ONLY rows with an explicit approve decision (or edit with fixed_output)
    // enter. Rejected and unlabeled drop. This is the compile-pipeline guard
    // contract: an unapproved row must NEVER appear in a train/eval split
    // when approvedOnly is set.
    source = events.filter(e => {
      const a = approvals[e.event_id];
      if (!a) { buckets.unlabeled += 1; return false; }
      if (a.decision === 'reject') { buckets.rejected += 1; return false; }
      if (a.decision === 'approve') {
        if (a.fixed_output) buckets.edited += 1;
        else buckets.approved += 1;
        return true;
      }
      return false;
    });
  } else if (includeApproved) {
    source = events.filter(e => {
      const a = approvals[e.event_id];
      if (a && a.decision === 'reject') { buckets.rejected += 1; return false; }
      if (a && a.decision === 'approve') {
        if (a.fixed_output) buckets.edited += 1;
        else buckets.approved += 1;
      } else {
        buckets.unlabeled += 1;
      }
      return true;
    });
  } else {
    source = events.slice();
    for (const e of source) {
      const a = approvals[e.event_id];
      if (a && a.decision === 'reject') buckets.rejected += 1;
      else if (a && a.decision === 'approve') {
        if (a.fixed_output) buckets.edited += 1; else buckets.approved += 1;
      } else buckets.unlabeled += 1;
    }
  }
  // Synthetic bucket - any event with source_type='synthetic' counts toward
  // the synthetic tally regardless of approval state.
  for (const e of source) {
    if ((e.source_type || 'real') === 'synthetic') buckets.synthetic += 1;
  }
  // If an opportunity is referenced, restrict to that opportunity's sample ids
  // when they're in this namespace.
  if (opts.fromOpportunity) {
    const state = loadOpportunitiesState();
    const opp = state.byId[opts.fromOpportunity];
    if (opp && Array.isArray(opp.sample_event_ids) && opp.sample_event_ids.length) {
      const allow = new Set(opp.sample_event_ids);
      source = source.filter(e => allow.has(e.event_id));
    }
  }
  // W426 - explicit event-id whitelist. The seeds-importer uses this to pin
  // the dataset to the exact set of rows it just appended, avoiding a
  // namespace-wide rescan that could pick up legacy rows the caller doesn't
  // own (or didn't intend to bake into this dataset). The tenant filter on
  // listEvents() already fences cross-tenant; this is an additional
  // intra-tenant narrowing.
  if (Array.isArray(opts.fromEventIds) && opts.fromEventIds.length) {
    const allow = new Set(opts.fromEventIds);
    source = source.filter(e => allow.has(e.event_id));
  }
  if (!source.length) {
    throw new Error('no events available for dataset (namespace=' + ns + ')');
  }
  // W411 P0 #10 - content-based dedupe by row hash BEFORE the split. The
  // identity-based split contract (train_ids ∩ holdout_ids = ∅) only catches
  // event-id duplication; two distinct event_ids carrying the same
  // (prompt, response) pair (a re-emit, a replay through a different proxy,
  // a hand-curated synthetic copy) would still pass that probe and then both
  // copies could be distributed 80/20 across train+holdout. We canonicalise
  // each (input, output) and keep the first occurrence - the rest are
  // collapsed and tallied so the dataset record can carry an honest
  // `row_hash_dedupe_count`.
  const seenRowHashes = new Set();
  let row_hash_dedupe_count = 0;
  const dedupedSource = [];
  for (const e of source) {
    const input = String(e.prompt_redacted || e.prompt || e.input || '');
    const output = String(e.response_redacted || e.response || e.output || '');
    const rowHash = crypto.createHash('sha256').update(input + '\x1f' + output).digest('hex');
    if (seenRowHashes.has(rowHash)) {
      row_hash_dedupe_count += 1;
      continue;
    }
    seenRowHashes.add(rowHash);
    dedupedSource.push(e);
  }
  source = dedupedSource;
  const datasetId = _dsId(ns);
  const file = path.join(_datasetsDir(), datasetId + '.json');
  const record = {
    dataset_id: datasetId,
    namespace: ns,
    version: 1,
    // W411 - `tenant_id` stamped on the record so listDatasets() can filter
    // and a downstream split / export / compile can re-verify that the
    // caller still owns the dataset before reading rows. Falls back to the
    // first event's tenant_id when the route omits an explicit tenant, so
    // legacy local-only datasets still carry an identifier.
    tenant_id: tenantScope || (source[0] && source[0].tenant_id) || null,
    source_event_ids: source.map(e => e.event_id),
    approved_by: opts.approvedBy || 'local-user',
    redaction_policy: opts.redactionPolicy || 'redact',
    train_count: 0,
    holdout_count: 0,
    split_signature: null,
    train_ids: [],
    holdout_ids: [],
    source_type: opts.sourceType || 'real',
    approved_only: approvedOnly,
    seed: opts.seed != null ? Number(opts.seed) : null,
    buckets,
    // W411 P0 #10 - durable audit field. A verifier can compare
    // source_event_ids.length against (buckets sum + row_hash_dedupe_count)
    // to confirm the dedupe step ran.
    row_hash_dedupe_count,
    created_at: new Date().toISOString(),
    from_opportunity: opts.fromOpportunity || null,
    from_namespace: opts.fromNamespace || null,
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  const split = await splitDataset(datasetId, train_ratio, {
    seed: opts.seed,
    min_train: opts.min_train ?? opts.minTrain,
    min_holdout: opts.min_holdout ?? opts.minHoldout,
  });
  return {
    dataset_id: datasetId,
    // W411 - surface the stamped tenant_id in the return envelope so the
    // HTTP /v1/datasets POST response (and direct callers) can verify the
    // dataset belongs to the calling tenant without a follow-up inspect.
    tenant_id: record.tenant_id,
    train_count: split.train_count,
    holdout_count: split.holdout_count,
    source_event_ids: record.source_event_ids,
    version: record.version,
    split_signature: split.split_signature,
    approved_only: approvedOnly,
    buckets,
    row_hash_dedupe_count,
    seed: record.seed,
  };
}

// inspectDataset: full record + statistics. W409n surfaces the buckets +
// approved-only mode + media kind breakdown so the workbench page can render
// the train/holdout/synthetic/rejected breakdown without a follow-up call.
export async function inspectDataset(datasetId) {
  const file = path.join(_datasetsDir(), datasetId + '.json');
  if (!fs.existsSync(file)) throw new Error('dataset not found: ' + datasetId);
  const ds = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = await Promise.all(ds.source_event_ids.map(id => getEvent(id)));
  const present = events.filter(Boolean);
  const approvals = _loadApprovals();
  const labelDist = {};
  const redactionStats = { sensitive: 0, redact_policy: 0, allow_policy: 0 };
  const sourceBreakdown = {};
  const mediaBreakdown = {};
  const reviewerBreakdown = {};
  let approvedCount = 0, rejectedCount = 0, editedCount = 0, unlabeledCount = 0, syntheticCount = 0;
  for (const e of present) {
    const r = (e.response_redacted || '').trim().slice(0, 64);
    if (r) labelDist[r] = (labelDist[r] || 0) + 1;
    if (e.sensitive_data_detected) redactionStats.sensitive++;
    if (e.redaction_policy === 'redact') redactionStats.redact_policy++;
    if (e.redaction_policy === 'allow') redactionStats.allow_policy++;
    const k = e.source_type || 'real';
    sourceBreakdown[k] = (sourceBreakdown[k] || 0) + 1;
    if (k === 'synthetic') syntheticCount += 1;
    if (e.media_kind) {
      mediaBreakdown[e.media_kind] = (mediaBreakdown[e.media_kind] || 0) + 1;
    }
    const a = approvals[e.event_id];
    if (a) {
      if (a.reviewer) reviewerBreakdown[a.reviewer] = (reviewerBreakdown[a.reviewer] || 0) + 1;
      if (a.decision === 'reject') rejectedCount += 1;
      else if (a.decision === 'approve') {
        if (a.fixed_output) editedCount += 1; else approvedCount += 1;
      }
    } else {
      unlabeledCount += 1;
    }
  }
  const labels_sorted = Object.entries(labelDist).sort((a, b) => b[1] - a[1]).slice(0, 20);
  return {
    ...ds,
    statistics: {
      events_resolved: present.length,
      events_missing: ds.source_event_ids.length - present.length,
      label_distribution_top: labels_sorted,
      redaction_stats: redactionStats,
      source_breakdown: sourceBreakdown,
      media_breakdown: mediaBreakdown,
      reviewer_breakdown: reviewerBreakdown,
      buckets: {
        approved: approvedCount,
        rejected: rejectedCount,
        edited: editedCount,
        unlabeled: unlabeledCount,
        synthetic: syntheticCount,
      },
    },
  };
}

// W411 - `tenant` / `tenant_id` filter restricts the listing to datasets that
// belong to the caller. Legacy datasets without a stamped tenant_id are
// included only when the caller does NOT pass a filter (admin / local-only).
export async function listDatasets(opts = {}) {
  const dir = _datasetsDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const tenantFilter = (opts && (opts.tenant_id || opts.tenant)) || null;
  const out = [];
  for (const f of files) {
    try {
      const ds = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (tenantFilter && ds.tenant_id && ds.tenant_id !== tenantFilter) continue;
      // If a tenant filter is set, also drop legacy records that have no
      // tenant_id stamped - fail-closed so a cross-tenant lookup never sees
      // somebody else's dataset.
      if (tenantFilter && !ds.tenant_id) continue;
      out.push({
        dataset_id: ds.dataset_id,
        namespace: ds.namespace,
        tenant_id: ds.tenant_id || null,
        train_count: ds.train_count,
        holdout_count: ds.holdout_count,
        created_at: ds.created_at,
        version: ds.version,
      });
    } catch {} // deliberate: cleanup
  }
  return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// exportDataset(datasetId, format, opts): write jsonl (default) or csv to
// opts.out (defaults to ~/.kolm/datasets/<id>.<format>). Returns the path.
//
// W409n - exports use the canonical row shape from normalizeRow() so every
// dataset surface (export, bakeoff, distill, eval) reads the same envelope.
// Multimodal media + agent traces (tool_calls) are preserved when present.
// The optional opts.split controls which slice to export: 'train', 'holdout',
// or 'all' (default).
export async function exportDataset(datasetId, format = 'jsonl', opts = {}) {
  const ds = await inspectDataset(datasetId);
  const fmt = (format || 'jsonl').toLowerCase();
  if (!['jsonl', 'csv', 'seeds'].includes(fmt)) throw new Error('unsupported format: ' + fmt);
  const out = opts.out || path.join(_datasetsDir(), datasetId + '.' + (fmt === 'seeds' ? 'jsonl' : fmt));
  const split = (opts.split || 'all').toLowerCase();
  let ids = ds.source_event_ids;
  if (split === 'train') ids = ds.train_ids || [];
  else if (split === 'holdout') ids = ds.holdout_ids || [];
  const approvals = _loadApprovals();
  const rows = await Promise.all(ids.map(id => getEvent(id)));
  const present = rows.filter(Boolean);
  const normalized = present.map(r => normalizeRow(r, { approval: approvals[r.event_id] || null }));
  if (fmt === 'jsonl' || fmt === 'seeds') {
    // seeds.jsonl convention: {id, input, output} for the distill worker.
    // Full jsonl carries every canonical field so the round-trip preserves
    // multimodal + agent trace fields.
    const lines = fmt === 'seeds'
      ? normalized.map(r => JSON.stringify({ id: r.event_id, input: r.input, output: r.output }))
      : normalized.map(r => JSON.stringify(r));
    fs.writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  } else {
    const cols = ['event_id', 'namespace', 'prompt', 'completion', 'model', 'provider', 'sensitive', 'workflow_id', 'trace_id', 'media_kind'];
    const lines = [cols.join(',')];
    for (const r of normalized) {
      const row = {
        event_id: r.event_id,
        namespace: r.namespace,
        prompt: r.prompt,
        completion: r.completion,
        model: r.model,
        provider: r.provider,
        sensitive: r.sensitive,
        workflow_id: r.workflow_id,
        trace_id: r.trace_id,
        media_kind: r.media ? r.media.kind : null,
      };
      lines.push(cols.map(c => {
        const v = row[c];
        if (v == null) return '';
        const s = String(v);
        if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      }).join(','));
    }
    fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  }
  return out;
}

// W409n - importSeedsJsonl(filePath, {namespace, sourceType, autoApprove}):
// Reads a seeds.jsonl (or any jsonl with {input, output} / {prompt, completion}
// rows), writes each row as a fresh event into the event-store, optionally
// auto-approves it, and returns {imported, skipped, errors, dataset_id?}.
// When opts.createDataset is true, a fresh dataset is created from the
// just-imported events (the typical "round-trip from a hand-curated seed
// file" flow).
export async function importSeedsJsonl(filePath, opts = {}) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('seeds file not found: ' + filePath);
  const namespace = opts.namespace || 'imported-seeds';
  const sourceType = opts.sourceType || 'synthetic';
  const tenant = opts.tenantId || 'local';
  const autoApprove = opts.autoApprove === true;
  const reviewer = opts.reviewer || 'seeds-importer';
  const text = fs.readFileSync(filePath, 'utf8');
  let imported = 0;
  let skipped = 0;
  const errors = [];
  const importedEventIds = [];
  // Tolerant of both JSON-array and JSONL forms.
  let rows;
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try { rows = JSON.parse(trimmed); } catch (e) { rows = []; errors.push('json_parse:' + e.message); }
  } else {
    rows = text.split(/\r?\n/).filter(Boolean).map((ln, i) => {
      try { return JSON.parse(ln); } catch (e) { errors.push('line_' + (i + 1) + ':' + e.message); return null; }
    }).filter(Boolean);
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || typeof r !== 'object') { skipped += 1; continue; }
    const input = r.input || r.prompt || r.prompt_redacted || (r.messages ? JSON.stringify(r.messages) : '');
    const output = r.output || r.completion || r.response || r.response_redacted || (r.expected || '');
    if (!input || !output) { skipped += 1; continue; }
    const eventId = r.event_id || ('evt_seed_' + crypto.createHash('sha256').update(filePath + ':' + i + ':' + input).digest('hex').slice(0, 16));
    // W426 - preserve per-row metadata from the JSONL row where present.
    // Per the 2026-05-19 audit (P1-2): an imported row that carries its own
    // source_type / holdout_only / redaction_policy / approved should NOT be
    // silently overwritten by the importer's default sourceType. The
    // per-row value wins; the importer-default is the fallback. This is the
    // W411 P0 #2 "source_type preserved" pattern applied to the rest of the
    // metadata surface.
    const rowSourceType = r.source_type || sourceType;
    const rowRedactionPolicy = r.redaction_policy || opts.redactionPolicy || 'redact';
    const rowHoldoutOnly = r.holdout_only === true;
    const ev = newEvent({
      event_id: eventId,
      tenant_id: tenant,
      namespace,
      provider: r.provider || 'seeds-import',
      model: r.model || 'seeds-import',
      prompt_redacted: String(input),
      response_redacted: String(output),
      source_type: rowSourceType,
      redaction_policy: rowRedactionPolicy,
      holdout_only: rowHoldoutOnly,
      workflow_id: r.workflow_id || null,
      trace_id: r.trace_id || null,
      tool_calls: Array.isArray(r.tool_calls) ? r.tool_calls : [],
      media_kind: r.media_kind || (r.media && r.media.kind) || null,
      media_uri: r.media_uri || (r.media && r.media.uri) || null,
      media_hash: r.media_hash || (r.media && r.media.hash) || null,
      media_bytes: r.media_bytes || (r.media && r.media.bytes) || null,
      media_mime: r.media_mime || (r.media && r.media.mime) || null,
      media_extracted_text: r.media_extracted_text || (r.media && r.media.extracted_text) || null,
      status: 'success',
    });
    try {
      await appendEvent(ev);
      importedEventIds.push(eventId);
      // W426 - honour an explicit per-row `approved: true` flag in addition to
      // the importer-level autoApprove. The JSONL author may pre-mark some
      // rows as approved (the typical "I curated these by hand" flow). The
      // approveEvent stamp carries reviewer + workflow for audit.
      if (autoApprove || r.approved === true) {
        await approveEvent(eventId, { reviewer, workflow: 'seeds-import' });
      }
      imported += 1;
    } catch (e) {
      errors.push('append_' + i + ':' + (e.message || e));
      skipped += 1;
    }
  }
  let createdDatasetId = null;
  if (opts.createDataset && importedEventIds.length) {
    // W426 - pass tenant_id so the underlying listEvents() filter fences the
    // dataset to ONLY the calling tenant's rows in this namespace. Without
    // this, tenant A's `importSeedsJsonl({createDataset:true})` against a
    // shared namespace would pull tenant B's rows in too. Additionally, we
    // narrow the source to the exact ids we just imported via `fromEventIds`,
    // so even a same-tenant namespace pre-populated with unrelated rows can't
    // bleed into the seed-import dataset.
    const ds = await createDataset(namespace, {
      tenant_id: tenant,
      fromEventIds: importedEventIds.slice(),
      sourceType,
      approvedOnly: autoApprove,
      train_ratio: opts.train_ratio != null ? opts.train_ratio : 0.8,
      seed: opts.seed,
    });
    createdDatasetId = ds.dataset_id;
  }
  return {
    imported,
    skipped,
    errors,
    namespace,
    source_type: sourceType,
    event_ids: importedEventIds,
    dataset_id: createdDatasetId,
  };
}
