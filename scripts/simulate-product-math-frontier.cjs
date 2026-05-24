#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const mathPath = path.join(ROOT, 'docs', 'product-math-frontier.json');
const graphPath = path.join(ROOT, 'public', 'product-graph.json');
const readinessPath = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const portfolioPath = path.join(ROOT, 'docs', 'product-invention-portfolio.json');

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const categoryArg = args.find((arg) => arg.startsWith('--category='));
const inventionArg = args.find((arg) => arg.startsWith('--invention='));
const primitiveArg = args.find((arg) => arg.startsWith('--primitive='));
const categoryFilter = categoryArg ? categoryArg.slice('--category='.length) : null;
const inventionFilter = inventionArg ? inventionArg.slice('--invention='.length) : null;
const primitiveFilter = primitiveArg ? primitiveArg.slice('--primitive='.length) : null;

const MAX_SYNTHETIC_METRIC_LIFT = 0.82;
const MATH_FRONTIER_INTERACTION_MULTIPLIER = 1.75;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function unique(values) {
  return Array.from(new Set(values)).sort();
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

function hasText(value, min) {
  return typeof value === 'string' && value.trim().length >= min;
}

function validateShape(math, graph, readiness, portfolio, failures) {
  if (math.schema_version !== 'kolm-product-math-frontier-1') failures.push('unexpected schema_version');
  if (!Array.isArray(math.tracked_metrics) || math.tracked_metrics.length < 9) failures.push('tracked_metrics too thin');
  if (!Array.isArray(math.categories) || math.categories.length < 10) failures.push('categories too thin');
  if (!Array.isArray(math.sources) || math.sources.length < 30) failures.push('sources too thin');
  if (!Array.isArray(math.math_primitives) || math.math_primitives.length < 16) failures.push('math_primitives too thin');
  if (!Array.isArray(math.inventions) || math.inventions.length < 12) failures.push('inventions too thin');

  const categories = new Set(math.categories || []);
  const sourceIds = new Set();
  const sourceAreas = new Set();
  for (const source of math.sources || []) {
    if (!source.id || !/^[a-z0-9-]+$/.test(source.id)) failures.push(`bad source id: ${source.id}`);
    if (sourceIds.has(source.id)) failures.push(`duplicate source id: ${source.id}`);
    sourceIds.add(source.id);
    if (!source.url || !/^https?:\/\//.test(source.url)) failures.push(`${source.id}: source url missing`);
    if (!hasText(source.lesson, 50)) failures.push(`${source.id}: lesson too thin`);
    if (source.area) sourceAreas.add(source.area);
  }
  if (sourceAreas.size < 8) failures.push(`source areas too thin: ${sourceAreas.size}`);

  const primitiveIds = new Set();
  for (const primitive of math.math_primitives || []) {
    if (!primitive.id || !/^[a-z0-9-]+$/.test(primitive.id)) failures.push(`bad primitive id: ${primitive.id}`);
    if (primitiveIds.has(primitive.id)) failures.push(`duplicate primitive id: ${primitive.id}`);
    primitiveIds.add(primitive.id);
    if (!categories.has(primitive.category)) failures.push(`${primitive.id}: unknown category ${primitive.category}`);
    if (!Array.isArray(primitive.source_refs) || primitive.source_refs.length < 1) failures.push(`${primitive.id}: source_refs too thin`);
    if (!hasText(primitive.objective, 45)) failures.push(`${primitive.id}: objective too thin`);
    if (!hasText(primitive.kolm_use, 45)) failures.push(`${primitive.id}: kolm_use too thin`);
    for (const ref of primitive.source_refs || []) if (!sourceIds.has(ref)) failures.push(`${primitive.id}: unknown source_ref ${ref}`);
  }

  const journeyIds = new Set((graph.journeys || []).map((journey) => journey.id));
  const dimensionIds = new Set((graph.dimensions || []).map((dimension) => dimension.id));
  const requirements = flattenRequirements(readiness);
  const readinessIds = new Set(requirements.map((requirement) => requirement.id));
  const metricIds = new Set(Object.keys(portfolio.metric_weights || {}));
  const portfolioIds = new Set((portfolio.inventions || []).map((invention) => invention.id));
  const inventionIds = new Set();

  for (const invention of math.inventions || []) {
    if (!invention.id || !/^w596-[a-z0-9-]+$/.test(invention.id)) failures.push(`${invention.id || 'unknown'}: bad invention id`);
    if (inventionIds.has(invention.id)) failures.push(`${invention.id}: duplicate invention id`);
    inventionIds.add(invention.id);
    if (!categories.has(invention.category)) failures.push(`${invention.id}: unknown category ${invention.category}`);
    if (!portfolioIds.has(invention.portfolio_invention_id)) failures.push(`${invention.id}: unknown portfolio_invention_id ${invention.portfolio_invention_id}`);
    if (!hasText(invention.objective, 85)) failures.push(`${invention.id}: objective too thin`);
    if (!hasText(invention.invariant, 85)) failures.push(`${invention.id}: invariant too thin`);

    const arrayMinimums = {
      primitive_refs: 2,
      source_refs: 3,
      journeys: 3,
      dimensions: 3,
      readiness: 3,
      metrics: 4,
      implementation_files: 5,
      build_steps: 5,
      acceptance_tests: 4
    };
    for (const [field, min] of Object.entries(arrayMinimums)) {
      if (!Array.isArray(invention[field]) || invention[field].length < min) failures.push(`${invention.id}: ${field} too thin`);
    }
    if (!invention.smoke_simulation || !invention.smoke_simulation.command || !Array.isArray(invention.smoke_simulation.expected) || invention.smoke_simulation.expected.length < 3) {
      failures.push(`${invention.id}: smoke_simulation too thin`);
    }
    if (!invention.expected_metric_lift || Object.keys(invention.expected_metric_lift).length < 4) failures.push(`${invention.id}: expected_metric_lift too thin`);

    for (const ref of invention.source_refs || []) if (!sourceIds.has(ref)) failures.push(`${invention.id}: unknown source_ref ${ref}`);
    for (const ref of invention.primitive_refs || []) if (!primitiveIds.has(ref)) failures.push(`${invention.id}: unknown primitive_ref ${ref}`);
    for (const journey of invention.journeys || []) if (!journeyIds.has(journey)) failures.push(`${invention.id}: unknown journey ${journey}`);
    for (const dimension of invention.dimensions || []) if (!dimensionIds.has(dimension)) failures.push(`${invention.id}: unknown dimension ${dimension}`);
    for (const req of invention.readiness || []) if (!readinessIds.has(req)) failures.push(`${invention.id}: unknown readiness ${req}`);
    for (const metric of invention.metrics || []) if (!metricIds.has(metric)) failures.push(`${invention.id}: unknown metric ${metric}`);
    for (const metric of Object.keys(invention.expected_metric_lift || {})) if (!metricIds.has(metric)) failures.push(`${invention.id}: unknown metric lift ${metric}`);
  }
}

function simulate() {
  const math = readJson(mathPath);
  const graph = readJson(graphPath);
  const readiness = readJson(readinessPath);
  const portfolio = readJson(portfolioPath);
  const failures = [];

  validateShape(math, graph, readiness, portfolio, failures);

  let selected = math.inventions || [];
  if (categoryFilter) selected = selected.filter((invention) => invention.category === categoryFilter);
  if (inventionFilter) selected = selected.filter((invention) => invention.id === inventionFilter);
  if (primitiveFilter) selected = selected.filter((invention) => (invention.primitive_refs || []).includes(primitiveFilter));
  if (categoryFilter && selected.length === 0) failures.push(`unknown or empty category ${categoryFilter}`);
  if (inventionFilter && selected.length === 0) failures.push(`unknown invention ${inventionFilter}`);
  if (primitiveFilter && selected.length === 0) failures.push(`unknown or unused primitive ${primitiveFilter}`);

  const requirements = flattenRequirements(readiness);
  const openRequirementIds = unique(requirements.filter((req) => !['shipped', 'implemented'].includes(req.status)).map((req) => req.id));
  const metricIds = Object.keys(portfolio.metric_weights || {});
  const journeyIds = (graph.journeys || []).map((journey) => journey.id);
  const dimensionIds = (graph.dimensions || []).map((dimension) => dimension.id);
  const categories = math.categories || [];
  const primitiveIds = (math.math_primitives || []).map((primitive) => primitive.id);
  const portfolioIds = (portfolio.inventions || []).map((invention) => invention.id);
  const allInventions = math.inventions || [];

  const coveredJourneys = unique(allInventions.flatMap((invention) => invention.journeys || []));
  const coveredDimensions = unique(allInventions.flatMap((invention) => invention.dimensions || []));
  const coveredReadiness = unique(allInventions.flatMap((invention) => invention.readiness || []));
  const coveredMetrics = unique(allInventions.flatMap((invention) => invention.metrics || []));
  const coveredCategories = unique(allInventions.map((invention) => invention.category).filter(Boolean));
  const usedPrimitives = unique(allInventions.flatMap((invention) => invention.primitive_refs || []));
  const coveredPortfolio = unique(allInventions.map((invention) => invention.portfolio_invention_id).filter(Boolean));

  const missingJourneys = journeyIds.filter((id) => !coveredJourneys.includes(id));
  const missingDimensions = dimensionIds.filter((id) => !coveredDimensions.includes(id));
  const missingOpenRequirements = openRequirementIds.filter((id) => !coveredReadiness.includes(id));
  const missingMetrics = metricIds.filter((id) => !coveredMetrics.includes(id));
  const missingCategories = categories.filter((id) => !coveredCategories.includes(id));
  const unusedPrimitives = primitiveIds.filter((id) => !usedPrimitives.includes(id));
  const missingPortfolio = portfolioIds.filter((id) => !coveredPortfolio.includes(id));

  const globalMode = !categoryFilter && !inventionFilter && !primitiveFilter;
  if (globalMode) {
    if (missingJourneys.length) failures.push(`missing journeys: ${missingJourneys.join(', ')}`);
    if (missingDimensions.length) failures.push(`missing dimensions: ${missingDimensions.join(', ')}`);
    if (missingOpenRequirements.length) failures.push(`open requirements not addressed: ${missingOpenRequirements.join(', ')}`);
    if (missingMetrics.length) failures.push(`missing metrics: ${missingMetrics.join(', ')}`);
    if (missingCategories.length) failures.push(`missing categories: ${missingCategories.join(', ')}`);
    if (unusedPrimitives.length) failures.push(`unused primitives: ${unusedPrimitives.join(', ')}`);
    if (missingPortfolio.length) failures.push(`missing portfolio inventions: ${missingPortfolio.join(', ')}`);
  }

  const metricLift = {};
  for (const metric of metricIds) metricLift[metric] = 0;
  for (const invention of allInventions) {
    for (const [metric, lift] of Object.entries(invention.expected_metric_lift || {})) {
      const compoundedLift = Number(lift) * MATH_FRONTIER_INTERACTION_MULTIPLIER;
      metricLift[metric] = Math.min(MAX_SYNTHETIC_METRIC_LIFT, Number(((metricLift[metric] || 0) + compoundedLift).toFixed(4)));
    }
  }

  const baseline = portfolio.baseline || {};
  const simulated = {};
  for (const metric of metricIds) {
    simulated[metric] = Number(Math.min(0.996, (baseline[metric] || 0) + metricLift[metric] * (1 - (baseline[metric] || 0))).toFixed(3));
  }
  const baselineComposite = composite(baseline, portfolio.metric_weights || {});
  const simulatedComposite = composite(simulated, portfolio.metric_weights || {});
  if (globalMode && simulatedComposite - baselineComposite < 0.22) failures.push(`math-frontier composite lift too low: ${simulatedComposite - baselineComposite}`);

  const result = {
    ok: failures.length === 0,
    note: 'Synthetic math-frontier smoke only. This checks algorithmic research coverage, implementation-plan completeness, and mapping to product journeys/readiness gates; it is not benchmark evidence or external certification.',
    filter: {
      category: categoryFilter,
      invention: inventionFilter,
      primitive: primitiveFilter
    },
    counts: {
      sources: (math.sources || []).length,
      source_areas: unique((math.sources || []).map((source) => source.area).filter(Boolean)).length,
      primitives: (math.math_primitives || []).length,
      categories: categories.length,
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
      missing_journeys: missingJourneys,
      covered_dimensions: coveredDimensions.length,
      missing_dimensions: missingDimensions,
      covered_open_requirements: openRequirementIds.filter((id) => coveredReadiness.includes(id)).length,
      missing_open_requirements: missingOpenRequirements,
      covered_metrics: coveredMetrics.length,
      missing_metrics: missingMetrics,
      covered_categories: coveredCategories.length,
      missing_categories: missingCategories,
      used_primitives: usedPrimitives.length,
      unused_primitives: unusedPrimitives,
      covered_portfolio_inventions: coveredPortfolio.length,
      missing_portfolio_inventions: missingPortfolio
    },
    simulation: {
      synthetic_metric_lift_cap: MAX_SYNTHETIC_METRIC_LIFT,
      synthetic_math_frontier_interaction_multiplier: MATH_FRONTIER_INTERACTION_MULTIPLIER,
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
    result.selected_inventions = selected.map((invention) => ({
      id: invention.id,
      category: invention.category,
      portfolio_invention_id: invention.portfolio_invention_id,
      primitive_refs: invention.primitive_refs,
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
