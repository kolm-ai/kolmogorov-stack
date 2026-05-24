// W707b — Frontend supplement bundle v2 (WF03 mobile-nav + WF06 breadcrumbs + WF22/23/24 wires).
//
// Pins the v2 additions with the W604 anti-brittleness pattern: regex+threshold, never explicit arrays.
//
// Atomic items pinned:
//
//   1)  supplement.js exposes SUPPLEMENT_VERSION matching /w707-supp-v[2-9]/
//   2)  supplement.js installMobileNav present + builds .kolm-mobile-nav overlay
//   3)  supplement.js MOBILE_NAV_LINKS has >= 4 groups (Product/Trust/Developer/Company)
//   4)  supplement.js installBreadcrumbs + auto-trigger for /docs/ /account/ /use-cases/ /guides/
//   5)  supplement.css ships .kolm-mobile-nav and .kolm-breadcrumbs selectors
//   6)  supplement.css mobile-nav trigger gated to max-width: 720px
//   7)  security.html includes /supplement.js + /supplement.css + wf22-security-page marker
//   8)  compare.html includes /supplement.js + /supplement.css + wf23-compare-page marker
//   9)  integrations.html includes /supplement.js + /supplement.css + wf24-integrations-page marker
//   10) sw.js cache key matches /wave\d{3,4}/ AND >= 707

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

test('W707b #1 supplement.js bumped to /w707-supp-v[2-9]/', () => {
  const js = readPublic('supplement.js');
  assert.ok(/w707-supp-v[2-9]/.test(js), 'should be at v2 or later');
});

test('W707b #2 installMobileNav builds .kolm-mobile-nav overlay', () => {
  const js = readPublic('supplement.js');
  assert.ok(/function installMobileNav/.test(js), 'installMobileNav defined');
  assert.ok(/class:\s*'kolm-mobile-nav'/.test(js), 'creates .kolm-mobile-nav');
  assert.ok(/kolm-mobile-nav__sheet/.test(js), 'has __sheet child');
});

test('W707b #3 MOBILE_NAV_LINKS has >= 4 groups', () => {
  const js = readPublic('supplement.js');
  const m = js.match(/var MOBILE_NAV_LINKS = \[([\s\S]*?)\];/);
  assert.ok(m, 'MOBILE_NAV_LINKS array present');
  const groupCount = (m[1].match(/group:/g) || []).length;
  assert.ok(groupCount >= 4, `expected >= 4 mobile nav groups, got ${groupCount}`);
});

test('W707b #4 installBreadcrumbs auto-triggers for scoped sections', () => {
  const js = readPublic('supplement.js');
  assert.ok(/function installBreadcrumbs/.test(js), 'installBreadcrumbs defined');
  assert.ok(/\/\^\\\/\(docs\|account\|use-cases\|guides\)/.test(js) ||
            /docs\|account\|use-cases\|guides/.test(js), 'scoped section regex present');
});

test('W707b #5 supplement.css ships .kolm-mobile-nav and .kolm-breadcrumbs', () => {
  const css = readPublic('supplement.css');
  assert.ok(/\.kolm-mobile-nav\b/.test(css), 'has .kolm-mobile-nav selector');
  assert.ok(/\.kolm-breadcrumbs\b/.test(css), 'has .kolm-breadcrumbs selector');
});

test('W707b #6 mobile-nav trigger gated to max-width: 720px', () => {
  const css = readPublic('supplement.css');
  assert.ok(/@media \(max-width: 720px\)[\s\S]{0,200}\.kolm-mobile-nav__trigger/.test(css),
    'trigger only displayed on small viewports');
});

test('W707b #7 security.html includes supplement bundle + wf22 marker', () => {
  const html = readPublic('security.html');
  assert.ok(/src="\/supplement\.js"/.test(html), 'supplement.js included');
  assert.ok(/href="\/supplement\.css"/.test(html), 'supplement.css included');
  assert.ok(/data-test=["']wf22-security-page["']/.test(html), 'wf22-security-page marker present');
});

test('W707b #8 compare.html includes supplement bundle + wf23 marker', () => {
  const html = readPublic('compare.html');
  assert.ok(/src="\/supplement\.js"/.test(html), 'supplement.js included');
  assert.ok(/href="\/supplement\.css"/.test(html), 'supplement.css included');
  assert.ok(/data-test=["']wf23-compare-page["']/.test(html), 'wf23-compare-page marker present');
});

test('W707b #9 integrations.html includes supplement bundle + wf24 marker', () => {
  const html = readPublic('integrations.html');
  assert.ok(/src="\/supplement\.js"/.test(html), 'supplement.js included');
  assert.ok(/href="\/supplement\.css"/.test(html), 'supplement.css included');
  assert.ok(/data-test=["']wf24-integrations-page["']/.test(html), 'wf24-integrations-page marker present');
});

test('W707b #10 sw.js cache key has wave token >= 707', () => {
  const sw = readPublic('sw.js');
  const m = sw.match(/wave(\d{3,4})/);
  assert.ok(m, 'sw.js cache key has wave\\d{3,4} token');
  const n = parseInt(m[1], 10);
  assert.ok(n >= 707, `expected wave >= 707, got ${n}`);
});
