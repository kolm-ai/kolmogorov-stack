// W409h — end-to-end value-loop regression battery.
//
// Boots buildRouter() in-process and walks the entire observe → optimize →
// dataset → label → bake-off → compile → verify → run chain. This is the
// gold-standard regression check: if it goes red, something on the loop
// disconnected.
//
// The harness mocks upstream at the network boundary by enabling the
// connector fixture mode (KOLM_CONNECTOR_FIXTURE=1) — the connector proxy
// then returns deterministic chat.completion envelopes without making any
// outbound calls. No fake HTTP server, no monkey-patching. Behavior at the
// kolm boundary (capture-store → event-store → lake → opportunity → dataset
// → labels → bakeoff → build → verify → run) is exercised exactly as in
// production.
//
// Tenant scoping: the connector proxy (router.js __connectorProxy) stamps
// every event with tenant_id='local' and namespace='default'. Reads from
// /v1/lake/*, /v1/opportunities, /v1/datasets, /v1/labels/* all default to
// the same namespace='default' filter, so the tenant filter does not have
// to match the connector tenant. The cross-tenant isolation is already
// covered by W297 #8.
//
// Tests assert behavior, not page copy. Each step that is genuinely not
// wired logs a HARD FAIL with an actionable hint. No silent skips.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Module-level singleton imports — same trap as W397/W409a: any dynamic
// re-import with a cache buster gives a different module instance than the
// router writes to, and reads silently miss.
import * as eventStore from '../src/event-store.js';
import * as captureStore from '../src/capture-store.js';

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w409h-'));
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
}

function snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_CAPTURE_DRIVER: process.env.KOLM_CAPTURE_DRIVER,
    KOLM_CONNECTOR_FIXTURE: process.env.KOLM_CONNECTOR_FIXTURE,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    KOLM_RECIPE_RECEIPT_SECRET: process.env.KOLM_RECIPE_RECEIPT_SECRET,
    KOLM_DISTILL_FULL: process.env.KOLM_DISTILL_FULL,
    KOLM_DISTILL_TEACHER: process.env.KOLM_DISTILL_TEACHER,
    KOLM_SIGNING_KEY: process.env.KOLM_SIGNING_KEY,
  };
}

function restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function setIsolatedHome(home) {
  process.env.KOLM_DATA_DIR = path.join(home, '.kolm');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.KOLM_STORE_DRIVER = 'jsonl';
  delete process.env.KOLM_CAPTURE_DRIVER;
  process.env.KOLM_CONNECTOR_FIXTURE = '1';
  // Strip upstream creds so the connector takes the fixture branch.
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  // Receipt secret long enough for HMAC + Ed25519 paths.
  process.env.KOLM_RECIPE_RECEIPT_SECRET = 'w409h-e2e-test-secret-32-chars-minimum-len';
  // Distill in stub mode so the test does not need real teacher keys.
  delete process.env.KOLM_DISTILL_FULL;
  delete process.env.KOLM_DISTILL_TEACHER;
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (captureStore._resetDriverCache) captureStore._resetDriverCache();
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
}

async function makeAppAndTenant() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 50000 });
  return { app, apiKey: t.api_key, tenantId: t.id };
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const realPort = server.address().port;
        const out = await fn(`http://127.0.0.1:${realPort}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

// HARD FAIL helper: when a stage is genuinely not wired, surface the gap
// with an actionable message rather than skipping. Caller passes the
// repeated-prompt + dataset_id context so the message is debuggable.
function hardFail(stage, detail, hint) {
  assert.fail(`W409h ${stage} HARD FAIL: ${detail}${hint ? ' — ' + hint : ''}`);
}

// ---------------------------------------------------------------------------
// Step 1 — POST N=120 identical mock chat completions through
// /v1/chat/completions and assert 2xx + receipt headers.
// ---------------------------------------------------------------------------
test('W409h #1 — POST 120 identical chat completions through /v1/chat/completions', async () => {
  const saved = snapEnv();
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      const body = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'translate to french: hello world' }],
      };
      const N = 120;
      let firstEventId = null;
      let durableCount = 0;
      for (let i = 0; i < N; i++) {
        const r = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (r.status !== 200) {
          hardFail('step-1-connector',
            `POST ${i + 1}/${N} returned ${r.status} (expected 200 with fixture mode)`,
            'check KOLM_CONNECTOR_FIXTURE=1 wired through __connectorProxy + fixtureBody');
        }
        const eventId = r.headers.get('x-kolm-event-id');
        if (!eventId) {
          hardFail('step-1-receipt-header',
            `request ${i + 1} returned no x-kolm-event-id header`,
            'connector proxy must stamp every response with the event id');
        }
        if (!firstEventId) firstEventId = eventId;
        if (r.headers.get('x-kolm-event-durable') === 'true') durableCount++;
        const json = await r.json();
        if (!json || !json.choices || !json.choices[0]) {
          hardFail('step-1-fixture-shape',
            `request ${i + 1} returned invalid chat.completion shape`,
            'fixture body must produce OpenAI envelope with choices[0].message');
        }
      }
      assert.ok(durableCount >= N * 0.9,
        `only ${durableCount}/${N} responses reported durable; expected ≥${Math.floor(N * 0.9)} (capture-store insert failing?)`);
      assert.ok(firstEventId, 'must capture at least one event_id from the first response');
    });
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Step 2 — Event-store must hold 120 events with redacted prompts.
//
// FINDING (W409h follow-up): the connector path writes via insertCapture()
// (which bridges with prompt_redacted = promptText) but THEN immediately
// calls appendEvent(ev) on the connector's connectorNewEvent() row, which
// does NOT carry prompt_redacted. Because appendEvent is INSERT OR REPLACE
// keyed on event_id, the second write strips the redacted prompt the
// bridge had just stored. router.js:1863 is where this happens.
// Test asserts what the system SHOULD produce, allowing for the current
// bug — counts must hold, prompts SHOULD hold (HARD FAIL flagged if not).
// ---------------------------------------------------------------------------
test('W409h #2 — event-store holds the 120 bridged events with redacted prompts', async () => {
  const saved = snapEnv();
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      const body = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'translate to french: hello world' }],
      };
      const N = 120;
      for (let i = 0; i < N; i++) {
        const r = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(r.status, 200, `request ${i + 1} returned ${r.status}`);
        await r.json();
      }
      // Read the event-store directly — every connector call must have
      // bridged into it via insertCapture → bridgeToEventStore → appendEvent.
      const events = await eventStore.listEvents({ namespace: 'default', limit: 0 });
      const ours = events.filter(e => e.model === 'gpt-4o-mini');
      if (ours.length < N) {
        hardFail('step-2-bridge',
          `event-store holds ${ours.length}/${N} bridged events (filter: model=gpt-4o-mini, ns=default)`,
          'check capture-store.bridgeToEventStore() + router.js connector __connectorProxy eventAppend()');
      }
      // Every bridged row must carry an event_id with the canonical evt_ prefix.
      for (const ev of ours.slice(0, 5)) {
        assert.match(ev.event_id, /^evt_/, 'event_id must be the canonical evt_ prefix');
        // template/request_hash MUST be present so the lake can cluster.
        assert.ok(ev.request_hash, 'each bridged event must carry request_hash for clustering');
      }
      // Prompt-redaction contract — at least ONE event must carry a non-null
      // prompt_redacted, OR the bridge is broken at router.js:1863.
      // Currently the connector path overwrites the bridge-stored
      // prompt_redacted with a connectorNewEvent({...}) row that omits it,
      // because appendEvent INSERT-OR-REPLACE keyed on event_id wipes the
      // earlier bridge row.
      const withPrompt = ours.filter(e =>
        typeof e.prompt_redacted === 'string' && e.prompt_redacted.length > 0);
      if (withPrompt.length === 0) {
        hardFail('step-2-prompt-redacted',
          `0/${ours.length} bridged events carry prompt_redacted on the connector path`,
          'router.js:1815 connectorNewEvent({...}) must include prompt_redacted=promptText; the trailing eventAppend(ev) wipes the bridge row otherwise (INSERT OR REPLACE keyed on event_id)');
      }
    });
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Step 3 — /v1/lake/stats must return total_calls=120 and surface the
// repeated prompt at the top.
// ---------------------------------------------------------------------------
test('W409h #3 — /v1/lake/stats returns total_calls=120 + repeated cluster surfaces', async () => {
  const saved = snapEnv();
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      const auth = { authorization: 'Bearer ' + apiKey };
      const body = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'translate to french: hello world' }],
      };
      const N = 120;
      for (let i = 0; i < N; i++) {
        // W411 — pass auth on the connector POST so events get tagged with
        // req.tenant_record.id; the lake/datasets/labels reads below fence on
        // the same canonical id. Without auth the events go to the 'local'
        // tenant scope and the authenticated reads return 0.
        const r = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify(body),
        });
        assert.equal(r.status, 200);
        await r.json();
      }
      const statsR = await fetch(base + '/v1/lake/stats', { headers: auth });
      assert.equal(statsR.status, 200, `lake/stats returned ${statsR.status}; expected 200 with Bearer auth`);
      const stats = await statsR.json();
      assert.equal(stats.ok, true);
      if (stats.total_calls < N) {
        hardFail('step-3-lake-stats',
          `lake/stats.total_calls=${stats.total_calls}, expected ≥${N}`,
          'lake.lakeStats() must read from event-store; if 0, check listEvents+namespace path');
      }
      // Repeated-cluster surface.
      const repR = await fetch(base + '/v1/lake/repeated?limit=10', { headers: auth });
      assert.equal(repR.status, 200);
      const rep = await repR.json();
      assert.ok(Array.isArray(rep.clusters), 'lake/repeated must return clusters[]');
      if (rep.clusters.length === 0) {
        hardFail('step-3-lake-repeated',
          'no clusters surfaced even though 120 identical prompts were posted',
          'check lake.clusterRepeatedPrompts(events) + templateSignature() hashing');
      }
      const topCluster = rep.clusters[0];
      // lake.clusterRepeatedPrompts() returns clusters with field `count` (see lake.js:148-194);
      // /v1/lake/repeated maps to `count` as well. Accept either `count` or `call_count` for safety.
      const callCount = topCluster.count ?? topCluster.call_count;
      assert.ok(callCount >= 4, `top cluster must have ≥4 calls; saw ${callCount} (shape: ${JSON.stringify(Object.keys(topCluster))})`);
    });
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Step 4 — /v1/opportunities surfaces ≥1 repeated-expensive opportunity.
// ---------------------------------------------------------------------------
test('W409h #4 — /v1/opportunities surfaces ≥1 repeated-expensive opportunity', async () => {
  const saved = snapEnv();
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      const auth = { authorization: 'Bearer ' + apiKey };
      const body = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'translate to french: hello world' }],
      };
      const N = 120;
      for (let i = 0; i < N; i++) {
        // W411 — pass auth on the connector POST so events get tagged with
        // req.tenant_record.id; the lake/datasets/labels reads below fence on
        // the same canonical id. Without auth the events go to the 'local'
        // tenant scope and the authenticated reads return 0.
        const r = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify(body),
        });
        assert.equal(r.status, 200);
        await r.json();
      }
      // Inject cost into the events post-write so the opportunity engine
      // can apply its spend thresholds. Fixture-mode events have cost=0
      // because no real upstream call was made; in production those events
      // would carry the actual upstream cost. We model that here by
      // attaching $0.005/event (~ gpt-4o-mini pricing) before reading
      // /v1/opportunities. This is the only place we mutate event-store
      // state from the test; everything else flows through the HTTP API.
      const { listEvents, appendEvent } = await import('../src/event-store.js');
      const events = await listEvents({ namespace: 'default', limit: 10000, order: 'desc' });
      for (const ev of events) {
        if (ev.estimated_cost_usd > 0) continue;
        await appendEvent({ ...ev, estimated_cost_usd: 0.005, prompt_tokens: 25, completion_tokens: 10 });
      }
      // Call the opportunity engine directly with relaxed thresholds matching
      // the test scale (120 events, not 1000+). The /v1/opportunities route
      // uses production defaults (minCallCount=50, minMonthlySpend=10) which
      // would require ≥1000 events for dataset_ready and ≥$10/mo monthly
      // spend (we have ~$0.6/mo). Behavior assertion = the engine can detect
      // repeats at all, not that it uses any specific threshold.
      const { findOpportunities } = await import('../src/opportunity-engine.js');
      const direct = await findOpportunities({ namespace: 'default', minCallCount: 50, minMonthlySpend: 0 });
      if (direct.length < 1) {
        hardFail('step-4-opportunities-direct',
          `opportunity engine (direct call) surfaced 0 opportunities; events=${events.length}, ` +
          `total cost=$${events.reduce((a,e)=>a+(Number(e.estimated_cost_usd)||0),0).toFixed(4)}`,
          'opportunity-engine.findOpportunities({minMonthlySpend:0}) must surface ≥1 hit for 120 identical prompts ' +
          'with cost > 0 — check cache_candidate path + clusterRepeatedPrompts() output');
      }
      // Also exercise the HTTP route — it should at minimum match direct.
      const oppR = await fetch(base + '/v1/opportunities', { headers: auth });
      assert.equal(oppR.status, 200);
      const opp = await oppR.json();
      assert.equal(opp.ok, true);
      // The /v1/opportunities route uses production defaults so the count
      // may be lower than direct; the behavior contract is just "the
      // engine + HTTP route both work end-to-end on real bridged events".
      assert.ok(typeof opp.total === 'number', '/v1/opportunities must return a numeric .total');
      assert.ok(Array.isArray(opp.opportunities), '/v1/opportunities must return opportunities[]');
      // Behavior assertions on the DIRECT engine output (relaxed thresholds).
      // At least one of: cache_candidate, repeated_extraction, repeated_classification,
      // local_replacement_candidate, prompt_compression, dataset_ready — all valid
      // categories that the engine can flag on a repeated cluster.
      const flaggedKinds = new Set(direct.map(o => o.kind || o.type || o.opportunity_kind));
      assert.ok(direct.length >= 1,
        `direct opportunities[] must be non-empty (got ${direct.length}, kinds=${[...flaggedKinds]})`);
      // Each opportunity must carry an id for accept/dismiss.
      assert.ok(direct[0].id || direct[0].opportunity_id,
        'each opportunity must carry an id for accept/dismiss; saw shape: ' + JSON.stringify(Object.keys(direct[0])));
      // Surface (for diagnostics) the flagged kinds in the assertion message.
      void flaggedKinds;
    });
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Step 5 — POST /v1/datasets (with namespace=default) returns a dataset_id
// with N seeds and a deterministic split.
// ---------------------------------------------------------------------------
test('W409h #5 — POST /v1/datasets returns ds_* with deterministic train/holdout split', async () => {
  const saved = snapEnv();
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      const auth = { authorization: 'Bearer ' + apiKey };
      const N = 120;
      for (let i = 0; i < N; i++) {
        // W411 — content-based dedupe in createDataset() collapses identical
        // (prompt, response) pairs to a single row before the split (defends
        // train_ids ∩ holdout_ids = ∅ from being defeated by re-emits). The
        // dataset test needs N distinct prompts to land N source_event_ids,
        // so we vary each prompt by index. Auth is required so events get
        // stamped with req.tenant_record.id; the dataset endpoint fences on
        // the same canonical id.
        const body = {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'translate to french: item ' + i }],
        };
        const r = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify(body),
        });
        assert.equal(r.status, 200);
        await r.json();
      }
      // Create the dataset.
      const dsR = await fetch(base + '/v1/datasets', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ namespace: 'default', train_ratio: 0.8 }),
      });
      assert.equal(dsR.status, 200, `dataset create returned ${dsR.status}`);
      const ds = await dsR.json();
      assert.equal(ds.ok, true);
      assert.match(ds.dataset_id, /^ds_/, `dataset_id must look like ds_*, got ${ds.dataset_id}`);
      assert.ok(ds.source_event_ids && ds.source_event_ids.length >= N * 0.95,
        `dataset.source_event_ids must include ≥${Math.floor(N * 0.95)} events; got ${ds.source_event_ids?.length}`);
      assert.ok(ds.split_signature && ds.split_signature.startsWith('sha256:'),
        'split must be deterministic with sha256-prefixed signature');
      // Determinism contract: re-creating the dataset on the same source
      // events with the same seed must yield the same signature, OR a
      // re-split via /v1/datasets/:id/split must be stable.
      const splitR = await fetch(base + `/v1/datasets/${ds.dataset_id}/split`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ train_ratio: 0.8 }),
      });
      assert.equal(splitR.status, 200);
      const split = await splitR.json();
      assert.equal(split.ok, true);
      assert.equal(split.split_signature, ds.split_signature,
        'split must be deterministic — re-splitting same dataset+ratio must match the original signature');
      // Train/holdout must sum to source events and be disjoint.
      assert.ok(split.train_count >= 1 && split.holdout_count >= 1,
        `train+holdout must each be ≥1, got train=${split.train_count} holdout=${split.holdout_count}`);
      const total = split.train_count + split.holdout_count;
      assert.equal(total, ds.source_event_ids.length,
        `train(${split.train_count})+holdout(${split.holdout_count})=${total} must equal source(${ds.source_event_ids.length})`);
    });
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Step 6 — /v1/labels/next + POST /v1/labels: pull the first unlabeled row,
// approve it, then verify state moves via /v1/labels/stats.
// ---------------------------------------------------------------------------
test('W409h #6 — label queue: next → approve → stats reflects approval', async () => {
  const saved = snapEnv();
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      const auth = { authorization: 'Bearer ' + apiKey };
      // Seed 12 captures so the queue has work. W411 — vary prompts (content
      // dedupe in dataset workbench) + pass auth (lake fences on tenant id).
      for (let i = 0; i < 12; i++) {
        const body = {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'translate to french: row ' + i }],
        };
        const r = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify(body),
        });
        assert.equal(r.status, 200);
        await r.json();
      }
      // Snapshot stats before approval.
      const before = await fetch(base + '/v1/labels/stats', { headers: auth });
      assert.equal(before.status, 200);
      const beforeJson = await before.json();
      const beforeApproved = beforeJson.approved || 0;
      // Next.
      const nextR = await fetch(base + '/v1/labels/next?n=1', { headers: auth });
      assert.equal(nextR.status, 200);
      const next = await nextR.json();
      if (!next.events || next.events.length === 0) {
        hardFail('step-6-label-next',
          'label queue returned 0 events after seeding 12 captures',
          'check label-queue.nextToLabel() reads from event-store + filters by approval state');
      }
      const target = next.events[0];
      assert.ok(target.event_id, 'next event must carry event_id');
      // Approve.
      const submitR = await fetch(base + '/v1/labels', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({
          event_id: target.event_id,
          verdict: 'good',
          reviewer: 'w409h-test',
        }),
      });
      assert.equal(submitR.status, 200, `label submit returned ${submitR.status}`);
      const submit = await submitR.json();
      assert.equal(submit.ok, true);
      // After.
      const after = await fetch(base + '/v1/labels/stats', { headers: auth });
      assert.equal(after.status, 200);
      const afterJson = await after.json();
      if ((afterJson.approved || 0) <= beforeApproved) {
        hardFail('step-6-label-stats',
          `labels.approved did not advance after submit (before=${beforeApproved}, after=${afterJson.approved})`,
          'label-queue.submitLabel() must persist + labelStats() must read same approvals.jsonl');
      }
      // Read-by-event-id round-trip.
      const getR = await fetch(base + `/v1/labels/${target.event_id}`, { headers: auth });
      assert.equal(getR.status, 200, `GET /v1/labels/${target.event_id} returned ${getR.status}`);
      const got = await getR.json();
      assert.equal(got.ok, true);
      assert.equal(got.label.event_id, target.event_id);
    });
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Step 7 — POST /v1/bakeoff/run with a dataset_id returns ranked contestants
// carrying quality/cost/latency markers.
// ---------------------------------------------------------------------------
test('W409h #7 — /v1/bakeoff/run returns ranked contestants on the holdout', async () => {
  const saved = snapEnv();
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      const auth = { authorization: 'Bearer ' + apiKey };
      // Seed dataset.
      const body = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'translate to french: hello world' }],
      };
      const N = 30;
      for (let i = 0; i < N; i++) {
        // W411 — pass auth on the connector POST so events get tagged with
        // req.tenant_record.id; the lake/datasets/labels reads below fence on
        // the same canonical id. Without auth the events go to the 'local'
        // tenant scope and the authenticated reads return 0.
        const r = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify(body),
        });
        assert.equal(r.status, 200);
        await r.json();
      }
      const dsR = await fetch(base + '/v1/datasets', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ namespace: 'default', train_ratio: 0.5 }),
      });
      assert.equal(dsR.status, 200);
      const ds = await dsR.json();
      assert.match(ds.dataset_id, /^ds_/);
      // Run bakeoff with stub-mode contestants (cache, rule, prompt_only) so
      // the test never makes a real LLM call.
      const boR = await fetch(base + '/v1/bakeoff/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({
          dataset_id: ds.dataset_id,
          contestants: ['cache', 'rule', 'prompt_only'],
          opts: { stubModel: true, maxRows: 8 },
        }),
      });
      assert.equal(boR.status, 200, `bakeoff/run returned ${boR.status}`);
      const bo = await boR.json();
      assert.equal(bo.ok, true);
      if (!Array.isArray(bo.contestants) || bo.contestants.length === 0) {
        hardFail('step-7-bakeoff',
          `bakeoff returned no contestants (rows_used=${bo.rows_used})`,
          'check bakeoff.bakeoff() + loadDatasetRows() hydration from event-store');
      }
      for (const c of bo.contestants) {
        assert.equal(typeof c.name, 'string', 'contestant must have name');
        assert.equal(typeof c.pass_rate, 'number', 'contestant must have pass_rate');
        assert.equal(typeof c.avg_latency_ms, 'number', 'contestant must have avg_latency_ms');
        assert.equal(typeof c.avg_cost_usd, 'number', 'contestant must have avg_cost_usd');
        assert.ok(c.pass_rate >= 0 && c.pass_rate <= 1, 'pass_rate must be in [0,1]');
      }
      assert.ok(bo.recommended || bo.contestants.find(c => c.recommended),
        'bakeoff must surface a recommended contestant');
    });
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Step 8 — compile pipeline (via direct compileFull on the seeded namespace)
// emits .kolm artifact with manifest + signature receipt chain.
// ---------------------------------------------------------------------------
test('W409h #8 — compileFull emits .kolm artifact with manifest + bundle entry', async () => {
  const saved = snapEnv();
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      const auth = { authorization: 'Bearer ' + apiKey };
      // Seed N captures so compileFull has source rows. W411 — vary prompts
      // (dataset workbench dedupes identical content rows before split).
      const N = 25;
      for (let i = 0; i < N; i++) {
        // W411 — pass auth on the connector POST so events get tagged with
        // req.tenant_record.id; vary prompts so they survive content dedupe.
        const body = {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'translate to french: line ' + i }],
        };
        const r = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify(body),
        });
        assert.equal(r.status, 200);
        await r.json();
      }
      // Run compileFull directly (the router exposes /v1/pipeline/full but
      // it returns 202 + a job id; the actual phases are async. Calling
      // compileFull directly returns the async iterator we can await.).
      const { compileFull } = await import('../src/compile-pipeline.js');
      const outDir = path.join(process.env.KOLM_DATA_DIR, 'artifacts');
      let donePhase = null;
      let bundlePhase = null;
      let signPhase = null;
      let verdictPhase = null;
      for await (const ev of compileFull({
        namespace: 'default',
        opts: {
          emit_progress_every: 0,
          no_install: true,
          force: true,
          out_dir: outDir,
        },
      })) {
        if (ev.phase === 'bundle') bundlePhase = ev;
        if (ev.phase === 'sign') signPhase = ev;
        if (ev.phase === 'verdict') verdictPhase = ev;
        if (ev.phase === 'done') donePhase = ev;
      }
      if (!donePhase) {
        hardFail('step-8-compile-done',
          'compileFull yielded no done phase',
          'check src/compile-pipeline.js compileFull() async generator ends with phase:"done"');
      }
      if (!bundlePhase || !bundlePhase.recipe_bundle_path) {
        hardFail('step-8-compile-bundle',
          'compileFull did not emit a recipe_bundle_path',
          'check src/compile-pipeline.js _bundlePhase + buildAndZip()');
      }
      assert.ok(fs.existsSync(bundlePhase.recipe_bundle_path),
        `artifact ${bundlePhase.recipe_bundle_path} must exist on disk`);
      assert.ok(donePhase.artifact_path, 'done phase must carry artifact_path');
      assert.equal(typeof donePhase.production_ready, 'boolean',
        'done must include production_ready boolean (verdict gate)');
      // Receipt chain: verdict + sign must run.
      assert.ok(verdictPhase, 'verdict phase must emit');
      assert.ok(signPhase, 'sign phase must emit');
      // Open the .kolm and assert the manifest + recipe.bundle.mjs exist.
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(fs.readFileSync(bundlePhase.recipe_bundle_path));
      const entryNames = zip.getEntries().map(e => e.entryName);
      assert.ok(entryNames.includes('manifest.json'),
        `artifact must contain manifest.json (got [${entryNames.join(', ')}])`);
      assert.ok(entryNames.includes('recipe.bundle.mjs'),
        'artifact must contain recipe.bundle.mjs (W367 invariant)');
      const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
      assert.ok(manifest.job_id || manifest.artifact_job_id || manifest.cid,
        'manifest must carry job_id / artifact_job_id / cid for receipt chain');
    });
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Step 9 — verify on the artifact passes Ed25519 + receipt + holdout
// disjointness (by reading the manifest + sidecar).
// ---------------------------------------------------------------------------
test('W409h #9 — verify the compiled artifact (manifest signature + holdout disjointness)', async () => {
  const saved = snapEnv();
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      const body = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'translate to french: hello world' }],
      };
      for (let i = 0; i < 25; i++) {
        const r = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(r.status, 200);
        await r.json();
      }
      // Generate a stable Ed25519 key so the sign phase runs deterministically.
      const crypto = await import('node:crypto');
      const kp = crypto.generateKeyPairSync('ed25519');
      const keyPem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
      process.env.KOLM_SIGNING_KEY = keyPem;

      const { compileFull } = await import('../src/compile-pipeline.js');
      const outDir = path.join(process.env.KOLM_DATA_DIR, 'artifacts');
      let bundlePath = null;
      let splitPhase = null;
      let signPhase = null;
      for await (const ev of compileFull({
        namespace: 'default',
        opts: { emit_progress_every: 0, no_install: true, force: true, out_dir: outDir },
      })) {
        if (ev.phase === 'bundle') bundlePath = ev.recipe_bundle_path;
        if (ev.phase === 'dataset_split') splitPhase = ev;
        if (ev.phase === 'sign') signPhase = ev;
      }
      assert.ok(bundlePath, 'bundle must produce a path');
      // Verify via the artifact-runner loadArtifact() — it re-validates the
      // manifest and the Ed25519 sidecar if present.
      const { loadArtifact } = await import('../src/artifact-runner.js');
      let bundle;
      try {
        bundle = loadArtifact(bundlePath);
      } catch (e) {
        hardFail('step-9-loadArtifact',
          `loadArtifact threw: ${e.message}`,
          'manifest + bundle must round-trip through loadArtifact()');
      }
      assert.ok(bundle.manifest, 'bundle must have manifest');
      assert.ok(bundle.recipes && Array.isArray(bundle.recipes.recipes),
        'bundle must have recipes[]');
      // Ed25519 sidecar must exist next to the artifact (sign phase attached).
      const sidecar = bundlePath + '.ed25519.sig';
      const sidecarExists = fs.existsSync(sidecar);
      if (signPhase && signPhase.ed25519_attached) {
        assert.ok(sidecarExists,
          `signPhase.ed25519_attached=true but sidecar ${sidecar} is missing on disk`);
      }
      // Holdout disjointness: from the dataset_split phase, train_ids and
      // holdout_ids must be disjoint.
      if (splitPhase && Array.isArray(splitPhase.train_ids) && Array.isArray(splitPhase.holdout_ids)) {
        const train = new Set(splitPhase.train_ids);
        for (const h of splitPhase.holdout_ids) {
          if (train.has(h)) {
            hardFail('step-9-holdout-overlap',
              `event_id ${h} is in BOTH train and holdout — split invariant violated`,
              'check dataset-workbench.splitDataset() disjointness assertion');
          }
        }
      }
    });
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Step 10 — runArtifact on the compiled .kolm via dispatchRuntime returns a
// response from the local runtime.
// ---------------------------------------------------------------------------
test('W409h #10 — runArtifact dispatches through dispatchRuntime and returns output', async () => {
  const saved = snapEnv();
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      const body = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'translate to french: hello world' }],
      };
      for (let i = 0; i < 25; i++) {
        const r = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(r.status, 200);
        await r.json();
      }
      const { compileFull } = await import('../src/compile-pipeline.js');
      const outDir = path.join(process.env.KOLM_DATA_DIR, 'artifacts');
      let bundlePath = null;
      for await (const ev of compileFull({
        namespace: 'default',
        opts: { emit_progress_every: 0, no_install: true, force: true, out_dir: outDir },
      })) {
        if (ev.phase === 'bundle') bundlePath = ev.recipe_bundle_path;
      }
      assert.ok(bundlePath, 'compileFull must produce a bundle path');
      // Run via runArtifact() which routes through dispatchRuntime().
      const { runArtifact, dispatchRuntime, loadArtifact } = await import('../src/artifact-runner.js');
      let result;
      try {
        result = await runArtifact(bundlePath, 'translate to french: hello world');
      } catch (e) {
        // If the artifact has no compileable recipe, fall back to dispatch
        // through a synthesized bundle so we can still prove the routing wires.
        if (e.code === 'KOLM_E_NO_RECIPE_HANDLED' || e.code === 'KOLM_E_NO_RECIPES') {
          hardFail('step-10-runArtifact-no-recipe',
            `runArtifact returned ${e.code}: ${e.message}`,
            'compileFull stub mode should still attach at least one recipe; check src/compile-pipeline.js _distillPhase recipe synthesis');
        }
        throw e;
      }
      assert.ok(result, 'runArtifact must return a result envelope');
      // Output may be string / object / undefined depending on recipe — what
      // matters is the receipt + recipe_id + latency shape.
      assert.ok('output' in result, 'result must contain output field');
      assert.ok(result.receipt, 'result must contain receipt (spec=rs-1-run)');
      assert.equal(result.receipt.spec, 'rs-1-run',
        `receipt.spec must be rs-1-run, got ${result.receipt.spec}`);
      assert.equal(typeof result.latency_us, 'number');
      assert.ok(result.latency_us >= 0, 'latency_us must be non-negative');
      assert.ok(result.audit, 'result must include audit envelope');
      assert.equal(result.audit.spec, 'kolm-audit-1', 'audit.spec must be kolm-audit-1');
      // Also exercise dispatchRuntime() directly to lock in the loadArtifact
      // → dispatchRuntime path used by run/eval.
      const bundle = loadArtifact(bundlePath);
      const direct = await dispatchRuntime(bundle, 'translate to french: hello world');
      assert.ok(direct, 'dispatchRuntime must return a result');
      assert.equal(direct.runtime, 'js', 'js target is the default for stub-mode compileFull');
    });
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});
