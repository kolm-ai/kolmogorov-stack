// W637 - Python-less CURATE dedup fallback.
//
// If the optional python semantic dedup tier is unavailable, CURATE must still
// run a deterministic JS embedding-cosine near-dup pass instead of turning the
// stage into a silent no-op.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  curatePairs,
  EMBEDDING_NEAR_DUP_VERSION,
} from '../src/data-curate.js';

function withTempEnv(fn) {
  const oldPython = process.env.KOLM_PYTHON;
  const oldData = process.env.KOLM_DATA_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w637-curate-'));
  process.env.KOLM_PYTHON = 'kolm-python-not-installed-for-w637';
  process.env.KOLM_DATA_DIR = tmp;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (oldPython === undefined) delete process.env.KOLM_PYTHON;
      else process.env.KOLM_PYTHON = oldPython;
      if (oldData === undefined) delete process.env.KOLM_DATA_DIR;
      else process.env.KOLM_DATA_DIR = oldData;
      try { fs.rmSync(tmp, { recursive: true, force: true }); }
      catch (_) { /* Windows can briefly hold SQLite handles open; temp cleanup is best-effort. */ }
    });
}

const nearDupPairs = [
  {
    input: 'Explain how to rotate an API key in the dashboard safely',
    output: 'Open settings, create a replacement key, update clients, and revoke the old key.',
  },
  {
    input: 'Explain how to safely rotate an API key in the dashboard',
    output: 'Open settings, create a replacement key, update clients, and revoke the old key.',
  },
  {
    input: 'Summarize the refund policy for annual invoices',
    output: 'Annual invoices can be refunded within the stated window after billing review.',
  },
];

test('CURATE uses JS embedding near-dup fallback when python dedup is unavailable', async () => {
  await withTempEnv(async () => {
    const res = await curatePairs({
      tenant: 'tenant_w637',
      namespace: 'near-dup-fallback',
      pairs: nearDupPairs.map((p) => ({ ...p })),
      opts: {
        quality: false,
        minhash: false,
        semdedup: false,
        dedup: true,
        cluster: false,
        cot: false,
        pii: false,
        embeddingNearDup: true,
        embeddingNearDupThreshold: 0.93,
      },
    });

    assert.equal(res.ok, true);
    assert.match(res.report.dedup, /^skipped:/);
    assert.ok(res.report.embedding_near_dup, 'fallback report present');
    assert.equal(res.report.embedding_near_dup.version, EMBEDDING_NEAR_DUP_VERSION);
    assert.equal(res.report.embedding_near_dup.backend_used, 'embedding-near-dup-js');
    assert.equal(res.report.embedding_near_dup.threshold, 0.93);
    assert.equal(res.report.embedding_near_dup.n_in, 3);
    assert.equal(res.report.embedding_near_dup.n_kept, 2);
    assert.equal(res.report.embedding_near_dup.n_removed, 1);
    assert.ok(res.report.embedding_near_dup.max_removed_similarity >= 0.93);
    assert.equal(res.n_kept, 2);
    assert.equal(res.report.deduped, 1);
    assert.match(res.report.backend_used, /embedding-near-dup-js/);
  });
});

test('CURATE can explicitly disable the JS near-dup fallback', async () => {
  await withTempEnv(async () => {
    const res = await curatePairs({
      tenant: 'tenant_w637',
      namespace: 'near-dup-fallback-disabled',
      pairs: nearDupPairs.map((p) => ({ ...p })),
      opts: {
        quality: false,
        minhash: false,
        semdedup: false,
        dedup: true,
        cluster: false,
        cot: false,
        pii: false,
        embeddingNearDup: false,
      },
    });

    assert.equal(res.ok, true);
    assert.match(res.report.dedup, /^skipped:/);
    assert.equal(res.report.embedding_near_dup, null);
    assert.equal(res.report.backend_used, 'none');
    assert.equal(res.n_kept, 3);
  });
});
