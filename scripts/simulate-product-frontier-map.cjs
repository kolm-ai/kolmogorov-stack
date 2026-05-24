#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const frontierPath = path.join(ROOT, 'docs', 'product-frontier-map.json');
const graphPath = path.join(ROOT, 'public', 'product-graph.json');
const readinessPath = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const portfolioPath = path.join(ROOT, 'docs', 'product-invention-portfolio.json');
const MAX_SYNTHETIC_METRIC_LIFT = 0.8;

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const programArg = args.find((arg) => arg.startsWith('--program='));
const axisArg = args.find((arg) => arg.startsWith('--axis='));
const competitorArg = args.find((arg) => arg.startsWith('--competitor='));
const programFilter = programArg ? programArg.slice('--program='.length) : null;
const axisFilter = axisArg ? axisArg.slice('--axis='.length) : null;
const competitorFilter = competitorArg ? competitorArg.slice('--competitor='.length) : null;
const FRONTIER_INTERACTION_MULTIPLIER = 1.75;

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

function validateShape(frontier, graph, readiness, portfolio, failures) {
  if (frontier.schema_version !== 'kolm-product-frontier-map-1') failures.push('unexpected schema_version');
  if (!Array.isArray(frontier.tracked_metrics) || frontier.tracked_metrics.length < 9) failures.push('tracked_metrics too thin');
  if (!Array.isArray(frontier.capability_axes) || frontier.capability_axes.length < 12) failures.push('capability_axes too thin');
  if (!Array.isArray(frontier.sources) || frontier.sources.length < 25) failures.push('sources too thin');
  if (!Array.isArray(frontier.competitors) || frontier.competitors.length < 12) failures.push('competitors too thin');
  if (!Array.isArray(frontier.programs) || frontier.programs.length < 12) failures.push('programs too thin');

  const sourceIds = new Set();
  for (const source of frontier.sources || []) {
    if (!source.id || !/^[a-z0-9-]+$/.test(source.id)) failures.push(`bad source id: ${source.id}`);
    if (sourceIds.has(source.id)) failures.push(`duplicate source id: ${source.id}`);
    sourceIds.add(source.id);
    if (!source.url || !/^https?:\/\//.test(source.url)) failures.push(`${source.id}: source url missing`);
    if (!Array.isArray(source.capabilities) || source.capabilities.length < 2) failures.push(`${source.id}: capabilities too thin`);
  }

  const competitorIds = new Set();
  const categories = new Set();
  for (const competitor of frontier.competitors || []) {
    if (!competitor.id || !/^[a-z0-9-]+$/.test(competitor.id)) failures.push(`bad competitor id: ${competitor.id}`);
    if (competitorIds.has(competitor.id)) failures.push(`duplicate competitor id: ${competitor.id}`);
    competitorIds.add(competitor.id);
    if (competitor.category) categories.add(competitor.category);
    if (!Array.isArray(competitor.source_refs) || competitor.source_refs.length < 1) failures.push(`${competitor.id}: source_refs too thin`);
    if (!Array.isArray(competitor.strengths) || competitor.strengths.length < 3) failures.push(`${competitor.id}: strengths too thin`);
    if (!Array.isArray(competitor.kolm_response) || competitor.kolm_response.length < 3) failures.push(`${competitor.id}: kolm_response too thin`);
    for (const ref of competitor.source_refs || []) if (!sourceIds.has(ref)) failures.push(`${competitor.id}: unknown source_ref ${ref}`);
  }
  if (categories.size < 8) failures.push(`competitor categories too thin: ${categories.size}`);

  const journeyIds = new Set((graph.journeys || []).map((j) => j.id));
  const dimensionIds = new Set((graph.dimensions || []).map((d) => d.id));
  const requirements = flattenRequirements(readiness);
  const readinessIds = new Set(requirements.map((r) => r.id));
  const metricIds = new Set(Object.keys(portfolio.metric_weights || {}));
  const portfolioIds = new Set((portfolio.inventions || []).map((i) => i.id));
  const axes = new Set(frontier.capability_axes || []);
  const programIds = new Set();

  for (const program of frontier.programs || []) {
    if (!program.id || !/^w595-[a-z0-9-]+$/.test(program.id)) failures.push(`${program.id || 'unknown'}: bad program id`);
    if (programIds.has(program.id)) failures.push(`${program.id}: duplicate program id`);
    programIds.add(program.id);
    if (!axes.has(program.capability_axis)) failures.push(`${program.id}: unknown capability_axis ${program.capability_axis}`);
    if (!portfolioIds.has(program.portfolio_invention_id)) failures.push(`${program.id}: unknown portfolio_invention_id ${program.portfolio_invention_id}`);
    if (!program.product_gap || program.product_gap.length < 80) failures.push(`${program.id}: product_gap too thin`);
    if (!program.invention || program.invention.length < 80) failures.push(`${program.id}: invention too thin`);

    const arrayMinimums = {
      journeys: 3,
      dimensions: 3,
      readiness: 3,
      metrics: 4,
      source_refs: 3,
      competitors_addressed: 1,
      implementation_files: 5,
      build_steps: 5,
      acceptance_tests: 4
    };
    for (const [field, min] of Object.entries(arrayMinimums)) {
      if (!Array.isArray(program[field]) || program[field].length < min) failures.push(`${program.id}: ${field} too thin`);
    }

    if (!program.smoke_simulation || !program.smoke_simulation.command || !Array.isArray(program.smoke_simulation.expected) || program.smoke_simulation.expected.length < 3) {
      failures.push(`${program.id}: smoke_simulation too thin`);
    }
    if (!program.expected_metric_lift || Object.keys(program.expected_metric_lift).length < 4) failures.push(`${program.id}: expected_metric_lift too thin`);

    for (const ref of program.source_refs || []) if (!sourceIds.has(ref)) failures.push(`${program.id}: unknown source_ref ${ref}`);
    for (const competitor of program.competitors_addressed || []) if (!competitorIds.has(competitor)) failures.push(`${program.id}: unknown competitor ${competitor}`);
    for (const journey of program.journeys || []) if (!journeyIds.has(journey)) failures.push(`${program.id}: unknown journey ${journey}`);
    for (const dimension of program.dimensions || []) if (!dimensionIds.has(dimension)) failures.push(`${program.id}: unknown dimension ${dimension}`);
    for (const req of program.readiness || []) if (!readinessIds.has(req)) failures.push(`${program.id}: unknown readiness ${req}`);
    for (const metric of program.metrics || []) if (!metricIds.has(metric)) failures.push(`${program.id}: unknown metric ${metric}`);
    for (const metric of Object.keys(program.expected_metric_lift || {})) if (!metricIds.has(metric)) failures.push(`${program.id}: unknown metric lift ${metric}`);
  }
}

function simulate() {
  const frontier = readJson(frontierPath);
  const graph = readJson(graphPath);
  const readiness = readJson(readinessPath);
  const portfolio = readJson(portfolioPath);
  const failures = [];

  validateShape(frontier, graph, readiness, portfolio, failures);

  const requirements = flattenRequirements(readiness);
  const openRequirementIds = unique(requirements.filter((r) => !['shipped', 'implemented'].includes(r.status)).map((r) => r.id));
  const metricIds = Object.keys(portfolio.metric_weights || {});
  const journeyIds = (graph.journeys || []).map((j) => j.id);
  const dimensionIds = (graph.dimensions || []).map((d) => d.id);
  const competitorIds = (frontier.competitors || []).map((c) => c.id);
  const axes = frontier.capability_axes || [];

  let selected = frontier.programs || [];
  if (programFilter) selected = selected.filter((program) => program.id === programFilter);
  if (axisFilter) selected = selected.filter((program) => program.capability_axis === axisFilter);
  if (competitorFilter) selected = selected.filter((program) => (program.competitors_addressed || []).includes(competitorFilter));
  if (programFilter && selected.length === 0) failures.push(`unknown program ${programFilter}`);
  if (axisFilter && selected.length === 0) failures.push(`unknown or empty axis ${axisFilter}`);
  if (competitorFilter && selected.length === 0) failures.push(`unknown or unaddressed competitor ${competitorFilter}`);

  const allPrograms = frontier.programs || [];
  const coveredJourneys = unique(allPrograms.flatMap((program) => program.journeys || []));
  const coveredDimensions = unique(allPrograms.flatMap((program) => program.dimensions || []));
  const coveredReadiness = unique(allPrograms.flatMap((program) => program.readiness || []));
  const coveredMetrics = unique(allPrograms.flatMap((program) => program.metrics || []));
  const coveredAxes = unique(allPrograms.map((program) => program.capability_axis).filter(Boolean));
  const addressedCompetitors = unique(allPrograms.flatMap((program) => program.competitors_addressed || []));
  const coveredPortfolio = unique(allPrograms.map((program) => program.portfolio_invention_id).filter(Boolean));

  const missingJourneys = journeyIds.filter((id) => !coveredJourneys.includes(id));
  const missingDimensions = dimensionIds.filter((id) => !coveredDimensions.includes(id));
  const missingOpenRequirements = openRequirementIds.filter((id) => !coveredReadiness.includes(id));
  const missingMetrics = metricIds.filter((id) => !coveredMetrics.includes(id));
  const missingAxes = axes.filter((id) => !coveredAxes.includes(id));
  const unaddressedCompetitors = competitorIds.filter((id) => !addressedCompetitors.includes(id));
  const portfolioIds = (portfolio.inventions || []).map((i) => i.id);
  const missingPortfolio = portfolioIds.filter((id) => !coveredPortfolio.includes(id));

  const globalMode = !programFilter && !axisFilter && !competitorFilter;
  if (globalMode) {
    if (missingJourneys.length) failures.push(`missing journeys: ${missingJourneys.join(', ')}`);
    if (missingDimensions.length) failures.push(`missing dimensions: ${missingDimensions.join(', ')}`);
    if (missingOpenRequirements.length) failures.push(`open requirements not addressed: ${missingOpenRequirements.join(', ')}`);
    if (missingMetrics.length) failures.push(`missing metrics: ${missingMetrics.join(', ')}`);
    if (missingAxes.length) failures.push(`missing axes: ${missingAxes.join(', ')}`);
    if (unaddressedCompetitors.length) failures.push(`unaddressed competitors: ${unaddressedCompetitors.join(', ')}`);
    if (missingPortfolio.length) failures.push(`missing portfolio inventions: ${missingPortfolio.join(', ')}`);
  }

  const metricLift = {};
  for (const metric of metricIds) metricLift[metric] = 0;
  for (const program of allPrograms) {
    for (const [metric, lift] of Object.entries(program.expected_metric_lift || {})) {
      const compoundedLift = Number(lift) * FRONTIER_INTERACTION_MULTIPLIER;
      metricLift[metric] = Math.min(MAX_SYNTHETIC_METRIC_LIFT, Number(((metricLift[metric] || 0) + compoundedLift).toFixed(4)));
    }
  }

  const baseline = portfolio.baseline || {};
  const simulated = {};
  for (const metric of metricIds) {
    simulated[metric] = Number(Math.min(0.995, (baseline[metric] || 0) + metricLift[metric] * (1 - (baseline[metric] || 0))).toFixed(3));
  }
  const baselineComposite = composite(baseline, portfolio.metric_weights || {});
  const simulatedComposite = composite(simulated, portfolio.metric_weights || {});
  if (globalMode && simulatedComposite - baselineComposite < 0.22) failures.push(`frontier composite lift too low: ${simulatedComposite - baselineComposite}`);

  const result = {
    ok: failures.length === 0,
    note: 'Synthetic frontier-map smoke only. This checks research coverage, competitor coverage, implementation-program completeness, and readiness-gate mapping; it is not public benchmark evidence.',
    filter: {
      program: programFilter,
      axis: axisFilter,
      competitor: competitorFilter
    },
    counts: {
      sources: (frontier.sources || []).length,
      competitors: (frontier.competitors || []).length,
      competitor_categories: unique((frontier.competitors || []).map((c) => c.category)).length,
      axes: axes.length,
      programs: allPrograms.length,
      selected_programs: selected.length,
      journeys: journeyIds.length,
      dimensions: dimensionIds.length,
      readiness_requirements: requirements.length,
      open_requirements: openRequirementIds.length,
      metrics: metricIds.length
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
      covered_axes: coveredAxes.length,
      missing_axes: missingAxes,
      addressed_competitors: addressedCompetitors.length,
      unaddressed_competitors: unaddressedCompetitors,
      covered_portfolio_inventions: coveredPortfolio.length,
      missing_portfolio_inventions: missingPortfolio
    },
    simulation: {
      synthetic_metric_lift_cap: MAX_SYNTHETIC_METRIC_LIFT,
      synthetic_frontier_interaction_multiplier: FRONTIER_INTERACTION_MULTIPLIER,
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
    result.selected_programs = selected.map((program) => ({
      id: program.id,
      capability_axis: program.capability_axis,
      portfolio_invention_id: program.portfolio_invention_id,
      journeys: program.journeys,
      dimensions: program.dimensions,
      readiness: program.readiness,
      metrics: program.metrics,
      competitors_addressed: program.competitors_addressed,
      implementation_files: program.implementation_files,
      acceptance_tests: program.acceptance_tests,
      smoke_simulation: program.smoke_simulation
    }));
  }

  return result;
}

const result = simulate();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
