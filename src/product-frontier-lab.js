import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCT_FRONTIER_LAB_SPEC = 'kolm-product-frontier-lab-contract-1';

export const PRODUCT_FRONTIER_LAB_SOURCE_PATHS = [
  'src/product-frontier-lab.js',
  'docs/product-frontier-lab.json',
  'docs/research/product-frontier-lab-2026-05-23.md',
  'scripts/simulate-product-frontier-lab.cjs',
  'tests/wave601-product-frontier-lab.test.js',
  'tests/wave602-product-frontier-lab-api.test.js',
  'docs/product-frontier-implementation-contracts.json',
  'docs/research/product-frontier-implementation-contracts-2026-05-23.md',
  'scripts/simulate-product-frontier-implementation-contracts.cjs',
  'tests/wave603-product-frontier-implementation-contracts.test.js',
];

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SYNTHETIC_METRIC_LIFT = 0.9;
const FRONTIER_INTERACTION_MULTIPLIER = 1.28;

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value != null).map(String))).sort();
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

function fileExists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

function validateLabShape(root, lab, graph, readiness, portfolio) {
  const failures = [];
  if (lab.schema_version !== 'kolm-product-frontier-lab-1') failures.push('unexpected schema_version');
  if (!Array.isArray(lab.tracked_metrics) || lab.tracked_metrics.length < 9) failures.push('tracked_metrics too thin');
  if (!Array.isArray(lab.categories) || lab.categories.length < 14) failures.push('categories too thin');
  if (!Array.isArray(lab.sources) || lab.sources.length < 30) failures.push('sources too thin');
  if (!Array.isArray(lab.experiments) || lab.experiments.length < 14) failures.push('experiments too thin');

  const sourceIds = new Set();
  for (const source of lab.sources || []) {
    if (!source.id || !/^[a-z0-9-]+$/.test(source.id)) failures.push(`bad source id: ${source.id || 'unknown'}`);
    if (sourceIds.has(source.id)) failures.push(`duplicate source id: ${source.id}`);
    sourceIds.add(source.id);
    if (!source.url || !/^https?:\/\//.test(source.url)) failures.push(`${source.id || 'unknown'}: missing source url`);
    if (!hasText(source.lesson, 80)) failures.push(`${source.id || 'unknown'}: lesson too thin`);
  }

  const categoryIds = new Set(lab.categories || []);
  const journeyIds = new Set((graph.journeys || []).map((journey) => journey.id));
  const dimensionIds = new Set((graph.dimensions || []).map((dimension) => dimension.id));
  const readinessIds = new Set(flattenRequirements(readiness).map((requirement) => requirement.id));
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
    for (const [field, min] of Object.entries({
      source_refs: 3,
      journeys: 4,
      dimensions: 4,
      readiness: 4,
      metrics: 5,
      implementation_files: 5,
      procedure: 6,
      acceptance_tests: 3,
      kill_criteria: 3,
    })) {
      if (!Array.isArray(experiment[field]) || experiment[field].length < min) failures.push(`${experiment.id}: ${field} too thin`);
    }
    for (const ref of experiment.source_refs || []) if (!sourceIds.has(ref)) failures.push(`${experiment.id}: unknown source_ref ${ref}`);
    for (const journey of experiment.journeys || []) if (!journeyIds.has(journey)) failures.push(`${experiment.id}: unknown journey ${journey}`);
    for (const dimension of experiment.dimensions || []) if (!dimensionIds.has(dimension)) failures.push(`${experiment.id}: unknown dimension ${dimension}`);
    for (const requirement of experiment.readiness || []) if (!readinessIds.has(requirement)) failures.push(`${experiment.id}: unknown readiness ${requirement}`);
    for (const metric of experiment.metrics || []) if (!metricIds.has(metric)) failures.push(`${experiment.id}: unknown metric ${metric}`);
    for (const rel of experiment.implementation_files || []) if (!fileExists(root, rel)) failures.push(`${experiment.id}: implementation file missing ${rel}`);
  }

  return failures;
}

function selectedExperiments(lab, filters) {
  let selected = lab.experiments || [];
  if (filters.category) selected = selected.filter((experiment) => experiment.category === filters.category);
  if (filters.experiment) selected = selected.filter((experiment) => experiment.id === filters.experiment);
  if (filters.source) selected = selected.filter((experiment) => (experiment.source_refs || []).includes(filters.source));
  if (filters.metric) selected = selected.filter((experiment) => (experiment.metrics || []).includes(filters.metric));
  return selected;
}

export function buildProductFrontierLab(options = {}) {
  const root = options.root || MODULE_ROOT;
  const filters = {
    category: options.category || null,
    experiment: options.experiment || null,
    source: options.source || null,
    metric: options.metric || null,
  };
  const lab = readJson(root, 'docs/product-frontier-lab.json');
  const graph = readJson(root, 'public/product-graph.json');
  const readiness = readJson(root, 'docs/product-sota-readiness.json');
  const portfolio = readJson(root, 'docs/product-invention-portfolio.json');
  const failures = validateLabShape(root, lab, graph, readiness, portfolio);
  const selected = selectedExperiments(lab, filters);
  if (filters.category && selected.length === 0) failures.push(`unknown or empty category ${filters.category}`);
  if (filters.experiment && selected.length === 0) failures.push(`unknown experiment ${filters.experiment}`);
  if (filters.source && selected.length === 0) failures.push(`unknown or unused source ${filters.source}`);
  if (filters.metric && selected.length === 0) failures.push(`unknown or uncovered metric ${filters.metric}`);

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
  const globalMode = !filters.category && !filters.experiment && !filters.source && !filters.metric;
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
  for (const experiment of allExperiments) {
    for (const [metric, lift] of Object.entries(experiment.expected_metric_lift || {})) {
      metricLift[metric] = Math.min(MAX_SYNTHETIC_METRIC_LIFT, Number(((metricLift[metric] || 0) + Number(lift) * FRONTIER_INTERACTION_MULTIPLIER).toFixed(4)));
    }
  }
  const baseline = portfolio.baseline || {};
  const simulated = {};
  for (const metric of metricIds) simulated[metric] = Number(Math.min(0.998, (baseline[metric] || 0) + metricLift[metric] * (1 - (baseline[metric] || 0))).toFixed(3));
  const baselineComposite = composite(baseline, portfolio.metric_weights || {});
  const simulatedComposite = composite(simulated, portfolio.metric_weights || {});
  const localContractOk = failures.length === 0;

  return {
    spec: PRODUCT_FRONTIER_LAB_SPEC,
    ok: localContractOk,
    local_contract_ok: localContractOk,
    external_ready: false,
    readiness_status: localContractOk ? 'implemented' : 'blocked',
    secret_values_included: false,
    updated_at: lab.updated_at || null,
    note: 'Synthetic frontier-lab contract. It validates research coverage, experiment depth, product mapping, and implementation handoff; it is not package publication, external adoption, public benchmark evidence, or certification.',
    filter: filters,
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
      portfolio_inventions: portfolioIds.length,
      failures: failures.length,
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
      unused_sources: unusedSources,
    },
    simulation: {
      synthetic_metric_lift_cap: MAX_SYNTHETIC_METRIC_LIFT,
      interaction_multiplier: FRONTIER_INTERACTION_MULTIPLIER,
      baseline_composite: baselineComposite,
      simulated_composite: simulatedComposite,
      composite_delta: Number((simulatedComposite - baselineComposite).toFixed(3)),
      baseline,
      simulated,
      metric_lift: metricLift,
    },
    selected_experiments: selected.map((experiment) => ({
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
      acceptance_tests: experiment.acceptance_tests,
    })),
    failures,
    evidence: {
      source_paths: PRODUCT_FRONTIER_LAB_SOURCE_PATHS,
    },
    next_actions: [
      {
        kind: 'command',
        label: 'Verify frontier lab',
        value: 'npm run verify:frontier-lab',
        surface: 'public-docs-sdk',
        journey: 'compile-verify',
        priority: 'P0',
      },
    ],
  };
}

export default buildProductFrontierLab;
