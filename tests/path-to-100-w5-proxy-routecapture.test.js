// W-5 part 3 (Path to 100%) — the proxy capture path is wired to the quarantine.
//
// __connectorProxy's two insertCapture sites now go through routeCaptureWrite
// (the exact module-level helper this test exercises). Default (KOLM_W808_STAGING
// off) = durable passthrough to observations; staging on = quarantine in
// staged_captures; a staging-write failure falls back to the durable write so a
// capture is NEVER dropped.

import { test } from 'node:test';
import assert from 'node:assert';
import { routeCaptureWrite } from '../src/router.js';
import { insertStagedCapture, listStagedCaptures, _resetStagedCapturesForTests } from '../src/store.js';

const T = 'w5proxy_' + process.pid;

test('W-5 proxy: staging OFF => durable passthrough, nothing quarantined', async () => {
  _resetStagedCapturesForTests();
  const written = [];
  const where = await routeCaptureWrite(
    { tenant_id: T, namespace: 'default', prompt: 'hi' },
    { stagingOn: false, insertStaged: insertStagedCapture, insertObservation: async (r) => { written.push(r); } },
  );
  assert.strictEqual(where, 'passthrough');
  assert.strictEqual(written.length, 1, 'the observation is written');
  assert.strictEqual(listStagedCaptures({ tenant_id: T }).length, 0, 'nothing quarantined');
  _resetStagedCapturesForTests();
});

test('W-5 proxy: staging ON => quarantined in staged_captures, NOT in observations', async () => {
  _resetStagedCapturesForTests();
  const written = [];
  const where = await routeCaptureWrite(
    { tenant_id: T, namespace: 'default', prompt: 'secret' },
    { stagingOn: true, insertStaged: insertStagedCapture, insertObservation: async (r) => { written.push(r); } },
  );
  assert.strictEqual(where, 'staged');
  assert.strictEqual(written.length, 0, 'a quarantined capture is NOT written to observations');
  assert.strictEqual(listStagedCaptures({ tenant_id: T }).length, 1, 'one row quarantined');
  _resetStagedCapturesForTests();
});

test('W-5 proxy: a staging-write failure falls back to the durable write (never drop)', async () => {
  const written = [];
  const where = await routeCaptureWrite(
    { tenant_id: T, prompt: 'x' },
    {
      stagingOn: true,
      insertStaged: () => { throw new Error('staging backend down'); },
      insertObservation: async (r) => { written.push(r); },
    },
  );
  assert.strictEqual(where, 'passthrough', 'falls back to passthrough on staging failure');
  assert.strictEqual(written.length, 1, 'the capture is still durably written — never lost');
});
