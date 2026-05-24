// W738 — Artifact Composition: kolm.pipeline.yaml + runtime + sidecar tests.
//
// Atomic items pinned (matches the W738 implementation):
//
//   1) PIPELINE_YAML_VERSION + PIPELINE_RUNNER_VERSION constants present
//   2) parsePipelineYaml accepts the W738 schema (full shape)
//   3) validatePipelineYaml returns errors on bad input (every error surfaced)
//   4) runPipeline with mock classifier + mock loader → routes to correct artifact
//   5) runPipeline with route_not_found returns honest envelope (label + available_routes)
//   6) runPipeline with classifier_failure returns honest envelope (no crash)
//   7) runPipeline with escalation route calls teacher_caller
//   8) latency_ms_breakdown is present on every result (classify + route + total)
//   9) compilePipeline emits .kolm.pipeline sidecar with parent_cids array
//  10) POST /v1/pipeline/run requires auth + returns envelope (no 500s)
//  11) public/docs/pipelines.html exists with brand-lock content + schema example
//  12) cli/kolm.js defines cmdW738Pipeline exactly once + wired from `case 'pipeline'`
//  13) Family lock-in uses regex wave(\d{3,4}) (no explicit-array per W604)
//  14) Dependency injection: tests do NOT require real artifacts or teacher API
//
// W604 anti-brittleness: no explicit-array family checks. Assertions key on
// load-bearing tokens (version stamp, envelope shape, file existence, regex on
// cli/kolm.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  PIPELINE_YAML_VERSION,
  parsePipelineYaml,
  validatePipelineYaml,
  collectReferencedCids,
} from '../src/pipeline-yaml.js';

import {
  PIPELINE_RUNNER_VERSION,
  runPipeline,
  compilePipeline,
} from '../src/pipeline-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'pipelines.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const TESTS_DIR = __dirname;

// Shared sample yaml — kept in sync with starterPipelineYaml() in
// src/pipeline-yaml.js. We deliberately use realistic-looking bafk-style
// cids so the loose CID_RE in the validator passes.
const SAMPLE_YAML = [
  'version: w738-v1',
  'name: support-triage',
  '',
  'classifier:',
  '  artifact_cid: bafkreigh2akiscaildc3xy7p4nntwvjp7m5kw5kbsmm5kkkkkkkkkkkkkk',
  '  version: v1',
  '',
  'routes:',
  '  support:',
  '    artifact_cid: bafkreig5ssssssspport4qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  '  billing:',
  '    artifact_cid: bafkreib1lling4qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  '  escalation:',
  '    teacher: claude-sonnet-4-6',
  '',
].join('\n');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w738-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// =============================================================================
// 1) Version stamps present
// =============================================================================

test('W738 #1 — PIPELINE_YAML_VERSION + PIPELINE_RUNNER_VERSION are w738-v1', () => {
  freshDir();
  assert.equal(PIPELINE_YAML_VERSION, 'w738-v1',
    `expected PIPELINE_YAML_VERSION='w738-v1'; got ${JSON.stringify(PIPELINE_YAML_VERSION)}`);
  assert.equal(PIPELINE_RUNNER_VERSION, 'w738-v1',
    `expected PIPELINE_RUNNER_VERSION='w738-v1'; got ${JSON.stringify(PIPELINE_RUNNER_VERSION)}`);
});

// =============================================================================
// 2) parsePipelineYaml accepts the W738 schema
// =============================================================================

test('W738 #2 — parsePipelineYaml accepts the W738 schema (full shape)', () => {
  freshDir();
  const parsed = parsePipelineYaml(SAMPLE_YAML);
  assert.equal(parsed.version, 'w738-v1');
  assert.equal(parsed.name, 'support-triage');
  assert.ok(parsed.classifier && typeof parsed.classifier.artifact_cid === 'string',
    'classifier.artifact_cid must be present');
  assert.equal(parsed.classifier.version, 'v1');
  assert.ok(parsed.routes && typeof parsed.routes === 'object',
    'routes must be a mapping');
  assert.ok(parsed.routes.support && parsed.routes.support.artifact_cid,
    'routes.support.artifact_cid must be present');
  assert.ok(parsed.routes.billing && parsed.routes.billing.artifact_cid,
    'routes.billing.artifact_cid must be present');
  assert.equal(parsed.routes.escalation.teacher, 'claude-sonnet-4-6');
  // collectReferencedCids must return classifier + 2 artifact-cid routes (NOT teacher).
  const cids = collectReferencedCids(parsed);
  assert.equal(cids.length, 3, `expected 3 referenced cids; got ${cids.length}: ${cids.join(',')}`);
});

// =============================================================================
// 3) validatePipelineYaml returns errors on bad input (every error surfaced)
// =============================================================================

test('W738 #3 — validatePipelineYaml returns errors on bad input + reports every error', () => {
  freshDir();
  // 3a — clean input is ok:true
  const okParsed = parsePipelineYaml(SAMPLE_YAML);
  const okV = validatePipelineYaml(okParsed);
  assert.equal(okV.ok, true, `clean yaml must validate; got ${JSON.stringify(okV)}`);

  // 3b — missing version
  const noVerYaml = SAMPLE_YAML.replace(/^version:.*$/m, '');
  const noVerParsed = parsePipelineYaml(noVerYaml);
  const noVerV = validatePipelineYaml(noVerParsed);
  assert.equal(noVerV.ok, false, 'missing version must fail');
  assert.ok(noVerV.errors.some(e => e.path === 'version' && e.error === 'required'),
    `expected version=required; got ${JSON.stringify(noVerV.errors)}`);

  // 3c — wrong version string
  const wrongVerParsed = parsePipelineYaml(SAMPLE_YAML.replace('w738-v1', 'w999-v9'));
  const wrongVerV = validatePipelineYaml(wrongVerParsed);
  assert.equal(wrongVerV.ok, false);
  assert.ok(wrongVerV.errors.some(e => e.path === 'version' && /must_equal_/.test(e.error)),
    `expected version mismatch error; got ${JSON.stringify(wrongVerV.errors)}`);

  // 3d — route with BOTH artifact_cid + teacher (ambiguous)
  const ambigYaml = [
    'version: w738-v1',
    'name: ambig',
    'classifier:',
    '  artifact_cid: bafkreigh2akiscaildc3xy7p4nntwvjp7m5kw5kbsmm5kkkkkkkkkkkkkk',
    'routes:',
    '  ambiguous:',
    '    artifact_cid: bafkreigh2akiscaildc3xy7p4nntwvjp7m5kw5kbsmm5kkkkkkkkkkkkkk',
    '    teacher: claude-sonnet-4-6',
    '',
  ].join('\n');
  const ambigParsed = parsePipelineYaml(ambigYaml);
  const ambigV = validatePipelineYaml(ambigParsed);
  assert.equal(ambigV.ok, false, 'ambiguous route must fail');
  assert.ok(ambigV.errors.some(e => e.path === 'routes.ambiguous' && e.error === 'must_not_have_both_artifact_cid_and_teacher'),
    `expected ambiguous-route error; got ${JSON.stringify(ambigV.errors)}`);

  // 3e — root must be a mapping (non-object input)
  const rootArr = validatePipelineYaml([1, 2, 3]);
  assert.equal(rootArr.ok, false);
  assert.ok(rootArr.errors.some(e => e.error === 'root_must_be_mapping'));
});

// =============================================================================
// 4) runPipeline routes to the correct artifact (mock classifier + mock loader)
// =============================================================================

test('W738 #4 — runPipeline with mock classifier + mock loader routes correctly', async () => {
  freshDir();
  const parsed = parsePipelineYaml(SAMPLE_YAML);
  const calls = [];
  // Mock loader returns a different stub per cid.
  const artifact_loader = async (cid, _opts) => {
    calls.push({ load: cid });
    if (cid === parsed.classifier.artifact_cid) {
      return { run: (input) => {
        // Trivial classifier: contains "bill" → billing; contains "refund" → support; else escalation.
        if (/bill/i.test(input)) return 'billing';
        if (/refund|support/i.test(input)) return 'support';
        return 'escalation';
      } };
    }
    if (cid === parsed.routes.support.artifact_cid) {
      return { run: (input) => `SUPPORT_REPLY(${input})` };
    }
    if (cid === parsed.routes.billing.artifact_cid) {
      return { run: (input) => `BILLING_REPLY(${input})` };
    }
    throw new Error('unknown_cid:' + cid);
  };
  const teacher_caller = async (teacher, input) => `TEACHER(${teacher})(${input})`;

  // 4a — billing path
  const r1 = await runPipeline({
    pipeline: parsed,
    input: 'I have a billing question',
    tenant_id: 'test-tenant',
    artifact_loader,
    teacher_caller,
  });
  assert.equal(r1.ok, true, `billing route must succeed; got ${JSON.stringify(r1)}`);
  assert.equal(r1.classifier_label, 'billing');
  assert.equal(r1.route_taken.kind, 'artifact');
  assert.equal(r1.route_taken.cid, parsed.routes.billing.artifact_cid);
  assert.equal(r1.result, 'BILLING_REPLY(I have a billing question)');

  // 4b — support path
  const r2 = await runPipeline({
    pipeline: parsed,
    input: 'I need a refund',
    tenant_id: 'test-tenant',
    artifact_loader,
    teacher_caller,
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.classifier_label, 'support');
  assert.equal(r2.result, 'SUPPORT_REPLY(I need a refund)');

  // Idempotency: same input + same pipeline → same classifier_label + route.
  const r2b = await runPipeline({
    pipeline: parsed,
    input: 'I need a refund',
    tenant_id: 'test-tenant',
    artifact_loader,
    teacher_caller,
  });
  assert.equal(r2b.classifier_label, r2.classifier_label,
    'idempotent classify must produce the same label for the same input');
  assert.equal(r2b.route_taken.cid, r2.route_taken.cid,
    'idempotent route must produce the same cid for the same input');
});

// =============================================================================
// 5) route_not_found returns honest envelope
// =============================================================================

test('W738 #5 — runPipeline with route_not_found returns honest envelope', async () => {
  freshDir();
  const parsed = parsePipelineYaml(SAMPLE_YAML);
  const artifact_loader = async (cid, _opts) => {
    if (cid === parsed.classifier.artifact_cid) {
      // Classifier returns a label that is NOT in routes.
      return { run: (_input) => 'sales' };
    }
    throw new Error('should_not_load_for_unknown_route');
  };
  const out = await runPipeline({
    pipeline: parsed,
    input: 'tell me about your enterprise plan',
    tenant_id: 'test-tenant',
    artifact_loader,
  });
  assert.equal(out.ok, false, 'route_not_found must surface ok:false');
  assert.equal(out.error, 'route_not_found');
  assert.equal(out.label, 'sales', 'envelope must echo the missing label');
  assert.ok(Array.isArray(out.available_routes) && out.available_routes.length === 3,
    `available_routes must list known labels; got ${JSON.stringify(out.available_routes)}`);
  // Sorted for stable diff.
  assert.deepEqual(out.available_routes, ['billing', 'escalation', 'support']);
  assert.ok(typeof out.hint === 'string' && out.hint.length > 0,
    'hint must be a non-empty string');
});

// =============================================================================
// 6) classifier_failure returns honest envelope
// =============================================================================

test('W738 #6 — runPipeline with classifier_failure returns honest envelope', async () => {
  freshDir();
  const parsed = parsePipelineYaml(SAMPLE_YAML);
  const artifact_loader = async (cid, _opts) => {
    if (cid === parsed.classifier.artifact_cid) {
      return { run: (_input) => { throw new Error('classifier_blew_up'); } };
    }
    throw new Error('unreachable');
  };
  const out = await runPipeline({
    pipeline: parsed,
    input: 'anything',
    tenant_id: 'test-tenant',
    artifact_loader,
  });
  assert.equal(out.ok, false, 'classifier failure must surface ok:false');
  assert.equal(out.error, 'classifier_failure');
  assert.ok(typeof out.detail === 'string' && out.detail.includes('classifier_blew_up'),
    `detail must surface the underlying error; got ${JSON.stringify(out.detail)}`);
  assert.equal(out.cid, parsed.classifier.artifact_cid,
    'envelope must record which classifier cid failed');
  // Also test classifier_load_failed (loader throws).
  const loaderThrows = async (_cid, _opts) => { throw new Error('catalog_offline'); };
  const out2 = await runPipeline({
    pipeline: parsed,
    input: 'anything',
    tenant_id: 'test-tenant',
    artifact_loader: loaderThrows,
  });
  assert.equal(out2.ok, false);
  assert.equal(out2.error, 'classifier_load_failed');
  assert.ok(out2.detail.includes('catalog_offline'));
});

// =============================================================================
// 7) escalation route calls teacher_caller
// =============================================================================

test('W738 #7 — runPipeline with escalation route calls teacher_caller', async () => {
  freshDir();
  const parsed = parsePipelineYaml(SAMPLE_YAML);
  let teacherCalls = 0;
  const artifact_loader = async (cid, _opts) => {
    if (cid === parsed.classifier.artifact_cid) {
      return { run: (_input) => 'escalation' };
    }
    throw new Error('should_not_load_for_teacher_route');
  };
  const teacher_caller = async (teacher, input) => {
    teacherCalls += 1;
    return `TEACHER(${teacher}):${input}`;
  };
  const out = await runPipeline({
    pipeline: parsed,
    input: 'something hard',
    tenant_id: 'test-tenant',
    artifact_loader,
    teacher_caller,
  });
  assert.equal(out.ok, true, `escalation must succeed; got ${JSON.stringify(out)}`);
  assert.equal(out.classifier_label, 'escalation');
  assert.equal(out.route_taken.kind, 'teacher');
  assert.equal(out.route_taken.teacher, 'claude-sonnet-4-6');
  assert.equal(out.result, 'TEACHER(claude-sonnet-4-6):something hard');
  assert.equal(teacherCalls, 1, 'teacher_caller must be invoked exactly once');

  // Without teacher_caller → honest teacher_caller_required envelope.
  const out2 = await runPipeline({
    pipeline: parsed,
    input: 'something hard',
    tenant_id: 'test-tenant',
    artifact_loader,
    // teacher_caller intentionally omitted
  });
  assert.equal(out2.ok, false);
  assert.equal(out2.error, 'teacher_caller_required');
  assert.equal(out2.teacher, 'claude-sonnet-4-6');
});

// =============================================================================
// 8) latency_ms_breakdown present + honest
// =============================================================================

test('W738 #8 — latency_ms_breakdown present on every result + honest Date.now() deltas', async () => {
  freshDir();
  const parsed = parsePipelineYaml(SAMPLE_YAML);
  // Inject a 25ms delay into the classifier so classify > 0 in a non-flaky way.
  const artifact_loader = async (cid, _opts) => {
    if (cid === parsed.classifier.artifact_cid) {
      return { run: async (_input) => {
        await new Promise((r) => setTimeout(r, 25));
        return 'support';
      } };
    }
    return { run: async (_input) => {
      await new Promise((r) => setTimeout(r, 15));
      return 'support_reply';
    } };
  };
  const out = await runPipeline({
    pipeline: parsed,
    input: 'hi',
    tenant_id: 't',
    artifact_loader,
  });
  assert.equal(out.ok, true, `must succeed; got ${JSON.stringify(out)}`);
  const lat = out.latency_ms_breakdown;
  assert.ok(lat && typeof lat === 'object', 'latency_ms_breakdown must be present');
  assert.equal(typeof lat.classify, 'number', `classify must be number; got ${typeof lat.classify}`);
  assert.equal(typeof lat.route, 'number',   `route must be number; got ${typeof lat.route}`);
  assert.equal(typeof lat.total, 'number',   `total must be number; got ${typeof lat.total}`);
  assert.ok(lat.classify >= 0, `classify must be >= 0; got ${lat.classify}`);
  assert.ok(lat.route    >= 0, `route must be >= 0; got ${lat.route}`);
  assert.ok(lat.total    >= 0, `total must be >= 0; got ${lat.total}`);
  // Honesty: total is independently measured wall-clock. It MUST be at least
  // as large as classify (we don't claim total < classify).
  assert.ok(lat.total >= lat.classify,
    `total (${lat.total}) must be >= classify (${lat.classify}) for an honest breakdown`);
  // Even an error envelope carries latency_ms_breakdown — verify with a
  // classifier_failure path so the contract is total (every code path emits it).
  const loaderThrows = async (_cid, _opts) => { throw new Error('boom'); };
  const errOut = await runPipeline({
    pipeline: parsed,
    input: 'x',
    tenant_id: 't',
    artifact_loader: loaderThrows,
  });
  assert.equal(errOut.ok, false);
  assert.ok(errOut.latency_ms_breakdown && typeof errOut.latency_ms_breakdown.total === 'number',
    'error envelopes must also carry latency_ms_breakdown');
});

// =============================================================================
// 9) compilePipeline emits .kolm.pipeline sidecar with parent_cids array
// =============================================================================

test('W738 #9 — compilePipeline emits sidecar with parent_cids array (W739 lineage chain entry)', async () => {
  freshDir();
  const out = await compilePipeline(SAMPLE_YAML, {});
  assert.equal(out.ok, true, `compile must succeed; got ${JSON.stringify(out)}`);
  assert.ok(out.sidecar && typeof out.sidecar === 'object', 'sidecar must be present');
  assert.equal(out.sidecar.artifact_kind, 'kolm.pipeline',
    'sidecar.artifact_kind must be "kolm.pipeline"');
  assert.equal(out.sidecar.version, PIPELINE_YAML_VERSION);
  assert.equal(out.sidecar.name, 'support-triage');
  // parent_cids — the load-bearing field. Must include classifier + both artifact-cid routes.
  assert.ok(Array.isArray(out.sidecar.parent_cids),
    `parent_cids must be an array; got ${typeof out.sidecar.parent_cids}`);
  assert.equal(out.sidecar.parent_cids.length, 3,
    `parent_cids must list 3 cids (classifier + 2 routes); got ${out.sidecar.parent_cids.length}`);
  // Sorted for stable diff (deterministic regardless of route label order).
  const sorted = out.sidecar.parent_cids.slice().sort();
  assert.deepEqual(out.sidecar.parent_cids, sorted,
    'parent_cids must be sorted for stable diff');
  // sidecar_hash is a sha256-prefixed hex digest so the W739 lineage chain
  // has a stable reference to the pipeline itself.
  assert.ok(/^sha256-[0-9a-f]{64}$/.test(out.sidecar_hash),
    `sidecar_hash must be sha256-prefixed hex; got ${out.sidecar_hash}`);
  // Schema-invalid input → ok:false with validation block surfaced.
  const bad = await compilePipeline('version: w999-v9\nname: x', {});
  assert.equal(bad.ok, false);
  assert.ok(bad.validation && Array.isArray(bad.validation.errors),
    'invalid yaml must surface validation.errors');
});

// =============================================================================
// 10) POST /v1/pipeline/run requires auth + returns envelope
// =============================================================================

test('W738 #10 — POST /v1/pipeline/run requires auth + returns envelope on bad+good calls', async () => {
  freshDir();
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
    // 10a — no auth → 401 (auth middleware fires before the route handler so
    // the error string is the upstream "missing api key"; we accept either
    // the middleware error or the route's own auth_required for forward
    // compatibility if the middleware moves).
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/pipeline/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipeline_yaml: SAMPLE_YAML, input: 'hi' }),
    });
    assert.equal(noAuth.status, 401, `expected 401 with no auth; got ${noAuth.status}`);
    const noAuthBody = await noAuth.json();
    assert.ok(
      noAuthBody.error === 'missing api key' || noAuthBody.error === 'auth_required',
      `expected auth-failure error string; got ${JSON.stringify(noAuthBody)}`,
    );

    // 10b — auth + missing pipeline_yaml → 400 missing_field
    const missField = await fetch(`http://127.0.0.1:${port}/v1/pipeline/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ input: 'hi' }),
    });
    assert.equal(missField.status, 400);
    const missBody = await missField.json();
    assert.equal(missBody.error, 'missing_field');
    assert.equal(missBody.field, 'pipeline_yaml');

    // 10c — auth + invalid yaml schema → 400 pipeline_yaml_validation_failed
    const badSchema = await fetch(`http://127.0.0.1:${port}/v1/pipeline/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ pipeline_yaml: 'version: w999\nname: x', input: 'hi' }),
    });
    assert.equal(badSchema.status, 400);
    const badSchemaBody = await badSchema.json();
    assert.equal(badSchemaBody.error, 'pipeline_yaml_validation_failed');
    assert.ok(badSchemaBody.validation && Array.isArray(badSchemaBody.validation.errors));

    // 10d — auth + valid yaml → runner runs, stub loader fails on first cid → 200 ok:false envelope
    const goodSchema = await fetch(`http://127.0.0.1:${port}/v1/pipeline/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ pipeline_yaml: SAMPLE_YAML, input: 'hi' }),
    });
    // The HTTP call succeeded; the envelope reports the artifact wasn't in the catalog.
    assert.equal(goodSchema.status, 200,
      `valid schema must yield 200 even when artifact_loader fails; got ${goodSchema.status}`);
    const goodBody = await goodSchema.json();
    assert.equal(goodBody.ok, false);
    assert.equal(goodBody.error, 'classifier_load_failed',
      `expected classifier_load_failed envelope; got ${JSON.stringify(goodBody)}`);
    assert.ok(goodBody.latency_ms_breakdown && typeof goodBody.latency_ms_breakdown.total === 'number',
      'envelope must carry latency_ms_breakdown even on artifact-load failure');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 11) public/docs/pipelines.html exists with brand-lock content + schema example
// =============================================================================

test('W738 #11 — /docs/pipelines.html exists with brand-lock content + schema example', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  for (const needle of [
    'kolm.ai',                  // brand
    'class="ks-nav"',           // nav shell
    'ks-footer',                // footer shell
    'kolm.pipeline.yaml',       // schema filename
    'classifier',               // pipeline part
    'routes',                   // pipeline part
    'escalation',               // pipeline lane
    'latency_ms_breakdown',     // honest latency contract
    'parent_cids',              // W739 lineage chain entry point
    'w738-v1',                  // version stamp in the example
    'POST /v1/pipeline/run',    // API surface
  ]) {
    assert.ok(html.includes(needle),
      `pipelines.html must mention "${needle}"`);
  }
  // The full schema example block must include the version line + a classifier
  // section + a routes section so a reader can copy-paste the snippet.
  assert.ok(/version:\s+w738-v1/.test(html),
    'pipelines.html must show "version: w738-v1" in the schema example');
  assert.ok(/classifier:\s*\n\s+artifact_cid:/.test(html),
    'pipelines.html must show a classifier.artifact_cid line in the schema example');
});

// =============================================================================
// 12) cli/kolm.js defines cmdW738Pipeline exactly once + routed
// =============================================================================

test('W738 #12 — cli/kolm.js defines cmdW738Pipeline dispatcher exactly once + routed', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // Distinct-named per the W724/W726/W727/W728/W729/W730/W731/W732/W733/W734/W735
  // precedent so parallel wave agents can't collide on the symbol.
  const defs = cli.match(/async function cmdW738Pipeline\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW738Pipeline dispatcher definition; got ${defs.length}`);
  // Must be routed from the `case 'pipeline'` arm in main() — and the routing
  // must mention cmdW738Pipeline(rest) so a `validate`/`run`/`compile --file`
  // sub reaches the new dispatcher.
  assert.ok(/case\s+['"]pipeline['"]/.test(cli),
    `cli must have a case 'pipeline' arm`);
  assert.ok(cli.includes('cmdW738Pipeline(rest)'),
    `cmdW738Pipeline must be invoked with the rest args`);
  // Honest fallbacks: pipeline_yaml_not_found is the load-bearing error code.
  assert.ok(cli.includes('pipeline_yaml_not_found'),
    `cmdW738Pipeline must emit pipeline_yaml_not_found envelope on missing file`);
});

// =============================================================================
// 13) Family lock-in via regex (no explicit array per W604)
// =============================================================================

test('W738 #13 — wave738 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Threshold check — at least 3 wave-test files MUST exist (W738 itself +
  // siblings like W732/W733/W734/W735). Forward-compatible: adding more wave
  // tests does NOT break this test.
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
});

// =============================================================================
// 14) Dependency injection: tests do NOT require real artifacts or teacher API
// =============================================================================

test('W738 #14 — runPipeline accepts mock artifact_loader + mock teacher_caller (no real network)', async () => {
  freshDir();
  // The whole point of W738-2's design is that the runner is pure orchestration:
  // it accepts callable loaders + callers so tests, dry-runs, and local sims
  // all hit the same code path. We assert the contract by running an entire
  // pipeline (classify + route + escalation) without any IO at all.
  const parsed = parsePipelineYaml(SAMPLE_YAML);
  // A loader that NEVER touches the filesystem or the network.
  const loaderCalls = [];
  const artifact_loader = async (cid, opts) => {
    loaderCalls.push({ cid, tenant: opts && opts.tenant_id });
    if (cid === parsed.classifier.artifact_cid) {
      return (input) => input.length > 100 ? 'escalation' : 'support';
    }
    return (input) => `OK:${input.slice(0, 20)}`;
  };
  const teacher_caller = async (teacher, input) => `TEACHER_${teacher}_${input.slice(0, 10)}`;
  const out1 = await runPipeline({
    pipeline: parsed,
    input: 'short',
    tenant_id: 'tenant-x',
    artifact_loader,
    teacher_caller,
  });
  assert.equal(out1.ok, true);
  assert.equal(out1.route_taken.kind, 'artifact',
    'short input must hit the support artifact route');
  const longInput = 'L'.repeat(200);
  const out2 = await runPipeline({
    pipeline: parsed,
    input: longInput,
    tenant_id: 'tenant-x',
    artifact_loader,
    teacher_caller,
  });
  assert.equal(out2.ok, true);
  assert.equal(out2.route_taken.kind, 'teacher',
    'long input must escalate to the teacher route');
  // Tenant id must be threaded through the loader so a real catalog wire-up
  // can use it for fencing.
  assert.ok(loaderCalls.every(c => c.tenant === 'tenant-x'),
    `every artifact_loader call must receive tenant_id; got ${JSON.stringify(loaderCalls)}`);
});
