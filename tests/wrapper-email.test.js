// LM-8 (V1 launch 2026-05-26) — transactional-email surface lock-in.
//
// Pins the launch-day contract for src/email.js + cli/kolm.js so a rename,
// signature change, or template regression trips here before V1 customers
// hit the queue. No router boot, no real network — every test either calls
// the pure templates or exercises the local-outbox fallback path.
//
//   #1 sendEmail() returns queued:true when RESEND_API_KEY is unset
//   #2 tEmailSignup, tEmailCompileDone, tEmailUsageAlert all return
//      {subject, html, text} with non-empty fields
//   #3 cmdEmailOutbox is registered in cli/kolm.js (source grep — proves
//      the CLI dispatcher branch exists)
//   #4 usage-alert template surfaces the threshold + cap + used numbers
//   #5 signup template includes a CTA to /account/overview
//   #6 sendEmail emits the right `tag` field in the queued envelope

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Run the outbox-touching tests from a fresh cwd so we don't smear the
// real data/email-outbox.jsonl with test rows. The email module resolves
// the outbox path off process.cwd() at module load — switch BEFORE the
// import. Restored at process exit so the rest of node:test's machinery
// doesn't trip over the temp dir if it lingers.
const _origCwd = process.cwd();
const _tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wrapper-email-'));
fs.mkdirSync(path.join(_tmpCwd, 'data'), { recursive: true });
process.chdir(_tmpCwd);
process.on('exit', () => {
  try { process.chdir(_origCwd); } catch (_) {}
  try { fs.rmSync(_tmpCwd, { recursive: true, force: true }); } catch (_) {}
});

// Force the no-key branch for the duration of this file. Save + restore so
// a developer running the suite with a real key in their env doesn't burn
// Resend quota on a unit test.
const _origKey = process.env.RESEND_API_KEY;
delete process.env.RESEND_API_KEY;
process.on('exit', () => {
  if (_origKey !== undefined) process.env.RESEND_API_KEY = _origKey;
});

const emailMod = await import('../src/email.js');
const { sendEmail, tEmailSignup, tEmailCompileDone, tEmailUsageAlert, emailOutboxPath } = emailMod;

const OUTBOX_PATH = emailOutboxPath();

// ---------------------------------------------------------------------------
// #1 sendEmail returns queued:true when RESEND_API_KEY is unset
// ---------------------------------------------------------------------------
test('LM-8 #1: sendEmail returns queued:true when RESEND_API_KEY is unset', async () => {
  // Pre-condition: the key is unset (we deleted it at file load).
  assert.equal(process.env.RESEND_API_KEY, undefined, 'test fixture must delete RESEND_API_KEY');
  const r = await sendEmail({
    to: 'queued-fallback@example.com',
    subject: 'queued-fallback subject',
    text: 'queued-fallback body',
    tag: 'queued_test',
  });
  assert.equal(r.ok, true, 'sendEmail must always return ok:true (never throws)');
  assert.equal(r.delivered, false, 'no Resend key -> not delivered');
  assert.equal(r.queued, true, 'no Resend key -> must queue to data/email-outbox.jsonl');
});

// ---------------------------------------------------------------------------
// #2 templates all return {subject, html, text} with non-empty fields
// ---------------------------------------------------------------------------
test('LM-8 #2: tEmailSignup / tEmailCompileDone / tEmailUsageAlert return {subject, html, text} non-empty', () => {
  const s = tEmailSignup({ email: 'alice@example.com', tenant_id: 'tenant_lm8_signup', plan_tier: 'free' });
  for (const k of ['subject', 'html', 'text']) {
    assert.equal(typeof s[k], 'string', `tEmailSignup.${k} must be a string`);
    assert.ok(s[k].length > 0, `tEmailSignup.${k} must be non-empty`);
  }
  const c = tEmailCompileDone({
    email: 'alice@example.com', tenant_id: 'tenant_lm8_compile',
    artifact_id: 'art_test_001', status: 'success', k_score: 0.93, duration_s: 12.4,
  });
  for (const k of ['subject', 'html', 'text']) {
    assert.equal(typeof c[k], 'string', `tEmailCompileDone.${k} must be a string`);
    assert.ok(c[k].length > 0, `tEmailCompileDone.${k} must be non-empty`);
  }
  const u = tEmailUsageAlert({
    email: 'alice@example.com', tenant_id: 'tenant_lm8_usage',
    threshold: 80, used: 800, cap: 1000, plan_tier: 'free',
  });
  for (const k of ['subject', 'html', 'text']) {
    assert.equal(typeof u[k], 'string', `tEmailUsageAlert.${k} must be a string`);
    assert.ok(u[k].length > 0, `tEmailUsageAlert.${k} must be non-empty`);
  }
});

// ---------------------------------------------------------------------------
// #3 cmdEmailOutbox is registered in cli/kolm.js
// ---------------------------------------------------------------------------
test('LM-8 #3: cmdEmailOutbox is registered in cli/kolm.js', () => {
  const cliSrc = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.ok(
    /async\s+function\s+cmdEmailOutbox\s*\(/.test(cliSrc),
    'cli/kolm.js must define async function cmdEmailOutbox(...)',
  );
  // Dispatcher must invoke it from a verb case so the CLI actually reaches it.
  assert.ok(
    /cmdEmailOutbox\s*\(/.test(cliSrc),
    'cli/kolm.js must invoke cmdEmailOutbox from a verb branch',
  );
  // The `email` verb branch must be present in the switch dispatcher.
  assert.ok(
    /case\s+['"]email['"]/.test(cliSrc),
    'cli/kolm.js must register a case for the `email` top-level verb',
  );
});

// ---------------------------------------------------------------------------
// #4 usage-alert template surfaces threshold + cap + used numbers
// ---------------------------------------------------------------------------
test('LM-8 #4: tEmailUsageAlert surfaces threshold + cap + used numbers', () => {
  const u80 = tEmailUsageAlert({
    email: 'alice@example.com', tenant_id: 'tenant_lm8_th80',
    threshold: 80, used: 1234, cap: 5000, plan_tier: 'free',
  });
  // Numbers must appear in the rendered text. Be lenient about formatting
  // (Number.toLocaleString may insert thousand separators) so we check the
  // un-separated form AND the toLocaleString form.
  const hasUsed = u80.text.includes('1234') || u80.text.includes((1234).toLocaleString());
  const hasCap  = u80.text.includes('5000') || u80.text.includes((5000).toLocaleString());
  assert.ok(hasUsed, 'usage-alert text must include the `used` count');
  assert.ok(hasCap,  'usage-alert text must include the `cap` count');
  assert.ok(/80\s*%|80%|80/.test(u80.text), 'usage-alert text must reference the 80% threshold');

  // 100% template must explicitly call out the cap-reached state.
  const u100 = tEmailUsageAlert({
    email: 'alice@example.com', tenant_id: 'tenant_lm8_th100',
    threshold: 100, used: 5000, cap: 5000, plan_tier: 'free',
  });
  assert.ok(/100/.test(u100.text), 'usage-alert text must reference 100% at the cap');
  // Non-enterprise tier must include a /pricing CTA.
  assert.ok(/\/pricing/.test(u100.text) || /\/pricing/.test(u100.html),
    'non-enterprise usage alert must include /pricing CTA');

  // Enterprise tier must NOT advertise /pricing (bespoke billing).
  const uEnt = tEmailUsageAlert({
    email: 'ops@example.com', tenant_id: 'tenant_lm8_ent',
    threshold: 100, used: 100000, cap: 100000, plan_tier: 'enterprise',
  });
  assert.ok(!/\/pricing/.test(uEnt.text), 'enterprise usage alert must not link /pricing');
});

// ---------------------------------------------------------------------------
// #5 signup template includes a CTA to /account/overview
// ---------------------------------------------------------------------------
test('LM-8 #5: tEmailSignup includes a CTA to /account/overview', () => {
  const s = tEmailSignup({ email: 'alice@example.com', tenant_id: 'tenant_lm8_s5', plan_tier: 'free' });
  assert.ok(s.text.includes('/account/overview'), 'signup text must include /account/overview');
  assert.ok(s.html.includes('/account/overview'), 'signup html must include /account/overview');
});

// ---------------------------------------------------------------------------
// #6 sendEmail emits the right tag field in the queued envelope
// ---------------------------------------------------------------------------
test('LM-8 #6: sendEmail writes the tag field into the queued outbox envelope', async () => {
  // Snapshot pre-state so we can isolate the row we just wrote.
  const before = fs.existsSync(OUTBOX_PATH) ? fs.readFileSync(OUTBOX_PATH, 'utf8') : '';
  const r = await sendEmail({
    to: 'tag-test@example.com',
    subject: 'tag-test subject',
    text: 'tag-test body',
    tag: 'lm8_tag_lockin',
  });
  assert.equal(r.queued, true, 'precondition: sendEmail must queue when RESEND_API_KEY is unset');

  const after = fs.readFileSync(OUTBOX_PATH, 'utf8');
  assert.ok(after.length > before.length, 'outbox file must have grown after sendEmail()');
  const newRows = after.slice(before.length).trim().split(/\r?\n/).filter(Boolean);
  assert.ok(newRows.length >= 1, 'at least one new envelope row must be appended');
  const env = JSON.parse(newRows[newRows.length - 1]);
  assert.equal(env.tag, 'lm8_tag_lockin', 'queued envelope.tag must match the sendEmail() tag arg');
  assert.equal(env.subject, 'tag-test subject', 'queued envelope.subject must match');
  assert.equal(env.to, 'tag-test@example.com', 'queued envelope.to must match');
  assert.equal(typeof env.ts, 'string', 'queued envelope must carry an ISO ts');
});
