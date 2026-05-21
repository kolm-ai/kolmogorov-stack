#!/usr/bin/env node
import {
  cloudReadinessSummary,
  detectCloudReadiness,
  listPlatformCapabilities,
  validatePlatformCapabilities,
} from '../src/platform-capabilities.js';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const out = {
  ok: true,
  platform_matrix: validatePlatformCapabilities(),
  cloud_readiness: detectCloudReadiness(process.env),
};
if (args.includes('--summary') || strict) {
  const summary = cloudReadinessSummary(process.env);
  out.ok = strict ? summary.ok : summary.platform_matrix.ok;
  out.summary = summary;
} else {
  out.ok = out.platform_matrix.ok;
}
if (args.includes('--capabilities')) out.capabilities = listPlatformCapabilities();
if (args.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const counts = out.platform_matrix.counts;
  console.log(`platform: ok=${out.platform_matrix.ok} frameworks=${counts.frameworks} model_families=${counts.model_families} devices=${counts.device_targets} methods=${counts.methods} enterprise=${counts.enterprise_controls} observability=${counts.observability_controls} scale=${counts.scale_controls}`);
  for (const [category, row] of Object.entries(out.cloud_readiness.categories)) {
    console.log(`${category}: ${row.configured}/${row.total} configured${row.ids.length ? ' (' + row.ids.join(', ') + ')' : ''}`);
  }
  if (out.summary?.blockers?.length) console.log('blockers: ' + out.summary.blockers.join(', '));
}
if (!out.ok) process.exit(1);
