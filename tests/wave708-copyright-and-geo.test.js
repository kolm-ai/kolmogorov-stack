// @public-routes-only — exercises /v1/signup (public, mounted before authMiddleware via signupLimiter).
// W708 — capture copyright-risk flagger (W708-4) + signup geo-fence (W708-5).
//
// These tests assert observable behavior, NOT page copy:
//   1) flagCopyrightRisk flags obvious paywall snippet + copyright header.
//   2) flagCopyrightRisk does NOT flag clean conversational text.
//   3) attachCopyrightFlag stamps copyright_flagged + copyright_reasons on a row.
//   4) isGeoFenced blocks CU/IR/KP/SY/RU/BY (case-insensitive) and allows US/CA/DE.
//   5) Signup with denylisted country returns HTTP 451 + envelope shape.
//   6) Signup without country header/body succeeds and stamps geo_check:'unknown'.
//   7) Signup with allowed country succeeds and stamps country_code + geo_check:'allowed'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Isolate data dir so we never touch the developer's real ~/.kolm during tests.
const TEST_DATA_DIR = path.join(os.tmpdir(), 'kolm-w708-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.KOLM_DATA_DIR = TEST_DATA_DIR;
process.env.KOLM_HOME = TEST_DATA_DIR;
process.env.HOME = TEST_DATA_DIR;
process.env.USERPROFILE = TEST_DATA_DIR;

const {
  CAPTURE_COPYRIGHT_FILTER_VERSION,
  flagCopyrightRisk,
  attachCopyrightFlag,
} = await import('../src/capture-copyright-filter.js');
const { isGeoFenced, EXPORT_CONTROL_DENYLIST } = await import('../src/auth.js');

// =============================================================================
// 1) flagCopyrightRisk flags obvious paywall/copyright cases
// =============================================================================

test('W708 #1 — flagCopyrightRisk flags paywall snippet AND copyright header', () => {
  const paywall = flagCopyrightRisk('Subscribe to read more about the rate hike.');
  assert.equal(paywall.flagged, true, 'paywall snippet should flag');
  assert.ok(paywall.matched_phrases.includes('subscribe to read more'),
    'matched_phrases should include the paywall string');
  assert.ok(paywall.reasons.includes('flagged-phrase-match'),
    'reasons should include flagged-phrase-match');

  const copyHeader = flagCopyrightRisk('© 2024 The New York Times Company. All rights reserved.');
  assert.equal(copyHeader.flagged, true, 'copyright header should flag');
  assert.ok(copyHeader.reasons.includes('copyright-header'),
    'reasons should include copyright-header');

  const lyrics = flagCopyrightRisk('[Verse 1]\nIn the morning light\n[Chorus]\nWe rise together');
  assert.equal(lyrics.flagged, true, 'song-lyrics markers should flag');
  assert.ok(lyrics.matched_phrases.some((p) => p.startsWith('[verse') || p.startsWith('[chorus')),
    'lyrics markers should appear in matched_phrases');
});

test('W708 #1b - W1022 copyright filter reuses local fingerprints and source-license policy', () => {
  const fingerprinted = flagCopyrightRisk(
    'SPDX-License-Identifier: MIT\nCopyright (c) 2026 Acme\nMickey Mouse reference'
  );
  assert.equal(fingerprinted.flagged, true);
  assert.equal(fingerprinted.version, CAPTURE_COPYRIGHT_FILTER_VERSION);
  assert.ok(fingerprinted.reasons.includes('copyright-fingerprint-match'));
  assert.ok(fingerprinted.fingerprint_hits.some((hit) => hit.kind === 'spdx'));
  assert.ok(fingerprinted.fingerprint_hits.some((hit) => hit.kind === 'code_copyright'));
  assert.ok(fingerprinted.fingerprint_hits.some((hit) => hit.kind === 'disney_character'));
  assert.ok(fingerprinted.risk_score > 0);

  const disallowed = flagCopyrightRisk('This is a public-corpus row from a web scrape.', {
    source_type: 'web',
    source_license: 'all-rights-reserved',
  });
  assert.equal(disallowed.flagged, true);
  assert.ok(disallowed.reasons.includes('source-license-disallowed'));
  assert.equal(disallowed.license_policy.normalized_license, 'all-rights-reserved');
  assert.equal(disallowed.license_policy.restricted, true);

  const longWebText = 'A source paragraph. '.repeat(40);
  const missing = flagCopyrightRisk(longWebText, { source_type: 'web' });
  assert.equal(missing.flagged, true);
  assert.ok(missing.reasons.includes('source-license-missing'));
  assert.equal(missing.license_policy.require_source_license, true);

  const permitted = flagCopyrightRisk(longWebText, {
    source_type: 'web',
    source_license: 'Apache-2.0',
  });
  assert.equal(permitted.flagged, false);
  assert.equal(permitted.license_policy.permitted, true);
});

// =============================================================================
// 2) flagCopyrightRisk skips clean text
// =============================================================================

test('W708 #2 — flagCopyrightRisk does NOT flag clean conversational text', () => {
  const clean = flagCopyrightRisk('What is the capital of France?');
  assert.equal(clean.flagged, false, 'short clean prompt should not flag');
  assert.equal(clean.reasons.length, 0);
  assert.equal(clean.matched_phrases.length, 0);

  const cleanAnswer = flagCopyrightRisk('The capital of France is Paris.');
  assert.equal(cleanAnswer.flagged, false, 'short clean answer should not flag');

  // Empty / null / weird inputs never throw.
  assert.equal(flagCopyrightRisk('').flagged, false);
  assert.equal(flagCopyrightRisk(null).flagged, false);
  assert.equal(flagCopyrightRisk(undefined).flagged, false);
  assert.equal(flagCopyrightRisk({ nested: 'object' }).flagged, false);
});

// =============================================================================
// 3) attachCopyrightFlag mutates a capture row in place
// =============================================================================

test('W708 #3 — attachCopyrightFlag stamps copyright_flagged + copyright_reasons on a row', () => {
  const row = {
    id: 'cap_test_w708',
    tenant: 'acme',
    prompt: 'Subscribe to read more about quantum computing.',
    response: 'Quantum computing uses qubits.',
  };
  attachCopyrightFlag(row);
  assert.equal(row.copyright_flagged, true, 'row should be flagged because prompt has paywall snippet');
  assert.ok(Array.isArray(row.copyright_reasons), 'copyright_reasons should be an array');
  assert.ok(row.copyright_reasons.includes('flagged-phrase-match'));
  assert.ok(Array.isArray(row.copyright_matched_phrases));
  assert.ok(row.copyright_matched_phrases.includes('subscribe to read more'));
  assert.equal(typeof row.copyright_risk_score, 'number');
  assert.equal(row.copyright_policy.version, CAPTURE_COPYRIGHT_FILTER_VERSION);

  // Clean row should be flagged:false with empty reasons.
  const cleanRow = { id: 'cap_clean', prompt: 'hi', response: 'hello' };
  attachCopyrightFlag(cleanRow);
  assert.equal(cleanRow.copyright_flagged, false);
  assert.deepEqual(cleanRow.copyright_reasons, []);
  assert.deepEqual(cleanRow.copyright_matched_phrases, []);
  assert.deepEqual(cleanRow.copyright_fingerprint_hits, []);
  assert.equal(cleanRow.copyright_risk_score, 0);

  const licensedRow = {
    id: 'cap_license',
    source_type: 'dataset',
    source_license: 'proprietary',
    prompt: 'Short source row',
    response: 'OK',
  };
  attachCopyrightFlag(licensedRow);
  assert.equal(licensedRow.copyright_flagged, true);
  assert.ok(licensedRow.copyright_reasons.includes('source-license-disallowed'));
  assert.equal(licensedRow.copyright_policy.input.normalized_license, 'proprietary');

  // Null row never throws and is returned as-is.
  assert.equal(attachCopyrightFlag(null), null);
  assert.equal(attachCopyrightFlag(undefined), undefined);
});

// =============================================================================
// 4) isGeoFenced blocks comprehensive-sanctions countries
// =============================================================================

test('W708 #4 — isGeoFenced blocks CU/IR/KP/SY/RU/BY and allows US/CA/DE/JP/GB', () => {
  // Denylist baseline matches the orchestrator spec. EXPORT_CONTROL_DENYLIST is
  // Object.freeze'd (the sanctions list must be tamper-proof at runtime), so sort
  // a COPY for the order-independent content comparison rather than mutating it.
  assert.deepEqual([...EXPORT_CONTROL_DENYLIST].sort(),
    ['BY', 'CU', 'IR', 'KP', 'RU', 'SY'].sort(),
    'denylist should be the OFAC comprehensive-sanctions baseline');

  for (const blocked of ['CU', 'IR', 'KP', 'SY', 'RU', 'BY']) {
    assert.equal(isGeoFenced(blocked), true, `${blocked} should be geo-fenced`);
    assert.equal(isGeoFenced(blocked.toLowerCase()), true, `${blocked} should be case-insensitive`);
  }
  for (const allowed of ['US', 'CA', 'DE', 'JP', 'GB', 'FR', 'BR', 'ZA']) {
    assert.equal(isGeoFenced(allowed), false, `${allowed} should NOT be geo-fenced`);
  }
  // Edge cases: missing/invalid never blocks (handler stamps geo_check:'unknown').
  assert.equal(isGeoFenced(null), false);
  assert.equal(isGeoFenced(undefined), false);
  assert.equal(isGeoFenced(''), false);
  assert.equal(isGeoFenced('USA'), false, 'wrong-length code should not match');
});

// =============================================================================
// 5+6+7) Signup integration — geo-fence returns 451, missing → unknown, allowed → stamped
// =============================================================================

test('W708 #5 — signup with denylisted country returns HTTP 451 + geo_restricted envelope', async () => {
  // Build a minimal Express-ish app with just the signup route by importing
  // the full router. The router is heavy but loads cleanly with the test data
  // dir set above.
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildRouter());

  // Drive via supertest-style direct invocation: use Node's http to start on
  // a random port + send a request.
  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  async function postSignup(body, headers = {}) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  try {
    const blocked = await postSignup(
      { email: `denied-${crypto.randomBytes(3).toString('hex')}@example.com` },
      { 'x-kolm-country': 'IR' }
    );
    assert.equal(blocked.status, 451, 'denylisted country should return HTTP 451');
    assert.equal(blocked.json.ok, false);
    assert.equal(blocked.json.error, 'geo_restricted');
    assert.equal(blocked.json.country, 'IR');
    assert.equal(blocked.json.contact, 'dev@kolm.ai');

    // Body-field form (no header) is also honored.
    const blockedBody = await postSignup({
      email: `denied2-${crypto.randomBytes(3).toString('hex')}@example.com`,
      country_code: 'kp',
    });
    assert.equal(blockedBody.status, 451);
    assert.equal(blockedBody.json.country, 'KP', 'should upper-case the lowercased input');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('W708 #6 — signup without country succeeds and stamps geo_check:unknown', async () => {
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const { buildRouter } = await import('../src/router.js');
  const { findTenantByEmail } = await import('../src/auth.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildRouter());

  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const email = `unknown-${crypto.randomBytes(4).toString('hex')}@example.com`;
    const res = await fetch(`http://127.0.0.1:${port}/v1/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(res.status, 201, 'no-country signup should succeed');
    const tenant = findTenantByEmail(email);
    assert.ok(tenant, 'tenant should be persisted');
    assert.equal(tenant.country_code, null, 'country_code should be null when unknown');
    assert.equal(tenant.geo_check, 'unknown', 'geo_check should be "unknown" when no code supplied');

    // Allowed country path: stamp country_code + geo_check:'allowed'.
    const allowedEmail = `allowed-${crypto.randomBytes(4).toString('hex')}@example.com`;
    const allowedRes = await fetch(`http://127.0.0.1:${port}/v1/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kolm-country': 'US' },
      body: JSON.stringify({ email: allowedEmail }),
    });
    assert.equal(allowedRes.status, 201);
    const allowedTenant = findTenantByEmail(allowedEmail);
    assert.equal(allowedTenant.country_code, 'US');
    assert.equal(allowedTenant.geo_check, 'allowed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// =============================================================================
// 7) End-to-end: capture row carries copyright_flagged bit after insertCapture
// =============================================================================

test('W708 #7 — insertCapture stamps copyright_flagged on the persisted row', async () => {
  const { insertCapture, listCaptures } = await import('../src/capture-store.js');
  const tenant = 'w708-cap-' + crypto.randomBytes(3).toString('hex');
  const namespace = 'default';
  const row = {
    id: 'cap_' + crypto.randomBytes(4).toString('hex'),
    tenant,
    corpus_namespace: namespace,
    prompt: 'Subscribe to read more — exclusive coverage you cannot find elsewhere.',
    response: 'OK.',
    model: 'gpt-4',
    created_at: new Date().toISOString(),
  };
  await insertCapture(row);
  // The mutation is in-place, so the row object we passed in is now stamped.
  assert.equal(row.copyright_flagged, true, 'inserted row should carry copyright_flagged');
  assert.ok(Array.isArray(row.copyright_reasons));
  assert.ok(row.copyright_reasons.includes('flagged-phrase-match'));

  // And listCaptures should surface it back (legacy in-memory driver).
  const found = await listCaptures(tenant, namespace, 10);
  assert.ok(found.length >= 1, 'should retrieve at least one row');
  const ours = found.find((c) => c.id === row.id) || found[0];
  assert.equal(ours.copyright_flagged, true, 'persisted row should retain the flag');
});
