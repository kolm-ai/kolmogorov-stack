// W-5 part 2 (Path to 100%) — revive the dead capture-quarantine pipeline.
//
// The store had a complete W808 quarantine contract (insertStagedCapture,
// listStagedCaptures, promoteStagedCapture, autoAllowSinceQuarantine) but
// insertStagedCapture had ZERO callers — so for proxy traffic the quarantine was
// dead and the "captures are reviewed before they enter the corpus" SOC2/ISO
// evidence was false. stageOrPassthrough() is the missing call site (gated on
// KOLM_W808_STAGING). This pins the E2 invariant: with staging on, a flagged
// capture is held OUT of observations until an operator promotes it.

import { test } from 'node:test';
import assert from 'node:assert';
import {
  stageOrPassthrough,
  listStagedCaptures,
  promoteStagedCapture,
  _resetStagedCapturesForTests,
} from '../src/store.js';

const T = 'w5b_' + process.pid;

test('W-5 E2: staging disabled = passthrough straight to observations (no regression)', () => {
  _resetStagedCapturesForTests();
  const observed = [];
  const out = stageOrPassthrough({
    row: { tenant_id: T, namespace: 'default', input: 'hi', output: 'yo' },
    stagingEnabled: false,
    insertObservation: (r) => observed.push(r),
  });
  assert.strictEqual(out.staged, false);
  assert.strictEqual(observed.length, 1, 'passthrough writes the observation directly');
  assert.strictEqual(listStagedCaptures({ tenant_id: T }).length, 0, 'nothing quarantined');
});

test('W-5 E2: staging on quarantines a flagged capture OUT of observations until promoted', () => {
  _resetStagedCapturesForTests();
  const observed = [];
  const out = stageOrPassthrough({
    row: { tenant_id: T, namespace: 'default', input: 'secret', output: 'leak?' },
    stagingEnabled: true,
    anomalyFlagged: true,
    anomalyReasons: ['copyright_suspected'],
    insertObservation: (r) => observed.push(r),
  });
  assert.strictEqual(out.staged, true, 'flagged capture is quarantined, not written through');
  assert.strictEqual(observed.length, 0, 'a quarantined capture is NOT yet an observation');
  const pending = listStagedCaptures({ tenant_id: T });
  assert.strictEqual(pending.length, 1, 'exactly one row pending review');
  assert.strictEqual(pending[0].quarantine_state, 'pending');

  // An anomaly-flagged row never auto-promotes (must be reviewed).
  assert.strictEqual(
    promoteStagedCapture(out.row.staged_capture_id, { tenant_id: T, insertObservation: (r) => observed.push(r) }),
    null,
    'a flagged row is never auto-promoted',
  );
  assert.strictEqual(observed.length, 0);

  // After an operator force-promotes (review), it reaches observations exactly once.
  const promoted = promoteStagedCapture(out.row.staged_capture_id, {
    tenant_id: T, force: true, reviewer: 'operator', insertObservation: (r) => observed.push(r),
  });
  assert.ok(promoted && promoted.quarantine_state === 'promoted');
  assert.strictEqual(observed.length, 1, 'after review the capture enters observations exactly once');
  _resetStagedCapturesForTests();
});

test('W-5 E2: staged rows are tenant-fenced', () => {
  _resetStagedCapturesForTests();
  stageOrPassthrough({ row: { tenant_id: T, input: 'a' }, stagingEnabled: true });
  assert.strictEqual(listStagedCaptures({ tenant_id: T }).length, 1);
  assert.strictEqual(listStagedCaptures({ tenant_id: 'w5b_other' }).length, 0, 'another tenant sees none');
  _resetStagedCapturesForTests();
});
