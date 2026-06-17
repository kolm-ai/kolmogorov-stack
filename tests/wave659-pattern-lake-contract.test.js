// W659 - direct contract for src/pattern-lake.js.
//
// Focus: opt-in-before-write, hash-only persistence, privacy floor, bounded
// input, and read-side sanitization of corrupted contribution rows.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LAKE_ENABLED_ENV,
  aggregatePatterns,
  contributePattern,
  isOptedIn,
  optIn,
  optOut,
  tokenizePattern,
} from '../src/pattern-lake.js';
import { appendEvent, listEvents, _resetForTests } from '../src/event-store.js';

const PROVIDER_CONTRIBUTION = 'kolm_pattern_lake_contribution';
const HEX64_RE = /^[a-f0-9]{64}$/;

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function rowsText(rows) {
  return JSON.stringify(rows);
}

function contributionRows() {
  return listEvents({ provider: PROVIDER_CONTRIBUTION, limit: 0 });
}

function freshLake(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w659-pattern-lake-'));
  const oldDataDir = process.env.KOLM_DATA_DIR;
  const oldDriver = process.env.KOLM_EVENT_STORE_DRIVER;
  const oldEnabled = process.env[LAKE_ENABLED_ENV];

  process.env.KOLM_DATA_DIR = dir;
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  delete process.env[LAKE_ENABLED_ENV];
  _resetForTests();

  t.after(() => {
    _resetForTests();
    if (oldDataDir == null) delete process.env.KOLM_DATA_DIR;
    else process.env.KOLM_DATA_DIR = oldDataDir;
    if (oldDriver == null) delete process.env.KOLM_EVENT_STORE_DRIVER;
    else process.env.KOLM_EVENT_STORE_DRIVER = oldDriver;
    if (oldEnabled == null) delete process.env[LAKE_ENABLED_ENV];
    else process.env[LAKE_ENABLED_ENV] = oldEnabled;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('W659 pattern tokenization emits sha256 bigrams only', () => {
  const hashes = tokenizePattern('Alpha beta, beta gamma.');
  assert.equal(hashes.length, 3);
  for (const h of hashes) assert.match(h, HEX64_RE);
  assert.equal(rowsText(hashes).includes('alpha'), false);
  assert.equal(rowsText(hashes).includes('beta'), false);
});

test('W659 contributions do not write when disabled or namespace is not opted in', async (t) => {
  freshLake(t);

  const disabled = await contributePattern({
    tenant_id: 'tenant-a',
    namespace: 'support',
    consent: true,
    capture: { id: 'cap-1', input: 'secret alpha beta' },
  });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error, 'lake_disabled');
  assert.equal((await contributionRows()).length, 0);

  process.env[LAKE_ENABLED_ENV] = '1';
  const notOpted = await contributePattern({
    tenant_id: 'tenant-a',
    namespace: 'support',
    consent: true,
    capture: { id: 'cap-1', input: 'secret alpha beta' },
  });
  assert.equal(notOpted.ok, false);
  assert.equal(notOpted.error, 'namespace_not_opted_in');
  const rows = await contributionRows();
  assert.equal(rows.length, 0);
  assert.equal(rowsText(rows).includes('secret alpha beta'), false);
});

test('W659 opted-in contribution is hash-only, idempotent, and bounded', async (t) => {
  freshLake(t);
  process.env[LAKE_ENABLED_ENV] = '1';

  await optIn(' tenant-a ', ' support ');
  assert.equal(await isOptedIn('tenant-a', 'support'), true);

  const first = await contributePattern({
    tenant_id: 'tenant-a',
    namespace: 'support',
    consent: true,
    capture: { id: 42, input: 'Secret Alpha Beta Gamma' },
  });
  assert.equal(first.ok, true);
  assert.equal(first.capture_id, '42');
  assert.equal(first.bigram_count, 3);

  const rows = await contributionRows();
  assert.equal(rows.length, 1);
  assert.equal(rowsText(rows).includes('Secret Alpha Beta Gamma'), false);
  assert.equal(rowsText(rows).includes('secret'), false);
  const payload = JSON.parse(rows[0].feedback);
  assert.equal(payload.namespace, 'support');
  assert.equal(payload.capture_id, '42');
  assert.equal(payload.bigram_hashes.length, 3);
  for (const h of payload.bigram_hashes) assert.match(h, HEX64_RE);

  const dupe = await contributePattern({
    tenant_id: 'tenant-a',
    namespace: 'support',
    consent: true,
    capture: { id: 42, input: 'different raw text should not be re-hashed' },
  });
  assert.equal(dupe.ok, true);
  assert.equal(dupe.skipped, true);
  assert.equal((await contributionRows()).length, 1);

  const tooSmall = await contributePattern({
    tenant_id: 'tenant-a',
    namespace: 'support',
    consent: true,
    capture: { id: 'cap-single', input: 'solitary' },
  });
  assert.equal(tooSmall.ok, false);
  assert.equal(tooSmall.error, 'insufficient_pattern_signal');

  const tooLarge = await contributePattern({
    tenant_id: 'tenant-a',
    namespace: 'support',
    consent: true,
    capture: { id: 'cap-large', input: 'x'.repeat(200001) },
  });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.error, 'pattern_input_too_large');
  assert.equal((await contributionRows()).length, 1);
});

test('W659 aggregation enforces floor and drops opted-out rows', async (t) => {
  freshLake(t);
  process.env[LAKE_ENABLED_ENV] = '1';

  for (let i = 0; i < 5; i += 1) {
    const tenant = `tenant-${i}`;
    await optIn(tenant, 'support-legal');
    const r = await contributePattern({
      tenant_id: tenant,
      namespace: 'support-legal',
      consent: true,
      capture: { id: `cap-${i}`, input: 'alpha beta gamma alpha beta' },
    });
    assert.equal(r.ok, true);
  }

  const agg = await aggregatePatterns({ min_contributors: 5, vertical: 'support', k_top: 10 });
  assert.equal(agg.ok, true);
  assert.equal(agg.n_contributors, 5);
  assert.ok(agg.top_bigram_hashes.length >= 3);
  for (const row of agg.top_bigram_hashes) assert.match(row.hash, HEX64_RE);
  assert.ok(agg.top_bigram_hashes.some((row) => row.count === 5));

  await optOut('tenant-4', 'support-legal');
  const afterOptOut = await aggregatePatterns({ min_contributors: 5, vertical: 'support', k_top: 10 });
  assert.equal(afterOptOut.ok, false);
  assert.equal(afterOptOut.error, 'insufficient_contributors');
  assert.equal(afterOptOut.have, 4);
});

test('W659 read path sanitizes corrupted raw-looking hashes before aggregate output', async (t) => {
  freshLake(t);
  process.env[LAKE_ENABLED_ENV] = '1';
  const validHash = sha256Hex('safe|bigram');

  for (let i = 0; i < 5; i += 1) {
    const tenant = `corrupt-${i}`;
    await optIn(tenant, 'support-corrupt');
    await appendEvent({
      tenant_id: tenant,
      namespace: 'kolm_pattern_lake',
      provider: PROVIDER_CONTRIBUTION,
      status: 'ok',
      feedback: JSON.stringify({
        capture_id: `bad-${i}`,
        namespace: 'support-corrupt',
        bigram_hashes: [`raw secret ${i}`, validHash, validHash.toUpperCase()],
      }),
    });
  }

  const agg = await aggregatePatterns({ min_contributors: 5, vertical: 'support', k_top: 10 });
  assert.equal(agg.ok, true);
  assert.equal(agg.n_contributors, 5);
  assert.deepEqual(agg.top_bigram_hashes, [{ hash: validHash, count: 5 }]);
  assert.equal(rowsText(agg).includes('raw secret'), false);
});
