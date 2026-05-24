#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const contractsPath = path.join(ROOT, 'docs', 'product-frontier-implementation-contracts.json');
const labPath = path.join(ROOT, 'docs', 'product-frontier-lab.json');
const graphPath = path.join(ROOT, 'public', 'product-graph.json');
const readinessPath = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const portfolioPath = path.join(ROOT, 'docs', 'product-invention-portfolio.json');

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const contractArg = args.find((arg) => arg.startsWith('--contract='));
const experimentArg = args.find((arg) => arg.startsWith('--experiment='));
const categoryArg = args.find((arg) => arg.startsWith('--category='));
const sourceArg = args.find((arg) => arg.startsWith('--source='));
const metricArg = args.find((arg) => arg.startsWith('--metric='));
const contractFilter = contractArg ? contractArg.slice('--contract='.length) : null;
const experimentFilter = experimentArg ? experimentArg.slice('--experiment='.length) : null;
const categoryFilter = categoryArg ? categoryArg.slice('--category='.length) : null;
const sourceFilter = sourceArg ? sourceArg.slice('--source='.length) : null;
const metricFilter = metricArg ? metricArg.slice('--metric='.length) : null;

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

function validateShape(spec, lab, graph, readiness, portfolio, failures) {
  if (spec.schema_version !== 'kolm-product-frontier-implementation-contracts-1') failures.push('unexpected schema_version');
  if (!Array.isArray(spec.implementation_research) || spec.implementation_research.length < 12) failures.push('implementation_research too thin');
  if (!Array.isArray(spec.contracts) || spec.contracts.length < (lab.experiments || []).length) failures.push('contracts do not cover lab experiments');
  if (!Array.isArray(spec.contract_rules) || spec.contract_rules.length < 5) failures.push('contract_rules too thin');

  const researchIds = new Set();
  for (const source of spec.implementation_research || []) {
    if (!source.id || !/^[a-z0-9-]+$/.test(source.id)) failures.push(`bad research id: ${source.id || 'unknown'}`);
    if (researchIds.has(source.id)) failures.push(`duplicate research id: ${source.id}`);
    researchIds.add(source.id);
    if (!source.url || !/^https?:\/\//.test(source.url)) failures.push(`${source.id || 'unknown'}: missing url`);
    if (!hasText(source.lesson, 90)) failures.push(`${source.id || 'unknown'}: lesson too thin`);
  }

  const experimentById = new Map((lab.experiments || []).map((experiment) => [experiment.id, experiment]));
  const categoryIds = new Set(lab.categories || []);
  const journeyIds = new Set((graph.journeys || []).map((journey) => journey.id));
  const dimensionIds = new Set((graph.dimensions || []).map((dimension) => dimension.id));
  const requirements = flattenRequirements(readiness);
  const readinessIds = new Set(requirements.map((requirement) => requirement.id));
  const metricIds = new Set(Object.keys(portfolio.metric_weights || {}));
  const portfolioIds = new Set((portfolio.inventions || []).map((invention) => invention.id));
  const contractIds = new Set();

  for (const contract of spec.contracts || []) {
    if (!contract.id || !/^w603-[a-z0-9-]+-contract$/.test(contract.id)) failures.push(`${contract.id || 'unknown'}: bad contract id`);
    if (contractIds.has(contract.id)) failures.push(`${contract.id}: duplicate contract id`);
    contractIds.add(contract.id);
    const experiment = experimentById.get(contract.experiment_id);
    if (!experiment) failures.push(`${contract.id}: unknown experiment_id ${contract.experiment_id}`);
    if (experiment && experiment.category !== categoryFromContract(contract, experiment)) failures.push(`${contract.id}: category mismatch`);
    if (!hasText(contract.title, 10)) failures.push(`${contract.id}: title too thin`);

    const minimums = {
      research_refs: 2,
      current_files: 4,
      proposed_files: 2,
      entrypoints: 2,
      data_schemas: 2,
      api_routes: 1,
      cli_commands: 1,
      rollout_phases: 4,
      verification_commands: 3,
      evidence_gates: 3,
      failure_modes: 3,
      tracked_metrics: 5
    };
    for (const [field, min] of Object.entries(minimums)) {
      if (!Array.isArray(contract[field]) || contract[field].length < min) failures.push(`${contract.id}: ${field} too thin`);
    }
    for (const ref of contract.research_refs || []) if (!researchIds.has(ref)) failures.push(`${contract.id}: unknown research_ref ${ref}`);
    for (const rel of contract.current_files || []) if (!fileExists(rel)) failures.push(`${contract.id}: current file missing ${rel}`);
    for (const entrypoint of contract.entrypoints || []) {
      if (!hasText(entrypoint.name, 8)) failures.push(`${contract.id}: entrypoint name too thin`);
      if (!hasText(entrypoint.input_contract, 20)) failures.push(`${contract.id}: entrypoint input_contract too thin`);
      if (!hasText(entrypoint.output_contract, 20)) failures.push(`${contract.id}: entrypoint output_contract too thin`);
    }
    if (!contract.smoke_fixture || !contract.smoke_fixture.input || !contract.smoke_fixture.expected) failures.push(`${contract.id}: smoke_fixture incomplete`);
    for (const metric of contract.tracked_metrics || []) if (!metricIds.has(metric)) failures.push(`${contract.id}: unknown tracked_metric ${metric}`);

    if (experiment) {
      for (const journey of experiment.journeys || []) if (!journeyIds.has(journey)) failures.push(`${contract.id}: experiment has unknown journey ${journey}`);
      for (const dimension of experiment.dimensions || []) if (!dimensionIds.has(dimension)) failures.push(`${contract.id}: experiment has unknown dimension ${dimension}`);
      for (const requirement of experiment.readiness || []) if (!readinessIds.has(requirement)) failures.push(`${contract.id}: experiment has unknown readiness ${requirement}`);
      for (const metric of experiment.metrics || []) if (!metricIds.has(metric)) failures.push(`${contract.id}: experiment has unknown metric ${metric}`);
      if (!categoryIds.has(experiment.category)) failures.push(`${contract.id}: experiment has unknown category ${experiment.category}`);
      if (!portfolioIds.has(experiment.portfolio_invention_id)) failures.push(`${contract.id}: experiment has unknown portfolio ${experiment.portfolio_invention_id}`);
    }
  }
}

function categoryFromContract(contract, experiment) {
  return experiment.category;
}

function simulate() {
  const spec = readJson(contractsPath);
  const lab = readJson(labPath);
  const graph = readJson(graphPath);
  const readiness = readJson(readinessPath);
  const portfolio = readJson(portfolioPath);
  const failures = [];
  validateShape(spec, lab, graph, readiness, portfolio, failures);

  const experimentById = new Map((lab.experiments || []).map((experiment) => [experiment.id, experiment]));
  let selected = spec.contracts || [];
  if (contractFilter) selected = selected.filter((contract) => contract.id === contractFilter);
  if (experimentFilter) selected = selected.filter((contract) => contract.experiment_id === experimentFilter);
  if (categoryFilter) selected = selected.filter((contract) => experimentById.get(contract.experiment_id)?.category === categoryFilter);
  if (sourceFilter) selected = selected.filter((contract) => (contract.research_refs || []).includes(sourceFilter));
  if (metricFilter) selected = selected.filter((contract) => (contract.tracked_metrics || []).includes(metricFilter) || (experimentById.get(contract.experiment_id)?.metrics || []).includes(metricFilter));
  if (contractFilter && selected.length === 0) failures.push(`unknown contract ${contractFilter}`);
  if (experimentFilter && selected.length === 0) failures.push(`unknown experiment ${experimentFilter}`);
  if (categoryFilter && selected.length === 0) failures.push(`unknown or empty category ${categoryFilter}`);
  if (sourceFilter && selected.length === 0) failures.push(`unknown or unused source ${sourceFilter}`);
  if (metricFilter && selected.length === 0) failures.push(`unknown or uncovered metric ${metricFilter}`);

  const allContracts = spec.contracts || [];
  const linkedExperiments = allContracts.map((contract) => experimentById.get(contract.experiment_id)).filter(Boolean);
  const experimentIds = (lab.experiments || []).map((experiment) => experiment.id);
  const contractExperimentIds = allContracts.map((contract) => contract.experiment_id);
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

  const globalMode = !contractFilter && !experimentFilter && !categoryFilter && !sourceFilter && !metricFilter;
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

  const implementationReadiness = Number((allContracts.reduce((sum, contract) => {
    const score = 0.15
      + Math.min(0.15, (contract.entrypoints || []).length * 0.04)
      + Math.min(0.14, (contract.current_files || []).length * 0.02)
      + Math.min(0.08, (contract.proposed_files || []).length * 0.02)
      + Math.min(0.08, (contract.data_schemas || []).length * 0.02)
      + Math.min(0.14, (contract.verification_commands || []).length * 0.035)
      + Math.min(0.14, (contract.evidence_gates || []).length * 0.03)
      + Math.min(0.14, (contract.rollout_phases || []).length * 0.025)
      + Math.min(0.14, (contract.failure_modes || []).length * 0.03);
    return sum + Math.min(0.98, score);
  }, 0) / Math.max(1, allContracts.length)).toFixed(3));
  if (globalMode && implementationReadiness < 0.78) failures.push(`implementation readiness too low: ${implementationReadiness}`);

  const result = {
    ok: failures.length === 0,
    note: 'Synthetic implementation-contract smoke only. This proves W601 experiments have implementation handoff contracts; it is not external adoption, package publication, public benchmark evidence, or certification.',
    filter: {
      contract: contractFilter,
      experiment: experimentFilter,
      category: categoryFilter,
      source: sourceFilter,
      metric: metricFilter
    },
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
      portfolio_inventions: portfolioIds.length
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
      unused_research: unusedResearch
    },
    simulation: {
      implementation_readiness: implementationReadiness,
      local_contract_only: true,
      external_ready: false
    },
    failures
  };

  if (!summary) {
    result.contracts = selected.map((contract) => ({
      id: contract.id,
      experiment_id: contract.experiment_id,
      title: contract.title,
      category: experimentById.get(contract.experiment_id)?.category || null,
      research_refs: contract.research_refs,
      current_files: contract.current_files,
      proposed_files: contract.proposed_files,
      entrypoints: contract.entrypoints,
      data_schemas: contract.data_schemas,
      verification_commands: contract.verification_commands,
      evidence_gates: contract.evidence_gates,
      tracked_metrics: contract.tracked_metrics
    }));
  }
  return result;
}

const result = simulate();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
