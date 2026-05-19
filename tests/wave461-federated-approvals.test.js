// W461 — federated approval-row sharing (hash-only, DP-noised).
//
// Closes audit P1 Federated Foundations cluster open item:
//   "approval-row sharing (decisions, not data); cross-org demo with 2+
//    tenants; opt-in policy + audit chain."
//
// Tests assert behavior:
//   - opt-in / opt-out registry persistence + tenant fence
//   - shareApprovalRows() emits hash-only rows (NO raw text)
//   - aggregateApprovals() noises peer counts with Laplace
//   - two in-process tenants can run the cross-org demo end-to-end
//   - AUDIT_OPS entries land in the local audit chain
//
// Why this test pattern: every check goes through the live module APIs and
// inspects file state on disk where the audit memo wants receipts to land.
// Static-source pins guard the load-bearing constants.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';

const TMP = path.join(os.tmpdir(), 'kolm-wave461-' + crypto.randomBytes(3).toString('hex'));
fs.mkdirSync(TMP, { recursive: true });
process.env.KOLM_DATA_DIR = TMP;

const { default: _default, ...rest } = await import('../src/federated-approvals.js');
const {
  computeApprovalHash,
  optIn,
  optOut,
  getOptInState,
  listPeers,
  shareApprovalRows,
  aggregateApprovals,
  auditTrail,
  FEATURE_STATE,
  DEFAULT_DP_EPSILON,
  DP_SENSITIVITY,
  _wipeLocalState,
} = rest;

const { appendEvent, listEvents } = await import('../src/event-store.js');
const { approveEvent, rejectEvent } = await import('../src/dataset-workbench.js');
const { listAuditEvents } = await import('../src/audit.js');

function _eid() { return 'ev_' + crypto.randomBytes(8).toString('hex'); }

async function seedEvent(tenant_id, namespace, prompt, response) {
  const event_id = _eid();
  await appendEvent({
    event_id,
    tenant_id,
    namespace,
    workflow_id: namespace,
    prompt_redacted: prompt,
    response_redacted: response,
    provider: 'kolm-test',
    model: 'test-model',
    created_at: new Date().toISOString(),
  });
  return event_id;
}

test('W461 #1 — computeApprovalHash is deterministic + namespace+input+decision are load-bearing', () => {
  const h1 = computeApprovalHash({ namespace: 'support', input: 'hi', decision_kind: 'approved' });
  const h2 = computeApprovalHash({ namespace: 'support', input: 'hi', decision_kind: 'approved' });
  assert.equal(h1.approval_hash, h2.approval_hash);
  assert.equal(h1.input_hash, h2.input_hash);
  // namespace change must shift the approval_hash but NOT the input_hash
  const h3 = computeApprovalHash({ namespace: 'other', input: 'hi', decision_kind: 'approved' });
  assert.notEqual(h1.approval_hash, h3.approval_hash);
  assert.equal(h1.input_hash, h3.input_hash, 'input_hash binds input only; namespace does not affect it');
  // decision change must shift the approval_hash
  const h4 = computeApprovalHash({ namespace: 'support', input: 'hi', decision_kind: 'rejected' });
  assert.notEqual(h1.approval_hash, h4.approval_hash);
  // bad decision_kind throws
  assert.throws(() => computeApprovalHash({ namespace: 'support', input: 'hi', decision_kind: 'maybe' }));
});

test('W461 #2 — opt-in / opt-out persistence + audit chain', () => {
  _wipeLocalState();
  const entry = optIn({ tenant_id: 'tenant-A', scope: ['support'], peers: ['tenant-B'], note: 'demo' });
  assert.equal(entry.tenant_id, 'tenant-A');
  assert.deepEqual(entry.namespaces, ['support']);
  assert.deepEqual(entry.peers, ['tenant-B']);
  assert.equal(entry.feature_state, FEATURE_STATE);
  // re-read through getOptInState
  const got = getOptInState('tenant-A');
  assert.equal(got.tenant_id, 'tenant-A');
  // audit chain wrote a federated.optin row
  const events = listAuditEvents('tenant-A');
  const ops = events.map(e => e.op);
  assert.ok(ops.includes('federated.optin'), 'audit chain must record federated.optin');
  // opt-out clears the registry
  const out = optOut({ tenant_id: 'tenant-A', reason: 'demo-end' });
  assert.equal(out.opted_out, true);
  assert.equal(getOptInState('tenant-A'), null);
  const events2 = listAuditEvents('tenant-A');
  assert.ok(events2.map(e => e.op).includes('federated.optout'));
});

test('W461 #3 — listPeers excludes self', () => {
  _wipeLocalState();
  optIn({ tenant_id: 'tenant-A', scope: ['support'] });
  optIn({ tenant_id: 'tenant-B', scope: ['support'] });
  optIn({ tenant_id: 'tenant-C', scope: ['support'] });
  const fromA = listPeers({ tenant_id: 'tenant-A' });
  assert.equal(fromA.length, 2);
  assert.ok(!fromA.some(p => p.tenant_id === 'tenant-A'));
  assert.ok(fromA.some(p => p.tenant_id === 'tenant-B'));
  assert.ok(fromA.some(p => p.tenant_id === 'tenant-C'));
});

test('W461 #4 — shareApprovalRows emits hash-only rows; raw text NEVER appears', async () => {
  _wipeLocalState();
  const ns = 'w461-4-' + crypto.randomBytes(2).toString('hex');
  optIn({ tenant_id: 'tenant-A', scope: [ns] });
  const eid = await seedEvent('tenant-A', ns, 'how do I reset my password', 'click the reset link');
  await approveEvent(eid, { reviewer: 'r1', tenant_id: 'tenant-A' });
  const result = await shareApprovalRows({ tenant_id: 'tenant-A', namespace: ns });
  assert.equal(result.envelope.tenant_id, 'tenant-A');
  assert.equal(result.envelope.rows_count, 1);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  // hash-only shape
  assert.equal(typeof row.approval_hash, 'string');
  assert.equal(row.approval_hash.length, 64);
  assert.equal(typeof row.input_hash, 'string');
  assert.equal(row.input_hash.length, 64);
  assert.equal(row.decision_kind, 'approved');
  // raw text MUST NOT appear in the row
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes('how do I reset my password'), 'raw input must not appear');
  assert.ok(!serialized.includes('click the reset link'), 'raw output must not appear');
  // envelope must not carry raw text either
  const envelopeStr = JSON.stringify(result.envelope);
  assert.ok(!envelopeStr.includes('how do I reset my password'));
});

test('W461 #5 — shareApprovalRows rejects when tenant did not opt-in', async () => {
  _wipeLocalState();
  await assert.rejects(
    () => shareApprovalRows({ tenant_id: 'tenant-X', namespace: 'support' }),
    /not opted in/i,
  );
});

test('W461 #6 — shareApprovalRows rejects out-of-scope namespace', async () => {
  _wipeLocalState();
  const ns = 'w461-6-' + crypto.randomBytes(2).toString('hex');
  optIn({ tenant_id: 'tenant-A', scope: [ns] });
  await assert.rejects(
    () => shareApprovalRows({ tenant_id: 'tenant-A', namespace: ns + '-other' }),
    /not in opt-in scope/i,
  );
});

test('W461 #7 — cross-tenant fence: A cannot share B\'s approvals', async () => {
  _wipeLocalState();
  const ns = 'w461-7-' + crypto.randomBytes(2).toString('hex');
  optIn({ tenant_id: 'tenant-A', scope: [ns] });
  optIn({ tenant_id: 'tenant-B', scope: [ns] });
  // B's event + B's approval
  const eidB = await seedEvent('tenant-B', ns, 'B-private-prompt', 'B-private-response');
  await approveEvent(eidB, { reviewer: 'rb', tenant_id: 'tenant-B' });
  // A tries to share — should see ZERO rows (B's approval is tenant-fenced)
  const result = await shareApprovalRows({ tenant_id: 'tenant-A', namespace: ns });
  assert.equal(result.envelope.rows_count, 0, 'A must not see B\'s approvals');
});

test('W461 #8 — aggregateApprovals applies Laplace noise to peer counts', () => {
  _wipeLocalState();
  // Build two row sets that share an approval_hash and one that is local-only
  const sharedHash = 'a'.repeat(64);
  const localOnlyHash = 'b'.repeat(64);
  const peerOnlyHash = 'c'.repeat(64);
  // Many peer rows for the shared hash → expected aggregate peer_count ≈ 100
  const local_rows = [
    { approval_hash: sharedHash, decision_kind: 'approved' },
    { approval_hash: localOnlyHash, decision_kind: 'approved' },
  ];
  const peer_rows = [];
  for (let i = 0; i < 100; i++) peer_rows.push({ approval_hash: sharedHash, decision_kind: 'approved' });
  for (let i = 0; i < 5; i++) peer_rows.push({ approval_hash: peerOnlyHash, decision_kind: 'approved' });

  const out = aggregateApprovals({ local_rows, peer_rows, epsilon: DEFAULT_DP_EPSILON });
  assert.equal(out.feature_state, FEATURE_STATE);
  assert.equal(out.epsilon, DEFAULT_DP_EPSILON);
  assert.equal(out.sensitivity, DP_SENSITIVITY);
  assert.equal(out.laplace_scale, DP_SENSITIVITY / DEFAULT_DP_EPSILON);
  const shared = out.rows.find(r => r.approval_hash === sharedHash);
  const localOnly = out.rows.find(r => r.approval_hash === localOnlyHash);
  const peerOnly = out.rows.find(r => r.approval_hash === peerOnlyHash);
  assert.equal(shared.local_count, 1);
  // noised peer count is plausibly within 50% of 100 (Laplace scale 1 is tiny vs n=100)
  assert.ok(shared.peer_count_noised >= 50 && shared.peer_count_noised <= 150,
    `noised peer count for shared hash should be near 100, got ${shared.peer_count_noised}`);
  assert.equal(localOnly.local_count, 1);
  // Laplace noise on raw=0 with scale 1.0 occasionally rounds to 1-2 — that's
  // privacy doing its job. The stable invariant is peer_count_raw_present:false.
  assert.ok(localOnly.peer_count_noised <= 5,
    `noised peer count for local-only hash should be near 0, got ${localOnly.peer_count_noised}`);
  assert.equal(localOnly.peer_count_raw_present, false);
  assert.equal(peerOnly.local_count, 0);
});

test('W461 #9 — aggregateApprovals rejects bad epsilon', () => {
  assert.throws(() => aggregateApprovals({ local_rows: [], peer_rows: [], epsilon: 0 }));
  assert.throws(() => aggregateApprovals({ local_rows: [], peer_rows: [], epsilon: -1 }));
});

test('W461 #10 — 2-tenant cross-org demo end-to-end (the audit memo deliverable)', async () => {
  _wipeLocalState();
  const ns = 'w461-10-' + crypto.randomBytes(2).toString('hex');
  optIn({ tenant_id: 'tenant-A', scope: [ns] });
  optIn({ tenant_id: 'tenant-B', scope: [ns] });
  // Both tenants approve the SAME logical question independently. The
  // approval_hashes should match — that's the whole point of the protocol.
  const sharedPrompt = 'I forgot my password. how do I reset it? — ' + crypto.randomBytes(4).toString('hex');
  const eidA = await seedEvent('tenant-A', ns, sharedPrompt, 'See reset link in email.');
  const eidB = await seedEvent('tenant-B', ns, sharedPrompt, 'Click forgot password.');
  await approveEvent(eidA, { reviewer: 'ra', tenant_id: 'tenant-A' });
  await approveEvent(eidB, { reviewer: 'rb', tenant_id: 'tenant-B' });
  const shareA = await shareApprovalRows({ tenant_id: 'tenant-A', namespace: ns });
  const shareB = await shareApprovalRows({ tenant_id: 'tenant-B', namespace: ns });
  assert.equal(shareA.rows.length, 1);
  assert.equal(shareB.rows.length, 1);
  // Same prompt + same namespace + same decision_kind → identical approval_hash
  assert.equal(
    shareA.rows[0].approval_hash,
    shareB.rows[0].approval_hash,
    'two tenants approving the same prompt + namespace must produce matching approval_hashes',
  );
  // Aggregate: A treats B's rows as peer input. Peer count for the shared
  // hash must be at least 1 (noised) and local count must be 1.
  const agg = aggregateApprovals({ local_rows: shareA.rows, peer_rows: shareB.rows });
  const matchRow = agg.rows.find(r => r.approval_hash === shareA.rows[0].approval_hash);
  assert.ok(matchRow);
  assert.equal(matchRow.local_count, 1);
  assert.equal(matchRow.peer_count_raw_present, true);
});

test('W461 #11 — audit trail surfaces the share envelopes', async () => {
  _wipeLocalState();
  const ns = 'w461-11-' + crypto.randomBytes(2).toString('hex');
  optIn({ tenant_id: 'tenant-A', scope: [ns] });
  const eid = await seedEvent('tenant-A', ns, 'audit-prompt-' + crypto.randomBytes(2).toString('hex'), 'audit-response');
  await approveEvent(eid, { reviewer: 'r1', tenant_id: 'tenant-A' });
  await shareApprovalRows({ tenant_id: 'tenant-A', namespace: ns });
  await shareApprovalRows({ tenant_id: 'tenant-A', namespace: ns });
  const trail = auditTrail({ tenant_id: 'tenant-A', limit: 5 });
  assert.equal(trail.tenant_id, 'tenant-A');
  assert.equal(trail.total, 2);
  assert.ok(trail.shares.every(s => s.namespace === ns));
});

test('W461 #12 — source pin: AUDIT_OPS exports the 3 federated ops', async () => {
  const src = fs.readFileSync(new URL('../src/audit.js', import.meta.url), 'utf8');
  for (const op of ['FEDERATED_OPTIN', 'FEDERATED_OPTOUT', 'FEDERATED_SHARE']) {
    assert.ok(src.includes(op), `audit.js must export ${op}`);
  }
});

test('W461 #13 — sw.js CACHE references the wave461 family pattern', () => {
  const sw = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  // Family pattern: regex+threshold (never explicit-array). Any wave >= 461 counts.
  const wm = sw.match(/wave(\d{3,4})/);
  assert.ok(wm, 'public/sw.js CACHE must declare a waveNNN token');
  assert.ok(parseInt(wm[1], 10) >= 461,
    'public/sw.js CACHE slug should reference wave461 or a successor, got wave' + wm[1]);
});
