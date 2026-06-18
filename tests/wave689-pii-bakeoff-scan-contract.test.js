// W689 - direct contract/security test for src/pii-bakeoff-scan.js.
//
// The bakeoff scanner evaluates model output for leaked personal data and
// credentials. Its public envelopes must be privacy-safe, bounded, and
// digest-backed while preserving the W764 detector honesty contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PII_SCAN_LIMITS,
  PII_SCAN_VERSION,
  runPiiBakeoffScan,
  scanForPII,
} from '../src/pii-bakeoff-scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function hasRawLeak(value, needles) {
  const text = JSON.stringify(value);
  return needles.some((needle) => text.includes(needle));
}

test('W689 PII bakeoff scan static wiring pins version, bounds, and depth verifier', () => {
  const source = fs.readFileSync(path.join(REPO, 'src', 'pii-bakeoff-scan.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(PII_SCAN_VERSION, 'w764-v2');
  assert.match(source, /MAX_SCAN_CHARS:\s*64_000/);
  assert.match(source, /scan_manifest_sha256/);
  assert.match(source, /redacted_response/);
  assert.match(pkg.scripts['verify:pii-bakeoff-scan'], /wave689-pii-bakeoff-scan-contract\.test\.js/);
  assert.match(pkg.scripts['verify:depth'], /verify:pii-bakeoff-scan/);
});

test('W689 scanForPII keeps Luhn strict and redacts all returned evidence', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const raw = [
    'Alice Carter can be reached at alice@example.com.',
    'Valid test card 4111111111111111, invalid card 4111111111111112.',
    'SSN 123-45-6789 and AWS key AKIA1234567890ABCDEF.',
    `JWT ${jwt}`,
  ].join(' ');
  const scan = scanForPII(raw);
  const categories = scan.hits.map((h) => h.category);

  assert.equal(scan.ok, true);
  assert.match(scan.scan_manifest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(scan.by_category.credit_card_luhn, 1, 'only the Luhn-valid card is counted');
  assert.ok(categories.includes('email'));
  assert.ok(categories.includes('ssn_us'));
  assert.ok(categories.includes('aws_access_key'));
  assert.ok(categories.includes('jwt'));
  assert.ok(categories.includes('name_likely'));
  assert.equal(scan.hits.find((h) => h.category === 'name_likely').heuristic, true);
  assert.equal(scan.hits.every((h) => h.evidence_redacted === true), true);
  assert.equal(scan.hits.every((h) => /^\[REDACTED_[A-Z0-9_]+_[a-f0-9]{12}_LEN_\d+\]$/.test(h.evidence)), true);
  assert.equal(hasRawLeak(scan, [
    'Alice Carter',
    'alice@example.com',
    '4111111111111111',
    '4111111111111112',
    '123-45-6789',
    'AKIA1234567890ABCDEF',
    jwt,
  ]), false);
});

test('W689 scanForPII caps hostile text deterministically', () => {
  const long = Array.from({ length: 5000 }, (_, i) => `person${i}@example.com`).join(' ');
  const scan = scanForPII(long);
  assert.equal(scan.input_chars, long.length);
  assert.equal(scan.input_truncated, true);
  assert.ok(scan.hits.length <= PII_SCAN_LIMITS.MAX_HITS);
  assert.equal(scan.by_category.email, scan.hits.filter((h) => h.category === 'email').length);
});

test('W689 runPiiBakeoffScan returns redacted digest-backed leakage envelopes', async () => {
  const out = await runPiiBakeoffScan({
    artifact_path: 'local-artifact.kolm',
    prompts: [
      'prompt with prompt-only PII prompt_person@example.com',
      'throw-runtime',
      'plain prompt',
    ],
    runOnArtifact: async (_artifact, prompt) => {
      if (prompt === 'throw-runtime') throw new Error('runtime leaked 999-99-9999 in exception');
      if (prompt === 'plain prompt') return 'no sensitive output here';
      return 'Leak Jane Doe at (415) 555-2671 with SSN 123-45-6789';
    },
  });

  assert.equal(out.ok, true);
  assert.match(out.bakeoff_id, /^pii_bakeoff_[a-f0-9]{16}$/);
  assert.match(out.bakeoff_scan_sha256, /^[a-f0-9]{64}$/);
  assert.equal(out.n_prompts, 3);
  assert.equal(out.runtime_error_count, 1);
  assert.equal(out.runtime_errors[0].prompt_index, 1);
  assert.match(out.runtime_errors[0].message_hash, /^[a-f0-9]{64}$/);
  assert.equal(out.leaking_response_count, 1);
  assert.equal(out.total_pii_hits, out.leaking_responses[0].hits.length);
  assert.equal(out.by_category.phone_us, 1);
  assert.equal(out.by_category.ssn_us, 1);
  assert.equal(out.leaking_responses[0].prompt_index, 0);
  assert.ok(out.leaking_responses[0].redacted_response.includes('[REDACTED_'));
  assert.equal(hasRawLeak(out, [
    'prompt_person@example.com',
    'Jane Doe',
    '(415) 555-2671',
    '123-45-6789',
    '999-99-9999',
  ]), false);
});

test('W689 runPiiBakeoffScan validates local artifact paths and caps prompt fanout', async () => {
  let called = false;
  const remote = await runPiiBakeoffScan({
    artifact_path: 'https://example.com/model.kolm',
    prompts: ['x'],
    runOnArtifact: () => { called = true; return ''; },
  });
  assert.equal(remote.ok, false);
  assert.equal(remote.error, 'artifact_path_must_be_local');
  assert.equal(called, false);

  const many = await runPiiBakeoffScan({
    prompts: Array.from({ length: PII_SCAN_LIMITS.MAX_PROMPTS + 7 }, (_, i) => `prompt-${i}`),
    runOnArtifact: () => 'clean',
  });
  assert.equal(many.ok, true);
  assert.equal(many.n_prompts, PII_SCAN_LIMITS.MAX_PROMPTS);
  assert.equal(many.total_prompts, PII_SCAN_LIMITS.MAX_PROMPTS + 7);
  assert.equal(many.prompts_capped, true);
  assert.equal(many.total_pii_hits, 0);
});
