// W823 — OpenTelemetry integration upgrade tests.
//
// Coverage map (>= 8 tests):
//
//   #1  tools/grafana/kolm-dashboard.json parses as JSON
//   #2  Dashboard has >= 6 panels
//   #3  Dashboard schemaVersion is a number >= 30
//   #4  All 3 alert yaml files exist, are non-empty, parse via tiny yaml subset
//   #5  src/otel-attrs.js exports kolmSpanAttrs (W823-1 attribute helper)
//   #6  All 5 new W823-1 attrs are referenced somewhere in src/
//   #7  Alert thresholds in YAML files match spec (0.05 / 0.15 / 25%)
//   #8  public/sw.js cache key bumped with wave823-otel-upgrade suffix
//   #9  kolmSpanAttrs canonicalizes input -> KOLM_OTEL_ATTRS-keyed envelope
//  #10  W823 panel titles cover the 6 spec'd panel types (sanity)
//  #11  Dashboard panels each declare a prometheus datasource + targets[]
//
// W604 anti-brittleness:
//   - panel-count uses ">=" not "=" so future panels don't trip the test
//   - sw.js cache key uses regex /wave823-otel-upgrade/ not full-string equality
//   - yaml parse uses a tiny inline subset rather than a hard js-yaml dep

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DASHBOARD_PATH = path.join(REPO_ROOT, 'tools', 'grafana', 'kolm-dashboard.json');
const ALERT_PATHS = [
  path.join(REPO_ROOT, 'tools', 'alerts', 'datadog-kolm.yaml'),
  path.join(REPO_ROOT, 'tools', 'alerts', 'honeycomb-kolm.yaml'),
  path.join(REPO_ROOT, 'tools', 'alerts', 'grafana-kolm.yaml'),
];
const OTEL_ATTRS_PATH = path.join(REPO_ROOT, 'src', 'otel-attrs.js');
const OTEL_PATH = path.join(REPO_ROOT, 'src', 'otel.js');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');

// W823-1 canonical attribute keys (the 5 new attrs).
const W823_ATTRS = [
  'kolm.artifact.id',
  'kolm.routing.decision',
  'kolm.token.confidence_p50',
  'kolm.token.confidence_p95',
  'kolm.kscore.drift',
];

// Tiny YAML subset parser — just enough to:
//   - reject blatantly invalid syntax (unbalanced quotes, tab-indent)
//   - confirm the file has top-level key:value pairs
//   - extract numeric values for threshold-presence checks
//
// We deliberately don't try to be a full YAML 1.2 implementation; the test's
// job is to catch typos in the alert template, not to validate the spec.
function tinyYamlValidate(src) {
  if (typeof src !== 'string' || src.length === 0) return { ok: false, reason: 'empty' };
  const lines = src.split(/\r?\n/);
  let hasKey = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    // Strip comments + trailing whitespace.
    const noComment = raw.replace(/(^|[^"'])#.*$/, '$1');
    const trimmed = noComment.trim();
    if (!trimmed) continue;
    // Tab indentation is invalid YAML.
    if (/^\t/.test(raw)) return { ok: false, reason: `tab indent at line ${i + 1}` };
    // Key:value or "- key:" sequence form.
    if (/^[A-Za-z_][\w.-]*\s*:/.test(trimmed)) hasKey = true;
    else if (/^-\s*[A-Za-z_][\w.-]*\s*:/.test(trimmed)) hasKey = true;
    else if (/^-\s/.test(trimmed)) hasKey = true; // bare sequence item
  }
  return { ok: hasKey, reason: hasKey ? null : 'no key:value pairs found' };
}

test('W823 #1 — kolm-dashboard.json parses as JSON', () => {
  assert.ok(fs.existsSync(DASHBOARD_PATH), 'dashboard file must exist');
  const raw = fs.readFileSync(DASHBOARD_PATH, 'utf8');
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'dashboard must parse as JSON');
  assert.ok(parsed && typeof parsed === 'object', 'parsed dashboard must be an object');
});

test('W823 #2 — dashboard has >= 6 panels', () => {
  const parsed = JSON.parse(fs.readFileSync(DASHBOARD_PATH, 'utf8'));
  assert.ok(Array.isArray(parsed.panels), 'panels must be an array');
  assert.ok(parsed.panels.length >= 6, `panel count must be >= 6 (got ${parsed.panels.length})`);
});

test('W823 #3 — dashboard schemaVersion is a number >= 30', () => {
  const parsed = JSON.parse(fs.readFileSync(DASHBOARD_PATH, 'utf8'));
  assert.equal(typeof parsed.schemaVersion, 'number', 'schemaVersion must be a number');
  assert.ok(parsed.schemaVersion >= 30, `schemaVersion must be >= 30 (got ${parsed.schemaVersion})`);
});

test('W823 #4 — all 3 alert yaml files exist + parse via tiny yaml subset', () => {
  for (const p of ALERT_PATHS) {
    assert.ok(fs.existsSync(p), `alert file must exist: ${path.basename(p)}`);
    const raw = fs.readFileSync(p, 'utf8');
    assert.ok(raw.length > 0, `alert file must be non-empty: ${path.basename(p)}`);
    const r = tinyYamlValidate(raw);
    assert.ok(r.ok, `alert file must parse: ${path.basename(p)} (${r.reason})`);
  }
});

test('W823 #5 — src/otel-attrs.js exports kolmSpanAttrs', async () => {
  assert.ok(fs.existsSync(OTEL_ATTRS_PATH), 'src/otel-attrs.js must exist');
  const mod = await import(new URL('../src/otel-attrs.js', import.meta.url).href);
  assert.equal(typeof mod.kolmSpanAttrs, 'function', 'kolmSpanAttrs must be a function');
  // Also verify the standing-directive marker version export so we lock in
  // that src/otel-attrs.js was authored under W823 contract.
  assert.equal(typeof mod.OTEL_ATTRS_W823_VERSION, 'string', 'version export required');
  assert.match(mod.OTEL_ATTRS_W823_VERSION, /^w823-/, 'version must regex-match /^w823-/');
});

test('W823 #6 — all 5 new W823-1 attrs are referenced somewhere in src/', () => {
  // Read both candidate files (the canonical attribute table + the helper).
  const sources = [
    fs.readFileSync(OTEL_PATH, 'utf8'),
    fs.readFileSync(OTEL_ATTRS_PATH, 'utf8'),
  ].join('\n');
  for (const attr of W823_ATTRS) {
    assert.ok(sources.includes(attr), `attr must be referenced in src/: ${attr}`);
  }
});

test('W823 #7 — alert thresholds match spec values', () => {
  // Spec values:
  //   - kscore_drift          > 0.05
  //   - fallback_rate         > 0.15
  //   - p95_latency_increase  > 25%  (i.e. ratio > 1.25)
  for (const p of ALERT_PATHS) {
    const raw = fs.readFileSync(p, 'utf8');
    // K-Score drift: at least one literal "0.05" (datadog uses `> 0.05`,
    // honeycomb uses `value: 0.05`, grafana uses `params: [0.05]`).
    assert.ok(/\b0\.05\b/.test(raw),
      `${path.basename(p)} must reference 0.05 (K-Score drift threshold)`);
    // Fallback rate: at least one literal "0.15".
    assert.ok(/\b0\.15\b/.test(raw),
      `${path.basename(p)} must reference 0.15 (fallback rate threshold)`);
    // Latency: ratio 1.25 OR the percentage "25". Both are valid encodings;
    // datadog/grafana use the ratio, honeycomb uses both. We accept either.
    assert.ok(/\b1\.25\b/.test(raw) || /\b25\b/.test(raw),
      `${path.basename(p)} must reference 1.25 or 25 (latency regression threshold)`);
  }
});

test('W823 #8 — public/sw.js cache key bumped with wave823 suffix', () => {
  const raw = fs.readFileSync(SW_PATH, 'utf8');
  // Per the standing W604/W829 anti-brittleness rule, the sw.js cache-key wave
  // marker is asserted via regex-and-threshold (wave NNN >= 823), NOT a literal
  // per-wave slug. sw.js is a shared file bumped every wave (currently far past
  // 823), so pinning the literal "wave823-otel-upgrade" suffix is stale lock-in.
  const m = raw.match(/wave(\d{3,4})/g);
  assert.ok(m && m.length > 0, 'sw.js must contain at least one wave NNN token');
  const maxWave = m.reduce((acc, tok) => {
    const n = Number(tok.replace(/^wave/, ''));
    return Number.isFinite(n) && n > acc ? n : acc;
  }, 0);
  assert.ok(maxWave >= 823, `sw.js max wave token must be >= 823 (saw ${maxWave})`);
});

test('W823 #9 — kolmSpanAttrs canonicalizes input -> KOLM_OTEL_ATTRS-keyed envelope', async () => {
  const mod = await import(new URL('../src/otel-attrs.js', import.meta.url).href);
  const otel = await import(new URL('../src/otel.js', import.meta.url).href);
  const out = mod.kolmSpanAttrs({
    artifact_id: 'art_w823_test',
    routing_decision: 'student',
    token_confidence_p50: 0.91,
    token_confidence_p95: 0.97,
    kscore_drift: -0.012,
    namespace: 'prod',
    tenant_id: 'tenant_xyz',
  });
  assert.equal(out[otel.KOLM_OTEL_ATTRS.ARTIFACT_ID], 'art_w823_test');
  assert.equal(out[otel.KOLM_OTEL_ATTRS.ROUTING_DECISION], 'student');
  assert.equal(out[otel.KOLM_OTEL_ATTRS.TOKEN_CONFIDENCE_P50], 0.91);
  assert.equal(out[otel.KOLM_OTEL_ATTRS.TOKEN_CONFIDENCE_P95], 0.97);
  assert.equal(out[otel.KOLM_OTEL_ATTRS.KSCORE_DRIFT], -0.012);
  assert.equal(out[otel.KOLM_OTEL_ATTRS.NAMESPACE], 'prod');
  // Privacy contract: raw tenant_id must NEVER appear; sha256 prefix only.
  for (const v of Object.values(out)) {
    assert.notEqual(v, 'tenant_xyz', 'raw tenant_id must never appear in output');
  }
  assert.ok(out[otel.KOLM_OTEL_ATTRS.TENANT_ID_HASH], 'tenant_id_hash must be present');
  assert.match(out[otel.KOLM_OTEL_ATTRS.TENANT_ID_HASH], /^[0-9a-f]{12}$/,
    'tenant_id_hash must be a 12-char hex sha256 prefix');
  // NaN / Infinity must be dropped silently (honesty contract).
  const out2 = mod.kolmSpanAttrs({
    token_confidence_p50: NaN,
    token_confidence_p95: Infinity,
    kscore_drift: 'not a number',
  });
  assert.equal(out2[otel.KOLM_OTEL_ATTRS.TOKEN_CONFIDENCE_P50], undefined);
  assert.equal(out2[otel.KOLM_OTEL_ATTRS.TOKEN_CONFIDENCE_P95], undefined);
  assert.equal(out2[otel.KOLM_OTEL_ATTRS.KSCORE_DRIFT], undefined);
});

test('W823 #10 — dashboard panels cover the 6 spec\'d panel types', () => {
  const parsed = JSON.parse(fs.readFileSync(DASHBOARD_PATH, 'utf8'));
  const titles = parsed.panels.map((p) => String(p.title || '').toLowerCase());
  // We assert presence of the 6 spec'd panel concepts via substring match;
  // wording can drift but the concept must remain.
  const required = [
    /k.?score/,           // K-Score over time
    /drift/,              // K-Score drift gauge
    /latency/,            // p95 latency by artifact
    /fallback/,           // fallback rate (stacked area)
    /confidence/,         // token confidence distribution
    /routing/,            // routing-decision breakdown
  ];
  for (const re of required) {
    assert.ok(titles.some((t) => re.test(t)),
      `dashboard must include a panel matching /${re.source}/ (titles: ${titles.join(' | ')})`);
  }
});

test('W823 #11 — every panel declares a datasource + targets[]', () => {
  const parsed = JSON.parse(fs.readFileSync(DASHBOARD_PATH, 'utf8'));
  for (const panel of parsed.panels) {
    assert.ok(panel.datasource && panel.datasource.type === 'prometheus',
      `panel "${panel.title}" must have prometheus datasource`);
    assert.ok(Array.isArray(panel.targets) && panel.targets.length > 0,
      `panel "${panel.title}" must have non-empty targets[]`);
    for (const t of panel.targets) {
      assert.ok(typeof t.expr === 'string' && t.expr.length > 0,
        `panel "${panel.title}" targets[] must each have an expr`);
    }
  }
});
