// Wave 409n / 409o / 409p — Datasets + Human labeling + Bakeoffs.
//
// Five invariants (per the W409nop spec):
//
//   1. Deterministic split: same dataset + same seed -> identical
//      train_ids / holdout_ids / split_signature across runs.
//
//   2. Approved-only mode: an unapproved (or rejected) row NEVER appears
//      in the train OR holdout split when createDataset({approvedOnly:true}).
//
//   3. Reviewer identity + audit trail recorded: submitLabel persists the
//      reviewer + decided_at on the row, AND the append-only approvals.jsonl
//      contains the full before/after history.
//
//   4. Bakeoff row shape: every contestant exposes
//      quality / cost / latency / privacy / determinism columns.
//
//   5. Recommendation enum: the bakeoff `recommendation` field is one of
//      {keep_frontier, distill, compile_rule, use_local_backbone, needs_human}.
//
// Each test runs against its own tmpdir (KOLM_DATA_DIR + HOME isolated) so
// the developer's real event store / labels / datasets dir is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function mkTmp(label = 'w409nop') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-' + label + '-'));
}

function snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
  };
}
function setEnv(tmp) {
  // KOLM_DATA_DIR is the kolm base dir itself (not a parent of .kolm/).
  // Modules use `process.env.KOLM_DATA_DIR ? path.resolve(it) : ~/.kolm`.
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  // KOLM_STORE_DRIVER 'jsonl' is rejected by src/store.js (which expects
  // 'json' or 'sqlite'); event-store.js looks at it differently. The router
  // imports store.js so we use 'json' here for in-process Express tests.
  process.env.KOLM_STORE_DRIVER = 'json';
}
// Path helper: KOLM_DATA_DIR is the kolm base dir itself (no .kolm prefix).
function kolmDir(tmp, ...rest) { return path.join(tmp, ...rest); }
function restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

async function seedNamespace(namespace, n = 20, opts = {}) {
  const { appendEvent, _resetForTests } = await import('../src/event-store.js');
  _resetForTests();
  const ids = [];
  for (let i = 0; i < n; i++) {
    const ev = await appendEvent({
      namespace,
      tenant_id: opts.tenantId || 'wave409nop-test',
      prompt_redacted: 'classify ticket ' + i + ' about billing and refunds',
      response_redacted: 'category_' + (i % 5),
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
      ...(opts.sourceType ? { source_type: opts.sourceType } : {}),
      ...(opts.workflow_id ? { workflow_id: opts.workflow_id + '_' + i } : {}),
      ...(opts.trace_id ? { trace_id: opts.trace_id + '_' + i } : {}),
      ...(opts.media_kind ? {
        media_kind: opts.media_kind,
        media_uri: 'file://' + namespace + '/' + i + '.png',
        media_hash: 'sha256:' + i,
        media_bytes: 1024 * (i + 1),
        media_mime: 'image/png',
        media_extracted_text: 'extracted from image ' + i,
      } : {}),
    });
    ids.push(ev.event_id);
  }
  return ids;
}

// ---------------- W409n: dataset workbench --------------------------------

test('W409n #1 — deterministic split across runs (same seed -> same train_ids)', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    await seedNamespace('w409n-det', 30);
    const ws = await import('../src/dataset-workbench.js');
    // Pre-approve everything so approvedOnly:false isn't a confound.
    const { listEvents } = await import('../src/event-store.js');
    const evs = await listEvents({ namespace: 'w409n-det', limit: 100 });
    for (const e of evs) await ws.approveEvent(e.event_id, { reviewer: 'r1' });

    const dsA = await ws.createDataset('w409n-det', { seed: 42, train_ratio: 0.8 });
    const dsB = await ws.createDataset('w409n-det', { seed: 42, train_ratio: 0.8 });
    const splitA = await ws.splitDataset(dsA.dataset_id, 0.8, { seed: 42 });
    const splitB = await ws.splitDataset(dsB.dataset_id, 0.8, { seed: 42 });

    // The IDs themselves change per run (timestamped) but the partition of
    // source_event_ids -> train/holdout MUST be identical when seed matches.
    assert.equal(splitA.train_count, splitB.train_count, 'train_count must match across same-seed runs');
    assert.equal(splitA.holdout_count, splitB.holdout_count, 'holdout_count must match across same-seed runs');
    // Same set of source events (we seeded the same namespace) -> same partition.
    // Normalize ID->index by source ordering and compare bucket assignments.
    const recordA = JSON.parse(fs.readFileSync(kolmDir(tmp, 'datasets', dsA.dataset_id + '.json'), 'utf8'));
    const recordB = JSON.parse(fs.readFileSync(kolmDir(tmp, 'datasets', dsB.dataset_id + '.json'), 'utf8'));
    const sourceA = recordA.source_event_ids;
    const sourceB = recordB.source_event_ids;
    assert.deepEqual(sourceA.slice().sort(), sourceB.slice().sort(), 'source events must be identical');
    // For every source event, its bucket must be the same in both runs.
    const bucketA = new Map();
    for (const id of splitA.train_ids) bucketA.set(id, 'train');
    for (const id of splitA.holdout_ids) bucketA.set(id, 'holdout');
    for (const id of splitB.train_ids) {
      assert.equal(bucketA.get(id), 'train', `event ${id} flipped bucket: A=${bucketA.get(id)} B=train`);
    }
    for (const id of splitB.holdout_ids) {
      assert.equal(bucketA.get(id), 'holdout', `event ${id} flipped bucket: A=${bucketA.get(id)} B=holdout`);
    }
    // Disjointness sanity check inside each split too.
    const t = new Set(splitB.train_ids);
    for (const h of splitB.holdout_ids) assert.ok(!t.has(h), `disjointness violation: ${h}`);
  } finally {
    restoreEnv(saved);
  }
});

test('W409n #2 — different seeds produce different splits', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    await seedNamespace('w409n-seedchange', 40);
    const ws = await import('../src/dataset-workbench.js');
    const ds1 = await ws.createDataset('w409n-seedchange', { seed: 1 });
    const ds2 = await ws.createDataset('w409n-seedchange', { seed: 99 });
    const s1 = await ws.splitDataset(ds1.dataset_id, 0.8, { seed: 1 });
    const s2 = await ws.splitDataset(ds2.dataset_id, 0.8, { seed: 99 });
    // signatures MUST differ (the partition is different).
    assert.notEqual(s1.split_signature, s2.split_signature, 'different seeds must produce different split signatures');
  } finally {
    restoreEnv(saved);
  }
});

test('W409n #3 — approved-only mode never lets an unapproved row into the split', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    const evIds = await seedNamespace('w409n-appr', 20);
    const ws = await import('../src/dataset-workbench.js');
    // Approve a deterministic subset.
    const approvedSet = new Set();
    for (let i = 0; i < evIds.length; i++) {
      if (i % 3 === 0) {
        await ws.approveEvent(evIds[i], { reviewer: 'alice' });
        approvedSet.add(evIds[i]);
      } else if (i % 3 === 1) {
        await ws.rejectEvent(evIds[i], { reviewer: 'alice', reason: 'wrong' });
      }
      // i % 3 === 2 stays unlabeled.
    }
    const ds = await ws.createDataset('w409n-appr', { approvedOnly: true, seed: 7 });
    const split = await ws.splitDataset(ds.dataset_id, 0.8, { seed: 7 });
    const allRows = new Set([...split.train_ids, ...split.holdout_ids]);
    // Hard assert: no row outside approvedSet leaks into the split.
    for (const id of allRows) {
      assert.ok(approvedSet.has(id),
        `approved-only invariant violated: ${id} is in the split but never approved`);
    }
    // And every approved row appears in exactly one bucket.
    const trainSet = new Set(split.train_ids);
    const holdoutSet = new Set(split.holdout_ids);
    for (const id of approvedSet) {
      const inTrain = trainSet.has(id);
      const inHoldout = holdoutSet.has(id);
      assert.ok(inTrain || inHoldout, `approved row ${id} dropped from split`);
      assert.ok(!(inTrain && inHoldout), `approved row ${id} in both buckets`);
    }
    // Sanity: buckets bookkeeping reflects the source breakdown.
    assert.ok(ds.buckets && ds.buckets.approved >= 1, 'buckets.approved should count >= 1 approved row');
    assert.equal(ds.approved_only, true, 'approved_only flag must persist on the record');
  } finally {
    restoreEnv(saved);
  }
});

test('W409n #4 — canonical row shape carries input+output AND prompt+completion', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    await seedNamespace('w409n-shape', 6, { workflow_id: 'wf', trace_id: 'tr' });
    const ws = await import('../src/dataset-workbench.js');
    const ds = await ws.createDataset('w409n-shape');
    const out = await ws.exportDataset(ds.dataset_id, 'jsonl', {
      out: path.join(tmp, 'shape.jsonl'),
    });
    const text = fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(text.length > 0, 'export produced no rows');
    for (const ln of text) {
      const r = JSON.parse(ln);
      // canonical row shape
      assert.equal(typeof r.event_id, 'string', 'row.event_id missing');
      assert.equal(typeof r.input, 'string', 'row.input missing');
      assert.equal(typeof r.output, 'string', 'row.output missing');
      // HF mirror
      assert.equal(r.prompt, r.input, 'prompt must mirror input');
      assert.equal(r.completion, r.output, 'completion must mirror output');
      // workflow + trace plumbed through
      assert.equal(typeof r.workflow_id, 'string', 'workflow_id missing');
      assert.equal(typeof r.trace_id, 'string', 'trace_id missing');
      assert.ok(Array.isArray(r.tool_calls), 'tool_calls must be an array');
    }
  } finally {
    restoreEnv(saved);
  }
});

test('W409n #5 — multimodal media field round-trips through canonical row', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    await seedNamespace('w409n-mm', 4, { media_kind: 'image' });
    const ws = await import('../src/dataset-workbench.js');
    const ds = await ws.createDataset('w409n-mm');
    const out = await ws.exportDataset(ds.dataset_id, 'jsonl', {
      out: path.join(tmp, 'mm.jsonl'),
    });
    const rows = fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.ok(r.media, 'media object missing on multimodal row');
      assert.equal(r.media.kind, 'image');
      assert.ok(typeof r.media.uri === 'string', 'media.uri missing');
      assert.ok(typeof r.media.hash === 'string', 'media.hash missing');
      assert.ok(typeof r.media.bytes === 'number', 'media.bytes missing');
    }
  } finally {
    restoreEnv(saved);
  }
});

test('W409n #6 — seeds.jsonl export+import round-trip', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    await seedNamespace('w409n-seeds', 5);
    const ws = await import('../src/dataset-workbench.js');
    const ds = await ws.createDataset('w409n-seeds');
    const seedsPath = path.join(tmp, 'export-seeds.jsonl');
    await ws.exportDataset(ds.dataset_id, 'seeds', { out: seedsPath });
    const lines = fs.readFileSync(seedsPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 0, 'seeds export produced no rows');
    for (const ln of lines) {
      const r = JSON.parse(ln);
      assert.ok(r.id, 'seed row missing id');
      assert.ok(r.input, 'seed row missing input');
      assert.ok(r.output, 'seed row missing output');
    }
    // Import the exported seeds into a fresh namespace.
    const r = await ws.importSeedsJsonl(seedsPath, {
      namespace: 'w409n-seeds-reimport',
      createDataset: true,
      autoApprove: true,
      sourceType: 'synthetic',
    });
    assert.ok(r.imported >= 1, 'import did not bring any rows in');
    assert.ok(r.dataset_id, 'import was asked to create a dataset and did not');
  } finally {
    restoreEnv(saved);
  }
});

test('W409n #7 — dataset_create CLI surface accepts --from-namespace --seed --approved-only', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    await seedNamespace('w409n-cli', 12);
    const ws = await import('../src/dataset-workbench.js');
    const { listEvents } = await import('../src/event-store.js');
    const evs = await listEvents({ namespace: 'w409n-cli', limit: 50 });
    // Approve first 6.
    for (let i = 0; i < 6; i++) await ws.approveEvent(evs[i].event_id, { reviewer: 'cli-user' });
    // Same call shape the CLI uses for `kolm dataset create --from-namespace w409n-cli --seed 13 --approved-only`.
    const ds = await ws.createDataset(undefined, {
      fromNamespace: 'w409n-cli',
      seed: 13,
      approvedOnly: true,
    });
    assert.equal(ds.approved_only, true);
    assert.equal(ds.seed, 13);
    assert.ok(ds.dataset_id.startsWith('ds_'));
  } finally {
    restoreEnv(saved);
  }
});

// ---------------- W409o: human labeling --------------------------------

test('W409o #1 — submitLabel persists reviewer identity + decided_at on the label file', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    const evIds = await seedNamespace('w409o-rev', 4);
    const lq = await import('../src/label-queue.js');
    const r = await lq.submitLabel(evIds[0], { verdict: 'good', reviewer: 'alice' });
    assert.equal(r.label.reviewer, 'alice', 'reviewer must persist on label record');
    assert.ok(r.label.labeled_at, 'labeled_at missing');
    assert.equal(r.label.verdict, 'good');
    // Audit trail entry in approvals.jsonl carries reviewer too.
    const af = kolmDir(tmp, 'labels', 'approvals.jsonl');
    const lines = fs.readFileSync(af, 'utf8').trim().split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.reviewer, 'alice', 'approvals.jsonl row must carry reviewer');
    assert.ok(last.decided_at, 'approvals.jsonl row must carry decided_at');
  } finally {
    restoreEnv(saved);
  }
});

test('W409o #2 — full audit trail captured (every decision appended, not last-write-wins)', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    const evIds = await seedNamespace('w409o-audit', 4);
    const lq = await import('../src/label-queue.js');
    const ws = await import('../src/dataset-workbench.js');
    // Reviewer alice rejects, then bob comes in and approves, then carol edits.
    await lq.submitLabel(evIds[0], { verdict: 'bad', reviewer: 'alice', reason: 'noisy' });
    await lq.submitLabel(evIds[0], { verdict: 'good', reviewer: 'bob' });
    await lq.submitLabel(evIds[0], { verdict: 'edit', reviewer: 'carol', fixedOutput: 'category_corrected' });
    const trail = ws.loadAuditTrail(evIds[0]);
    assert.equal(trail.length, 3, 'audit trail must contain all 3 decisions');
    assert.equal(trail[0].reviewer, 'alice');
    assert.equal(trail[1].reviewer, 'bob');
    assert.equal(trail[2].reviewer, 'carol');
    // Audit before/after on the LAST (edit) row
    const last = trail[2];
    assert.ok(last.audit, 'edit row must record audit object');
    // After bob approved, prior_reviewer for carol should be bob.
    assert.equal(last.audit.prior_reviewer, 'bob', 'audit must record prior_reviewer');
    assert.ok(last.audit.after_output, 'after_output must be set on edit row');
    assert.equal(last.fixed_output, 'category_corrected');
  } finally {
    restoreEnv(saved);
  }
});

test('W409o #3 — team_approval flag + co_reviewers persist on label record', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    const evIds = await seedNamespace('w409o-team', 2);
    const lq = await import('../src/label-queue.js');
    const r = await lq.submitLabel(evIds[0], {
      verdict: 'good',
      reviewer: 'alice',
      teamApproval: true,
      coReviewers: ['bob', 'carol'],
    });
    assert.equal(r.label.team_approval, true);
    assert.deepEqual(r.label.co_reviewers, ['bob', 'carol']);
    // co_reviewers_seen accumulates as reviewers come in.
    assert.ok(Array.isArray(r.label.co_reviewers_seen));
    assert.ok(r.label.co_reviewers_seen.includes('alice'));
    assert.ok(r.label.co_reviewers_seen.includes('bob'));
    assert.ok(r.label.co_reviewers_seen.includes('carol'));
  } finally {
    restoreEnv(saved);
  }
});

test('W409o #4 — /v1/label-queue/* aliases work via in-process Express router', async () => {
  const saved = { ...snapEnv(), ADMIN_KEY: process.env.ADMIN_KEY };
  const tmp = mkTmp();
  setEnv(tmp);
  // Use the admin-key bypass so we don't need to provision a tenant for this
  // route-level smoke test. The authMiddleware accepts ADMIN_KEY-bearer
  // requests and sets req.tenant='demo' + req.is_admin=true.
  process.env.ADMIN_KEY = 'w409nop-test-admin-' + Date.now();
  try {
    const evIds = await seedNamespace('w409o-routes', 3);
    const express = await import('express');
    const { buildRouter } = await import('../src/router.js');
    const app = express.default();
    app.use(express.default.json());
    app.use(buildRouter());
    const http = await import('node:http');
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const authHeader = { 'Authorization': 'Bearer ' + process.env.ADMIN_KEY };

    const fetchJson = async (url, opts = {}) => {
      const res = await fetch('http://127.0.0.1:' + port + url, {
        ...opts,
        headers: { ...(opts.headers || {}), ...authHeader },
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, body };
    };

    // /v1/label-queue/next - returns the first undecided event (top-level prompt/response shape).
    const next = await fetchJson('/v1/label-queue/next?namespace=w409o-routes');
    assert.equal(next.status, 200, 'next status ' + next.status + ' body=' + JSON.stringify(next.body).slice(0, 200));
    assert.ok(next.body && next.body.event_id, 'next must return an event with event_id (got: ' + JSON.stringify(next.body).slice(0, 200) + ')');

    // /v1/label-queue/submit - legacy "accept" maps to good.
    const sub = await fetchJson('/v1/label-queue/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: evIds[0], label: 'accept', reviewer: 'route-user' }),
    });
    assert.equal(sub.status, 200, 'submit status=' + sub.status + ' body=' + JSON.stringify(sub.body).slice(0, 200));
    // The submit response carries the label record + approval row. The exact
    // shape depends on which alias handler matched first — we just need to
    // see verdict=good somewhere recognizable.
    const subVerdict = (sub.body.label && sub.body.label.verdict) || sub.body.verdict || (sub.body.approval && sub.body.approval.decision);
    assert.ok(['good', 'approve'].includes(subVerdict), 'accept must map to good/approve, got: ' + subVerdict);
    const subReviewer = (sub.body.label && sub.body.label.reviewer) || sub.body.reviewer || (sub.body.approval && sub.body.approval.reviewer);
    assert.equal(subReviewer, 'route-user');

    // /v1/label-queue/submit - legacy "correct" maps to edit with fixed_output.
    const sub2 = await fetchJson('/v1/label-queue/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: evIds[1], label: 'correct', fixed_output: 'better', reviewer: 'r2' }),
    });
    assert.equal(sub2.status, 200);
    const sub2Verdict = (sub2.body.label && sub2.body.label.verdict) || sub2.body.verdict;
    assert.equal(sub2Verdict, 'edit');
    const sub2Fixed = (sub2.body.label && sub2.body.label.fixed_output) || sub2.body.fixed_output || (sub2.body.approval && sub2.body.approval.fixed_output);
    assert.equal(sub2Fixed, 'better');

    // /v1/label-queue/audit/:event_id - returns the trail. Two handlers exist
    // (earlier returns {audit:[]}, later returns {trail:[]}); accept either.
    const aud = await fetchJson('/v1/label-queue/audit/' + evIds[0]);
    assert.equal(aud.status, 200);
    const trail = aud.body.audit || aud.body.trail;
    assert.ok(Array.isArray(trail), 'audit response must include an array (got keys: ' + Object.keys(aud.body).join(',') + ')');
    assert.ok(trail.length >= 1, 'audit trail must include the submitted decision');
    assert.equal(aud.body.event_id, evIds[0]);

    // /v1/label-queue/stats - reports counts.
    const stats = await fetchJson('/v1/label-queue/stats');
    assert.equal(stats.status, 200);
    // canonical "approved" or legacy "accepted"
    const approved = stats.body.approved != null ? stats.body.approved : stats.body.accepted;
    assert.equal(typeof approved, 'number');
    assert.equal(typeof stats.body.pending, 'number');

    await new Promise((resolve) => server.close(resolve));
  } finally {
    restoreEnv(saved);
  }
});

test('W409o #5 — approve / reject / edit all record audit with before+after outputs', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    const evIds = await seedNamespace('w409o-beforeafter', 3);
    const ws = await import('../src/dataset-workbench.js');
    await ws.approveEvent(evIds[0], { reviewer: 'a' });
    const t1 = ws.loadAuditTrail(evIds[0]);
    assert.equal(t1.length, 1);
    assert.ok(t1[0].audit && t1[0].audit.before_output, 'approve must record before_output');
    assert.equal(t1[0].audit.after_output, t1[0].audit.before_output, 'approve without fixed_output -> after=before');

    await ws.rejectEvent(evIds[0], { reviewer: 'b', reason: 'noise' });
    const t2 = ws.loadAuditTrail(evIds[0]);
    assert.equal(t2.length, 2);
    assert.equal(t2[1].decision, 'reject');
    assert.equal(t2[1].audit.prior_decision, 'approve', 'reject row must remember prior decision');

    await ws.editEvent(evIds[0], 'corrected_answer', { reviewer: 'c' });
    const t3 = ws.loadAuditTrail(evIds[0]);
    assert.equal(t3.length, 3);
    assert.equal(t3[2].fixed_output, 'corrected_answer');
    assert.equal(t3[2].audit.after_output, 'corrected_answer');
  } finally {
    restoreEnv(saved);
  }
});

// ---------------- W409p: bakeoffs ---------------------------------------

test('W409p #1 — bakeoff row exposes quality/cost/latency/privacy/determinism columns', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    await seedNamespace('w409p-cols', 8);
    const ws = await import('../src/dataset-workbench.js');
    const ds = await ws.createDataset('w409p-cols');
    const { bakeoff } = await import('../src/bakeoff.js');
    const result = await bakeoff(ds.dataset_id, {
      contestants: ['cache', 'rule', 'prompt_only', 'gemma-3n-e2b', 'claude-haiku-4-5'],
      opts: { stubModel: true },
    });
    assert.ok(Array.isArray(result.contestants), 'contestants must be an array');
    assert.ok(result.contestants.length >= 1, 'bakeoff returned no contestant rows');
    for (const c of result.contestants) {
      assert.equal(typeof c.name, 'string', 'contestant.name missing');
      assert.equal(typeof c.quality, 'number', 'contestant.quality missing');
      assert.equal(typeof c.pass_rate, 'number', 'contestant.pass_rate missing');
      assert.equal(typeof c.avg_latency_ms, 'number', 'contestant.avg_latency_ms missing');
      assert.equal(typeof c.avg_cost_usd, 'number', 'contestant.avg_cost_usd missing');
      assert.ok(['public', 'local', 'frontier', 'byo-vendor', 'unknown'].includes(c.privacy_class),
        'privacy_class must come from the closed set, got: ' + c.privacy_class);
      assert.equal(typeof c.deterministic, 'boolean', 'deterministic must be boolean');
    }
    // The columns descriptor is also returned for downstream UI.
    assert.ok(Array.isArray(result.columns) && result.columns.includes('privacy_class'));
    assert.ok(result.columns.includes('deterministic'));
  } finally {
    restoreEnv(saved);
  }
});

test('W409p #2 — recommendation field is one of the closed enum', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    await seedNamespace('w409p-enum', 12);
    const ws = await import('../src/dataset-workbench.js');
    const ds = await ws.createDataset('w409p-enum');
    const { bakeoff, RECOMMENDATION_VERDICTS } = await import('../src/bakeoff.js');
    const result = await bakeoff(ds.dataset_id, {
      contestants: ['cache', 'rule', 'gemma-3n-e2b', 'claude-haiku-4-5'],
      opts: { stubModel: true },
    });
    assert.ok(RECOMMENDATION_VERDICTS.includes(result.recommendation),
      'recommendation must be one of ' + RECOMMENDATION_VERDICTS.join('|') + ', got: ' + result.recommendation);
    assert.equal(result.recommendation, result.recommendation_verdict, 'aliases must agree');
  } finally {
    restoreEnv(saved);
  }
});

test('W409p #3 — recommendationVerdict returns keep_frontier when only frontier clears the gate', async () => {
  // Direct unit test against the verdict function: easier than coaxing the
  // stubbed bakeoff into a deterministic threshold.
  const { recommendationVerdict } = await import('../src/bakeoff.js');
  const contestants = [
    { name: 'cache', pass_rate: 0.0, privacy_class: 'public' },
    { name: 'rule', pass_rate: 0.2, privacy_class: 'public' },
    { name: 'claude-haiku-4-5', pass_rate: 0.92, privacy_class: 'frontier' },
  ];
  assert.equal(recommendationVerdict(contestants, 'claude-haiku-4-5'), 'keep_frontier');
});

test('W409p #4 — recommendationVerdict returns distill when a local sits close to frontier', async () => {
  const { recommendationVerdict } = await import('../src/bakeoff.js');
  const contestants = [
    { name: 'cache', pass_rate: 0.0, privacy_class: 'public' },
    { name: 'rule', pass_rate: 0.3, privacy_class: 'public' },
    { name: 'phi-mini', pass_rate: 0.74, privacy_class: 'local' },
    { name: 'claude-haiku-4-5', pass_rate: 0.92, privacy_class: 'frontier' },
  ];
  // Frontier won the gate (>=0.85) and a local exists at >=0.7 -> distill.
  assert.equal(recommendationVerdict(contestants, 'claude-haiku-4-5'), 'distill');
});

test('W409p #4b — recommendationVerdict returns use_local_backbone when local wins the gate', async () => {
  const { recommendationVerdict } = await import('../src/bakeoff.js');
  const contestants = [
    { name: 'cache', pass_rate: 0.0, privacy_class: 'public' },
    { name: 'rule', pass_rate: 0.3, privacy_class: 'public' },
    { name: 'phi-mini', pass_rate: 0.93, privacy_class: 'local' },
    { name: 'claude-haiku-4-5', pass_rate: 0.85, privacy_class: 'frontier' },
  ];
  // Local cleared the gate -> use_local_backbone.
  assert.equal(recommendationVerdict(contestants, 'phi-mini'), 'use_local_backbone');
});

test('W409p #4c — recommendationVerdict returns compile_rule when rule wins the gate', async () => {
  const { recommendationVerdict } = await import('../src/bakeoff.js');
  const contestants = [
    { name: 'cache', pass_rate: 0.0, privacy_class: 'public' },
    { name: 'rule', pass_rate: 0.95, privacy_class: 'public' },
    { name: 'claude-haiku-4-5', pass_rate: 0.4, privacy_class: 'frontier' },
  ];
  // Rule cleared the gate -> compile_rule.
  assert.equal(recommendationVerdict(contestants, 'rule'), 'compile_rule');
});

test('W409p #5 — bakeoff returns needs_human when nothing clears the gate', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    // Use tiny custom rows where outputs don't match any keyword pattern
    // - cache never hits (no cacheKeys), rule's tokens are unrelated.
    const customRows = [
      { input: 'aaa', output: 'XYZ' },
      { input: 'bbb', output: 'PDQ' },
      { input: 'ccc', output: 'QQR' },
      { input: 'ddd', output: 'STU' },
      { input: 'eee', output: 'VVW' },
    ];
    const { bakeoff } = await import('../src/bakeoff.js');
    const result = await bakeoff(customRows, {
      contestants: ['cache', 'rule'],  // nothing intelligent.
      opts: { stubModel: true },
    });
    assert.equal(result.recommendation, 'needs_human',
      'when nothing clears 0.85 -> needs_human; got: ' + result.recommendation);
  } finally {
    restoreEnv(saved);
  }
});

test('W409p #6 — bakeoff JSON envelope carries dataset_id, rows_used, created_at', async () => {
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    await seedNamespace('w409p-envelope', 6);
    const ws = await import('../src/dataset-workbench.js');
    const ds = await ws.createDataset('w409p-envelope');
    const { bakeoff } = await import('../src/bakeoff.js');
    const r = await bakeoff(ds.dataset_id, {
      contestants: ['cache', 'rule'],
      opts: { stubModel: true },
    });
    assert.equal(r.dataset_id, ds.dataset_id, 'envelope must carry dataset_id');
    assert.equal(typeof r.rows_used, 'number');
    assert.ok(r.rows_used >= 1);
    assert.ok(r.created_at, 'envelope must carry created_at');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(r.created_at), 'created_at must be ISO');
  } finally {
    restoreEnv(saved);
  }
});

// ---------------- W409c coordination (approved-only pipeline guard) -------

test('W409c-coord — compile-pipeline createDataset honors approvedOnly opt', async () => {
  // We don't run the full pipeline here (heavy); we just assert that the
  // approved-only filter flows through createDataset to the resulting record.
  const saved = snapEnv();
  const tmp = mkTmp();
  setEnv(tmp);
  try {
    const evIds = await seedNamespace('w409c-coord', 9);
    const ws = await import('../src/dataset-workbench.js');
    // Approve only the first 3.
    for (let i = 0; i < 3; i++) await ws.approveEvent(evIds[i], { reviewer: 'pipeline-user' });
    const ds = await ws.createDataset('w409c-coord', { approvedOnly: true, seed: 21 });
    // Source must equal exactly the 3 approved IDs.
    const record = JSON.parse(fs.readFileSync(kolmDir(tmp, 'datasets', ds.dataset_id + '.json'), 'utf8'));
    assert.equal(record.source_event_ids.length, 3, 'approvedOnly must yield exactly the approved rows');
    for (const id of record.source_event_ids) {
      assert.ok(evIds.slice(0, 3).includes(id), 'leaked non-approved id ' + id);
    }
  } finally {
    restoreEnv(saved);
  }
});
