#!/usr/bin/env node
import {
  auditFormatGovernancePacket,
  formatGovernanceCatalog,
  formatGovernanceSubmissionTemplate,
  validateFormatGovernanceSubmission,
} from '../src/format-governance-packet.js';
import fs from 'node:fs';

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const catalog = args.includes('--catalog');
const template = args.includes('--template');
const json = args.includes('--json') || (!summary && !catalog);
const requireLocal = args.includes('--require-local-contract');
const requireExternal = args.includes('--require-external-acceptance');
const validateIdx = args.indexOf('--validate');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`kolm format governance packet

USAGE
  node scripts/format-governance-packet.mjs [--summary] [--json]
  node scripts/format-governance-packet.mjs --catalog
  node scripts/format-governance-packet.mjs --template
  node scripts/format-governance-packet.mjs --validate reports/format-governance-submission.json

FLAGS
  --require-local-contract       fail if local governance packet files are missing
  --require-external-acceptance  fail until outside acceptance is recorded`);
  process.exit(0);
}

if (catalog) {
  console.log(JSON.stringify({ ok: true, ...formatGovernanceCatalog() }, null, 2));
  process.exit(0);
}

if (template) {
  console.log(JSON.stringify({ ok: true, template: formatGovernanceSubmissionTemplate() }, null, 2));
  process.exit(0);
}

if (validateIdx !== -1) {
  const file = args[validateIdx + 1];
  if (!file) {
    console.error('missing manifest path after --validate');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const validation = validateFormatGovernanceSubmission(manifest);
  console.log(JSON.stringify(validation, null, 2));
  process.exit(validation.ok ? 0 : 1);
}

const audit = auditFormatGovernancePacket();
if (summary) {
  console.log(`ok=${audit.ok} external_acceptance_verified=${audit.external_acceptance_verified} files=${audit.counts.present_files}/${audit.counts.required_files} blockers=${audit.counts.blockers}`);
  for (const blocker of audit.blockers) console.log(`blocker: ${blocker}`);
} else if (json) {
  console.log(JSON.stringify(audit, null, 2));
}

if (requireLocal && !audit.ok) process.exit(1);
if (requireExternal && !audit.external_acceptance_verified) process.exit(1);
