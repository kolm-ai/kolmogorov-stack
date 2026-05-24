#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const specPath = path.join(ROOT, 'docs', 'product-invention-implementation-spec.json');
const portfolioPath = path.join(ROOT, 'docs', 'product-invention-portfolio.json');
const graphPath = path.join(ROOT, 'public', 'product-graph.json');
const readinessPath = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const MAX_SYNTHETIC_METRIC_LIFT = 0.8;

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const categoryArg = args.find((arg) => arg.startsWith('--category='));
const categoryFilter = categoryArg ? categoryArg.slice('--category='.length) : null;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function unique(values) {
  return Array.from(new Set(values)).sort();
}

function flattenRequirements(readiness) {
  const out = [];
  for (const surface of readiness.surfaces || []) {
    for (const req of surface.requirements || []) out.push({ surface: surface.id, ...req });
  }
  return out;
}

function composite(metrics, weights) {
  return Number(Object.entries(weights).reduce((sum, [metric, weight]) => sum + (metrics[metric] || 0) * weight, 0).toFixed(3));
}

function simulate() {
  const spec = readJson(specPath);
  const portfolio = readJson(portfolioPath);
  const graph = readJson(graphPath);
  const readiness = readJson(readinessPath);
  const failures = [];

  if (spec.schema_version !== 'kolm-invention-implementation-spec-1') failures.push('unexpected schema_version');
  if (!Array.isArray(spec.tracked_metrics) || spec.tracked_metrics.length < 9) failures.push('tracked_metrics too thin');
  if (!Array.isArray(spec.research_sources) || spec.research_sources.length < 20) failures.push('research_sources too thin');
  if (!Array.isArray(spec.inventions) || spec.inventions.length < 12) failures.push('inventions too thin');

  const metricWeights = portfolio.metric_weights || {};
  const baseline = portfolio.baseline || {};
  const metricIds = Object.keys(metricWeights);
  const graphJourneyIds = new Set((graph.journeys || []).map((j) => j.id));
  const graphDimensionIds = new Set((graph.dimensions || []).map((d) => d.id));
  const requirements = flattenRequirements(readiness);
  const readinessIds = new Set(requirements.map((r) => r.id));
  const openRequirementIds = new Set(requirements.filter((r) => !['shipped', 'implemented'].includes(r.status)).map((r) => r.id));
  const portfolioIds = new Set((portfolio.inventions || []).map((i) => i.id));
  const sourceIds = new Set((spec.research_sources || []).map((s) => s.id));
  const ids = new Set();

  const inventions = categoryFilter
    ? (spec.inventions || []).filter((item) => item.category === categoryFilter)
    : (spec.inventions || []);
  if (categoryFilter && inventions.length === 0) failures.push(`unknown category ${categoryFilter}`);

  for (const invention of inventions) {
    if (!invention.id || !/^[a-z0-9-]+$/.test(invention.id)) failures.push(`${invention.id || 'unknown'}: bad id`);
    if (ids.has(invention.id)) failures.push(`${invention.id}: duplicate id`);
    ids.add(invention.id);
    if (!portfolioIds.has(invention.portfolio_invention_id)) failures.push(`${invention.id}: unknown portfolio_invention_id ${invention.portfolio_invention_id}`);
    if (!invention.thesis || invention.thesis.length < 80) failures.push(`${invention.id}: thesis too thin`);
    for (const field of ['research_refs', 'journeys', 'dimensions', 'readiness', 'metrics', 'build_phases', 'implementation_files', 'acceptance_tests', 'failure_modes']) {
      if (!Array.isArray(invention[field]) || invention[field].length < 2) failures.push(`${invention.id}: ${field} too thin`);
    }
    if (!Array.isArray(invention.math_core) || invention.math_core.length < 3) failures.push(`${invention.id}: math_core needs at least 3 items`);
    if (!invention.smoke_simulation || !invention.smoke_simulation.command || !Array.isArray(invention.smoke_simulation.expected)) failures.push(`${invention.id}: missing smoke_simulation`);
    if (!invention.expected_metric_lift || Object.keys(invention.expected_metric_lift).length < 3) failures.push(`${invention.id}: expected_metric_lift too thin`);

    for (const ref of invention.research_refs || []) if (!sourceIds.has(ref)) failures.push(`${invention.id}: unknown research_ref ${ref}`);
    for (const journey of invention.journeys || []) if (!graphJourneyIds.has(journey)) failures.push(`${invention.id}: unknown journey ${journey}`);
    for (const dimension of invention.dimensions || []) if (!graphDimensionIds.has(dimension)) failures.push(`${invention.id}: unknown dimension ${dimension}`);
    for (const req of invention.readiness || []) if (!readinessIds.has(req)) failures.push(`${invention.id}: unknown readiness ${req}`);
    for (const metric of invention.metrics || []) if (!metricIds.includes(metric)) failures.push(`${invention.id}: unknown metric ${metric}`);
    for (const metric of Object.keys(invention.expected_metric_lift || {})) if (!metricIds.includes(metric)) failures.push(`${invention.id}: unknown metric lift ${metric}`);
  }

  const allInventions = spec.inventions || [];
  const coveredJourneys = unique(allInventions.flatMap((i) => i.journeys || []));
  const coveredDimensions = unique(allInventions.flatMap((i) => i.dimensions || []));
  const coveredReadiness = unique(allInventions.flatMap((i) => i.readiness || []));
  const coveredMetrics = unique(allInventions.flatMap((i) => i.metrics || []));
  const coveredPortfolio = unique(allInventions.map((i) => i.portfolio_invention_id));
  const weakJourneys = (graph.journeys || [])
    .map((j) => ({ id: j.id, count: allInventions.filter((i) => (i.journeys || []).includes(j.id)).length }))
    .filter((row) => row.count < 2);
  const missingJourneys = (graph.journeys || []).map((j) => j.id).filter((id) => !coveredJourneys.includes(id));
  const missingDimensions = (graph.dimensions || []).map((d) => d.id).filter((id) => !coveredDimensions.includes(id));
  const missingOpenRequirements = Array.from(openRequirementIds).filter((id) => !coveredReadiness.includes(id)).sort();
  const missingMetrics = metricIds.filter((id) => !coveredMetrics.includes(id));
  const missingPortfolio = Array.from(portfolioIds).filter((id) => !coveredPortfolio.includes(id)).sort();

  if (!categoryFilter) {
    if (missingJourneys.length) failures.push(`missing journeys: ${missingJourneys.join(', ')}`);
    if (weakJourneys.length) failures.push(`journeys with <2 inventions: ${weakJourneys.map((j) => `${j.id}:${j.count}`).join(', ')}`);
    if (missingDimensions.length) failures.push(`missing dimensions: ${missingDimensions.join(', ')}`);
    if (missingOpenRequirements.length) failures.push(`open requirements not addressed: ${missingOpenRequirements.join(', ')}`);
    if (missingMetrics.length) failures.push(`missing metrics: ${missingMetrics.join(', ')}`);
    if (missingPortfolio.length) failures.push(`portfolio inventions without implementation spec: ${missingPortfolio.join(', ')}`);
  }

  const metricLift = {};
  for (const metric of metricIds) metricLift[metric] = 0;
  for (const invention of allInventions) {
    for (const [metric, lift] of Object.entries(invention.expected_metric_lift || {})) {
      metricLift[metric] = Math.min(MAX_SYNTHETIC_METRIC_LIFT, Number(((metricLift[metric] || 0) + lift).toFixed(4)));
    }
  }
  const simulated = {};
  for (const metric of metricIds) {
    simulated[metric] = Number(Math.min(0.995, (baseline[metric] || 0) + metricLift[metric] * (1 - (baseline[metric] || 0))).toFixed(3));
  }
  const baselineComposite = composite(baseline, metricWeights);
  const simulatedComposite = composite(simulated, metricWeights);
  if (!categoryFilter && simulatedComposite - baselineComposite < 0.25) failures.push(`composite lift too low: ${simulatedComposite - baselineComposite}`);

  const result = {
    ok: failures.length === 0,
    note: 'Synthetic implementation-spec smoke only. This proves coverage and buildability of the invention plan, not production benchmark performance.',
    filter: { category: categoryFilter },
    counts: {
      inventions: allInventions.length,
      selected_inventions: inventions.length,
      research_sources: (spec.research_sources || []).length,
      journeys: graph.journeys?.length || 0,
      dimensions: graph.dimensions?.length || 0,
      readiness_requirements: requirements.length,
      open_requirements: openRequirementIds.size,
      metric_classes: metricIds.length,
      portfolio_inventions: portfolioIds.size
    },
    coverage: {
      covered_journeys: coveredJourneys.length,
      covered_dimensions: coveredDimensions.length,
      covered_open_requirements: Array.from(openRequirementIds).filter((id) => coveredReadiness.includes(id)).length,
      covered_metrics: coveredMetrics.length,
      covered_portfolio_inventions: coveredPortfolio.length,
      missing_journeys: missingJourneys,
      weak_journeys: weakJourneys,
      missing_dimensions: missingDimensions,
      missing_open_requirements: missingOpenRequirements,
      missing_metrics: missingMetrics,
      missing_portfolio_inventions: missingPortfolio
    },
    simulation: {
      synthetic_metric_lift_cap: MAX_SYNTHETIC_METRIC_LIFT,
      baseline,
      simulated,
      metric_lift: metricLift,
      baseline_composite: baselineComposite,
      simulated_composite: simulatedComposite,
      composite_delta: Number((simulatedComposite - baselineComposite).toFixed(3))
    },
    failures
  };
  if (!summary) {
    result.inventions = inventions.map((i) => ({
      id: i.id,
      category: i.category,
      portfolio_invention_id: i.portfolio_invention_id,
      metrics: i.metrics,
      readiness: i.readiness,
      implementation_files: i.implementation_files,
      smoke_simulation: i.smoke_simulation,
      acceptance_tests: i.acceptance_tests
    }));
  }
  return result;
}

const result = simulate();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
