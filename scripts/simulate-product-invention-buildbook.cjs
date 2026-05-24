#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const buildbookPath = path.join(ROOT, 'docs', 'product-invention-buildbook.json');
const portfolioPath = path.join(ROOT, 'docs', 'product-invention-portfolio.json');
const graphPath = path.join(ROOT, 'public', 'product-graph.json');
const readinessPath = path.join(ROOT, 'docs', 'product-sota-readiness.json');

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const categoryArg = args.find((arg) => arg.startsWith('--category='));
const inventionArg = args.find((arg) => arg.startsWith('--invention='));
const metricArg = args.find((arg) => arg.startsWith('--metric='));
const categoryFilter = categoryArg ? categoryArg.slice('--category='.length) : null;
const inventionFilter = inventionArg ? inventionArg.slice('--invention='.length) : null;
const metricFilter = metricArg ? metricArg.slice('--metric='.length) : null;

const MAX_SYNTHETIC_METRIC_LIFT = 0.86;
const BUILDBOOK_INTERACTION_MULTIPLIER = 1.35;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function unique(values) {
  return Array.from(new Set(values)).sort();
}

function hasText(value, min) {
  return typeof value === 'string' && value.trim().length >= min;
}

function flattenRequirements(readiness) {
  const out = [];
  for (const surface of readiness.surfaces || []) {
    for (const requirement of surface.requirements || []) out.push({ surface: surface.id, ...requirement });
  }
  return out;
}

function composite(metrics, weights) {
  return Number(Object.entries(weights).reduce((sum, [metric, weight]) => sum + (metrics[metric] || 0) * weight, 0).toFixed(3));
}

function validateBuildbook(buildbook, graph, readiness, portfolio, failures) {
  if (buildbook.schema_version !== 'kolm-product-invention-buildbook-1') failures.push('unexpected schema_version');
  if (!Array.isArray(buildbook.source_policy) || buildbook.source_policy.length < 3) failures.push('source_policy too thin');
  if (!Array.isArray(buildbook.tracked_metrics) || buildbook.tracked_metrics.length < 9) failures.push('tracked_metrics too thin');
  if (!Array.isArray(buildbook.categories) || buildbook.categories.length < 12) failures.push('categories too thin');
  if (!Array.isArray(buildbook.research_sources) || buildbook.research_sources.length < 24) failures.push('research_sources too thin');
  if (!Array.isArray(buildbook.inventions) || buildbook.inventions.length < 12) failures.push('inventions too thin');

  const categoryIds = new Set(buildbook.categories || []);
  const sourceIds = new Set();
  const sourceAreas = new Set();
  for (const source of buildbook.research_sources || []) {
    if (!source.id || !/^[a-z0-9-]+$/.test(source.id)) failures.push(`bad source id: ${source.id || 'unknown'}`);
    if (sourceIds.has(source.id)) failures.push(`duplicate source id: ${source.id}`);
    sourceIds.add(source.id);
    if (!source.url || !/^https?:\/\//.test(source.url)) failures.push(`${source.id}: missing source url`);
    if (!hasText(source.lesson, 70)) failures.push(`${source.id}: lesson too thin`);
    if (source.area) sourceAreas.add(source.area);
  }
  if (sourceAreas.size < 10) failures.push(`source areas too thin: ${sourceAreas.size}`);

  const journeyIds = new Set((graph.journeys || []).map((journey) => journey.id));
  const dimensionIds = new Set((graph.dimensions || []).map((dimension) => dimension.id));
  const requirements = flattenRequirements(readiness);
  const readinessIds = new Set(requirements.map((requirement) => requirement.id));
  const metricIds = new Set(Object.keys(portfolio.metric_weights || {}));
  const portfolioIds = new Set((portfolio.inventions || []).map((invention) => invention.id));
  const inventionIds = new Set();

  for (const invention of buildbook.inventions || []) {
    if (!invention.id || !/^w598-[a-z0-9-]+$/.test(invention.id)) failures.push(`${invention.id || 'unknown'}: bad invention id`);
    if (inventionIds.has(invention.id)) failures.push(`${invention.id}: duplicate invention id`);
    inventionIds.add(invention.id);
    if (!categoryIds.has(invention.category)) failures.push(`${invention.id}: unknown category ${invention.category}`);
    if (!portfolioIds.has(invention.portfolio_invention_id)) failures.push(`${invention.id}: unknown portfolio_invention_id ${invention.portfolio_invention_id}`);
    if (!hasText(invention.name, 8)) failures.push(`${invention.id}: name too thin`);
    if (!hasText(invention.thesis, 115)) failures.push(`${invention.id}: thesis too thin`);

    const minimums = {
      research_refs: 3,
      journeys: 4,
      dimensions: 4,
      readiness: 5,
      metrics: 5,
      implementation_files: 5,
      build_steps: 7,
      acceptance_tests: 4,
      failure_modes: 3
    };
    for (const [field, min] of Object.entries(minimums)) {
      if (!Array.isArray(invention[field]) || invention[field].length < min) failures.push(`${invention.id}: ${field} too thin`);
    }
    if (!invention.expected_metric_lift || Object.keys(invention.expected_metric_lift).length < 4) failures.push(`${invention.id}: expected_metric_lift too thin`);
    if (!invention.smoke_simulation || !invention.smoke_simulation.command || !Array.isArray(invention.smoke_simulation.expected) || invention.smoke_simulation.expected.length < 3) {
      failures.push(`${invention.id}: smoke_simulation too thin`);
    }

    for (const ref of invention.research_refs || []) if (!sourceIds.has(ref)) failures.push(`${invention.id}: unknown research_ref ${ref}`);
    for (const journey of invention.journeys || []) if (!journeyIds.has(journey)) failures.push(`${invention.id}: unknown journey ${journey}`);
    for (const dimension of invention.dimensions || []) if (!dimensionIds.has(dimension)) failures.push(`${invention.id}: unknown dimension ${dimension}`);
    for (const requirement of invention.readiness || []) if (!readinessIds.has(requirement)) failures.push(`${invention.id}: unknown readiness ${requirement}`);
    for (const metric of invention.metrics || []) if (!metricIds.has(metric)) failures.push(`${invention.id}: unknown metric ${metric}`);
    for (const metric of Object.keys(invention.expected_metric_lift || {})) if (!metricIds.has(metric)) failures.push(`${invention.id}: unknown metric lift ${metric}`);
  }
}

function simulate() {
  const buildbook = readJson(buildbookPath);
  const graph = readJson(graphPath);
  const readiness = readJson(readinessPath);
  const portfolio = readJson(portfolioPath);
  const failures = [];
  validateBuildbook(buildbook, graph, readiness, portfolio, failures);

  let selected = buildbook.inventions || [];
  if (categoryFilter) selected = selected.filter((invention) => invention.category === categoryFilter);
  if (inventionFilter) selected = selected.filter((invention) => invention.id === inventionFilter);
  if (metricFilter) selected = selected.filter((invention) => (invention.metrics || []).includes(metricFilter));
  if (categoryFilter && selected.length === 0) failures.push(`unknown or empty category ${categoryFilter}`);
  if (inventionFilter && selected.length === 0) failures.push(`unknown invention ${inventionFilter}`);
  if (metricFilter && selected.length === 0) failures.push(`unknown or uncovered metric ${metricFilter}`);

  const requirements = flattenRequirements(readiness);
  const openRequirementIds = unique(requirements.filter((req) => !['shipped', 'implemented'].includes(req.status)).map((req) => req.id));
  const metricIds = Object.keys(portfolio.metric_weights || {});
  const journeyIds = (graph.journeys || []).map((journey) => journey.id);
  const dimensionIds = (graph.dimensions || []).map((dimension) => dimension.id);
  const categoryIds = buildbook.categories || [];
  const portfolioIds = (portfolio.inventions || []).map((invention) => invention.id);
  const allInventions = buildbook.inventions || [];

  const coveredJourneys = unique(allInventions.flatMap((invention) => invention.journeys || []));
  const coveredDimensions = unique(allInventions.flatMap((invention) => invention.dimensions || []));
  const coveredReadiness = unique(allInventions.flatMap((invention) => invention.readiness || []));
  const coveredMetrics = unique(allInventions.flatMap((invention) => invention.metrics || []));
  const coveredCategories = unique(allInventions.map((invention) => invention.category).filter(Boolean));
  const coveredPortfolio = unique(allInventions.map((invention) => invention.portfolio_invention_id).filter(Boolean));
  const categoryCounts = Object.fromEntries(categoryIds.map((category) => [category, allInventions.filter((invention) => invention.category === category).length]));
  const journeyCounts = Object.fromEntries(journeyIds.map((journey) => [journey, allInventions.filter((invention) => (invention.journeys || []).includes(journey)).length]));

  const missingJourneys = journeyIds.filter((id) => !coveredJourneys.includes(id));
  const weakJourneys = Object.entries(journeyCounts).filter(([, count]) => count < 2).map(([id, count]) => ({ id, count }));
  const missingDimensions = dimensionIds.filter((id) => !coveredDimensions.includes(id));
  const missingOpenRequirements = openRequirementIds.filter((id) => !coveredReadiness.includes(id));
  const missingMetrics = metricIds.filter((id) => !coveredMetrics.includes(id));
  const missingCategories = categoryIds.filter((id) => !coveredCategories.includes(id));
  const missingPortfolio = portfolioIds.filter((id) => !coveredPortfolio.includes(id));

  const globalMode = !categoryFilter && !inventionFilter && !metricFilter;
  if (globalMode) {
    if (missingJourneys.length) failures.push(`missing journeys: ${missingJourneys.join(', ')}`);
    if (weakJourneys.length) failures.push(`journeys with <2 inventions: ${weakJourneys.map((j) => `${j.id}:${j.count}`).join(', ')}`);
    if (missingDimensions.length) failures.push(`missing dimensions: ${missingDimensions.join(', ')}`);
    if (missingOpenRequirements.length) failures.push(`open requirements not addressed: ${missingOpenRequirements.join(', ')}`);
    if (missingMetrics.length) failures.push(`missing metrics: ${missingMetrics.join(', ')}`);
    if (missingCategories.length) failures.push(`missing categories: ${missingCategories.join(', ')}`);
    if (missingPortfolio.length) failures.push(`missing portfolio inventions: ${missingPortfolio.join(', ')}`);
  }

  const metricLift = {};
  for (const metric of metricIds) metricLift[metric] = 0;
  for (const invention of allInventions) {
    for (const [metric, lift] of Object.entries(invention.expected_metric_lift || {})) {
      metricLift[metric] = Math.min(MAX_SYNTHETIC_METRIC_LIFT, Number(((metricLift[metric] || 0) + Number(lift) * BUILDBOOK_INTERACTION_MULTIPLIER).toFixed(4)));
    }
  }

  const baseline = portfolio.baseline || {};
  const simulated = {};
  for (const metric of metricIds) {
    simulated[metric] = Number(Math.min(0.997, (baseline[metric] || 0) + metricLift[metric] * (1 - (baseline[metric] || 0))).toFixed(3));
  }
  const baselineComposite = composite(baseline, portfolio.metric_weights || {});
  const simulatedComposite = composite(simulated, portfolio.metric_weights || {});
  if (globalMode && simulatedComposite - baselineComposite < 0.27) failures.push(`buildbook composite lift too low: ${simulatedComposite - baselineComposite}`);

  const result = {
    ok: failures.length === 0,
    note: 'Synthetic buildbook smoke only. This validates research coverage, implementation sequencing, product-surface mapping, and open-gate handoff. It is not public benchmark evidence, external runtime adoption, package publication, or live certification proof.',
    filter: {
      category: categoryFilter,
      invention: inventionFilter,
      metric: metricFilter
    },
    counts: {
      sources: (buildbook.research_sources || []).length,
      source_areas: unique((buildbook.research_sources || []).map((source) => source.area).filter(Boolean)).length,
      categories: categoryIds.length,
      inventions: allInventions.length,
      selected_inventions: selected.length,
      journeys: journeyIds.length,
      dimensions: dimensionIds.length,
      readiness_requirements: requirements.length,
      open_requirements: openRequirementIds.length,
      metrics: metricIds.length,
      portfolio_inventions: portfolioIds.length
    },
    coverage: {
      covered_journeys: coveredJourneys.length,
      covered_dimensions: coveredDimensions.length,
      covered_open_requirements: openRequirementIds.filter((id) => coveredReadiness.includes(id)).length,
      covered_metrics: coveredMetrics.length,
      covered_categories: coveredCategories.length,
      covered_portfolio_inventions: coveredPortfolio.length,
      category_counts: categoryCounts,
      journey_counts: journeyCounts,
      missing_journeys: missingJourneys,
      weak_journeys: weakJourneys,
      missing_dimensions: missingDimensions,
      missing_open_requirements: missingOpenRequirements,
      missing_metrics: missingMetrics,
      missing_categories: missingCategories,
      missing_portfolio_inventions: missingPortfolio
    },
    simulation: {
      synthetic_metric_lift_cap: MAX_SYNTHETIC_METRIC_LIFT,
      interaction_multiplier: BUILDBOOK_INTERACTION_MULTIPLIER,
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
    result.inventions = selected.map((invention) => ({
      id: invention.id,
      name: invention.name,
      category: invention.category,
      portfolio_invention_id: invention.portfolio_invention_id,
      research_refs: invention.research_refs,
      journeys: invention.journeys,
      dimensions: invention.dimensions,
      readiness: invention.readiness,
      metrics: invention.metrics,
      implementation_files: invention.implementation_files,
      acceptance_tests: invention.acceptance_tests,
      smoke_simulation: invention.smoke_simulation
    }));
  }
  return result;
}

const result = simulate();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
