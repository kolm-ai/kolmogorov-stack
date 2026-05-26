#!/usr/bin/env node
// W889-12.1 — One-shot helper to update hardcoded GitHub org references from
// the W490-era org (`sneaky-hippo`) to the canonical `kolm-ai` org per the
// MCD final-polish directive.
//
// SCOPE (intentionally limited):
//   - cli/, src/, scripts/, sdk/, packages/, .github/, tools/, infra/, docs/,
//     CONTRIBUTING.md, README.md, vercel.json
// EXCLUDED (preserved as historical record):
//   - archive/   (snapshot of pre-rename prod)
//   - backups/   (old versioned snapshots)
//   - public/brand/github-org-decision.html (governance record of the
//     deliberation; describes the rename happening in Q3 2026)
//   - data/assistant-corpus/error-catalog.json (historical fixture)
//   - md-links-test/ (third-party sample)
//   - any *.tap / debug.log files

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FROM = 'sneaky-hippo';
const TO = 'kolm-ai';

// Files passed via argv, or the curated allowlist below.
const TARGETS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      // critical CLI + server
      'cli/kolm.js',
      'src/changelog.js',
      'src/daemon-connector.js',
      // SDK + package manifests
      'sdk/node/package.json',
      'sdk/node/README.md',
      'sdk/mcp/package.json',
      'sdk/vscode/package.json',
      'sdk/python/pyproject.toml',
      'sdk/python/kolm/client.py',
      'packages/attestation/package.json',
      'packages/homebrew/kolm.rb',
      'packages/homebrew/README.md',
      'packages/langchain-kolm/package.json',
      'packages/langchain-kolm/README.md',
      'packages/llamaindex-kolm/package.json',
      'packages/llamaindex-kolm/README.md',
      'packages/python-langchain-kolm/pyproject.toml',
      'packages/python-langchain-kolm/README.md',
      'packages/python-llamaindex-kolm/pyproject.toml',
      'packages/python-llamaindex-kolm/README.md',
      'packages/sdk-rn/kolm-rn.podspec',
      'packages/sdk-rn/package.json',
      'packages/sdk-ts/package.json',
      'packages/sdk-ts/README.md',
      'packages/vscode-kolm-rag/package.json',
      'packages/winget/kolm.kolm.installer.yaml',
      'packages/winget/kolm.kolm.locale.en-US.yaml',
      'packages/winget/README.md',
      'scripts/brew/kolm.rb',
      'scripts/winget/kolm.yaml',
      'scripts/write-w869-cli-docs.cjs',
      'scripts/write-missing-cli-docs.cjs',
      'scripts/write-extra-cli-docs.cjs',
      'scripts/wave887-docs-generator.cjs',
      // GitHub actions
      '.github/actions/kolm-compile/action.yml',
      '.github/actions/kolm-gate-k-score/action.yml',
      '.github/actions/kolm-publish/action.yml',
      '.github/actions/kolm-test/action.yml',
      '.github/actions/kolm-verify/action.yml',
      // Helm / infra
      'tools/helm/kolm/Chart.yaml',
      'tools/helm/kolm/README.md',
      'tools/helm/kolm/values.yaml',
      'infra/aws-marketplace/cloudformation.yaml',
      // Top-level docs
      'CONTRIBUTING.md',
      'README.md',
      'vercel.json',
    ];

let totalFilesChanged = 0;
let totalOccurrences = 0;
const perFile = [];

for (const rel of TARGETS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const before = fs.readFileSync(abs, 'utf-8');
  if (!before.includes(FROM)) continue;
  const after = before.split(FROM).join(TO);
  const count = (before.match(new RegExp(FROM, 'g')) || []).length;
  fs.writeFileSync(abs, after);
  totalFilesChanged++;
  totalOccurrences += count;
  perFile.push({ file: rel, occurrences: count });
}

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({
    ok: true,
    from: FROM,
    to: TO,
    files_changed: totalFilesChanged,
    occurrences_replaced: totalOccurrences,
    per_file: perFile,
  }, null, 2) + '\n');
} else {
  console.log(`[w889-12-rename] ${FROM} -> ${TO}: ${totalFilesChanged} files / ${totalOccurrences} occurrences`);
  for (const r of perFile) console.log(`  ${r.occurrences.toString().padStart(3)}  ${r.file}`);
}
