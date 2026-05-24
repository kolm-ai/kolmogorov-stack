#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const kernelsPath = path.join(ROOT, 'docs', 'product-frontier-operator-kernels.json');
const graphPath = path.join(ROOT, 'public', 'product-graph.json');
const readinessPath = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const portfolioPath = path.join(ROOT, 'docs', 'product-invention-portfolio.json');

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const kernelArg = args.find((arg) => arg.startsWith('--kernel='));
const categoryArg = args.find((arg) => arg.startsWith('--category='));
const sourceArg = args.find((arg) => arg.startsWith('--source='));
const metricArg = args.find((arg) => arg.startsWith('--metric='));
const journeyArg = args.find((arg) => arg.startsWith('--journey='));
const kernelFilter = kernelArg ? kernelArg.slice('--kernel='.length) : null;
const categoryFilter = categoryArg ? categoryArg.slice('--category='.length) : null;
const sourceFilter = sourceArg ? sourceArg.slice('--source='.length) : null;
const metricFilter = metricArg ? metricArg.slice('--metric='.length) : null;
const journeyFilter = journeyArg ? journeyArg.slice('--journey='.length) : null;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value != null).map(String))).sort();
}

function hasText(value, min) {
  return typeof value === 'string' && value.trim().length >= min;
}

function fileExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function flattenRequirements(readiness) {
  const out = [];
  for (const surface of readiness.surfaces || []) {
    for (const requirement of surface.requirements || []) out.push({ surface: surface.id, ...requirement });
  }
  return out;
}

function validateShape(spec, graph, readiness, portfolio, failures) {
  if (spec.schema_version !== 'kolm-product-frontier-operator-kernels-1') failures.push('unexpected schema_version');
  if (!Array.isArray(spec.tracked_metrics) || spec.tracked_metrics.length < 9) failures.push('tracked_metrics too thin');
  if (!Array.isArray(spec.categories) || spec.categories.length < 10) failures.push('categories too thin');
  if (!Array.isArray(spec.sources) || spec.sources.length < 20) failures.push('sources too thin');
  if (!Array.isArray(spec.operator_kernels) || spec.operator_kernels.length < 10) failures.push('operator_kernels too thin');

  const sourceIds = new Set();
  for (const source of spec.sources || []) {
    if (!source.id || !/^[a-z0-9-]+$/.test(source.id)) failures.push(`bad source id: ${source.id || 'unknown'}`);
    if (sourceIds.has(source.id)) failures.push(`duplicate source id: ${source.id}`);
    sourceIds.add(source.id);
    if (!source.url || !/^https?:\/\//.test(source.url)) failures.push(`${source.id || 'unknown'}: missing source url`);
    if (!hasText(source.lesson, 90)) failures.push(`${source.id || 'unknown'}: lesson too thin`);
  }

  const categoryIds = new Set(spec.categories || []);
  const journeyIds = new Set((graph.journeys || []).map((journey) => journey.id));
  const dimensionIds = new Set((graph.dimensions || []).map((dimension) => dimension.id));
  const readinessIds = new Set(flattenRequirements(readiness).map((requirement) => requirement.id));
  const metricIds = new Set(Object.keys(portfolio.metric_weights || {}));
  const portfolioIds = new Set((portfolio.inventions || []).map((invention) => invention.id));
  const kernelIds = new Set();

  for (const kernel of spec.operator_kernels || []) {
    if (!kernel.id || !/^w605-[a-z0-9-]+-kernel$/.test(kernel.id)) failures.push(`${kernel.id || 'unknown'}: bad kernel id`);
    if (kernelIds.has(kernel.id)) failures.push(`${kernel.id}: duplicate kernel id`);
    kernelIds.add(kernel.id);
    if (!categoryIds.has(kernel.category)) failures.push(`${kernel.id}: unknown category ${kernel.category}`);
    if (!portfolioIds.has(kernel.portfolio_invention_id)) failures.push(`${kernel.id}: unknown portfolio_invention_id ${kernel.portfolio_invention_id}`);
    if (!hasText(kernel.title, 10)) failures.push(`${kernel.id}: title too thin`);
    if (!hasText(kernel.thesis, 140)) failures.push(`${kernel.id}: thesis too thin`);
    const minimums = {
      source_refs: 3,
      journeys: 4,
      dimensions: 4,
      readiness: 4,
      metrics: 5,
      mathematical_primitives: 5,
      owner_files: 5,
      proposed_files: 3,
      api_routes: 2,
      cli_commands: 1,
      data_contracts: 2,
      build_steps: 6,
      smoke_tests: 2,
      failure_modes: 4,
    };
    for (const [field, min] of Object.entries(minimums)) {
      if (!Array.isArray(kernel[field]) || kernel[field].length < min) failures.push(`${kernel.id}: ${field} too thin`);
    }
    for (const ref of kernel.source_refs || []) if (!sourceIds.has(ref)) failures.push(`${kernel.id}: unknown source_ref ${ref}`);
    for (const journey of kernel.journeys || []) if (!journeyIds.has(journey)) failures.push(`${kernel.id}: unknown journey ${journey}`);
    for (const dimension of kernel.dimensions || []) if (!dimensionIds.has(dimension)) failures.push(`${kernel.id}: unknown dimension ${dimension}`);
    for (const requirement of kernel.readiness || []) if (!readinessIds.has(requirement)) failures.push(`${kernel.id}: unknown readiness ${requirement}`);
    for (const metric of kernel.metrics || []) if (!metricIds.has(metric)) failures.push(`${kernel.id}: unknown metric ${metric}`);
    for (const rel of kernel.owner_files || []) if (!fileExists(rel)) failures.push(`${kernel.id}: owner file missing ${rel}`);
    for (const [metric, lift] of Object.entries(kernel.expected_metric_lift || {})) {
      if (!metricIds.has(metric)) failures.push(`${kernel.id}: expected_metric_lift unknown metric ${metric}`);
      if (!(Number(lift) > 0 && Number(lift) <= 0.3)) failures.push(`${kernel.id}: expected_metric_lift ${metric} out of range`);
    }
  }
}

function selectKernels(spec) {
  let selected = spec.operator_kernels || [];
  if (kernelFilter) selected = selected.filter((kernel) => kernel.id === kernelFilter);
  if (categoryFilter) selected = selected.filter((kernel) => kernel.category === categoryFilter);
  if (sourceFilter) selected = selected.filter((kernel) => (kernel.source_refs || []).includes(sourceFilter));
  if (metricFilter) selected = selected.filter((kernel) => (kernel.metrics || []).includes(metricFilter));
  if (journeyFilter) selected = selected.filter((kernel) => (kernel.journeys || []).includes(journeyFilter));
  return selected;
}

function simulate() {
  const spec = readJson(kernelsPath);
  const graph = readJson(graphPath);
  const readiness = readJson(readinessPath);
  const portfolio = readJson(portfolioPath);
  const failures = [];
  validateShape(spec, graph, readiness, portfolio, failures);

  const selected = selectKernels(spec);
  if (kernelFilter && selected.length === 0) failures.push(`unknown kernel ${kernelFilter}`);
  if (categoryFilter && selected.length === 0) failures.push(`unknown or empty category ${categoryFilter}`);
  if (sourceFilter && selected.length === 0) failures.push(`unknown or unused source ${sourceFilter}`);
  if (metricFilter && selected.length === 0) failures.push(`unknown or uncovered metric ${metricFilter}`);
  if (journeyFilter && selected.length === 0) failures.push(`unknown or uncovered journey ${journeyFilter}`);

  const allKernels = spec.operator_kernels || [];
  const requirements = flattenRequirements(readiness);
  const openRequirementIds = unique(requirements.filter((req) => !['shipped', 'implemented'].includes(req.status)).map((req) => req.id));
  const journeyIds = (graph.journeys || []).map((journey) => journey.id);
  const dimensionIds = (graph.dimensions || []).map((dimension) => dimension.id);
  const metricIds = Object.keys(portfolio.metric_weights || {});
  const portfolioIds = (portfolio.inventions || []).map((invention) => invention.id);
  const categoryIds = spec.categories || [];
  const sourceIds = (spec.sources || []).map((source) => source.id);

  const coveredJourneys = unique(allKernels.flatMap((kernel) => kernel.journeys || []));
  const coveredDimensions = unique(allKernels.flatMap((kernel) => kernel.dimensions || []));
  const coveredReadiness = unique(allKernels.flatMap((kernel) => kernel.readiness || []));
  const coveredMetrics = unique(allKernels.flatMap((kernel) => kernel.metrics || []));
  const coveredCategories = unique(allKernels.map((kernel) => kernel.category).filter(Boolean));
  const coveredPortfolio = unique(allKernels.map((kernel) => kernel.portfolio_invention_id).filter(Boolean));
  const usedSources = unique(allKernels.flatMap((kernel) => kernel.source_refs || []));
  const missingJourneys = journeyIds.filter((id) => !coveredJourneys.includes(id));
  const missingDimensions = dimensionIds.filter((id) => !coveredDimensions.includes(id));
  const missingOpenRequirements = openRequirementIds.filter((id) => !coveredReadiness.includes(id));
  const missingMetrics = metricIds.filter((id) => !coveredMetrics.includes(id));
  const missingCategories = categoryIds.filter((id) => !coveredCategories.includes(id));
  const missingPortfolio = portfolioIds.filter((id) => !coveredPortfolio.includes(id));
  const unusedSources = sourceIds.filter((id) => !usedSources.includes(id));

  const globalMode = !kernelFilter && !categoryFilter && !sourceFilter && !metricFilter && !journeyFilter;
  if (globalMode) {
    if (missingJourneys.length) failures.push(`missing journeys: ${missingJourneys.join(', ')}`);
    if (missingDimensions.length) failures.push(`missing dimensions: ${missingDimensions.join(', ')}`);
    if (missingOpenRequirements.length) failures.push(`open requirements not addressed: ${missingOpenRequirements.join(', ')}`);
    if (missingMetrics.length) failures.push(`missing metrics: ${missingMetrics.join(', ')}`);
    if (missingCategories.length) failures.push(`missing categories: ${missingCategories.join(', ')}`);
    if (missingPortfolio.length) failures.push(`missing portfolio inventions: ${missingPortfolio.join(', ')}`);
    if (unusedSources.length) failures.push(`unused sources: ${unusedSources.join(', ')}`);
  }

  const metricLift = Object.fromEntries(metricIds.map((metric) => [metric, 0]));
  for (const kernel of allKernels) {
    for (const [metric, lift] of Object.entries(kernel.expected_metric_lift || {})) {
      metricLift[metric] = Math.min(0.85, Number(((metricLift[metric] || 0) + Number(lift) * 0.92).toFixed(4)));
    }
  }
  const baseline = portfolio.baseline || {};
  const simulated = {};
  for (const metric of metricIds) {
    simulated[metric] = Number(Math.min(0.995, (baseline[metric] || 0) + metricLift[metric] * (1 - (baseline[metric] || 0))).toFixed(3));
  }
  const weights = portfolio.metric_weights || {};
  const composite = (metrics) => Number(Object.entries(weights).reduce((sum, [metric, weight]) => sum + (metrics[metric] || 0) * weight, 0).toFixed(3));
  const baselineComposite = composite(baseline);
  const simulatedComposite = composite(simulated);
  const buildDepth = Number((allKernels.reduce((sum, kernel) => {
    const score = 0.1
      + Math.min(0.12, (kernel.source_refs || []).length * 0.025)
      + Math.min(0.12, (kernel.mathematical_primitives || []).length * 0.018)
      + Math.min(0.12, (kernel.build_steps || []).length * 0.016)
      + Math.min(0.1, (kernel.owner_files || []).length * 0.018)
      + Math.min(0.1, (kernel.proposed_files || []).length * 0.025)
      + Math.min(0.1, (kernel.data_contracts || []).length * 0.035)
      + Math.min(0.1, (kernel.smoke_tests || []).length * 0.035)
      + Math.min(0.1, (kernel.failure_modes || []).length * 0.02);
    return sum + Math.min(0.98, score);
  }, 0) / Math.max(1, allKernels.length)).toFixed(3));
  if (globalMode && buildDepth < 0.68) failures.push(`build depth too low: ${buildDepth}`);
  if (globalMode && (simulatedComposite - baselineComposite) < 0.2) failures.push(`synthetic composite delta too low: ${simulatedComposite - baselineComposite}`);

  const result = {
    ok: failures.length === 0,
    note: 'Synthetic operator-kernel smoke only. This validates research-backed build plans and simulated metric lift; it does not prove external adoption, package publication, public benchmark data, live certifications, or real benchmark wins.',
    filter: {
      kernel: kernelFilter,
      category: categoryFilter,
      source: sourceFilter,
      metric: metricFilter,
      journey: journeyFilter
    },
    counts: {
      sources: sourceIds.length,
      source_areas: unique((spec.sources || []).map((source) => source.area)).length,
      categories: categoryIds.length,
      kernels: allKernels.length,
      selected_kernels: selected.length,
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
      missing_journeys: missingJourneys,
      missing_dimensions: missingDimensions,
      missing_open_requirements: missingOpenRequirements,
      missing_metrics: missingMetrics,
      missing_categories: missingCategories,
      missing_portfolio_inventions: missingPortfolio,
      unused_sources: unusedSources
    },
    simulation: {
      build_depth: buildDepth,
      baseline_composite: baselineComposite,
      simulated_composite: simulatedComposite,
      composite_delta: Number((simulatedComposite - baselineComposite).toFixed(3)),
      metric_lift: metricLift,
      baseline,
      simulated
    },
    failures
  };

  if (!summary) {
    result.operator_kernels = selected.map((kernel) => ({
      id: kernel.id,
      title: kernel.title,
      category: kernel.category,
      portfolio_invention_id: kernel.portfolio_invention_id,
      source_refs: kernel.source_refs,
      journeys: kernel.journeys,
      dimensions: kernel.dimensions,
      readiness: kernel.readiness,
      metrics: kernel.metrics,
      mathematical_primitives: kernel.mathematical_primitives,
      owner_files: kernel.owner_files,
      proposed_files: kernel.proposed_files,
      api_routes: kernel.api_routes,
      cli_commands: kernel.cli_commands,
      data_contracts: kernel.data_contracts,
      smoke_tests: kernel.smoke_tests,
      failure_modes: kernel.failure_modes
    }));
  }
  return result;
}

const result = simulate();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
