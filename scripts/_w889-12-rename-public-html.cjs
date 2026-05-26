#!/usr/bin/env node
// W889-12.1 — Sweep public/**/*.html files and update GitHub org references
// from `sneaky-hippo` to `kolm-ai`. Excludes:
//   - public/brand/github-org-decision.html   (intentional governance record)
//   - public/brand/values.html                (mentions old org as historical note)
//   - public/brand/company-entity.html        (same)
//   - public/brand/index.html                 (same)
//
// Plus excludes the global archive/ and backups/ trees outside of public/.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const FROM = 'sneaky-hippo';
const TO = 'kolm-ai';

const EXCLUDE_PATHS = new Set([
  path.join(PUBLIC, 'brand', 'github-org-decision.html'),
  path.join(PUBLIC, 'brand', 'values.html'),
  path.join(PUBLIC, 'brand', 'company-entity.html'),
  path.join(PUBLIC, 'brand', 'index.html'),
]);

const files = [];
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile() && /\.html$/i.test(e.name)) files.push(full);
  }
}
walk(PUBLIC);

let totalFilesChanged = 0;
let totalOccurrences = 0;
const perFile = [];

for (const abs of files) {
  if (EXCLUDE_PATHS.has(abs)) continue;
  const before = fs.readFileSync(abs, 'utf-8');
  if (!before.includes(FROM)) continue;
  const after = before.split(FROM).join(TO);
  const count = (before.match(new RegExp(FROM, 'g')) || []).length;
  fs.writeFileSync(abs, after);
  totalFilesChanged++;
  totalOccurrences += count;
  perFile.push({ file: path.relative(ROOT, abs).replace(/\\/g, '/'), occurrences: count });
}

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({
    ok: true,
    from: FROM,
    to: TO,
    files_changed: totalFilesChanged,
    occurrences_replaced: totalOccurrences,
    per_file_count: perFile.length,
  }, null, 2) + '\n');
} else {
  console.log(`[w889-12-rename-public-html] ${FROM} -> ${TO}: ${totalFilesChanged} files / ${totalOccurrences} occurrences`);
  // print top 10 by occurrence count
  perFile.sort((a, b) => b.occurrences - a.occurrences);
  for (const r of perFile.slice(0, 10)) console.log(`  ${r.occurrences.toString().padStart(3)}  ${r.file}`);
  if (perFile.length > 10) console.log(`  ... ${perFile.length - 10} more file(s)`);
}
