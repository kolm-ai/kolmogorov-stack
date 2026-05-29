// W921 — Website / Marketing / Conversion surface lock-in.
//
// Covers the five shipped specs:
//   #54 programmatic SEO comparison/integration/use-case/vertical generator
//   #50 verifiable social-proof rail (build-time SoT + X04-bound numbers)
//   #55 real-time trust/status strip + public status route module
//   #51 single-dominant-CTA hero re-rank + intent-segmented secondary
//   #53 docs IA theme-token fix (in-scope slice)
//
// Pure node:test + node:assert, static-HTML/regex + in-process module imports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// #54 — programmatic SEO generator
// ---------------------------------------------------------------------------

const seo = require('../scripts/build-comparison-seo.cjs');

test('W921 SEO #1 - catalog loads all four families with rows', () => {
  const cat = seo.loadSeoCatalog();
  assert.ok(cat.competitors.length >= 4, 'expected >=4 competitors');
  assert.ok(cat.integrations.length >= 3, 'expected >=3 integrations');
  assert.ok(cat.usecases.length >= 3, 'expected >=3 use-cases');
  assert.ok(cat.verticals.length >= 3, 'expected >=3 verticals');
});

test('W921 SEO #2 - generator is idempotent (rendered output is stable)', () => {
  const a = seo.build({ check: true, write: false });
  // In --check mode, written>0 means the on-disk pages drift from the renderer.
  assert.equal(a.written, 0, `expected 0 drift, got ${a.written}/${a.total}`);
});

test('W921 SEO #3 - every generated page: 1 H1, canonical, parseable JSON-LD, bounded title/desc, proof link', () => {
  const cat = seo.loadSeoCatalog();
  const pages = seo.renderAll(cat);
  assert.ok(pages.length >= 16, 'expected >=16 generated pages');
  for (const p of pages) {
    const h = p.html;
    const h1 = (h.match(/<h1[\s>]/g) || []).length;
    assert.equal(h1, 1, `${p.canonicalPath}: must have exactly one <h1>`);
    assert.match(h, /<link rel="canonical"/, `${p.canonicalPath}: needs canonical`);
    const title = (h.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    assert.ok(title.length > 0 && title.length <= 65, `${p.canonicalPath}: title len ${title.length}`);
    const desc = (h.match(/name="description" content="([\s\S]*?)"/) || [])[1] || '';
    assert.ok(desc.length >= 50 && desc.length <= 165, `${p.canonicalPath}: desc len ${desc.length}`);
    const ld = (h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1];
    assert.ok(ld, `${p.canonicalPath}: missing JSON-LD`);
    const parsed = JSON.parse(ld); // throws on bad JSON
    const types = parsed['@graph'].map((x) => x['@type']);
    assert.ok(types.includes('SoftwareApplication'), `${p.canonicalPath}: needs SoftwareApplication`);
    assert.ok(types.includes('BreadcrumbList'), `${p.canonicalPath}: needs BreadcrumbList`);
    // proof link to a real artifact
    assert.match(h, /href="\/(benchmarks|case-studies|verify-prod)/, `${p.canonicalPath}: needs a proof link`);
  }
});

test('W921 SEO #4 - comparison pages carry FAQPage JSON-LD and a >=6-row matrix', () => {
  const cat = seo.loadSeoCatalog();
  for (const row of cat.competitors) {
    const p = seo.renderComparisonPage(row, { catalog: cat });
    const ld = JSON.parse((p.html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/))[1]);
    const types = ld['@graph'].map((x) => x['@type']);
    assert.ok(types.includes('FAQPage'), `${row.slug}: comparison page must carry FAQPage JSON-LD`);
    const rows = (p.html.match(/<tr>/g) || []).length;
    assert.ok(rows >= 6, `${row.slug}: matrix has ${rows} rows, need >=6`);
  }
});

test('W921 SEO #5 - integration pages carry HowTo JSON-LD', () => {
  const cat = seo.loadSeoCatalog();
  for (const row of cat.integrations) {
    const p = seo.renderIntegrationPage(row, { catalog: cat });
    const ld = JSON.parse((p.html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/))[1]);
    const types = ld['@graph'].map((x) => x['@type']);
    assert.ok(types.includes('HowTo'), `${row.slug}: integration page must carry HowTo JSON-LD`);
  }
});

test('W921 SEO #6 - renderBlufBlock enforces the 40-75 word window', () => {
  assert.throws(() => seo.renderBlufBlock('q?', 'three short words'), /40-75/);
  const longText = Array(120).fill('word').join(' ');
  assert.throws(() => seo.renderBlufBlock('q?', longText), /40-75/);
  const ok = Array(50).fill('word').join(' ');
  const html = seo.renderBlufBlock('q?', ok);
  assert.match(html, /data-bluf="1"/);
});

test('W921 SEO #7 - computeUniqueRatio ~1 for disjoint text, low for duplicates', () => {
  const a = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
  const b = 'kilo lima mike november oscar papa quebec romeo sierra tango';
  assert.ok(seo.computeUniqueRatio(a, [b]) > 0.9, 'disjoint text should be highly unique');
  assert.ok(seo.computeUniqueRatio(a, [a]) < 0.3, 'identical text should be near zero unique');
});

test('W921 SEO #8 - assertProofRefsResolve throws on dangling ref, passes on real one', () => {
  assert.throws(() => seo.assertProofRefsResolve(['/benchmarks/does-not-exist.json'], PUBLIC), /dangling/);
  assert.doesNotThrow(() => seo.assertProofRefsResolve(['/benchmarks/trinity-500-benchmark.json'], PUBLIC));
  assert.doesNotThrow(() => seo.assertProofRefsResolve(['/verify-prod'], PUBLIC));
});

test('W921 SEO #9 - generated pages exist on disk and pass the thin-content audit gate', () => {
  // The build must have been run; assert representative files exist.
  for (const f of ['compare/modal.html', 'integrations/llamaindex.html', 'use-cases/support-deflection.html', 'for/insurance.html']) {
    assert.ok(fs.existsSync(path.join(PUBLIC, f)), `generated page missing: ${f}`);
  }
  const audit = require('../scripts/audit-seo-pages.cjs');
  const r = audit.auditSeoPages({ publicDir: PUBLIC });
  assert.equal(r.pass, true, `audit failed: thin=${JSON.stringify(r.thin)} proof=${JSON.stringify(r.brokenProof)} jsonld=${JSON.stringify(r.badJsonLd)}`);
  assert.deepEqual(r.thin, []);
  assert.deepEqual(r.brokenProof, []);
  assert.deepEqual(r.badJsonLd, []);
});

test('W921 SEO #10 - generated pages do not clobber hand-authored, test-pinned compare pages', () => {
  // The wave274-pinned pages must keep their distinct slugs untouched.
  for (const pinned of ['kolm-vs-openpipe-2026', 'kolm-vs-predibase-2026', 'kolm-vs-together-2026', 'kolm-vs-proxis']) {
    const cat = seo.loadSeoCatalog();
    assert.ok(!cat.competitors.some((c) => `kolm-vs-${c.slug}` === pinned || c.slug === pinned),
      `catalog slug must not collide with hand-authored ${pinned}`);
  }
});

test('W921 SEO #11 - generated families appear in segmented sitemaps and the sitemap index', () => {
  for (const fam of ['compare', 'integrations', 'use-cases', 'for']) {
    const p = path.join(PUBLIC, `sitemap-seo-${fam}.xml`);
    assert.ok(fs.existsSync(p), `missing segmented sitemap for ${fam}`);
  }
  const idx = read('public/sitemap-seo-index.xml');
  assert.match(idx, /sitemap-seo-compare\.xml/);
  // main sitemap also includes the generated pages
  const main = read('public/sitemap.xml');
  assert.match(main, /\/compare\/modal/);
  assert.match(main, /\/integrations\/llamaindex/);
});

// ---------------------------------------------------------------------------
// #50 — verifiable social-proof rail
// ---------------------------------------------------------------------------

const social = require('../scripts/build-social-proof.cjs');

test('W921 SOCIAL #1 - applyDisplayPolicy gates the >=1000-star floor', () => {
  assert.equal(social.applyDisplayPolicy({ stargazers_count: 999 }).show_star_count, false);
  assert.equal(social.applyDisplayPolicy({ stargazers_count: 999 }).lead_with, 'chips');
  assert.equal(social.applyDisplayPolicy({ stargazers_count: 1000 }).show_star_count, true);
  assert.equal(social.applyDisplayPolicy({ stargazers_count: 1000 }).lead_with, 'stars');
  assert.equal(social.applyDisplayPolicy({ stargazers_count: null }).show_star_count, false);
});

test('W921 SOCIAL #2 - fetchOssTraction degrades to last-good (offline) and never fabricates a count', async () => {
  const oss = await social.fetchOssTraction('kolm-ai/kolm', { offline: true, prev: null });
  assert.equal(oss.stale, true);
  assert.equal(oss.available, false);
  assert.equal(oss.stargazers_count, null, 'must not fabricate a star count offline');
});

test('W921 SOCIAL #3 - benchmark proof cards reuse X04-fixtured substrings', () => {
  const cards = social.extractBenchmarkProof();
  assert.ok(cards.length >= 3, 'expected >=3 benchmark proof cards');
  const fixtures = JSON.parse(read('data/x04-claim-fixtures.json')).fixtures.map((f) => f.claim_substring);
  for (const c of cards) {
    assert.ok(fixtures.includes(c.claim_substring), `proof card "${c.value}" has no X04 fixture (substring ${c.claim_substring})`);
  }
});

test('W921 SOCIAL #4 - social-proof.json artifact exists and is well-formed', () => {
  const a = JSON.parse(read('public/social-proof.json'));
  assert.equal(a.spec, 'kolm-social-proof-1');
  assert.ok(Array.isArray(a.proof) && a.proof.length >= 3);
  assert.ok(Array.isArray(a.case_studies) && a.case_studies.length >= 1);
  // testimonial is anonymized-role only — no named person policy.
  assert.match(a.testimonial.who, /anonymized/i);
});

test('W921 SOCIAL #5 - homepage rail is present, visible, and every number traces to the SoT', () => {
  const idx = read('public/index.html');
  assert.match(idx, /data-w921="proof-rail"/, 'proof rail section must be present');
  assert.match(idx, /class="ks-proof-rail"/);
  // every value rendered on a proof card must appear in social-proof.json
  const a = JSON.parse(read('public/social-proof.json'));
  const railBlock = idx.slice(idx.indexOf('data-w921="proof-rail"'), idx.indexOf('data-w921="proof-rail"') + 4000);
  for (const c of a.proof) {
    assert.ok(railBlock.includes(c.value), `rail must render proof value "${c.value}" from the SoT`);
  }
  // no fabricated star count is rendered when below floor
  assert.equal(a.policy.show_star_count, false);
  assert.ok(!/\b\d{3,4} stars\b/.test(railBlock), 'must not render a star count below the floor');
  // a /compare link and case-study links are present
  assert.match(railBlock, /href="\/compare"/);
  assert.match(railBlock, /\/case-studies\//);
});

// ---------------------------------------------------------------------------
// #55 — real-time trust/status strip + public status route module
// ---------------------------------------------------------------------------

test('W921 STATUS #1 - status route module: summary shape + degradation', async () => {
  const mod = await import('../src/website-status-routes.js');
  const okDeps = { store: { backendInfo: () => ({ driver: 'json' }), all: () => [] }, loadSigner: () => ({ ok: true }) };
  const s = mod.statusSummary(okDeps);
  assert.ok(['none', 'minor', 'major', 'critical'].includes(s.status.indicator));
  for (const c of s.components) {
    assert.ok(['operational', 'degraded_performance', 'partial_outage', 'major_outage'].includes(c.status));
  }
  // signer failure degrades exactly one component, never fakes operational.
  const badDeps = { store: { backendInfo: () => ({ driver: 'json' }) }, loadSigner: () => { throw new Error('x'); } };
  const s2 = mod.statusSummary(badDeps);
  assert.equal(s2.status.indicator, 'minor');
  assert.ok(s2.components.some((c) => c.id === 'signing' && c.status === 'degraded_performance'));
});

test('W921 STATUS #2 - publicReceiptStats exposes only the whitelisted PII-free keys', async () => {
  const mod = await import('../src/website-status-routes.js');
  mod._resetReceiptCacheForTests();
  const deps = { store: { all: (t) => (t === 'observations' ? [{ id: 'rcpt_a', created_at: new Date().toISOString() }, { receipt_id: 'rcpt_b', tenant_id: 'should_not_leak', created_at: '2020-01-01T00:00:00Z' }] : []) } };
  const r = mod.publicReceiptStats({}, deps);
  assert.deepEqual(Object.keys(r).sort(), ['last_24h', 'last_receipt_at', 'last_receipt_id', 'ok', 'total', 'verify_url'].sort());
  assert.equal(r.total, 2);
  assert.ok(r.last_24h <= r.total);
  assert.ok(!JSON.stringify(r).includes('should_not_leak'), 'no tenant id may leak');
});

test('W921 STATUS #3 - homepage trust strip is present, non-hidden, motion-gated, degrades gracefully', () => {
  const idx = read('public/index.html');
  assert.match(idx, /data-w921="trust-strip"/);
  // strip is not aria-hidden
  const stripStart = idx.indexOf('data-w921="trust-strip"');
  const stripTag = idx.slice(idx.lastIndexOf('<', stripStart), idx.indexOf('>', stripStart) + 1);
  assert.ok(!/aria-hidden="true"/.test(stripTag), 'trust strip must be visible (not aria-hidden)');
  // widget reads the new routes and falls back to /health + /v1/status
  assert.match(idx, /\/v1\/status\/receipts/);
  assert.match(idx, /\/v1\/status\/summary/);
  assert.match(idx, /prefers-reduced-motion/);
  assert.match(idx, /document\.hidden/, 'polling must pause on hidden tab');
});

test('W921 STATUS #4 - status.html consumes /v1/status/summary and stops fabricating 99.97% green', () => {
  const s = read('public/status.html');
  assert.match(s, /\/v1\/status\/summary/, 'status.html must consume the real summary route');
  // the JS fallback no longer paints a fabricated 99.97%
  assert.ok(!s.includes("'99.97%'"), 'status.html JS must not hardcode 99.97%');
  // the w890-15 monitoring anchor is preserved
  assert.match(s, /w890-15-live-health/, 'must preserve the wave890 monitoring lock-in anchor');
});

// ---------------------------------------------------------------------------
// #51 — single-dominant CTA hierarchy
// ---------------------------------------------------------------------------

function heroCtaStrip(idx) {
  const i = idx.indexOf('data-w921="cta-hierarchy"');
  return idx.slice(i, idx.indexOf('</p>', i) + 4 || i + 1200);
}

test('W921 CTA #1 - hero has exactly one primary + at most one secondary in the strip', () => {
  const idx = read('public/index.html');
  const i = idx.indexOf('class="ks-hero__ctas"');
  const strip = idx.slice(i, idx.indexOf('</div>', i) + 6);
  const primary = (strip.match(/ks-btn--primary/g) || []).length;
  const ghost = (strip.match(/ks-btn--ghost/g) || []).length;
  assert.equal(primary, 1, 'hero strip must have exactly one primary CTA');
  assert.ok(ghost <= 1, `hero strip must have at most one ghost secondary, got ${ghost}`);
});

test('W921 CTA #2 - demoted actions exist at link weight in the aux line (no dead ends)', () => {
  const idx = read('public/index.html');
  const i = idx.indexOf('data-w921="cta-aux"');
  assert.ok(i > 0, 'aux line must exist');
  const aux = idx.slice(i, idx.indexOf('</p>', i) + 4);
  assert.match(aux, /href="#chat"/, 'Try-it-without-signing-up must remain reachable');
  assert.match(aux, /href="\/demo-live"/, 'demo must remain reachable');
  assert.match(aux, /ks-btn--link/, 'demoted actions use the quiet link weight');
});

test('W921 CTA #3 - locked hero markers preserved (data-w260 v02-strip + data-w271 cta-primary -> /quickstart)', () => {
  const idx = read('public/index.html');
  const heroStart = idx.search(/<h1[\s>]/i);
  const hero = idx.slice(heroStart, heroStart + 4500);
  assert.match(idx, /data-w260="v02-strip"/);
  assert.match(hero, /<a[^>]*href="\/quickstart"[^>]*data-w271="cta-primary"/i, 'W271 primary marker preserved');
  assert.match(hero, /Compile a free \.kolm in 60 seconds/i, 'W271 primary copy preserved');
});

test('W921 CTA #4 - compare.html closing CTA also reduced to 1 primary + 1 secondary', () => {
  const c = read('public/compare.html');
  const i = c.indexOf('data-w921="cta-hierarchy"');
  assert.ok(i > 0, 'compare.html closing CTA must carry the hierarchy marker');
  const block = c.slice(i, c.indexOf('</div>', i) + 6);
  assert.equal((block.match(/ks-btn--primary/g) || []).length, 1);
  assert.ok((block.match(/ks-btn--ghost/g) || []).length <= 1);
});

// ---------------------------------------------------------------------------
// #53 — docs IA theme-token fix (in-scope slice)
// ---------------------------------------------------------------------------

test('W921 DOCS #1 - docs-shell.css has no near-black hardcoded hex fallback', () => {
  const css = read('public/docs-shell.css');
  assert.ok(!/#0b0d10|#0c0e12/.test(css), 'docs-shell.css must not hardcode near-black dark-theme hex');
});

// ---------------------------------------------------------------------------
// theme discipline: new marketing CSS uses cool-slate tokens, no warm/amber
// ---------------------------------------------------------------------------

test('W921 THEME #1 - seo-pages.css uses cool-slate tokens, no warm/brown/orange/amber hex', () => {
  const css = read('public/seo-pages.css');
  assert.match(css, /--ks-color-(text|surface|border)-/, 'must use cool-slate binding tokens');
  // no obviously-warm hex literals (burnt sienna / amber families)
  assert.ok(!/#c2410c|#d9770[0-9a-f]|#b4530[0-9a-f]|#ea580c|#f59e0b/i.test(css), 'no warm/amber accent hex');
});
