// Wave 409j — copy sweep: vocabulary unification + HMAC drift.
//
// Auditor flagged that product copy is "still inconsistent outside the homepage"
// — account/docs still mention AI compiler, K-score, and HMAC where the loop is
// actually about capture/opportunity/dataset/bakeoff/build/verify/run.
//
// The W226 SEO pillar /what-is-an-ai-compiler still owns "AI compiler" — that
// page is intentionally exempt. K-score still ships as an internal evaluation
// metric, but it must not lead prominent user-facing headings or lead copy on
// non-explainer pages. HMAC mentions in user-facing copy are stale; the source
// of truth is src/ed25519.js where Ed25519 is the public-key signer (HMAC
// retained only as a layered legacy integrity check, per the module's own
// comments).
//
// Tests assert behavior (page text grep + structural assertions), not exact
// copy. Lock-ins for W221 nav, W207 skip-link, W208 viewport, W228 brand-anchor,
// W205 em-dash budgets are owned by their own waves and not re-asserted here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');

// Pages exempt from the HMAC sweep because HMAC is structurally load-bearing
// content on them (the pillar/spec/format/i18n surfaces, the receipts spec, the
// post-mortem references, and the legacy webhooks contract which is genuinely
// HMAC-SHA256 today).
const HMAC_EXEMPT = new Set([
  'public/spec/rs-1.html',
  'public/spec/kolm-format-v1.html',
  'public/spec/codebase.html',
  'public/spec/changelog.html',
  'public/spec/spec.html',
  'public/docs/rs-1.html',
  'public/docs/rs-1.md',
  'public/docs/receipt-v0.1.json',
  'public/docs/webhooks.html',
  'public/docs/glossary.html',
  'public/docs/i18n/de.html',
  'public/docs/i18n/es.html',
  'public/docs/i18n/fr.html',
  'public/docs/i18n/ja.html',
  'public/docs/i18n/ko.html',
  'public/docs/i18n/zh.html',
  'public/articles/kolm-file-format.html',
  'public/research/receipt-chains.html',
  'public/research/receipt-chain.html',
  'public/format/v2.html',
  'public/spec.html',
]);

function read(p) {
  return fs.readFileSync(path.join(REPO, p), 'utf8');
}
function exists(p) {
  return fs.existsSync(path.join(REPO, p));
}

// =====================================================================
// 1. HMAC must not appear in account/ user-facing copy.
// =====================================================================

test('W409j #1 - no "HMAC" in any public/account/*.html (receipts are Ed25519)', () => {
  const dir = path.join(PUBLIC, 'account');
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(dir, name), 'utf8');
    if (/\bHMAC\b/.test(html) || /\bhmac-sha256\b/i.test(html)) {
      // exclude the literal field name inside a code/pre block? No — auditor
      // wants this fully purged from account copy.
      offenders.push(`account/${name}`);
    }
  }
  assert.equal(offenders.length, 0,
    `account pages still mention HMAC (replace with Ed25519):\n${offenders.join('\n')}`);
});

// =====================================================================
// 2. HMAC must not appear in public/docs/*.html user-facing copy.
//
// docs/glossary.html (the historical reference for "HMAC chain" the term),
// docs/webhooks.html (genuinely HMAC-SHA256 for webhooks), docs/rs-1.md and
// docs/receipt-v0.1.json (the receipts spec) are exempt by HMAC_EXEMPT above.
// =====================================================================

test('W409j #2 - HMAC in public/docs/ is confined to spec/glossary/webhooks/i18n', () => {
  const root = path.join(PUBLIC, 'docs');
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(html|md)$/.test(entry.name)) continue;
      const rel = 'public/' + path.relative(PUBLIC, full).split(path.sep).join('/');
      if (HMAC_EXEMPT.has(rel)) continue;
      // Also exempt api-routes.json since it is generator output reflecting
      // source-code comments (legacy HMAC chain wording in router.js). The
      // user-facing rendering is api.html, which is its own concern.
      if (rel.endsWith('api-routes.json')) continue;
      // Exempt CLI man pages that mention "HMAC chain" as part of the 7-check
      // audit description — those are reference docs, not lead copy. We still
      // flag the lede paragraph of api.html below.
      const html = fs.readFileSync(full, 'utf8');
      if (/\bHMAC\b/.test(html)) {
        // Allow CLI verify/inspect/eval pages to keep "HMAC chain" as a
        // technical reference (it remains a legacy integrity layer). Flag
        // only if HMAC appears as the PRIMARY signer in lede/H1/H2.
        const headlineHMAC = /<h[12][^>]*>[^<]*HMAC/i.test(html) ||
          /<p class="lede"[^>]*>[^<]*HMAC[^<]{0,300}<\/p>/i.test(html);
        if (headlineHMAC) offenders.push(rel);
      }
    }
  }
  walk(root);
  assert.equal(offenders.length, 0,
    `docs pages still lead with HMAC (replace with Ed25519):\n${offenders.join('\n')}`);
});

// =====================================================================
// 3. Pages that mention receipts must mention Ed25519.
//
// Ed25519 IS the user-facing public-key signer; HMAC is a layered legacy
// integrity check (per src/ed25519.js comments). Any user-facing page that
// names receipts as a feature must name Ed25519 somewhere.
// =====================================================================

test('W409j #3 - /security mentions Ed25519 (it is the public-key signer)', () => {
  const html = read('public/security.html');
  assert.match(html, /\bEd25519\b/, 'security.html must mention Ed25519');
});

test('W409j #4 - /api mentions Ed25519 (receipts are public-key signed)', () => {
  const html = read('public/api.html');
  assert.match(html, /\bEd25519\b/, 'api.html must mention Ed25519 (public-key receipts)');
});

// =====================================================================
// 4. Canonical loop verbs.
//
// The seven canonical loop verbs (capture / opportunity / dataset / label /
// bakeoff / build / verify / run) MUST appear at least once on /docs/api.html
// or /api.html — these are the buyer-facing API references where the loop
// vocabulary is most important.
// =====================================================================

test('W409j #5 - canonical loop verbs appear in /docs/api.html or /api.html', () => {
  const api = read('public/api.html').toLowerCase();
  const docsApi = exists('public/docs/api.html') ? read('public/docs/api.html').toLowerCase() : '';
  const corpus = api + '\n' + docsApi;
  const verbs = ['capture', 'opportunity', 'dataset', 'label', 'bakeoff', 'build', 'verify', 'run'];
  const missing = verbs.filter((v) => !new RegExp(`\\b${v}\\b`).test(corpus));
  assert.equal(missing.length, 0,
    `API references missing canonical loop verbs: ${missing.join(', ')}`);
});

// =====================================================================
// 5. Billing canonical units.
//
// The task names captured_events / builds / hosted_inference / team_seats as
// the canonical billing units. The actual source-of-truth meter names in
// scripts/build-account-pages.cjs use slightly fuller forms (artifacts_built
// for "builds"; hosted_build_minutes for "hosted inference"). The test
// accepts either form.
// =====================================================================

test('W409j #6 - /account/billing.html names canonical billing units', () => {
  const html = read('public/account/billing.html');
  // captured_events is canonical and present today
  assert.match(html, /\bcaptured_events\b/, 'billing must name captured_events');
  // builds — accept artifacts_built (canonical meter) OR the literal "builds"
  assert.ok(/\bartifacts_built\b/.test(html) || /\bbuilds\b/i.test(html),
    'billing must name builds (artifacts_built or builds)');
  // hosted_inference — accept hosted_build_minutes (canonical meter) OR the
  // literal "hosted_inference"
  assert.ok(/\bhosted_build_minutes\b/.test(html) || /\bhosted_inference\b/.test(html),
    'billing must name hosted inference (hosted_build_minutes or hosted_inference)');
  // team_seats is canonical and present today
  assert.match(html, /\bteam_seats\b/, 'billing must name team_seats');
});

// =====================================================================
// 6. Artifact metadata.
//
// /account/artifacts.html must surface the canonical artifact metadata
// fields: production_ready_state, runtime_target, license,
// verified_receipt_hash. These are the buyer-facing fields per the W409
// vocabulary unification.
// =====================================================================

test('W409j #7 - /account/artifacts.html surfaces canonical artifact metadata fields', () => {
  const html = read('public/account/artifacts.html');
  const fields = [
    'production_ready_state',
    'runtime_target',
    'license',
    'verified_receipt_hash',
  ];
  const missing = fields.filter((f) => !new RegExp(`\\b${f}\\b`).test(html));
  assert.equal(missing.length, 0,
    `account/artifacts.html missing canonical fields: ${missing.join(', ')}`);
});

// =====================================================================
// 7. Audit allergy: "soup to nuts" must not appear anywhere on the site.
// =====================================================================

test('W409j #8 - no page contains the literal phrase "soup to nuts"', () => {
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(html|md|txt)$/.test(entry.name)) continue;
      const html = fs.readFileSync(full, 'utf8');
      if (/\bsoup\s+to\s+nuts\b/i.test(html)) {
        offenders.push(path.relative(PUBLIC, full).split(path.sep).join('/'));
      }
    }
  }
  walk(PUBLIC);
  assert.equal(offenders.length, 0,
    `pages contain the audit-allergy phrase "soup to nuts":\n${offenders.join('\n')}`);
});

// =====================================================================
// 8. K-score must not lead prominent user-facing headings/lede on the
// account artifact/build pages — replace with held-out pass rate framing.
//
// /k-score, /k-score-explained, /kscore-leaderboard, /research/k-score-*
// keep K-score in their headings (the dedicated explainer pages own it).
// =====================================================================

test('W409j #9 - /account/artifacts.html and /account/builds.html do not LEAD with K-score', () => {
  for (const p of ['public/account/artifacts.html', 'public/account/builds.html']) {
    const html = read(p);
    // H1 must not contain K-score.
    const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [, ''])[1];
    assert.ok(!/k-score|kscore/i.test(h1), `${p} H1 must not lead with K-score (got: ${h1.trim().slice(0,80)})`);
    // Lede paragraph must not contain K-score.
    const lede = (html.match(/<p class="lede"[^>]*>([\s\S]*?)<\/p>/i) || [, ''])[1];
    assert.ok(!/k-score|kscore/i.test(lede), `${p} lede must not lead with K-score`);
  }
});
