// Team learning event log.
//
// A kolm tenant can split its membership into one or more *teams* (e.g.,
// claims-ops vs. provider-relations vs. compliance) and collect a shared,
// append-only learning event stream per team. Subsequent compiles fold the
// team's events into the next artifact's seeds + comparator policy so the
// student keeps closing the gap on whatever real inputs the team is seeing.
//
// What this module gives you:
//
//   - append(team, event)          add an event to the team's log
//   - read(team, opts)             read the team's log (filter by kind, since)
//   - chain(team)                  recompute the rolling hash chain
//   - exportSeeds(team, opts)      flatten event log into seeds.jsonl rows
//                                    (positives + corrections only)
//   - redactForExport(events, fn)  drop / mask any payload field a redactor
//                                    classifies as PHI/PII before crossing
//                                    a tenant boundary
//
// What this module does NOT do:
//
//   - It does not sync between tenants or across the network. That belongs
//     to src/federated-learning.js (this wave).
//   - It does not run the redactor. It just calls whatever redactor function
//     you pass in. That keeps redaction policy a separate concern.
//   - It does not write to a hosted log or a SaaS. Storage is local files
//     under KOLM_HOME/teams/<team>/events.jsonl. Tenants can stand up their
//     own object-store backed implementation by replacing the storage
//     adapter.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TEAM_EVENTS_VERSION = 'team-events-v2';

// Kinds an event can be. Adding a kind here is a contract change — bump
// TEAM_EVENTS_VERSION and migrate.
export const EVENT_KINDS = Object.freeze({
  POSITIVE:           'positive',            // a captured input/output pair
                                              // the operator confirmed is right
  CORRECTION:         'correction',          // an artifact output that needs
                                              // replacement with a fixed value
  REGRESSION_FLAG:    'regression_flag',     // a holdout row that started
                                              // failing after an upgrade
  DRIFT_OBSERVATION:  'drift_observation',   // distributional shift signal
                                              // (e.g., new payer, new code set)
  CAPABILITY_REQUEST: 'capability_request',  // ask for a feature the artifact
                                              // can't currently express
  CONFIG_CHANGE:      'config_change',       // change to comparator / gate
  REVIEW_DECISION:    'review_decision',     // (W293) a reviewer's decision
                                              // on another event's review state
});

// Review states a (non-review_decision) event can be in. Set on append to
// 'pending'; mutated by appending a review_decision event referencing the
// target event's hash. Last-write-wins.
export const REVIEW_STATES = Object.freeze(['pending', 'approved', 'rejected', 'needs_revision']);

// Per-kind payload schemas (W293). `required` lists payload fields that
// must be present + non-empty strings (unless typed otherwise via _types).
// We reject anything else so that downstream readers can rely on the
// contract without per-event guards.
export const EVENT_SCHEMAS = Object.freeze({
  positive:            Object.freeze({ required: ['input', 'output'] }),
  correction:          Object.freeze({ required: ['input', 'bad_output', 'good_output'] }),
  regression_flag:     Object.freeze({ required: ['holdout_row_id'] }),
  drift_observation:   Object.freeze({ required: ['signal'] }),
  capability_request:  Object.freeze({ required: ['description'] }),
  config_change:       Object.freeze({ required: ['change'] }),
  review_decision:     Object.freeze({ required: ['event_hash', 'state', 'reviewer'] }),
});

const REQUIRED = ['kind', 'actor', 'artifact_version', 'payload'];

function _now() { return new Date().toISOString(); }
function _shortHash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function _validateEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('event must be an object');
  for (const f of REQUIRED) {
    if (event[f] === undefined) throw new Error(`event missing field: ${f}`);
  }
  if (!Object.values(EVENT_KINDS).includes(event.kind)) {
    throw new Error(`unknown event kind: ${event.kind}`);
  }
  if (typeof event.actor !== 'string' || !event.actor) throw new Error('event.actor must be non-empty string');
  if (typeof event.artifact_version !== 'string' || !event.artifact_version) {
    throw new Error('event.artifact_version must be non-empty string');
  }
  if (!event.payload || typeof event.payload !== 'object') {
    throw new Error('event.payload must be an object');
  }
  // Strict per-kind payload schema (W293).
  const schema = EVENT_SCHEMAS[event.kind];
  if (schema && Array.isArray(schema.required)) {
    for (const f of schema.required) {
      const v = event.payload[f];
      if (v === undefined || v === null || v === '') {
        throw new Error(`event.payload missing required field for kind=${event.kind}: ${f}`);
      }
    }
  }
  // review_decision payload.state must be in REVIEW_STATES.
  if (event.kind === EVENT_KINDS.REVIEW_DECISION) {
    if (!REVIEW_STATES.includes(event.payload.state)) {
      throw new Error(`unknown review state: ${event.payload.state} (must be one of ${REVIEW_STATES.join(', ')})`);
    }
  }
}

function _validateTeam(team) {
  if (typeof team !== 'string') throw new Error('team id must be a string');
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(team)) {
    throw new Error('team id must match [a-zA-Z0-9_.-]{1,64}');
  }
}

function _teamDir(team) {
  const home = process.env.KOLM_HOME
    || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kolm');
  return path.join(home, 'teams', team);
}

function _teamFile(team) {
  return path.join(_teamDir(team), 'events.jsonl');
}

// Append-only writer. The rolling hash chain links event N to event N-1
// via prev_hash; the verifier can detect any rewrite/truncation by walking
// the chain.
export async function append(team, event) {
  _validateTeam(team);
  _validateEvent(event);
  const dir = _teamDir(team);
  await fs.mkdir(dir, { recursive: true });
  const file = _teamFile(team);

  // Read last line (if any) to get prev_hash. Append is O(1) but reading the
  // tail to compute the chain link is O(file size); for high-throughput
  // tenants the storage adapter should be swapped for an indexed backend.
  let prevHash = 'genesis';
  let seq = 0;
  try {
    const buf = await fs.readFile(file, 'utf8');
    const lines = buf.split('\n').filter(l => l.trim().length > 0);
    if (lines.length > 0) {
      const last = JSON.parse(lines[lines.length - 1]);
      prevHash = last.hash;
      seq = (last.seq || 0) + 1;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const ts = event.timestamp || _now();
  const enriched = {
    spec: TEAM_EVENTS_VERSION,
    team,
    seq,
    timestamp: ts,
    kind: event.kind,
    actor: event.actor,
    artifact_version: event.artifact_version,
    payload: event.payload,
    prev_hash: prevHash,
  };
  // Every non-review_decision event lands in the 'pending' review state
  // (W293). review_decision events do not themselves have a review state
  // — they describe one for the event they reference.
  if (event.kind !== EVENT_KINDS.REVIEW_DECISION) {
    enriched.review = { state: 'pending', created_at: ts };
  }
  // The chain hash binds the entire enriched event (minus its own hash field).
  enriched.hash = _shortHash(JSON.stringify(enriched));

  await fs.appendFile(file, JSON.stringify(enriched) + '\n', 'utf8');
  return enriched;
}

// Append a review_decision event for `event_hash`. The decision is the
// authoritative state for that event from this point forward (last-write-
// wins). Reviewers can override prior reviewers; the chain is the audit
// trail. (W293)
export async function setReview(team, opts = {}) {
  const { event_hash, state, reviewer, note, artifact_version, actor } = opts;
  if (!event_hash) throw new Error('setReview: event_hash required');
  if (!REVIEW_STATES.includes(state)) {
    throw new Error(`unknown review state: ${state} (must be one of ${REVIEW_STATES.join(', ')})`);
  }
  if (!reviewer || typeof reviewer !== 'string') throw new Error('setReview: reviewer required');
  // Resolve artifact_version from the target event if not supplied.
  let av = artifact_version;
  if (!av) {
    const events = await read(team);
    const target = events.find(e => e.hash === event_hash);
    av = target ? target.artifact_version : 'unknown';
  }
  const payload = { event_hash, state, reviewer };
  if (note) payload.note = note;
  return await append(team, {
    kind: EVENT_KINDS.REVIEW_DECISION,
    actor: actor || reviewer,
    artifact_version: av,
    payload,
  });
}

// Walk the chain forward and return the latest review_decision for
// event_hash. Returns {state, reviewer, note?, decision_hash?, timestamp?}.
// Defaults to the event's own .review (typically `pending`) if no
// decisions have landed yet. (W293)
export async function getReview(team, event_hash) {
  const events = await read(team);
  const target = events.find(e => e.hash === event_hash);
  if (!target) return null;
  let latest = target.review || { state: 'pending', created_at: target.timestamp };
  let latestDecisionHash = null;
  for (const e of events) {
    if (e.kind !== EVENT_KINDS.REVIEW_DECISION) continue;
    if (!e.payload || e.payload.event_hash !== event_hash) continue;
    latest = {
      state: e.payload.state,
      reviewer: e.payload.reviewer,
      note: e.payload.note,
      created_at: e.timestamp,
    };
    latestDecisionHash = e.hash;
  }
  if (latestDecisionHash) latest.decision_hash = latestDecisionHash;
  return latest;
}

// Read events from the team's log. Filters: kind, since (ISO timestamp),
// artifact_version. Returns an array in append order.
export async function read(team, opts = {}) {
  _validateTeam(team);
  const file = _teamFile(team);
  let buf;
  try { buf = await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  let events = buf.split('\n').filter(l => l.trim()).map(JSON.parse);
  if (opts.kind) events = events.filter(e => e.kind === opts.kind);
  if (opts.kinds) events = events.filter(e => opts.kinds.includes(e.kind));
  if (opts.since) events = events.filter(e => e.timestamp >= opts.since);
  if (opts.artifact_version) events = events.filter(e => e.artifact_version === opts.artifact_version);
  if (opts.actor) events = events.filter(e => e.actor === opts.actor);
  return events;
}

// Walk the chain and report the first link that breaks. Used by the verifier
// when a team's event log is bundled into an artifact's receipt.
export async function chain(team) {
  const events = await read(team);
  let prev = 'genesis';
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.prev_hash !== prev) {
      return { ok: false, broke_at: i, reason: 'prev_hash_mismatch', expected: prev, got: e.prev_hash };
    }
    const recomputed = _shortHash(JSON.stringify({
      spec: e.spec, team: e.team, seq: e.seq, timestamp: e.timestamp,
      kind: e.kind, actor: e.actor, artifact_version: e.artifact_version,
      payload: e.payload, prev_hash: e.prev_hash,
    }));
    if (recomputed !== e.hash) {
      return { ok: false, broke_at: i, reason: 'hash_mismatch', expected: recomputed, got: e.hash };
    }
    prev = e.hash;
  }
  return { ok: true, length: events.length, head: prev === 'genesis' ? null : prev };
}

// Export learning events as seeds.jsonl rows. Only POSITIVE and CORRECTION
// kinds contribute, and only when the payload carries the canonical
// fields per the W293 strict schema (positive: {input, output};
// correction: {input, bad_output, good_output}).
//
// Review gate (W294):
//   - by default ONLY events whose latest review_decision is 'approved'
//     export as seeds. Pending/rejected/needs_revision events are dropped.
//   - opts.include_pending=true keeps pending (for audit/debug dumps);
//     it still drops rejected + needs_revision.
//   - every emitted seed carries source_event_hash + review_decision_hash
//     so the verifier can prove the approval link from the seed back to
//     the chained event log.
//
// The artifact compile path uses this to fold a team's accumulated
// reviewed learning into the next training set without the team having to
// manage a separate seeds.jsonl by hand.
export async function exportSeeds(team, opts = {}) {
  const includePending = opts.include_pending === true;
  // Pull the full log once so we can also resolve review decisions per
  // event in a single pass (the chain is small per team).
  const all = await read(team);
  // Pre-compute latest review state per event_hash from the full chain.
  const latestReview = new Map();
  for (const e of all) {
    if (e.kind === EVENT_KINDS.REVIEW_DECISION && e.payload && e.payload.event_hash) {
      latestReview.set(e.payload.event_hash, {
        state: e.payload.state,
        decision_hash: e.hash,
        reviewer: e.payload.reviewer,
      });
    }
  }
  let events = all.filter(e => e.kind === EVENT_KINDS.POSITIVE || e.kind === EVENT_KINDS.CORRECTION);
  if (opts.since) events = events.filter(e => e.timestamp >= opts.since);
  if (opts.artifact_version) events = events.filter(e => e.artifact_version === opts.artifact_version);
  if (opts.actor) events = events.filter(e => e.actor === opts.actor);
  const rows = [];
  for (const e of events) {
    const review = latestReview.get(e.hash) || (e.review || { state: 'pending' });
    if (review.state === 'rejected' || review.state === 'needs_revision') continue;
    if (review.state === 'pending' && !includePending) continue;
    if (review.state !== 'approved' && review.state !== 'pending') continue;
    const p = e.payload || {};
    let input, output;
    if (e.kind === EVENT_KINDS.CORRECTION) {
      if (typeof p.input === 'string' && typeof p.good_output === 'string') {
        input = p.input; output = p.good_output;
      }
    } else {
      if (typeof p.input === 'string' && typeof p.output === 'string') {
        input = p.input; output = p.output;
      } else if (typeof p.prompt === 'string' && typeof p.completion === 'string') {
        input = p.prompt; output = p.completion;
      }
    }
    if (typeof input !== 'string' || typeof output !== 'string') continue;
    const tags = Array.isArray(p.tags) ? p.tags.slice() : [];
    tags.push(`team:${team}`);
    tags.push(`event:${e.kind}`);
    tags.push(`review:${review.state}`);
    const row = {
      input,
      output,
      tags,
      source_seq: e.seq,
      source_event_hash: e.hash,
      review_state: review.state,
    };
    if (review.decision_hash) row.review_decision_hash = review.decision_hash;
    rows.push(row);
  }
  return rows;
}

// Redaction pass — caller supplies the redactor (so privacy policy stays
// pluggable). The redactor function gets (event.payload) and returns a new
// payload + a redaction_map. The result event is identical except for the
// payload and a `redaction.kept` array listing kept-token classes.
export function redactForExport(events, redactor) {
  if (typeof redactor !== 'function') throw new Error('redactor must be a function');
  return events.map(e => {
    const { redacted, map } = redactor(e.payload || {});
    return {
      ...e,
      payload: redacted,
      redaction: {
        applied: true,
        token_classes: Array.from(new Set(Object.values(map || {}).map(v => v.class || 'other'))),
        map_size: Object.keys(map || {}).length,
      },
    };
  });
}

// Stats helper — gives the compile pipeline a quick view of what's in the
// team log so it can decide whether to retrain.
export async function stats(team) {
  const events = await read(team);
  const byKind = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return {
    team,
    total: events.length,
    by_kind: byKind,
    head_hash: events.length > 0 ? events[events.length - 1].hash : null,
    last_timestamp: events.length > 0 ? events[events.length - 1].timestamp : null,
  };
}

// Used by tests + a future REPL command. NEVER call this from a code path
// that touches a real tenant's log. The CLI surface should refuse this in
// non-dev contexts.
export async function _resetForTest(team) {
  if (process.env.NODE_ENV !== 'test' && process.env.KOLM_ALLOW_DESTRUCTIVE !== '1') {
    throw new Error('_resetForTest blocked outside NODE_ENV=test');
  }
  _validateTeam(team);
  const file = _teamFile(team);
  try { await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// ─── W409t — team-learning approval (private-by-default) ───────────────────
//
// PROBLEM W409t closes:
//   The original team-events log treats every captured event as a "team
//   event" — append() lands the row in the team's shared chain and
//   exportSeeds() feeds it into the next training set as soon as a reviewer
//   marks it `approved`. The audit called this out: "local reviewed-event
//   export, not 'everyone trains the shared team database' by default".
//
// CONTRACT W409t enforces:
//   1. Local individual events stay private by default. The team-events
//      append() chain is the LOCAL log per the team-id slug. Cross-tenant /
//      team-database promotion now requires an EXPLICIT approval gesture:
//      either per-event (`approveForTeam(team, event_hash, contributor)`)
//      or by namespace policy (`setNamespacePolicy(team, ns, 'auto')`).
//   2. Every team-promoted event carries:
//        - reviewer state (`review.state`)
//        - lineage_hash (sha256 of the source local event hash)
//        - team_id
//        - contributor_anonymized_hash (sha256 of the contributor's user_id;
//          raw user_id NEVER lands in the team bundle)
//   3. Team datasets only use events whose team-approval is `approved`
//      AND whose reviewer state is `approved`.
//   4. Team artifacts record `contributor_hashes` (the de-duplicated set of
//      contributor_anonymized_hash values that fed the artifact). The raw
//      user_id is absent from the manifest by construction.
//
// New CLI verbs (wired in cli/kolm.js):
//   kolm team export [--approved-only]   — write a team bundle to stdout / file
//   kolm team import <bundle>            — merge an inbound bundle
//   kolm team approve <event_hash>       — flip team_approval to 'approved'
//   kolm team queue                      — list events pending team approval

export const TEAM_APPROVAL_STATES = Object.freeze(['pending', 'approved', 'rejected']);
export const NAMESPACE_POLICIES = Object.freeze(['manual', 'auto', 'never']);

// Anonymize a contributor's user_id (or email) into a stable hash. The team
// log + downstream artifacts only ever see this hash. Returns a 32-hex prefix
// for compactness — sha256 over the salted user_id.
export function contributorHash(userId, { salt } = {}) {
  if (userId == null) return null;
  const s = String(userId);
  const h = crypto.createHash('sha256');
  if (salt) h.update(String(salt));
  h.update(s);
  return h.digest('hex').slice(0, 32);
}

function _teamApprovalFile(team) { return path.join(_teamDir(team), 'team_approvals.jsonl'); }
function _teamPolicyFile(team)   { return path.join(_teamDir(team), 'namespace_policies.json'); }

async function _readApprovalLog(team) {
  const file = _teamApprovalFile(team);
  try {
    const buf = await fs.readFile(file, 'utf8');
    return buf.split('\n').filter(l => l.trim()).map(JSON.parse);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function _appendApprovalRecord(team, rec) {
  const dir = _teamDir(team);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(_teamApprovalFile(team), JSON.stringify(rec) + '\n', 'utf8');
}

// Read the namespace policy map (defaults: empty). Each entry maps
// namespace -> { policy: 'manual'|'auto'|'never', set_by, set_at }.
async function _readNamespacePolicies(team) {
  const file = _teamPolicyFile(team);
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

async function _writeNamespacePolicies(team, policies) {
  const dir = _teamDir(team);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(_teamPolicyFile(team), JSON.stringify(policies, null, 2), 'utf8');
}

// Compute the lineage hash binding a team-approved event back to the local
// event it was promoted from. sha256(local_event_hash + team_id).
export function lineageHash(localEventHash, teamId) {
  return crypto.createHash('sha256').update(String(localEventHash) + '|' + String(teamId)).digest('hex');
}

// Per-namespace policy. Default: 'manual' (each event must be explicitly
// approved). 'auto' = events whose payload.namespace matches auto-promote.
// 'never' = events from this namespace never promote even with explicit
// approval (kill-switch for sensitive namespaces).
export async function setNamespacePolicy(team, namespace, policy, opts = {}) {
  _validateTeam(team);
  if (!NAMESPACE_POLICIES.includes(policy)) {
    throw new Error(`unknown namespace policy: ${policy} (must be one of ${NAMESPACE_POLICIES.join(', ')})`);
  }
  const policies = await _readNamespacePolicies(team);
  policies[namespace] = {
    policy,
    set_by: opts.actor || 'system',
    set_at: _now(),
  };
  await _writeNamespacePolicies(team, policies);
  return policies[namespace];
}

export async function getNamespacePolicy(team, namespace) {
  const policies = await _readNamespacePolicies(team);
  return policies[namespace] || { policy: 'manual', set_by: 'default', set_at: null };
}

// Compute the latest team-approval state for a local event_hash. Returns
// {state, approved_by_hash, decided_at, lineage_hash}, defaulting to
// {state:'pending'} when no approval record exists.
export async function getTeamApproval(team, eventHash) {
  const log = await _readApprovalLog(team);
  let latest = { state: 'pending' };
  for (const rec of log) {
    if (rec.event_hash !== eventHash) continue;
    latest = {
      state: rec.state,
      approved_by_hash: rec.approved_by_hash,
      decided_at: rec.decided_at,
      lineage_hash: rec.lineage_hash,
      namespace: rec.namespace || null,
      reason: rec.reason || null,
    };
  }
  return latest;
}

// Approve a local event for team promotion. The decision lands in
// team_approvals.jsonl (separate from the event chain so the local chain
// stays untouched). `contributor` is the raw user_id — it is HASHED before
// landing in the record; the raw value never persists. (W409t)
export async function approveForTeam(team, opts = {}) {
  _validateTeam(team);
  const { event_hash, contributor, salt, reason, namespace } = opts;
  if (!event_hash) throw new Error('approveForTeam: event_hash required');
  // Reject if a namespace 'never' policy applies.
  if (namespace) {
    const p = await getNamespacePolicy(team, namespace);
    if (p.policy === 'never') throw new Error(`namespace policy=never blocks promotion: ${namespace}`);
  }
  const events = await read(team);
  const target = events.find(e => e.hash === event_hash);
  if (!target) throw new Error(`event not found: ${event_hash}`);
  const cHash = contributor != null ? contributorHash(contributor, { salt }) : null;
  const rec = {
    spec: TEAM_EVENTS_VERSION,
    team_id: team,
    event_hash,
    state: 'approved',
    approved_by_hash: cHash,
    decided_at: _now(),
    lineage_hash: lineageHash(event_hash, team),
    namespace: namespace || (target.payload && target.payload.namespace) || null,
    reason: reason || null,
  };
  await _appendApprovalRecord(team, rec);
  return rec;
}

// Reject a local event for team promotion (counterpart to approveForTeam).
export async function rejectForTeam(team, opts = {}) {
  _validateTeam(team);
  const { event_hash, contributor, salt, reason } = opts;
  if (!event_hash) throw new Error('rejectForTeam: event_hash required');
  const rec = {
    spec: TEAM_EVENTS_VERSION,
    team_id: team,
    event_hash,
    state: 'rejected',
    approved_by_hash: contributor != null ? contributorHash(contributor, { salt }) : null,
    decided_at: _now(),
    lineage_hash: lineageHash(event_hash, team),
    reason: reason || null,
  };
  await _appendApprovalRecord(team, rec);
  return rec;
}

// Approval queue — surfaces local events that are NOT yet team-approved.
// Filters reviewable kinds (positives + corrections) by default; opts.kinds
// overrides. Each row carries {hash, kind, namespace, review_state,
// team_approval_state} so the UI can render the queue + reason-to-approve.
// (W409t)
export async function listApprovalQueue(team, opts = {}) {
  _validateTeam(team);
  const events = await read(team);
  const wantKinds = opts.kinds || [EVENT_KINDS.POSITIVE, EVENT_KINDS.CORRECTION];
  const approvals = await _readApprovalLog(team);
  const latestApproval = new Map();
  for (const a of approvals) latestApproval.set(a.event_hash, a);
  const queue = [];
  for (const e of events) {
    if (!wantKinds.includes(e.kind)) continue;
    const ta = latestApproval.get(e.hash);
    const approvalState = ta ? ta.state : 'pending';
    if (opts.state && approvalState !== opts.state) continue;
    if (!opts.state && approvalState === 'approved') continue; // queue == not yet approved
    queue.push({
      event_hash: e.hash,
      kind: e.kind,
      actor: e.actor,
      artifact_version: e.artifact_version,
      timestamp: e.timestamp,
      namespace: (e.payload && e.payload.namespace) || null,
      review_state: (e.review && e.review.state) || 'pending',
      team_approval_state: approvalState,
      team_approval_reason: ta ? (ta.reason || null) : null,
    });
  }
  return queue;
}

// Like exportSeeds() but only emits rows whose team-approval is 'approved'
// (or auto-policy by namespace). Each emitted row also carries lineage_hash
// + contributor_hash + team_id so a downstream team-dataset builder can
// prove which contributor approved which seed without ever holding raw
// user_ids. The reviewer state is still consulted — only events that are
// BOTH reviewed-approved AND team-approved make the cut. (W409t)
export async function exportApprovedForTeam(team, opts = {}) {
  _validateTeam(team);
  const includeUnreviewed = opts.include_unreviewed === true;
  const all = await read(team);
  // Latest reviewer-decision per event_hash (W293/W294)
  const latestReview = new Map();
  for (const e of all) {
    if (e.kind === EVENT_KINDS.REVIEW_DECISION && e.payload && e.payload.event_hash) {
      latestReview.set(e.payload.event_hash, {
        state: e.payload.state,
        decision_hash: e.hash,
        reviewer: e.payload.reviewer,
      });
    }
  }
  const approvals = await _readApprovalLog(team);
  const latestApproval = new Map();
  for (const a of approvals) latestApproval.set(a.event_hash, a);
  const policies = await _readNamespacePolicies(team);
  let events = all.filter(e => e.kind === EVENT_KINDS.POSITIVE || e.kind === EVENT_KINDS.CORRECTION);
  const rows = [];
  for (const e of events) {
    const ns = (e.payload && e.payload.namespace) || null;
    const policy = (ns && policies[ns]) ? policies[ns].policy : 'manual';
    if (policy === 'never') continue;
    const approval = latestApproval.get(e.hash);
    let approved = false;
    let approvedByHash = null;
    let approvalLineageHash = null;
    if (approval && approval.state === 'approved') {
      approved = true;
      approvedByHash = approval.approved_by_hash;
      approvalLineageHash = approval.lineage_hash;
    } else if (policy === 'auto') {
      approved = true;
      approvedByHash = null;
      approvalLineageHash = lineageHash(e.hash, team);
    }
    if (!approved) continue;
    const review = latestReview.get(e.hash) || (e.review || { state: 'pending' });
    if (review.state === 'rejected' || review.state === 'needs_revision') continue;
    if (review.state === 'pending' && !includeUnreviewed) continue;
    const p = e.payload || {};
    let input, output;
    if (e.kind === EVENT_KINDS.CORRECTION) {
      if (typeof p.input === 'string' && typeof p.good_output === 'string') {
        input = p.input; output = p.good_output;
      }
    } else if (typeof p.input === 'string' && typeof p.output === 'string') {
      input = p.input; output = p.output;
    }
    if (typeof input !== 'string' || typeof output !== 'string') continue;
    rows.push({
      input,
      output,
      tags: [`team:${team}`, `event:${e.kind}`, `review:${review.state}`],
      source_event_hash: e.hash,
      team_id: team,
      lineage_hash: approvalLineageHash,
      contributor_hash: approvedByHash,
      namespace: ns,
      review_state: review.state,
      promotion_policy: policy,
    });
  }
  return rows;
}

// buildTeamDataset — convenience wrapper. Returns
//   { dataset_id, team_id, rows, contributor_hashes, lineage_hashes,
//     event_count, built_at }
// `dataset_id` is content-addressed over the canonical (sorted) row hash
// list, so two builds over the same approved set yield the same id. (W409t)
export async function buildTeamDataset(team, opts = {}) {
  const rows = await exportApprovedForTeam(team, opts);
  const contributor_hashes = Array.from(new Set(rows.map(r => r.contributor_hash).filter(Boolean))).sort();
  const lineage_hashes = Array.from(new Set(rows.map(r => r.lineage_hash).filter(Boolean))).sort();
  const rowHashes = rows.map(r => crypto.createHash('sha256').update(r.input + '\0' + r.output).digest('hex').slice(0, 16)).sort();
  const dataset_id = 'ds_' + crypto.createHash('sha256').update(rowHashes.join('|') + '|' + team).digest('hex').slice(0, 24);
  return {
    spec: TEAM_EVENTS_VERSION,
    dataset_id,
    team_id: team,
    rows,
    contributor_hashes,
    lineage_hashes,
    event_count: rows.length,
    built_at: _now(),
  };
}

// buildTeamArtifactMetadata — produces the metadata block a downstream
// `kolm compile` will embed in the artifact manifest. It records the
// contributor_hashes that contributed seeds, never the raw user_ids.
// `dataset` is the output of buildTeamDataset (or any object with the same
// shape). (W409t)
export function buildTeamArtifactMetadata(dataset, opts = {}) {
  if (!dataset || !dataset.dataset_id) throw new Error('dataset required');
  // CRITICAL: refuse to build metadata from a dataset that already carries a
  // raw user identity field. This is the last-mile guard before bytes hit a
  // manifest — even if upstream code accidentally attached raw user_ids,
  // they NEVER make it into the artifact.
  const FORBIDDEN_FIELDS = ['user_id', 'user_email', 'user', 'email', 'actor'];
  for (const f of FORBIDDEN_FIELDS) {
    if (dataset[f] !== undefined) {
      throw new Error(`team artifact metadata must not contain raw user identity field: ${f}`);
    }
  }
  const meta = {
    spec: TEAM_EVENTS_VERSION,
    team_id: dataset.team_id,
    dataset_id: dataset.dataset_id,
    contributor_hashes: Array.isArray(dataset.contributor_hashes) ? dataset.contributor_hashes.slice() : [],
    lineage_hashes: Array.isArray(dataset.lineage_hashes) ? dataset.lineage_hashes.slice() : [],
    event_count: dataset.event_count || 0,
    built_at: dataset.built_at || _now(),
  };
  if (opts.artifact_version) meta.artifact_version = opts.artifact_version;
  return meta;
}

// Export the team's approved events as a portable bundle. The bundle can
// then be shipped over any transport (git push, S3, signed URL) and merged
// at the other side via importTeamBundle. The bundle carries no raw user
// identity — only contributor_hash references. (W409t)
export async function exportTeamBundle(team, opts = {}) {
  _validateTeam(team);
  const approvedOnly = opts.approved_only !== false;
  const events = await read(team);
  const approvals = await _readApprovalLog(team);
  const approvalByHash = new Map();
  for (const a of approvals) approvalByHash.set(a.event_hash, a);
  const bundle = {
    spec: TEAM_EVENTS_VERSION,
    team_id: team,
    bundle_id: 'bnd_' + crypto.randomBytes(8).toString('hex'),
    exported_at: _now(),
    approved_only: approvedOnly,
    events: [],
    approvals: [],
    policies: await _readNamespacePolicies(team),
  };
  for (const e of events) {
    if (approvedOnly) {
      const a = approvalByHash.get(e.hash);
      if (!a || a.state !== 'approved') continue;
      bundle.events.push(e);
      bundle.approvals.push(a);
    } else {
      bundle.events.push(e);
    }
  }
  if (!approvedOnly) {
    for (const a of approvals) bundle.approvals.push(a);
  }
  return bundle;
}

// Merge an inbound team bundle into the local team chain. Inbound events
// land with their original hash chain preserved as `inbound_event_hash` in
// the appended row's payload, so the merged chain remains tamper-evident
// for the local audit trail. Returns counts of what landed.
//
// Inbound approvals are appended verbatim to team_approvals.jsonl — they
// reference inbound event hashes by lineage, never by raw user_id.
export async function importTeamBundle(team, bundle) {
  _validateTeam(team);
  if (!bundle || bundle.spec !== TEAM_EVENTS_VERSION) throw new Error('bad bundle spec');
  if (!Array.isArray(bundle.events)) throw new Error('bundle.events must be array');
  let imported = 0;
  const localBefore = await read(team);
  const seen = new Set(localBefore.map(e => e.hash));
  for (const e of bundle.events) {
    if (seen.has(e.hash)) continue;
    if (e.kind === EVENT_KINDS.REVIEW_DECISION) continue;
    // Validate inbound has no raw user identity contamination.
    if (e.payload && (e.payload.user_id || e.payload.user_email)) {
      throw new Error('inbound bundle carries raw user identity in payload');
    }
    await append(team, {
      kind: e.kind,
      actor: e.actor,
      artifact_version: e.artifact_version,
      payload: { ...e.payload, _imported_from: bundle.team_id, _inbound_event_hash: e.hash },
    });
    imported += 1;
  }
  if (Array.isArray(bundle.approvals)) {
    for (const a of bundle.approvals) {
      // Inbound approvals reference inbound event hashes — keep them in the
      // approval log so the lineage chain remains verifiable.
      await _appendApprovalRecord(team, { ...a, _imported_from: bundle.team_id });
    }
  }
  return { imported, bundle_id: bundle.bundle_id || null, team_id: team };
}

// Helper for tests + the W409t CLI verb — wipes the team-approval state
// files for a given team (NOT the event log itself, use _resetForTest for
// that). NEVER call outside NODE_ENV=test.
export async function _resetTeamApprovalForTest(team) {
  if (process.env.NODE_ENV !== 'test' && process.env.KOLM_ALLOW_DESTRUCTIVE !== '1') {
    throw new Error('_resetTeamApprovalForTest blocked outside NODE_ENV=test');
  }
  _validateTeam(team);
  try { await fs.unlink(_teamApprovalFile(team)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { await fs.unlink(_teamPolicyFile(team)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

export default {
  TEAM_EVENTS_VERSION,
  EVENT_KINDS,
  EVENT_SCHEMAS,
  REVIEW_STATES,
  TEAM_APPROVAL_STATES,
  NAMESPACE_POLICIES,
  append,
  setReview,
  getReview,
  read,
  chain,
  exportSeeds,
  redactForExport,
  stats,
  contributorHash,
  lineageHash,
  setNamespacePolicy,
  getNamespacePolicy,
  approveForTeam,
  rejectForTeam,
  getTeamApproval,
  listApprovalQueue,
  exportApprovedForTeam,
  buildTeamDataset,
  buildTeamArtifactMetadata,
  exportTeamBundle,
  importTeamBundle,
  _resetForTest,
  _resetTeamApprovalForTest,
};
