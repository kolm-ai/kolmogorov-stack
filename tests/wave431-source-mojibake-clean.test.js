// W431 — source comments must not contain mojibake (audit P2-1).
//
// The W415 audit flagged "Several comments contain ?? or encoding artifacts
// near newer W411 sections" in src/router.js and src/agent-telemetry.js.
// Investigation in the W431 fix wave showed the files were already clean
// (the mojibake was cleaned in the W411 closer batch). This test is the
// regression guard the audit asked for: any future paste-from-Word or
// double-encoded UTF-8 round-trip will trip it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const FILES = [
  path.join(REPO, 'src', 'router.js'),
  path.join(REPO, 'src', 'agent-telemetry.js'),
];

function findMojibake(text) {
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    // U+FFFD REPLACEMENT CHARACTER — the canonical mojibake sentinel.
    if (/�/.test(ln)) {
      hits.push({ line: i + 1, kind: 'U+FFFD', text: ln.slice(0, 100) });
      continue;
    }
    // cp1252-double-encoded sequences. Real em-dash is U+2014.
    // The double-encoded form shows up as "â€" prefix (C3 A2 E2 80).
    if (/â€/.test(ln)) {
      hits.push({ line: i + 1, kind: 'cp1252-double', text: ln.slice(0, 100) });
      continue;
    }
    // Bare "??" inside a single-line comment (// ... ??) is the visible
    // form mojibake takes in some terminals. Excludes JS nullish-coalescing
    // (which appears in code, not in `//`-prefixed lines).
    if (/^\s*\/\//.test(ln) && /\?\?/.test(ln)) {
      hits.push({ line: i + 1, kind: 'bare-?? in comment', text: ln.slice(0, 100) });
    }
  }
  return hits;
}

for (const file of FILES) {
  test(`W431 — ${path.basename(file)} contains no mojibake artifacts`, () => {
    const txt = fs.readFileSync(file, 'utf8');
    const hits = findMojibake(txt);
    if (hits.length) {
      const summary = hits.slice(0, 10).map(h =>
        `  line ${h.line} (${h.kind}): ${h.text}`).join('\n');
      assert.fail(`found ${hits.length} mojibake hits in ${path.basename(file)}:\n${summary}`);
    }
  });
}
