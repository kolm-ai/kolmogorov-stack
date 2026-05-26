#!/usr/bin/env node
// W888-M scan-errors — harvest `throw new Error(...)` (and Kolm-specific
// error sites) from src/ and cli/, emitting one row per call site to
// data/assistant-corpus/error-catalog.json.
//
// If data/error-catalog.json already exists, we prefer it as authoritative
// (the W478/W490 catalog) and merge against the scan output. When the
// scan returns 0 rows and no catalog exists, we emit [] and warn — no
// fabrication. Each row: { message, file, line, code? }.

'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const OUT_PATH = path.join(REPO, 'data', 'assistant-corpus', 'error-catalog.json');
const EXISTING_CATALOG = path.join(REPO, 'data', 'error-catalog.json');

// Recursively walk a directory, returning every .js / .cjs / .mjs / .ts file.
function walk(dir, hits) {
  hits = hits || [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return hits; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Skip noisy folders.
      if (e.name === 'node_modules' || e.name === '__pycache__') continue;
      walk(full, hits);
    } else if (/\.(js|cjs|mjs|ts)$/.test(e.name)) {
      hits.push(full);
    }
  }
  return hits;
}

// Extract throw-site rows from one file. We support:
//   throw new Error('msg')           string literal
//   throw new Error("msg")           string literal
//   throw new Error(`msg`)           template literal (kept as-is, no interp)
//   throw new <CustomError>('msg')   any name ending in Error / Exception
//   const err = new Error('msg');    bare construction we treat as fallible
//                                    (only when the immediately-prior line
//                                    contains `throw` somewhere or the var
//                                    `err.exitCode` is set in the next few
//                                    lines — kept conservative).
function scanFile(filePath) {
  const rel = path.relative(REPO, filePath).replace(/\\/g, '/');
  let src;
  try { src = fs.readFileSync(filePath, 'utf8'); }
  catch (_) { return []; }
  const lines = src.split(/\r?\n/);
  const rows = [];
  // Pattern 1: direct throw new <Name>Error(...)
  const reThrow = /throw\s+new\s+([A-Z]\w*(?:Error|Exception))\s*\(\s*([`'"])([^`'"]*?)\2/g;
  let m;
  while ((m = reThrow.exec(src)) !== null) {
    const idx = m.index;
    const line = src.slice(0, idx).split(/\r?\n/).length;
    rows.push({
      message: m[3].trim(),
      file: rel,
      line,
      code: m[1],
    });
  }
  // Pattern 2: `const err = new Error(...)` followed within 3 lines by
  // `err.exitCode` or `throw err`. Picks up the kolm.js convention.
  for (let i = 0; i < lines.length; i++) {
    const construct = lines[i].match(/=\s*new\s+Error\s*\(\s*([`'"])([^`'"]*?)\1/);
    if (!construct) continue;
    let throws = false;
    for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
      if (/\bthrow\b/.test(lines[j]) || /\.exitCode\s*=/.test(lines[j])) {
        throws = true;
        break;
      }
    }
    if (!throws) continue;
    rows.push({
      message: construct[2].trim(),
      file: rel,
      line: i + 1,
      code: 'Error',
    });
  }
  return rows;
}

function build() {
  const srcDir = path.join(REPO, 'src');
  const cliDir = path.join(REPO, 'cli');
  const files = [...walk(srcDir), ...walk(cliDir)];
  let rows = [];
  for (const f of files) rows = rows.concat(scanFile(f));
  // Dedup by (message, file). Keep first.
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = r.file + '::' + r.message;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  // Prefer pre-built catalog if present.
  let merged = out;
  if (fs.existsSync(EXISTING_CATALOG)) {
    try {
      const existing = JSON.parse(fs.readFileSync(EXISTING_CATALOG, 'utf8'));
      if (Array.isArray(existing) && existing.length > 0) {
        // Merge: existing-first, then any scan-only entries.
        const existKeys = new Set(existing.map(e => (e.file || '') + '::' + (e.message || '')));
        const extra = out.filter(o => !existKeys.has(o.file + '::' + o.message));
        merged = existing.concat(extra);
      }
    } catch (_) { /* fall through to scan-only */ }
  }
  return { generated_at: new Date().toISOString(), count: merged.length, errors: merged };
}

function main() {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const result = build();
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
  if (result.count === 0) {
    process.stderr.write('warn: scan-errors found 0 throw sites in src/ + cli/\n');
  } else {
    process.stdout.write(`scan-errors: ${result.count} errors -> ${path.relative(REPO, OUT_PATH)}\n`);
  }
}

if (require.main === module) main();
module.exports = { build };
