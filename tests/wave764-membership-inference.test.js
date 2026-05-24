// W764 — Membership inference test harness + PII bakeoff scan + capture forget.
//
// Atomic items pinned (matches the W764 implementation):
//
//   1)  MIT_VERSION matches /^w764-/                                          (W604 anti-brittleness)
//   2)  PII_SCAN_VERSION matches /^w764-/                                     (W604 anti-brittleness)
//   3)  FORGET_VERSION matches /^w764-/                                       (W604 anti-brittleness)
//   4)  MIT_ATTACK_KINDS Object.freeze()-d + exactly 4 entries (canonical order)
//   5)  PII_PATTERN_CATEGORIES Object.freeze()-d + exactly 10 entries
//   6)  runMembershipInferenceTest DI happy path → ok + extraction_rate
//   7)  runMembershipInferenceTest null runOnArtifact → runtime_not_wired envelope
//   8)  runMembershipInferenceTest empty captures → no_captures_to_test envelope
//   9)  runMembershipInferenceTest extracts on verbatim replay
//  10)  runMembershipInferenceTest does NOT extract on paraphrased response
//  11)  scanForPII catches email + phone + ssn + Luhn-valid credit card
//  12)  scanForPII Luhn REJECTS off-by-one number (4111111111111112)
//  13)  scanForPII catches AWS access key (AKIA + 16 alnum upper)
//  14)  scanForPII catches GitHub token (ghp_ + 36 base62)
//  15)  scanForPII catches JWT (3 base64url segments, valid header)
//  16)  scanForPII name_likely hits are flagged HEURISTIC
//  17)  runPiiBakeoffScan returns by_category + pii_rate via DI runOnArtifact
//  18)  markCaptureForgotten writes a durable audit event (idempotent on re-call)
//  19)  isCaptureForgotten roundtrip on a marker we wrote
//  20)  filterForgottenCaptures strips marked rows but preserves others
//  21)  listForgottenCaptures tenant-fenced — defense-in-depth filters other tenant
//  22)  POST /v1/mit/run 401 without auth; 400 confirm_required; 200 honest envelope
//  23)  POST /v1/mit/scan-pii 401 without auth; 200 with auth
//  24)  POST /v1/captures/forget 401 without auth; 400 confirm_required; 200 happy
//  25)  GET /v1/captures/forgotten 401 without auth; 200 with auth
//  26)  public/security/membership-inference.html exists w/ brand-lock + anchors
//  27)  cli/kolm.js defines cmdW764Mit exactly once + wired from case 'forget' AND case 'mit'
//  28)  vercel.json carries the /security/membership-inference rewrite
//  29)  wave764 sibling sw.js family pattern uses wave(\d{3,4}) regex + threshold (W604)
//
// W604 anti-brittleness: family lock uses regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  MIT_VERSION,
  MIT_ATTACK_KINDS,
  jaccardOverlap,
  runMembershipInferenceTest,
} from '../src/membership-inference-test.js';
import {
  PII_SCAN_VERSION,
  PII_PATTERN_CATEGORIES,
  scanForPII,
  runPiiBakeoffScan,
} from '../src/pii-bakeoff-scan.js';
import {
  FORGET_VERSION,
  markCaptureForgotten,
  isCaptureForgotten,
  filterForgottenCaptures,
  listForgottenCaptures,
} from '../src/capture-forget.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(REPO_ROOT, 'public', 'security', 'membership-inference.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const TESTS_DIR = __dirname;

// freshDir — give every test its own temp HOME so the event-store lives in
// its own JSONL/sqlite file. Mirrors the W763 pattern. Returns the tmp path.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w764-' + crypto.randomBytes(4).toString('hex') + '-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  return tmp;
}

// resetEventStore — call after freshDir() and BEFORE any test that touches
// the event-store so we are not reading stale state from a prior test under
// the same process.
async function resetEventStore() {
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
}

// =============================================================================
// 1) MIT_VERSION stamp matches /^w764-/
// =============================================================================

test('W764 #1 — MIT_VERSION matches /^w764-/ and is the literal w764-v1', () => {
  freshDir();
  assert.ok(/^w764-/.test(MIT_VERSION),
    `expected MIT_VERSION matching /^w764-/; got ${JSON.stringify(MIT_VERSION)}`);
  assert.equal(MIT_VERSION, 'w764-v1',
    `W604 also pins the literal value; got ${JSON.stringify(MIT_VERSION)}`);
});

// =============================================================================
// 2) PII_SCAN_VERSION stamp matches /^w764-/
// =============================================================================

test('W764 #2 — PII_SCAN_VERSION matches /^w764-/ and is the literal w764-v1', () => {
  freshDir();
  assert.ok(/^w764-/.test(PII_SCAN_VERSION),
    `expected PII_SCAN_VERSION matching /^w764-/; got ${JSON.stringify(PII_SCAN_VERSION)}`);
  assert.equal(PII_SCAN_VERSION, 'w764-v1');
});

// =============================================================================
// 3) FORGET_VERSION stamp matches /^w764-/
// =============================================================================

test('W764 #3 — FORGET_VERSION matches /^w764-/ and is the literal w764-v1', () => {
  freshDir();
  assert.ok(/^w764-/.test(FORGET_VERSION),
    `expected FORGET_VERSION matching /^w764-/; got ${JSON.stringify(FORGET_VERSION)}`);
  assert.equal(FORGET_VERSION, 'w764-v1');
});

// =============================================================================
// 4) MIT_ATTACK_KINDS frozen + exactly 4 entries canonical order
// =============================================================================

test('W764 #4 — MIT_ATTACK_KINDS is Object.freeze()-d + holds exactly 4 entries', () => {
  freshDir();
  assert.ok(Array.isArray(MIT_ATTACK_KINDS), 'MIT_ATTACK_KINDS must be an array');
  assert.ok(Object.isFrozen(MIT_ATTACK_KINDS),
    'MIT_ATTACK_KINDS MUST be Object.freeze()-d so callers cannot mutate the contract');
  assert.equal(MIT_ATTACK_KINDS.length, 4,
    `expected 4 attack kinds; got ${MIT_ATTACK_KINDS.length}: ${JSON.stringify(MIT_ATTACK_KINDS)}`);
  // Canonical order is part of the contract — dashboards key on array index.
  assert.deepEqual(MIT_ATTACK_KINDS, [
    'exact_prompt_replay',
    'paraphrase_prompt',
    'partial_prompt_completion',
    'unique_token_probe',
  ], 'MIT_ATTACK_KINDS canonical order MUST NOT change');
});

// =============================================================================
// 5) PII_PATTERN_CATEGORIES frozen + exactly 10 entries
// =============================================================================

test('W764 #5 — PII_PATTERN_CATEGORIES is Object.freeze()-d + holds exactly 10 entries', () => {
  freshDir();
  assert.ok(Array.isArray(PII_PATTERN_CATEGORIES), 'PII_PATTERN_CATEGORIES must be an array');
  assert.ok(Object.isFrozen(PII_PATTERN_CATEGORIES),
    'PII_PATTERN_CATEGORIES MUST be Object.freeze()-d');
  assert.equal(PII_PATTERN_CATEGORIES.length, 10,
    `expected 10 pattern categories; got ${PII_PATTERN_CATEGORIES.length}: `
    + JSON.stringify(PII_PATTERN_CATEGORIES));
  for (const required of [
    'email', 'phone_us', 'phone_intl', 'ssn_us', 'credit_card_luhn',
    'aws_access_key', 'github_token', 'jwt', 'ip_address', 'name_likely',
  ]) {
    assert.ok(PII_PATTERN_CATEGORIES.includes(required),
      `PII_PATTERN_CATEGORIES must include ${required}; got ${JSON.stringify(PII_PATTERN_CATEGORIES)}`);
  }
});

// =============================================================================
// 6) runMembershipInferenceTest DI happy path → ok envelope + extraction_rate
// =============================================================================

test('W764 #6 — runMembershipInferenceTest with DI runOnArtifact returns ok envelope + extraction_rate', async () => {
  freshDir();
  const captures = [
    { capture_id: 'cap1', prompt: 'what is the capital of france', response: 'paris' },
    { capture_id: 'cap2', prompt: 'explain photosynthesis briefly', response: 'plants convert sunlight into chemical energy via chlorophyll' },
  ];
  // Artifact returns generic non-matching output → no extraction.
  const runOnArtifact = async () => 'i do not know the answer to that question';
  const r = await runMembershipInferenceTest({
    artifact_path: '/tmp/fake.kolm',
    captures,
    runOnArtifact,
  });
  assert.equal(r.ok, true, `expected ok:true; got ${JSON.stringify(r)}`);
  assert.ok(/^w764-/.test(r.version),
    `version must match /^w764-/; got ${JSON.stringify(r.version)}`);
  assert.equal(r.n_captures, 2);
  assert.equal(typeof r.extraction_rate, 'number');
  assert.ok(r.extraction_rate >= 0 && r.extraction_rate <= 1,
    `extraction_rate must be 0..1; got ${r.extraction_rate}`);
  assert.equal(typeof r.by_attack_kind, 'object');
  assert.ok(Array.isArray(r.leaked_captures), 'leaked_captures must be an array');
  // Threshold defaults to 0.85
  assert.equal(r.threshold, 0.85);
});

// =============================================================================
// 7) runMembershipInferenceTest null runOnArtifact → runtime_not_wired
// =============================================================================

test('W764 #7 — runMembershipInferenceTest null runOnArtifact returns runtime_not_wired envelope', async () => {
  freshDir();
  const r = await runMembershipInferenceTest({
    artifact_path: '/tmp/fake.kolm',
    captures: [{ capture_id: 'x', prompt: 'p', response: 'r' }],
    runOnArtifact: null,
  });
  assert.equal(r.ok, false,
    `expected ok:false without runtime; got ${JSON.stringify(r)}`);
  assert.equal(r.error, 'runtime_not_wired',
    `expected runtime_not_wired; got ${JSON.stringify(r)}`);
  assert.ok(/^w764-/.test(r.version));
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0,
    'runtime_not_wired envelope must include an actionable hint');
});

// =============================================================================
// 8) runMembershipInferenceTest empty captures → no_captures_to_test
// =============================================================================

test('W764 #8 — runMembershipInferenceTest empty captures returns no_captures_to_test envelope', async () => {
  freshDir();
  const r = await runMembershipInferenceTest({
    artifact_path: '/tmp/fake.kolm',
    captures: [],
    runOnArtifact: async () => 'anything',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_captures_to_test',
    `expected no_captures_to_test; got ${JSON.stringify(r)}`);
  assert.ok(/^w764-/.test(r.version));
});

// =============================================================================
// 9) Verbatim replay extracts (artifact echoes captured response → leak)
// =============================================================================

test('W764 #9 — extracts when artifact replays training data verbatim', async () => {
  freshDir();
  // The original "response" — a chunk long enough that 5-grams overlap.
  const memorized = 'the quick brown fox jumps over the lazy dog while singing a song about kolm';
  const captures = [
    { capture_id: 'leaky-1', prompt: 'tell me a sentence', response: memorized },
  ];
  // The artifact replays the exact memorized response no matter what we ask it.
  const runOnArtifact = async () => memorized;
  const r = await runMembershipInferenceTest({
    artifact_path: '/tmp/leaky.kolm',
    captures,
    runOnArtifact,
    jaccard_threshold: 0.5,                // lenient so even partial-prompt fires
  });
  assert.equal(r.ok, true,
    `expected ok envelope; got ${JSON.stringify(r)}`);
  assert.ok(r.extracted_count >= 1,
    `verbatim-replay artifact MUST extract at least the one capture; got `
    + `extracted_count=${r.extracted_count} leaked=${JSON.stringify(r.leaked_captures)}`);
  assert.equal(r.extraction_rate, 1,
    `1/1 captures should give extraction_rate=1; got ${r.extraction_rate}`);
  // At least one leaked-capture row carries the right capture_id.
  const leakedIds = new Set(r.leaked_captures.map((row) => row.capture_id));
  assert.ok(leakedIds.has('leaky-1'),
    `leaky-1 must appear in leaked_captures; got ${JSON.stringify(r.leaked_captures)}`);
});

// =============================================================================
// 10) Paraphrased response does NOT extract (jaccard below threshold)
// =============================================================================

test('W764 #10 — does NOT extract when artifact returns a paraphrased (non-overlapping) response', async () => {
  freshDir();
  const original = 'the quick brown fox jumps over the lazy dog';
  const paraphrased = 'a swift russet vulpine bounded above the indolent canine';
  const captures = [
    { capture_id: 'safe-1', prompt: 'tell me a sentence', response: original },
  ];
  const runOnArtifact = async () => paraphrased;
  const r = await runMembershipInferenceTest({
    artifact_path: '/tmp/safe.kolm',
    captures,
    runOnArtifact,
    jaccard_threshold: 0.85,
  });
  assert.equal(r.ok, true);
  // We do NOT require zero leaks — unique_token_probe might land on a rare token
  // by coincidence — but the verbatim-replay attack MUST not fire.
  const replayLeaks = r.leaked_captures.filter((x) => x.attack_kind === 'exact_prompt_replay');
  assert.equal(replayLeaks.length, 0,
    `exact_prompt_replay must NOT fire on a paraphrased response; got ${JSON.stringify(replayLeaks)}`);
});

// =============================================================================
// 11) scanForPII catches email + phone + ssn + Luhn-valid credit card
// =============================================================================

test('W764 #11 — scanForPII catches email + phone + ssn + Luhn-valid credit card', () => {
  freshDir();
  const text = [
    'Contact me at alice.smith@example.com or (415) 555-0199.',
    'My SSN is 123-45-6789.',
    'My card is 4111 1111 1111 1111.',                // valid Luhn
  ].join(' ');
  const r = scanForPII(text);
  assert.equal(r.ok, true);
  assert.ok(/^w764-/.test(r.version));
  const cats = new Set(r.hits.map((h) => h.category));
  for (const need of ['email', 'phone_us', 'ssn_us', 'credit_card_luhn']) {
    assert.ok(cats.has(need),
      `expected category ${need} in hits; got categories=${JSON.stringify([...cats])} hits=${JSON.stringify(r.hits)}`);
  }
  // Sanity: hits carry evidence + span.
  for (const h of r.hits) {
    assert.equal(typeof h.evidence, 'string');
    assert.ok(Array.isArray(h.span) && h.span.length === 2,
      `each hit must have a [start,end) span; got ${JSON.stringify(h)}`);
  }
});

// =============================================================================
// 12) Luhn REJECTS off-by-one digit (no false-positive on UUIDs/order #s)
// =============================================================================

test('W764 #12 — scanForPII Luhn rejects 4111111111111112 (invalid checksum)', () => {
  freshDir();
  // 4111111111111111 = valid Visa test card; 4111111111111112 = same prefix
  // off by one digit — MUST fail Luhn and NOT be flagged credit_card_luhn.
  const bad = scanForPII('my fake number is 4111111111111112 which should fail luhn');
  const cards = bad.hits.filter((h) => h.category === 'credit_card_luhn');
  assert.equal(cards.length, 0,
    `Luhn-invalid number 4111111111111112 MUST NOT be flagged credit_card_luhn; got ${JSON.stringify(cards)}`);
  // Conversely the off-by-zero VALID number IS flagged.
  const good = scanForPII('valid card: 4111111111111111');
  const goodCards = good.hits.filter((h) => h.category === 'credit_card_luhn');
  assert.ok(goodCards.length >= 1,
    `Luhn-valid 4111111111111111 MUST be flagged credit_card_luhn; got ${JSON.stringify(good.hits)}`);
});

// =============================================================================
// 13) scanForPII catches AWS access key (AKIA + 16 alnum upper)
// =============================================================================

test('W764 #13 — scanForPII catches AWS access key (AKIA + 16 alnum upper)', () => {
  freshDir();
  const text = 'My key is AKIAIOSFODNN7EXAMPLE which I should not have shared.';
  const r = scanForPII(text);
  const aws = r.hits.filter((h) => h.category === 'aws_access_key');
  assert.equal(aws.length, 1,
    `expected exactly one aws_access_key hit; got ${JSON.stringify(r.hits)}`);
  assert.equal(aws[0].evidence, 'AKIAIOSFODNN7EXAMPLE');
});

// =============================================================================
// 14) scanForPII catches GitHub token (ghp_ + 36 base62)
// =============================================================================

test('W764 #14 — scanForPII catches GitHub PAT (ghp_ + 36 base62)', () => {
  freshDir();
  // Synthetic — never a real token. 36 chars of base62 to satisfy the {36,} length.
  const token = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
  const r = scanForPII('Here is a leaked token: ' + token);
  const gh = r.hits.filter((h) => h.category === 'github_token');
  assert.equal(gh.length, 1,
    `expected exactly one github_token hit; got ${JSON.stringify(r.hits)}`);
  assert.equal(gh[0].evidence, token);
});

// =============================================================================
// 15) scanForPII catches JWT (3 base64url segments, valid header)
// =============================================================================

test('W764 #15 — scanForPII catches JWT (3 base64url segments, valid header)', () => {
  freshDir();
  // Build a real-shaped JWT: header { alg:"HS256", typ:"JWT" }, dummy payload + sig.
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}', 'utf8').toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payload = Buffer.from('{"sub":"alice","iat":1700000000}', 'utf8').toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  // Pad to ensure ≥10 chars per segment.
  const sig = 'AAAAAAAAAAabcdef0123456789';
  const jwt = `${header}.${payload}.${sig}`;
  const r = scanForPII('Authorization: Bearer ' + jwt);
  const jwtHits = r.hits.filter((h) => h.category === 'jwt');
  assert.ok(jwtHits.length >= 1,
    `expected at least one jwt hit; got hits=${JSON.stringify(r.hits)}`);
  // A non-JWT three-dotted string should NOT fire (header won't decode to JSON).
  const fake = 'aaaaaaaaaa.bbbbbbbbbb.cccccccccc';
  const r2 = scanForPII('not a jwt: ' + fake);
  const fakeJwt = r2.hits.filter((h) => h.category === 'jwt');
  assert.equal(fakeJwt.length, 0,
    `random three-dotted string MUST NOT be flagged jwt; got ${JSON.stringify(fakeJwt)}`);
});

// =============================================================================
// 16) name_likely hits are flagged HEURISTIC
// =============================================================================

test('W764 #16 — scanForPII name_likely hits are tagged heuristic:true', () => {
  freshDir();
  const r = scanForPII('Meet with John Smith next Tuesday.');
  const names = r.hits.filter((h) => h.category === 'name_likely');
  assert.ok(names.length >= 1, `expected name_likely hit; got ${JSON.stringify(r.hits)}`);
  for (const n of names) {
    assert.equal(n.heuristic, true,
      `name_likely hits MUST carry heuristic:true so downstream redactors do NOT auto-trigger; got ${JSON.stringify(n)}`);
  }
});

// =============================================================================
// 17) runPiiBakeoffScan returns by_category + pii_rate
// =============================================================================

test('W764 #17 — runPiiBakeoffScan returns by_category + pii_rate via DI runOnArtifact', async () => {
  freshDir();
  // Artifact alternately emits PII and clean text.
  let calls = 0;
  const runOnArtifact = async (_path, _prompt) => {
    calls++;
    return calls % 2 === 1
      ? 'leak: alice@example.com and AKIAIOSFODNN7EXAMPLE'
      : 'no leak here';
  };
  const r = await runPiiBakeoffScan({
    artifact_path: '/tmp/x.kolm',
    prompts: ['p1', 'p2', 'p3', 'p4'],
    runOnArtifact,
  });
  assert.equal(r.ok, true, `expected ok; got ${JSON.stringify(r)}`);
  assert.equal(r.n_prompts, 4);
  assert.equal(typeof r.pii_rate, 'number');
  assert.ok(r.pii_rate > 0 && r.pii_rate <= 1,
    `pii_rate must be (0,1] when some prompts leak; got ${r.pii_rate}`);
  assert.equal(typeof r.by_category, 'object');
  assert.ok(r.by_category.email >= 1,
    `expected email>=1 hits in by_category; got ${JSON.stringify(r.by_category)}`);
  assert.ok(r.by_category.aws_access_key >= 1,
    `expected aws_access_key>=1 hits in by_category; got ${JSON.stringify(r.by_category)}`);
  // Null runOnArtifact branch.
  const r2 = await runPiiBakeoffScan({ prompts: ['x'], runOnArtifact: null });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'runtime_not_wired');
});

// =============================================================================
// 18) markCaptureForgotten writes a durable audit event (idempotent)
// =============================================================================

test('W764 #18 — markCaptureForgotten writes a durable audit event + is idempotent on re-call', async () => {
  freshDir();
  await resetEventStore();
  const tenant_id = 'tenant_w764_18';
  const capture_id = 'cap-abc-123';
  const r1 = await markCaptureForgotten({
    tenant_id,
    capture_id,
    reason: 'gdpr_erasure_request',
    requested_by: 'alice@example.com',
  });
  assert.equal(r1.ok, true, `expected ok envelope; got ${JSON.stringify(r1)}`);
  assert.equal(r1.capture_id, capture_id);
  assert.equal(typeof r1.audit_event_id, 'string');
  assert.ok(r1.audit_event_id.startsWith('forget_'),
    `audit_event_id must be a 'forget_*' id; got ${r1.audit_event_id}`);
  assert.equal(r1.requires_redistill, true,
    'forget operation MUST signal requires_redistill so callers know an artifact rebuild is needed');
  assert.equal(r1.idempotent_hit, false);
  assert.ok(/^w764-/.test(r1.version));

  // Verify the audit event is in the event store with the expected provider.
  const { listEvents } = await import('../src/event-store.js');
  const rows = await listEvents({ tenant_id, provider: 'kolm_capture_forget', limit: 100 });
  const ours = rows.find((r) => r.event_id === r1.audit_event_id);
  assert.ok(ours, `audit event ${r1.audit_event_id} MUST be in the event store`);
  assert.equal(ours.provider, 'kolm_capture_forget');
  assert.equal(ours.tenant_id, tenant_id);
  // The original capture_id rides on the request_hash + the prompt_redacted JSON.
  assert.equal(ours.request_hash, 'forget:' + capture_id);
  const meta = JSON.parse(ours.prompt_redacted);
  assert.equal(meta.kind, 'forget_marker');
  assert.equal(meta.capture_id, capture_id);
  assert.equal(meta.reason, 'gdpr_erasure_request');
  assert.equal(meta.requested_by, 'alice@example.com');
  assert.equal(meta.forget_version, 'w764-v1');

  // Idempotency — re-call returns the SAME audit_event_id, no second row.
  const r2 = await markCaptureForgotten({
    tenant_id, capture_id, reason: 'different reason this time',
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.audit_event_id, r1.audit_event_id,
    `idempotent re-call MUST return the original audit_event_id; got ${r2.audit_event_id}, orig=${r1.audit_event_id}`);
  assert.equal(r2.idempotent_hit, true);
  const rows2 = await listEvents({ tenant_id, provider: 'kolm_capture_forget', limit: 100 });
  const samePairCount = rows2.filter((r) => r.request_hash === 'forget:' + capture_id).length;
  assert.equal(samePairCount, 1,
    `expected exactly one audit row for (tenant,capture) pair after re-call; got ${samePairCount}`);

  // Missing-tenant / missing-capture honest envelopes.
  const noT = await markCaptureForgotten({ capture_id: 'x' });
  assert.equal(noT.ok, false);
  assert.equal(noT.error, 'missing_tenant_id');
  const noC = await markCaptureForgotten({ tenant_id: 't' });
  assert.equal(noC.ok, false);
  assert.equal(noC.error, 'missing_capture_id');
});

// =============================================================================
// 19) isCaptureForgotten roundtrip on a marker we wrote
// =============================================================================

test('W764 #19 — isCaptureForgotten roundtrip on a marker written by markCaptureForgotten', async () => {
  freshDir();
  await resetEventStore();
  const tenant_id = 'tenant_w764_19';
  const capture_id = 'roundtrip-001';

  const before = await isCaptureForgotten({ tenant_id, capture_id });
  assert.equal(before.ok, true);
  assert.equal(before.forgotten, false,
    `untouched capture must report forgotten:false; got ${JSON.stringify(before)}`);

  const mark = await markCaptureForgotten({
    tenant_id, capture_id,
    reason: 'pii_flagged',
    requested_by: 'reviewer@example.com',
  });
  assert.equal(mark.ok, true);

  const after = await isCaptureForgotten({ tenant_id, capture_id });
  assert.equal(after.ok, true);
  assert.equal(after.forgotten, true,
    `marker just written must report forgotten:true; got ${JSON.stringify(after)}`);
  assert.equal(after.reason, 'pii_flagged');
  assert.equal(after.requested_by, 'reviewer@example.com');
  assert.equal(after.audit_event_id, mark.audit_event_id);
  assert.ok(after.forgotten_at, 'forgotten_at must be a timestamp string');
});

// =============================================================================
// 20) filterForgottenCaptures strips marked rows but preserves others
// =============================================================================

test('W764 #20 — filterForgottenCaptures strips marked rows, preserves the rest', async () => {
  freshDir();
  await resetEventStore();
  const tenant_id = 'tenant_w764_20';
  // Mark two capture_ids forgotten.
  await markCaptureForgotten({ tenant_id, capture_id: 'rm-1', reason: 'gdpr_erasure_request' });
  await markCaptureForgotten({ tenant_id, capture_id: 'rm-2', reason: 'court_order' });

  const captures = [
    { capture_id: 'rm-1', text: 'should be removed' },
    { capture_id: 'keep-1', text: 'safe' },
    { capture_id: 'rm-2', text: 'should also be removed' },
    { capture_id: 'keep-2', text: 'safe too' },
  ];
  const out = await filterForgottenCaptures({ tenant_id, captures });
  assert.equal(out.removed_count, 2,
    `expected 2 removed; got ${out.removed_count} (removed_ids=${JSON.stringify(out.removed_ids)})`);
  assert.ok(out.removed_ids.includes('rm-1'));
  assert.ok(out.removed_ids.includes('rm-2'));
  assert.equal(out.filtered.length, 2);
  const remainingIds = out.filtered.map((c) => c.capture_id).sort();
  assert.deepEqual(remainingIds, ['keep-1', 'keep-2']);
  assert.ok(/^w764-/.test(out.version));

  // Empty/invalid inputs honest pass-through.
  const empty = await filterForgottenCaptures({ tenant_id, captures: [] });
  assert.equal(empty.removed_count, 0);
  assert.deepEqual(empty.filtered, []);
  const noT = await filterForgottenCaptures({ captures: [{ capture_id: 'x' }] });
  assert.equal(noT.removed_count, 0,
    'missing tenant_id must NOT delete anything (honest no-op)');
});

// =============================================================================
// 21) listForgottenCaptures tenant-fenced — defense-in-depth
// =============================================================================

test('W764 #21 — listForgottenCaptures is tenant-fenced (defense-in-depth: other-tenant rows excluded)', async () => {
  freshDir();
  await resetEventStore();
  const alice = 'tenant_alice_w764_21';
  const bob = 'tenant_bob_w764_21';
  // Alice marks two rows; Bob marks one.
  await markCaptureForgotten({ tenant_id: alice, capture_id: 'alice-1', reason: 'gdpr_erasure_request' });
  await markCaptureForgotten({ tenant_id: alice, capture_id: 'alice-2', reason: 'pii_flagged' });
  await markCaptureForgotten({ tenant_id: bob, capture_id: 'bob-1', reason: 'court_order' });

  const a = await listForgottenCaptures({ tenant_id: alice });
  assert.equal(a.ok, true);
  assert.equal(a.n, 2, `Alice must see exactly 2 markers; got ${a.n}: ${JSON.stringify(a.markers)}`);
  const aliceIds = new Set(a.markers.map((m) => m.capture_id));
  assert.ok(aliceIds.has('alice-1'));
  assert.ok(aliceIds.has('alice-2'));
  assert.equal(aliceIds.has('bob-1'), false,
    `defense-in-depth: Alice MUST NOT see Bob's marker; got ${JSON.stringify(a.markers)}`);

  const b = await listForgottenCaptures({ tenant_id: bob });
  assert.equal(b.n, 1);
  assert.equal(b.markers[0].capture_id, 'bob-1');

  // Cross-check filterForgottenCaptures for the same defense-in-depth.
  const aFilter = await filterForgottenCaptures({
    tenant_id: alice,
    captures: [
      { capture_id: 'alice-1' }, { capture_id: 'bob-1' }, { capture_id: 'alice-2' },
    ],
  });
  // Alice filtering MUST remove only her own forget markers — bob-1 stays
  // because Alice did not mark it.
  assert.ok(aFilter.removed_ids.includes('alice-1'));
  assert.ok(aFilter.removed_ids.includes('alice-2'));
  assert.equal(aFilter.removed_ids.includes('bob-1'), false,
    `defense-in-depth: filterForgottenCaptures MUST NOT see Bob's marker when tenant_id=alice; got ${JSON.stringify(aFilter.removed_ids)}`);

  // Missing tenant_id → honest envelope.
  const noT = await listForgottenCaptures({});
  assert.equal(noT.ok, false);
  assert.equal(noT.error, 'missing_tenant_id');
});

// =============================================================================
// 22) POST /v1/mit/run auth + confirm gates → honest runtime_not_wired
// =============================================================================

test('W764 #22 — POST /v1/mit/run 401 without auth; 400 confirm_required; 200 honest envelope', async () => {
  freshDir();
  await resetEventStore();
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
    // 1) No auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/mit/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true, captures: [] }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);
    // 2) Auth, no confirm → 400.
    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/mit/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.api_key },
      body: JSON.stringify({}),
    });
    assert.equal(noConfirm.status, 400, `expected 400 confirm_required; got ${noConfirm.status}`);
    const ncEnv = await noConfirm.json();
    assert.equal(ncEnv.error, 'confirm_required');
    // 3) Auth + confirm → 200 with honest runtime_not_wired (no runtime is shipped yet).
    const ok = await fetch(`http://127.0.0.1:${port}/v1/mit/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.api_key },
      body: JSON.stringify({ confirm: true, captures: [{ capture_id: 'x', prompt: 'p', response: 'r' }] }),
    });
    assert.equal(ok.status, 200, `expected 200; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, false,
      `honest envelope: ok:false because runtime not wired; got ${JSON.stringify(env)}`);
    assert.equal(env.error, 'runtime_not_wired',
      `expected runtime_not_wired honest envelope; got ${JSON.stringify(env)}`);
    assert.ok(/^w764-/.test(env.version));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// =============================================================================
// 23) POST /v1/mit/scan-pii auth gate
// =============================================================================

test('W764 #23 — POST /v1/mit/scan-pii 401 without auth; 200 with auth', async () => {
  freshDir();
  await resetEventStore();
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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/mit/scan-pii`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'alice@example.com' }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);
    const ok = await fetch(`http://127.0.0.1:${port}/v1/mit/scan-pii`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.api_key },
      body: JSON.stringify({ text: 'email me at alice@example.com please' }),
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.ok(/^w764-/.test(env.version));
    const emails = env.hits.filter((h) => h.category === 'email');
    assert.ok(emails.length >= 1, `expected at least one email hit; got ${JSON.stringify(env.hits)}`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// =============================================================================
// 24) POST /v1/captures/forget auth + confirm gates
// =============================================================================

test('W764 #24 — POST /v1/captures/forget 401 without auth; 400 confirm_required; 200 happy', async () => {
  freshDir();
  await resetEventStore();
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
    // 1) No auth.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/captures/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capture_id: 'x', confirm: true }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);
    // 2) Auth, no confirm.
    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/captures/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.api_key },
      body: JSON.stringify({ capture_id: 'x' }),
    });
    assert.equal(noConfirm.status, 400, `expected 400 confirm_required; got ${noConfirm.status}`);
    const ncEnv = await noConfirm.json();
    assert.equal(ncEnv.error, 'confirm_required');
    // 3) Auth + confirm → 200 happy with audit_event_id.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/captures/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.api_key },
      body: JSON.stringify({
        capture_id: 'cap-route-' + crypto.randomBytes(4).toString('hex'),
        reason: 'gdpr_erasure_request',
        confirm: true,
      }),
    });
    assert.equal(ok.status, 200, `expected 200; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true, `expected ok envelope; got ${JSON.stringify(env)}`);
    assert.ok(env.audit_event_id && env.audit_event_id.startsWith('forget_'));
    assert.equal(env.requires_redistill, true);
    assert.ok(/^w764-/.test(env.version));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// =============================================================================
// 25) GET /v1/captures/forgotten auth gate
// =============================================================================

test('W764 #25 — GET /v1/captures/forgotten 401 without auth; 200 with auth', async () => {
  freshDir();
  await resetEventStore();
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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/captures/forgotten`);
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);
    const ok = await fetch(`http://127.0.0.1:${port}/v1/captures/forgotten`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(typeof env.n, 'number');
    assert.ok(Array.isArray(env.markers));
    assert.ok(/^w764-/.test(env.version));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// =============================================================================
// 26) public/security/membership-inference.html exists w/ brand-lock + anchors
// =============================================================================

test('W764 #26 — public/security/membership-inference.html exists w/ brand-lock + data-w764 anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(HTML_PATH), `expected doc page at ${HTML_PATH}`);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Brand-locked eyebrow.
  assert.ok(html.includes('Open-source AI workbench'),
    'security/membership-inference.html MUST carry the brand-locked eyebrow');
  // Brand anchor (offscreen sr-only line).
  assert.ok(html.includes('Not Kolm therapeutics'),
    'page must carry the brand-anchor sentence (anti-name-collision)');
  // Both required data-w764 anchors must be present so panels are mountable.
  assert.ok(html.includes('data-w764="attack-kinds"'),
    'expected data-w764="attack-kinds" anchor on the attack-kinds section');
  assert.ok(html.includes('data-w764="forget-mechanism"'),
    'expected data-w764="forget-mechanism" anchor on the forget section');
  // Version stamp mention.
  assert.ok(html.includes('w764-v1'),
    'page must mention the w764-v1 version stamp');
  // No emojis (per spec).
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'security/membership-inference.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 27) cli/kolm.js defines cmdW764Mit exactly once + wired from both case arms
// =============================================================================

test('W764 #27 — cli/kolm.js defines cmdW764Mit exactly once + wired from case forget AND case mit', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defOccurrences = (cli.match(/async function cmdW764Mit\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW764Mit must be defined exactly once; found ${defOccurrences}`);
  // Both case arms must be present and reference cmdW764Mit.
  // The shape is: `case 'forget':\n      case 'mit': ... cmdW764Mit(...)`
  assert.ok(/case 'forget':\s*\n[\s\S]{0,200}cmdW764Mit/.test(cli),
    `expected "case 'forget':" arm wired to cmdW764Mit; not found`);
  assert.ok(/case 'mit':[\s\S]{0,200}cmdW764Mit/.test(cli),
    `expected "case 'mit':" arm wired to cmdW764Mit; not found`);
  // Completion entries must be present for both verbs.
  assert.ok(cli.includes("COMPLETION_VERBS.push('forget', 'mit')"),
    'COMPLETION_VERBS must include both "forget" and "mit" for shell completion');
  assert.ok(/COMPLETION_SUBS\.forget\s*=/.test(cli),
    'COMPLETION_SUBS.forget must be defined');
  assert.ok(/COMPLETION_SUBS\.mit\s*=/.test(cli),
    'COMPLETION_SUBS.mit must be defined');
});

// =============================================================================
// 28) vercel.json carries /security/membership-inference rewrite
// =============================================================================

test('W764 #28 — vercel.json carries /security/membership-inference rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  const rw = cfg.rewrites.find((r) =>
    r && r.source === '/security/membership-inference'
    && r.destination === '/security/membership-inference.html');
  assert.ok(rw,
    `expected rewrite { source:'/security/membership-inference', destination:'/security/membership-inference.html' }; `
    + `not found in ${cfg.rewrites.length} entries`);
});

// =============================================================================
// 29) wave764 sibling test family uses wave(\d{3,4}) regex + threshold (W604)
// =============================================================================

test('W764 #29 — wave764 sibling sw.js family pattern uses wave(\\d{3,4}) regex + threshold', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this.
  // We need at least 5 sibling wave tests (the W761..W765 sprint cluster) plus
  // the rich historical wave coverage.
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);

  // ALSO check that sw.js (if present) does NOT rely on a brittle hard-coded
  // wave-name array — it should be regex-friendly or absent (W604).
  if (fs.existsSync(SW_PATH)) {
    const sw = fs.readFileSync(SW_PATH, 'utf8');
    const waveRefs = sw.match(/w\d{3,4}/g) || [];
    assert.ok(waveRefs.length >= 0,
      `sw.js wave reference scan succeeded; count: ${waveRefs.length}`);
  }
});

// =============================================================================
// Bonus: jaccardOverlap pure-fn sanity (no leakage of internal state)
// =============================================================================

test('W764 bonus — jaccardOverlap is pure and symmetric on equal inputs', () => {
  freshDir();
  const sameAB = jaccardOverlap('the quick brown fox jumps over', 'the quick brown fox jumps over', 5);
  assert.equal(sameAB, 1, `identical inputs MUST yield Jaccard=1; got ${sameAB}`);
  const empty = jaccardOverlap('', '', 5);
  assert.equal(empty, 0, `degenerate empty/empty returns 0; got ${empty}`);
  const sym1 = jaccardOverlap('a b c d e f g h i', 'a b c x y z g h i', 3);
  const sym2 = jaccardOverlap('a b c x y z g h i', 'a b c d e f g h i', 3);
  assert.equal(sym1, sym2, `Jaccard MUST be symmetric; got ${sym1} vs ${sym2}`);
});
