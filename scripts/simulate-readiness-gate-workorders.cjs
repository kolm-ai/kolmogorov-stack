#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const workordersPath = path.join(ROOT, 'docs', 'readiness-gate-workorders.json');
const readinessPath = path.join(ROOT, 'docs', 'product-sota-readiness.json');

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const requirementArg = args.find((arg) => arg.startsWith('--requirement='));
const kindArg = args.find((arg) => arg.startsWith('--kind='));
const requirementFilter = requirementArg ? requirementArg.slice('--requirement='.length) : null;
const kindFilter = kindArg ? kindArg.slice('--kind='.length) : null;

const STATUS_TO_KIND = {
  needs_external_partner: 'external_partner',
  needs_package_release: 'package_release',
  needs_public_benchmark_data: 'public_benchmark_data',
  needs_live_certification: 'live_certification'
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function unique(values) {
  return Array.from(new Set(values)).sort();
}

function flattenRequirements(readiness) {
  const out = [];
  for (const surface of readiness.surfaces || []) {
    for (const requirement of surface.requirements || []) out.push({ surface: surface.id, ...requirement });
  }
  return out;
}

function hasText(value, min) {
  return typeof value === 'string' && value.trim().length >= min;
}

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

function validate(workorders, readiness, failures) {
  if (workorders.schema_version !== 'kolm-readiness-gate-workorders-1') failures.push('unexpected schema_version');
  if (!Array.isArray(workorders.definition_of_done) || workorders.definition_of_done.length < 4) failures.push('definition_of_done too thin');
  if (!Array.isArray(workorders.workorders) || workorders.workorders.length < 1) failures.push('workorders missing');

  const requirements = flattenRequirements(readiness);
  const open = requirements.filter((req) => STATUS_TO_KIND[req.status]);
  const openIds = new Set(open.map((req) => req.id));
  const openById = new Map(open.map((req) => [req.id, req]));
  const ids = new Set();
  const requirementCounts = new Map();

  for (const workorder of workorders.workorders || []) {
    if (!workorder.id || !/^wo-[a-z0-9-]+$/.test(workorder.id)) failures.push(`${workorder.id || 'unknown'}: bad workorder id`);
    if (ids.has(workorder.id)) failures.push(`${workorder.id}: duplicate workorder id`);
    ids.add(workorder.id);

    requirementCounts.set(workorder.requirement_id, (requirementCounts.get(workorder.requirement_id) || 0) + 1);
    const req = openById.get(workorder.requirement_id);
    if (!req) failures.push(`${workorder.id}: requirement_id ${workorder.requirement_id} is not an open readiness requirement`);
    if (req && workorder.surface !== req.surface) failures.push(`${workorder.id}: surface mismatch ${workorder.surface} != ${req.surface}`);
    if (req && workorder.status !== req.status) failures.push(`${workorder.id}: status mismatch ${workorder.status} != ${req.status}`);
    if (req && workorder.priority !== req.priority) failures.push(`${workorder.id}: priority mismatch ${workorder.priority} != ${req.priority}`);
    if (req && workorder.kind !== STATUS_TO_KIND[req.status]) failures.push(`${workorder.id}: kind ${workorder.kind} does not match status ${req.status}`);

    if (!hasText(workorder.local_contract_state, 12)) failures.push(`${workorder.id}: local_contract_state too thin`);
    if (!hasText(workorder.public_copy_rule, 120)) failures.push(`${workorder.id}: public_copy_rule too thin`);
    if (!/do not (claim|advertise|publish)/i.test(workorder.public_copy_rule)) failures.push(`${workorder.id}: public_copy_rule must be explicit about claim limits`);

    const minimums = {
      local_files: 4,
      local_commands: 4,
      external_actions: 3,
      evidence_required: 3,
      failure_modes: 3
    };
    for (const [field, min] of Object.entries(minimums)) {
      if (!Array.isArray(workorder[field]) || workorder[field].length < min) failures.push(`${workorder.id}: ${field} too thin`);
    }
    for (const relPath of workorder.local_files || []) {
      if (!fileExists(relPath)) failures.push(`${workorder.id}: local file missing ${relPath}`);
    }
    if (!(workorder.local_commands || []).some((cmd) => /verify:/.test(cmd))) failures.push(`${workorder.id}: local_commands need at least one verify:* command`);
    if (!(workorder.local_commands || []).some((cmd) => /simulate-|package-release|compliance|governance|benchmark|sota|claims/.test(cmd))) failures.push(`${workorder.id}: local_commands need a focused contract command`);
  }

  for (const id of openIds) {
    const count = requirementCounts.get(id) || 0;
    if (count !== 1) failures.push(`open requirement ${id} has ${count} workorders`);
  }
}

function simulate() {
  const workorders = readJson(workordersPath);
  const readiness = readJson(readinessPath);
  const failures = [];
  validate(workorders, readiness, failures);

  let selected = workorders.workorders || [];
  if (requirementFilter) selected = selected.filter((workorder) => workorder.requirement_id === requirementFilter);
  if (kindFilter) selected = selected.filter((workorder) => workorder.kind === kindFilter);
  if (requirementFilter && selected.length === 0) failures.push(`unknown requirement ${requirementFilter}`);
  if (kindFilter && selected.length === 0) failures.push(`unknown kind ${kindFilter}`);

  const requirements = flattenRequirements(readiness);
  const open = requirements.filter((req) => STATUS_TO_KIND[req.status]);
  const openIds = open.map((req) => req.id);
  const coveredIds = unique((workorders.workorders || []).map((workorder) => workorder.requirement_id));
  const kinds = unique((workorders.workorders || []).map((workorder) => workorder.kind));
  const statuses = unique(open.map((req) => req.status));
  const missing = openIds.filter((id) => !coveredIds.includes(id));
  const extra = coveredIds.filter((id) => !openIds.includes(id));
  const kindCounts = Object.fromEntries(kinds.map((kind) => [kind, (workorders.workorders || []).filter((workorder) => workorder.kind === kind).length]));

  const result = {
    ok: failures.length === 0,
    note: 'Synthetic readiness workorder smoke only. This validates that every non-shipped readiness gate has a local contract and external evidence plan; it does not create external partner adoption, package publication, public benchmark data, or live certification.',
    filter: {
      requirement: requirementFilter,
      kind: kindFilter
    },
    counts: {
      open_requirements: open.length,
      workorders: (workorders.workorders || []).length,
      selected_workorders: selected.length,
      kinds: kinds.length,
      statuses: statuses.length,
      local_files: unique((workorders.workorders || []).flatMap((workorder) => workorder.local_files || [])).length,
      local_commands: unique((workorders.workorders || []).flatMap((workorder) => workorder.local_commands || [])).length,
      external_actions: (workorders.workorders || []).reduce((sum, workorder) => sum + (workorder.external_actions || []).length, 0),
      evidence_requirements: (workorders.workorders || []).reduce((sum, workorder) => sum + (workorder.evidence_required || []).length, 0)
    },
    coverage: {
      covered_open_requirements: coveredIds.filter((id) => openIds.includes(id)).length,
      missing_open_requirements: missing,
      extra_workorders: extra,
      statuses,
      kinds,
      kind_counts: kindCounts
    },
    failures
  };

  if (!summary) {
    result.workorders = selected.map((workorder) => ({
      id: workorder.id,
      requirement_id: workorder.requirement_id,
      surface: workorder.surface,
      status: workorder.status,
      kind: workorder.kind,
      local_contract_state: workorder.local_contract_state,
      public_copy_rule: workorder.public_copy_rule,
      local_commands: workorder.local_commands,
      evidence_required: workorder.evidence_required
    }));
  }
  return result;
}

const result = simulate();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
