#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const UPDATED_AT = '2026-06-17';
const STACK_SPEC = path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md');
const RAW_DELTAS = path.join(ROOT, 'research', 'strategy-2026', 'frontier-deltas.json');
const SOTA_LEDGER = path.join(ROOT, 'docs', 'whole-stack-sota-deep-dive-2026-06-17.json');
const MASTER_SPEC = path.join(ROOT, 'docs', 'master-component-spec-sheet-2026-06-17.json');
const OUT = path.join(ROOT, 'docs', 'internal', 'frontier-delta-freshness.json');

const args = new Set(process.argv.slice(2));
const SEVERE = new Set(['critical', 'major']);
const CLOSED_STATUSES = new Set(['shipped', 'implemented']);
const AUTHORITY_PHRASE = 'Current source of truth for readiness';
const STALE_AUTHORITY_RE = /Source of truth:\s*16 per-category frontier-delta analyses/i;

function normalize(p) {
  return p.replace(/\\/g, '/');
}

function rel(p) {
  return normalize(path.relative(ROOT, p));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function countGapSeverities(gaps) {
  const counts = { critical: 0, major: 0, minor: 0, closed: 0, external: 0, other: 0 };
  for (const gap of gaps || []) {
    const severity = String(gap && gap.severity || 'other').toLowerCase();
    counts[severity] = (counts[severity] || 0) + 1;
  }
  return counts;
}

function severeCount(counts) {
  return (counts.critical || 0) + (counts.major || 0);
}

function extractSection(markdown, id) {
  const needle = `### ${id}`;
  const start = markdown.indexOf(needle);
  if (start < 0) return '';
  const rest = markdown.slice(start + needle.length);
  const next = rest.search(/\n###\s+/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function closureMarkers(section) {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\bCLOSED W\d+|\[closed W\d+\]|\(completed-local,\s*W\d+/i.test(line))
    .slice(0, 12);
}

function flattenReadinessOpen(readinessRows) {
  const out = [];
  for (const row of readinessRows || []) {
    if (!CLOSED_STATUSES.has(row.status)) out.push(row);
  }
  return out;
}

function build() {
  const stackSpec = readText(STACK_SPEC);
  const raw = readJson(RAW_DELTAS);
  const ledger = readJson(SOTA_LEDGER);
  const master = fs.existsSync(MASTER_SPEC) ? readJson(MASTER_SPEC) : null;
  const failures = [];

  if (STALE_AUTHORITY_RE.test(stackSpec)) {
    failures.push('stack spec still describes raw frontier-deltas.json as the current source of truth');
  }
  if (!stackSpec.includes(AUTHORITY_PHRASE)) {
    failures.push(`stack spec must include explicit authority phrase: ${AUTHORITY_PHRASE}`);
  }

  const rawByCategory = new Map();
  for (const entry of raw || []) {
    if (entry && entry.category) rawByCategory.set(entry.category, entry);
  }

  const rows = [];
  for (const category of ledger.categories || []) {
    const rawEntry = rawByCategory.get(category.id) || {};
    const rawCounts = countGapSeverities(rawEntry.gaps || []);
    const currentCounts = {
      critical: category.local_sota_review?.gaps?.critical || 0,
      major: category.local_sota_review?.gaps?.major || 0,
      minor: category.local_sota_review?.gaps?.minor || 0,
    };
    const rawSevere = severeCount(rawCounts);
    const currentSevere = severeCount(currentCounts);
    const section = extractSection(stackSpec, category.id);
    const markers = closureMarkers(section);
    const resolution = rawSevere > 0 && currentSevere === 0
      ? 'historical_raw_deltas_superseded_by_current_stack_spec'
      : (currentSevere > 0 ? 'current_stack_spec_keeps_local_frontier_work_open' : 'no_severe_raw_delta');

    if (rawSevere > 0 && currentSevere === 0 && markers.length === 0) {
      failures.push(`${category.id}: raw severe deltas are superseded but current spec has no closure marker`);
    }

    rows.push({
      id: category.id,
      current_status: category.status,
      source_stack_spec_line: category.source_stack_spec?.line || null,
      raw_delta_gap_counts: rawCounts,
      current_stack_gap_counts: currentCounts,
      raw_severe_gap_count: rawSevere,
      current_severe_gap_count: currentSevere,
      resolution,
      closure_marker_count: markers.length,
      closure_markers: markers,
    });
  }

  const currentSevereCategories = rows.filter((row) => row.current_severe_gap_count > 0);
  if (currentSevereCategories.length > 0) {
    failures.push(`current stack ledger still has severe local frontier categories: ${currentSevereCategories.map((row) => row.id).join(', ')}`);
  }

  if ((ledger.summary?.categories_with_critical_frontier_work_open || 0) !== 0) {
    failures.push('whole-stack ledger summary reports critical frontier work open');
  }
  if ((ledger.summary?.categories_with_major_frontier_work_open || 0) !== 0) {
    failures.push('whole-stack ledger summary reports major frontier work open');
  }
  if (master) {
    if ((master.summary?.categories_with_critical_frontier_work_open || 0) !== (ledger.summary?.categories_with_critical_frontier_work_open || 0)) {
      failures.push('master spec critical frontier count disagrees with stack ledger');
    }
    if ((master.summary?.categories_with_major_frontier_work_open || 0) !== (ledger.summary?.categories_with_major_frontier_work_open || 0)) {
      failures.push('master spec major frontier count disagrees with stack ledger');
    }
  }

  const rawCounts = rows.reduce((acc, row) => {
    for (const [key, value] of Object.entries(row.raw_delta_gap_counts)) {
      acc[key] = (acc[key] || 0) + value;
    }
    return acc;
  }, {});
  const currentCounts = rows.reduce((acc, row) => {
    for (const [key, value] of Object.entries(row.current_stack_gap_counts)) {
      acc[key] = (acc[key] || 0) + value;
    }
    return acc;
  }, {});
  const openReadiness = flattenReadinessOpen(ledger.summary?.readiness_open_requirements || []);

  return {
    schema: 'kolm-frontier-delta-freshness-1',
    updated_at: UPDATED_AT,
    purpose: 'Prevents historical frontier-delta research notes from being mistaken for current SOTA readiness after later W-wave closures land.',
    authority: {
      current_sources: [
        rel(STACK_SPEC),
        rel(SOTA_LEDGER),
        rel(MASTER_SPEC),
      ],
      historical_research_baseline: rel(RAW_DELTAS),
      rule: 'Raw frontier deltas can preserve the original research audit, but current readiness must be read from the stack spec and generated ledgers.',
      status: failures.length === 0 ? 'current_spec_verified' : 'authority_drift_detected',
    },
    summary: {
      category_count: rows.length,
      historical_raw_gap_counts: rawCounts,
      historical_raw_severe_gap_count: severeCount(rawCounts),
      categories_with_historical_raw_severe_gaps: rows.filter((row) => row.raw_severe_gap_count > 0).length,
      current_stack_gap_counts: currentCounts,
      current_severe_category_count: currentSevereCategories.length,
      superseded_severe_categories: rows.filter((row) => row.resolution === 'historical_raw_deltas_superseded_by_current_stack_spec').length,
      open_external_or_release_requirements: openReadiness.length,
      open_external_or_release_status_counts: openReadiness.reduce((acc, row) => {
        acc[row.status] = (acc[row.status] || 0) + 1;
        return acc;
      }, {}),
    },
    rows,
    failures,
  };
}

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const doc = build();
const body = stable(doc);

if (args.has('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== body) {
    console.error(`frontier-delta-freshness: ${rel(OUT)} is out of date`);
    process.exit(1);
  }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body, 'utf8');
}

if (args.has('--summary') || !args.has('--check')) {
  console.log(JSON.stringify({
    ok: doc.failures.length === 0,
    output: rel(OUT),
    authority: doc.authority,
    summary: doc.summary,
    failures: doc.failures,
  }, null, 2));
}

if (doc.failures.length) process.exit(1);
