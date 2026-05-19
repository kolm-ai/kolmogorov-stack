// W451/W452 — multimodal redactor surface + no-teacher synth default.
//
// W451 = compileFull now defaults opts.synthesize_recipe:true when no teacher
//        API is wired (no KOLM_DISTILL_TEACHER / ANTHROPIC_API_KEY / OPENAI_API_KEY)
//        and the caller didn't pass explicit recipes. Without this default a
//        tenant with real captures would get a hard "stub-only" error from the
//        bundle phase even though the rule-class W438 synth path could produce
//        a real artifact.
// W452 = new /v1/redact + /v1/media/redact HTTP routes + `kolm redact --remote`
//        and `kolm redact --media <uri>` CLI flags. Multimodal kinds (image /
//        audio / video / pdf) return a deferred envelope with a worker hint;
//        text-extractable kinds return the redacted text + map_hash.
//
// Behavior-only — no page-copy markers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function _mkHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w451-'));
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_STORE_DRIVER = 'json';
  return tmp;
}

async function _makeAppAndTenant() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 1000 });
  return { app, apiKey: t.api_key, tenantId: t.id };
}

function _withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const out = await fn(`http://127.0.0.1:${server.address().port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

// =============================================================================
// W451 #1 — compileFull defaults synthesize_recipe:true with no teacher env
// =============================================================================

test('W451 #1 — compileFull defaults synthesize_recipe:true when no teacher env', async () => {
  // The default is computed inside compileFull from process.env. Without any
  // KOLM_DISTILL_TEACHER / ANTHROPIC_API_KEY / OPENAI_API_KEY in the
  // environment, the synth path should auto-enable for a caller that doesn't
  // pass opts.recipes. We assert this by reading the source — the default
  // logic is a single line we can grep for, and the comment above it documents
  // the contract so anyone changing the line knows what they're breaking.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'compile-pipeline.js'), 'utf8');
  assert.ok(/teacherWired\s*=\s*!!\(process\.env\.KOLM_DISTILL_TEACHER/.test(src),
    'compile-pipeline.js must compute teacherWired from KOLM_DISTILL_TEACHER + ANTHROPIC_API_KEY + OPENAI_API_KEY');
  assert.ok(/synthDefault\s*=\s*!teacherWired\s*&&\s*!opts\.recipes/.test(src),
    'synthDefault must be true when no teacher is wired AND no explicit recipes');
  assert.ok(/synthOpt\s*=\s*opts\.synthesize_recipe\s*===\s*undefined\s*\?\s*synthDefault\s*:/.test(src),
    'synthOpt must default to synthDefault when opts.synthesize_recipe is undefined');
});

// =============================================================================
// W451 #2 — explicit opts.synthesize_recipe:false still wins (override path)
// =============================================================================

test('W451 #2 — explicit opts.synthesize_recipe:false overrides the default', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'compile-pipeline.js'), 'utf8');
  // The ternary above resolves opts.synthesize_recipe to the literal boolean
  // when it's defined, so `false` survives. We assert the shape of the
  // wantSynth check — it must use synthOpt, not opts.synthesize_recipe directly.
  assert.ok(/const wantSynth = synthOpt\b/.test(src),
    'wantSynth must read from synthOpt so an explicit false still wins');
});

// =============================================================================
// W452 #3 — POST /v1/redact returns redacted text + map_hash + class counters
// =============================================================================

test('W452 #3 — POST /v1/redact redacts text + reports class counters', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/redact', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Email me at jane@example.com, my SSN is 123-45-6789' }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(typeof j.redacted, 'string');
    // PHI must be tokenized out — the original SSN must not survive
    assert.ok(!j.redacted.includes('123-45-6789'),
      'redacted text must not contain raw SSN: ' + j.redacted);
    assert.ok(!j.redacted.includes('jane@example.com'),
      'redacted text must not contain raw email: ' + j.redacted);
    // At least the two classes we triggered must appear in classes_seen.
    // privacy-membrane.js uses lowercase class ids ('ssn', 'email') — see
    // ALL_CLASSES in src/privacy-membrane.js. Case-insensitive contains so
    // the test stays stable if the class id format ever capitalizes.
    assert.ok(Array.isArray(j.classes_seen));
    const seenLower = j.classes_seen.map(c => String(c).toLowerCase());
    assert.ok(seenLower.includes('ssn'),
      'classes_seen must include ssn, got: ' + JSON.stringify(j.classes_seen));
    assert.ok(seenLower.includes('email'),
      'classes_seen must include email, got: ' + JSON.stringify(j.classes_seen));
    assert.equal(typeof j.map_hash, 'string');
    assert.ok(j.map_hash.startsWith('sha256:'), 'map_hash must be sha256-prefixed');
  });
});

// =============================================================================
// W452 #4 — POST /v1/redact requires {text}
// =============================================================================

test('W452 #4 — POST /v1/redact 400 without text', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/redact', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, 'text_required');
  });
});

// =============================================================================
// W452 #5 — POST /v1/redact 401 unauth
// =============================================================================

test('W452 #5 — POST /v1/redact 401 unauth', async () => {
  _mkHome();
  const { app } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/redact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    assert.equal(r.status, 401);
  });
});

// =============================================================================
// W452 #6 — POST /v1/redact 413 on oversize text
// =============================================================================

test('W452 #6 — POST /v1/redact 413 on text over the 256 KiB limit', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const huge = 'A'.repeat(300 * 1024);
    const r = await fetch(base + '/v1/redact', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text: huge }),
    });
    assert.equal(r.status, 413);
    const j = await r.json();
    assert.equal(j.error, 'text_too_large');
    assert.equal(typeof j.limit_bytes, 'number');
  });
});

// =============================================================================
// W452 #7 — POST /v1/media/redact returns a deferred envelope for image kinds
// =============================================================================

test('W452 #7 — POST /v1/media/redact returns deferred for image/png (no bytes load)', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/media/redact', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ media_uri: 'file:/nonexistent.png', mime: 'image/png' }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.deferred, true);
    assert.equal(j.mime, 'image/png');
    assert.equal(j.deferral.kind, 'image');
    assert.equal(j.deferral.worker, 'ocr');
    assert.ok(typeof j.deferral.hint === 'string' && j.deferral.hint.length > 0);
  });
});

// =============================================================================
// W452 #8 — POST /v1/media/redact runs redactor on text inline (no media_uri)
// =============================================================================

test('W452 #8 — POST /v1/media/redact runs redactor on inline text', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/media/redact', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'My SSN is 123-45-6789', mime: 'text/plain' }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.deferred, false);
    assert.ok(!j.redacted.includes('123-45-6789'),
      'redacted text must not contain raw SSN: ' + j.redacted);
    assert.ok(Array.isArray(j.classes_seen));
    const seenLower = j.classes_seen.map(c => String(c).toLowerCase());
    assert.ok(seenLower.includes('ssn'),
      'classes_seen must include ssn, got: ' + JSON.stringify(j.classes_seen));
  });
});

// =============================================================================
// W452 #9 — POST /v1/media/redact 400 without media_uri OR text
// =============================================================================

test('W452 #9 — POST /v1/media/redact 400 without media_uri or text', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/media/redact', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, 'media_uri_or_text_required');
  });
});

// =============================================================================
// W452 #10 — POST /v1/media/redact reads a stored blob and redacts it
// =============================================================================

test('W452 #10 — POST /v1/media/redact loads a stored text/plain blob and redacts', async () => {
  _mkHome();
  const { storeBlob } = await import('../src/media-store.js');
  const buf = Buffer.from('Email me at carol@x.co and call 555-123-4567', 'utf8');
  const { uri } = await storeBlob(buf, { mime: 'text/plain', kind: 'text' });

  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/media/redact', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ media_uri: uri }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.deferred, false);
    assert.ok(!j.redacted.includes('carol@x.co'), 'raw email must be redacted');
    assert.ok(!j.redacted.includes('555-123-4567'), 'raw phone must be redacted');
  });
});

// =============================================================================
// W452 #11 — POST /v1/media/redact 404 when stored blob is missing
// =============================================================================

test('W452 #11 — POST /v1/media/redact 404 when media_uri does not exist', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/media/redact', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ media_uri: 'file:/no/such/path/xyz.txt' }),
    });
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.equal(j.error, 'media_not_found');
  });
});

// =============================================================================
// W452 #12 — CLI: cmdRedact accepts --remote and --media flags
// =============================================================================

test('W452 #12 — cli/kolm.js cmdRedact supports --remote and --media', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.ok(/const remote = args\.includes\('--remote'\)/.test(cli),
    'cmdRedact must parse --remote');
  assert.ok(/const mediaUri = pickFlag\(args, '--media'\)/.test(cli),
    'cmdRedact must parse --media <uri>');
  // The remote path must hit /v1/redact; the media path must hit /v1/media/redact.
  // Use a sectioned grep so we only look inside cmdRedact body.
  const m = cli.match(/async function cmdRedact\(args\) \{([\s\S]*?)\n\}\n/);
  assert.ok(m, 'cmdRedact body must be locatable');
  const body = m[1];
  assert.ok(body.includes('/v1/redact'),
    'cmdRedact must call POST /v1/redact when --remote is set');
  assert.ok(body.includes('/v1/media/redact'),
    'cmdRedact must call POST /v1/media/redact when --media is set');
});

// =============================================================================
// W452 #13 — HELP.redact documents the new flags
// =============================================================================

test('W452 #13 — HELP.redact documents --remote, --media, --mime', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  // Grep within the HELP.redact heredoc.
  const m = cli.match(/redact: `kolm redact[\s\S]*?`,/);
  assert.ok(m, 'HELP.redact heredoc must be locatable');
  const help = m[0];
  assert.ok(/--remote/.test(help), 'HELP.redact must document --remote');
  assert.ok(/--media/.test(help),  'HELP.redact must document --media');
  assert.ok(/--mime/.test(help),   'HELP.redact must document --mime');
});
