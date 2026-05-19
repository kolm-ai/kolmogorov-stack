// W409t — team learning approval gate.
//
// Audit said: src/team-events.js is "local reviewed-event export, not
// 'everyone trains the shared team database' by default". W409t closes
// that: local events stay private; promotion to a shared team dataset
// requires either an explicit per-event approval or a namespace policy of
// 'auto'. Team artifacts record contributor_hashes, never raw user_ids.
//
// Tests assert behavior:
//   1. Unapproved teammate event is NOT in the exportApprovedForTeam set.
//   2. buildTeamDataset only contains approved events.
//   3. Team artifact metadata has contributor_hashes + zero raw user_id.
//   4. The approval queue surfaces unapproved events.
//   5. contributorHash is deterministic + does NOT reveal the user_id.
//   6. Namespace policy 'never' blocks promotion even with explicit approval.
//   7. Namespace policy 'auto' promotes without per-event approval.
//   8. exportTeamBundle / importTeamBundle round-trips approved-only.
//   9. Inbound bundle with raw user_id payload is rejected.
//  10. Lineage hash binds team-approved event back to local event hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.NODE_ENV = 'test';
// Each test uses its own KOLM_HOME so the file-backed log doesn't leak.
function freshHome(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w409t-${tag}-`));
  process.env.KOLM_HOME = dir;
  return dir;
}

async function freshModule() {
  // Cache-bust the module so each test gets a clean view of the file paths
  // anchored to the freshly-set KOLM_HOME.
  const url = new URL('../src/team-events.js', import.meta.url).href + `?t=${Date.now()}-${Math.random()}`;
  return await import(url);
}

const TEAM = 'w409t';

test('W409t #1 — unapproved teammate event is NOT in exportApprovedForTeam', async () => {
  freshHome('t1');
  const M = await freshModule();
  await M._resetForTest(TEAM);
  await M._resetTeamApprovalForTest(TEAM);
  const e = await M.append(TEAM, {
    kind: 'positive', actor: 'alice', artifact_version: 'v1',
    payload: { input: 'q', output: 'a' },
  });
  // Even after reviewer approval, the local event is NOT in the team-approved
  // set until team-approval lands too.
  await M.setReview(TEAM, { event_hash: e.hash, state: 'approved', reviewer: 'lead' });
  const rows = await M.exportApprovedForTeam(TEAM);
  assert.equal(rows.length, 0, 'reviewer-approved but team-unapproved must NOT promote');
});

test('W409t #2 — buildTeamDataset only contains team-approved events', async () => {
  freshHome('t2');
  const M = await freshModule();
  await M._resetForTest(TEAM);
  await M._resetTeamApprovalForTest(TEAM);

  // Three events from three contributors. Only middle one gets both reviewer
  // + team approval.
  const e1 = await M.append(TEAM, { kind: 'positive', actor: 'alice', artifact_version: 'v1', payload: { input: 'i1', output: 'o1' } });
  const e2 = await M.append(TEAM, { kind: 'positive', actor: 'bob',   artifact_version: 'v1', payload: { input: 'i2', output: 'o2' } });
  const e3 = await M.append(TEAM, { kind: 'positive', actor: 'carol', artifact_version: 'v1', payload: { input: 'i3', output: 'o3' } });

  await M.setReview(TEAM, { event_hash: e1.hash, state: 'approved', reviewer: 'lead' });
  await M.setReview(TEAM, { event_hash: e2.hash, state: 'approved', reviewer: 'lead' });
  await M.setReview(TEAM, { event_hash: e3.hash, state: 'approved', reviewer: 'lead' });

  // Only e2 is team-approved.
  await M.approveForTeam(TEAM, { event_hash: e2.hash, contributor: 'bob@example.com' });

  const ds = await M.buildTeamDataset(TEAM);
  assert.equal(ds.event_count, 1, 'only one row promoted');
  assert.equal(ds.rows.length, 1);
  assert.equal(ds.rows[0].input, 'i2');
  assert.equal(ds.rows[0].output, 'o2');
  // Round-trip stability — same approved set yields same dataset id.
  const ds2 = await M.buildTeamDataset(TEAM);
  assert.equal(ds.dataset_id, ds2.dataset_id);
});

test('W409t #3 — team artifact metadata carries contributor_hashes + ZERO raw user_id', async () => {
  freshHome('t3');
  const M = await freshModule();
  await M._resetForTest(TEAM);
  await M._resetTeamApprovalForTest(TEAM);
  const e = await M.append(TEAM, { kind: 'positive', actor: 'dan', artifact_version: 'v1', payload: { input: 'iX', output: 'oX' } });
  await M.setReview(TEAM, { event_hash: e.hash, state: 'approved', reviewer: 'lead' });
  await M.approveForTeam(TEAM, { event_hash: e.hash, contributor: 'dan@example.com' });

  const ds = await M.buildTeamDataset(TEAM);
  const meta = M.buildTeamArtifactMetadata(ds, { artifact_version: 'v1' });

  // Contributor hash present.
  assert.ok(Array.isArray(meta.contributor_hashes));
  assert.equal(meta.contributor_hashes.length, 1);
  assert.match(meta.contributor_hashes[0], /^[0-9a-f]{32}$/, 'contributor hash is sha256/32-hex');

  // Raw user_id ABSENT.
  const flat = JSON.stringify(meta);
  assert.equal(flat.includes('dan@example.com'), false, 'raw email must not appear in metadata');
  assert.equal(flat.includes('"user_id"'), false, 'user_id key must not appear');
  assert.equal(flat.includes('"user_email"'), false, 'user_email key must not appear');
});

test('W409t #4 — approval queue surfaces unapproved events', async () => {
  freshHome('t4');
  const M = await freshModule();
  await M._resetForTest(TEAM);
  await M._resetTeamApprovalForTest(TEAM);
  const e1 = await M.append(TEAM, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: '1', output: '1' } });
  const e2 = await M.append(TEAM, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: '2', output: '2' } });
  const e3 = await M.append(TEAM, { kind: 'correction', actor: 'a', artifact_version: 'v1', payload: { input: '3', bad_output: 'bad', good_output: 'good' } });

  // Approve one — the other two should remain on the queue.
  await M.approveForTeam(TEAM, { event_hash: e2.hash, contributor: 'a@example.com' });

  const q = await M.listApprovalQueue(TEAM);
  const hashes = q.map(r => r.event_hash);
  assert.equal(q.length, 2, 'two events still pending team approval');
  assert.ok(hashes.includes(e1.hash));
  assert.ok(hashes.includes(e3.hash));
  assert.equal(hashes.includes(e2.hash), false);
});

test('W409t #5 — contributorHash is deterministic and does NOT reveal the user_id', async () => {
  freshHome('t5');
  const M = await freshModule();
  const h1 = M.contributorHash('alice@example.com');
  const h2 = M.contributorHash('alice@example.com');
  assert.equal(h1, h2, 'deterministic');
  assert.match(h1, /^[0-9a-f]{32}$/);
  assert.equal(h1.includes('alice'), false);
  assert.equal(h1.includes('example.com'), false);
  // Salted variant — different output, same determinism within the salt.
  const sh1 = M.contributorHash('alice@example.com', { salt: 'tenant-A' });
  const sh2 = M.contributorHash('alice@example.com', { salt: 'tenant-A' });
  assert.equal(sh1, sh2);
  assert.notEqual(sh1, h1, 'salt changes the hash');
});

test('W409t #6 — namespace policy "never" blocks promotion even with explicit approval', async () => {
  freshHome('t6');
  const M = await freshModule();
  await M._resetForTest(TEAM);
  await M._resetTeamApprovalForTest(TEAM);
  const e = await M.append(TEAM, {
    kind: 'positive', actor: 'a', artifact_version: 'v1',
    payload: { input: 'i', output: 'o', namespace: 'phi/healthcare' },
  });
  await M.setReview(TEAM, { event_hash: e.hash, state: 'approved', reviewer: 'lead' });
  await M.setNamespacePolicy(TEAM, 'phi/healthcare', 'never', { actor: 'admin' });

  // Even attempting per-event approval is blocked.
  await assert.rejects(
    M.approveForTeam(TEAM, { event_hash: e.hash, contributor: 'a@example.com', namespace: 'phi/healthcare' }),
    /never/i,
  );
  const rows = await M.exportApprovedForTeam(TEAM);
  assert.equal(rows.length, 0);
});

test('W409t #7 — namespace policy "auto" promotes without per-event approval', async () => {
  freshHome('t7');
  const M = await freshModule();
  await M._resetForTest(TEAM);
  await M._resetTeamApprovalForTest(TEAM);
  await M.setNamespacePolicy(TEAM, 'public/redaction', 'auto', { actor: 'admin' });
  const e = await M.append(TEAM, {
    kind: 'positive', actor: 'a', artifact_version: 'v1',
    payload: { input: 'iA', output: 'oA', namespace: 'public/redaction' },
  });
  await M.setReview(TEAM, { event_hash: e.hash, state: 'approved', reviewer: 'lead' });
  const rows = await M.exportApprovedForTeam(TEAM);
  assert.equal(rows.length, 1, 'auto-policy event promotes without explicit approval');
  assert.equal(rows[0].promotion_policy, 'auto');
});

test('W409t #8 — exportTeamBundle / importTeamBundle round-trips approved-only', async () => {
  // Source team
  freshHome('t8-src');
  let M = await freshModule();
  const SRC = 'w409t-src';
  await M._resetForTest(SRC);
  await M._resetTeamApprovalForTest(SRC);
  const e1 = await M.append(SRC, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'ix', output: 'ox' } });
  const e2 = await M.append(SRC, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'iy', output: 'oy' } });
  await M.setReview(SRC, { event_hash: e1.hash, state: 'approved', reviewer: 'lead' });
  await M.setReview(SRC, { event_hash: e2.hash, state: 'approved', reviewer: 'lead' });
  await M.approveForTeam(SRC, { event_hash: e1.hash, contributor: 'a@example.com' });
  // e2 NOT team-approved → should NOT export in approved-only bundle.
  const bundle = await M.exportTeamBundle(SRC, { approved_only: true });
  assert.equal(bundle.events.length, 1);
  assert.equal(bundle.events[0].hash, e1.hash);

  // Destination team (fresh HOME — different file paths)
  freshHome('t8-dst');
  M = await freshModule();
  const DST = 'w409t-dst';
  await M._resetForTest(DST);
  await M._resetTeamApprovalForTest(DST);
  const r = await M.importTeamBundle(DST, bundle);
  assert.equal(r.imported, 1);
  const events = await M.read(DST);
  assert.equal(events.length, 1);
  // Inbound event has the source lineage marker on its payload.
  assert.equal(events[0].payload._imported_from, SRC);
});

test('W409t #9 — inbound bundle with raw user_id payload is rejected', async () => {
  freshHome('t9');
  const M = await freshModule();
  await M._resetForTest(TEAM);
  await M._resetTeamApprovalForTest(TEAM);
  const bad = {
    spec: M.TEAM_EVENTS_VERSION,
    team_id: 'other-team',
    bundle_id: 'bnd_bad',
    events: [
      {
        spec: M.TEAM_EVENTS_VERSION,
        hash: 'deadbeefdeadbeef',
        kind: 'positive', actor: 'x', artifact_version: 'v1',
        payload: { input: 'i', output: 'o', user_id: 'malicious@example.com' },
      },
    ],
    approvals: [],
  };
  await assert.rejects(M.importTeamBundle(TEAM, bad), /user identity|user_id/i);
});

test('W409t #10 — lineage hash binds team-approval back to local event hash', async () => {
  freshHome('t10');
  const M = await freshModule();
  await M._resetForTest(TEAM);
  await M._resetTeamApprovalForTest(TEAM);
  const e = await M.append(TEAM, { kind: 'positive', actor: 'a', artifact_version: 'v1', payload: { input: 'iL', output: 'oL' } });
  await M.setReview(TEAM, { event_hash: e.hash, state: 'approved', reviewer: 'lead' });
  const rec = await M.approveForTeam(TEAM, { event_hash: e.hash, contributor: 'a@example.com' });

  // The lineage_hash must be deterministically derived from event_hash + team.
  const expected = M.lineageHash(e.hash, TEAM);
  assert.equal(rec.lineage_hash, expected);
  // And it must be different from the source event hash.
  assert.notEqual(rec.lineage_hash, e.hash);

  // The dataset row inherits the lineage hash.
  const ds = await M.buildTeamDataset(TEAM);
  assert.equal(ds.rows[0].lineage_hash, expected);
  assert.ok(ds.lineage_hashes.includes(expected));
});

test('W409t #11 — buildTeamArtifactMetadata refuses fields that look like raw user identity', async () => {
  freshHome('t11');
  const M = await freshModule();
  // Construct a malformed dataset that already contains a raw user_id field.
  // The builder must reject — this is the last-mile guard.
  const bad = {
    dataset_id: 'ds_x', team_id: TEAM,
    contributor_hashes: ['aa'.repeat(16)],
    lineage_hashes: ['bb'.repeat(32)],
    event_count: 1,
    user_id: 'should-not-be-here@example.com',
  };
  assert.throws(() => M.buildTeamArtifactMetadata(bad), /user identity|user_id/i);
});
