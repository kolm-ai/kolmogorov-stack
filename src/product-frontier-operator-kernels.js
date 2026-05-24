import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCT_FRONTIER_OPERATOR_KERNELS_SPEC = 'kolm-product-frontier-operator-kernels-contract-1';

export const PRODUCT_FRONTIER_OPERATOR_KERNELS_SOURCE_PATHS = [
  'src/product-frontier-operator-kernels.js',
  'docs/product-frontier-operator-kernels.json',
  'docs/research/product-frontier-operator-kernels-2026-05-23.md',
  'scripts/simulate-product-frontier-operator-kernels.cjs',
  'tests/wave605-product-frontier-operator-kernels.test.js',
  'tests/wave606-product-frontier-operator-kernels-api.test.js',
];

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value != null).map(String))).sort();
}

function hasText(value, min) {
  return typeof value === 'string' && value.trim().length >= min;
}

function fileExists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

function flattenRequirements(readiness) {
  const out = [];
  for (const surface of readiness.surfaces || []) {
    for (const requirement of surface.requirements || []) out.push({ surface: surface.id, ...requirement });
  }
  return out;
}

function selectKernels(kernels, filters) {
  let selected = kernels || [];
  if (filters.kernel) selected = selected.filter((kernel) => kernel.id === filters.kernel);
  if (filters.category) selected = selected.filter((kernel) => kernel.category === filters.category);
  if (filters.source) selected = selected.filter((kernel) => (kernel.source_refs || []).includes(filters.source));
  if (filters.metric) selected = selected.filter((kernel) => (kernel.metrics || []).includes(filters.metric));
  if (filters.journey) selected = selected.filter((kernel) => (kernel.journeys || []).includes(filters.journey));
  return selected;
}

function validateOperatorKernels(root, spec, graph, readiness, portfolio) {
  const failures = [];
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
    for (const rel of kernel.owner_files || []) if (!fileExists(root, rel)) failures.push(`${kernel.id}: owner file missing ${rel}`);
    for (const [metric, lift] of Object.entries(kernel.expected_metric_lift || {})) {
      if (!metricIds.has(metric)) failures.push(`${kernel.id}: expected_metric_lift unknown metric ${metric}`);
      if (!(Number(lift) > 0 && Number(lift) <= 0.3)) failures.push(`${kernel.id}: expected_metric_lift ${metric} out of range`);
    }
  }
  return failures;
}

function scoreKernels(kernels, portfolio) {
  const metricIds = Object.keys(portfolio.metric_weights || {});
  const metricLift = Object.fromEntries(metricIds.map((metric) => [metric, 0]));
  for (const kernel of kernels) {
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
  const buildDepth = Number((kernels.reduce((sum, kernel) => {
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
  }, 0) / Math.max(1, kernels.length)).toFixed(3));
  const baselineComposite = composite(baseline);
  const simulatedComposite = composite(simulated);
  return {
    build_depth: buildDepth,
    baseline_composite: baselineComposite,
    simulated_composite: simulatedComposite,
    composite_delta: Number((simulatedComposite - baselineComposite).toFixed(3)),
    metric_lift: metricLift,
    baseline,
    simulated,
  };
}

export function buildProductFrontierOperatorKernels(options = {}) {
  const root = options.root || MODULE_ROOT;
  const filters = {
    kernel: options.kernel || null,
    category: options.category || null,
    source: options.source || null,
    metric: options.metric || null,
    journey: options.journey || null,
  };
  const spec = readJson(root, 'docs/product-frontier-operator-kernels.json');
  const graph = readJson(root, 'public/product-graph.json');
  const readiness = readJson(root, 'docs/product-sota-readiness.json');
  const portfolio = readJson(root, 'docs/product-invention-portfolio.json');
  const failures = validateOperatorKernels(root, spec, graph, readiness, portfolio);
  const selected = selectKernels(spec.operator_kernels || [], filters);
  if (filters.kernel && selected.length === 0) failures.push(`unknown kernel ${filters.kernel}`);
  if (filters.category && selected.length === 0) failures.push(`unknown or empty category ${filters.category}`);
  if (filters.source && selected.length === 0) failures.push(`unknown or unused source ${filters.source}`);
  if (filters.metric && selected.length === 0) failures.push(`unknown or uncovered metric ${filters.metric}`);
  if (filters.journey && selected.length === 0) failures.push(`unknown or uncovered journey ${filters.journey}`);

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
  const globalMode = !filters.kernel && !filters.category && !filters.source && !filters.metric && !filters.journey;
  if (globalMode) {
    if (missingJourneys.length) failures.push(`missing journeys: ${missingJourneys.join(', ')}`);
    if (missingDimensions.length) failures.push(`missing dimensions: ${missingDimensions.join(', ')}`);
    if (missingOpenRequirements.length) failures.push(`open requirements not addressed: ${missingOpenRequirements.join(', ')}`);
    if (missingMetrics.length) failures.push(`missing metrics: ${missingMetrics.join(', ')}`);
    if (missingCategories.length) failures.push(`missing categories: ${missingCategories.join(', ')}`);
    if (missingPortfolio.length) failures.push(`missing portfolio inventions: ${missingPortfolio.join(', ')}`);
    if (unusedSources.length) failures.push(`unused sources: ${unusedSources.join(', ')}`);
  }
  const simulation = scoreKernels(allKernels, portfolio);
  if (globalMode && simulation.build_depth < 0.68) failures.push(`build depth too low: ${simulation.build_depth}`);
  if (globalMode && simulation.composite_delta < 0.2) failures.push(`synthetic composite delta too low: ${simulation.composite_delta}`);

  const ok = failures.length === 0;
  return {
    spec: PRODUCT_FRONTIER_OPERATOR_KERNELS_SPEC,
    schema_version: spec.schema_version,
    ok,
    local_contract_ok: ok,
    external_ready: false,
    readiness_status: ok ? 'implemented' : 'blocked',
    secret_values_included: false,
    updated_at: spec.updated_at || null,
    note: 'Runtime surface for W605 operator kernels. It exposes build-ready backend kernels; it is not external adoption, package publication, public benchmark evidence, certification, or real benchmark proof.',
    filter: filters,
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
    simulation,
    selected_kernels: selected.map((kernel) => ({
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
      build_steps: kernel.build_steps,
      smoke_tests: kernel.smoke_tests,
      failure_modes: kernel.failure_modes,
      expected_metric_lift: kernel.expected_metric_lift,
    })),
    failures,
    evidence: {
      source_paths: PRODUCT_FRONTIER_OPERATOR_KERNELS_SOURCE_PATHS,
    },
    next_actions: [
      {
        kind: 'command',
        label: 'Verify operator kernel contracts',
        value: 'npm run verify:operator-kernels',
        surface: 'public-docs-sdk',
        journey: 'compile-verify',
        priority: 'P0',
      },
    ],
  };
}
