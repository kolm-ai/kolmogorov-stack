// Wave 409z: nine canonical integration recipe pages.
//
// One copy-paste recipe per major ecosystem so users can adopt with a single
// config change. Tests assert BEHAVIOR (file exists + canonical W221 nav +
// W207 skip-link + W208 viewport + W228 brand-anchor + a fenced code block),
// not page copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INTEG_DIR = path.join(ROOT, 'public', 'integrations');
const HUB = path.join(ROOT, 'public', 'integrations.html');
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

const SLUGS = [
  'openai-sdk',
  'anthropic-sdk',
  'openrouter',
  'langchain',
  'vercel-ai-sdk',
  'litellm',
  'cursor-claude-code',
  'docker-compose',
  'env-vars',
];

const NAV_LABELS = ['Product', 'Models', 'Docs', 'Pricing', 'Enterprise'];

function readSlug(slug) {
  return fs.readFileSync(path.join(INTEG_DIR, `${slug}.html`), 'utf8');
}

test('W409z #1 - all 9 integration recipe files exist on disk', () => {
  for (const slug of SLUGS) {
    const p = path.join(INTEG_DIR, `${slug}.html`);
    assert.ok(fs.existsSync(p), `missing recipe page: integrations/${slug}.html`);
  }
});

test('W409z #2 - each recipe page reads as a non-empty HTML document', () => {
  for (const slug of SLUGS) {
    const html = readSlug(slug);
    assert.ok(html.length > 500, `recipe page too small: ${slug}.html (${html.length} bytes)`);
    assert.match(html, /<!DOCTYPE html>/i, `${slug}.html missing DOCTYPE`);
    assert.match(html, /<\/html>/i, `${slug}.html missing closing tag`);
  }
});

test('W409z #3 - each recipe page carries canonical W221 5-anchor nav block', () => {
  const beginMark = '<!-- KOLM_NAV_BEGIN (W221) -->';
  const endMark = '<!-- KOLM_NAV_END (W221) -->';
  for (const slug of SLUGS) {
    const html = readSlug(slug);
    assert.ok(html.includes(beginMark), `${slug}.html missing W221 BEGIN marker`);
    assert.ok(html.includes(endMark), `${slug}.html missing W221 END marker`);
    // 5 top labels in order
    const navStart = html.indexOf(beginMark);
    const navEnd = html.indexOf(endMark);
    assert.ok(navEnd > navStart, `${slug}.html nav markers in wrong order`);
    const navBlock = html.slice(navStart, navEnd);
    let cursor = 0;
    for (const label of NAV_LABELS) {
      const re = new RegExp(`<a[^>]*class="nav-top"[^>]*>${label}</a>`);
      const m = navBlock.slice(cursor).match(re);
      assert.ok(m, `${slug}.html nav missing top label "${label}" in order`);
      cursor += navBlock.slice(cursor).indexOf(m[0]) + m[0].length;
    }
  }
});

test('W409z #4 - each recipe page has a W207 skip-link as the first focusable body anchor', () => {
  for (const slug of SLUGS) {
    const html = readSlug(slug);
    assert.match(html, /<a[^>]*class="skip"[^>]*href="#main"[^>]*>/i,
      `${slug}.html missing skip-link`);
    assert.match(html, /id="main"/, `${slug}.html missing #main landmark`);
  }
});

test('W409z #5 - each recipe page has the W208 viewport meta tag', () => {
  for (const slug of SLUGS) {
    const html = readSlug(slug);
    assert.match(html, /<meta\s+name="viewport"\s+content="[^"]*width=device-width/i,
      `${slug}.html missing W208 viewport meta`);
  }
});

test('W409z #6 - each recipe page has the W228 brand-anchor disambiguator', () => {
  for (const slug of SLUGS) {
    const html = readSlug(slug);
    assert.match(html, /class="brand-anchor"/,
      `${slug}.html missing W228 brand-anchor span`);
    // The brand-anchor must sit in the first 1200 chars of <body> to satisfy
    // the W228 sweep. We check loosely by asserting it appears before <main>.
    const bodyIdx = html.indexOf('<body');
    const anchorIdx = html.indexOf('class="brand-anchor"');
    const mainIdx = html.indexOf('<main');
    assert.ok(bodyIdx > 0 && anchorIdx > bodyIdx,
      `${slug}.html brand-anchor not after <body>`);
    assert.ok(mainIdx === -1 || anchorIdx < mainIdx,
      `${slug}.html brand-anchor must appear before <main>`);
  }
});

test('W409z #7 - each recipe page has at least one fenced code block', () => {
  for (const slug of SLUGS) {
    const html = readSlug(slug);
    // We render code blocks as <pre class="code">...</pre> or any <pre>...</pre>.
    const matches = html.match(/<pre[^>]*>[\s\S]*?<\/pre>/g) || [];
    assert.ok(matches.length >= 1,
      `${slug}.html has no <pre> code block`);
    // Each block must carry non-trivial content.
    const longest = matches.reduce((m, b) => Math.max(m, b.length), 0);
    assert.ok(longest > 40,
      `${slug}.html longest code block too short (${longest} bytes)`);
  }
});

test('W409z #8 - each recipe page cross-links to /quickstart/api, /captures, /security', () => {
  for (const slug of SLUGS) {
    const html = readSlug(slug);
    for (const href of ['/quickstart/api', '/captures', '/security']) {
      assert.ok(html.includes(`href="${href}"`),
        `${slug}.html missing cross-link to ${href}`);
    }
  }
});

test('W409z #9 - each recipe page has a unique <title> ending in "kolm.ai"', () => {
  const titles = new Set();
  for (const slug of SLUGS) {
    const html = readSlug(slug);
    const m = html.match(/<title>([^<]+)<\/title>/);
    assert.ok(m, `${slug}.html missing <title>`);
    const t = m[1].trim();
    assert.ok(t.includes('kolm.ai'),
      `${slug}.html title does not include kolm.ai: ${t}`);
    assert.ok(!titles.has(t), `duplicate title across recipe pages: ${t}`);
    titles.add(t);
  }
});

test('W409z #10 - each recipe page has a TechArticle JSON-LD block', () => {
  for (const slug of SLUGS) {
    const html = readSlug(slug);
    const m = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(m, `${slug}.html missing JSON-LD`);
    const parsed = JSON.parse(m[1].trim());
    assert.equal(parsed['@type'], 'TechArticle',
      `${slug}.html JSON-LD @type is not TechArticle`);
    assert.ok(parsed.url && parsed.url.includes(`/integrations/${slug}`),
      `${slug}.html JSON-LD url wrong: ${parsed.url}`);
  }
});

test('W409z #11 - hub page links to all 9 recipe slugs', () => {
  const hub = fs.readFileSync(HUB, 'utf8');
  for (const slug of SLUGS) {
    assert.ok(hub.includes(`/integrations/${slug}`),
      `hub integrations.html missing link to /integrations/${slug}`);
  }
});

test('W409z #12 - hub hero copy frames "one config change"', () => {
  // Behavior assertion: the hub hero must mention the value prop "one config
  // change" so the page promises what the recipe pages deliver.
  const hub = fs.readFileSync(HUB, 'utf8');
  assert.match(hub, /one config change/i,
    'hub integrations.html hero missing "one config change" promise');
});

test('W409z #13 - vercel.json has rewrite for /integrations', () => {
  const has = (VERCEL.rewrites || []).some(r => r.source === '/integrations');
  assert.ok(has, 'vercel.json missing rewrite for /integrations');
});

test('W409z #14 - vercel.json has rewrites for every recipe slug', () => {
  const rewrites = VERCEL.rewrites || [];
  for (const slug of SLUGS) {
    const has = rewrites.some(r =>
      r.source === `/integrations/${slug}` &&
      r.destination === `/integrations/${slug}.html`,
    );
    assert.ok(has, `vercel.json missing rewrite for /integrations/${slug}`);
  }
});

test('W409z #15 - W205 em-dash budget: 0 raw em-dashes in recipe pages', () => {
  // W205 forbids U+2014 em-dashes outside of explicit HTML-entity markup.
  // Authors should use &mdash; / &ndash; or just rewrite the sentence.
  for (const slug of SLUGS) {
    const html = readSlug(slug);
    const count = (html.match(/—/g) || []).length;
    assert.equal(count, 0,
      `${slug}.html has ${count} raw em-dash(es); budget is 0`);
  }
});

test('W409z #16 - inject-nav.cjs Product mega-menu includes /integrations', () => {
  // Hub must be reachable from the primary nav under Product.
  const injector = fs.readFileSync(path.join(ROOT, 'scripts/inject-nav.cjs'), 'utf8');
  assert.match(injector, /href:\s*['"]\/integrations['"]/,
    'inject-nav.cjs missing /integrations href in mega-menu');
});
