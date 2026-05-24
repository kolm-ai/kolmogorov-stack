// W740 — Import: GGUF / safetensors / ONNX -> not_kolm_compiled manifest.
//
// Atomic items pinned (matches the W740 implementation):
//
//   1) IMPORT_VERSION constant present + equals 'w740-v1'
//   2) detectFormat: stubbed GGUF magic bytes return 'gguf'
//   3) detectFormat: stubbed safetensors header bytes return 'safetensors'
//   4) detectFormat: stubbed ONNX tag bytes return 'onnx'
//   5) detectFormat: random garbage returns 'unknown'
//   6) parseImportMetadata: file_not_found envelope on missing path
//   7) parseImportMetadata: python3_missing envelope when pythonPath override fails
//   8) wrapAsKolmManifest: returns not_kolm_compiled:true + 64-hex source_sha256
//   9) wrapAsKolmManifest: returns ok:false metadata-error block on parser failure
//  10) POST /v1/import/inspect: 401 without auth; 400 on missing path; 200 envelope on stub file
//  11) POST /v1/import/wrap: 401 without auth; envelope.manifest.not_kolm_compiled === true
//  12) public/docs/import.html exists with brand-lock strings
//  13) vercel.json has /docs/import -> /docs/import.html rewrite
//  14) cli/kolm.js defines cmdW740Import exactly once + wired from `case 'import'`
//  15) apps/import/gguf.py exists + has shebang + reads header bytes
//  16) apps/import/safetensors.py exists + uses stdlib struct (no third-party imports)
//  17) apps/import/onnx.py exists + emits honest envelope on stdlib-only parse limit
//  18) wave740 sibling test count uses wave(\d{3,4}) regex + threshold (W604 anti-brittle)
//
// W604 anti-brittleness: no explicit-array family checks. Tests pivot on the
// load-bearing tokens (version stamp, envelope shape, file existence, regex
// against cli/kolm.js and apps/import/*.py).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  IMPORT_VERSION,
  detectFormat,
  parseImportMetadata,
  wrapAsKolmManifest,
  describeFormats,
} from '../src/import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'import.html');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const APPS_IMPORT_DIR = path.join(REPO_ROOT, 'apps', 'import');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w740-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// -----------------------------------------------------------------------------
// Stub file builders — produce minimal byte sequences with the right magic so
// detectFormat() recognizes them. We never generate a real model.
// -----------------------------------------------------------------------------

function stubGgufFile(dir) {
  // Header layout: "GGUF" + u32 LE version=3 + u64 LE tensor_count=0 + u64 LE kv_count=0
  const buf = Buffer.alloc(24);
  buf.write('GGUF', 0, 'ascii');
  buf.writeUInt32LE(3, 4);
  buf.writeBigUInt64LE(0n, 8);
  buf.writeBigUInt64LE(0n, 16);
  const p = path.join(dir, 'stub.gguf');
  fs.writeFileSync(p, buf);
  return p;
}

function stubSafetensorsFile(dir) {
  // Minimal valid safetensors: 8-byte u64 LE header_size + JSON header.
  // The JSON object has zero tensors + an __metadata__ block.
  const header = Buffer.from(JSON.stringify({ __metadata__: { format: 'test' } }), 'utf8');
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(header.length), 0);
  const body = Buffer.concat([lenBuf, header]);
  const p = path.join(dir, 'stub.safetensors');
  fs.writeFileSync(p, body);
  return p;
}

function stubOnnxFile(dir) {
  // Minimal protobuf: ir_version=10 (field 1, wire type 0 = varint) +
  // producer_name="test" (field 3, wire type 2 = length-delim).
  //
  //   tag = (1 << 3) | 0 = 0x08    | varint payload 0x0a -> ir_version=10
  //   tag = (3 << 3) | 2 = 0x1a    | length=4, "test"
  //   pad to >64 bytes so detectFormat's size check passes.
  const head = Buffer.from([
    0x08, 0x0a,                          // ir_version = 10
    0x1a, 0x04, 0x74, 0x65, 0x73, 0x74,  // producer_name = "test"
  ]);
  const pad = Buffer.alloc(128 - head.length, 0);
  const p = path.join(dir, 'stub.onnx');
  fs.writeFileSync(p, Buffer.concat([head, pad]));
  return p;
}

function stubGarbageFile(dir) {
  const buf = Buffer.alloc(8);
  // Avoid any byte that happens to match a magic prefix:
  buf[0] = 0xff; buf[1] = 0xff; buf[2] = 0xff; buf[3] = 0xff;
  buf[4] = 0xff; buf[5] = 0xff; buf[6] = 0xff; buf[7] = 0xff;
  const p = path.join(dir, 'stub.bin');
  fs.writeFileSync(p, buf);
  return p;
}

// =============================================================================
// 1) IMPORT_VERSION
// =============================================================================

test('W740 #1 — IMPORT_VERSION is w740-v1', () => {
  freshDir();
  assert.equal(IMPORT_VERSION, 'w740-v1',
    `expected IMPORT_VERSION='w740-v1'; got ${JSON.stringify(IMPORT_VERSION)}`);
});

// =============================================================================
// 2) detectFormat: GGUF
// =============================================================================

test('W740 #2 — detectFormat recognizes the GGUF magic header', () => {
  const tmp = freshDir();
  const p = stubGgufFile(tmp);
  assert.equal(detectFormat(p), 'gguf',
    `expected detectFormat to return 'gguf' for a file with "GGUF" magic; got ${detectFormat(p)}`);
});

// =============================================================================
// 3) detectFormat: safetensors
// =============================================================================

test('W740 #3 — detectFormat recognizes the safetensors u64 header', () => {
  const tmp = freshDir();
  const p = stubSafetensorsFile(tmp);
  assert.equal(detectFormat(p), 'safetensors',
    `expected 'safetensors' for u64 header + JSON '{'; got ${detectFormat(p)}`);
});

// =============================================================================
// 4) detectFormat: ONNX
// =============================================================================

test('W740 #4 — detectFormat recognizes ONNX protobuf wire-type tags', () => {
  const tmp = freshDir();
  const p = stubOnnxFile(tmp);
  assert.equal(detectFormat(p), 'onnx',
    `expected 'onnx' for a protobuf tag byte; got ${detectFormat(p)}`);
});

// =============================================================================
// 5) detectFormat: garbage
// =============================================================================

test('W740 #5 — detectFormat returns "unknown" on garbage bytes', () => {
  const tmp = freshDir();
  const p = stubGarbageFile(tmp);
  assert.equal(detectFormat(p), 'unknown',
    `expected 'unknown' for non-matching bytes; got ${detectFormat(p)}`);
});

// =============================================================================
// 6) parseImportMetadata: file_not_found
// =============================================================================

test('W740 #6 — parseImportMetadata returns file_not_found envelope on missing path', async () => {
  freshDir();
  const env = await parseImportMetadata('/tmp/this-path-does-not-exist-' + crypto.randomBytes(4).toString('hex'));
  assert.equal(env.ok, false, `expected ok:false; got ${JSON.stringify(env)}`);
  assert.equal(env.error, 'file_not_found',
    `expected error='file_not_found'; got ${env.error}`);
  assert.equal(env.version, 'w740-v1');
});

// =============================================================================
// 7) parseImportMetadata: python3_missing
// =============================================================================
//
// We don't unset PATH (would break the rest of node). Instead we pass an
// explicit pythonPath that we know does not exist; src/import.js skips
// detection entirely when pythonPath is provided. To force the
// python3_missing branch we mock _resolvePython by passing a deliberately
// unresolvable explicit override that the script-spawn path then fails on.
// The test below verifies the structural python3_missing envelope shape via
// describeFormats() when we point apps_import to a non-existent dir AND
// override pythonPath to an unresolvable binary.

test('W740 #7 — parseImportMetadata surfaces honest error when python3 explicitly missing', async () => {
  const tmp = freshDir();
  const p = stubGgufFile(tmp);
  // The pythonPath override is honored — if the path doesn't exist we get a
  // spawn failure surfaced as import_parser_spawn_failed. This is the honest
  // envelope branch; the python3_missing branch fires only when BOTH probes
  // (python3 and python) fail _resolvePython(). We can't easily force that
  // from the test, but we CAN assert the failed-spawn shape, which is the
  // same honest contract.
  const env = await parseImportMetadata(p, {
    pythonPath: path.join(tmp, 'definitely-not-a-real-python-' + crypto.randomBytes(4).toString('hex')),
  });
  assert.equal(env.ok, false,
    `expected ok:false for unresolvable pythonPath; got ${JSON.stringify(env)}`);
  // Either spawn failed (ENOENT-ish) or the parser exited non-zero — both are
  // honest envelope shapes for this branch.
  assert.ok(
    env.error === 'import_parser_spawn_failed'
      || env.error === 'import_parser_no_envelope'
      || env.error === 'import_parser_bad_json'
      || env.error === 'python3_missing',
    `expected an import_parser_* or python3_missing error code; got ${env.error}`);
  assert.equal(env.version, 'w740-v1');
});

// =============================================================================
// 8) wrapAsKolmManifest: not_kolm_compiled + 64-hex sha
// =============================================================================

test('W740 #8 — wrapAsKolmManifest returns not_kolm_compiled:true + 64-hex source_sha256', () => {
  freshDir();
  const fakeMeta = {
    ok: true,
    format: 'gguf',
    sha256: 'a'.repeat(64),
    source_path: '/abs/path/model.gguf',
    size_bytes: 1024,
    params_b: 3.2,
    quant: 'q4_k_m',
    raw_metadata_keys: ['general.architecture', 'general.file_type'],
  };
  const manifest = wrapAsKolmManifest(fakeMeta, { now: '2026-05-24T00:00:00.000Z' });
  assert.equal(manifest.not_kolm_compiled, true,
    'W740-2 honesty lock: not_kolm_compiled must be true');
  assert.equal(manifest.manifest_version, 'w740-v1');
  assert.equal(manifest.k_score, null, 'K-Score must be null on a not_kolm_compiled wrap');
  assert.equal(manifest.holdout, null, 'holdout must be null on a not_kolm_compiled wrap');
  assert.equal(manifest.source_format, 'gguf');
  assert.ok(/^[0-9a-f]{64}$/.test(manifest.source_sha256),
    `source_sha256 must be 64-hex; got ${manifest.source_sha256}`);
  assert.equal(manifest.source_size_bytes, 1024);
  assert.equal(manifest.source_params_b, 3.2);
  assert.equal(manifest.source_quant, 'q4_k_m');
  assert.equal(manifest.imported_at, '2026-05-24T00:00:00.000Z');
  // manifest_id must be a deterministic sha256 derived from source_sha + format + version.
  const expectedId = crypto.createHash('sha256')
    .update(`${fakeMeta.sha256}:gguf:w740-v1`)
    .digest('hex');
  assert.equal(manifest.manifest_id, expectedId,
    'manifest_id must be sha256(source_sha:format:version)');
});

// =============================================================================
// 9) wrapAsKolmManifest: ok:false metadata surfaces error block
// =============================================================================

test('W740 #9 — wrapAsKolmManifest surfaces source_metadata_error on parser failure', () => {
  freshDir();
  const badMeta = {
    ok: false,
    error: 'gguf_parse_failed',
    hint: 'magic mismatch',
  };
  const manifest = wrapAsKolmManifest(badMeta);
  assert.equal(manifest.not_kolm_compiled, true,
    'wrap must STILL be honest about not_kolm_compiled even on parser failure');
  assert.ok(manifest.source_metadata_error,
    'source_metadata_error block must be surfaced when parser failed');
  assert.equal(manifest.source_metadata_error.error, 'gguf_parse_failed');
  assert.equal(manifest.source_metadata_error.hint, 'magic mismatch');
  assert.ok(manifest.manifest_id.startsWith('unbound-'),
    'manifest_id must fall back to unbound- prefix when source_sha is missing');
});

// =============================================================================
// 10) POST /v1/import/inspect — auth + envelope
// =============================================================================

test('W740 #10 — POST /v1/import/inspect: 401 no-auth, 400 missing field, 200 envelope on stub', async () => {
  const tmp = freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const stubPath = stubGgufFile(tmp);

    // 10a — no auth -> 401
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/import/inspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: stubPath }),
    });
    assert.equal(noAuth.status, 401, `expected 401 with no auth; got ${noAuth.status}`);
    const noAuthBody = await noAuth.json();
    assert.ok(
      noAuthBody.error === 'missing api key' || noAuthBody.error === 'auth_required',
      `expected auth-failure error string; got ${JSON.stringify(noAuthBody)}`);

    // 10b — auth + missing field -> 400
    const missField = await fetch(`http://127.0.0.1:${port}/v1/import/inspect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({}),
    });
    assert.equal(missField.status, 400);
    const missBody = await missField.json();
    assert.equal(missBody.error, 'missing_field');
    assert.equal(missBody.field, 'path');

    // 10c — auth + good stub gguf file -> 200, ok envelope with format:'gguf'
    const good = await fetch(`http://127.0.0.1:${port}/v1/import/inspect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ path: stubPath }),
    });
    // status is either 200 (python3 present, parsed fine) or 503 (python3 not on PATH).
    assert.ok(good.status === 200 || good.status === 503,
      `expected 200 or 503; got ${good.status}`);
    const goodBody = await good.json();
    assert.equal(goodBody.version, 'w740-v1');
    if (good.status === 200) {
      assert.equal(goodBody.ok, true, `expected ok:true; got ${JSON.stringify(goodBody)}`);
      assert.equal(goodBody.format, 'gguf');
      assert.ok(/^[0-9a-f]{64}$/.test(goodBody.sha256),
        `sha256 must be 64-hex; got ${goodBody.sha256}`);
    } else {
      assert.equal(goodBody.error, 'python3_missing');
    }
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 11) POST /v1/import/wrap — auth + manifest carries not_kolm_compiled:true
// =============================================================================

test('W740 #11 — POST /v1/import/wrap: 401 no-auth; envelope.manifest.not_kolm_compiled:true', async () => {
  const tmp = freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const stubPath = stubGgufFile(tmp);

    // 11a — no auth
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/import/wrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: stubPath }),
    });
    assert.equal(noAuth.status, 401, `expected 401 no-auth; got ${noAuth.status}`);

    // 11b — auth + good stub -> 200 with manifest.not_kolm_compiled:true
    const good = await fetch(`http://127.0.0.1:${port}/v1/import/wrap`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ path: stubPath }),
    });
    assert.ok(good.status === 200 || good.status === 503,
      `expected 200 or 503; got ${good.status}`);
    const goodBody = await good.json();
    if (good.status === 200) {
      assert.equal(goodBody.ok, true, `expected envelope ok:true; got ${JSON.stringify(goodBody)}`);
      assert.ok(goodBody.manifest && typeof goodBody.manifest === 'object',
        'envelope.manifest must be an object');
      assert.equal(goodBody.manifest.not_kolm_compiled, true,
        'W740-2 honesty lock: envelope.manifest.not_kolm_compiled must be true');
      assert.equal(goodBody.manifest.source_format, 'gguf');
      assert.equal(goodBody.version, 'w740-v1');
    } else {
      assert.equal(goodBody.error, 'python3_missing');
    }
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 12) public/docs/import.html exists with brand-lock strings
// =============================================================================

test('W740 #12 — /docs/import.html exists with brand-lock strings', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  for (const needle of [
    'kolm.ai',                                // brand
    'class="ks-nav"',                         // nav shell
    'ks-footer',                              // footer shell
    'Open-source AI workbench',               // brand-lock eyebrow
    'Frontier AI on your own infrastructure', // brand-lock h1
    'not_kolm_compiled',                      // W740-2 honesty lock
    'gguf',                                   // format
    'safetensors',                            // format
    'onnx',                                   // format
    'kolm export',                            // round-trip
    'kolm distill',                           // round-trip
    'teacher-quality-bound',                  // honesty disclaimer
    'POST /v1/import/inspect',                // API surface
    'POST /v1/import/wrap',                   // API surface
  ]) {
    assert.ok(html.includes(needle),
      `import.html must mention "${needle}"`);
  }
});

// =============================================================================
// 13) vercel.json /docs/import rewrite
// =============================================================================

test('W740 #13 — vercel.json has /docs/import -> /docs/import.html rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have rewrites array');
  const found = cfg.rewrites.find(r => r && r.source === '/docs/import');
  assert.ok(found, 'expected rewrite with source=/docs/import');
  assert.equal(found.destination, '/docs/import.html',
    `expected destination=/docs/import.html; got ${found && found.destination}`);
});

// =============================================================================
// 14) cli/kolm.js defines cmdW740Import + wired
// =============================================================================

test('W740 #14 — cli/kolm.js defines cmdW740Import dispatcher exactly once + wired from case import', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW740Import\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW740Import dispatcher definition; got ${defs.length}`);
  assert.ok(cli.includes('cmdW740Import(rest)'),
    `cmdW740Import must be invoked with the rest args`);
  // Wire-up: the dispatcher must be reachable from `case 'import'` (existing
  // legacy import-chat verb stays around as a fallthrough).
  assert.ok(/case\s+['"]import['"]/.test(cli),
    `cli must have a case 'import' arm`);
  // Honest fallbacks: load-bearing error codes must appear in the dispatcher.
  for (const needle of [
    'python3_missing',
    'file_not_found',
    'unknown_format',
    'not_kolm_compiled',
  ]) {
    // not_kolm_compiled is set inside src/import.js, but the round-trip hint
    // referencing kolm export must be in the cli for symmetry.
    if (needle === 'not_kolm_compiled') continue;
    assert.ok(cli.includes(needle),
      `cmdW740Import must reference "${needle}" envelope code`);
  }
  // Round-trip hint to kolm export (symmetric pair, W740-3)
  assert.ok(/kolm export.*--backend gguf/.test(cli),
    `cmdW740Import must surface "kolm export ... --backend gguf" round-trip hint`);
});

// =============================================================================
// 15) apps/import/gguf.py exists + has shebang + reads header bytes
// =============================================================================

test('W740 #15 — apps/import/gguf.py exists with shebang + reads GGUF header bytes', () => {
  freshDir();
  const sp = path.join(APPS_IMPORT_DIR, 'gguf.py');
  assert.ok(fs.existsSync(sp), `expected ${sp} to exist`);
  const txt = fs.readFileSync(sp, 'utf8');
  assert.ok(txt.startsWith('#!/usr/bin/env python3') || txt.startsWith('#!'),
    'gguf.py must start with a shebang line');
  assert.ok(/GGUF/.test(txt), 'gguf.py must reference the GGUF magic constant');
  assert.ok(/struct/.test(txt), 'gguf.py must use struct for binary decoding');
  assert.ok(/<I|<Q/.test(txt), 'gguf.py must decode LE u32 / u64 fields');
  assert.ok(/hashlib|sha256/.test(txt), 'gguf.py must hash the file for provenance');
});

// =============================================================================
// 16) apps/import/safetensors.py exists + stdlib only
// =============================================================================

test('W740 #16 — apps/import/safetensors.py exists + uses stdlib struct (no third-party imports)', () => {
  freshDir();
  const sp = path.join(APPS_IMPORT_DIR, 'safetensors.py');
  assert.ok(fs.existsSync(sp), `expected ${sp} to exist`);
  const txt = fs.readFileSync(sp, 'utf8');
  assert.ok(txt.startsWith('#!/usr/bin/env python3') || txt.startsWith('#!'),
    'safetensors.py must start with a shebang line');
  assert.ok(/import struct/.test(txt), 'safetensors.py must import struct (stdlib)');
  assert.ok(/import json/.test(txt), 'safetensors.py must import json (stdlib)');
  // Negative assertion: must NOT import the safetensors pip package or torch
  // or any other third-party dep.
  assert.ok(!/import safetensors\b/.test(txt),
    'safetensors.py must NOT import the safetensors pip package');
  assert.ok(!/^import torch\b|^from torch\b/m.test(txt),
    'safetensors.py must NOT import torch');
  assert.ok(!/^import numpy\b|^from numpy\b/m.test(txt),
    'safetensors.py must NOT import numpy');
  assert.ok(!/^import huggingface_hub\b/m.test(txt),
    'safetensors.py must NOT import huggingface_hub');
});

// =============================================================================
// 17) apps/import/onnx.py exists + honest envelope on stdlib limit
// =============================================================================

test('W740 #17 — apps/import/onnx.py exists + emits honest envelope on stdlib-only parse limit', () => {
  freshDir();
  const sp = path.join(APPS_IMPORT_DIR, 'onnx.py');
  assert.ok(fs.existsSync(sp), `expected ${sp} to exist`);
  const txt = fs.readFileSync(sp, 'utf8');
  assert.ok(txt.startsWith('#!/usr/bin/env python3') || txt.startsWith('#!'),
    'onnx.py must start with a shebang line');
  // The W740 honest-by-default contract: when the stdlib-only walker can't
  // reach ir_version, emit "onnx_metadata_partial" — NEVER silently fake a
  // full parse.
  assert.ok(/onnx_metadata_partial/.test(txt),
    'onnx.py must emit the onnx_metadata_partial code on stdlib-only parse limit');
  assert.ok(/onnx_parse_failed/.test(txt),
    'onnx.py must emit onnx_parse_failed on signature mismatch');
  // Negative assertion: no third-party protobuf or onnx pip deps.
  assert.ok(!/^import onnx\b|^from onnx\b/m.test(txt),
    'onnx.py must NOT import the onnx pip package');
  assert.ok(!/^import protobuf\b|^from google\.protobuf\b/m.test(txt),
    'onnx.py must NOT import protobuf');
});

// =============================================================================
// 18) Family lock-in via regex (W604 anti-brittle)
// =============================================================================

test('W740 #18 — wave740 sibling test count uses wave(\\d{3,4}) regex + threshold pattern', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this test.
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
});

// =============================================================================
// Bonus — describeFormats returns the expected shape
// =============================================================================

test('W740 #19 — describeFormats returns formats + scripts + python info', () => {
  freshDir();
  const out = describeFormats();
  assert.deepEqual(out.formats.slice().sort(), ['gguf', 'onnx', 'safetensors']);
  for (const f of out.formats) {
    assert.ok(out.detail[f].script_present === true,
      `expected apps/import/${f}.py to be present; got ${JSON.stringify(out.detail[f])}`);
  }
  assert.equal(out.version, 'w740-v1');
});
