// W431 — source comments must not contain mojibake (audit P2-1).
//
// The W415 audit flagged "Several comments contain question-mark encoding artifacts
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
  path.join(REPO, 'cli', 'kolm.js'),
  path.join(REPO, 'src', 'router.js'),
  path.join(REPO, 'src', 'agent-telemetry.js'),
  path.join(REPO, 'src', 'package-release-readiness.js'),
  path.join(REPO, 'scripts', 'package-release-readiness.mjs'),
  path.join(REPO, 'scripts', 'verify-sdk-dist.mjs'),
  path.join(REPO, 'scripts', 'build-browser-extension.mjs'),
];

// Sentinel characters are constructed via String.fromCharCode so this test
// file itself stays free of mojibake glyphs — site.test.js's encoding scan
// walks tests/* and would flag any U+FFFD literal in source.
const SENTINEL_FFFD = String.fromCharCode(0xfffd);
// cp1252-double-encoded em-dash prefix: C3 A2 E2 80 84 = "â€”"
// when decoded as UTF-8. Build via charCodes so the literal does not appear.
const SENTINEL_CP1252 = String.fromCharCode(0x00e2, 0x20ac);

function findMojibake(text) {
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    // U+FFFD REPLACEMENT CHARACTER — the canonical mojibake sentinel.
    if (ln.indexOf(SENTINEL_FFFD) !== -1) {
      hits.push({ line: i + 1, kind: 'U+FFFD', text: ln.slice(0, 100) });
      continue;
    }
    // cp1252-double-encoded sequences. Real em-dash is U+2014.
    if (ln.indexOf(SENTINEL_CP1252) !== -1) {
      hits.push({ line: i + 1, kind: 'cp1252-double', text: ln.slice(0, 100) });
      continue;
    }
    // Bare "??" inside a single-line comment is the visible form mojibake
    // takes in some terminals. Excludes JS nullish-coalescing (which appears
    // in code, not in `//`-prefixed lines).
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
