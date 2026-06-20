// W1035 - /v1/compile hydrates real seed examples from the capture store when
// the UI submits a corpus_namespace without literal examples.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const scratch = path.join(os.tmpdir(), `kolm-w1035-compile-namespace-${process.pid}-${Date.now()}`);
fs.mkdirSync(scratch, { recursive: true });
process.env.KOLM_DATA_DIR = scratch;
process.env.KOLM_RATE_LIMIT_DISABLED = '1';
process.env.KOLM_SYNTH_ENGINE = '0';
process.env.ANTHROPIC_API_KEY = '';
process.env.FAL_KEY = '';
process.env.KOLM_FAL_TOKEN = '';
process.env.RECIPE_RECEIPT_SECRET = 'test-receipt-secret-test-receipt-secret-32';
process.env.NODE_ENV = 'test';

const auth = await import('../src/auth.js');
const store = await import('../src/store.js');
const eventStore = await import('../src/event-store.js');
const captureStore = await import('../src/capture-store.js');
const { buildRouter } = await import('../src/router.js');

after(() => {
  try { if (eventStore._resetForTests) eventStore._resetForTests(); } catch {}
  try { if (captureStore._resetDriverCache) captureStore._resetDriverCache(); } catch {}
  try { store.close(); } catch {}
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
});

function unique(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  return app;
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      try {
        const base = `http://127.0.0.1:${srv.address().port}`;
        const out = await fn(base);
        srv.close(() => resolve(out));
      } catch (e) {
        srv.close(() => reject(e));
      }
    });
  });
}

async function api(base, pathName, key, { method = 'GET', body } = {}) {
  return fetch(base + pathName, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('W1035 compile hydrates requestless examples from the tenant capture namespace', async () => {
  const tenant = auth.provisionTenant(unique('w1035-tenant'), {
    plan: 'enterprise',
    quota: 100000,
    email: 'w1035@example.test',
  });

  await withServer(makeApp(), async (base) => {
    const namespace = unique('w1035-ns');
    const items = Array.from({ length: 16 }, (_, i) => {
      const urgent = i % 2 === 0;
      return {
        input: urgent
          ? `urgent outage ticket ${i} needs response now`
          : `routine newsletter update ${i} can wait`,
        output: urgent,
      };
    });

    const capture = await api(base, '/v1/capture/log', tenant.api_key, {
      method: 'POST',
      body: {
        namespace,
        provider: 'manual',
        model: 'w1035-fixture',
        items,
      },
    });
    assert.equal(capture.status, 201);
    const captureBody = await capture.json();
    assert.equal(captureBody.count, items.length);

    const started = await api(base, '/v1/compile?sync=1', tenant.api_key, {
      method: 'POST',
      body: {
        task: 'flag urgent support tickets',
        corpus_namespace: namespace,
        recipe_class: 'rule',
        k_threshold: 0.50,
        allow_below_gate: true,
      },
    });
    assert.equal(started.status, 202);
    const startedBody = await started.json();
    assert.ok(startedBody.job_id);

    const status = await api(base, `/v1/compile/${startedBody.job_id}`, tenant.api_key);
    assert.equal(status.status, 200);
    const job = await status.json();
    assert.equal(job.corpus_namespace, namespace);
    assert.equal(job.examples_n, items.length);
    assert.notEqual(job.error_code, 'KOLM_E_NO_SEEDS');
    assert.equal(job.status, 'completed', job.error || 'compile should complete from hydrated captures');
    assert.ok((job.stages || []).some((s) => s && s.name === 'split.done'));
    assert.ok(job.seed_provenance && job.seed_provenance.seeds_hash);
  });
});
