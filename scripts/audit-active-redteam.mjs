#!/usr/bin/env node
// Agent Security-Review - Deep Red-Team CLI (consented ACTIVE injection battery).
//
// Runs the passive audit over a log export, fires the CONSENTED active battery
// (src/active-redteam.js) at a vendor STAGING endpoint, merges the active
// outcomes into the red_team block (src/red-team.js mergeActiveResults), and
// signs the result through the existing report builder - the signed envelope
// picks the merged block up via buildRedTeamBlock with zero builder changes.
//
//   node scripts/audit-active-redteam.mjs \
//     --logs <export.jsonl> \
//     --endpoint https://staging.vendor.example/v1/chat/completions \
//     --consent-token <token> \
//     --consent-statement "We authorize kolm to probe https://staging.vendor.example/v1/chat/completions" \
//     [--source litellm] [--model staging-agent] [--subject "Vendor fleet"] \
//     [--attestor name@vendor.example] [--timeout-ms 15000] [--out report.json]
//
// Exits 1 when any merged probe is exposed, 2 on usage errors. The consent
// gate is hard: no token + endpoint-naming statement, no probe is ever sent.

import fs from 'node:fs';
import path from 'node:path';
import { runAudit } from '../src/audit-orchestrator.js';
import { runActiveBattery, ACTIVE_RED_TEAM_SPEC_VERSION } from '../src/active-redteam.js';
import { mergeActiveResults, RED_TEAM_SPEC_VERSION } from '../src/red-team.js';
import { buildAndSignReport } from '../src/attestation-report-builder.js';

function parseArgs(argv) {
  const out = { _: [] };
  const take = (name) => { out[name] = argv[++i]; };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--logs') take('logs');
    else if (a === '--endpoint') take('endpoint');
    else if (a === '--consent-token') take('consentToken');
    else if (a === '--consent-statement') take('consentStatement');
    else if (a === '--attestor') take('attestor');
    else if (a === '--source') take('source');
    else if (a === '--model') take('model');
    else if (a === '--subject') take('subject');
    else if (a === '--timeout-ms') take('timeoutMs');
    else if (a === '--out') take('out');
    else out._.push(a);
  }
  return out;
}

function usage() {
  console.error('usage: node scripts/audit-active-redteam.mjs --logs <export.jsonl> --endpoint <url> --consent-token <t> --consent-statement "<statement naming the endpoint>" [--source litellm] [--model m] [--subject name] [--attestor who] [--timeout-ms 15000] [--out report.json]');
  console.error(`spec: ${RED_TEAM_SPEC_VERSION} + ${ACTIVE_RED_TEAM_SPEC_VERSION}`);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.logs || !args.endpoint || !args.consentToken || !args.consentStatement) usage();

  const abs = path.resolve(args.logs);
  if (!fs.existsSync(abs)) {
    console.error(`no such file: ${abs}`);
    process.exit(2);
  }
  const logs = fs.readFileSync(abs, 'utf8');

  // 1. Passive audit over the export (deterministic, offline).
  const audit = runAudit(logs, { source: args.source });

  // 2. Consented active battery against the staging endpoint. The consent gate
  //    inside runActiveBattery throws CONSENT_REQUIRED before any probe is sent
  //    if the record is missing or does not name the endpoint.
  let active;
  try {
    active = await runActiveBattery({
      endpoint: args.endpoint,
      model: args.model,
      timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
      consent: {
        token: args.consentToken,
        statement: args.consentStatement,
        attestor: args.attestor,
        asserted_at: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error(`active battery refused: ${e.message}${e.code ? ` [${e.code}]` : ''}`);
    process.exitCode = 2;
    return;
  }

  // 3. Merge active outcomes into the red_team block on the audit result -
  //    BEFORE the report builder runs, so the signed envelope carries the
  //    merged block through the existing buildRedTeamBlock path unchanged.
  audit.red_team = mergeActiveResults(audit.red_team, active);

  // 4. Build + sign the deliverable.
  const { envelope, report_id, key_fingerprint, signed_at } = buildAndSignReport(audit, {
    subject: args.subject || 'Deep Red-Team subject',
    tier: 'report',
  });

  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(envelope, null, 2) + '\n');
  }

  // 5. Probe table.
  const rt = audit.red_team;
  const line = '-'.repeat(72);
  console.log(line);
  console.log(`  DEEP RED-TEAM - ACTIVE INJECTION BATTERY   (${rt.spec_version})`);
  console.log(line);
  console.log(`  Endpoint digest: ${active.endpoint_digest}`);
  console.log(`  Consent: recorded (attestor: ${active.consent.attestor}, asserted_at: ${active.consent.asserted_at})`);
  console.log(`  Active window: ${active.started_at} -> ${active.finished_at}`);
  console.log('');
  for (const p of rt.probes) {
    const mark = p.status === 'exposed' ? '[EXPOSED] ' : p.status === 'resisted' ? '[RESISTED]' : '[UNTESTED]';
    console.log(`    ${mark} ${p.id}  (${p.severity}, evidence: ${p.evidence_source || 'passive'})`);
  }
  console.log('');
  const s = rt.summary;
  console.log(`  Score: ${s.red_team_score == null ? 'n/a' : s.red_team_score}   resisted ${s.resisted} / exposed ${s.exposed} / untested ${s.untested}`);
  if (s.active) console.log(`  Active outcomes merged: ${s.active.probes_merged}`);
  console.log(`  Report: ${report_id}  key ${key_fingerprint}  signed ${signed_at}${args.out ? `  -> ${args.out}` : ''}`);
  console.log(line);

  // process.exitCode (not process.exit) so in-flight fetch/undici handles can
  // drain cleanly - a hard exit here races libuv handle teardown on Windows.
  process.exitCode = s.exposed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(`audit-active-redteam failed: ${e && e.message ? e.message : e}`);
  process.exitCode = 2;
});
