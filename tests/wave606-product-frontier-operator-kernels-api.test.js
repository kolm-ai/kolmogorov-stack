import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import express from 'express';

import {
  buildProductFrontierOperatorKernels,
  PRODUCT_FRONTIER_OPERATOR_KERNELS_SPEC,
} from '../src/product-frontier-operator-kernels.js';
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

test('W606 #1 - operator kernels have runtime coverage and route ownership', () => {
  const kernels = buildProductFrontierOperatorKernels({ root: ROOT });
  assert.equal(kernels.spec, PRODUCT_FRONTIER_OPERATOR_KERNELS_SPEC);
  assert.equal(kernels.ok, true, kernels.failures.join('\n'));
  assert.equal(kernels.external_ready, false);
  assert.equal(kernels.secret_values_included, false);
  assert.equal(kernels.counts.kernels, 12);
  assert.equal(kernels.coverage.missing_journeys.length, 0);
  assert.equal(kernels.coverage.missing_dimensions.length, 0);
  assert.equal(kernels.coverage.missing_open_requirements.length, 0);
  assert.equal(kernels.coverage.unused_sources.length, 0);
  assert.ok(kernels.simulation.composite_delta >= 0.2);
  assert.ok(kernels.evidence.source_paths.includes('src/product-frontier-operator-kernels.js'));
  assert.ok(kernels.next_actions.some((action) => action.value === 'npm run verify:operator-kernels'));
  const surfaces = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'product-surfaces.json'), 'utf8'));
  const publicDocs = surfaces.surfaces.find((surface) => surface.id === 'public-docs-sdk');
  assert.ok(publicDocs.primary_paths.includes('/v1/product/operator-kernels'));
  assert.ok(publicDocs.code_paths.includes('src/product-frontier-operator-kernels.js'));
  assert.ok(publicDocs.doc_paths.includes('docs/product-frontier-operator-kernels.json'));
  assert.ok(publicDocs.production_smoke.some((probe) => probe.id === 'product-operator-kernels' && probe.path === '/v1/product/operator-kernels'));
});

test('W606 #2 - public API exposes filtered operator kernels', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/v1/product/operator-kernels?source=tensorrt-llm&include_kernels=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-kolm-readiness'), 'implemented');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.journey, 'compile-verify');
    assert.equal(body.data.secret_values_included, false);
    assert.equal(body.data.operator_kernels.spec, PRODUCT_FRONTIER_OPERATOR_KERNELS_SPEC);
    assert.equal(body.data.operator_kernels.filter.source, 'tensorrt-llm');
    assert.equal(body.data.operator_kernels.counts.selected_kernels, 3);
    assert.ok(body.data.operator_kernels.selected_kernels.every((kernel) => kernel.source_refs.includes('tensorrt-llm')));
    assert.ok(body.evidence.source_paths.includes('src/product-frontier-operator-kernels.js'));
    assert.ok(body.evidence.source_paths.includes('tests/wave606-product-frontier-operator-kernels-api.test.js'));
    assert.ok(body.next_actions.some((action) => action.value === 'npm run verify:operator-kernels'));
  });
});

test('W606 #3 - CLI surfaces output can include operator kernel parity data', () => {
  const run = spawnSync(process.execPath, ['cli/kolm.js', 'surfaces', '--operator-kernels', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const body = JSON.parse(run.stdout);
  assert.equal(body.operator_kernels.spec, PRODUCT_FRONTIER_OPERATOR_KERNELS_SPEC);
  assert.equal(body.operator_kernels.ok, true);
  assert.equal(body.operator_kernels.secret_values_included, false);
  assert.equal(body.operator_kernels.coverage.missing_open_requirements.length, 0);
  assert.ok(body.operator_kernels.next_actions.some((action) => action.value === 'npm run verify:operator-kernels'));
});
