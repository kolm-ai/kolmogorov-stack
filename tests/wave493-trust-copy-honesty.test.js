// Wave 493 - public trust copy must not overclaim SLSA/Rekor evidence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('W493 #1 - /slsa names current status, not an already-proven SLSA L3 claim', () => {
  const html = read('public/slsa.html');
  assert.match(html, /Build provenance status/);
  assert.match(html, /not yet public-attested/i);
  assert.match(html, /SLSA Level 3 attestation is still a target/i);
  assert.match(html, /KOLM_REQUIRE_REKOR=1/);
  assert.match(html, /KOLM_SIGSTORE_REKOR_URL/);

  for (const forbidden of [
    'SLSA Level 3 build provenance.',
    'Every .kolm artifact ships alongside a signed in-toto attestation',
    'artifacts publish to four surfaces',
    'GitHub Releases, npm registry, Homebrew tap, Docker Hub',
    'cosign verify on every artifact + Rekor',
    'Rekor entry per tag',
    'SLSA v1.0 Build L3</td>',
  ]) {
    assert.equal(html.includes(forbidden), false, `public /slsa must not contain overclaim: ${forbidden}`);
  }
});

test('W493 #2 - /trust documents the actual signature_sigstore/Rekor gate', () => {
  const html = read('public/trust.html');
  assert.match(html, /signature_sigstore/);
  assert.match(html, /dry-run bundle/);
  assert.match(html, /kolm sigstore-attest/);
  assert.match(html, /KOLM_REQUIRE_REKOR=1/);

  for (const forbidden of [
    'Receipts can carry an <code>anchors</code> array',
    '<code>arweave</code>',
    '<code>btc-op-return</code>',
    '<code>ots</code>',
  ]) {
    assert.equal(html.includes(forbidden), false, `public /trust must not contain stale anchor copy: ${forbidden}`);
  }
});
