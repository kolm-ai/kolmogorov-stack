#!/usr/bin/env node
// W903 — strip brand-anchor SEO disambiguation spans containing "Not Kolm
// therapeutics" across all public/*.html. The span was a hidden screen-reader
// SEO hack from W170-era; user mandate (2026-05-27): "served its purpose but
// looks unprofessional now". Remove entirely from rendered surfaces.
//
// Scope: only public/**/*.html. Pattern: <span class="brand-anchor" ...>...</span>
// matched non-greedy across the whole tag. If the span sits on its own line,
// the trailing \n is also consumed to avoid leaving blank lines.
//
// Exit codes: 0 = clean run (count printed); non-zero = unexpected error.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'public');

// Walk synchronously; the tree is bounded and we want deterministic output.
function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && p.endsWith('.html')) out.push(p);
  }
  return out;
}

const SPAN_RE = /<span\s+class="brand-anchor"[^>]*>[\s\S]*?<\/span>\n?/g;

let filesTouched = 0;
let spansRemoved = 0;
for (const file of walk(ROOT, [])) {
  const before = fs.readFileSync(file, 'utf8');
  if (!before.includes('brand-anchor')) continue;
  const after = before.replace(SPAN_RE, '');
  const removed = (before.match(SPAN_RE) || []).length;
  if (removed > 0 && after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    filesTouched++;
    spansRemoved += removed;
  }
}

process.stdout.write(`W903 strip: ${spansRemoved} brand-anchor spans removed across ${filesTouched} files\n`);
