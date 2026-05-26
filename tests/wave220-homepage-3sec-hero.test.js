// Wave 220: homepage rewrite — Jung A Hong "3-sec value prop" critique.
// New H1 claims "AI compiler" as the SEO category. 5+ hero strips collapsed
// to ONE proof line + ONE artifact line. Cycle-word animation stripped.
// Single primary CTA → /captures (the observe→optimize→compile ladder).
// Behavior assertions on hero shape; bulk byte cuts come in W224's slop sweep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');

// First ~4KB after the H1 = the visible-on-load hero region.
const heroIdx = INDEX.search(/<h1[\s>]/i);
const HERO = heroIdx >= 0 ? INDEX.slice(heroIdx, heroIdx + 4000) : '';

test('W220 #1 - hero claims "AI compiler" as the category', () => {
  // Must contain the exact category claim within the hero region.
  // W271 relocated the SEO claim from inside the H1 into a sibling
  // visually-hidden span / SEO chip — so the assertion is hero-scoped,
  // not H1-scoped. The middle-dot separator keeps em-dash budget intact
  // (see #6 below).
  assert.match(HERO, /kolm\.ai/i, 'hero must surface kolm.ai brand');
  assert.match(HERO, /the AI compiler/i, 'hero must claim "the AI compiler" category');
});

test('W220 #2 - cycle-word animation stripped from H1', () => {
  // The H1 must NOT contain the cycle-word span anymore.
  const h1Match = INDEX.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  assert.ok(h1Match, 'h1 present');
  assert.ok(!/cycle-word/.test(h1Match[1]), 'H1 must not contain .cycle-word span');
  assert.ok(!/cw-ghost/.test(h1Match[1]), 'H1 must not contain .cw-ghost');
  assert.ok(!/cw-cur/.test(h1Match[1]), 'H1 must not contain .cw-cur');
  assert.ok(!/data-words=/.test(h1Match[1]), 'H1 must not carry data-words attribute');
});

test('W220 #3 - cycle-word IIFE removed (no live DOM dependency on .cycle-word)', () => {
  // The IIFE that drove the swap must be gone; no live JS may depend on
  // the .cycle-word selector.
  assert.ok(!/querySelector\(['"][^'"]*\.cycle-word/.test(INDEX),
    'cycle-word querySelector must be removed');
  assert.ok(!/setInterval\(swap,\s*3200\)/.test(INDEX),
    'cycle-word swap interval must be removed');
});

test('W220 #4 - new lede is the 3-sec value prop, not the dense pre-W220 lede', () => {
  // Behavior assertion (not copy lock): the lede must follow the 4-beat
  // "Capture / Compile / Ship / Audit" structure. W245 widened "Ship it on
  // your hardware" to "Ship it on every device you own" — both satisfy the
  // ship-beat, so we match on the action verb only.
  // W335 second-pass hero rescue moved the lede paragraph below the cinematic
  // demo into its own framed section to give the above-the-fold hero room to
  // breathe; the data-w260="lede-beats" marker is preserved on the moved
  // element. We assert lede-beat presence anywhere in INDEX (not just the
  // 4KB-after-H1 slice) since the lede was moved, not deleted.
  assert.match(INDEX, /Capture your real prompts/i, 'lede must open with capture beat');
  assert.match(INDEX, /Compile them into your own model/i, 'lede must include compile beat');
  assert.match(INDEX, /Ship it on/i, 'lede must include ship beat');
  assert.match(INDEX, /Audit every call/i, 'lede must close with audit beat');
  assert.match(INDEX, /data-w260="lede-beats"/, 'lede-beats marker must be preserved on the moved element');
  // Old lede must be gone.
  assert.ok(!/Describe what your AI should do\. kolm builds it on your data/.test(INDEX),
    'pre-W220 dense lede must be replaced');
});

test('W220 #5 - primary CTA targets /captures (W213 dashboard) [W387: copy relaxed]', () => {
  // Hero must surface /captures as a primary action — the observe→optimize→compile
  // ladder entry point. W387 (2026-05-18) relaxed the exact label match because
  // the W387 hero rewrite changed "See it on your captures" → "See your duplicate
  // API calls" for empathy. The structural requirement (anchor to /captures with
  // primary class) is preserved.
  assert.match(HERO, /<a[^>]*href=["']\/captures["'][^>]*class=["'][^"']*\bbtn\b[^"']*primary/i,
    'primary CTA must link to /captures');
});

test('W220 #6 - em-dash budget on index.html still <= 1 (W205 lock)', () => {
  const raw = (INDEX.match(/—/g) || []).length;
  const ent = (INDEX.match(/&mdash;/g) || []).length;
  assert.ok(raw + ent <= 1, `index.html em-dash count ${raw + ent} > budget 1`);
});

test('W220 #7 - hero collapses 5+ moat strips into ONE proof + ONE artifact', () => {
  // Single hero-quant line (proof) + single hero-artifact line (live download).
  // The pre-W220 hero-promise + hero-moat + hero-stack strips must be removed.
  // W335 second-pass rescue: hero-quant / hero-artifact may carry additional
  // classes (w335-proof / w335-artifact) for the new section's spacing, so the
  // assertion accepts the class as one token in a multi-class attribute.
  assert.match(HERO, /class=["'][^"']*\bhero-quant\b/, 'hero must carry a hero-quant proof line');
  assert.match(HERO, /class=["'][^"']*\bhero-artifact\b/, 'hero must carry a hero-artifact artifact line');
  assert.ok(!/class=["']hero-promise["']/.test(INDEX),
    'hero-promise strip must be removed (collapsed into lede)');
  assert.ok(!/class=["']hero-moat["']/.test(INDEX),
    'hero-moat strip must be removed (collapsed into category claim)');
  assert.ok(!/class=["']hero-stack["']/.test(INDEX),
    'hero-stack strip must be removed (collapsed into footer/about elsewhere)');
});

test('W220 #8 - hero keeps a concrete .kolm artifact proof [W405: artifact-agnostic]', () => {
  // W334 dropped "0 PHI leaks" + "HIPAA Safe Harbor" from the hero proof strip
  // because PHI/HIPAA framing was too narrow. W366 dropped the K=0.982 jargon
  // from the visible proof strip because regular users don't decode K-score.
  // W387 finished the cleanup: the K-score widget below the hero still ships
  // the K=0.982 leaderboard, but the hero region itself surfaces plain-English
  // proof + the .kolm artifact.
  // W405 (2026-05-19) relaxed from `phi-redactor.kolm` to any *.kolm artifact:
  // user feedback "we are not an insurance tech company get this shit out of
  // the hero. people care about frontier distilled models." Hero artifact now
  // references a frontier-distilled student (e.g., qwen3.6-27b.kolm). The
  // behavior assertion is: hero has ≥1 anchor to a concrete .kolm artifact.
  assert.match(HERO, /<a[^>]*>[^<]*\.kolm[^<]*<\/a>/i,
    'hero must carry an anchor to a concrete .kolm artifact');
});

test('W220 #9 - persona signal (W205 lock) still present in hero', () => {
  // W205 PERSONA list — at least one must hit in firstHero(3KB).
  const PERSONA = ['developer', 'engineer', 'procurement', 'compliance', 'data',
    'architect', 'security', 'regulated', 'HIPAA', 'SOC2',
    'enterprise', 'install', 'CLI', 'model', 'distill', 'distillation'];
  const hit = PERSONA.some(p => new RegExp(`\\b${p}\\b`, 'i').test(HERO));
  assert.ok(hit, 'hero must hit at least one PERSONA token (W205 lock)');
});

test('W220 #10 - index.html ships substantive content (W864: byte floor relaxed)', () => {
  // W864 (2026-05-25): user audit flagged the W220/W205 byte-floor recovery
  // payload as internal scaffolding rendering publicly. Hidden div with
  // raw spec text was deleted. New contract: page ships substantive content
  // (>= 50 KB) but no padded recovery payload is required. The original
  // 200 KB floor was a regression guard against a specific 2026-04 cut;
  // post-W864 the homepage is intentionally tighter (~100 KB visible).
  const bytes = fs.statSync(path.join(ROOT, 'public/index.html')).size;
  assert.ok(bytes >= 50 * 1024, `index.html ${bytes} B below 50 KB minimum`);
});

test('W220 #11 - sw.js CACHE wave-floor >= 220', () => {
  const m = SW.match(/const\s+CACHE\s*=\s*'kolm-v\d+-2026-\d{2}-\d{2}-[^']*?wave(\d+)/);
  assert.ok(m, 'CACHE slug present');
  assert.ok(parseInt(m[1], 10) >= 220, 'CACHE wave >= 220 (got ' + m[1] + ')');
});

test('W220 #12 - "AI compiler" category claim is in above-the-fold body window (SEO)', () => {
  // The 3-sec value prop must be visible without scrolling. W864 (2026-05-25)
  // relaxed the window from 3 KB to 8 KB of <body> because the modern
  // homepage carries a richer nav + theme-toggle bootstrap script ahead of
  // the H1; the H1 itself now lands ~5 KB into body and the SEO chip a few
  // hundred bytes later. The claim must still appear in the first viewport's
  // worth of HTML, not buried below the fold.
  const bodyMatch = INDEX.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  assert.ok(bodyMatch, 'body present');
  const above = bodyMatch[1].slice(0, 8000);
  assert.match(above, /the AI compiler/i,
    'AI compiler category claim must be in first 8 KB of body');
});
