// W889-8.3 + W889-8.4 — programmatic SEO + GitHub OAuth + Book Demo CTA.
//
// Lock-in invariants (12 minimum). What this wave adds:
//   1. scripts/build-seo-pages.cjs exists; --dry-run exits 0.
//   2. Running the generator produces >=50 pages under public/compile/.
//   3. Random sample of 5 SEO pages contains JSON-LD Product schema.
//   4. Random sample of 5 SEO pages contains a `kolm compile` code block.
//   5. public/sitemap.xml lists all generated SEO pages.
//   6. src/router.js has GET /v1/auth/github and GET /v1/auth/github/callback.
//   7. Both GitHub OAuth aliases are in src/auth.js PUBLIC_API.
//   8. public/signup.html contains a "Continue with GitHub" button (greppable).
//   9. public/index.html contains a "Book demo" CTA with data-above-fold marker.
//  10. .env.example documents GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET.
//  11. No SEO page contains "honesty" or "honest".
//  12. vercel.json has rewrites for /compile/:slug + /book-demo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(REPO, 'public');
const COMPILE_DIR = path.join(PUBLIC, 'compile');
const SCRIPT = path.join(REPO, 'scripts', 'build-seo-pages.cjs');

function readText(p) { return fs.readFileSync(p, 'utf8'); }
function fileExists(p) { try { fs.statSync(p); return true; } catch { return false; } }

// Deterministic "random" sample so the suite is reproducible.
function sample(arr, n, seed = 0) {
  const out = [];
  const step = Math.max(1, Math.floor(arr.length / n));
  for (let i = 0; i < n && (seed + i * step) < arr.length; i++) out.push(arr[seed + i * step]);
  return out;
}

test('w889-8.3 #1 — scripts/build-seo-pages.cjs exists + --dry-run exits 0', () => {
  assert.ok(fileExists(SCRIPT), 'build-seo-pages.cjs must exist');
  const r = spawnSync(process.execPath, [SCRIPT, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `--dry-run exit code (stderr=${r.stderr})`);
  assert.match(r.stdout, /dry-run/, 'dry-run banner');
  assert.match(r.stdout, /\/compile\//, 'dry-run lists at least one /compile/ path');
});

test('w889-8.3 #2 — generator produces >=50 pages under public/compile/', () => {
  assert.ok(fileExists(COMPILE_DIR), 'public/compile/ exists');
  const files = fs.readdirSync(COMPILE_DIR).filter((f) => f.endsWith('.html') && f !== 'all.html' && f !== 'index.html');
  assert.ok(files.length >= 50, `expected >=50 SEO pages, got ${files.length}`);
});

test('w889-8.3 #3 — random sample of 5 SEO pages contains JSON-LD Product schema', () => {
  const files = fs.readdirSync(COMPILE_DIR).filter((f) => f.endsWith('.html') && f !== 'all.html' && f !== 'index.html').sort();
  const sampled = sample(files, 5, 0);
  assert.equal(sampled.length, 5, 'must sample 5 pages');
  for (const f of sampled) {
    const html = readText(path.join(COMPILE_DIR, f));
    assert.match(html, /<script type="application\/ld\+json">/, `${f} has JSON-LD script tag`);
    assert.match(html, /"@type":\s*"Product"/, `${f} has Product schema`);
  }
});

test('w889-8.3 #4 — random sample of 5 SEO pages contains a `kolm compile` code block', () => {
  const files = fs.readdirSync(COMPILE_DIR).filter((f) => f.endsWith('.html') && f !== 'all.html' && f !== 'index.html').sort();
  const sampled = sample(files, 5, 7);
  assert.equal(sampled.length, 5);
  for (const f of sampled) {
    const html = readText(path.join(COMPILE_DIR, f));
    assert.match(html, /<pre>[\s\S]*\$ kolm compile [\s\S]*<\/pre>/, `${f} has kolm compile <pre> block`);
  }
});

test('w889-8.3 #5 — public/sitemap.xml lists generated SEO pages', () => {
  const sitemap = readText(path.join(PUBLIC, 'sitemap.xml'));
  const files = fs.readdirSync(COMPILE_DIR).filter((f) => f.endsWith('.html') && f !== 'all.html' && f !== 'index.html').sort();
  // Spot-check 6 — sitemap MUST list each per-pair page.
  for (const f of sample(files, 6, 3)) {
    const slug = f.replace(/\.html$/, '');
    assert.ok(sitemap.includes(`https://kolm.ai/compile/${slug}`), `sitemap.xml must list /compile/${slug}`);
  }
});

test('w889-8.4 #6 — src/router.js has GET /v1/auth/github + /v1/auth/github/callback', () => {
  const src = readText(path.join(REPO, 'src', 'router.js'));
  // Both routes must exist as r.get('/v1/auth/github', ...) and r.get('/v1/auth/github/callback', ...).
  assert.match(src, /r\.get\(\s*['"]\/v1\/auth\/github['"]\s*,/, 'router must mount /v1/auth/github');
  assert.match(src, /r\.get\(\s*['"]\/v1\/auth\/github\/callback['"]\s*,/, 'router must mount /v1/auth/github/callback');
});

test('w889-8.4 #7 — both GitHub OAuth aliases are in PUBLIC_API', () => {
  const auth = readText(path.join(REPO, 'src', 'auth.js'));
  assert.match(auth, /p\s*===\s*['"]\/v1\/auth\/github['"]/, 'PUBLIC_API must include /v1/auth/github');
  assert.match(auth, /p\s*===\s*['"]\/v1\/auth\/github\/callback['"]/, 'PUBLIC_API must include /v1/auth/github/callback');
});

test('w889-8.4 #8 — public/signup.html has a "Continue with GitHub" button', () => {
  const html = readText(path.join(PUBLIC, 'signup.html'));
  assert.match(html, /Continue with GitHub/, 'signup page must show GitHub OAuth button');
});

test('w889-8.4 #9 — public/index.html has Book demo CTA with data-above-fold marker', () => {
  const html = readText(path.join(PUBLIC, 'index.html'));
  // Must contain "Book demo" text and a data-above-fold marker.
  assert.match(html, /Book demo/, 'homepage must contain Book demo CTA text');
  assert.match(html, /data-above-fold=/, 'homepage Book demo CTA must carry data-above-fold marker');
  // Marker must appear BEFORE the first </section>.
  const firstSectionClose = html.indexOf('</section>');
  const bookDemoIdx = html.indexOf('Book demo');
  assert.ok(bookDemoIdx > 0, 'Book demo string must be present');
  assert.ok(bookDemoIdx < firstSectionClose, 'Book demo CTA must appear above the first </section> (hero)');
});

test('w889-8.4 #10 — .env.example documents GITHUB_OAUTH_CLIENT_ID + _SECRET', () => {
  const envEx = readText(path.join(REPO, '.env.example'));
  assert.match(envEx, /GITHUB_OAUTH_CLIENT_ID/, '.env.example must mention GITHUB_OAUTH_CLIENT_ID');
  assert.match(envEx, /GITHUB_OAUTH_CLIENT_SECRET/, '.env.example must mention GITHUB_OAUTH_CLIENT_SECRET');
});

test('w889-8.3 #11 — no SEO page contains banned word', () => {
  const files = fs.readdirSync(COMPILE_DIR).filter((f) => f.endsWith('.html'));
  for (const f of files) {
    const html = readText(path.join(COMPILE_DIR, f)).toLowerCase();
    assert.ok(!/\bhonest\b/.test(html), `${f} must not contain banned word "honest"`);
    assert.ok(!/\bhonesty\b/.test(html), `${f} must not contain banned word "honesty"`);
  }
});

test('w889-8.3 #12 — vercel.json has rewrites for /compile/:slug + /book-demo', () => {
  const vercel = JSON.parse(readText(path.join(REPO, 'vercel.json')));
  const rewrites = vercel.rewrites || [];
  const slugRewrite = rewrites.find((r) => r.source === '/compile/:slug');
  assert.ok(slugRewrite, 'vercel.json must rewrite /compile/:slug -> /compile/:slug.html');
  assert.equal(slugRewrite.destination, '/compile/:slug.html');
  const bookDemo = rewrites.find((r) => r.source === '/book-demo');
  assert.ok(bookDemo, 'vercel.json must rewrite /book-demo');
});
