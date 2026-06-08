#!/usr/bin/env node
// Agent Security-Review audit — thin end-to-end CLI.
//
// Logs in, findings + control map out. This is the dogfood path for the
// findings trinity: it runs a real log export through the deterministic
// orchestrator and prints the readiness rollup the report layer will sign.
//
//   node scripts/audit-run.mjs <export.jsonl> [--source litellm] [--json]
//                              [--retention-days 182]
//
// --json prints the full machine result (the shape the future API returns);
// without it you get the human-readable scan.

import fs from 'node:fs';
import path from 'node:path';
import { runAudit, AUDIT_SPEC_VERSION } from '../src/audit-orchestrator.js';

function parseArgs(argv) {
  const out = { _: [], json: false, source: undefined, retentionDays: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--source') out.source = argv[++i];
    else if (a === '--retention-days') out.retentionDays = Number(argv[++i]);
    else if (a.startsWith('--source=')) out.source = a.slice(9);
    else if (a.startsWith('--retention-days=')) out.retentionDays = Number(a.slice(17));
    else out._.push(a);
  }
  return out;
}

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const STATUS_MARK = { blocking: '[BLOCK]', attention: '[WARN] ', pass: '[PASS] ' };

function fmtSeverity(by) {
  const parts = [];
  for (const sev of ['critical', 'high', 'medium', 'low', 'info']) {
    if (by[sev]) parts.push(`${by[sev]} ${sev}`);
  }
  return parts.length ? parts.join(', ') : 'none';
}

function printReport(r) {
  const s = r.summary;
  const line = '─'.repeat(64);
  console.log(line);
  console.log(`  AGENT SECURITY-REVIEW READINESS SCAN   (${r.spec_version})`);
  console.log(line);
  console.log(`  Source: ${r.source}    Records: ${r.ingest.records}    Events: ${r.ingest.events}`);
  if (r.errors.length) console.log(`  Ingest errors: ${r.errors.length}`);
  console.log('');

  // Headline.
  const readiness = s.readiness_pct == null ? 'n/a' : `${s.readiness_pct}%`;
  console.log(`  READINESS (assessed controls): ${readiness}`);
  console.log(`  Tamper-evident trail: ${s.tamper_evident ? 'yes' : 'NO'}`);
  console.log(`  Findings: ${s.total_findings}   (${fmtSeverity(s.by_severity)})`);
  console.log('');

  // Exposure one-liners — the lead-magnet surface.
  console.log('  EXPOSURE');
  console.log(`    Tools granted vs used: ${r.ingest.distinct_tools} distinct tools, ` +
    `${r.permission.summary.over_permissioned_actors} over-permissioned actor(s)`);
  console.log(`    Egress destinations: ${r.ingest.distinct_hosts} host(s); ` +
    `${r.ingest.egress_events} egress event(s), ${r.ingest.sensitive_events} carrying sensitive data`);
  console.log(`    Shared credentials: ${r.permission.summary.shared_keys}   ` +
    `Wildcard grants: ${r.permission.summary.wildcard_actors}`);
  console.log('');

  // Per-control status.
  console.log('  ASR CONTROLS (assessed)');
  for (const c of s.controls) {
    console.log(`    ${STATUS_MARK[c.status]} ${c.id} ${c.name} — ${c.findings} finding(s) [${fmtSeverity(c.by_severity)}]`);
  }
  console.log('  NOT ASSESSED');
  for (const n of s.not_assessed) console.log(`    [----]  ${n.id} — ${n.reason}`);
  console.log('');

  // Blocking findings, mapped to the buyer's frameworks.
  if (s.blocking.length) {
    console.log('  DEAL-BLOCKING FINDINGS (critical / high)');
    const sorted = [...s.blocking].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
    for (const f of sorted) {
      console.log(`    • [${f.severity.toUpperCase()}] ${f.title}`);
      console.log(`        ${f.asr || '—'}  ·  ${f.frameworks.join(' · ') || 'no framework mapping'}`);
    }
  } else {
    console.log('  No deal-blocking findings in the assessed controls.');
  }
  console.log(line);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file) {
    console.error('usage: node scripts/audit-run.mjs <export.jsonl> [--source litellm] [--json] [--retention-days 182]');
    console.error(`spec: ${AUDIT_SPEC_VERSION}`);
    process.exit(2);
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`no such file: ${abs}`);
    process.exit(2);
  }
  const logs = fs.readFileSync(abs, 'utf8');
  const result = runAudit(logs, { source: args.source, retentionDays: args.retentionDays });

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    printReport(result);
  }
}

main();
