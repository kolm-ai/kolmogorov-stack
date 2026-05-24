// Wave 580: product invention portfolio lock-ins.
//
// This keeps the research/invention backlog from becoming prose drift. The
// portfolio is a backend/product contract: it must cover every product journey,
// every user customization dimension, every currently open readiness gate, and
// every tracked metric before implementation agents treat it as a plan.

import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORTFOLIO = path.join(ROOT, 'docs', 'product-invention-portfolio.json');
const GRAPH = path.join(ROOT, 'public', 'product-graph.json');
const READINESS = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const PACKAGE = path.join(ROOT, 'package.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function openReadinessIds() {
  const readiness = readJson(READINESS);
  const ids = [];
  for (const surface of readiness.surfaces || []) {
    for (const req of surface.requirements || []) {
      if (!['shipped', 'implemented'].includes(req.status)) ids.push(req.id);
    }
  }
  return ids.sort();
}

test('1. invention portfolio is a structured backend contract, not loose prose', () => {
  const portfolio = readJson(PORTFOLIO);
  assert.equal(portfolio.schema_version, 'kolm-product-invention-portfolio-1');
  assert.ok(Array.isArray(portfolio.implementation_rules) && portfolio.implementation_rules.length >= 5);
  assert.ok(Object.keys(portfolio.metric_weights).length >= 9);
  assert.ok(Object.keys(portfolio.baseline).length >= 9);
  assert.ok(Array.isArray(portfolio.inventions) && portfolio.inventions.length >= 12);

  for (const invention of portfolio.inventions) {
    assert.match(invention.id, /^[a-z0-9-]+$/);
    assert.ok(invention.thesis.length >= 40, `${invention.id}: thesis should be implementation-grade`);
    for (const field of ['journeys', 'dimensions', 'readiness', 'implementation_surfaces', 'smoke_tests']) {
      assert.ok(Array.isArray(invention[field]) && invention[field].length > 0, `${invention.id}: missing ${field}`);
    }
    assert.ok(Object.keys(invention.metrics || {}).length > 0, `${invention.id}: missing metric lift`);
  }
});

test('2. portfolio covers all journeys, dimensions, open gates, and metrics', () => {
  const portfolio = readJson(PORTFOLIO);
  const graph = readJson(GRAPH);
  const coveredJourneys = new Set(portfolio.inventions.flatMap((row) => row.journeys));
  const coveredDimensions = new Set(portfolio.inventions.flatMap((row) => row.dimensions));
  const coveredReadiness = new Set(portfolio.inventions.flatMap((row) => row.readiness));
  const coveredMetrics = new Set(portfolio.inventions.flatMap((row) => Object.keys(row.metrics || {})));

  for (const journey of graph.journeys || []) assert.ok(coveredJourneys.has(journey.id), `missing journey ${journey.id}`);
  for (const dimension of graph.dimensions || []) assert.ok(coveredDimensions.has(dimension.id), `missing dimension ${dimension.id}`);
  for (const id of openReadinessIds()) assert.ok(coveredReadiness.has(id), `missing open readiness gate ${id}`);
  for (const metric of Object.keys(portfolio.metric_weights)) assert.ok(coveredMetrics.has(metric), `missing metric ${metric}`);
});

test('3. synthetic simulator is green and materially improves weighted score', () => {
  const stdout = execFileSync(process.execPath, ['scripts/simulate-invention-portfolio.cjs', '--summary'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.coverage.missing_journeys.length, 0);
  assert.equal(result.coverage.missing_dimensions.length, 0);
  assert.equal(result.coverage.missing_open_requirements.length, 0);
  assert.equal(result.coverage.missing_metric_classes.length, 0);
  assert.ok(result.simulation.composite_delta >= 0.2, `expected >=0.2 composite delta, got ${result.simulation.composite_delta}`);
});

test('4. depth verification includes the invention gate', () => {
  const pkg = readJson(PACKAGE);
  assert.ok(pkg.scripts['verify:inventions'].includes('simulate-invention-portfolio.cjs --summary'));
  assert.ok(pkg.scripts['verify:depth'].includes('simulate-invention-portfolio.cjs --summary'));
});
