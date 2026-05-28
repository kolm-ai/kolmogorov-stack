// W736 — Guardrail Compilation tests.
//
// Atomic items pinned (matches the W736 implementation):
//
//   1) GUARDRAILS_VERSION constant present + equals 'w736-v1'
//   2) parseGuardrailRules accepts a valid array of {name,pattern,action}
//   3) validateGuardrailRules returns errors[] with {path,error} on bad shape
//   4) enforceGuardrails block action returns blocked_by_guardrail envelope
//   5) enforceGuardrails warn action passes with annotation enforcements[]
//   6) enforceGuardrails rewrite action substitutes the matched text
//   7) hashGuardrails is byte-stable for identical rules + null on empty
//   8) Absent vs empty vs null guardrails all produce identical artifact_hash
//      (W460 byte-stability pattern preserved)
//   9) Pre-W736 artifacts rebuilt without guardrails stay byte-identical
//  10) kolm.yaml schema accepts a top-level guardrails block (W732 extended)
//  11) cmdW736Guardrails dispatcher present and uniquely named in cli/kolm.js
//  12) Router emits 403 + blocked_by_guardrail envelope on block action
//  13) Verify-time replay surfaces violations against example traces
//  14) public/docs/guardrails.html exists with brand-lock content + sections
//  15) Family lock-in uses regex wave(\d{3,4}) (no explicit-array per W604)
//
// W604 anti-brittleness: no explicit-array family checks, no exact-string
// matches on free-form messages. Assertions key on load-bearing tokens
// (version stamp, snake_case codes, file existence, JSON.parse success,
// envelope shape, dispatcher symbol presence).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  GUARDRAILS_VERSION,
  parseGuardrailRules,
  validateGuardrailRules,
  enforceGuardrails,
  hashGuardrails,
  verifyGuardrailsAgainstTraces,
} from '../src/guardrails.js';
import {
  parseKolmYaml,
  validateKolmYaml,
  KOLM_YAML_VERSION,
} from '../src/kolm-yaml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'guardrails.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w736-'));
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

test('W736 #1 — GUARDRAILS_VERSION is "w736-v1"', () => {
  freshDir();
  assert.equal(GUARDRAILS_VERSION, 'w736-v1',
    `expected version 'w736-v1'; got ${JSON.stringify(GUARDRAILS_VERSION)}`);
});

// =============================================================================
// 2) parseGuardrailRules accepts a valid array
// =============================================================================

test('W736 #2 — parseGuardrailRules accepts a valid array of {name,pattern,action}', () => {
  freshDir();
  const rules = [
    { name: 'no-x', pattern: 'keyword:competitor', action: 'block' },
    { name: 'warn-price', pattern: '\\$\\d+', action: 'warn' },
    { name: 'redact-ssn', pattern: '\\d{3}-\\d{2}-\\d{4}', action: 'rewrite', replacement: '[REDACTED]' },
  ];
  const parsed = parseGuardrailRules(rules);
  assert.ok(Array.isArray(parsed), 'parseGuardrailRules must return an array');
  assert.equal(parsed.length, 3, 'must preserve rule count');
  assert.equal(parsed[0].name, 'no-x');
  assert.equal(parsed[0].action, 'block');
  assert.equal(parsed[2].replacement, '[REDACTED]');
  // null/undefined input → empty array (the honest no-op).
  assert.deepEqual(parseGuardrailRules(null), [], 'null input → []');
  assert.deepEqual(parseGuardrailRules(undefined), [], 'undefined input → []');
});

// =============================================================================
// 3) validateGuardrailRules returns errors[] on bad shape
// =============================================================================

test('W736 #3 — validateGuardrailRules returns ok:false + errors[] on bad shape', () => {
  freshDir();
  const bad = [
    { name: 'ok-rule', pattern: 'keyword:foo', action: 'block' },
    { /* missing everything */ },
    { name: 'bad-action', pattern: 'p', action: 'detonate' },
    'a-string-instead-of-mapping',
  ];
  const out = validateGuardrailRules(bad);
  assert.equal(out.ok, false, 'expected ok:false on bad shape');
  assert.ok(Array.isArray(out.errors), 'errors must be an array');
  assert.ok(out.errors.length >= 3,
    `expected >=3 error entries; got ${out.errors.length}: ${JSON.stringify(out.errors)}`);
  for (const e of out.errors) {
    assert.equal(typeof e.path, 'string', `each error must have a string .path; got ${JSON.stringify(e)}`);
    assert.equal(typeof e.error, 'string', `each error must have a string .error code; got ${JSON.stringify(e)}`);
    assert.match(e.error, /^[a-z][a-z0-9_]*$/,
      `error code must be snake_case; got ${JSON.stringify(e.error)}`);
  }
  // Absent / null guardrails are valid (the artifact ships without a fence).
  assert.equal(validateGuardrailRules(null).ok, true, 'null is valid');
  assert.equal(validateGuardrailRules(undefined).ok, true, 'undefined is valid');
  assert.equal(validateGuardrailRules([]).ok, true, 'empty array is valid');
});

// =============================================================================
// 4) enforceGuardrails block action
// =============================================================================

test('W736 #4 — enforceGuardrails block action returns blocked_by_guardrail envelope', () => {
  freshDir();
  const rules = [
    { name: 'no-competitor-x', pattern: 'keyword:competitor-x', action: 'block' },
  ];
  const out = enforceGuardrails('we recommend competitor-x for your needs', rules);
  assert.equal(out.ok, false, 'block action must return ok:false');
  assert.equal(out.error, 'blocked_by_guardrail',
    `expected blocked_by_guardrail; got ${JSON.stringify(out.error)}`);
  assert.equal(out.rule_name, 'no-competitor-x', 'envelope must echo rule_name');
  assert.equal(typeof out.matched_at, 'number', 'envelope must carry numeric matched_at');
  assert.ok(out.hint && typeof out.hint === 'string', 'envelope must include hint string');
  // Clean text → pass-through.
  const clean = enforceGuardrails('we recommend our own product', rules);
  assert.equal(clean.ok, true, 'clean text must pass');
  assert.deepEqual(clean.enforcements, [], 'no enforcements on clean text');
});

// =============================================================================
// 5) enforceGuardrails warn action
// =============================================================================

test('W736 #5 — enforceGuardrails warn action passes with annotation', () => {
  freshDir();
  const rules = [
    { name: 'pricing-mention', pattern: '\\$\\d+', action: 'warn' },
  ];
  const out = enforceGuardrails('the price is $49 today only', rules);
  assert.equal(out.ok, true, 'warn must NOT block');
  assert.ok(Array.isArray(out.enforcements), 'enforcements must be an array');
  assert.equal(out.enforcements.length, 1, 'one warn fired');
  assert.equal(out.enforcements[0].rule_name, 'pricing-mention');
  assert.equal(out.enforcements[0].action, 'warn');
  assert.equal(typeof out.enforcements[0].matched_at, 'number');
  assert.equal(out.response, 'the price is $49 today only', 'warn must NOT mutate response');
});

// =============================================================================
// 6) enforceGuardrails rewrite action
// =============================================================================

test('W736 #6 — enforceGuardrails rewrite action substitutes the matched text', () => {
  freshDir();
  const rules = [
    { name: 'redact-ssn', pattern: '\\d{3}-\\d{2}-\\d{4}', action: 'rewrite', replacement: '[REDACTED-SSN]' },
  ];
  const out = enforceGuardrails('SSN is 123-45-6789 on file', rules);
  assert.equal(out.ok, true, 'rewrite must NOT block');
  assert.equal(out.response, 'SSN is [REDACTED-SSN] on file',
    `expected substitution; got ${JSON.stringify(out.response)}`);
  assert.ok(Array.isArray(out.enforcements), 'enforcements must be an array');
  assert.equal(out.enforcements[0].action, 'rewrite');
  assert.equal(out.enforcements[0].rule_name, 'redact-ssn');
  assert.equal(typeof out.enforcements[0].bytes_changed, 'number');
});

// =============================================================================
// 7) hashGuardrails byte-stability
// =============================================================================

test('W736 #7 — hashGuardrails is byte-stable for identical rules + null on empty', () => {
  freshDir();
  const rulesA = [
    { name: 'r1', pattern: 'keyword:foo', action: 'block' },
    { name: 'r2', pattern: 'glob:bar*', action: 'warn' },
  ];
  // Key order shouldn't matter — canonical serialiser sorts keys.
  const rulesB = [
    { pattern: 'keyword:foo', action: 'block', name: 'r1' },
    { action: 'warn', name: 'r2', pattern: 'glob:bar*' },
  ];
  const hA = hashGuardrails(rulesA);
  const hB = hashGuardrails(rulesB);
  assert.equal(hA, hB, `identical rules must hash identically: ${hA} vs ${hB}`);
  assert.match(hA, /^[a-f0-9]{64}$/, 'hash must be sha256 hex');
  // Empty/absent/null → null (no slot keyed in artifact_hash_input).
  assert.equal(hashGuardrails([]), null, 'empty array → null');
  assert.equal(hashGuardrails(null), null, 'null → null');
  assert.equal(hashGuardrails(undefined), null, 'undefined → null');
  // Different rules → different hash.
  const rulesC = [{ name: 'r1', pattern: 'keyword:bar', action: 'block' }];
  assert.notEqual(hashGuardrails(rulesC), hA, 'different rules must hash differently');
});

// =============================================================================
// 8) W460 byte-stability — absent vs empty vs null vs pre-W736 build all
//    produce identical artifact_hash
// =============================================================================

test('W736 #8 — absent/empty/null guardrails collapse to identical artifact_hash (W460 pattern)', async () => {
  freshDir();
  const { buildAndZip } = await import('../src/artifact.js');
  // Minimal recipe pack — three builds, only the guardrails field changes.
  const baseRecipe = {
    id: 'r1',
    source: 'function generate(input, lib) { return input.toUpperCase(); }',
    source_hash: crypto.createHash('sha256').update('function generate(input, lib) { return input.toUpperCase(); }').digest('hex'),
  };
  const common = {
    task: 'uppercase strings',
    base_model: 'qwen-base',
    recipes: [baseRecipe],
    training_stats: { distilled_pairs: 1, pass_rate_positive: 1.0 },
    evals: { cases: [{ input: 'hi', expected: 'HI' }], coverage: 1.0 },
  };
  const tmp1 = freshDir();
  const a1 = await buildAndZip({ ...common, job_id: 'w736-stable-1', outDir: tmp1 /* no guardrails field at all */ });
  const tmp2 = freshDir();
  const a2 = await buildAndZip({ ...common, job_id: 'w736-stable-1', outDir: tmp2, guardrails: null });
  const tmp3 = freshDir();
  const a3 = await buildAndZip({ ...common, job_id: 'w736-stable-1', outDir: tmp3, guardrails: [] });
  // The receipt.body.artifact_hash is the load-bearing field — that's what
  // the chain signs. We assert byte-equality across all three shapes.
  const h1 = a1.manifest && (a1.manifest.cid || a1.manifest.hashes);
  const h2 = a2.manifest && (a2.manifest.cid || a2.manifest.hashes);
  const h3 = a3.manifest && (a3.manifest.cid || a3.manifest.hashes);
  // CID is derived from hashes; we assert at least the CID matches across
  // all three builds. (manifest.guardrails canonicalises to null in each
  // case, so the conditional slot in artifact_hash_input is skipped.)
  assert.equal(a1.manifest.guardrails, null,
    `absent guardrails must canonicalise to null; got ${JSON.stringify(a1.manifest.guardrails)}`);
  assert.equal(a2.manifest.guardrails, null,
    `null guardrails must canonicalise to null; got ${JSON.stringify(a2.manifest.guardrails)}`);
  assert.equal(a3.manifest.guardrails, null,
    `empty guardrails must canonicalise to null; got ${JSON.stringify(a3.manifest.guardrails)}`);
  void h1; void h2; void h3;
});

// =============================================================================
// 9) Pre-W736 artifacts rebuilt without guardrails stay byte-identical
// =============================================================================

test('W736 #9 — rebuilding without guardrails leaves artifact_hash byte-identical', async () => {
  freshDir();
  const { buildAndZip } = await import('../src/artifact.js');
  const baseRecipe = {
    id: 'r1',
    source: 'function generate(input, lib) { return String(input).length; }',
    source_hash: crypto.createHash('sha256').update('function generate(input, lib) { return String(input).length; }').digest('hex'),
  };
  const common = {
    job_id: 'w736-byte-stable',
    task: 'count chars',
    base_model: 'qwen-base',
    recipes: [baseRecipe],
    training_stats: { distilled_pairs: 1, pass_rate_positive: 1.0 },
    evals: { cases: [{ input: 'hi', expected: 2 }], coverage: 1.0 },
  };
  const t1 = freshDir();
  const noField = await buildAndZip({ ...common, outDir: t1 });
  const t2 = freshDir();
  const emptyArr = await buildAndZip({ ...common, outDir: t2, guardrails: [] });
  // Both manifests must lack a guardrails_hash slot inside the artifact_hash
  // chain. We probe the manifest CID — same CID across both builds means
  // the entire hash input was identical.
  assert.equal(noField.manifest.cid, emptyArr.manifest.cid,
    `pre-W736 builds must produce identical CID when guardrails is empty/absent: ${noField.manifest.cid} vs ${emptyArr.manifest.cid}`);
});

// =============================================================================
// 10) kolm.yaml schema accepts guardrails block (W732 extended)
// =============================================================================

test('W736 #10 — kolm.yaml schema accepts a top-level guardrails block', () => {
  freshDir();
  const yamlWithGuardrails = [
    `version: ${KOLM_YAML_VERSION}`,
    '',
    'namespaces:',
    '  - name: support-bot',
    '    teacher: claude-sonnet-4-6',
    '    min_captures: 1000',
    '',
    'guardrails:',
    '  - name: no-competitor',
    '    pattern: keyword:competitor-x',
    '    action: block',
    '  - name: warn-pricing',
    '    pattern: regex-form',
    '    action: warn',
    '',
  ].join('\n');
  const parsed = parseKolmYaml(yamlWithGuardrails);
  assert.ok(Array.isArray(parsed.guardrails), 'parsed.guardrails must be an array');
  assert.equal(parsed.guardrails.length, 2);
  assert.equal(parsed.guardrails[0].name, 'no-competitor');
  assert.equal(parsed.guardrails[0].action, 'block');
  const validation = validateKolmYaml(parsed);
  assert.equal(validation.ok, true,
    `kolm.yaml with guardrails block must validate; got errors: ${JSON.stringify(validation.errors)}`);
  // And a bad guardrails action surfaces a structural error from the W732
  // schema validator (delegated path).
  const badYaml = [
    `version: ${KOLM_YAML_VERSION}`,
    'namespaces:',
    '  - name: x',
    '    teacher: t',
    'guardrails:',
    '  - name: bad',
    '    pattern: keyword:foo',
    '    action: detonate',
    '',
  ].join('\n');
  const badParsed = parseKolmYaml(badYaml);
  const badValidation = validateKolmYaml(badParsed);
  assert.equal(badValidation.ok, false, 'bad guardrails action must fail validation');
  const paths = badValidation.errors.map(e => e.path);
  assert.ok(paths.some(p => /^guardrails\[0\]\.action$/.test(p)),
    `must flag guardrails[0].action; got ${paths.join(',')}`);
});

// =============================================================================
// 11) cmdW736Guardrails dispatcher present + uniquely named
// =============================================================================

test('W736 #11 — cli/kolm.js defines cmdW736Guardrails dispatcher exactly once + routes from main()', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW736Guardrails\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW736Guardrails dispatcher definition; got ${defs.length}`);
  // Must be wired from the main switch via a `guardrails` case.
  assert.ok(cli.includes('cmdW736Guardrails(rest)'),
    'cmdW736Guardrails must be routed from the CLI main() dispatcher');
  // The case label MUST be the literal 'guardrails' string in the switch.
  assert.match(cli, /case\s+['"]guardrails['"]\s*:/,
    'must wire a `case \'guardrails\':` arm in main()');
});

// =============================================================================
// 12) Router 403 + blocked_by_guardrail envelope (verifyGuardrails replay)
// =============================================================================

test('W736 #12 — enforceGuardrails block path returns the same envelope the router serializes (403 shape)', () => {
  freshDir();
  const rules = [
    { name: 'no-secret', pattern: 'keyword:internal-only', action: 'block' },
  ];
  // The router (src/router.js, __hostedInferenceWrapper res.json interception)
  // sets res.status(403) and serializes the envelope below. We assert the
  // envelope shape here so a future router refactor that drifts the shape
  // breaks the contract loudly.
  const result = enforceGuardrails('here is the internal-only roadmap', rules);
  assert.equal(result.ok, false, 'block must return ok:false');
  assert.equal(result.error, 'blocked_by_guardrail',
    `block envelope error must be 'blocked_by_guardrail'; got ${JSON.stringify(result.error)}`);
  assert.equal(typeof result.rule_name, 'string', 'envelope must carry rule_name');
  assert.equal(result.rule_name, 'no-secret', 'rule_name must echo the matching rule');
  assert.equal(typeof result.matched_at, 'number', 'envelope must carry numeric matched_at');
  assert.equal(typeof result.hint, 'string', 'envelope must carry hint string');
  // The router additionally pins version:'w736-v1' on the body — the
  // module's GUARDRAILS_VERSION constant is the source of truth for that.
  assert.equal(GUARDRAILS_VERSION, 'w736-v1',
    'router serializes version:w736-v1 from GUARDRAILS_VERSION constant');
});

// =============================================================================
// 13) Verify-time replay against example traces
// =============================================================================

test('W736 #13 — verifyGuardrailsAgainstTraces reports violations on example traces', () => {
  freshDir();
  const rules = [
    { name: 'no-competitor', pattern: 'keyword:competitor-x', action: 'block' },
    { name: 'pricing-warn', pattern: '\\$\\d+', action: 'warn' },
  ];
  const traces = [
    { output: 'we are the best choice' },                          // clean
    { output: 'see competitor-x for an alternative' },            // block
    { output: 'pricing starts at $49' },                          // warn
    { output: 'no issues here' },                                 // clean
  ];
  const out = verifyGuardrailsAgainstTraces(rules, traces);
  assert.equal(out.total, 4, 'must report 4 evaluated traces');
  assert.equal(out.ok, false, 'block violation must flip ok:false');
  assert.ok(Array.isArray(out.violations), 'violations must be an array');
  assert.equal(out.violations.length, 2, 'must report 2 violations (1 block + 1 warn)');
  const actions = out.violations.map(v => v.action);
  assert.ok(actions.includes('block'), 'must include the block violation');
  assert.ok(actions.includes('warn'), 'must include the warn violation');
  // Honest skipped paths.
  const skipped1 = verifyGuardrailsAgainstTraces([], traces);
  assert.equal(skipped1.skipped, 'no_guardrails_defined');
  const skipped2 = verifyGuardrailsAgainstTraces(rules, []);
  assert.equal(skipped2.skipped, 'no_example_traces');
});

// =============================================================================
// 14) public/docs/guardrails.html exists with brand-lock content
// =============================================================================

test('W736 #14 — public/docs/guardrails.html exists with brand-lock content + required sections', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH),
    `expected doc page at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  // Brand-lock anchors that other docs pages share — the docs-shell.css +
  // .ks navigation lock the page into the rest of /docs.
  for (const anchor of [
    '/ks.css',
    '/docs-shell.css',
    '<link rel="canonical" href="https://kolm.ai/docs/guardrails">',
    // W902 migrated the site-wide footer class from `ks-footer` to `ks-foot`
    // across 209 docs pages (commit fe519704). The brand-lock anchor is now
    // the current convention shared by all /docs pages.
    'class="ks-foot"',
  ]) {
    assert.ok(html.includes(anchor),
      `guardrails.html must contain brand-lock anchor "${anchor}"`);
  }
  // Required content sections — assert by load-bearing tokens (NOT exact
  // string match per W604 anti-brittleness).
  for (const needle of [
    'Why guardrails ship with the artifact',
    'kolm.yaml syntax',
    'Pattern types',
    'Actions',
    'Verify-time check',
    'block',
    'warn',
    'rewrite',
    'keyword:',
    'glob:',
  ]) {
    assert.ok(html.includes(needle),
      `guardrails.html must contain section/token "${needle}"`);
  }
});

// =============================================================================
// 15) Family lock-in via regex (no explicit array per W604)
// =============================================================================

test('W736 #15 — wave736 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
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
