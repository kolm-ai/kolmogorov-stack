import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import express from 'express';

import {
  buildProductFrontierLab,
  PRODUCT_FRONTIER_LAB_SPEC,
} from '../src/product-frontier-lab.js';
import { buildRouter } from '../src/router.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const out = await fn(base);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
    server.on('error', reject);
  });
}

test('W602 #1 - product frontier lab contract is local-ready and complete across product metrics', () => {
  const lab = buildProductFrontierLab({ root: ROOT });
  const graph = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'product-graph.json'), 'utf8'));
  const journeyIds = new Set((graph.journeys || []).map((journey) => journey.id));
  assert.equal(lab.spec, PRODUCT_FRONTIER_LAB_SPEC);
  assert.equal(lab.ok, true, lab.failures.join('\n'));
  assert.equal(lab.local_contract_ok, true);
  assert.equal(lab.external_ready, false);
  assert.equal(lab.secret_values_included, false);
  assert.ok(lab.counts.experiments >= 14);
  assert.ok(lab.counts.sources >= 30);
  assert.equal(lab.coverage.missing_journeys.length, 0);
  assert.equal(lab.coverage.missing_dimensions.length, 0);
  assert.equal(lab.coverage.missing_open_requirements.length, 0);
  assert.equal(lab.coverage.missing_metrics.length, 0);
  assert.ok(lab.simulation.composite_delta >= 0.28);
  assert.ok(lab.evidence.source_paths.includes('tests/wave602-product-frontier-lab-api.test.js'));
  assert.ok(lab.evidence.source_paths.includes('docs/product-frontier-implementation-contracts.json'));
  assert.ok(lab.evidence.source_paths.includes('tests/wave603-product-frontier-implementation-contracts.test.js'));
  for (const action of lab.next_actions) {
    assert.ok(journeyIds.has(action.journey), `${action.value}: unknown journey ${action.journey}`);
  }
});

test('W602 #2 - public API exposes the frontier lab as an enveloped product contract', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/v1/product/frontier-lab?metric=latency&include_experiments=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-kolm-readiness'), 'implemented');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.journey, 'compile-verify');
    assert.equal(body.data.secret_values_included, false);
    assert.equal(body.data.lab.spec, PRODUCT_FRONTIER_LAB_SPEC);
    assert.equal(body.data.lab.filter.metric, 'latency');
    assert.ok(body.data.lab.selected_experiments.length >= 1);
    assert.ok(body.evidence.source_paths.includes('src/product-frontier-lab.js'));
    assert.ok(body.evidence.source_paths.includes('docs/product-frontier-implementation-contracts.json'));
    assert.ok(body.evidence.source_paths.includes('scripts/simulate-product-frontier-implementation-contracts.cjs'));
    assert.ok(body.next_actions.some((action) => action.value === 'npm run verify:frontier-lab'));
  });
});

test('W602 #3 - CLI surfaces output can include frontier lab parity data', () => {
  const run = spawnSync(process.execPath, ['cli/kolm.js', 'surfaces', '--frontier-lab', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const body = JSON.parse(run.stdout);
  assert.equal(body.frontier_lab.spec, PRODUCT_FRONTIER_LAB_SPEC);
  assert.equal(body.frontier_lab.ok, true);
  assert.equal(body.frontier_lab.secret_values_included, false);
  assert.equal(body.frontier_lab.coverage.missing_open_requirements.length, 0);
  assert.ok(body.frontier_lab.next_actions.some((action) => action.value === 'npm run verify:frontier-lab'));
});
