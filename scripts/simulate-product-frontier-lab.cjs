#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const labPath = path.join(ROOT, 'docs', 'product-frontier-lab.json');
const graphPath = path.join(ROOT, 'public', 'product-graph.json');
const readinessPath = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const portfolioPath = path.join(ROOT, 'docs', 'product-invention-portfolio.json');

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const categoryArg = args.find((arg) => arg.startsWith('--category='));
const experimentArg = args.find((arg) => arg.startsWith('--experiment='));
const sourceArg = args.find((arg) => arg.startsWith('--source='));
const metricArg = args.find((arg) => arg.startsWith('--metric='));
const categoryFilter = categoryArg ? categoryArg.slice('--category='.length) : null;
const experimentFilter = experimentArg ? experimentArg.slice('--experiment='.length) : null;
const sourceFilter = sourceArg ? sourceArg.slice('--source='.length) : null;
const metricFilter = metricArg ? metricArg.slice('--metric='.length) : null;

const MAX_SYNTHETIC_METRIC_LIFT = 0.9;
const FRONTIER_INTERACTION_MULTIPLIER = 1.28;

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

function validateShape(lab, graph, readiness, portfolio, failures) {
  if (lab.schema_version !== 'kolm-product-frontier-lab-1') failures.push('unexpected schema_version');
  if (!Array.isArray(lab.tracked_metrics) || lab.tracked_metrics.length < 9) failures.push('tracked_metrics too thin');
  if (!Array.isArray(lab.categories) || lab.categories.length < 14) failures.push('categories too thin');
  if (!Array.isArray(lab.sources) || lab.sources.length < 30) failures.push('sources too thin');
  if (!Array.isArray(lab.experiments) || lab.experiments.length < 14) failures.push('experiments too thin');

  const sourceIds = new Set();
  const sourceAreas = new Set();
  for (const source of lab.sources || []) {
    if (!source.id || !/^[a-z0-9-]+$/.test(source.id)) failures.push(`bad source id: ${source.id || 'unknown'}`);
    if (sourceIds.has(source.id)) failures.push(`duplicate source id: ${source.id}`);
    sourceIds.add(source.id);
    if (!source.url || !/^https?:\/\//.test(source.url)) failures.push(`${source.id}: missing source url`);
    if (!hasText(source.lesson, 80)) failures.push(`${source.id}: lesson too thin`);
    if (source.area) sourceAreas.add(source.area);
  }
  if (sourceAreas.size < 12) failures.push(`source areas too thin: ${sourceAreas.size}`);

  const categoryIds = new Set(lab.categories || []);
  const journeyIds = new Set((graph.journeys || []).map((journey) => journey.id));
  const dimensionIds = new Set((graph.dimensions || []).map((dimension) => dimension.id));
  const requirements = flattenRequirements(readiness);
  const readinessIds = new Set(requirements.map((requirement) => requirement.id));
  const metricIds = new Set(Object.keys(portfolio.metric_weights || {}));
  const portfolioIds = new Set((portfolio.inventions || []).map((invention) => invention.id));
  const experimentIds = new Set();

  for (const experiment of lab.experiments || []) {
    if (!experiment.id || !/^w601-[a-z0-9-]+$/.test(experiment.id)) failures.push(`${experiment.id || 'unknown'}: bad experiment id`);
    if (experimentIds.has(experiment.id)) failures.push(`${experiment.id}: duplicate experiment id`);
    experimentIds.add(experiment.id);
    if (!categoryIds.has(experiment.category)) failures.push(`${experiment.id}: unknown category ${experiment.category}`);
    if (!portfolioIds.has(experiment.portfolio_invention_id)) failures.push(`${experiment.id}: unknown portfolio_invention_id ${experiment.portfolio_invention_id}`);
    if (!hasText(experiment.title, 8)) failures.push(`${experiment.id}: title too thin`);
    if (!hasText(experiment.hypothesis, 140)) failures.push(`${experiment.id}: hypothesis too thin`);

    const minimums = {
      source_refs: 3,
      journeys: 4,
      dimensions: 4,
      readiness: 4,
      metrics: 5,
      implementation_files: 5,
      procedure: 6,
      acceptance_tests: 3,
      kill_criteria: 3
    };
    for (const [field, min] of Object.entries(minimums)) {
      if (!Array.isArray(experiment[field]) || experiment[field].length < min) failures.push(`${experiment.id}: ${field} too thin`);
    }
    if (!experiment.expected_metric_lift || Object.keys(experiment.expected_metric_lift).length < 5) failures.push(`${experiment.id}: expected_metric_lift too thin`);

    for (const ref of experiment.source_refs || []) if (!sourceIds.has(ref)) failures.push(`${experiment.id}: unknown source_ref ${ref}`);
    for (const journey of experiment.journeys || []) if (!journeyIds.has(journey)) failures.push(`${experiment.id}: unknown journey ${journey}`);
    for (const dimension of experiment.dimensions || []) if (!dimensionIds.has(dimension)) failures.push(`${experiment.id}: unknown dimension ${dimension}`);
    for (const requirement of experiment.readiness || []) if (!readinessIds.has(requirement)) failures.push(`${experiment.id}: unknown readiness ${requirement}`);
    for (const metric of experiment.metrics || []) if (!metricIds.has(metric)) failures.push(`${experiment.id}: unknown metric ${metric}`);
    for (const metric of Object.keys(experiment.expected_metric_lift || {})) if (!metricIds.has(metric)) failures.push(`${experiment.id}: unknown metric lift ${metric}`);
    for (const relPath of experiment.implementation_files || []) if (!fileExists(relPath)) failures.push(`${experiment.id}: implementation file missing ${relPath}`);
  }
}

function simulate() {
  const lab = readJson(labPath);
  const graph = readJson(graphPath);
  const readiness = readJson(readinessPath);
  const portfolio = readJson(portfolioPath);
  const failures = [];

  validateShape(lab, graph, readiness, portfolio, failures);

  let selected = lab.experiments || [];
  if (categoryFilter) selected = selected.filter((experiment) => experiment.category === categoryFilter);
  if (experimentFilter) selected = selected.filter((experiment) => experiment.id === experimentFilter);
  if (sourceFilter) selected = selected.filter((experiment) => (experiment.source_refs || []).includes(sourceFilter));
  if (metricFilter) selected = selected.filter((experiment) => (experiment.metrics || []).includes(metricFilter));
  if (categoryFilter && selected.length === 0) failures.push(`unknown or empty category ${categoryFilter}`);
  if (experimentFilter && selected.length === 0) failures.push(`unknown experiment ${experimentFilter}`);
  if (sourceFilter && selected.length === 0) failures.push(`unknown or unused source ${sourceFilter}`);
  if (metricFilter && selected.length === 0) failures.push(`unknown or uncovered metric ${metricFilter}`);

  const requirements = flattenRequirements(readiness);
  const openRequirementIds = unique(requirements.filter((req) => !['shipped', 'implemented'].includes(req.status)).map((req) => req.id));
  const journeyIds = (graph.journeys || []).map((journey) => journey.id);
  const dimensionIds = (graph.dimensions || []).map((dimension) => dimension.id);
  const metricIds = Object.keys(portfolio.metric_weights || {});
  const portfolioIds = (portfolio.inventions || []).map((invention) => invention.id);
  const categoryIds = lab.categories || [];
  const sourceIds = (lab.sources || []).map((source) => source.id);
  const allExperiments = lab.experiments || [];

  const coveredJourneys = unique(allExperiments.flatMap((experiment) => experiment.journeys || []));
  const coveredDimensions = unique(allExperiments.flatMap((experiment) => experiment.dimensions || []));
  const coveredReadiness = unique(allExperiments.flatMap((experiment) => experiment.readiness || []));
  const coveredMetrics = unique(allExperiments.flatMap((experiment) => experiment.metrics || []));
  const coveredCategories = unique(allExperiments.map((experiment) => experiment.category).filter(Boolean));
  const coveredPortfolio = unique(allExperiments.map((experiment) => experiment.portfolio_invention_id).filter(Boolean));
  const usedSources = unique(allExperiments.flatMap((experiment) => experiment.source_refs || []));

  const missingJourneys = journeyIds.filter((id) => !coveredJourneys.includes(id));
  const missingDimensions = dimensionIds.filter((id) => !coveredDimensions.includes(id));
  const missingOpenRequirements = openRequirementIds.filter((id) => !coveredReadiness.includes(id));
  const missingMetrics = metricIds.filter((id) => !coveredMetrics.includes(id));
  const missingCategories = categoryIds.filter((id) => !coveredCategories.includes(id));
  const missingPortfolio = portfolioIds.filter((id) => !coveredPortfolio.includes(id));
  const unusedSources = sourceIds.filter((id) => !usedSources.includes(id));

  const categoryCounts = Object.fromEntries(categoryIds.map((category) => [category, allExperiments.filter((experiment) => experiment.category === category).length]));
  const globalMode = !categoryFilter && !experimentFilter && !sourceFilter && !metricFilter;
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
  for (const experiment of allExperiments) {
    for (const [metric, lift] of Object.entries(experiment.expected_metric_lift || {})) {
      metricLift[metric] = Math.min(MAX_SYNTHETIC_METRIC_LIFT, Number(((metricLift[metric] || 0) + Number(lift) * FRONTIER_INTERACTION_MULTIPLIER).toFixed(4)));
    }
  }
  const baseline = portfolio.baseline || {};
  const simulated = {};
  for (const metric of metricIds) {
    simulated[metric] = Number(Math.min(0.998, (baseline[metric] || 0) + metricLift[metric] * (1 - (baseline[metric] || 0))).toFixed(3));
  }
  const baselineComposite = composite(baseline, portfolio.metric_weights || {});
  const simulatedComposite = composite(simulated, portfolio.metric_weights || {});
  if (globalMode && simulatedComposite - baselineComposite < 0.28) failures.push(`frontier-lab composite lift too low: ${simulatedComposite - baselineComposite}`);

  const result = {
    ok: failures.length === 0,
    note: 'Synthetic frontier-lab smoke only. This validates research coverage, experiment depth, product mapping, and readiness-gate planning; it is not public benchmark evidence, package publication, external adoption, or certification.',
    filter: {
      category: categoryFilter,
      experiment: experimentFilter,
      source: sourceFilter,
      metric: metricFilter
    },
    counts: {
      sources: sourceIds.length,
      source_areas: unique((lab.sources || []).map((source) => source.area).filter(Boolean)).length,
      categories: categoryIds.length,
      experiments: allExperiments.length,
      selected_experiments: selected.length,
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
      interaction_multiplier: FRONTIER_INTERACTION_MULTIPLIER,
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
    result.experiments = selected.map((experiment) => ({
      id: experiment.id,
      title: experiment.title,
      category: experiment.category,
      portfolio_invention_id: experiment.portfolio_invention_id,
      source_refs: experiment.source_refs,
      journeys: experiment.journeys,
      dimensions: experiment.dimensions,
      readiness: experiment.readiness,
      metrics: experiment.metrics,
      implementation_files: experiment.implementation_files,
      acceptance_tests: experiment.acceptance_tests
    }));
  }
  return result;
}

const result = simulate();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
