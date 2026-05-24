#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const graphPath = path.join(ROOT, 'public', 'product-graph.json');
const readinessPath = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const portfolioPath = path.join(ROOT, 'docs', 'product-invention-portfolio.json');
const args = process.argv.slice(2);
const summary = args.includes('--summary');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function unique(values) {
  return Array.from(new Set(values)).sort();
}

function flattenRequirements(doc) {
  const rows = [];
  for (const surface of doc.surfaces || []) {
    for (const req of surface.requirements || []) {
      rows.push({ surface: surface.id, ...req });
    }
  }
  return rows;
}

function composite(metrics, weights) {
  return Number(Object.entries(weights).reduce((sum, [k, w]) => sum + (metrics[k] || 0) * w, 0).toFixed(3));
}

function validatePortfolioShape(portfolio) {
  const failures = [];
  if (portfolio.schema_version !== 'kolm-product-invention-portfolio-1') failures.push('unexpected portfolio schema_version');
  if (!portfolio.metric_weights || typeof portfolio.metric_weights !== 'object') failures.push('missing metric_weights');
  if (!portfolio.baseline || typeof portfolio.baseline !== 'object') failures.push('missing baseline metrics');
  if (!Array.isArray(portfolio.implementation_rules) || portfolio.implementation_rules.length < 5) failures.push('implementation_rules too thin');
  if (!Array.isArray(portfolio.inventions) || portfolio.inventions.length < 10) failures.push('at least 10 inventions required');
  const ids = new Set();
  for (const invention of portfolio.inventions || []) {
    if (!invention.id || !/^[a-z0-9-]+$/.test(invention.id)) failures.push(`bad invention id: ${invention.id}`);
    if (ids.has(invention.id)) failures.push(`duplicate invention id: ${invention.id}`);
    ids.add(invention.id);
    if (!invention.name || String(invention.name).trim().length < 8) failures.push(`${invention.id}: name too thin`);
    if (!invention.thesis || String(invention.thesis).trim().length < 40) failures.push(`${invention.id}: thesis too thin`);
    for (const field of ['journeys', 'dimensions', 'readiness', 'implementation_surfaces', 'smoke_tests']) {
      if (!Array.isArray(invention[field]) || invention[field].length === 0) failures.push(`${invention.id}: missing ${field}`);
    }
    if (!invention.metrics || Object.keys(invention.metrics).length === 0) failures.push(`${invention.id}: missing metrics`);
  }
  return failures;
}

function simulate() {
  const graph = readJson(graphPath);
  const readiness = readJson(readinessPath);
  const portfolio = readJson(portfolioPath);
  const metricWeights = portfolio.metric_weights || {};
  const baseline = portfolio.baseline || {};
  const inventions = portfolio.inventions || [];
  const requirements = flattenRequirements(readiness);
  const openRequirements = requirements.filter((r) => !['shipped', 'implemented'].includes(r.status));

  const failures = validatePortfolioShape(portfolio);
  const graphJourneys = graph.journeys || [];
  const graphDimensions = graph.dimensions || [];
  const readinessIds = new Set(requirements.map((r) => r.id));
  const journeyIds = new Set(graphJourneys.map((j) => j.id));
  const dimensionIds = new Set(graphDimensions.map((d) => d.id));
  const metricIds = Object.keys(metricWeights);

  for (const invention of inventions) {
    for (const journey of invention.journeys || []) {
      if (!journeyIds.has(journey)) failures.push(`${invention.id}: unknown journey ${journey}`);
    }
    for (const dimension of invention.dimensions || []) {
      if (!dimensionIds.has(dimension)) failures.push(`${invention.id}: unknown dimension ${dimension}`);
    }
    for (const requirement of invention.readiness || []) {
      if (!readinessIds.has(requirement)) failures.push(`${invention.id}: unknown readiness requirement ${requirement}`);
    }
    for (const metric of Object.keys(invention.metrics || {})) {
      if (!metricIds.includes(metric)) failures.push(`${invention.id}: unknown metric ${metric}`);
    }
  }

  const coveredJourneys = unique(inventions.flatMap((i) => i.journeys || []));
  const coveredDimensions = unique(inventions.flatMap((i) => i.dimensions || []));
  const coveredReadiness = unique(inventions.flatMap((i) => i.readiness || []));
  const coveredMetrics = unique(inventions.flatMap((i) => Object.keys(i.metrics || {})));

  const missingJourneys = graphJourneys.map((j) => j.id).filter((id) => !coveredJourneys.includes(id));
  const weakJourneys = graphJourneys
    .map((j) => ({ id: j.id, count: inventions.filter((i) => (i.journeys || []).includes(j.id)).length }))
    .filter((j) => j.count < 2);
  const missingDimensions = graphDimensions.map((d) => d.id).filter((id) => !coveredDimensions.includes(id));
  const missingOpenRequirements = openRequirements.map((r) => r.id).filter((id) => !coveredReadiness.includes(id));
  const missingMetricClasses = metricIds.filter((id) => !coveredMetrics.includes(id));

  const metricLift = {};
  for (const metric of metricIds) metricLift[metric] = 0;
  for (const invention of inventions) {
    for (const [metric, lift] of Object.entries(invention.metrics || {})) {
      metricLift[metric] = Math.min(0.65, (metricLift[metric] || 0) + lift);
    }
  }

  const simulated = {};
  for (const metric of metricIds) {
    simulated[metric] = Number(Math.min(0.99, (baseline[metric] || 0) + metricLift[metric] * (1 - (baseline[metric] || 0))).toFixed(3));
  }
  const baselineComposite = composite(baseline, metricWeights);
  const simulatedComposite = composite(simulated, metricWeights);

  if (missingJourneys.length) failures.push(`missing journeys: ${missingJourneys.join(', ')}`);
  if (weakJourneys.length) failures.push(`journeys with <2 inventions: ${weakJourneys.map((j) => `${j.id}:${j.count}`).join(', ')}`);
  if (missingDimensions.length) failures.push(`missing dimensions: ${missingDimensions.join(', ')}`);
  if (missingOpenRequirements.length) failures.push(`open requirements not addressed: ${missingOpenRequirements.join(', ')}`);
  if (missingMetricClasses.length) failures.push(`missing metric classes: ${missingMetricClasses.join(', ')}`);
  if (simulatedComposite <= baselineComposite) failures.push('portfolio does not improve weighted composite score');

  const result = {
    ok: failures.length === 0,
    note: 'Synthetic portfolio smoke only. This checks coverage and internally consistent expected metric lift; it is not a real model benchmark.',
    counts: {
      inventions: inventions.length,
      journeys: graphJourneys.length,
      dimensions: graphDimensions.length,
      readiness_requirements: requirements.length,
      open_requirements: openRequirements.length,
      metric_classes: metricIds.length,
    },
    coverage: {
      covered_journeys: coveredJourneys.length,
      covered_dimensions: coveredDimensions.length,
      covered_open_requirements: openRequirements.filter((r) => coveredReadiness.includes(r.id)).length,
      covered_metric_classes: coveredMetrics.length,
      weak_journeys: weakJourneys,
      missing_journeys: missingJourneys,
      missing_dimensions: missingDimensions,
      missing_open_requirements: missingOpenRequirements,
      missing_metric_classes: missingMetricClasses,
    },
    simulation: {
      baseline,
      simulated,
      baseline_composite: baselineComposite,
      simulated_composite: simulatedComposite,
      composite_delta: Number((simulatedComposite - baselineComposite).toFixed(3)),
      metric_lift: metricLift,
    },
    failures,
  };
  if (!summary) {
    result.inventions = inventions.map((i) => ({
      id: i.id,
      journeys: i.journeys,
      dimensions: i.dimensions,
      readiness: i.readiness,
      implementation_surfaces: i.implementation_surfaces,
      smoke_tests: i.smoke_tests,
      metrics: i.metrics,
    }));
  }
  return result;
}

const result = simulate();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
