// W715 — Cross-namespace transfer learning.
//
// Closes W707 system-upgrade item: "New user starts with zero captures →
// bootstrap from anonymized patterns of similar namespaces". The atomic
// units are namespace-fingerprint.js + binder.js audit + the namespace/new
// consent UI + the trainer warm-start hook + the CLI wiring.
//
// These tests assert behavior, not page copy. Per W604 anti-brittleness:
// regex + threshold patterns, never explicit-array family checks.
//
//   1) FINGERPRINT_VERSION === 'w715-v1'
//   2) computeFingerprint({captures: []}) returns honest empty fingerprint (n_captures: 0)
//   3) computeFingerprint with captures returns non-null hashes
//   4) Two fingerprints from same captures are byte-identical (deterministic)
//   5) cosineSimilarity == 1.0 for identical, <= 1.0 always
//   6) findNearestNamespaces ranks correctly
//   7) verticalGuess returns one of {legal, medical, code, finance, support, general}
//   8) PRIVACY LOCK: fingerprint payload contains NO raw capture text
//   9) AUDIT: binder.recordFingerprintShare writes a FINGERPRINT_SHARE audit row
//  10) CLI `kolm namespace fingerprint --json` emits valid JSON with expected keys
//  11) FEDERATED HOOK: --warm-start-from-fingerprint missing → cold-start log line
//  12) HTML opt-in checkbox is UNCHECKED by default in /account/namespaces/new
//  13) AUDIT op code FINGERPRINT_SHARE is registered + matches the regex shape

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w715-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  return tmp;
}

// Sample captures with a clear vertical lean toward 'support'.
const SUPPORT_CAPTURES = [
  { text: 'i cannot reset my password please help with login ticket' },
  { text: 'app crash on launch please reproduce the bug screenshot attached' },
  { text: 'how do i cancel my subscription and request a refund' },
  { text: 'install failed timeout connecting to server console log error' },
];

const CODE_CAPTURES = [
  { text: 'async function returns null pointer please commit fix to compiler' },
  { text: 'segfault in mutex closure stacktrace points to kernel syscall' },
  { text: 'await import const class export return pullrequest merge approved' },
  { text: 'method on class pointer closure mutex syscall kernel stacktrace' },
];

const PII_PROBE_CAPTURES = [
  { text: 'My email is alice@example.com and my SSN is 123-45-6789 reset password' },
  { text: 'API_KEY=sk-secret-abc-123 reset login ticket bug crash console' },
  { text: 'phone 555-867-5309 reset login ticket subscription refund crash' },
];

// =============================================================================
// 1) FINGERPRINT_VERSION
// =============================================================================

test('W715 #1 — FINGERPRINT_VERSION === "w715-v1"', async () => {
  const fp = await import('../src/namespace-fingerprint.js');
  assert.equal(fp.FINGERPRINT_VERSION, 'w715-v1', 'FINGERPRINT_VERSION must be w715-v1');
});

// =============================================================================
// 2) Empty-captures honest envelope
// =============================================================================

test('W715 #2 — computeFingerprint({captures: []}) returns honest empty envelope (n_captures: 0)', async () => {
  const fp = await import('../src/namespace-fingerprint.js');
  const result = fp.computeFingerprint({ captures: [], namespace: 'empty-ns' });
  assert.equal(result.version, 'w715-v1');
  assert.equal(result.n_captures, 0);
  assert.equal(result.n_tokens, 0);
  assert.equal(result.n_unique_terms, 0);
  assert.equal(typeof result.token_bag_hash, 'string');
  assert.equal(result.token_bag_hash.length, 64, 'token_bag_hash is 64-hex sha256');
  assert.ok(Array.isArray(result.top_terms_hash_array), 'top_terms_hash_array is an array');
  assert.equal(result.top_terms_hash_array.length, 0);
  assert.equal(result.vertical_guess, 'general');
  assert.match(result.fingerprint_id, /^fp_[a-f0-9]+$/);
  assert.equal(result.namespace, 'empty-ns');
});

// =============================================================================
// 3) Populated fingerprint
// =============================================================================

test('W715 #3 — computeFingerprint with captures returns non-null hashes + top_terms', async () => {
  const fp = await import('../src/namespace-fingerprint.js');
  const result = fp.computeFingerprint({ captures: SUPPORT_CAPTURES, namespace: 'support-bot' });
  assert.equal(result.version, 'w715-v1');
  assert.equal(result.n_captures, SUPPORT_CAPTURES.length);
  assert.ok(result.n_tokens > 0, 'must count tokens');
  assert.ok(result.n_unique_terms > 0, 'must count unique bigrams');
  assert.equal(result.token_bag_hash.length, 64);
  assert.notEqual(result.token_bag_hash, ''.padEnd(64, '0'), 'non-empty captures must have non-zero hash');
  assert.ok(result.top_terms_hash_array.length > 0, 'top_terms_hash_array must be populated');
  assert.ok(result.top_terms_hash_array.length <= fp.TOP_TERMS_K, 'top_terms <= TOP_TERMS_K');
  for (const h of result.top_terms_hash_array) {
    assert.match(h, /^[a-f0-9]{64}$/, 'each top_term entry is a sha256 hex');
  }
});

// =============================================================================
// 4) Determinism
// =============================================================================

test('W715 #4 — Two fingerprints from same captures are byte-identical', async () => {
  const fp = await import('../src/namespace-fingerprint.js');
  const a = fp.computeFingerprint({ captures: SUPPORT_CAPTURES, namespace: 'ns1' });
  const b = fp.computeFingerprint({ captures: SUPPORT_CAPTURES, namespace: 'ns1' });
  assert.equal(a.token_bag_hash, b.token_bag_hash, 'token_bag_hash deterministic');
  assert.equal(a.n_tokens, b.n_tokens);
  assert.equal(a.n_unique_terms, b.n_unique_terms);
  assert.deepEqual(a.top_terms_hash_array, b.top_terms_hash_array);
  assert.equal(a.fingerprint_id, b.fingerprint_id, 'fingerprint_id deterministic per (ns, bag)');
});

// =============================================================================
// 5) cosineSimilarity bounds
// =============================================================================

test('W715 #5 — cosineSimilarity == 1.0 for identical, <= 1.0 always', async () => {
  const fp = await import('../src/namespace-fingerprint.js');
  const a = fp.computeFingerprint({ captures: SUPPORT_CAPTURES, namespace: 'ns1' });
  const b = fp.computeFingerprint({ captures: SUPPORT_CAPTURES, namespace: 'ns2' });
  const c = fp.computeFingerprint({ captures: CODE_CAPTURES, namespace: 'ns3' });
  const sim_aa = fp.cosineSimilarity(a, a);
  const sim_ab = fp.cosineSimilarity(a, b);
  const sim_ac = fp.cosineSimilarity(a, c);
  assert.equal(sim_aa, 1.0, 'identical fingerprints similarity is 1.0');
  assert.equal(sim_ab, 1.0, 'same captures different namespace still similarity 1.0 (bag-based)');
  assert.ok(sim_ac <= 1.0, 'similarity bounded above by 1.0');
  assert.ok(sim_ac >= 0.0, 'similarity bounded below by 0.0');
  assert.ok(sim_ac < sim_aa, 'different verticals similarity strictly less than identical');
});

// =============================================================================
// 6) findNearestNamespaces ranking
// =============================================================================

test('W715 #6 — findNearestNamespaces ranks siblings by similarity desc', async () => {
  const fp = await import('../src/namespace-fingerprint.js');
  const target = fp.computeFingerprint({ captures: SUPPORT_CAPTURES, namespace: 'target' });
  const near = fp.computeFingerprint({ captures: SUPPORT_CAPTURES.slice(0, 3), namespace: 'near-sibling' });
  const far = fp.computeFingerprint({ captures: CODE_CAPTURES, namespace: 'far-cousin' });
  const ranked = fp.findNearestNamespaces(target, [near, far], 5);
  assert.equal(ranked.length, 2, 'two candidates returned');
  assert.equal(ranked[0].namespace, 'near-sibling', 'near sibling ranks first');
  assert.ok(ranked[0].similarity >= ranked[1].similarity, 'descending sort by similarity');
  // k truncation:
  const truncated = fp.findNearestNamespaces(target, [near, far], 1);
  assert.equal(truncated.length, 1);
  // self-exclusion:
  const withSelf = fp.findNearestNamespaces(target, [target, near, far], 5);
  for (const r of withSelf) {
    assert.notEqual(r.fingerprint_id, target.fingerprint_id, 'self is excluded from results');
  }
});

// =============================================================================
// 7) verticalGuess
// =============================================================================

test('W715 #7 — verticalGuess returns one of {legal, medical, code, finance, support, general}', async () => {
  const fp = await import('../src/namespace-fingerprint.js');
  const VALID_VERTICALS_REGEX = /^(legal|medical|code|finance|support|general)$/;
  const support = fp.computeFingerprint({ captures: SUPPORT_CAPTURES, namespace: 'ns' });
  const code = fp.computeFingerprint({ captures: CODE_CAPTURES, namespace: 'ns' });
  const empty = fp.computeFingerprint({ captures: [], namespace: 'ns' });
  assert.match(support.vertical_guess, VALID_VERTICALS_REGEX);
  assert.match(code.vertical_guess, VALID_VERTICALS_REGEX);
  assert.match(empty.vertical_guess, VALID_VERTICALS_REGEX);
  assert.equal(empty.vertical_guess, 'general', 'no captures → general');
  // Sanity: support_captures should guess support, code_captures should guess code.
  assert.equal(support.vertical_guess, 'support', 'support corpus guesses support vertical');
  assert.equal(code.vertical_guess, 'code', 'code corpus guesses code vertical');
  // VERTICAL_STUBS shape: dict of arrays of strings.
  for (const [v, terms] of Object.entries(fp.VERTICAL_STUBS)) {
    assert.match(v, VALID_VERTICALS_REGEX, 'every stub key is a known vertical');
    assert.ok(Array.isArray(terms) && terms.length > 0, `${v} stub has terms`);
  }
});

// =============================================================================
// 8) PRIVACY LOCK — no raw text leaks
// =============================================================================

test('W715 #8 — fingerprint payload contains NO raw capture text', async () => {
  const fp = await import('../src/namespace-fingerprint.js');
  const result = fp.computeFingerprint({ captures: PII_PROBE_CAPTURES, namespace: 'pii-test' });
  const serialized = JSON.stringify(result);
  // Anti-leak regex set: emails, SSN patterns, phone numbers, secrets,
  // and the explicit strings we injected into the captures.
  const ANTI_LEAK_PATTERNS = [
    /alice@example\.com/i,
    /123-45-6789/,
    /sk-secret/i,
    /555-867-5309/,
    /API_KEY/i,
    /SSN/i,
    // distinct token from PII_PROBE_CAPTURES that should NEVER appear:
    /attached/, // intentionally not in CAPTURES, just a sanity that the assertion mechanism works
  ];
  // The last regex (/attached/) WILL fail if a leak somehow includes it,
  // so we test the assertion direction by excluding it from probes that
  // matter and testing it inverted:
  for (const re of ANTI_LEAK_PATTERNS.slice(0, -1)) {
    assert.ok(!re.test(serialized),
      `fingerprint payload must NOT contain ${re}; serialized=${serialized.slice(0, 200)}...`);
  }
  // Sanity: no email, ssn, phone, key in the JSON.
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(serialized),
    'no email-like substring in fingerprint payload');
  assert.ok(!/\b\d{3}-\d{2}-\d{4}\b/.test(serialized), 'no SSN-like substring');
  assert.ok(!/\b\d{3}-\d{3}-\d{4}\b/.test(serialized), 'no phone-like substring');
});

// =============================================================================
// 9) AUDIT — recordFingerprintShare writes a FINGERPRINT_SHARE row
// =============================================================================

test('W715 #9 — binder.recordFingerprintShare writes a FINGERPRINT_SHARE audit row', async () => {
  freshDir();
  // Reset audit table cache.
  const storeMod = await import('../src/store.js');
  if (storeMod._resetForTests) storeMod._resetForTests();
  const binder = await import('../src/binder.js');
  const audit = await import('../src/audit.js');
  assert.equal(typeof binder.recordFingerprintShare, 'function', 'recordFingerprintShare exported');
  assert.equal(audit.AUDIT_OPS.FINGERPRINT_SHARE, 'fingerprint.share', 'op code registered');
  // Set the receipt secret (audit chain refuses to write without it).
  process.env.RECIPE_RECEIPT_SECRET = 'x'.repeat(48);
  const row = binder.recordFingerprintShare(
    'tenant_test_1',
    'my-support-bot',
    'fp_deadbeefcafe',
    ['sibling-a', 'sibling-b']
  );
  assert.ok(row, 'returns a row');
  assert.equal(row.op, 'fingerprint.share');
  assert.equal(row.payload.namespace, 'my-support-bot');
  assert.equal(row.payload.fingerprint_id, 'fp_deadbeefcafe');
  assert.equal(row.payload.recipient_count, 2);
  assert.deepEqual(row.payload.recipient_namespaces, ['sibling-a', 'sibling-b']);
  assert.equal(typeof row.event_hash, 'string');
  assert.equal(row.event_hash.length, 64, 'event_hash is sha256 hex');
  // Missing args → null.
  assert.equal(binder.recordFingerprintShare(null, 'ns', 'fp', []), null);
  assert.equal(binder.recordFingerprintShare('t', null, 'fp', []), null);
});

// =============================================================================
// 10) CLI emits JSON
// =============================================================================

test('W715 #10 — CLI `kolm namespace fingerprint --json` emits valid JSON with expected keys', () => {
  freshDir();
  const cliPath = path.join(REPO_ROOT, 'cli', 'kolm.js');
  const env = { ...process.env, KOLM_NO_INTERACTIVE: '1', RECIPE_RECEIPT_SECRET: 'y'.repeat(48) };
  const res = spawnSync(
    process.execPath,
    [cliPath, 'namespace', 'fingerprint', '--json'],
    { env, encoding: 'utf8', timeout: 30000 }
  );
  // Help / verticals / fingerprint must not crash. Exit 0.
  assert.equal(res.status, 0, `cli exited non-zero; stderr=${res.stderr}`);
  // Output must be JSON-parseable.
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    assert.fail(`stdout was not valid JSON: ${res.stdout.slice(0, 200)}`);
  }
  assert.equal(parsed.version, 'w715-v1');
  assert.equal(typeof parsed.n_captures, 'number');
  assert.equal(typeof parsed.token_bag_hash, 'string');
  assert.ok(Array.isArray(parsed.top_terms_hash_array));
  assert.match(parsed.vertical_guess, /^(legal|medical|code|finance|support|general)$/);
  assert.match(parsed.fingerprint_id, /^fp_[a-f0-9]+$/);
});

// =============================================================================
// 11) FEDERATED warm-start hook — cold start when fingerprint absent
// =============================================================================

test('W715 #11 — federated.py --warm-start-from-fingerprint missing → cold-start log line', () => {
  const py = process.env.KOLM_PYTHON || process.env.PYTHON || 'python';
  const fedPath = path.join(REPO_ROOT, 'apps', 'trainer', 'federated.py');
  // The module imports torch at top-level. If torch is not available in
  // CI, skip with a clear note rather than failing the whole wave.
  const probe = spawnSync(py, ['-c', 'import torch'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    // Static-source-grep fallback: assert the surface exists even when
    // we cannot run the trainer in this environment.
    const src = fs.readFileSync(fedPath, 'utf8');
    assert.ok(/--warm-start-from-fingerprint/.test(src),
      'federated.py source must declare --warm-start-from-fingerprint');
    assert.ok(/no warm-start checkpoint available, cold start/.test(src),
      'federated.py source must log cold-start fallback message');
    assert.ok(/load_warm_start_from_fingerprint/.test(src),
      'federated.py source must define load_warm_start_from_fingerprint');
    return;
  }
  // torch present → run the CLI probe end-to-end.
  const tmp = fresh_tmp();
  const fpPath = path.join(tmp, 'nonexistent.json');
  const res = spawnSync(py, [fedPath, '--warm-start-from-fingerprint', fpPath], { encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0, `python exited non-zero; stderr=${res.stderr}`);
  assert.ok(/cold start/.test(res.stdout) || /cold start/.test(res.stderr),
    `expected "cold start" in output; got stdout=${res.stdout} stderr=${res.stderr}`);
});

function fresh_tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w715-py-'));
}

// =============================================================================
// 12) HTML consent checkbox unchecked by default
// =============================================================================

test('W715 #12 — /account/namespaces/new opt-in checkbox is UNCHECKED by default', () => {
  const htmlPath = path.join(REPO_ROOT, 'public', 'account', 'namespaces', 'new.html');
  assert.ok(fs.existsSync(htmlPath), 'public/account/namespaces/new.html must exist');
  const html = fs.readFileSync(htmlPath, 'utf8');
  // The checkbox must NOT have the `checked` attribute on the input element.
  // Match the share-fingerprint input specifically.
  const shareCheckboxMatch = html.match(/<input[^>]*name="share_fingerprint"[^>]*>/);
  assert.ok(shareCheckboxMatch, 'must have share_fingerprint checkbox input');
  const inputTag = shareCheckboxMatch[0];
  assert.equal(inputTag.includes('type="checkbox"'), true, 'is a checkbox');
  assert.equal(/\bchecked\b/.test(inputTag), false,
    'share_fingerprint checkbox MUST NOT default to checked (W715 standing directive #6)');
  // Form must POST to /v1/namespaces/new.
  assert.match(html, /action="\/v1\/namespaces\/new"/, 'form posts to /v1/namespaces/new');
  // Page must explain what is shared in plain language.
  assert.match(html, /anonymized term-bag hashes only/i, 'consent text mentions anonymized hashes');
  assert.match(html, /no raw text/i, 'consent text disclaims raw text');
});

// =============================================================================
// 13) AUDIT op code shape — anti-brittleness regex
// =============================================================================

test('W715 #13 — AUDIT_OPS.FINGERPRINT_SHARE matches the established op-name regex', async () => {
  const audit = await import('../src/audit.js');
  // Per W604 anti-brittleness: regex + threshold, not explicit-array.
  // Every op code is a dotted-lowercase namespace.verb pair.
  const OP_NAME_RE = /^[a-z_]+\.[a-z_]+$/;
  assert.match(audit.AUDIT_OPS.FINGERPRINT_SHARE, OP_NAME_RE);
  // The FINGERPRINT_SHARE code starts with "fingerprint." (the surface name).
  assert.ok(audit.AUDIT_OPS.FINGERPRINT_SHARE.startsWith('fingerprint.'),
    'op code lives in the fingerprint.* namespace');
  // FEDERATED_SHARE (W461) and FINGERPRINT_SHARE (W715) must be distinct ops:
  assert.notEqual(audit.AUDIT_OPS.FINGERPRINT_SHARE, audit.AUDIT_OPS.FEDERATED_SHARE,
    'fingerprint share and federated share are distinct audit operations');
});
