#!/usr/bin/env node
import {
  auditComplianceCertificationPacket,
  complianceCertificationCatalog,
  complianceCertificationManifestTemplate,
  validateComplianceCertificationManifest,
} from '../src/compliance-certification-packet.js';
import fs from 'node:fs';

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const catalog = args.includes('--catalog');
const template = args.includes('--template');
const requireLocal = args.includes('--require-local-contract');
const validateIdx = args.indexOf('--validate');

function usage() {
  console.log(`kolm compliance certification packet

USAGE
  node scripts/compliance-certification-packet.mjs [--summary]
  node scripts/compliance-certification-packet.mjs --catalog
  node scripts/compliance-certification-packet.mjs --template
  node scripts/compliance-certification-packet.mjs --validate reports/compliance-certification-manifest.json

FLAGS
  --require-local-contract   exit non-zero if local evidence files are missing

SCOPE
  Local only. This validates the evidence packet shape and never claims a live
  SOC 2, ISO 27001, HIPAA, GDPR, FedRAMP, SLSA, or SBOM certification.`);
}

if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

if (catalog) {
  console.log(JSON.stringify({ ok: true, ...complianceCertificationCatalog() }, null, 2));
  process.exit(0);
}

if (template) {
  console.log(JSON.stringify({ ok: true, template: complianceCertificationManifestTemplate() }, null, 2));
  process.exit(0);
}

if (validateIdx !== -1) {
  const file = args[validateIdx + 1];
  if (!file) {
    console.error('missing manifest path after --validate');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const validation = validateComplianceCertificationManifest(manifest);
  console.log(JSON.stringify(validation, null, 2));
  process.exit(validation.ok ? 0 : 1);
}

const audit = auditComplianceCertificationPacket();
if (summary) {
  console.log(`ok=${audit.ok} live_certification_verified=${audit.live_certification_verified} controls=${audit.controls.length} files=${audit.files.filter((f) => f.exists).length}/${audit.files.length} blockers=${audit.blockers.length}`);
  for (const blocker of audit.blockers) console.log(`blocker: ${blocker}`);
} else {
  console.log(JSON.stringify(audit, null, 2));
}

if (requireLocal && !audit.local_contract_ok) process.exit(1);
