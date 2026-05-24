// W743 — Migrate from Ollama and LM Studio tests.
//
// Atomic items pinned (matches the W743 implementation):
//
//   [W743-1] `kolm migrate from-ollama` reads ~/.ollama/models/
//   [W743-2] `kolm migrate from-lmstudio` reads LM Studio cache
//   [W743-3] /docs/migrate.html shipped with brand-lock
//
// Tests:
//   #1  — MIGRATE_VERSION constant equals 'w743-v1'
//   #2  — OLLAMA_DEFAULT_PATHS includes a linux/mac OR windows .ollama/models path
//   #3  — LMSTUDIO_DEFAULT_PATHS includes lm-studio/models on at least one platform
//   #4  — discoverOllamaModels honest envelope on missing root
//   #5  — discoverOllamaModels with mock filesystem returns >=1 model
//   #6  — discoverLmStudioModels honest envelope on missing root
//   #7  — discoverLmStudioModels with mock .gguf files returns entries
//   #8  — migrateOllamaModel returns wrapped manifest w/ source_tool:"ollama"
//         and inherits not_kolm_compiled:true from W740
//   #9  — migrateLmStudioModel returns wrapped manifest w/ source_tool:"lmstudio"
//   #10 — runMigrationDryRun returns found:N without invoking wrap
//   #11 — POST /v1/migrate/discover 401 no-auth; 200 with discovery envelope
//   #12 — POST /v1/migrate/wrap 401 no-auth; 200 with manifest envelope
//   #13 — public/docs/migrate.html exists with brand-lock + both source sections
//   #14 — vercel.json has /docs/migrate rewrite
//   #15 — cli/kolm.js defines cmdW743Migrate exactly once + wired from case 'migrate'
//   #16 — wave743 sibling test count uses wave(\d{3,4}) regex + threshold
//
// W604 anti-brittleness: no explicit-array family checks. Tests pivot on the
// load-bearing tokens (version stamp, envelope shape, file existence, regex
// against cli/kolm.js and src/migrate.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  MIGRATE_VERSION,
  OLLAMA_DEFAULT_PATHS,
  LMSTUDIO_DEFAULT_PATHS,
  discoverOllamaModels,
  discoverLmStudioModels,
  migrateOllamaModel,
  migrateLmStudioModel,
  runMigrationDryRun,
  describeMigrationSources,
} from '../src/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'migrate.html');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w743-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// -----------------------------------------------------------------------------
// Stub builders — produce filesystem layouts the discover* functions expect.
// -----------------------------------------------------------------------------

function _stubGgufBytes() {
  // Minimum valid GGUF header so parseImportMetadata could detect it (we never
  // invoke the python parser in pure discovery tests, but downstream wrap
  // tests use a stub python override anyway).
  const buf = Buffer.alloc(24);
  buf.write('GGUF', 0, 'ascii');
  buf.writeUInt32LE(3, 4);
  buf.writeBigUInt64LE(0n, 8);
  buf.writeBigUInt64LE(0n, 16);
  return buf;
}

function stubOllamaRoot(parent, { name = 'llama3.2', tag = '3b' } = {}) {
  const root = path.join(parent, 'mock-ollama');
  const libDir = path.join(root, 'manifests', 'registry.ollama.ai', 'library', name);
  const blobsDir = path.join(root, 'blobs');
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(blobsDir, { recursive: true });

  const ggufBytes = _stubGgufBytes();
  const digestHex = crypto.createHash('sha256').update(ggufBytes).digest('hex');
  const blobPath = path.join(blobsDir, `sha256-${digestHex}`);
  fs.writeFileSync(blobPath, ggufBytes);

  const manifestJson = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: { digest: 'sha256:' + 'c'.repeat(64), mediaType: 'application/vnd.docker.container.image.v1+json', size: 1 },
    layers: [
      {
        mediaType: 'application/vnd.ollama.image.model',
        digest: 'sha256:' + digestHex,
        size: ggufBytes.length,
      },
    ],
  };
  fs.writeFileSync(path.join(libDir, tag), JSON.stringify(manifestJson));
  return { root, name, tag, blob_path: blobPath, digest_hex: digestHex };
}

function stubLmStudioRoot(parent, { publisher = 'mockpub', repo = 'mockrepo', basename = 'mock-3b-q4_k_m' } = {}) {
  const root = path.join(parent, 'mock-lmstudio');
  const dir = path.join(root, publisher, repo);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, basename + '.gguf');
  fs.writeFileSync(filePath, _stubGgufBytes());
  return { root, file_path: filePath, basename, publisher, repo };
}

// =============================================================================
// 1) MIGRATE_VERSION
// =============================================================================

test('W743 #1 — MIGRATE_VERSION is w743-v1', () => {
  freshDir();
  assert.equal(MIGRATE_VERSION, 'w743-v1',
    `expected MIGRATE_VERSION='w743-v1'; got ${JSON.stringify(MIGRATE_VERSION)}`);
});

// =============================================================================
// 2) OLLAMA_DEFAULT_PATHS — at least one of the canonical patterns present
// =============================================================================

test('W743 #2 — OLLAMA_DEFAULT_PATHS contains a .ollama/models path', () => {
  freshDir();
  assert.ok(Array.isArray(OLLAMA_DEFAULT_PATHS),
    'OLLAMA_DEFAULT_PATHS must be an array');
  // It must reference the canonical ".ollama/models" trailing path on at least
  // one of the candidates. The exact platform path is host-dependent.
  const re = /\.ollama[\\/](models|model_lib)/;
  const matches = OLLAMA_DEFAULT_PATHS.filter((p) => typeof p === 'string' && re.test(p));
  assert.ok(matches.length >= 1,
    `expected at least one .ollama/models candidate; got ${JSON.stringify(OLLAMA_DEFAULT_PATHS)}`);
});

// =============================================================================
// 3) LMSTUDIO_DEFAULT_PATHS — lm-studio/models present somewhere
// =============================================================================

test('W743 #3 — LMSTUDIO_DEFAULT_PATHS contains an lm-studio/models path', () => {
  freshDir();
  assert.ok(Array.isArray(LMSTUDIO_DEFAULT_PATHS),
    'LMSTUDIO_DEFAULT_PATHS must be an array');
  // We accept either `lm-studio/models` (linux/mac) or `LM Studio\models`
  // (windows) or `LMStudio\models` (alt windows). Case-insensitive because
  // path comparison varies across platforms.
  const re = /(lm[ -]?studio)[\\/]models/i;
  const matches = LMSTUDIO_DEFAULT_PATHS.filter((p) => typeof p === 'string' && re.test(p));
  assert.ok(matches.length >= 1,
    `expected at least one lm-studio/models candidate; got ${JSON.stringify(LMSTUDIO_DEFAULT_PATHS)}`);
});

// =============================================================================
// 4) discoverOllamaModels — honest envelope on missing root
// =============================================================================

test('W743 #4 — discoverOllamaModels honest envelope on missing root', () => {
  const tmp = freshDir();
  const fake = path.join(tmp, 'definitely-not-an-ollama-' + crypto.randomBytes(4).toString('hex'));
  const env = discoverOllamaModels(fake);
  assert.equal(env.ok, false, `expected ok:false; got ${JSON.stringify(env)}`);
  assert.equal(env.error, 'ollama_root_missing');
  assert.equal(env.version, 'w743-v1');
});

// =============================================================================
// 5) discoverOllamaModels — mock filesystem returns >=1 model
// =============================================================================

test('W743 #5 — discoverOllamaModels finds models in mock filesystem', () => {
  const tmp = freshDir();
  const stub = stubOllamaRoot(tmp, { name: 'llama3.2', tag: '3b' });
  const env = discoverOllamaModels(stub.root);
  assert.equal(env.ok, true, `expected ok:true; got ${JSON.stringify(env)}`);
  assert.equal(env.source, 'ollama');
  assert.equal(env.found, 1, `expected found:1; got found:${env.found}`);
  const m = env.models[0];
  assert.equal(m.name, 'llama3.2');
  assert.equal(m.tag, '3b');
  assert.equal(m.source_name, 'llama3.2:3b');
  assert.equal(m.blob_path, stub.blob_path);
  assert.equal(m.digest_hex, stub.digest_hex);
});

// =============================================================================
// 6) discoverLmStudioModels — honest envelope on missing root
// =============================================================================

test('W743 #6 — discoverLmStudioModels honest envelope on missing root', () => {
  const tmp = freshDir();
  const fake = path.join(tmp, 'definitely-not-an-lmstudio-' + crypto.randomBytes(4).toString('hex'));
  const env = discoverLmStudioModels(fake);
  assert.equal(env.ok, false, `expected ok:false; got ${JSON.stringify(env)}`);
  assert.equal(env.error, 'lmstudio_root_missing');
  assert.equal(env.version, 'w743-v1');
});

// =============================================================================
// 7) discoverLmStudioModels — mock filesystem returns >=1 entry
// =============================================================================

test('W743 #7 — discoverLmStudioModels finds .gguf files in mock filesystem', () => {
  const tmp = freshDir();
  const stub = stubLmStudioRoot(tmp);
  const env = discoverLmStudioModels(stub.root);
  assert.equal(env.ok, true, `expected ok:true; got ${JSON.stringify(env)}`);
  assert.equal(env.source, 'lmstudio');
  assert.ok(env.found >= 1, `expected at least 1 model found; got ${env.found}`);
  const m = env.models[0];
  assert.equal(m.name, stub.basename);
  assert.equal(m.path, stub.file_path);
  assert.equal(m.format, 'gguf');
  assert.equal(m.publisher, stub.publisher);
  assert.equal(m.repo, stub.repo);
});

// =============================================================================
// 8) migrateOllamaModel — wrapped manifest carries not_kolm_compiled + source_tool
// =============================================================================
//
// We can't depend on python3 being on PATH inside the test runner, so we
// validate the wrap path two ways:
//   (a) if python3 is present, the wrap should return ok:true with the
//       not_kolm_compiled:true + source_tool:"ollama" decorations.
//   (b) if python3 is missing, the envelope is python3_missing — still carries
//       the source_tool and migrate_version decorations.
// Either path is honest; the load-bearing assertion is the source_tool field.

test('W743 #8 — migrateOllamaModel wraps with source_tool:"ollama" + inherits not_kolm_compiled:true', async () => {
  const tmp = freshDir();
  const stub = stubOllamaRoot(tmp);
  const env = discoverOllamaModels(stub.root);
  const entry = env.models[0];
  const wrapped = await migrateOllamaModel(entry);
  assert.equal(wrapped.source_tool, 'ollama',
    `source_tool must be "ollama" regardless of python3 availability; got ${wrapped.source_tool}`);
  assert.equal(wrapped.migrate_version, 'w743-v1');
  if (wrapped.ok === true) {
    assert.ok(wrapped.manifest && typeof wrapped.manifest === 'object',
      'envelope.manifest must be an object');
    assert.equal(wrapped.manifest.not_kolm_compiled, true,
      'W740-2 honesty lock: not_kolm_compiled MUST flow transitively through migrate wrap');
    assert.equal(wrapped.manifest.source_tool, 'ollama');
    assert.equal(wrapped.manifest.source_name, 'llama3.2:3b');
  } else {
    assert.equal(wrapped.error, 'python3_missing',
      `expected python3_missing on the failure branch; got ${wrapped.error}`);
  }
});

// =============================================================================
// 9) migrateLmStudioModel — wrapped manifest carries source_tool:"lmstudio"
// =============================================================================

test('W743 #9 — migrateLmStudioModel wraps with source_tool:"lmstudio"', async () => {
  const tmp = freshDir();
  const stub = stubLmStudioRoot(tmp);
  const env = discoverLmStudioModels(stub.root);
  const entry = env.models[0];
  const wrapped = await migrateLmStudioModel(entry);
  assert.equal(wrapped.source_tool, 'lmstudio',
    `source_tool must be "lmstudio" regardless of python3 availability; got ${wrapped.source_tool}`);
  assert.equal(wrapped.migrate_version, 'w743-v1');
  if (wrapped.ok === true) {
    assert.equal(wrapped.manifest.not_kolm_compiled, true,
      'W740-2 honesty lock: not_kolm_compiled MUST flow through migrate wrap');
    assert.equal(wrapped.manifest.source_tool, 'lmstudio');
    assert.equal(wrapped.manifest.source_publisher, stub.publisher);
    assert.equal(wrapped.manifest.source_repo, stub.repo);
  } else {
    assert.equal(wrapped.error, 'python3_missing');
  }
});

// =============================================================================
// 10) runMigrationDryRun — returns found:N without parsing
// =============================================================================

test('W743 #10 — runMigrationDryRun returns found:N without invoking wrap', () => {
  const tmp = freshDir();
  const stub = stubOllamaRoot(tmp);
  const env = runMigrationDryRun({ source: 'ollama', path: stub.root, limit: 10 });
  assert.equal(env.ok, true, `expected ok:true; got ${JSON.stringify(env)}`);
  assert.equal(env.source, 'ollama');
  assert.equal(env.found, 1);
  assert.ok(Array.isArray(env.sample), 'sample must be an array');
  assert.equal(env.sample.length, 1);
  assert.equal(env.version, 'w743-v1');
  // Sample entries must NOT contain a `manifest` field — that would mean we
  // accidentally invoked the wrap path.
  assert.equal(env.sample[0].manifest, undefined,
    'dry-run sample entries must NOT contain a manifest (would mean wrap was invoked)');
});

// =============================================================================
// 11) POST /v1/migrate/discover — auth + envelope
// =============================================================================

test('W743 #11 — POST /v1/migrate/discover: 401 no-auth, 200 with discovery envelope', async () => {
  const tmp = freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const stub = stubOllamaRoot(tmp);

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    // 11a — no auth -> 401
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/migrate/discover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'ollama', path: stub.root }),
    });
    assert.equal(noAuth.status, 401, `expected 401 with no auth; got ${noAuth.status}`);

    // 11b — auth + ollama + valid path -> 200 with discovery envelope
    const good = await fetch(`http://127.0.0.1:${port}/v1/migrate/discover`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ source: 'ollama', path: stub.root }),
    });
    assert.equal(good.status, 200, `expected 200; got ${good.status}`);
    const body = await good.json();
    assert.equal(body.ok, true, `expected ok:true; got ${JSON.stringify(body)}`);
    assert.equal(body.source, 'ollama');
    assert.equal(body.found, 1);
    assert.equal(body.version, 'w743-v1');

    // 11c — auth + invalid source -> 400
    const bad = await fetch(`http://127.0.0.1:${port}/v1/migrate/discover`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ source: 'invalid-source' }),
    });
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.error, 'invalid_source');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 12) POST /v1/migrate/wrap — auth + envelope.manifest.not_kolm_compiled:true
// =============================================================================

test('W743 #12 — POST /v1/migrate/wrap: 401 no-auth; envelope.manifest carries not_kolm_compiled:true', async () => {
  const tmp = freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const stub = stubOllamaRoot(tmp);

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    // 12a — no auth
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/migrate/wrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'ollama', model_name: 'llama3.2:3b', path: stub.root }),
    });
    assert.equal(noAuth.status, 401, `expected 401 no-auth; got ${noAuth.status}`);

    // 12b — auth + missing model_name -> 400
    const missField = await fetch(`http://127.0.0.1:${port}/v1/migrate/wrap`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ source: 'ollama', path: stub.root }),
    });
    assert.equal(missField.status, 400);
    const missBody = await missField.json();
    assert.equal(missBody.error, 'missing_field');
    assert.equal(missBody.field, 'model_name');

    // 12c — auth + valid path + valid name -> 200 (or 503 if python3 missing)
    const good = await fetch(`http://127.0.0.1:${port}/v1/migrate/wrap`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ source: 'ollama', model_name: 'llama3.2:3b', path: stub.root }),
    });
    assert.ok(good.status === 200 || good.status === 503,
      `expected 200 or 503; got ${good.status}`);
    const goodBody = await good.json();
    assert.equal(goodBody.source_tool, 'ollama',
      `envelope.source_tool must be "ollama"; got ${JSON.stringify(goodBody)}`);
    if (good.status === 200) {
      assert.equal(goodBody.ok, true);
      assert.ok(goodBody.manifest && typeof goodBody.manifest === 'object',
        'envelope.manifest must be an object');
      assert.equal(goodBody.manifest.not_kolm_compiled, true,
        'W740-2 honesty lock: not_kolm_compiled must be true on migrate wrap');
      assert.equal(goodBody.manifest.source_tool, 'ollama');
      assert.equal(goodBody.migrate_version, 'w743-v1');
    } else {
      assert.equal(goodBody.error, 'python3_missing');
    }

    // 12d — auth + valid path + bogus name -> 200 + model_not_found
    const noModel = await fetch(`http://127.0.0.1:${port}/v1/migrate/wrap`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ source: 'ollama', model_name: 'no-such-model:xyz', path: stub.root }),
    });
    assert.equal(noModel.status, 200);
    const noModelBody = await noModel.json();
    assert.equal(noModelBody.ok, false);
    assert.equal(noModelBody.error, 'model_not_found');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 13) public/docs/migrate.html — brand-lock + both source sections
// =============================================================================

test('W743 #13 — /docs/migrate.html exists with brand-lock strings + ollama + lmstudio sections', () => {
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
    'Ollama',                                 // source section
    'LM Studio',                              // source section
    'kolm migrate from-ollama',               // CLI snippet
    'kolm migrate from-lmstudio',             // CLI snippet
    'kolm migrate doctor',                    // CLI snippet
    'kolm distill',                           // next-step hint
    'local-only',                             // privacy note (allow hyphen)
    'POST /v1/migrate/discover',              // API surface
    'POST /v1/migrate/wrap',                  // API surface
  ]) {
    assert.ok(html.includes(needle),
      `migrate.html must mention "${needle}"`);
  }
});

// =============================================================================
// 14) vercel.json /docs/migrate rewrite
// =============================================================================

test('W743 #14 — vercel.json has /docs/migrate -> /docs/migrate.html rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have rewrites array');
  const found = cfg.rewrites.find(r => r && r.source === '/docs/migrate');
  assert.ok(found, 'expected rewrite with source=/docs/migrate');
  assert.equal(found.destination, '/docs/migrate.html',
    `expected destination=/docs/migrate.html; got ${found && found.destination}`);
});

// =============================================================================
// 15) cli/kolm.js defines cmdW743Migrate + wired
// =============================================================================

test('W743 #15 — cli/kolm.js defines cmdW743Migrate dispatcher exactly once + wired from case migrate', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW743Migrate\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW743Migrate dispatcher definition; got ${defs.length}`);
  assert.ok(cli.includes('cmdW743Migrate(rest)'),
    `cmdW743Migrate must be invoked with the rest args`);
  // Wire-up: the dispatcher must be reachable from `case 'migrate'` (existing
  // spec-migrate verb stays around as a fallthrough).
  assert.ok(/case\s+['"]migrate['"]/.test(cli),
    `cli must have a case 'migrate' arm`);
  // Honest error codes the dispatcher MUST reference.
  for (const needle of [
    'from-ollama',
    'from-lmstudio',
    'ollama_root_missing',
    'lmstudio_root_missing',
    'model_not_found',
  ]) {
    assert.ok(cli.includes(needle),
      `cmdW743Migrate must reference "${needle}"`);
  }
  // Distill-hint surfaced after a successful wrap (round-trip honesty).
  assert.ok(/kolm distill.*--base/.test(cli),
    `cmdW743Migrate must surface "kolm distill --base ..." hint after wrap`);
});

// =============================================================================
// 16) Family lock-in via regex (W604 anti-brittle)
// =============================================================================

test('W743 #16 — wave743 sibling test count uses wave(\\d{3,4}) regex + threshold pattern', () => {
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
// Bonus — describeMigrationSources returns the expected shape
// =============================================================================

test('W743 #17 — describeMigrationSources returns ollama + lmstudio detail', () => {
  freshDir();
  const out = describeMigrationSources();
  assert.equal(out.ok, true);
  assert.equal(out.version, 'w743-v1');
  assert.ok(out.ollama && Array.isArray(out.ollama.candidates));
  assert.ok(out.lmstudio && Array.isArray(out.lmstudio.candidates));
  for (const d of out.ollama.detail) {
    assert.ok(typeof d.path === 'string');
    assert.ok(typeof d.exists === 'boolean');
  }
  for (const d of out.lmstudio.detail) {
    assert.ok(typeof d.path === 'string');
    assert.ok(typeof d.exists === 'boolean');
  }
});
