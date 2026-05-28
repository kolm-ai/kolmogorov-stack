// Smoke test for src/data-curate.js (CURATE stage).
//
// Isolates state into a temp KOLM_DATA_DIR so it never touches the real
// ~/.kolm store, builds a small corpus exercising every pipeline stage, and
// asserts the six contract behaviors. Prints "N passed, M failed" and exits
// nonzero on any failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate state BEFORE importing the module (event-store reads KOLM_DATA_DIR
// lazily, but set it first so nothing can leak to the real home).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-curate-smoke-'));
process.env.KOLM_DATA_DIR = TMP;

const { curatePairs, flagCot, flagPii, redactPii, CURATE_VERSION } = await import('../src/data-curate.js');

let passed = 0;
let failed = 0;
const skips = [];

function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function skip(name, why) {
  skips.push(name);
  console.log(`  SKIP  ${name} — ${why}`);
}

// Assertion #2 (dedup) is gated on res.report.dedup === 'ok'; when the python
// dedup script degrades, that assertion becomes a documented SKIP.

// ── corpus ──────────────────────────────────────────────────────────────────
// 3 good, 1 garbage (empty output), 2 near-dups (same output + trivial edit),
// 1 CoT-leaked, 1 with a fake email + phone in the output.
const NEAR_DUP_OUTPUT = 'To reset your password, open Settings, choose Security, then click Reset Password and follow the emailed link.';

const corpus = [
  { input: 'How do I cancel my subscription?', output: 'Open Billing, select your plan, and click Cancel Subscription. Your access continues until the end of the current period.' },
  { input: 'Where can I download my invoices?', output: 'Go to Billing then Invoices. Each invoice has a Download PDF button on the right side of the row.' },
  { input: 'How do I add a teammate?', output: 'Open Settings, then Members, click Invite, and enter their work email address to send an invitation.' },
  { input: 'garbage row', output: '' }, // very-low-quality: empty output
  { input: 'How do I reset my password?', output: NEAR_DUP_OUTPUT }, // near-dup A
  { input: 'How do I reset my password again?', output: NEAR_DUP_OUTPUT + ' Thanks!' }, // near-dup B (trivial edit)
  { input: 'Plan a trip to Paris', output: '<think>The user wants a travel plan. Let me consider budget and dates first.</think> Here is a 3-day Paris itinerary: day one the Louvre, day two Versailles, day three Montmartre.' }, // CoT leak
  { input: 'How do I contact support?', output: 'Email us at support@example.com or call 415-555-0199 and our team will help you within one business day.' }, // PII
];

const res = await curatePairs({
  namespace: 'smoke',
  pairs: corpus,
  opts: { quality: true, minQuality: 0.35, dedup: true, dedupThreshold: 0.92, cluster: true, pii: true, cot: true },
});

console.log('\ncuratePairs envelope:');
console.log(JSON.stringify({ ok: res.ok, version: res.version, n_in: res.n_in, n_kept: res.n_kept, n_removed: res.n_removed, report: res.report, persist: res.persist }, null, 2));
console.log('');

// Envelope sanity.
ok('envelope ok:true + version', res.ok === true && res.version === CURATE_VERSION && CURATE_VERSION === 'curate-v1', `ok=${res.ok} version=${res.version}`);

// Read back what was written so we assert on the persisted artifact, not just
// the in-memory return.
const outFile = res.out_path;
const survivors = fs.readFileSync(outFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

// 1. quality filter drops the garbage (empty-output) pair.
ok('1. quality filter drops garbage pair', res.report.quality_filtered >= 1, `quality_filtered=${res.report.quality_filtered}`);
const garbageGone = !survivors.some((p) => p.input === 'garbage row');
ok('1b. garbage pair absent from survivors', garbageGone);

// 2. dedup removes 1 of the 2 near-dups (SKIP if python/dedup unavailable).
if (res.report.dedup === 'ok') {
  ok('2. dedup removed >=1 near-dup', res.report.deduped >= 1, `deduped=${res.report.deduped}`);
} else {
  skip('2. dedup removed >=1 near-dup', `dedup degraded (${res.report.dedup})`);
}

// 3. cot flag drops the CoT pair + pure-helper behavior.
// In the full run the CoT pair is so low-quality (hard <think> tag) that the
// quality gate (stage a) removes it before the cot gate (stage d) — verify it
// is gone either way. To exercise stage (d) directly we re-run with quality
// off, isolating the cot stage.
const cotGoneFull = !survivors.some((p) => String(p.output || '').includes('<think>'));
ok('3. CoT pair absent from full-run survivors', cotGoneFull);

const cotRes = await curatePairs({
  namespace: 'smoke_cot',
  pairs: [
    { input: 'good one', output: 'Open Settings and click Save. Your changes are stored immediately and sync across devices.' },
    { input: 'cot one', output: '<think>let me reason about this</think> The capital of France is Paris.' },
  ],
  opts: { quality: false, dedup: false, cluster: true, pii: false, cot: true },
});
ok('3b. cot stage flags the CoT pair (cot_flagged >= 1)', cotRes.report.cot_flagged >= 1, `cot_flagged=${cotRes.report.cot_flagged}`);
ok('3c. cot stage keeps the clean pair (n_kept === 1)', cotRes.n_kept === 1, `n_kept=${cotRes.n_kept}`);
ok("3d. flagCot('<think>x</think> y') === true", flagCot('<think>x</think> y') === true);
ok("3e. flagCot('plain answer') === false", flagCot('plain answer') === false);

// 4. pii redaction: pair survives, raw email gone, pii_redacted >= 1.
ok('4. pii_redacted >= 1', res.report.pii_redacted >= 1, `pii_redacted=${res.report.pii_redacted}`);
const piiPair = survivors.find((p) => String(p.input || '').includes('contact support'));
ok('4b. PII pair survived (not dropped)', !!piiPair, 'pii pair missing from survivors');
if (piiPair) {
  ok('4c. raw email scrubbed from output', !String(piiPair.output).includes('support@example.com'), piiPair.output);
  ok('4d. raw phone scrubbed from output', !String(piiPair.output).includes('415-555-0199'), piiPair.output);
}
// Pure-helper checks for flagPii / redactPii.
ok('4e. flagPii detects email', flagPii('reach me at a@b.com') === true);
ok('4f. flagPii false on clean text', flagPii('no contact info here') === false);
ok('4g. redactPii replaces with [REDACTED]', redactPii('mail a@b.com now').includes('[REDACTED]') && !redactPii('mail a@b.com now').includes('a@b.com'));

// 5. report.clusters >= 1 and coverage is an object.
ok('5. report.clusters >= 1', res.report.clusters >= 1, `clusters=${res.report.clusters}`);
ok('5b. coverage is an object', res.report.coverage && typeof res.report.coverage === 'object' && !Array.isArray(res.report.coverage));
const coverageSum = Object.values(res.report.coverage || {}).reduce((a, b) => a + b, 0);
ok('5c. coverage counts sum to survivor count', coverageSum === res.n_kept, `coverageSum=${coverageSum} n_kept=${res.n_kept}`);

// 6. n_kept + n_removed accounting is internally consistent.
ok('6. n_in === n_kept + n_removed', res.n_in === res.n_kept + res.n_removed, `n_in=${res.n_in} n_kept=${res.n_kept} n_removed=${res.n_removed}`);
ok('6b. survivors file length === n_kept', survivors.length === res.n_kept, `file=${survivors.length} n_kept=${res.n_kept}`);
ok('6c. n_in matches input corpus size', res.n_in === corpus.length, `n_in=${res.n_in} corpus=${corpus.length}`);

// Cleanup the temp dir (best-effort).
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best-effort */ }

console.log(`\n${passed} passed, ${failed} failed${skips.length ? ` (${skips.length} skipped)` : ''}`);
process.exit(failed > 0 ? 1 : 0);
