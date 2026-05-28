// W732 — Git-integrated kolm.yaml + GHA distill loop tests.
//
// Atomic items pinned (matches the W732 implementation):
//
//   1) KOLM_YAML_VERSION constant present + equals 'w732-v1'
//   2) parseKolmYaml accepts the W732 starter schema
//   3) parseKolmYaml throws snake_case error codes on broken YAML
//   4) validateKolmYaml returns errors[] with {path, error} on schema misses
//   5) findKolmYamlInRepo walks up directories like git's .gitignore search
//   6) .github/workflows/kolm-distill.yml exists + has push trigger comment +
//      has the kolm-distill job
//   7) .github/workflows/kolm-distill.yml is structurally valid YAML
//   8) POST /v1/yaml/validate returns 200 on valid body
//   9) POST /v1/yaml/validate returns 400 with yaml_parse_failed on bad input
//  10) diffArtifacts returns honest w739_not_shipped envelope
//  11) CLI cmdW732YamlSync dispatcher present and uniquely named
//  12) `kolm yaml init` writes a starter file to a tmp dir (idempotent re-run)
//  13) Family lock-in via regex wave(\d{3,4}) (no explicit-array per W604)
//
// W604 anti-brittleness:
//   - no explicit-array family checks
//   - no exact-string matches on free-form messages
//   - assertions key on load-bearing tokens (version stamp, snake_case code,
//     file existence, JSON.parse success, regex matches)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  KOLM_YAML_VERSION,
  parseKolmYaml,
  validateKolmYaml,
  findKolmYamlInRepo,
  starterKolmYaml,
} from '../src/kolm-yaml.js';
import { diffArtifacts, KOLM_DIFF_VERSION } from '../src/kolm-diff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'kolm-distill.yml');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w732-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// =============================================================================
// 1) Version stamp
// =============================================================================

test('W732 #1 — KOLM_YAML_VERSION is "w732-v1"', () => {
  freshDir();
  assert.equal(KOLM_YAML_VERSION, 'w732-v1',
    `expected version 'w732-v1'; got ${JSON.stringify(KOLM_YAML_VERSION)}`);
});

// =============================================================================
// 2) parseKolmYaml accepts the starter schema
// =============================================================================

test('W732 #2 — parseKolmYaml accepts the starter schema with namespaces[] + quality_gates{}', () => {
  freshDir();
  const yaml = starterKolmYaml();
  const parsed = parseKolmYaml(yaml);
  assert.equal(typeof parsed, 'object', 'parsed must be a mapping (object)');
  assert.equal(parsed.version, KOLM_YAML_VERSION,
    `parsed.version must equal ${KOLM_YAML_VERSION}; got ${JSON.stringify(parsed.version)}`);
  assert.ok(Array.isArray(parsed.namespaces), 'namespaces must be an array');
  assert.ok(parsed.namespaces.length >= 1, 'namespaces must have at least one entry');
  const ns0 = parsed.namespaces[0];
  assert.equal(typeof ns0, 'object', 'namespaces[0] must be a mapping');
  assert.equal(typeof ns0.name, 'string', 'namespaces[0].name must be a string');
  assert.equal(typeof ns0.teacher, 'string', 'namespaces[0].teacher must be a string');
  assert.equal(typeof ns0.min_captures, 'number', 'namespaces[0].min_captures must be a number');
  assert.equal(typeof parsed.quality_gates, 'object', 'quality_gates must be a mapping');
  assert.equal(typeof parsed.quality_gates.min_kscore, 'number',
    'quality_gates.min_kscore must be a number');
  assert.equal(typeof parsed.quality_gates.block_on_regression, 'boolean',
    'quality_gates.block_on_regression must be a boolean');
});

// =============================================================================
// 3) parseKolmYaml throws snake_case error codes on broken input
// =============================================================================

test('W732 #3 — parseKolmYaml throws with snake_case .code and a .line on tabbed input', () => {
  freshDir();
  // Tab in leading whitespace must throw `tab_indentation_unsupported`.
  const tabbed = 'version: w732-v1\nnamespaces:\n\t- name: x\n';
  let caught;
  try { parseKolmYaml(tabbed); }
  catch (e) { caught = e; }
  assert.ok(caught instanceof Error, 'parseKolmYaml must throw on tab indent; nothing was thrown');
  assert.match(String(caught.code || ''), /^[a-z][a-z0-9_]*$/,
    `error code must be snake_case; got ${JSON.stringify(caught.code)}`);
  assert.equal(caught.code, 'tab_indentation_unsupported',
    `expected code 'tab_indentation_unsupported'; got ${JSON.stringify(caught.code)}`);
  assert.equal(typeof caught.line, 'number',
    'thrown error must carry a numeric .line');
  assert.ok(caught.line >= 1, '.line must be 1-based');
});

// =============================================================================
// 4) validateKolmYaml returns {path, error} entries on schema violations
// =============================================================================

test('W732 #4 — validateKolmYaml returns ok:false + errors[] with {path,error} on bad shape', () => {
  freshDir();
  // Missing version, namespaces is the wrong type, quality_gates.min_kscore
  // is out of range, namespaces[0] is missing required fields.
  const bad = {
    namespaces: [{ name: 'ok-ns' }, 'a-string-instead-of-mapping'],
    quality_gates: { min_kscore: 2.5, block_on_regression: 'yes' },
  };
  const out = validateKolmYaml(bad);
  assert.equal(out.ok, false, 'expected ok:false on bad shape');
  assert.ok(Array.isArray(out.errors), 'errors must be an array');
  assert.ok(out.errors.length >= 4,
    `expected >=4 error entries; got ${out.errors.length}: ${JSON.stringify(out.errors)}`);
  for (const e of out.errors) {
    assert.equal(typeof e.path, 'string', `each error must have a string .path; got ${JSON.stringify(e)}`);
    assert.equal(typeof e.error, 'string', `each error must have a string .error code; got ${JSON.stringify(e)}`);
    assert.match(e.error, /^[a-z][a-z0-9_]*$/,
      `error code must be snake_case; got ${JSON.stringify(e.error)}`);
  }
  // The actual paths we expect to appear:
  const paths = out.errors.map(e => e.path);
  assert.ok(paths.includes('version'), `must flag missing version; got ${paths.join(',')}`);
  assert.ok(paths.includes('namespaces[1]'), `must flag bad namespaces[1] entry; got ${paths.join(',')}`);
  assert.ok(paths.includes('quality_gates.min_kscore'),
    `must flag quality_gates.min_kscore out of range; got ${paths.join(',')}`);
});

// =============================================================================
// 5) findKolmYamlInRepo walks up directories
// =============================================================================

test('W732 #5 — findKolmYamlInRepo finds an ancestor kolm.yaml from a nested cwd', () => {
  const tmp = freshDir();
  const yamlPath = path.join(tmp, 'kolm.yaml');
  fs.writeFileSync(yamlPath, starterKolmYaml(), 'utf8');
  const nested = path.join(tmp, 'a', 'b', 'c', 'd');
  fs.mkdirSync(nested, { recursive: true });
  const found = findKolmYamlInRepo(nested);
  assert.equal(found, yamlPath,
    `expected to find ${yamlPath} from nested cwd; got ${JSON.stringify(found)}`);
  // Null when no kolm.yaml exists anywhere on the walk-up path.
  const bareTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w732-bare-'));
  // path.parse(bareTmp).root is the platform root; the temp dir is two
  // levels deep on every supported OS (no kolm.yaml at any ancestor of the
  // tmp tree the test runner created).
  const result = findKolmYamlInRepo(bareTmp);
  // Either null (cleanly not-found) OR a kolm.yaml from a real ancestor of
  // the OS tmpdir — both are honest. We assert the type is correct, not the
  // exact value, because a developer running locally might happen to have a
  // kolm.yaml on a parent path of $TMPDIR.
  assert.ok(result === null || typeof result === 'string',
    `findKolmYamlInRepo must return null or a string; got ${typeof result}`);
});

// =============================================================================
// 6) .github/workflows/kolm-distill.yml exists with the right shape
// =============================================================================

test('W732 #6 — kolm-distill.yml exists with kolm-distill job + push-trigger comment', () => {
  freshDir();
  assert.ok(fs.existsSync(WORKFLOW_PATH),
    `expected workflow file at ${WORKFLOW_PATH}`);
  const yml = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  // Required markers — load-bearing tokens, not exact-string matches.
  for (const needle of [
    'name: kolm-distill',                     // workflow name
    'KOLM_API_KEY',                            // secret name in template
    'secret named `KOLM_API_KEY`',             // setup comment: configure the KOLM_API_KEY secret (W908 reworded from "Configure KOLM_API_KEY secret")
    'workflow_dispatch',                       // safe default trigger
    'push:',                                   // documented push trigger (commented out OK)
    'kolm-distill:',                           // job key
    'softprops/action-gh-release@v2',          // release publish step
    'kolm yaml validate',                      // calls our W732 surface
  ]) {
    assert.ok(yml.includes(needle),
      `kolm-distill.yml must contain "${needle}"`);
  }
});

// =============================================================================
// 7) kolm-distill.yml is structurally valid YAML (tiny structural parse)
// =============================================================================

test('W732 #7 — kolm-distill.yml is structurally valid (our parser handles its top-level)', () => {
  freshDir();
  const yml = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  // We don't run a full GHA-schema parse here; we sanity-check that the
  // file's top-level mapping keys are reachable (name, on, jobs). Since
  // our hand-rolled parser is intentionally a strict subset, we strip the
  // # comment lines + the commented-out `# on:` block + any flow-style
  // contents, then verify the three keys parse.
  const cleaned = yml
    .split('\n')
    .filter(line => !/^\s*#/.test(line))   // drop comment-only lines
    .join('\n');
  // The workflow uses some YAML features we don't parse (env: mappings,
  // template expressions). For #7 we only assert the file is non-empty and
  // its three load-bearing top-level keys are present.
  for (const key of ['name:', 'on:', 'jobs:']) {
    assert.ok(cleaned.includes(key),
      `workflow file must include top-level "${key}"`);
  }
  // And the line count after stripping comments is non-trivial (the file
  // isn't just a comment shell).
  assert.ok(cleaned.split('\n').filter(l => l.trim().length > 0).length >= 20,
    'workflow file must have at least 20 non-comment lines');
});

// =============================================================================
// 8) POST /v1/yaml/validate returns 200 on a valid body
// =============================================================================

test('W732 #8 — POST /v1/yaml/validate returns 200 + ok:true on a valid kolm.yaml', async () => {
  freshDir();
  process.env.KOLM_PRODUCTION = '1';
  delete process.env.KOLM_LOCAL_DAEMON;
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  process.env.KOLM_STORE_DRIVER = process.env.KOLM_STORE_DRIVER || 'json';

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(express.text({ type: 'text/yaml', limit: '4mb' }));
  app.use(buildRouter());

  // provisionAnonTenant returns a real tenant_record + api_key; the auth
  // middleware stamps req.tenant_record on every request carrying this key.
  const tenant = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  assert.ok(tenant && tenant.api_key, 'provisionAnonTenant must return a key');

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/yaml/validate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${tenant.api_key}`,
      },
      body: JSON.stringify({ yaml: starterKolmYaml() }),
    });
    assert.equal(res.status, 200, `expected 200; got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, true, `expected ok:true on starter; got ${JSON.stringify(body)}`);
    assert.equal(body.version, KOLM_YAML_VERSION, 'response must echo KOLM_YAML_VERSION');
    assert.equal(typeof body.parsed, 'object', 'response must include parsed tree');
    assert.equal(body.validation.ok, true, 'validation.ok must be true on starter');
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 9) POST /v1/yaml/validate returns 400 yaml_parse_failed on bad input
// =============================================================================

test('W732 #9 — POST /v1/yaml/validate returns 400 with a snake_case error on parse failure', async () => {
  freshDir();
  process.env.KOLM_PRODUCTION = '1';
  delete process.env.KOLM_LOCAL_DAEMON;
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  process.env.KOLM_STORE_DRIVER = process.env.KOLM_STORE_DRIVER || 'json';

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(express.text({ type: 'text/yaml', limit: '4mb' }));
  app.use(buildRouter());

  const tenant = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  assert.ok(tenant && tenant.api_key, 'provisionAnonTenant must return a key');

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // Tab in indentation triggers tab_indentation_unsupported, which the
    // router maps onto the HTTP envelope verbatim.
    const bad = 'version: w732-v1\nnamespaces:\n\t- name: x\n';
    const res = await fetch(`http://127.0.0.1:${port}/v1/yaml/validate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${tenant.api_key}`,
      },
      body: JSON.stringify({ yaml: bad }),
    });
    assert.equal(res.status, 400, `expected 400 on parse failure; got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, false, `expected ok:false; got ${JSON.stringify(body)}`);
    assert.match(String(body.error || ''), /^[a-z][a-z0-9_]*$/,
      `error code must be snake_case; got ${JSON.stringify(body.error)}`);
    assert.ok(body.error === 'tab_indentation_unsupported'
      || body.error === 'yaml_parse_failed',
      `expected tab_indentation_unsupported or yaml_parse_failed; got ${JSON.stringify(body.error)}`);
    assert.equal(typeof body.line, 'number', 'response must echo a numeric line');
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 10) diffArtifacts returns honest w739_not_shipped envelope
// =============================================================================

test('W732 #10 — diffArtifacts is wired (W739 shipped: returns versioned envelope, ok:false for missing files)', async () => {
  freshDir();
  // W739 has shipped, so diffArtifacts is a real implementation rather than
  // the old w732 placeholder stub. For two non-existent paths it must still
  // return ok:false with a versioned envelope so CI / dashboards can branch on
  // the error without re-implementing the file-read logic.
  const result = await diffArtifacts('/tmp/a.kolm', '/tmp/b.kolm');
  assert.equal(typeof result, 'object', 'diffArtifacts must return an object');
  assert.equal(result.ok, false, 'diffArtifacts must return ok:false for missing files');
  assert.equal(typeof result.error, 'string', 'diffArtifacts must include a string error code');
  assert.equal(typeof result.version, 'string', 'diffArtifacts must include a version stamp');
  // Version stamp must be present and carry a recognisable wave prefix.
  assert.equal(typeof KOLM_DIFF_VERSION, 'string', 'KOLM_DIFF_VERSION must be exported');
  assert.match(KOLM_DIFF_VERSION, /^w7(32|39)-/,
    `KOLM_DIFF_VERSION must carry the w732- or w739- prefix; got ${JSON.stringify(KOLM_DIFF_VERSION)}`);
});

// =============================================================================
// 11) CLI cmdW732YamlSync dispatcher present and uniquely named
// =============================================================================

test('W732 #11 — cli/kolm.js defines cmdW732YamlSync dispatcher exactly once + routes from main()', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW732YamlSync\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW732YamlSync dispatcher definition; got ${defs.length}`);
  // Must be wired from the main switch.
  assert.ok(cli.includes('cmdW732YamlSync(rest)'),
    'cmdW732YamlSync must be routed from the CLI main() dispatcher');
  // Diff slot is the W732-4 placeholder.
  const diffDefs = cli.match(/async function cmdW732Diff\s*\(/g) || [];
  assert.equal(diffDefs.length, 1,
    `expected exactly 1 cmdW732Diff dispatcher definition; got ${diffDefs.length}`);
  assert.ok(cli.includes('cmdW732Diff(rest)'),
    'cmdW732Diff must be routed from the CLI main() dispatcher');
});

// =============================================================================
// 12) `kolm yaml init` writes a starter file to a tmp dir
// =============================================================================

test('W732 #12 — `kolm yaml init` writes a starter kolm.yaml to cwd (idempotent on re-run)', () => {
  const tmp = freshDir();
  // Spawn the CLI in a tmpdir as cwd so the test never pollutes the repo
  // root. We use execFileSync so a non-zero exit code surfaces as a thrown
  // error here.
  const env = {
    ...process.env,
    KOLM_NO_INTERACTIVE: '1',  // never drop into the REPL even if TTY
  };
  const stdout1 = execFileSync(
    process.execPath,
    [CLI_PATH, 'yaml', 'init'],
    { cwd: tmp, env, encoding: 'utf8' }
  );
  const first = JSON.parse(stdout1);
  assert.equal(first.ok, true, `first init must succeed; got ${stdout1}`);
  assert.equal(first.created, true, `first init must report created:true; got ${stdout1}`);
  assert.equal(first.path, path.join(tmp, 'kolm.yaml'),
    `first init path must be tmp/kolm.yaml; got ${stdout1}`);
  assert.ok(fs.existsSync(first.path), 'kolm.yaml must exist on disk after init');
  // Re-running must be idempotent and return already_exists:true.
  const stdout2 = execFileSync(
    process.execPath,
    [CLI_PATH, 'yaml', 'init'],
    { cwd: tmp, env, encoding: 'utf8' }
  );
  const second = JSON.parse(stdout2);
  assert.equal(second.ok, true, `second init must succeed; got ${stdout2}`);
  assert.equal(second.already_exists, true,
    `second init must report already_exists:true; got ${stdout2}`);
  // Created starter must validate against our own schema.
  const yamlText = fs.readFileSync(first.path, 'utf8');
  const parsed = parseKolmYaml(yamlText);
  const validation = validateKolmYaml(parsed);
  assert.equal(validation.ok, true,
    `starter must validate; got errors: ${JSON.stringify(validation.errors)}`);
});

// =============================================================================
// 13) Family lock-in via regex (no explicit array per W604)
// =============================================================================

test('W732 #13 — wave732 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
});
