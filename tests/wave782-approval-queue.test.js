// W782 - Team approval workflow.
//
// Atomic items pinned (matches the W782 implementation):
//
//   1)  APPROVAL_QUEUE_VERSION matches /^w782-/ + APPROVAL_STATUSES frozen
//   2)  requestApproval persists pending row + returns {ok, approval_id, status}
//   3)  listApprovals tenant-fenced (foreign rows excluded - W411 d-in-d)
//   4)  listApprovals optional status_filter narrows by status
//   5)  approveApproval transitions pending -> granted
//   6)  approveApproval invalid_transition on double-approval (already granted)
//   7)  rejectApproval transitions pending -> rejected + requires reason
//   8)  rejectApproval invalid_transition on already-rejected
//   9)  getApprovalStatus returns latest snapshot for one id
//   10) notifyApprovers honest envelope when no channels configured
//   11) notifyApprovers happy-path with DI fetchFn + spawnFn
//   12) Bad input envelopes (missing tenant / artifact_id / requested_by)
//   13) Route auth-gated (401 without auth)
//   14) End-to-end via HTTP: request -> get -> approve -> double-approve fails
//   15) Router file wires all 6 routes + version stamps match /^w782-/
//
// W604 anti-brittleness: version regex /^w782-/, never literal equality.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as approvals from '../src/distill-approval-queue.js';
import * as auth from '../src/auth.js';
import * as kolmStore from '../src/store.js';
import * as eventStore from '../src/event-store.js';
import { buildRouter } from '../src/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// In-memory store fake matching the surface area
// distill-approval-queue.js calls (insert + findByField + all). Keeps every
// test hermetic since src/store.js caches DATA_DIR at module-load time and
// no _resetForTests is wired there.
function freshStore() {
  const rowsByTable = new Map();
  return {
    insert(table, row) {
      if (!rowsByTable.has(table)) rowsByTable.set(table, []);
      rowsByTable.get(table).push(row);
      return row;
    },
    findByField(table, field, value) {
      return (rowsByTable.get(table) || []).filter((r) => r && r[field] === value);
    },
    all(table) {
      return (rowsByTable.get(table) || []).slice();
    },
    _rows: rowsByTable,
  };
}

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w782-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  if (kolmStore._resetForTests) kolmStore._resetForTests();
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (approvals._resetForTests) approvals._resetForTests({ storeMod: freshStore() });
  // Clear any leftover env configuration so notify tests start clean.
  delete process.env.KOLM_WEBHOOK_URL;
  delete process.env.KOLM_EMAIL_NOTIFY_CMD;
  return tmp;
}

async function buildApp() {
  const tmpdir = freshDir();
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(buildRouter());
  return { app, tmpdir };
}

async function listen(app) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

// =============================================================================
// 1) Version + APPROVAL_STATUSES frozen
// =============================================================================

test('W782 #1 - APPROVAL_QUEUE_VERSION matches /^w782-/ + APPROVAL_STATUSES frozen', () => {
  assert.match(approvals.APPROVAL_QUEUE_VERSION, /^w782-/);
  assert.ok(Object.isFrozen(approvals.APPROVAL_STATUSES));
  assert.deepEqual(Array.from(approvals.APPROVAL_STATUSES),
    ['pending', 'granted', 'rejected', 'expired']);
  assert.equal(approvals.APPROVAL_TABLE, 'distill_approvals');
  assert.equal(typeof approvals.requestApproval, 'function');
  assert.equal(typeof approvals.listApprovals, 'function');
  assert.equal(typeof approvals.approveApproval, 'function');
  assert.equal(typeof approvals.rejectApproval, 'function');
  assert.equal(typeof approvals.getApprovalStatus, 'function');
  assert.equal(typeof approvals.notifyApprovers, 'function');
});

// =============================================================================
// 2) requestApproval persists + returns ok envelope
// =============================================================================

test('W782 #2 - requestApproval creates pending row + returns approval_id', () => {
  freshDir();
  const out = approvals.requestApproval({
    tenant: 'tenant_w782_2',
    artifact_id: 'art_abc123',
    requested_by: 'u_alice',
    namespace: 'support',
    reason: 'rolling out gpt-4o-mini -> distilled',
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'pending');
  assert.equal(out.tenant_id, 'tenant_w782_2');
  assert.equal(out.namespace, 'support');
  assert.equal(out.artifact_id, 'art_abc123');
  assert.ok(out.approval_id && typeof out.approval_id === 'string');
  assert.ok(out.expires_at && typeof out.expires_at === 'string');
  assert.match(out.version, /^w782-/);

  // listApprovals must surface it.
  const list = approvals.listApprovals({ tenant: 'tenant_w782_2' });
  assert.equal(list.ok, true);
  assert.equal(list.count, 1);
  assert.equal(list.approvals[0].id, out.approval_id);
  assert.equal(list.approvals[0].status, 'pending');
});

// =============================================================================
// 3) Tenant fence (W411 defense-in-depth)
// =============================================================================

test('W782 #3 - listApprovals is tenant-fenced (foreign rows excluded)', () => {
  freshDir();
  approvals.requestApproval({
    tenant: 'tenant_w782_3_A', artifact_id: 'art_a', requested_by: 'u_a',
  });
  approvals.requestApproval({
    tenant: 'tenant_w782_3_A', artifact_id: 'art_b', requested_by: 'u_a',
  });
  approvals.requestApproval({
    tenant: 'tenant_w782_3_B', artifact_id: 'art_c', requested_by: 'u_b',
  });
  const a = approvals.listApprovals({ tenant: 'tenant_w782_3_A' });
  assert.equal(a.ok, true);
  assert.equal(a.count, 2, 'tenant A must see exactly its 2 rows');
  for (const r of a.approvals) {
    assert.equal(r.tenant_id, 'tenant_w782_3_A',
      'foreign tenant_id leaked into list: ' + JSON.stringify(r));
  }
  const b = approvals.listApprovals({ tenant: 'tenant_w782_3_B' });
  assert.equal(b.count, 1);
  assert.equal(b.approvals[0].artifact_id, 'art_c');
});

// =============================================================================
// 4) Status filter narrows results
// =============================================================================

test('W782 #4 - listApprovals status_filter narrows by status', () => {
  freshDir();
  const r1 = approvals.requestApproval({
    tenant: 'tenant_w782_4', artifact_id: 'art1', requested_by: 'u',
  });
  const r2 = approvals.requestApproval({
    tenant: 'tenant_w782_4', artifact_id: 'art2', requested_by: 'u',
  });
  approvals.approveApproval({
    tenant: 'tenant_w782_4', approval_id: r1.approval_id, approved_by: 'mgr',
  });
  const pending = approvals.listApprovals({ tenant: 'tenant_w782_4', status_filter: 'pending' });
  assert.equal(pending.count, 1);
  assert.equal(pending.approvals[0].id, r2.approval_id);
  const granted = approvals.listApprovals({ tenant: 'tenant_w782_4', status_filter: 'granted' });
  assert.equal(granted.count, 1);
  assert.equal(granted.approvals[0].id, r1.approval_id);
  // Bad status_filter -> honest envelope.
  const bad = approvals.listApprovals({ tenant: 'tenant_w782_4', status_filter: 'banana' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_status_filter');
  assert.deepEqual(Array.from(bad.supported), ['pending', 'granted', 'rejected', 'expired']);
});

// =============================================================================
// 5) approveApproval pending -> granted
// =============================================================================

test('W782 #5 - approveApproval transitions pending -> granted', () => {
  freshDir();
  const r = approvals.requestApproval({
    tenant: 'tenant_w782_5', artifact_id: 'art', requested_by: 'u',
  });
  const ok = approvals.approveApproval({
    tenant: 'tenant_w782_5', approval_id: r.approval_id, approved_by: 'manager_42',
    reason: 'reviewed eval; ok to ship',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 'granted');
  assert.equal(ok.approver_id, 'manager_42');
  assert.ok(ok.granted_at);
  // status snapshot must reflect granted.
  const st = approvals.getApprovalStatus({ tenant: 'tenant_w782_5', approval_id: r.approval_id });
  assert.equal(st.status, 'granted');
  assert.equal(st.approver_reason, 'reviewed eval; ok to ship');
});

// =============================================================================
// 6) Double-approval blocked
// =============================================================================

test('W782 #6 - approveApproval invalid_transition on already-granted row', () => {
  freshDir();
  const r = approvals.requestApproval({
    tenant: 'tenant_w782_6', artifact_id: 'art', requested_by: 'u',
  });
  approvals.approveApproval({
    tenant: 'tenant_w782_6', approval_id: r.approval_id, approved_by: 'mgr',
  });
  // Second approval attempt MUST fail honestly.
  const dup = approvals.approveApproval({
    tenant: 'tenant_w782_6', approval_id: r.approval_id, approved_by: 'other_mgr',
  });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'invalid_transition');
  assert.equal(dup.current_status, 'granted');
  assert.match(dup.version, /^w782-/);
});

// =============================================================================
// 7) rejectApproval requires reason + transitions pending -> rejected
// =============================================================================

test('W782 #7 - rejectApproval requires reason + transitions pending -> rejected', () => {
  freshDir();
  const r = approvals.requestApproval({
    tenant: 'tenant_w782_7', artifact_id: 'art', requested_by: 'u',
  });
  // No reason -> rejected with error
  const noReason = approvals.rejectApproval({
    tenant: 'tenant_w782_7', approval_id: r.approval_id, rejected_by: 'mgr',
  });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.error, 'reason_required');
  // With reason -> succeeds
  const out = approvals.rejectApproval({
    tenant: 'tenant_w782_7', approval_id: r.approval_id, rejected_by: 'mgr',
    reason: 'eval gap > 5% on golden set',
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'rejected');
  assert.equal(out.reason, 'eval gap > 5% on golden set');
});

// =============================================================================
// 8) Reject after reject blocked
// =============================================================================

test('W782 #8 - rejectApproval invalid_transition on already-rejected row', () => {
  freshDir();
  const r = approvals.requestApproval({
    tenant: 'tenant_w782_8', artifact_id: 'art', requested_by: 'u',
  });
  approvals.rejectApproval({
    tenant: 'tenant_w782_8', approval_id: r.approval_id, rejected_by: 'mgr', reason: 'bad',
  });
  const dup = approvals.rejectApproval({
    tenant: 'tenant_w782_8', approval_id: r.approval_id, rejected_by: 'mgr', reason: 'still bad',
  });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'invalid_transition');
  assert.equal(dup.current_status, 'rejected');
});

// =============================================================================
// 9) getApprovalStatus returns snapshot
// =============================================================================

test('W782 #9 - getApprovalStatus returns latest snapshot + not_found on unknown id', () => {
  freshDir();
  const r = approvals.requestApproval({
    tenant: 'tenant_w782_9', artifact_id: 'art', requested_by: 'u', namespace: 'finance',
  });
  const st = approvals.getApprovalStatus({ tenant: 'tenant_w782_9', approval_id: r.approval_id });
  assert.equal(st.ok, true);
  assert.equal(st.status, 'pending');
  assert.equal(st.namespace, 'finance');
  assert.equal(st.artifact_id, 'art');
  // Unknown id -> not_found.
  const nf = approvals.getApprovalStatus({ tenant: 'tenant_w782_9', approval_id: 'appr_does_not_exist' });
  assert.equal(nf.ok, false);
  assert.equal(nf.error, 'not_found');
});

// =============================================================================
// 10) notifyApprovers honest envelope when no channels configured
// =============================================================================

test('W782 #10 - notifyApprovers returns per-channel envelopes when no config', async () => {
  freshDir();
  const r = approvals.requestApproval({
    tenant: 'tenant_w782_10', artifact_id: 'art', requested_by: 'u',
  });
  const out = await approvals.notifyApprovers({
    tenant: 'tenant_w782_10', approval_id: r.approval_id,
  });
  assert.equal(out.ok, true, 'notifyApprovers itself never fails on missing config');
  assert.equal(out.any_dispatched, false);
  assert.equal(out.channels.webhook.ok, false);
  assert.equal(out.channels.webhook.error, 'no_webhook_configured');
  assert.equal(out.channels.email.ok, false);
  assert.equal(out.channels.email.error, 'no_email_configured');
});

// =============================================================================
// 11) notifyApprovers DI happy-path
// =============================================================================

test('W782 #11 - notifyApprovers happy-path with DI fetchFn + spawnFn', async () => {
  freshDir();
  process.env.KOLM_WEBHOOK_URL = 'https://hooks.example.test/approval';
  process.env.KOLM_EMAIL_NOTIFY_CMD = JSON.stringify(['node', '-e', 'process.exit(0)']);

  const r = approvals.requestApproval({
    tenant: 'tenant_w782_11', artifact_id: 'art', requested_by: 'u',
  });
  let webhookHit = null;
  const fakeFetch = async (url, opts) => {
    webhookHit = { url, body: JSON.parse(opts.body) };
    return { status: 200, ok: true };
  };
  let spawnHit = null;
  const fakeSpawn = (bin, args, spawnOpts) => {
    spawnHit = { bin, args, input: spawnOpts.input };
    return { status: 0, stdout: '', stderr: '' };
  };
  const out = await approvals.notifyApprovers({
    tenant: 'tenant_w782_11',
    approval_id: r.approval_id,
    fetchFn: fakeFetch,
    spawnFn: fakeSpawn,
  });
  assert.equal(out.ok, true);
  assert.equal(out.any_dispatched, true);
  assert.equal(out.channels.webhook.ok, true);
  assert.equal(out.channels.webhook.status, 200);
  assert.equal(out.channels.email.ok, true);
  assert.equal(out.channels.email.exit_code, 0);
  assert.ok(webhookHit && webhookHit.body.approval_id === r.approval_id);
  assert.ok(spawnHit && spawnHit.input.length > 0);
});

// =============================================================================
// 12) Bad input envelopes
// =============================================================================

test('W782 #12 - bad input returns honest envelopes (no throws)', () => {
  freshDir();
  // Missing tenant
  let out = approvals.requestApproval({ artifact_id: 'a', requested_by: 'u' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'tenant_required');
  // Missing artifact_id
  out = approvals.requestApproval({ tenant: 't', requested_by: 'u' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'artifact_id_required');
  // Missing requested_by
  out = approvals.requestApproval({ tenant: 't', artifact_id: 'a' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'requested_by_required');
  // approve without approval_id
  out = approvals.approveApproval({ tenant: 't', approved_by: 'mgr' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'approval_id_required');
  // approve without approver
  out = approvals.approveApproval({ tenant: 't', approval_id: 'x' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'approved_by_required');
});

// =============================================================================
// 13) Routes auth-gated
// =============================================================================

test('W782 #13 - approval routes are auth-gated (401 without auth)', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const routes = [
      { method: 'GET', url: '/v1/approvals' },
      { method: 'GET', url: '/v1/approvals/appr_xyz' },
      { method: 'POST', url: '/v1/approvals/request', body: {} },
      { method: 'POST', url: '/v1/approvals/appr_xyz/approve', body: {} },
      { method: 'POST', url: '/v1/approvals/appr_xyz/reject', body: { reason: 'x' } },
      { method: 'POST', url: '/v1/approvals/appr_xyz/notify', body: {} },
    ];
    for (const r of routes) {
      const opts = { method: r.method };
      if (r.body) {
        opts.headers = { 'content-type': 'application/json' };
        opts.body = JSON.stringify(r.body);
      }
      const res = await fetch(base + r.url, opts);
      assert.equal(res.status, 401, r.method + ' ' + r.url + ' must 401 without auth (got: ' + res.status + ')');
    }
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 14) End-to-end via HTTP
// =============================================================================

test('W782 #14 - E2E: request -> get -> approve -> double-approve blocked', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const tenant = await auth.provisionAnonTenant();
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${tenant.api_key}`,
    };

    // 1) Request
    const r1 = await fetch(`${base}/v1/approvals/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        artifact_id: 'art_e2e',
        requested_by: 'u_qa',
        namespace: 'support',
        reason: 'ship distilled support model',
      }),
    });
    assert.equal(r1.status, 200);
    const b1 = await r1.json();
    assert.equal(b1.ok, true);
    assert.equal(b1.status, 'pending');
    const approval_id = b1.approval_id;

    // 2) GET single
    const r2 = await fetch(`${base}/v1/approvals/${approval_id}`, { headers });
    assert.equal(r2.status, 200);
    const b2 = await r2.json();
    assert.equal(b2.status, 'pending');

    // 3) Approve
    const r3 = await fetch(`${base}/v1/approvals/${approval_id}/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ approved_by: 'mgr', reason: 'lgtm' }),
    });
    assert.equal(r3.status, 200);
    const b3 = await r3.json();
    assert.equal(b3.ok, true);
    assert.equal(b3.status, 'granted');

    // 4) Double-approve fails
    const r4 = await fetch(`${base}/v1/approvals/${approval_id}/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ approved_by: 'mgr2' }),
    });
    assert.equal(r4.status, 400);
    const b4 = await r4.json();
    assert.equal(b4.ok, false);
    assert.equal(b4.error, 'invalid_transition');
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 15) Router wires all 6 routes
// =============================================================================

test('W782 #15 - router.js wires all 6 /v1/approvals routes + version stamps', () => {
  const router = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  assert.match(router, /r\.post\(['"]\/v1\/approvals\/request['"]/);
  assert.match(router, /r\.get\(['"]\/v1\/approvals['"]/);
  assert.match(router, /r\.get\(['"]\/v1\/approvals\/:id['"]/);
  assert.match(router, /r\.post\(['"]\/v1\/approvals\/:id\/approve['"]/);
  assert.match(router, /r\.post\(['"]\/v1\/approvals\/:id\/reject['"]/);
  assert.match(router, /r\.post\(['"]\/v1\/approvals\/:id\/notify['"]/);
  assert.match(router, /version:\s*['"]w782-/, 'router must emit w782 version stamps');
});
