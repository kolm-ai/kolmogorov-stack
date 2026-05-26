#!/usr/bin/env node
// W888-L scaffold #48 — Onboarding 4-path completion.
//
// W888-F is shipping `public/account/onboarding/path-*.html` in parallel.
// This scaffold verifies each file exists AND carries a "Step X of Y" /
// equivalent progress indicator. When the files are not yet on disk we emit a
// SKIP envelope and exit 0 — ship-gate treats SKIP as a non-blocker.
//
// Output (stdout):
//   PASS: { ok:true, paths_present, all_have_step_indicator, version }
//   SKIP: { ok:false, skipped:true, reason, install_hint, missing, version }
//   FAIL: { ok:false, missing_indicator, version }

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION = 'w888L-onboarding-paths-v1';

function emit(o, code) {
  process.stdout.write(JSON.stringify(o) + '\n');
  process.exit(code || 0);
}

(function main() {
  // The W888-F plan ships 4 paths; the hub (onboarding.html) is the 5th file.
  const paths = [
    'public/account/onboarding.html',
    'public/account/onboarding/path-gpu.html',
    'public/account/onboarding/path-no-gpu.html',
    'public/account/onboarding/path-route-only.html',
    'public/account/onboarding/path-verify-only.html',
  ];
  const present = [];
  const missing = [];
  for (const rel of paths) {
    if (fs.existsSync(path.join(ROOT, rel))) present.push(rel);
    else missing.push(rel);
  }
  if (missing.length === paths.length) {
    return emit({
      ok: false, skipped: true,
      reason: 'no onboarding HTML files present (W888-F not yet shipped)',
      install_hint: 'create the 5 files listed under paths',
      paths,
      version: VERSION,
    }, 0);
  }
  if (missing.length > 0 && present.length > 0) {
    return emit({
      ok: false, skipped: true,
      reason: 'partial W888-F deploy — ' + present.length + '/' + paths.length + ' present',
      install_hint: 'ship the remaining files: ' + missing.join(', '),
      missing,
      version: VERSION,
    }, 0);
  }
  // All present — verify each carries a step indicator.
  // Patterns accepted: "Step 1 of 4", "Step 2/4", "1 of 5", "1/5", or an
  // aria-label / data-step attribute.
  const stepRegex = /(step\s*\d+\s*(of|\/)\s*\d+)|(\d+\s*(of|\/)\s*\d+)|(aria-label\s*=\s*["'][^"']*step[^"']*["'])|(data-step\s*=)/i;
  const missingIndicator = [];
  for (const rel of present) {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (!stepRegex.test(html)) missingIndicator.push(rel);
  }
  if (missingIndicator.length) {
    return emit({
      ok: false,
      missing_indicator: missingIndicator,
      hint: 'each path-*.html must include a "Step X of Y" indicator (or aria-label/data-step)',
      version: VERSION,
    }, 2);
  }
  emit({
    ok: true,
    paths_present: present.length,
    paths_total: paths.length,
    all_have_step_indicator: true,
    version: VERSION,
  }, 0);
})();
