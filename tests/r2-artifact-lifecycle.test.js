// R-2 — artifact lifecycle state machine tests.
//
// Pins:
//   1. Valid path: created -> signed -> deployed -> superseded -> archived
//      (5 transitions, each appended to history in chronological order).
//   2. Invalid transition (created -> revoked) is rejected with a clear error.
//   3. Revoking an artifact flips canPull() to false AND makes the download
//      route return HTTP 410 Gone with {error:'artifact_revoked', reason}.
//   4. History is append-only and chronologically ordered.
//   5. Missing actor / missing reason on revoke / missing successor on
//      supersede are rejected (constraints from the spec).
//   6. GET /v1/artifacts/:id/lifecycle returns current_state + history.
//   7. POST /v1/artifacts/:id/lifecycle/transition validates the move
//      against VALID_TRANSITIONS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Isolate data dir so we never touch a developer's real ~/.kolm during tests.
const TEST_DATA_DIR = path.join(os.tmpdir(), 'kolm-r2-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.KOLM_DATA_DIR = TEST_DATA_DIR;
process.env.KOLM_HOME = TEST_DATA_DIR;
process.env.HOME = TEST_DATA_DIR;
process.env.USERPROFILE = TEST_DATA_DIR;

const lc = await import('../src/artifact-lifecycle.js');

function _freshId(prefix = 'r2') {
  return prefix + '_' + crypto.randomBytes(4).toString('hex');
}

// =============================================================================
// 1) Valid path: created -> signed -> deployed -> superseded -> archived
// =============================================================================

test('R2 #1 — valid 5-step path created->signed->deployed->superseded->archived', () => {
  const id = _freshId('valid');
  let rec = lc.loadOrInit(id);
  assert.equal(rec.current_state, 'created');
  assert.equal(rec.history.length, 0);

  // Step 1: created -> signed
  lc.transition(rec, 'signed', { actor: 'tenant_abc', reason: 'compile_complete' });
  assert.equal(rec.current_state, 'signed');
  assert.equal(rec.history.length, 1);

  // Step 2: signed -> deployed
  lc.transition(rec, 'deployed', { actor: 'tenant_abc', evidence_id: 'prod-ns', reason: 'cli_deploy' });
  assert.equal(rec.current_state, 'deployed');
  assert.equal(rec.history.length, 2);

  // Step 3: deployed -> monitored
  lc.transition(rec, 'monitored', { actor: 'system', reason: 'monitor_enabled' });
  assert.equal(rec.current_state, 'monitored');
  assert.equal(rec.history.length, 3);

  // Step 4: monitored -> superseded (needs successor_id)
  const successor = _freshId('next');
  lc.transition(rec, 'superseded', { actor: 'tenant_abc', successor_id: successor, reason: 'newer_artifact' });
  assert.equal(rec.current_state, 'superseded');
  assert.equal(rec.history.length, 4);
  assert.equal(rec.history[3].successor_id, successor);

  // Step 5: superseded -> archived
  lc.transition(rec, 'archived', { actor: 'system', reason: 'retention_complete' });
  assert.equal(rec.current_state, 'archived');
  assert.equal(rec.history.length, 5);

  // History order matches walk order.
  const states = rec.history.map((h) => h.to);
  assert.deepEqual(states, ['signed', 'deployed', 'monitored', 'superseded', 'archived']);

  // Every entry has a timestamp + non-empty actor + valid from/to.
  for (const h of rec.history) {
    assert.ok(h.timestamp && typeof h.timestamp === 'string');
    assert.ok(h.actor && h.actor.length > 0);
    assert.ok(typeof h.from === 'string' && typeof h.to === 'string');
  }

  // Persisted to disk; readLifecycle returns the same record.
  const reloaded = lc.readLifecycle(id);
  assert.equal(reloaded.current_state, 'archived');
  assert.equal(reloaded.history.length, 5);
});

// =============================================================================
// 2) Invalid transition: created -> revoked is rejected
// =============================================================================

test('R2 #2 — invalid transition created->revoked is rejected', () => {
  const id = _freshId('invalid');
  let rec = lc.loadOrInit(id);
  assert.throws(
    () => lc.transition(rec, 'revoked', { actor: 'tenant_abc', reason: 'compromised' }),
    /invalid transition: created -> revoked not permitted/,
    'created -> revoked must be rejected',
  );
  // State must be unchanged.
  assert.equal(rec.current_state, 'created');
  assert.equal(rec.history.length, 0);
  // Disk record must not have been written.
  assert.equal(lc.readLifecycle(id), null);
});

// =============================================================================
// 3) Revoked artifact: canPull returns false AND pull endpoint returns 410
// =============================================================================

test('R2 #3 — canPull() returns true for non-revoked states, false for revoked', () => {
  // Synthetic in-memory records (no disk).
  assert.equal(lc.canPull({ current_state: 'created' }), true);
  assert.equal(lc.canPull({ current_state: 'signed' }), true);
  assert.equal(lc.canPull({ current_state: 'deployed' }), true);
  assert.equal(lc.canPull({ current_state: 'monitored' }), true);
  assert.equal(lc.canPull({ current_state: 'superseded' }), true);
  assert.equal(lc.canPull({ current_state: 'archived' }), true);
  // Only revoked blocks the pull.
  assert.equal(lc.canPull({ current_state: 'revoked' }), false);
});

test('R2 #3b — pull endpoint returns 410 Gone for revoked artifact', async () => {
  // We need a real completed job in the store so /v1/artifacts/:id/download
  // gets past the readiness checks. Provision a tenant, insert a fake job
  // record, then stamp the lifecycle to revoked and hit the download path.
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const http = await import('node:http');
  const { provisionTenant } = await import('../src/auth.js');
  const { buildRouter } = await import('../src/router.js');
  const store = await import('../src/store.js');

  const tenant = provisionTenant('r2-revoke-' + crypto.randomBytes(3).toString('hex'));
  const apiKey = tenant.api_key;

  // Create a synthetic completed compile job. We need artifact_path to point
  // at a real file so the readiness checks pass (otherwise the route returns
  // 410 for a missing file, which would mask the lifecycle 410 we want to
  // assert).
  const jobId = 'job_' + crypto.randomBytes(6).toString('hex');
  const artifactFile = path.join(TEST_DATA_DIR, jobId + '.kolm');
  fs.writeFileSync(artifactFile, Buffer.from('PK\x03\x04 fake .kolm payload'));
  // Compile jobs live in the `compile_jobs` table (see src/compile.js getJob).
  // The router gates lookups by req.tenant which authMiddleware sets to
  // tenant.name (not tenant.id), so the row's `tenant` field must use the
  // name to match.
  store.insert('compile_jobs', {
    id: jobId,
    tenant: tenant.name,
    task: 'r2 revoke smoke',
    status: 'completed',
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    artifact_path: artifactFile,
    artifact_bytes: fs.statSync(artifactFile).size,
  });

  // Stamp lifecycle to revoked. We walk through the legal path
  // signed -> deployed -> revoked so the transition table accepts it.
  let rec = lc.loadOrInit(jobId);
  lc.transition(rec, 'signed', { actor: tenant.id, reason: 'fixture_setup' });
  lc.transition(rec, 'deployed', { actor: tenant.id, reason: 'fixture_setup' });
  lc.transition(rec, 'revoked', { actor: tenant.id, reason: 'compromised_key_rotated' });
  assert.equal(rec.current_state, 'revoked');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser());
  app.use(buildRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/artifacts/${jobId}/download`, {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    assert.equal(res.status, 410, 'download must return 410 Gone for revoked artifact');
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'artifact_revoked');
    assert.equal(body.reason, 'compromised_key_rotated', 'revoke reason surfaced in response body');
    assert.ok(body.revoked_at && typeof body.revoked_at === 'string');
    assert.equal(body.actor, tenant.id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// =============================================================================
// 4) History preserves chronological order
// =============================================================================

test('R2 #4 — history is append-only and chronologically ordered', async () => {
  const id = _freshId('hist');
  let rec = lc.loadOrInit(id);
  lc.transition(rec, 'signed', { actor: 'system', reason: 'step_1' });
  // Tiny sleep so the timestamps are guaranteed distinct (ISO millisecond
  // resolution is enough on Linux/Mac, but Windows Date.now() can have a
  // 15ms tick — give the clock enough room to advance).
  await new Promise((r) => setTimeout(r, 20));
  lc.transition(rec, 'deployed', { actor: 'system', reason: 'step_2' });
  await new Promise((r) => setTimeout(r, 20));
  lc.transition(rec, 'monitored', { actor: 'system', reason: 'step_3' });
  assert.equal(rec.history.length, 3);
  // Strict <= because the same tick should never produce out-of-order rows.
  for (let i = 1; i < rec.history.length; i++) {
    assert.ok(
      rec.history[i - 1].timestamp <= rec.history[i].timestamp,
      'history entry ' + i + ' must not predate entry ' + (i - 1),
    );
  }
  // from/to chain forms a contiguous walk.
  for (let i = 1; i < rec.history.length; i++) {
    assert.equal(rec.history[i].from, rec.history[i - 1].to,
      'history entry ' + i + ' from must match prior to');
  }
});

// =============================================================================
// 5) Required-field guards (actor / revoke reason / supersede successor)
// =============================================================================

test('R2 #5a — missing actor is rejected', () => {
  const id = _freshId('noactor');
  let rec = lc.loadOrInit(id);
  assert.throws(() => lc.transition(rec, 'signed', { reason: 'no actor here' }),
    /actor is required/, 'no actor must be rejected');
  assert.throws(() => lc.transition(rec, 'signed', { actor: '', reason: 'empty actor' }),
    /actor is required/, 'empty actor must be rejected');
  assert.throws(() => lc.transition(rec, 'signed', { actor: '   ', reason: 'whitespace actor' }),
    /actor is required/, 'whitespace actor must be rejected');
});

test('R2 #5b — revoke requires non-empty reason', () => {
  const id = _freshId('noreason');
  let rec = lc.loadOrInit(id);
  lc.transition(rec, 'signed', { actor: 'tenant_abc', reason: 'setup' });
  lc.transition(rec, 'deployed', { actor: 'tenant_abc', reason: 'setup' });
  assert.throws(() => lc.transition(rec, 'revoked', { actor: 'tenant_abc' }),
    /revoking requires a non-empty reason/);
  assert.throws(() => lc.transition(rec, 'revoked', { actor: 'tenant_abc', reason: '' }),
    /revoking requires a non-empty reason/);
});

test('R2 #5c — supersede requires non-empty successor_id', () => {
  const id = _freshId('nosucc');
  let rec = lc.loadOrInit(id);
  lc.transition(rec, 'signed', { actor: 'tenant_abc', reason: 'setup' });
  lc.transition(rec, 'deployed', { actor: 'tenant_abc', reason: 'setup' });
  assert.throws(() => lc.transition(rec, 'superseded', { actor: 'tenant_abc', reason: 'new model' }),
    /superseding requires a non-empty successor_id/);
});

// =============================================================================
// 6) GET /v1/artifacts/:id/lifecycle
// =============================================================================

test('R2 #6 — GET /v1/artifacts/:id/lifecycle returns current_state + history', async () => {
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const http = await import('node:http');
  const { provisionTenant } = await import('../src/auth.js');
  const { buildRouter } = await import('../src/router.js');

  const tenant = provisionTenant('r2-get-' + crypto.randomBytes(3).toString('hex'));
  const apiKey = tenant.api_key;

  const id = _freshId('getep');
  let rec = lc.loadOrInit(id);
  lc.transition(rec, 'signed', { actor: tenant.id, reason: 'compile' });
  lc.transition(rec, 'deployed', { actor: tenant.id, reason: 'deploy', evidence_id: 'prod-ns' });

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser());
  app.use(buildRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/artifacts/${id}/lifecycle`, {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    assert.equal(res.status, 200, 'lifecycle GET should succeed');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.artifact_id, id);
    assert.equal(body.current_state, 'deployed');
    assert.equal(body.history.length, 2);
    assert.equal(body.history[1].evidence_id, 'prod-ns');
    assert.ok(Array.isArray(body.valid_states));
    assert.ok(body.valid_states.includes('archived'));
    assert.ok(body.valid_transitions && body.valid_transitions.deployed.includes('revoked'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// =============================================================================
// 7) POST /v1/artifacts/:id/lifecycle/transition
// =============================================================================

test('R2 #7 — POST /v1/artifacts/:id/lifecycle/transition validates moves', async () => {
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const http = await import('node:http');
  const { provisionTenant } = await import('../src/auth.js');
  const { buildRouter } = await import('../src/router.js');

  const tenant = provisionTenant('r2-post-' + crypto.randomBytes(3).toString('hex'));
  const apiKey = tenant.api_key;

  const id = _freshId('postep');
  // Pre-stamp to 'signed' so the POST has somewhere legal to go.
  let rec = lc.loadOrInit(id);
  lc.transition(rec, 'signed', { actor: tenant.id, reason: 'setup' });

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser());
  app.use(buildRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    // Legal: signed -> deployed
    const legal = await fetch(`http://127.0.0.1:${port}/v1/artifacts/${id}/lifecycle/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ to_state: 'deployed', reason: 'http_deploy', evidence_id: 'http-ns' }),
    });
    assert.equal(legal.status, 200);
    const legalBody = await legal.json();
    assert.equal(legalBody.ok, true);
    assert.equal(legalBody.current_state, 'deployed');

    // Illegal: deployed -> created (not in VALID_TRANSITIONS)
    const illegal = await fetch(`http://127.0.0.1:${port}/v1/artifacts/${id}/lifecycle/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ to_state: 'created', reason: 'rewind' }),
    });
    assert.equal(illegal.status, 400);
    const illegalBody = await illegal.json();
    assert.equal(illegalBody.ok, false);
    assert.equal(illegalBody.error, 'transition_rejected');
    assert.match(illegalBody.detail, /invalid transition/);

    // Missing to_state
    const missing = await fetch(`http://127.0.0.1:${port}/v1/artifacts/${id}/lifecycle/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ reason: 'no state' }),
    });
    assert.equal(missing.status, 400);
    const missingBody = await missing.json();
    assert.equal(missingBody.error, 'missing_to_state');

    // Unauthed request
    const unauthed = await fetch(`http://127.0.0.1:${port}/v1/artifacts/${id}/lifecycle/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to_state: 'monitored', reason: 'no auth' }),
    });
    assert.equal(unauthed.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// =============================================================================
// 8) LIFECYCLE_STATES + VALID_TRANSITIONS are the documented shapes
// =============================================================================

test('R2 #8 — LIFECYCLE_STATES + VALID_TRANSITIONS shape pins', () => {
  assert.deepEqual(lc.LIFECYCLE_STATES, [
    'created', 'signed', 'deployed', 'monitored', 'superseded', 'revoked', 'archived',
  ]);
  // Archived is terminal.
  assert.deepEqual(lc.VALID_TRANSITIONS.archived, []);
  // Revoked can only go to archived.
  assert.deepEqual(lc.VALID_TRANSITIONS.revoked, ['archived']);
  // Created can only go to signed.
  assert.deepEqual(lc.VALID_TRANSITIONS.created, ['signed']);
  // Deployed can fan out to monitored / superseded / revoked / undeployed.
  for (const s of ['monitored', 'superseded', 'revoked', 'undeployed']) {
    assert.ok(lc.VALID_TRANSITIONS.deployed.includes(s),
      'deployed must allow transition to ' + s);
  }
});
