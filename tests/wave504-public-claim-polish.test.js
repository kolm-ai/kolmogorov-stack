import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readPublic(path) {
  return readFileSync(join(root, 'public', path), 'utf8');
}

test('W504 public healthcare copy avoids unsupported zero-egress claims', () => {
  const page = readPublic('articles/hipaa-on-device.html');
  assert.doesNotMatch(page, /HHS&apos;s 2026 Health AI rule/i);
  assert.doesNotMatch(page, /zero PHI egress/i);
  assert.match(page, /deployment-specific legal and security review/i);
});

test('W504 HIPAA summarizer metadata does not promise zero PHI output', () => {
  const page = readPublic('cookbook/hipaa-summarizer.html');
  assert.doesNotMatch(page, /zero PHI in the output/i);
  assert.doesNotMatch(page, /never crosses the/i);
  assert.match(page, /reviewed training rows, redaction evidence, and receipt metadata/i);
});

test('W504 privacy page does not describe public artifacts as placeholder slots', () => {
  const page = readPublic('privacy.html');
  assert.doesNotMatch(page, /placeholder model\/index slots/i);
  assert.match(page, /runtime metadata, and deployment-specific model or index references/i);
});

test('W504 receipt-chain explainers distinguish HMAC integrity from public signatures', () => {
  const receipt = readPublic('research/receipt-chain.html');
  const format = readPublic('articles/kolm-file-format.html');
  assert.doesNotMatch(receipt, /four-ring HMAC integrity model/i);
  assert.doesNotMatch(receipt, /Anyone with the public chain root/i);
  assert.match(receipt, /Tenant-local integrity can use HMAC/i);
  assert.match(receipt, /public artifact distribution adds Ed25519/i);
  assert.match(format, /signature_alg ed25519\+hmac-sha256/i);
});
