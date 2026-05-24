// @public-routes-only — exercises /v1/product/frontier-contracts (public, mounted before authMiddleware).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import express from 'express';

import {
  buildProductFrontierContracts,
  PRODUCT_FRONTIER_IMPLEMENTATION_CONTRACTS_SPEC,
} from '../src/product-frontier-contracts.js';
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

test('W604 #1 - implementation contracts have runtime coverage and evidence paths', () => {
  const contracts = buildProductFrontierContracts({ root: ROOT });
  assert.equal(contracts.spec, PRODUCT_FRONTIER_IMPLEMENTATION_CONTRACTS_SPEC);
  assert.equal(contracts.ok, true, contracts.failures.join('\n'));
  assert.equal(contracts.external_ready, false);
  assert.equal(contracts.secret_values_included, false);
  assert.equal(contracts.counts.contracts, contracts.counts.lab_experiments);
  assert.equal(contracts.coverage.missing_experiment_contracts.length, 0);
  assert.equal(contracts.coverage.duplicate_experiment_contracts.length, 0);
  assert.equal(contracts.coverage.missing_journeys.length, 0);
  assert.equal(contracts.coverage.missing_open_requirements.length, 0);
  assert.equal(contracts.coverage.unused_research.length, 0);
  assert.ok(contracts.evidence.source_paths.includes('src/product-frontier-contracts.js'));
  assert.ok(contracts.next_actions.some((action) => action.value === 'npm run verify:frontier-contracts'));
  const surfaces = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'product-surfaces.json'), 'utf8'));
  const publicDocs = surfaces.surfaces.find((surface) => surface.id === 'public-docs-sdk');
  assert.ok(publicDocs.primary_paths.includes('/v1/product/frontier-contracts'));
  assert.ok(publicDocs.code_paths.includes('src/product-frontier-contracts.js'));
  assert.ok(publicDocs.doc_paths.includes('docs/product-frontier-implementation-contracts.json'));
  assert.ok(publicDocs.production_smoke.some((probe) => probe.id === 'product-frontier-contracts' && probe.path === '/v1/product/frontier-contracts'));
});

test('W604 #2 - public API exposes filtered implementation contracts', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/v1/product/frontier-contracts?source=mlir-dialect-conversion&include_contracts=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-kolm-readiness'), 'implemented');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.journey, 'compile-verify');
    assert.equal(body.data.secret_values_included, false);
    assert.equal(body.data.contracts.spec, PRODUCT_FRONTIER_IMPLEMENTATION_CONTRACTS_SPEC);
    assert.equal(body.data.contracts.filter.source, 'mlir-dialect-conversion');
    assert.ok(body.data.contracts.selected_contracts.length >= 1);
    assert.ok(body.evidence.source_paths.includes('src/product-frontier-contracts.js'));
    assert.ok(body.evidence.source_paths.includes('tests/wave604-product-frontier-contracts-api.test.js'));
    assert.ok(body.next_actions.some((action) => action.value === 'npm run verify:frontier-contracts'));
  });
});

test('W604 #3 - CLI surfaces output can include implementation contract parity data', () => {
  const run = spawnSync(process.execPath, ['cli/kolm.js', 'surfaces', '--frontier-contracts', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const body = JSON.parse(run.stdout);
  assert.equal(body.frontier_contracts.spec, PRODUCT_FRONTIER_IMPLEMENTATION_CONTRACTS_SPEC);
  assert.equal(body.frontier_contracts.ok, true);
  assert.equal(body.frontier_contracts.secret_values_included, false);
  assert.equal(body.frontier_contracts.coverage.missing_experiment_contracts.length, 0);
  assert.ok(body.frontier_contracts.next_actions.some((action) => action.value === 'npm run verify:frontier-contracts'));
});
