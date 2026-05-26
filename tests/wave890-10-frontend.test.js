// W890-10 — FRONTEND / ACCOUNT UI lock-ins.
//
// Fifteen invariants ratify the audit produced by
// `node scripts/w890-10-frontend-audit.cjs`. The audit writes 14 JSON reports
// under data/ plus a ship-gate snapshot, and a canonical reference at
// docs/reference/frontend-policy.md.
//
//   1.  data/w890-10-page-inventory.json: total > 60 account pages scanned
//   2.  data/w890-10-js-errors.json: parse_errors === 0
//   3.  data/w890-10-mobile.json: missing_viewport === 0
//   4.  data/w890-10-loading-states.json: pages_missing_loading === 0
//   5.  data/w890-10-form-validation.json: forms_missing_validation === 0
//   6.  data/w890-10-destructive-confirm.json: actions_missing_confirm === 0
//   7.  data/w890-10-session.json: nav_logout_present && server_tokens_expire
//   8.  data/w890-10-error-states.json: pages_missing_error_handling === 0
//   9.  data/w890-10-empty-states.json: list_pages_missing_empty_state === 0
//   10. data/w890-10-navigation.json: orphan_count === 0
//   11. data/w890-10-favicon.json: missing_count === 0 && broken_count === 0
//   12. data/w890-10-titles.json: missing_count === 0 && placeholder_count === 0
//   13. data/w890-10-links.json: broken === 0 (whole-site link audit)
//   14. data/w890-10-color-regression.json: hits_count === 0 (cool-slate guard)
//   15. docs/reference/frontend-policy.md exists + cross-links siblings
//   16. no banned vocabulary in any W890-10 artifact or the policy doc
//   17. ship-gate 52/52 still green (snapshotted to
//       data/w890-10-ship-gate-snapshot.json)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('W890-10 #1 — page inventory covers all account pages', () => {
  const r = readJSON('data/w890-10-page-inventory.json');
  assert.ok(typeof r.total === 'number' && r.total >= 60,
    `expected >= 60 account pages scanned; got ${r.total}`);
  assert.ok(Array.isArray(r.pages) && r.pages.length === r.total,
    'pages array length must match total');
  for (const p of r.pages.slice(0, 5)) {
    assert.ok(typeof p.page === 'string' && p.page.startsWith('public/account/'),
      `inventory entry must be a public/account/* page; got ${p.page}`);
  }
});

test('W890-10 #2 — every account page has zero inline-script parse errors', () => {
  const r = readJSON('data/w890-10-js-errors.json');
  assert.strictEqual(r.parse_errors, 0,
    `JS parse_errors must be 0; got ${r.parse_errors}. Sample: ${JSON.stringify(r.error_sites?.slice(0, 3))}`);
  assert.ok(r.pages > 0, 'pages count must be positive');
});

test('W890-10 #3 — every account page has a mobile viewport meta', () => {
  const r = readJSON('data/w890-10-mobile.json');
  assert.ok(Array.isArray(r.missing_viewport), 'missing_viewport must be an array');
  assert.strictEqual(r.missing_viewport.length, 0,
    `missing viewport count must be 0; got ${r.missing_viewport.length}. Sample: ${JSON.stringify(r.missing_viewport.slice(0, 3))}`);
  assert.ok(r.mobile_ok >= r.pages * 0.95,
    `>= 95% of pages must be mobile-ok; got ${r.mobile_ok}/${r.pages}`);
});

test('W890-10 #4 — every interactive page has a loading-state hint', () => {
  const r = readJSON('data/w890-10-loading-states.json');
  assert.strictEqual(r.pages_missing_loading, 0,
    `pages_missing_loading must be 0; got ${r.pages_missing_loading}. Sample: ${JSON.stringify(r.missing_loading?.slice(0, 3))}`);
  assert.ok(r.pages_with_interactive > 0, 'must find > 0 interactive pages');
});

test('W890-10 #5 — every form has client-side validation or is filter-only', () => {
  const r = readJSON('data/w890-10-form-validation.json');
  assert.strictEqual(r.forms_missing_validation, 0,
    `forms_missing_validation must be 0; got ${r.forms_missing_validation}`);
  assert.ok(r.total_forms > 0, 'must find > 0 forms');
});

test('W890-10 #6 — every destructive action has a confirm prompt', () => {
  const r = readJSON('data/w890-10-destructive-confirm.json');
  const missing = r.total_destructive_actions - r.actions_with_confirm;
  assert.strictEqual(missing, 0,
    `every destructive action must have confirm; ${missing} missing. Detail: ${JSON.stringify(r.rows?.filter(row => row.items.some(i => !i.has_confirm)))}`);
  assert.ok(r.total_destructive_actions >= 3,
    `must sample >= 3 destructive actions; got ${r.total_destructive_actions}`);
});

test('W890-10 #7 — session contract: nav-level logout + server tokens expire', () => {
  const r = readJSON('data/w890-10-session.json');
  assert.strictEqual(r.nav_logout_present, true,
    'nav_logout_present must be true (account.html or nav.js must surface a Sign out control)');
  assert.strictEqual(r.server_tokens_expire, true,
    'server_tokens_expire must be true (src/auth.js must reference expires/expiry/TTL)');
});

test('W890-10 #8 — every fetch page handles errors (catch / try / !r.ok branch)', () => {
  const r = readJSON('data/w890-10-error-states.json');
  assert.strictEqual(r.pages_missing_error_handling, 0,
    `pages_missing_error_handling must be 0; got ${r.pages_missing_error_handling}. Sample: ${JSON.stringify(r.missing_handlers?.slice(0, 3))}`);
  assert.ok(r.pages_with_fetch >= 30,
    `must scan >= 30 pages with fetch; got ${r.pages_with_fetch}`);
});

test('W890-10 #9 — every list page has an empty-state fallback', () => {
  const r = readJSON('data/w890-10-empty-states.json');
  assert.strictEqual(r.list_pages_missing_empty_state, 0,
    `list_pages_missing_empty_state must be 0; got ${r.list_pages_missing_empty_state}`);
  assert.ok(r.list_pages >= 20, `must find >= 20 list pages; got ${r.list_pages}`);
});

test('W890-10 #10 — no nav orphans: every page reachable from /account/overview', () => {
  const r = readJSON('data/w890-10-navigation.json');
  assert.strictEqual(r.orphan_count, 0,
    `orphan_count must be 0; got ${r.orphan_count}. Orphans: ${JSON.stringify(r.orphans)}`);
  assert.ok(r.pages_with_sidebar >= 50,
    `>= 50 pages should include account-sidebar; got ${r.pages_with_sidebar}`);
});

test('W890-10 #11 — every page has a favicon link and the file resolves', () => {
  const r = readJSON('data/w890-10-favicon.json');
  assert.strictEqual(r.missing_count, 0,
    `favicon missing_count must be 0; got ${r.missing_count}. Missing: ${JSON.stringify(r.missing?.slice(0, 3))}`);
  assert.strictEqual(r.broken_count, 0,
    `favicon broken_count must be 0; got ${r.broken_count}. Broken: ${JSON.stringify(r.broken?.slice(0, 3))}`);
});

test('W890-10 #12 — every page has a non-placeholder, unique title', () => {
  const r = readJSON('data/w890-10-titles.json');
  assert.strictEqual(r.missing_count, 0,
    `title missing_count must be 0; got ${r.missing_count}. Sample: ${JSON.stringify(r.missing?.slice(0, 3))}`);
  assert.strictEqual(r.placeholder_count, 0,
    `placeholder title count must be 0; got ${r.placeholder_count}`);
  assert.ok(r.duplicate_count <= 5,
    `duplicate titles should be <= 5 (some sibling pages share titles by design); got ${r.duplicate_count}`);
});

test('W890-10 #13 — site-wide link audit reports zero broken links', () => {
  const r = readJSON('data/w890-10-links.json');
  assert.strictEqual(r.summary.broken, 0,
    `link audit must report 0 broken; got ${r.summary.broken}/${r.summary.total}`);
  assert.ok(r.summary.total >= 1000,
    `link audit must cover >= 1000 hrefs; got ${r.summary.total}`);
  assert.strictEqual(r.status, 0, 'audit-href.cjs must exit 0');
});

test('W890-10 #14 — no warm-color regressions: cool slate palette only', () => {
  const r = readJSON('data/w890-10-color-regression.json');
  assert.strictEqual(r.hits_count, 0,
    `cool-slate guard: hits_count must be 0; got ${r.hits_count}. Sample: ${JSON.stringify(r.hits?.slice(0, 3))}`);
  assert.ok(Array.isArray(r.forbidden_hex) && r.forbidden_hex.length >= 10,
    `forbidden_hex list must cover >= 10 warm-paper hexes; got ${r.forbidden_hex?.length}`);
  assert.ok(Array.isArray(r.forbidden_words) && r.forbidden_words.length >= 5,
    `forbidden_words must include >= 5 warm-color names; got ${r.forbidden_words?.length}`);
});

test('W890-10 #15 — docs/reference/frontend-policy.md exists and is substantive', () => {
  const policyPath = path.join(ROOT, 'docs/reference/frontend-policy.md');
  assert.ok(fs.existsSync(policyPath),
    `frontend-policy.md must exist at ${policyPath}`);
  const text = readText('docs/reference/frontend-policy.md');
  assert.ok(text.length > 2000,
    `frontend-policy.md must be substantive; got ${text.length} bytes`);
  // Must reference every W890-10 data artifact
  const expectedRefs = [
    'w890-10-page-inventory.json',
    'w890-10-js-errors.json',
    'w890-10-mobile.json',
    'w890-10-loading-states.json',
    'w890-10-form-validation.json',
    'w890-10-destructive-confirm.json',
    'w890-10-session.json',
    'w890-10-error-states.json',
    'w890-10-empty-states.json',
    'w890-10-navigation.json',
    'w890-10-favicon.json',
    'w890-10-titles.json',
    'w890-10-links.json',
    'w890-10-color-regression.json',
  ];
  for (const ref of expectedRefs) {
    assert.ok(text.includes(ref),
      `frontend-policy.md must reference ${ref}`);
  }
  // Must cross-link sibling policies
  assert.ok(/cli-policy\.md|documentation-policy\.md/.test(text),
    'frontend-policy.md must cross-link sibling policy docs');
});

test('W890-10 #16 — no banned vocabulary in W890-10 artifacts or policy doc', () => {
  // The banned tokens are case-insensitive surface forms of "honesty"/"honest"
  // per the long-standing project directive.
  const BANNED = [/\bhonest\b/i, /\bhonesty\b/i];
  const files = [
    'data/w890-10-page-inventory.json',
    'data/w890-10-js-errors.json',
    'data/w890-10-mobile.json',
    'data/w890-10-loading-states.json',
    'data/w890-10-form-validation.json',
    'data/w890-10-destructive-confirm.json',
    'data/w890-10-session.json',
    'data/w890-10-error-states.json',
    'data/w890-10-empty-states.json',
    'data/w890-10-navigation.json',
    'data/w890-10-favicon.json',
    'data/w890-10-titles.json',
    'data/w890-10-links.json',
    'data/w890-10-color-regression.json',
    'docs/reference/frontend-policy.md',
  ];
  for (const rel of files) {
    const text = readText(rel);
    for (const pattern of BANNED) {
      assert.ok(!pattern.test(text),
        `banned vocabulary ${pattern} found in ${rel}`);
    }
  }
});

test('W890-10 #17 — ship-gate snapshot reports 52/52 green', () => {
  const snapPath = path.join(ROOT, 'data/w890-10-ship-gate-snapshot.json');
  assert.ok(fs.existsSync(snapPath),
    `ship-gate snapshot must exist at ${snapPath} (regenerate via scripts/w890-10-frontend-audit.cjs)`);
  const snap = readJSON('data/w890-10-ship-gate-snapshot.json');
  assert.ok(typeof snap.total === 'number', 'snapshot must have total');
  assert.ok(typeof snap.passed === 'number', 'snapshot must have passed');
  assert.strictEqual(snap.passed, snap.total,
    `ship-gate must be ${snap.total}/${snap.total} green; got ${snap.passed}/${snap.total}`);
  assert.ok(snap.total >= 52,
    `ship-gate must cover >= 52 checks; got ${snap.total}`);
});
