#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const atlasPath = path.join(ROOT, 'docs', 'product-research-atlas.json');
const graphPath = path.join(ROOT, 'public', 'product-graph.json');
const readinessPath = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const portfolioPath = path.join(ROOT, 'docs', 'product-invention-portfolio.json');

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const categoryArg = args.find((arg) => arg.startsWith('--category='));
const deltaArg = args.find((arg) => arg.startsWith('--delta='));
const sourceArg = args.find((arg) => arg.startsWith('--source='));
const metricArg = args.find((arg) => arg.startsWith('--metric='));
const categoryFilter = categoryArg ? categoryArg.slice('--category='.length) : null;
const deltaFilter = deltaArg ? deltaArg.slice('--delta='.length) : null;
const sourceFilter = sourceArg ? sourceArg.slice('--source='.length) : null;
const metricFilter = metricArg ? metricArg.slice('--metric='.length) : null;

const MAX_SYNTHETIC_METRIC_LIFT = 0.88;
const ATLAS_INTERACTION_MULTIPLIER = 1.25;

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

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

function validateShape(atlas, graph, readiness, portfolio, failures) {
  if (atlas.schema_version !== 'kolm-product-research-atlas-1') failures.push('unexpected schema_version');
  if (!Array.isArray(atlas.tracked_metrics) || atlas.tracked_metrics.length < 9) failures.push('tracked_metrics too thin');
  if (!Array.isArray(atlas.categories) || atlas.categories.length < 12) failures.push('categories too thin');
  if (!Array.isArray(atlas.sources) || atlas.sources.length < 28) failures.push('sources too thin');
  if (!Array.isArray(atlas.invention_deltas) || atlas.invention_deltas.length < 14) failures.push('invention_deltas too thin');

  const sourceIds = new Set();
  const sourceAreas = new Set();
  for (const source of atlas.sources || []) {
    if (!source.id || !/^[a-z0-9-]+$/.test(source.id)) failures.push(`bad source id: ${source.id || 'unknown'}`);
    if (sourceIds.has(source.id)) failures.push(`duplicate source id: ${source.id}`);
    sourceIds.add(source.id);
    if (!source.url || !/^https?:\/\//.test(source.url)) failures.push(`${source.id}: missing source url`);
    if (!hasText(source.lesson, 80)) failures.push(`${source.id}: lesson too thin`);
    if (source.area) sourceAreas.add(source.area);
  }
  if (sourceAreas.size < 12) failures.push(`source areas too thin: ${sourceAreas.size}`);

  const categoryIds = new Set(atlas.categories || []);
  const journeyIds = new Set((graph.journeys || []).map((journey) => journey.id));
  const dimensionIds = new Set((graph.dimensions || []).map((dimension) => dimension.id));
  const requirements = flattenRequirements(readiness);
  const readinessIds = new Set(requirements.map((requirement) => requirement.id));
  const metricIds = new Set(Object.keys(portfolio.metric_weights || {}));
  const portfolioIds = new Set((portfolio.inventions || []).map((invention) => invention.id));
  const deltaIds = new Set();

  for (const delta of atlas.invention_deltas || []) {
    if (!delta.id || !/^w600-[a-z0-9-]+$/.test(delta.id)) failures.push(`${delta.id || 'unknown'}: bad delta id`);
    if (deltaIds.has(delta.id)) failures.push(`${delta.id}: duplicate delta id`);
    deltaIds.add(delta.id);
    if (!categoryIds.has(delta.category)) failures.push(`${delta.id}: unknown category ${delta.category}`);
    if (!portfolioIds.has(delta.portfolio_invention_id)) failures.push(`${delta.id}: unknown portfolio_invention_id ${delta.portfolio_invention_id}`);
    if (!hasText(delta.title, 8)) failures.push(`${delta.id}: title too thin`);
    if (!hasText(delta.product_change, 120)) failures.push(`${delta.id}: product_change too thin`);

    const minimums = {
      research_refs: 3,
      journeys: 4,
      dimensions: 4,
      readiness: 4,
      metrics: 5,
      implementation_files: 5,
      build_steps: 5,
      acceptance_tests: 3,
      failure_modes: 3
    };
    for (const [field, min] of Object.entries(minimums)) {
      if (!Array.isArray(delta[field]) || delta[field].length < min) failures.push(`${delta.id}: ${field} too thin`);
    }
    if (!delta.expected_metric_lift || Object.keys(delta.expected_metric_lift).length < 5) failures.push(`${delta.id}: expected_metric_lift too thin`);

    for (const ref of delta.research_refs || []) if (!sourceIds.has(ref)) failures.push(`${delta.id}: unknown research_ref ${ref}`);
    for (const journey of delta.journeys || []) if (!journeyIds.has(journey)) failures.push(`${delta.id}: unknown journey ${journey}`);
    for (const dimension of delta.dimensions || []) if (!dimensionIds.has(dimension)) failures.push(`${delta.id}: unknown dimension ${dimension}`);
    for (const requirement of delta.readiness || []) if (!readinessIds.has(requirement)) failures.push(`${delta.id}: unknown readiness ${requirement}`);
    for (const metric of delta.metrics || []) if (!metricIds.has(metric)) failures.push(`${delta.id}: unknown metric ${metric}`);
    for (const metric of Object.keys(delta.expected_metric_lift || {})) if (!metricIds.has(metric)) failures.push(`${delta.id}: unknown metric lift ${metric}`);
    for (const relPath of delta.implementation_files || []) if (!fileExists(relPath)) failures.push(`${delta.id}: implementation file missing ${relPath}`);
  }
}

function simulate() {
  const atlas = readJson(atlasPath);
  const graph = readJson(graphPath);
  const readiness = readJson(readinessPath);
  const portfolio = readJson(portfolioPath);
  const failures = [];

  validateShape(atlas, graph, readiness, portfolio, failures);

  let selected = atlas.invention_deltas || [];
  if (categoryFilter) selected = selected.filter((delta) => delta.category === categoryFilter);
  if (deltaFilter) selected = selected.filter((delta) => delta.id === deltaFilter);
  if (sourceFilter) selected = selected.filter((delta) => (delta.research_refs || []).includes(sourceFilter));
  if (metricFilter) selected = selected.filter((delta) => (delta.metrics || []).includes(metricFilter));
  if (categoryFilter && selected.length === 0) failures.push(`unknown or empty category ${categoryFilter}`);
  if (deltaFilter && selected.length === 0) failures.push(`unknown delta ${deltaFilter}`);
  if (sourceFilter && selected.length === 0) failures.push(`unknown or unused source ${sourceFilter}`);
  if (metricFilter && selected.length === 0) failures.push(`unknown or uncovered metric ${metricFilter}`);

  const requirements = flattenRequirements(readiness);
  const openRequirementIds = unique(requirements.filter((req) => !['shipped', 'implemented'].includes(req.status)).map((req) => req.id));
  const journeyIds = (graph.journeys || []).map((journey) => journey.id);
  const dimensionIds = (graph.dimensions || []).map((dimension) => dimension.id);
  const metricIds = Object.keys(portfolio.metric_weights || {});
  const portfolioIds = (portfolio.inventions || []).map((invention) => invention.id);
  const categoryIds = atlas.categories || [];
  const sourceIds = (atlas.sources || []).map((source) => source.id);
  const allDeltas = atlas.invention_deltas || [];

  const coveredJourneys = unique(allDeltas.flatMap((delta) => delta.journeys || []));
  const coveredDimensions = unique(allDeltas.flatMap((delta) => delta.dimensions || []));
  const coveredReadiness = unique(allDeltas.flatMap((delta) => delta.readiness || []));
  const coveredMetrics = unique(allDeltas.flatMap((delta) => delta.metrics || []));
  const coveredCategories = unique(allDeltas.map((delta) => delta.category).filter(Boolean));
  const coveredPortfolio = unique(allDeltas.map((delta) => delta.portfolio_invention_id).filter(Boolean));
  const usedSources = unique(allDeltas.flatMap((delta) => delta.research_refs || []));

  const missingJourneys = journeyIds.filter((id) => !coveredJourneys.includes(id));
  const missingDimensions = dimensionIds.filter((id) => !coveredDimensions.includes(id));
  const missingOpenRequirements = openRequirementIds.filter((id) => !coveredReadiness.includes(id));
  const missingMetrics = metricIds.filter((id) => !coveredMetrics.includes(id));
  const missingCategories = categoryIds.filter((id) => !coveredCategories.includes(id));
  const missingPortfolio = portfolioIds.filter((id) => !coveredPortfolio.includes(id));
  const unusedSources = sourceIds.filter((id) => !usedSources.includes(id));

  const categoryCounts = Object.fromEntries(categoryIds.map((category) => [category, allDeltas.filter((delta) => delta.category === category).length]));
  const globalMode = !categoryFilter && !deltaFilter && !sourceFilter && !metricFilter;
  if (globalMode) {
    if (missingJourneys.length) failures.push(`missing journeys: ${missingJourneys.join(', ')}`);
    if (missingDimensions.length) failures.push(`missing dimensions: ${missingDimensions.join(', ')}`);
    if (missingOpenRequirements.length) failures.push(`open requirements not addressed: ${missingOpenRequirements.join(', ')}`);
    if (missingMetrics.length) failures.push(`missing metrics: ${missingMetrics.join(', ')}`);
    if (missingCategories.length) failures.push(`missing categories: ${missingCategories.join(', ')}`);
    if (missingPortfolio.length) failures.push(`missing portfolio inventions: ${missingPortfolio.join(', ')}`);
    if (unusedSources.length) failures.push(`unused sources: ${unusedSources.join(', ')}`);
  }

  const metricLift = {};
  for (const metric of metricIds) metricLift[metric] = 0;
  for (const delta of allDeltas) {
    for (const [metric, lift] of Object.entries(delta.expected_metric_lift || {})) {
      metricLift[metric] = Math.min(MAX_SYNTHETIC_METRIC_LIFT, Number(((metricLift[metric] || 0) + Number(lift) * ATLAS_INTERACTION_MULTIPLIER).toFixed(4)));
    }
  }
  const baseline = portfolio.baseline || {};
  const simulated = {};
  for (const metric of metricIds) {
    simulated[metric] = Number(Math.min(0.998, (baseline[metric] || 0) + metricLift[metric] * (1 - (baseline[metric] || 0))).toFixed(3));
  }
  const baselineComposite = composite(baseline, portfolio.metric_weights || {});
  const simulatedComposite = composite(simulated, portfolio.metric_weights || {});
  if (globalMode && simulatedComposite - baselineComposite < 0.26) failures.push(`research-atlas composite lift too low: ${simulatedComposite - baselineComposite}`);

  const result = {
    ok: failures.length === 0,
    note: 'Synthetic research-atlas smoke only. This validates current research coverage, invention depth, and product mapping; it is not benchmark evidence, package publication, external adoption, or certification.',
    filter: {
      category: categoryFilter,
      delta: deltaFilter,
      source: sourceFilter,
      metric: metricFilter
    },
    counts: {
      sources: sourceIds.length,
      source_areas: unique((atlas.sources || []).map((source) => source.area).filter(Boolean)).length,
      categories: categoryIds.length,
      invention_deltas: allDeltas.length,
      selected_deltas: selected.length,
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
      used_sources: usedSources.length,
      category_counts: categoryCounts,
      missing_journeys: missingJourneys,
      missing_dimensions: missingDimensions,
      missing_open_requirements: missingOpenRequirements,
      missing_metrics: missingMetrics,
      missing_categories: missingCategories,
      missing_portfolio_inventions: missingPortfolio,
      unused_sources: unusedSources
    },
    simulation: {
      synthetic_metric_lift_cap: MAX_SYNTHETIC_METRIC_LIFT,
      interaction_multiplier: ATLAS_INTERACTION_MULTIPLIER,
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
    result.invention_deltas = selected.map((delta) => ({
      id: delta.id,
      title: delta.title,
      category: delta.category,
      portfolio_invention_id: delta.portfolio_invention_id,
      research_refs: delta.research_refs,
      journeys: delta.journeys,
      dimensions: delta.dimensions,
      readiness: delta.readiness,
      metrics: delta.metrics,
      implementation_files: delta.implementation_files,
      acceptance_tests: delta.acceptance_tests
    }));
  }
  return result;
}

const result = simulate();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
