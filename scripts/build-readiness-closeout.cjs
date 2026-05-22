#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MATRIX_PATH = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const JSON_PATH = path.join(ROOT, 'public', 'product-readiness-closeout.json');
const MD_PATH = path.join(ROOT, 'docs', 'product-readiness-closeout.md');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const OPEN_STATUSES = new Set([
  'partial',
  'needs_public_benchmark_data',
  'needs_package_release',
  'needs_external_partner',
  'needs_live_certification',
]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readMatrix() {
  return JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
}

function collectRows(matrix) {
  const rows = [];
  for (const surface of matrix.surfaces || []) {
    for (const req of surface.requirements || []) {
      if (!OPEN_STATUSES.has(req.status)) continue;
      rows.push({
        surface_id: surface.id,
        requirement_id: req.id,
        priority: req.priority,
        status: req.status,
        title: req.title,
        current_scope: req.closeout.current_scope,
        blocking_condition: req.closeout.blocking_condition,
        next_wave: req.closeout.next_wave,
        build_or_proof_required: req.closeout.build_or_proof_required,
        done_when: req.closeout.done_when,
        verification: req.closeout.verification,
        evidence_paths: req.evidence_paths,
      });
    }
  }
  return rows.sort((a, b) => {
    const byPriority = a.priority.localeCompare(b.priority);
    if (byPriority) return byPriority;
    return `${a.surface_id}/${a.requirement_id}`.localeCompare(`${b.surface_id}/${b.requirement_id}`);
  });
}

function countBy(rows, field) {
  const out = {};
  for (const row of rows) out[row[field]] = (out[row[field]] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function renderJson(matrix, rows) {
  return {
    schema_version: `${matrix.schema_version}.closeout`,
    purpose: 'Generated closeout ledger for every non-final product readiness requirement.',
    generated_from: 'docs/product-sota-readiness.json',
    definition_of_done: [
      'No open readiness status may be vague.',
      'Each open item must state current scope, blocker, next wave, proof required, done-when criteria, and verification commands.',
      'Marketing and product UI must not describe these items as fully shipped until the status is promoted.',
    ],
    counts: {
      open_requirements: rows.length,
      by_status: countBy(rows, 'status'),
      by_priority: countBy(rows, 'priority'),
    },
    open_requirements: rows,
  };
}

function mdList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function renderMarkdown(matrix, rows) {
  const lines = [];
  lines.push('# Product Readiness Closeout Ledger');
  lines.push('');
  lines.push(`Generated from \`docs/product-sota-readiness.json\` schema \`${matrix.schema_version}\`.`);
  lines.push('');
  lines.push('This file is the DoD backstop for every readiness item that is not yet `shipped` or `implemented`. Open items are allowed only when the blocker is explicit and the next build/proof wave is named.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| status | count |');
  lines.push('|---|---:|');
  for (const [status, count] of Object.entries(countBy(rows, 'status'))) {
    lines.push(`| ${status} | ${count} |`);
  }
  lines.push('');
  lines.push('## Open Requirements');
  lines.push('');
  for (const row of rows) {
    lines.push(`### ${row.next_wave} - ${row.requirement_id}`);
    lines.push('');
    lines.push(`- Surface: \`${row.surface_id}\``);
    lines.push(`- Priority: \`${row.priority}\``);
    lines.push(`- Status: \`${row.status}\``);
    lines.push(`- Blocker: \`${row.blocking_condition}\``);
    lines.push(`- Current scope: ${row.current_scope}`);
    lines.push('');
    lines.push('Build or proof required:');
    lines.push(mdList(row.build_or_proof_required));
    lines.push('');
    lines.push('Done when:');
    lines.push(mdList(row.done_when));
    lines.push('');
    lines.push('Verification:');
    lines.push(mdList(row.verification.map((cmd) => `\`${cmd}\``)));
    lines.push('');
    lines.push('Evidence paths:');
    lines.push(mdList(row.evidence_paths.map((p) => `\`${p}\``)));
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function assertSame(filePath, next) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (existing !== next) {
    console.error(`readiness-closeout: stale ${path.relative(ROOT, filePath)}`);
    process.exitCode = 1;
  }
}

function main() {
  const matrix = readMatrix();
  const rows = collectRows(matrix);
  const jsonText = `${stableStringify(renderJson(matrix, rows))}\n`;
  const mdText = renderMarkdown(matrix, rows);

  if (checkOnly) {
    assertSame(JSON_PATH, jsonText);
    assertSame(MD_PATH, mdText);
    if (process.exitCode) return;
    console.log(`readiness-closeout: ok open=${rows.length}`);
    return;
  }

  fs.writeFileSync(JSON_PATH, jsonText);
  fs.writeFileSync(MD_PATH, mdText);
  console.log(`readiness-closeout: wrote ${path.relative(ROOT, JSON_PATH)} and ${path.relative(ROOT, MD_PATH)} open=${rows.length}`);
}

main();
