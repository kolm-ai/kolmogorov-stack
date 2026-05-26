// W750-followup — Heuristic copyright detector tests.
//
// W750 (copyright filter + capture quarantine) was MERGED into W808 in the
// 2026-05-24 dup-cleanup. The quarantine half shipped under W808; the
// remaining copyright-classifier slice ships under this followup as a
// regex pack for common copyrighted-content fingerprints (Disney character
// names, Top-100 song-title n-grams, code copyright headers, SPDX lines).
// It hooks into the W808 staged_captures pipeline as a post-quarantine
// classifier via src/capture-store.js insertCapture.
//
// Atomic items pinned:
//
//   1) COPYRIGHT_VERSION matches /^w750-followup-/ (W604 anti-brittleness)
//   2) DISNEY_NAMES is a frozen array w/ canonical lowercase entries
//   3) LYRIC_FINGERPRINTS is a frozen array w/ canonical lowercase entries
//   4) CODE_COPYRIGHT_REGEX + SPDX_REGEX present + functional
//   5) scanText detects "Mickey Mouse" (case-insensitive) as disney_character
//   6) scanText detects SPDX header
//   7) scanText detects `Copyright (c) 2023 Acme Corp` code header
//   8) scanText: clean text returns hits:[] + risk_score:0
//   9) scanText: risk_score capped at 1.0 (many hits do not exceed cap)
//  10) scanCapture: scans both input + output, tags side per hit
//  11) classifyForQuarantine: flags above threshold (reason starts w/ copyright_heuristic:)
//  12) classifyForQuarantine: below threshold returns should_quarantine:false
//  13) GATING: KOLM_W750_COPYRIGHT_DETECTOR=off path unchanged in insertCapture
//  14) GATING (positive): with detector on, insertCapture stamps flag_reason +
//      copyright_heuristic_flagged sidecar
//  15) POST /v1/copyright/scan 401 without auth
//  16) POST /v1/copyright/scan 200 envelope w/ hits (text body)
//  17) GET  /v1/copyright/queue/:namespace 401 without auth
//  18) GET  /v1/copyright/queue/:namespace 200 envelope w/ shape
//  19) public/docs/copyright-scan.html exists with brand-lock + heuristic disclaimer
//  20) vercel.json has /docs/copyright-scan rewrite
//  21) cli/kolm.js defines cmdW750Copyright exactly once + wired from case 'copyright-scan'
//  22) wave750 sibling test count uses wave(\d{3,4}) regex + threshold (W604 anti-brittleness)
//
// W604 anti-brittleness: every version assertion uses regex /^w750-followup-/
// instead of literal equality so a v1.x bump in the same wave does not force
// a coordinated test-rev.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  COPYRIGHT_VERSION,
  DISNEY_NAMES,
  LYRIC_FINGERPRINTS,
  CODE_COPYRIGHT_REGEX,
  SPDX_REGEX,
  scanText,
  scanCapture,
  classifyForQuarantine,
  shouldQuarantineForCopyright,
} from '../src/copyright-detector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'copyright-scan.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const CAPTURE_STORE_PATH = path.join(REPO_ROOT, 'src', 'capture-store.js');
const TESTS_DIR = __dirname;

// Each test seeds an isolated KOLM_DATA_DIR + HOME so the store does not
// leak rows across tests.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w750-' + crypto.randomBytes(4).toString('hex') + '-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_STORE_DRIVER = 'json';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  // Restore detector gate to default-on for each test; #13 flips it.
  delete process.env.KOLM_W750_COPYRIGHT_DETECTOR;
  return tmp;
}

// =============================================================================
// 1) COPYRIGHT_VERSION matches /^w750-followup-/
// =============================================================================

test('W750-followup #1 — COPYRIGHT_VERSION matches /^w750-followup-/', () => {
  freshDir();
  assert.ok(/^w750-followup-/.test(COPYRIGHT_VERSION),
    `expected COPYRIGHT_VERSION matching /^w750-followup-/; got ${JSON.stringify(COPYRIGHT_VERSION)}`);
  assert.equal(COPYRIGHT_VERSION, 'w750-followup-v1',
    `spec mandates initial COPYRIGHT_VERSION='w750-followup-v1'; got ${JSON.stringify(COPYRIGHT_VERSION)}`);
});

// =============================================================================
// 2) DISNEY_NAMES is a frozen array w/ canonical lowercase entries
// =============================================================================

test('W750-followup #2 — DISNEY_NAMES is a frozen lowercase array w/ canonical seeds', () => {
  freshDir();
  assert.ok(Array.isArray(DISNEY_NAMES), 'DISNEY_NAMES must be an array');
  assert.ok(Object.isFrozen(DISNEY_NAMES),
    'DISNEY_NAMES must be Object.freeze()d (W604 anti-brittleness)');
  assert.ok(DISNEY_NAMES.length >= 20,
    `DISNEY_NAMES should bundle ~20+ names per spec; got ${DISNEY_NAMES.length}`);
  // Canonical seeds the spec calls out explicitly.
  for (const needle of ['mickey mouse', 'donald duck', 'elsa', 'anna', 'olaf', 'simba']) {
    assert.ok(DISNEY_NAMES.includes(needle),
      `DISNEY_NAMES must contain canonical seed ${JSON.stringify(needle)}`);
  }
  // Every entry must be lowercase.
  for (const n of DISNEY_NAMES) {
    assert.equal(typeof n, 'string', `DISNEY_NAMES entries must be strings; got ${typeof n}`);
    assert.equal(n, n.toLowerCase(),
      `DISNEY_NAMES entries must be lowercase; got ${JSON.stringify(n)}`);
  }
});

// =============================================================================
// 3) LYRIC_FINGERPRINTS is a frozen array w/ canonical lowercase entries
// =============================================================================

test('W750-followup #3 — LYRIC_FINGERPRINTS is a frozen lowercase array w/ canonical seeds', () => {
  freshDir();
  assert.ok(Array.isArray(LYRIC_FINGERPRINTS),
    'LYRIC_FINGERPRINTS must be an array');
  assert.ok(Object.isFrozen(LYRIC_FINGERPRINTS),
    'LYRIC_FINGERPRINTS must be Object.freeze()d (W604 anti-brittleness)');
  assert.ok(LYRIC_FINGERPRINTS.length >= 25,
    `LYRIC_FINGERPRINTS should bundle ~30 fingerprints per spec; got ${LYRIC_FINGERPRINTS.length}`);
  // Canonical seeds the spec calls out explicitly.
  for (const needle of ['hey jude', 'imagine all the people', 'i will always love you']) {
    assert.ok(LYRIC_FINGERPRINTS.includes(needle),
      `LYRIC_FINGERPRINTS must contain canonical seed ${JSON.stringify(needle)}`);
  }
  // Every entry must be lowercase.
  for (const n of LYRIC_FINGERPRINTS) {
    assert.equal(typeof n, 'string', `LYRIC_FINGERPRINTS entries must be strings; got ${typeof n}`);
    assert.equal(n, n.toLowerCase(),
      `LYRIC_FINGERPRINTS entries must be lowercase; got ${JSON.stringify(n)}`);
  }
});

// =============================================================================
// 4) CODE_COPYRIGHT_REGEX + SPDX_REGEX present + functional
// =============================================================================

test('W750-followup #4 — CODE_COPYRIGHT_REGEX + SPDX_REGEX present + functional', () => {
  freshDir();
  assert.ok(CODE_COPYRIGHT_REGEX instanceof RegExp,
    'CODE_COPYRIGHT_REGEX must be a RegExp');
  assert.ok(SPDX_REGEX instanceof RegExp,
    'SPDX_REGEX must be a RegExp');
  // Code copyright regex catches the canonical "Copyright (c) 2023 Acme" form.
  assert.ok(CODE_COPYRIGHT_REGEX.test('Copyright (c) 2023 Acme Corp'),
    'CODE_COPYRIGHT_REGEX must match "Copyright (c) 2023 Acme Corp"');
  assert.ok(CODE_COPYRIGHT_REGEX.test('copyright © 2024 Foo'),
    'CODE_COPYRIGHT_REGEX must match "copyright © 2024 Foo"');
  assert.ok(CODE_COPYRIGHT_REGEX.test('Copyright 2025 Bar'),
    'CODE_COPYRIGHT_REGEX must match "Copyright 2025 Bar" (no (c) marker)');
  // SPDX regex catches the canonical "SPDX-License-Identifier: MIT" form.
  assert.ok(SPDX_REGEX.test('SPDX-License-Identifier: MIT'),
    'SPDX_REGEX must match "SPDX-License-Identifier: MIT"');
  assert.ok(SPDX_REGEX.test('// SPDX-License-Identifier: Apache-2.0'),
    'SPDX_REGEX must match an SPDX line inside a comment');
});

// =============================================================================
// 5) scanText detects "Mickey Mouse" (case-insensitive) as disney_character
// =============================================================================

test('W750-followup #5 — scanText detects Mickey Mouse case-insensitively', () => {
  freshDir();
  const v = scanText('In this story, Mickey Mouse meets Donald Duck for tea.');
  assert.equal(v.ok, true);
  // Both seeds should be reported with kind:'disney_character'.
  const disney = v.hits.filter((h) => h.kind === 'disney_character');
  assert.ok(disney.length >= 2,
    `expected 2+ disney_character hits; got ${disney.length}: ${JSON.stringify(disney)}`);
  const matched = disney.map((h) => h.matched);
  assert.ok(matched.includes('mickey mouse'),
    `expected matched:'mickey mouse' in ${JSON.stringify(matched)}`);
  assert.ok(matched.includes('donald duck'),
    `expected matched:'donald duck' in ${JSON.stringify(matched)}`);
  // Case-insensitivity proof on a different casing.
  const upper = scanText('MICKEY MOUSE rules.');
  const upDisney = upper.hits.filter((h) => h.kind === 'disney_character');
  assert.ok(upDisney.some((h) => h.matched === 'mickey mouse'),
    `case-insensitive match must work; got ${JSON.stringify(upDisney)}`);
});

// =============================================================================
// 6) scanText detects SPDX header
// =============================================================================

test('W750-followup #6 — scanText detects SPDX header', () => {
  freshDir();
  const v = scanText('// SPDX-License-Identifier: GPL-3.0-only\nint main(){}');
  assert.equal(v.ok, true);
  const spdx = v.hits.filter((h) => h.kind === 'spdx');
  assert.ok(spdx.length === 1,
    `expected exactly 1 spdx hit; got ${JSON.stringify(spdx)}`);
  assert.ok(spdx[0].matched.startsWith('SPDX-License-Identifier:'),
    `matched should start with SPDX-License-Identifier:; got ${JSON.stringify(spdx[0].matched)}`);
});

// =============================================================================
// 7) scanText detects `Copyright (c) 2023 Acme Corp` code header
// =============================================================================

test('W750-followup #7 — scanText detects Copyright (c) 2023 Acme Corp', () => {
  freshDir();
  const v = scanText('/*\n * Copyright (c) 2023 Acme Corp. All rights reserved.\n */\n');
  assert.equal(v.ok, true);
  const code = v.hits.filter((h) => h.kind === 'code_copyright');
  assert.ok(code.length === 1,
    `expected exactly 1 code_copyright hit; got ${JSON.stringify(code)}`);
  assert.ok(/Copyright \(c\) 2023 A/.test(code[0].matched),
    `matched should include the 2023 Acme prefix; got ${JSON.stringify(code[0].matched)}`);
});

// =============================================================================
// 8) scanText: clean text returns hits:[] + risk_score:0
// =============================================================================

test('W750-followup #8 — scanText on clean text returns hits:[] + risk_score:0', () => {
  freshDir();
  const v = scanText('What is the weather in Paris today?');
  assert.equal(v.ok, true);
  assert.deepEqual(v.hits, [],
    `expected hits:[] on clean text; got ${JSON.stringify(v.hits)}`);
  assert.equal(v.risk_score, 0,
    `expected risk_score:0 on clean text; got ${v.risk_score}`);
  // Empty + nullish inputs do not throw.
  assert.equal(scanText('').risk_score, 0);
  assert.equal(scanText(null).risk_score, 0);
  assert.equal(scanText(undefined).risk_score, 0);
  assert.equal(scanText({ nested: 'obj' }).risk_score, 0);
});

// =============================================================================
// 9) scanText: risk_score capped at 1.0
// =============================================================================

test('W750-followup #9 — scanText risk_score is capped at 1.0 even with many hits', () => {
  freshDir();
  // Build a text that has MANY (~10+) hits — multiple disney names, multiple
  // song titles, a copyright header, and an SPDX line. Dedup means the same
  // name twice is still 1 hit; we use distinct seeds.
  const text = [
    'Mickey Mouse and Minnie Mouse visited Donald Duck.',
    'Daisy Duck and Goofy started singing Hey Jude.',
    'They moved on to Let It Be and Imagine All The People.',
    'Then Bohemian Rhapsody started playing.',
    '// Copyright (c) 2024 Acme Corp',
    '// SPDX-License-Identifier: MIT',
  ].join('\n');
  const v = scanText(text);
  assert.ok(v.hits.length >= 8,
    `expected many hits; got ${v.hits.length}: ${JSON.stringify(v.hits.map(h => h.kind + ':' + h.matched))}`);
  assert.equal(v.risk_score, 1.0,
    `risk_score must saturate at 1.0; got ${v.risk_score}`);
  // Exact 1.0 not 1.000000001.
  assert.ok(v.risk_score <= 1,
    `risk_score must NOT exceed 1.0; got ${v.risk_score}`);
});

// =============================================================================
// 10) scanCapture: scans both input + output, tags side per hit
// =============================================================================

test('W750-followup #10 — scanCapture scans input + output and tags side', () => {
  freshDir();
  const row = {
    id: 'cap_w750_10',
    prompt: 'Tell me about Mickey Mouse',
    response: '// SPDX-License-Identifier: Apache-2.0\nconsole.log("hi");',
  };
  const v = scanCapture(row);
  assert.equal(v.ok, true);
  assert.equal(v.capture_id, 'cap_w750_10',
    `capture_id should be preserved; got ${v.capture_id}`);
  assert.ok(v.hits.length >= 2,
    `expected hits from both sides; got ${JSON.stringify(v.hits)}`);
  const inputHits = v.hits.filter((h) => h.side === 'input');
  const outputHits = v.hits.filter((h) => h.side === 'output');
  assert.ok(inputHits.some((h) => h.kind === 'disney_character'),
    `input-side disney hit missing; got ${JSON.stringify(inputHits)}`);
  assert.ok(outputHits.some((h) => h.kind === 'spdx'),
    `output-side spdx hit missing; got ${JSON.stringify(outputHits)}`);
  // Per-side risk scores broken out.
  assert.ok(v.input_risk > 0,
    `input_risk should be > 0; got ${v.input_risk}`);
  assert.ok(v.output_risk > 0,
    `output_risk should be > 0; got ${v.output_risk}`);
});

// =============================================================================
// 11) classifyForQuarantine: flags above threshold
// =============================================================================

test('W750-followup #11 — classifyForQuarantine flags above threshold w/ structured reason', () => {
  freshDir();
  const row = {
    capture_id: 'stg_w750_11',
    prompt: 'Mickey Mouse and Donald Duck',  // 2 disney hits, risk_score = 0.5
    response: 'plain text',
  };
  const v = classifyForQuarantine(row, { threshold: 0.5 });
  assert.equal(v.should_quarantine, true,
    `should_quarantine must be true at risk_score=${v.risk_score} threshold=0.5`);
  assert.ok(typeof v.reason === 'string' && v.reason.startsWith('copyright_heuristic:'),
    `reason must start with copyright_heuristic:; got ${JSON.stringify(v.reason)}`);
  assert.ok(v.reason.includes('disney_character'),
    `reason must include the disney_character category; got ${JSON.stringify(v.reason)}`);
  assert.ok(/^w750-followup-/.test(v.version),
    `version must match /^w750-followup-/; got ${JSON.stringify(v.version)}`);
});

// =============================================================================
// 12) classifyForQuarantine: below threshold returns should_quarantine:false
// =============================================================================

test('W750-followup #12 — classifyForQuarantine below threshold returns should_quarantine:false', () => {
  freshDir();
  // Single hit → risk_score = 0.25, below default threshold of 0.5.
  const row = {
    capture_id: 'stg_w750_12',
    prompt: 'A story about Mickey Mouse',
    response: 'plain unremarkable text with no hits',
  };
  const v = classifyForQuarantine(row);
  assert.equal(v.should_quarantine, false,
    `should_quarantine must be false at risk_score=${v.risk_score} threshold=0.5`);
  assert.equal(v.reason, null,
    `reason must be null when not quarantined; got ${JSON.stringify(v.reason)}`);
  // Hits are still surfaced for the caller to use.
  assert.ok(v.hits.length === 1,
    `single-hit case should still surface the hit; got ${JSON.stringify(v.hits)}`);
  // The convenience wrapper shouldQuarantineForCopyright matches.
  const v2 = shouldQuarantineForCopyright(row);
  assert.equal(v2.should_quarantine, false);
  assert.equal(v2.reason, null);
});

// =============================================================================
// 13) GATING: KOLM_W750_COPYRIGHT_DETECTOR=off path unchanged in insertCapture
// =============================================================================

test('W750-followup #13 — KOLM_W750_COPYRIGHT_DETECTOR=off skips the detector in insertCapture', async () => {
  freshDir();
  process.env.KOLM_W750_COPYRIGHT_DETECTOR = 'off';
  // Cache-bust capture-store + store so the new env is honored if the module
  // captured a static flag at import time (defensive — current implementation
  // reads env on every call).
  const cs = await import('../src/capture-store.js?w750_13=' + Date.now());
  const row = {
    id: 'cap_w750_13',
    tenant_id: 't_w750_13',
    tenant: 't_w750_13',
    namespace: 'ns_w750_13',
    prompt: 'Mickey Mouse and Donald Duck and Elsa and Olaf', // would flag if on
    response: '// SPDX-License-Identifier: MIT\nint x = 0;',  // would flag if on
  };
  try {
    await cs.insertCapture(row);
  } catch (e) { // deliberate: cleanup
    // insertCapture may legitimately fail on store-driver issues in CI; the
    // gate we care about is whether the row was mutated PRE-store. We
    // observe the row directly post-call regardless of the throw.
  }
  assert.ok(!row.copyright_heuristic_flagged,
    `gate=off: row.copyright_heuristic_flagged must remain unset; got ${row.copyright_heuristic_flagged}`);
  assert.ok(row.copyright_heuristic_risk === undefined,
    `gate=off: row.copyright_heuristic_risk must remain unset; got ${row.copyright_heuristic_risk}`);
  // flag_reason should NOT have been mutated to include copyright_heuristic.
  assert.ok(!(typeof row.flag_reason === 'string' && row.flag_reason.includes('copyright_heuristic:')),
    `gate=off: flag_reason must NOT include copyright_heuristic:; got ${JSON.stringify(row.flag_reason)}`);
  delete process.env.KOLM_W750_COPYRIGHT_DETECTOR;
});

// =============================================================================
// 14) GATING (positive): with detector on, insertCapture stamps the sidecar
// =============================================================================

test('W750-followup #14 — with detector on, insertCapture stamps flag_reason + sidecar', async () => {
  freshDir();
  // default-on (delete in freshDir already happened).
  const cs = await import('../src/capture-store.js?w750_14=' + Date.now());
  const row = {
    id: 'cap_w750_14',
    tenant_id: 't_w750_14',
    tenant: 't_w750_14',
    namespace: 'ns_w750_14',
    prompt: 'Mickey Mouse and Donald Duck on a journey',  // 2 disney hits
    response: '// SPDX-License-Identifier: MIT\nconsole.log("ok")', // +1 spdx hit
  };
  try {
    await cs.insertCapture(row);
  } catch (e) { // deliberate: cleanup
    // Same as #13 — we observe the row regardless of store success.
  }
  assert.equal(row.copyright_heuristic_flagged, true,
    `gate=on: row.copyright_heuristic_flagged must be true; got ${row.copyright_heuristic_flagged}`);
  assert.ok(typeof row.flag_reason === 'string'
      && row.flag_reason.includes('copyright_heuristic:'),
    `gate=on: row.flag_reason must include copyright_heuristic:; got ${JSON.stringify(row.flag_reason)}`);
  assert.ok(Number.isFinite(row.copyright_heuristic_risk)
      && row.copyright_heuristic_risk >= 0.5,
    `gate=on: risk should be >= 0.5; got ${row.copyright_heuristic_risk}`);
  assert.ok(Array.isArray(row.copyright_heuristic_hits)
      && row.copyright_heuristic_hits.length >= 2,
    `gate=on: hits sidecar should be present; got ${JSON.stringify(row.copyright_heuristic_hits)}`);
});

// =============================================================================
// 15) POST /v1/copyright/scan 401 without auth
// =============================================================================

test('W750-followup #15 — POST /v1/copyright/scan 401 without auth', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/copyright/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Mickey Mouse' }),
    });
    assert.equal(res.status, 401,
      `expected 401 without auth; got ${res.status}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 16) POST /v1/copyright/scan 200 envelope w/ hits (text body)
// =============================================================================

test('W750-followup #16 — POST /v1/copyright/scan 200 envelope w/ hits', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 500 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/copyright/scan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        text: 'Mickey Mouse and Donald Duck sing Hey Jude.',
      }),
    });
    assert.equal(res.status, 200, `expected 200; got ${res.status}`);
    const env = await res.json();
    assert.equal(env.ok, true);
    assert.ok(Array.isArray(env.hits) && env.hits.length >= 3,
      `expected 3+ hits (2 disney + 1 lyric); got ${JSON.stringify(env.hits)}`);
    assert.ok(env.risk_score >= 0.5,
      `expected risk_score >= 0.5; got ${env.risk_score}`);
    assert.ok(/^w750-followup-/.test(env.version),
      `version must match /^w750-followup-/; got ${JSON.stringify(env.version)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 17) GET /v1/copyright/queue/:namespace 401 without auth
// =============================================================================

test('W750-followup #17 — GET /v1/copyright/queue/:namespace 401 without auth', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/copyright/queue/anyns`, {
      method: 'GET',
    });
    assert.equal(res.status, 401,
      `expected 401 without auth; got ${res.status}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 18) GET /v1/copyright/queue/:namespace 200 envelope w/ shape
// =============================================================================

test('W750-followup #18 — GET /v1/copyright/queue/:namespace 200 envelope w/ shape', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const storeMod = await import('../src/store.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 500 });

  // Seed one staged_captures row that carries the heuristic tag.
  if (storeMod._resetStagedCapturesForTests) storeMod._resetStagedCapturesForTests();
  storeMod.insertStagedCapture({
    tenant_id: t.id,
    tenant: t.id,
    namespace: 'w750-queue-ns',
    corpus_namespace: 'w750-queue-ns',
    prompt: 'Mickey Mouse and Donald Duck',
    response: 'plain',
    flag_reason: 'copyright_heuristic:disney_character',
    copyright_heuristic_flagged: true,
    copyright_heuristic_risk: 0.5,
    copyright_heuristic_hits: [
      { kind: 'disney_character', matched: 'mickey mouse', side: 'input' },
      { kind: 'disney_character', matched: 'donald duck', side: 'input' },
    ],
  });
  // Seed a control row in the same namespace with no copyright tag.
  storeMod.insertStagedCapture({
    tenant_id: t.id,
    tenant: t.id,
    namespace: 'w750-queue-ns',
    corpus_namespace: 'w750-queue-ns',
    prompt: 'no hits here',
    response: 'plain',
  });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/copyright/queue/w750-queue-ns`, {
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(res.status, 200, `expected 200; got ${res.status}`);
    const env = await res.json();
    assert.equal(env.ok, true);
    assert.equal(env.namespace, 'w750-queue-ns');
    assert.equal(env.total, 1,
      `expected exactly 1 flagged row; got total=${env.total} captures=${JSON.stringify(env.captures)}`);
    const cap = env.captures[0];
    assert.ok(cap.flag_reason && cap.flag_reason.includes('copyright_heuristic:'),
      `flag_reason must include copyright_heuristic:; got ${JSON.stringify(cap.flag_reason)}`);
    assert.equal(cap.copyright_heuristic_risk, 0.5);
    assert.ok(Array.isArray(cap.copyright_heuristic_hits)
        && cap.copyright_heuristic_hits.length === 2,
      `hits sidecar must round-trip 2 entries; got ${JSON.stringify(cap.copyright_heuristic_hits)}`);
    assert.ok(/^w750-followup-/.test(env.version),
      `version must match /^w750-followup-/; got ${JSON.stringify(env.version)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (storeMod._resetStagedCapturesForTests) storeMod._resetStagedCapturesForTests();
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 19) public/docs/copyright-scan.html exists w/ brand-lock + heuristic disclaimer
// =============================================================================

test('W750-followup #19 — public/docs/copyright-scan.html exists w/ brand-lock + heuristic disclaimer', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  for (const needle of [
    'kolm.ai',
    'class="ks-nav"',
    'ks-footer',
    'Open-source AI workbench',                  // brand eyebrow lock
    'Frontier AI on your own infrastructure',    // brand H1 lock
    'w750-followup-v1',                          // version stamp
    'Mickey Mouse',                              // disney pattern visibility
    'Hey Jude',                                  // lyric fingerprint visibility
    'SPDX-License-Identifier',                   // code regex visibility
    'CODE_COPYRIGHT_REGEX',                      // pattern-pack name shown
    'Not legal advice',                          // heuristic disclaimer (canonical text)
    'Local-only',                                // privacy disclaimer
    'W808',                                      // W808 integration note
    'staged_captures',                           // pipeline integration mention
    'KOLM_W750_COPYRIGHT_DETECTOR',              // gating env-var
    '/v1/copyright/scan',                        // API surface mention
    '/v1/copyright/queue',                       // API surface mention
  ]) {
    assert.ok(html.includes(needle),
      `docs/copyright-scan.html must mention ${JSON.stringify(needle)}`);
  }
});

// =============================================================================
// 20) vercel.json has /docs/copyright-scan rewrite
// =============================================================================

test('W750-followup #20 — vercel.json has /docs/copyright-scan rewrite', () => {
  freshDir();
  const v = JSON.parse(fs.readFileSync(VERCEL_PATH, 'utf8'));
  const rewrites = v.rewrites || [];
  const docRewrite = rewrites.find((r) => r.source === '/docs/copyright-scan');
  assert.ok(docRewrite, '/docs/copyright-scan rewrite must exist in vercel.json');
  assert.equal(docRewrite.destination, '/docs/copyright-scan.html',
    `destination should be /docs/copyright-scan.html; got ${JSON.stringify(docRewrite.destination)}`);
});

// =============================================================================
// 21) cli/kolm.js defines cmdW750Copyright exactly once + wired
// =============================================================================

test('W750-followup #21 — cli/kolm.js defines cmdW750Copyright exactly once + wired', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW750Copyright\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW750Copyright dispatcher definition; got ${defs.length}`);
  assert.ok(/case\s+['"]copyright-scan['"]/.test(cli),
    `cli must have a case 'copyright-scan' arm`);
  assert.ok(cli.includes('cmdW750Copyright(rest)'),
    `cmdW750Copyright must be invoked with the rest args`);
});

// =============================================================================
// 22) wave750 sibling test count uses wave(\d{3,4}) regex + threshold
// =============================================================================

test('W750-followup #22 — wave750 sibling test count uses regex wave(\\d{3,4}) + threshold', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this.
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
  // This file itself satisfies the pattern.
  assert.ok(siblings.includes('wave750-copyright.test.js'),
    `this test file must match the wave(\\d{3,4}) sibling pattern`);
  // Spot-check that the capture-store wiring carries the gate text — proves
  // the test directly reflects the wave-naming + integration story.
  const cs = fs.readFileSync(CAPTURE_STORE_PATH, 'utf8');
  assert.ok(cs.includes('KOLM_W750_COPYRIGHT_DETECTOR'),
    'capture-store.js must reference the W750 gate env-var');
  assert.ok(cs.includes('classifyCopyrightForQuarantine')
      || cs.includes('classifyForQuarantine'),
    'capture-store.js must call the W750-followup classifier');
});
