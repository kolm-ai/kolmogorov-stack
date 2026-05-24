import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCT_FRONTIER_IMPLEMENTATION_CONTRACTS_SPEC = 'kolm-product-frontier-implementation-contracts-contract-1';

export const PRODUCT_FRONTIER_IMPLEMENTATION_CONTRACTS_SOURCE_PATHS = [
  'src/product-frontier-contracts.js',
  'docs/product-frontier-implementation-contracts.json',
  'docs/research/product-frontier-implementation-contracts-2026-05-23.md',
  'scripts/simulate-product-frontier-implementation-contracts.cjs',
  'tests/wave603-product-frontier-implementation-contracts.test.js',
  'tests/wave604-product-frontier-contracts-api.test.js',
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

function selectedContracts(contracts, experimentById, filters) {
  let selected = contracts || [];
  if (filters.contract) selected = selected.filter((contract) => contract.id === filters.contract);
  if (filters.experiment) selected = selected.filter((contract) => contract.experiment_id === filters.experiment);
  if (filters.category) selected = selected.filter((contract) => experimentById.get(contract.experiment_id)?.category === filters.category);
  if (filters.source) selected = selected.filter((contract) => (contract.research_refs || []).includes(filters.source));
  if (filters.metric) {
    selected = selected.filter((contract) => {
      const experiment = experimentById.get(contract.experiment_id);
      return (contract.tracked_metrics || []).includes(filters.metric) || (experiment?.metrics || []).includes(filters.metric);
    });
  }
  return selected;
}

function validateContracts(root, spec, lab, graph, readiness, portfolio) {
  const failures = [];
  if (spec.schema_version !== 'kolm-product-frontier-implementation-contracts-1') failures.push('unexpected schema_version');
  if (!Array.isArray(spec.implementation_research) || spec.implementation_research.length < 12) failures.push('implementation_research too thin');
  if (!Array.isArray(spec.contracts) || spec.contracts.length < (lab.experiments || []).length) failures.push('contracts do not cover lab experiments');

  const researchIds = new Set();
  for (const source of spec.implementation_research || []) {
    if (!source.id || !/^[a-z0-9-]+$/.test(source.id)) failures.push(`bad research id: ${source.id || 'unknown'}`);
    if (researchIds.has(source.id)) failures.push(`duplicate research id: ${source.id}`);
    researchIds.add(source.id);
    if (!source.url || !/^https?:\/\//.test(source.url)) failures.push(`${source.id || 'unknown'}: missing url`);
    if (!hasText(source.lesson, 90)) failures.push(`${source.id || 'unknown'}: lesson too thin`);
  }

  const experimentById = new Map((lab.experiments || []).map((experiment) => [experiment.id, experiment]));
  const journeyIds = new Set((graph.journeys || []).map((journey) => journey.id));
  const dimensionIds = new Set((graph.dimensions || []).map((dimension) => dimension.id));
  const readinessIds = new Set(flattenRequirements(readiness).map((requirement) => requirement.id));
  const metricIds = new Set(Object.keys(portfolio.metric_weights || {}));
  const categoryIds = new Set(lab.categories || []);
  const portfolioIds = new Set((portfolio.inventions || []).map((invention) => invention.id));
  const contractIds = new Set();

  for (const contract of spec.contracts || []) {
    if (!contract.id || !/^w603-[a-z0-9-]+-contract$/.test(contract.id)) failures.push(`${contract.id || 'unknown'}: bad contract id`);
    if (contractIds.has(contract.id)) failures.push(`${contract.id}: duplicate contract id`);
    contractIds.add(contract.id);
    const experiment = experimentById.get(contract.experiment_id);
    if (!experiment) failures.push(`${contract.id}: unknown experiment_id ${contract.experiment_id}`);
    if (!hasText(contract.title, 10)) failures.push(`${contract.id}: title too thin`);
    for (const ref of contract.research_refs || []) if (!researchIds.has(ref)) failures.push(`${contract.id}: unknown research_ref ${ref}`);
    for (const rel of contract.current_files || []) if (!fileExists(root, rel)) failures.push(`${contract.id}: current file missing ${rel}`);
    for (const entrypoint of contract.entrypoints || []) {
      if (!hasText(entrypoint.name, 8)) failures.push(`${contract.id}: entrypoint name too thin`);
      if (!hasText(entrypoint.input_contract, 20)) failures.push(`${contract.id}: entrypoint input_contract too thin`);
      if (!hasText(entrypoint.output_contract, 20)) failures.push(`${contract.id}: entrypoint output_contract too thin`);
    }
    if (!contract.smoke_fixture || !contract.smoke_fixture.input || !contract.smoke_fixture.expected) failures.push(`${contract.id}: smoke_fixture incomplete`);
    for (const metric of contract.tracked_metrics || []) if (!metricIds.has(metric)) failures.push(`${contract.id}: unknown tracked_metric ${metric}`);
    if (experiment) {
      if (!categoryIds.has(experiment.category)) failures.push(`${contract.id}: experiment has unknown category ${experiment.category}`);
      if (!portfolioIds.has(experiment.portfolio_invention_id)) failures.push(`${contract.id}: experiment has unknown portfolio ${experiment.portfolio_invention_id}`);
      for (const journey of experiment.journeys || []) if (!journeyIds.has(journey)) failures.push(`${contract.id}: experiment has unknown journey ${journey}`);
      for (const dimension of experiment.dimensions || []) if (!dimensionIds.has(dimension)) failures.push(`${contract.id}: experiment has unknown dimension ${dimension}`);
      for (const requirement of experiment.readiness || []) if (!readinessIds.has(requirement)) failures.push(`${contract.id}: experiment has unknown readiness ${requirement}`);
      for (const metric of experiment.metrics || []) if (!metricIds.has(metric)) failures.push(`${contract.id}: experiment has unknown metric ${metric}`);
    }
  }

  return failures;
}

export function buildProductFrontierContracts(options = {}) {
  const root = options.root || MODULE_ROOT;
  const filters = {
    contract: options.contract || null,
    experiment: options.experiment || null,
    category: options.category || null,
    source: options.source || null,
    metric: options.metric || null,
  };
  const spec = readJson(root, 'docs/product-frontier-implementation-contracts.json');
  const lab = readJson(root, 'docs/product-frontier-lab.json');
  const graph = readJson(root, 'public/product-graph.json');
  const readiness = readJson(root, 'docs/product-sota-readiness.json');
  const portfolio = readJson(root, 'docs/product-invention-portfolio.json');
  const failures = validateContracts(root, spec, lab, graph, readiness, portfolio);

  const experimentById = new Map((lab.experiments || []).map((experiment) => [experiment.id, experiment]));
  const selected = selectedContracts(spec.contracts || [], experimentById, filters);
  if (filters.contract && selected.length === 0) failures.push(`unknown contract ${filters.contract}`);
  if (filters.experiment && selected.length === 0) failures.push(`unknown experiment ${filters.experiment}`);
  if (filters.category && selected.length === 0) failures.push(`unknown or empty category ${filters.category}`);
  if (filters.source && selected.length === 0) failures.push(`unknown or unused source ${filters.source}`);
  if (filters.metric && selected.length === 0) failures.push(`unknown or uncovered metric ${filters.metric}`);

  const allContracts = spec.contracts || [];
  const experiments = lab.experiments || [];
  const linkedExperiments = allContracts.map((contract) => experimentById.get(contract.experiment_id)).filter(Boolean);
  const contractExperimentIds = allContracts.map((contract) => contract.experiment_id);
  const experimentIds = experiments.map((experiment) => experiment.id);
  const missingExperimentContracts = experimentIds.filter((id) => !contractExperimentIds.includes(id));
  const duplicateExperimentContracts = unique(contractExperimentIds.filter((id, idx) => contractExperimentIds.indexOf(id) !== idx));
  const requirements = flattenRequirements(readiness);
  const openRequirementIds = unique(requirements.filter((req) => !['shipped', 'implemented'].includes(req.status)).map((req) => req.id));
  const journeyIds = (graph.journeys || []).map((journey) => journey.id);
  const dimensionIds = (graph.dimensions || []).map((dimension) => dimension.id);
  const metricIds = Object.keys(portfolio.metric_weights || {});
  const categoryIds = lab.categories || [];
  const portfolioIds = (portfolio.inventions || []).map((invention) => invention.id);
  const researchIds = (spec.implementation_research || []).map((source) => source.id);
  const usedResearch = unique(allContracts.flatMap((contract) => contract.research_refs || []));
  const coveredJourneys = unique(linkedExperiments.flatMap((experiment) => experiment.journeys || []));
  const coveredDimensions = unique(linkedExperiments.flatMap((experiment) => experiment.dimensions || []));
  const coveredReadiness = unique(linkedExperiments.flatMap((experiment) => experiment.readiness || []));
  const coveredMetrics = unique(linkedExperiments.flatMap((experiment) => experiment.metrics || []).concat(allContracts.flatMap((contract) => contract.tracked_metrics || [])));
  const coveredCategories = unique(linkedExperiments.map((experiment) => experiment.category));
  const coveredPortfolio = unique(linkedExperiments.map((experiment) => experiment.portfolio_invention_id));
  const missingJourneys = journeyIds.filter((id) => !coveredJourneys.includes(id));
  const missingDimensions = dimensionIds.filter((id) => !coveredDimensions.includes(id));
  const missingOpenRequirements = openRequirementIds.filter((id) => !coveredReadiness.includes(id));
  const missingMetrics = metricIds.filter((id) => !coveredMetrics.includes(id));
  const missingCategories = categoryIds.filter((id) => !coveredCategories.includes(id));
  const missingPortfolio = portfolioIds.filter((id) => !coveredPortfolio.includes(id));
  const unusedResearch = researchIds.filter((id) => !usedResearch.includes(id));
  const globalMode = !filters.contract && !filters.experiment && !filters.category && !filters.source && !filters.metric;
  if (globalMode) {
    if (missingExperimentContracts.length) failures.push(`missing experiment contracts: ${missingExperimentContracts.join(', ')}`);
    if (duplicateExperimentContracts.length) failures.push(`duplicate experiment contracts: ${duplicateExperimentContracts.join(', ')}`);
    if (missingJourneys.length) failures.push(`missing journeys: ${missingJourneys.join(', ')}`);
    if (missingDimensions.length) failures.push(`missing dimensions: ${missingDimensions.join(', ')}`);
    if (missingOpenRequirements.length) failures.push(`open requirements not addressed: ${missingOpenRequirements.join(', ')}`);
    if (missingMetrics.length) failures.push(`missing metrics: ${missingMetrics.join(', ')}`);
    if (missingCategories.length) failures.push(`missing categories: ${missingCategories.join(', ')}`);
    if (missingPortfolio.length) failures.push(`missing portfolio inventions: ${missingPortfolio.join(', ')}`);
    if (unusedResearch.length) failures.push(`unused implementation research: ${unusedResearch.join(', ')}`);
  }

  const ok = failures.length === 0;
  return {
    spec: PRODUCT_FRONTIER_IMPLEMENTATION_CONTRACTS_SPEC,
    schema_version: spec.schema_version,
    ok,
    local_contract_ok: ok,
    external_ready: false,
    readiness_status: ok ? 'implemented' : 'blocked',
    secret_values_included: false,
    updated_at: spec.updated_at || null,
    note: 'Runtime surface for W603 implementation contracts. It exposes implementation-agent handoff contracts; it is not external adoption, package publication, public benchmark evidence, or certification.',
    filter: filters,
    counts: {
      implementation_research: researchIds.length,
      contracts: allContracts.length,
      selected_contracts: selected.length,
      lab_experiments: experimentIds.length,
      journeys: journeyIds.length,
      dimensions: dimensionIds.length,
      readiness_requirements: requirements.length,
      open_requirements: openRequirementIds.length,
      metrics: metricIds.length,
      categories: categoryIds.length,
      portfolio_inventions: portfolioIds.length,
      failures: failures.length,
    },
    coverage: {
      covered_experiments: unique(contractExperimentIds).length,
      missing_experiment_contracts: missingExperimentContracts,
      duplicate_experiment_contracts: duplicateExperimentContracts,
      covered_journeys: coveredJourneys.length,
      covered_dimensions: coveredDimensions.length,
      covered_open_requirements: openRequirementIds.filter((id) => coveredReadiness.includes(id)).length,
      covered_metrics: coveredMetrics.length,
      covered_categories: coveredCategories.length,
      covered_portfolio_inventions: coveredPortfolio.length,
      used_research: usedResearch.length,
      missing_journeys: missingJourneys,
      missing_dimensions: missingDimensions,
      missing_open_requirements: missingOpenRequirements,
      missing_metrics: missingMetrics,
      missing_categories: missingCategories,
      missing_portfolio_inventions: missingPortfolio,
      unused_research: unusedResearch,
    },
    selected_contracts: selected.map((contract) => ({
      id: contract.id,
      experiment_id: contract.experiment_id,
      title: contract.title,
      research_refs: contract.research_refs,
      current_files: contract.current_files,
      proposed_files: contract.proposed_files,
      entrypoints: contract.entrypoints,
      data_schemas: contract.data_schemas,
      api_routes: contract.api_routes,
      cli_commands: contract.cli_commands,
      rollout_phases: contract.rollout_phases,
      smoke_fixture: contract.smoke_fixture,
      verification_commands: contract.verification_commands,
      evidence_gates: contract.evidence_gates,
      failure_modes: contract.failure_modes,
      tracked_metrics: contract.tracked_metrics,
    })),
    failures,
    evidence: {
      source_paths: PRODUCT_FRONTIER_IMPLEMENTATION_CONTRACTS_SOURCE_PATHS,
    },
    next_actions: [
      {
        kind: 'command',
        label: 'Verify frontier implementation contracts',
        value: 'npm run verify:frontier-contracts',
        surface: 'public-docs-sdk',
        journey: 'compile-verify',
        priority: 'P0',
      },
    ],
  };
}
