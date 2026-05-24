#!/usr/bin/env node
import {
  auditRuntimeAdoptionPackets,
  runtimeAdoptionCatalog,
  runtimeAdoptionManifestTemplate,
  validateRuntimeAdoptionManifest,
} from '../src/runtime-adoption-packets.js';
import fs from 'node:fs';

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const catalog = args.includes('--catalog');
const template = args.includes('--template');
const json = args.includes('--json') || (!summary && !catalog);
const requireLocal = args.includes('--require-local-contract');
const requireExternal = args.includes('--require-external-adoption');
const validateIdx = args.indexOf('--validate');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`kolm runtime adoption packets

USAGE
  node scripts/runtime-adoption-packets.mjs [--summary] [--json]
  node scripts/runtime-adoption-packets.mjs --catalog
  node scripts/runtime-adoption-packets.mjs --template
  node scripts/runtime-adoption-packets.mjs --validate reports/runtime-adoption-manifest.json

FLAGS
  --require-local-contract     fail if local adapter packet files are missing
  --require-external-adoption  fail until external PR/package evidence is recorded`);
  process.exit(0);
}

if (catalog) {
  console.log(JSON.stringify({ ok: true, ...runtimeAdoptionCatalog() }, null, 2));
  process.exit(0);
}

if (template) {
  console.log(JSON.stringify({ ok: true, template: runtimeAdoptionManifestTemplate() }, null, 2));
  process.exit(0);
}

if (validateIdx !== -1) {
  const file = args[validateIdx + 1];
  if (!file) {
    console.error('missing manifest path after --validate');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const validation = validateRuntimeAdoptionManifest(manifest);
  console.log(JSON.stringify(validation, null, 2));
  process.exit(validation.ok ? 0 : 1);
}

const audit = auditRuntimeAdoptionPackets();
if (summary) {
  console.log(`ok=${audit.ok} external_adoption_verified=${audit.external_adoption_verified} targets=${audit.counts.targets} files=${audit.counts.present_files}/${audit.counts.required_files} blockers=${audit.counts.blockers}`);
  for (const target of audit.targets) console.log(`${target.id}: ${target.status}`);
} else if (json) {
  console.log(JSON.stringify(audit, null, 2));
}

if (requireLocal && !audit.ok) process.exit(1);
if (requireExternal && !audit.external_adoption_verified) process.exit(1);
