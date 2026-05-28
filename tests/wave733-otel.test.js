// W733 — OpenTelemetry Semantic Conventions tests.
//
// Atomic items pinned (matches the W733 implementation):
//
//   1) OTEL_W733_VERSION exported and pinned to 'w733-v1'
//   2) KOLM_OTEL_ATTRS includes all 8 attribute names under kolm.* namespace
//   3) KOLM_OTEL_SPAN_NAMES includes 4 sub-span names (queue/load/prefill/decode)
//   4) createInferenceSpans is callable + tolerates missing tracer (no throw)
//   5) setRoutingAttributes is callable + tolerates missing span (no throw)
//   6) tenant.id_hash is sha256-derived 12-char hex (never raw tenant_id)
//   7) public/docs/observability/opentelemetry.html exists with brand-lock
//   8) opentelemetry.html includes attribute table with all 8 names
//   9) CLI cmdW733OtelStatus dispatcher present + uniquely named
//  10) `kolm otel attributes` returns valid JSON
//  11) Family lock-in uses regex wave(\d{3,4}) (no explicit-array per W604)
//  12) No new package.json deps added (@opentelemetry/api OPTIONAL via try/import)
//
// W604 anti-brittleness: no explicit-array family checks, no exact-string
// matches on free-form messages. Assertions key on load-bearing tokens
// (version stamp, attribute names, span names, file existence, dispatcher
// symbol presence, JSON.parse success).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  OTEL_W733_VERSION,
  KOLM_OTEL_ATTRS,
  KOLM_OTEL_SPAN_NAMES,
  createInferenceSpans,
  setRoutingAttributes,
  getW733Status,
  listW733Attrs,
  listW733SpanNames,
} from '../src/otel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'observability', 'opentelemetry.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const PKG_PATH = path.join(REPO_ROOT, 'package.json');
const TESTS_DIR = __dirname;

// All eight kolm.* attribute names that the W733 plan pins. Order is not
// load-bearing — the test asserts set-membership, not ordering.
const REQUIRED_ATTR_NAMES = [
  'kolm.token.confidence',
  'kolm.routing.decision',
  'kolm.routing.entropy_nats',
  'kolm.kscore.value',
  'kolm.kscore.drift_24h',
  'kolm.artifact.cid',
  'kolm.tenant.id_hash',
  'kolm.namespace',
];

const REQUIRED_SPAN_NAMES = [
  'kolm.inference.queue',
  'kolm.inference.load',
  'kolm.inference.prefill',
  'kolm.inference.decode',
];

// Each test gets a fresh data dir so cross-test state cannot poison the
// runtime. We also wipe KOLM_OTEL + the global tracer hook so the "honest
// no-op" path is exercised by default; tests that need a tracer can set it
// explicitly.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w733-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  delete process.env.KOLM_OTEL;
  delete globalThis.__OTEL_TRACER__;
  return tmp;
}

// =============================================================================
// 1) Version stamp
// =============================================================================

test('W733 #1 — OTEL_W733_VERSION is "w733-v1"', () => {
  freshDir();
  assert.equal(OTEL_W733_VERSION, 'w733-v1',
    `expected version 'w733-v1'; got ${JSON.stringify(OTEL_W733_VERSION)}`);
});

// =============================================================================
// 2) KOLM_OTEL_ATTRS includes all 8 attribute names under kolm.* namespace
// =============================================================================

test('W733 #2 — KOLM_OTEL_ATTRS exposes all 8 required attribute names under kolm.*', () => {
  freshDir();
  assert.equal(typeof KOLM_OTEL_ATTRS, 'object',
    `KOLM_OTEL_ATTRS must be an object; got ${typeof KOLM_OTEL_ATTRS}`);
  const exposed = Object.values(KOLM_OTEL_ATTRS);
  for (const name of REQUIRED_ATTR_NAMES) {
    assert.ok(exposed.includes(name),
      `KOLM_OTEL_ATTRS must include "${name}"; got values: ${exposed.join(',')}`);
    assert.ok(name.startsWith('kolm.'),
      `attribute "${name}" must be namespaced under kolm.*`);
  }
  // listW733Attrs mirror surface must agree with the constant — codegen
  // callers rely on the function form.
  const listed = Object.values(listW733Attrs());
  for (const name of REQUIRED_ATTR_NAMES) {
    assert.ok(listed.includes(name),
      `listW733Attrs() must include "${name}"; got values: ${listed.join(',')}`);
  }
});

// =============================================================================
// 3) KOLM_OTEL_SPAN_NAMES includes 4 sub-span names
// =============================================================================

test('W733 #3 — KOLM_OTEL_SPAN_NAMES exposes 4 inference sub-span names', () => {
  freshDir();
  assert.equal(typeof KOLM_OTEL_SPAN_NAMES, 'object',
    `KOLM_OTEL_SPAN_NAMES must be an object; got ${typeof KOLM_OTEL_SPAN_NAMES}`);
  const exposed = Object.values(KOLM_OTEL_SPAN_NAMES);
  for (const name of REQUIRED_SPAN_NAMES) {
    assert.ok(exposed.includes(name),
      `KOLM_OTEL_SPAN_NAMES must include "${name}"; got values: ${exposed.join(',')}`);
    assert.ok(name.startsWith('kolm.inference.'),
      `span name "${name}" must be namespaced under kolm.inference.*`);
  }
  // Mirror surface check.
  const listed = Object.values(listW733SpanNames());
  for (const name of REQUIRED_SPAN_NAMES) {
    assert.ok(listed.includes(name),
      `listW733SpanNames() must include "${name}"; got values: ${listed.join(',')}`);
  }
});

// =============================================================================
// 4) createInferenceSpans tolerates missing tracer (honest no-op)
// =============================================================================

test('W733 #4 — createInferenceSpans is callable + honest no-op when no tracer registered', () => {
  freshDir();
  // No tracer registered + KOLM_OTEL not set → STATE.enabled is false →
  // honest no-op. Must NOT throw under any timing arg shape.
  assert.equal(typeof createInferenceSpans, 'function',
    `createInferenceSpans must be a function; got ${typeof createInferenceSpans}`);
  let result;
  assert.doesNotThrow(() => {
    result = createInferenceSpans(null, { queue_ms: 12, load_ms: 0, prefill_ms: 3, decode_ms: 41 });
  }, 'createInferenceSpans must not throw with null parent + no tracer');
  // Honest no-op contract: returns false (not an empty array, not undefined).
  assert.equal(result, false,
    `createInferenceSpans must return false on no-op path; got ${JSON.stringify(result)}`);
  // Also tolerates completely missing timings object.
  assert.doesNotThrow(() => createInferenceSpans(null),
    'createInferenceSpans must not throw with no timings');
  assert.doesNotThrow(() => createInferenceSpans(null, {}),
    'createInferenceSpans must not throw with empty timings');
});

// =============================================================================
// 5) setRoutingAttributes tolerates missing span (honest no-op)
// =============================================================================

test('W733 #5 — setRoutingAttributes is callable + honest no-op when span is null', () => {
  freshDir();
  assert.equal(typeof setRoutingAttributes, 'function',
    `setRoutingAttributes must be a function; got ${typeof setRoutingAttributes}`);
  let result;
  assert.doesNotThrow(() => {
    result = setRoutingAttributes(null, { decision: 'student', entropy_nats: 0.5 });
  }, 'setRoutingAttributes must not throw with null span');
  assert.equal(result, false,
    `setRoutingAttributes must return false on no-op path; got ${JSON.stringify(result)}`);
  // Also tolerates null block.
  assert.doesNotThrow(() => setRoutingAttributes(null, null),
    'setRoutingAttributes must not throw with null block');
  // Real native-span shape exercises the happy path.
  const span = { attributes: [] };
  const ok = setRoutingAttributes(span, {
    decision: 'teacher',
    entropy_nats: 0.42,
    kscore: 0.91,
    kscore_drift_24h: -0.03,
    tenant_id: 'tenant_fixture_w733_unit',
    namespace: 'unit-test',
    artifact_cid: 'cid_fixture_abc',
  });
  assert.equal(ok, true,
    `setRoutingAttributes on a kv-array span must return true; got ${ok}`);
  assert.ok(span.attributes.length >= 5,
    `kv-array span must have routing attributes appended; got ${span.attributes.length}`);
});

// =============================================================================
// 6) tenant.id_hash is sha256-derived 12-char hex (NEVER raw tenant_id)
// =============================================================================

test('W733 #6 — tenant.id_hash is sha256(tenant_id) first 12 hex chars, never raw', () => {
  freshDir();
  const rawTenant = 'tenant_w733_privacy_check_' + crypto.randomBytes(8).toString('hex');
  const span = { attributes: [] };
  setRoutingAttributes(span, { decision: 'student', tenant_id: rawTenant });
  // Find the kolm.tenant.id_hash attribute on the kv-array span.
  const hashEntry = span.attributes.find(a => a.key === 'kolm.tenant.id_hash');
  assert.ok(hashEntry, `kolm.tenant.id_hash must be appended to span; got attrs: ${JSON.stringify(span.attributes)}`);
  const hashVal = hashEntry.value && hashEntry.value.stringValue;
  assert.equal(typeof hashVal, 'string',
    `kolm.tenant.id_hash value must be a string; got ${typeof hashVal}`);
  assert.ok(/^[0-9a-f]{12}$/.test(hashVal),
    `kolm.tenant.id_hash must be 12 lowercase hex chars; got ${JSON.stringify(hashVal)}`);
  // Recompute the expected sha256 prefix and assert equality so we know we
  // are not accidentally hashing something else (process.env, timestamp).
  const expected = crypto.createHash('sha256').update(rawTenant).digest('hex').slice(0, 12);
  assert.equal(hashVal, expected,
    `kolm.tenant.id_hash must equal sha256(tenant_id)[:12]; expected ${expected}, got ${hashVal}`);
  // PRIVACY CONTRACT — raw tenant_id must NEVER appear in any attribute
  // value across the whole span. This is the central W733 #6 promise.
  for (const a of span.attributes) {
    const v = (a.value && (a.value.stringValue || String(a.value.intValue || a.value.doubleValue || ''))) || '';
    assert.ok(!v.includes(rawTenant),
      `raw tenant_id leaked into attribute "${a.key}" with value ${JSON.stringify(v)}`);
  }
});

// =============================================================================
// 7) opentelemetry.html exists with brand-lock content
// =============================================================================

test('W733 #7 — /docs/observability/opentelemetry.html exists with brand-lock content', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH),
    `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  // Brand lock matches the W730 prometheus.html shell: ks-nav + ks-foot
  // + canonical kolm.ai brand + topic words. Footer class migrated
  // ks-footer -> ks-foot in W902 (commit fe519704, "kolm-ai org
  // transition"); the static footer shell now ships ks-foot site-wide.
  for (const needle of [
    'kolm.ai',                          // brand
    'class="ks-nav"',                   // nav shell
    'ks-foot',                          // footer shell (W902 BEM rename)
    'OpenTelemetry',                    // topic word
    'w733-v1',                          // version stamp
    'OTEL_EXPORTER_OTLP_ENDPOINT',      // exporter env var
  ]) {
    assert.ok(html.includes(needle),
      `opentelemetry.html must mention "${needle}"`);
  }
});

// =============================================================================
// 8) opentelemetry.html includes attribute table with all 8 names
// =============================================================================

test('W733 #8 — opentelemetry.html documents all 8 kolm.* attributes', () => {
  freshDir();
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  for (const name of REQUIRED_ATTR_NAMES) {
    assert.ok(html.includes(name),
      `opentelemetry.html must document attribute "${name}"`);
  }
  // Also documents the 4 sub-span names so the timeline section is grounded.
  for (const name of REQUIRED_SPAN_NAMES) {
    assert.ok(html.includes(name),
      `opentelemetry.html must document span name "${name}"`);
  }
});

// =============================================================================
// 9) CLI cmdW733OtelStatus dispatcher present + uniquely named
// =============================================================================

test('W733 #9 — cli/kolm.js defines cmdW733OtelStatus dispatcher exactly once', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // Distinct-named per the W724/W726/W727/W728/W729/W730 precedent so
  // parallel W731/W732/W734 wave agents can't collide on the symbol.
  const defs = cli.match(/async function cmdW733OtelStatus\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW733OtelStatus dispatcher definition; got ${defs.length}`);
  // Must also be wired from at least one routing site.
  assert.ok(cli.includes('cmdW733OtelStatus(rest)'),
    `cmdW733OtelStatus must be routed from the CLI dispatcher`);
  assert.ok(/case 'otel'/.test(cli),
    `cli/kolm.js main() must include a case 'otel' for the W733 dispatcher`);
});

// =============================================================================
// 10) `kolm otel attributes` returns valid JSON
// =============================================================================

test('W733 #10 — `kolm otel attributes` emits parseable JSON including all 8 attribute names', () => {
  freshDir();
  // We run the CLI in-process via spawnSync against the existing entry
  // point so the wired case 'otel' arm is exercised end-to-end.
  const res = spawnSync(process.execPath, [CLI_PATH, 'otel', 'attributes'], {
    cwd: REPO_ROOT,
    env: { ...process.env, KOLM_ENV: 'test' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(res.status, 0,
    `kolm otel attributes must exit 0; got ${res.status}; stderr=${res.stderr}`);
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    assert.fail(`kolm otel attributes stdout must be valid JSON; parse error: ${e.message}; stdout was: ${res.stdout.slice(0, 400)}`);
  }
  assert.equal(parsed.ok, true,
    `JSON envelope must report ok:true; got ${JSON.stringify(parsed)}`);
  assert.equal(parsed.version, 'w733-v1',
    `version must be 'w733-v1'; got ${parsed.version}`);
  const exposed = Object.values(parsed.attributes || {});
  for (const name of REQUIRED_ATTR_NAMES) {
    assert.ok(exposed.includes(name),
      `kolm otel attributes JSON must include "${name}"; got: ${exposed.join(',')}`);
  }
  const spanExposed = Object.values(parsed.span_names || {});
  for (const name of REQUIRED_SPAN_NAMES) {
    assert.ok(spanExposed.includes(name),
      `kolm otel attributes JSON must include span name "${name}"; got: ${spanExposed.join(',')}`);
  }
});

// =============================================================================
// 11) Family lock-in via regex (no explicit array per W604)
// =============================================================================

test('W733 #11 — wave733 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  // Walk the tests directory and count files matching wave(\d{3,4}). The
  // W604 anti-brittleness directive FORBIDS explicit-array family checks.
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Threshold check — at least 3 wave-test files MUST exist (W733 itself +
  // siblings like W709/W730). Threshold is forward-compat: adding more
  // wave tests does NOT break this test.
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
});

// =============================================================================
// 12) No new package.json deps added (@opentelemetry/api OPTIONAL)
// =============================================================================

test('W733 #12 — package.json declares no @opentelemetry/* dependency (W733 is honest no-op)', () => {
  freshDir();
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const all = Object.assign(
    {},
    pkg.dependencies || {},
    pkg.devDependencies || {},
    pkg.peerDependencies || {},
    pkg.optionalDependencies || {},
  );
  for (const name of Object.keys(all)) {
    assert.ok(!name.startsWith('@opentelemetry/'),
      `package.json must NOT depend on "${name}" — W733 keeps @opentelemetry/api OPTIONAL via try/import`);
  }
  // Status helper reflects this contract: a fresh process has no tracer
  // registered (we wipe it in freshDir()) so the status report must say so.
  const status = getW733Status();
  assert.equal(status.ok, true,
    `getW733Status() must report ok:true; got ${JSON.stringify(status)}`);
  assert.equal(status.version, 'w733-v1',
    `getW733Status() version must be 'w733-v1'; got ${status.version}`);
  assert.equal(status.tracer_registered, false,
    `with no tracer globalThis hook + no @opentelemetry/api dep, tracer_registered must be false; got ${status.tracer_registered}`);
});
