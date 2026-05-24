// Wave WF01 — Design system v1 (W707 sprint, master plan PART VII).
// Locks in the new --ks-* token scale, component primitive selectors,
// and showcase page. Verifies that the rewrite of /design-tokens.css
// PRESERVED every legacy --brand-* / --surface-* / --ink-* / --line-* /
// --status-* / --space-* / --radius-* / --shadow-* / --duration-* /
// --ease-* / --text-* / --z-* / --accent-* / --kolm-* token that the
// ~20 production HTML pages consume.
//
// Each test pins one atomic deliverable:
//   1  files exist
//   2  legacy tokens preserved (presence + value-resolution check)
//   3  WF01 color tokens present (brand, surface x4, text x4, border x3,
//      state x4 x 3)
//   4  WF01 space scale present (4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96)
//   5  WF01 type scale present (12 / 14 / 16 / 18 / 24 / 32 / 48 / 64 / 96)
//   6  WF01 radius scale present (4 / 8 / 12 / 16 / 24)
//   7  WF01 shadow scale present (sm / md / lg / xl / 2xl + focus)
//   8  WF01 motion scale present (75 / 150 / 250 / 350 / 500 ms + curves)
//   9  Font stack token names present + Geist + Geist Mono declared
//  10  Component primitive selectors present (12 components)
//  11  Button variants x sizes complete (5 variants x 3 sizes)
//  12  Light-mode override block present and overrides --ks-color-*
//  13  prefers-reduced-motion clause present
//  14  Showcase page exists, links design-tokens.css + wf01-components.css
//  15  No raw hex inside wf01-components.css rule bodies (token-driven lock)
//  16  vercel.json /design-system rewrite present
//  17  a11y posture: visible focus rings + aria attrs in showcase
//  18  CSS-var actual resolution sanity check (custom property lookup)
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');
const TOKENS = path.join(PUBLIC, 'design-tokens.css');
const COMPONENTS = path.join(PUBLIC, 'wf01-components.css');
const SHOWCASE = path.join(PUBLIC, 'design-system.html');
const VERCEL = path.join(REPO, 'vercel.json');

const read = (p) => fs.readFileSync(p, 'utf8');

// helper — does the css declare the given custom property anywhere?
function hasToken(css, name) {
  const re = new RegExp(`--${name.replace(/^--/, '')}\\s*:`);
  return re.test(css);
}

// helper — get the first value assigned to a CSS custom property.
function tokenValue(css, name) {
  const re = new RegExp(`--${name.replace(/^--/, '')}\\s*:\\s*([^;]+);`);
  const m = css.match(re);
  return m ? m[1].trim() : null;
}

test('1. all three WF01 files exist and meet minimum size', () => {
  assert.ok(fs.existsSync(TOKENS), 'design-tokens.css missing');
  assert.ok(fs.existsSync(COMPONENTS), 'wf01-components.css missing');
  assert.ok(fs.existsSync(SHOWCASE), 'design-system.html missing');
  assert.ok(fs.statSync(TOKENS).size > 6 * 1024,
    `design-tokens.css too small (${fs.statSync(TOKENS).size} bytes)`);
  assert.ok(fs.statSync(COMPONENTS).size > 10 * 1024,
    `wf01-components.css too small (${fs.statSync(COMPONENTS).size} bytes)`);
  assert.ok(fs.statSync(SHOWCASE).size > 18 * 1024,
    `design-system.html too small (${fs.statSync(SHOWCASE).size} bytes)`);
});

test('2. legacy W598/W604 tokens preserved (downstream test pin)', () => {
  const css = read(TOKENS);
  // Brand layer
  for (const name of [
    'brand-primary', 'brand-primary-strong', 'brand-primary-soft', 'brand-primary-edge',
    'brand-paper', 'brand-paper-strong', 'brand-paper-dim',
  ]) {
    assert.ok(hasToken(css, name), `legacy token --${name} REMOVED — would break consumer pages`);
  }
  // Surface + ink + line + status
  for (const name of [
    'surface-0', 'surface-1', 'surface-2', 'surface-3', 'surface-input',
    'ink-1', 'ink-2', 'ink-3', 'ink-4',
    'line-1', 'line-2', 'line-3', 'line-strong',
    'status-good', 'status-warn', 'status-bad', 'status-info',
  ]) {
    assert.ok(hasToken(css, name), `legacy token --${name} REMOVED`);
  }
  // Space + radius + shadow + duration + ease + text + z
  for (const name of [
    'space-0', 'space-1', 'space-5', 'space-10',
    'radius-sm', 'radius-md', 'radius-lg', 'radius-xl', 'radius-pill',
    'shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-xl', 'shadow-glow-brand',
    'duration-instant', 'duration-fast', 'duration-base', 'duration-slow', 'duration-deliberate',
    'ease-out', 'ease-in', 'ease-in-out', 'ease-spring',
    'text-xs', 'text-sm', 'text-base', 'text-md', 'text-lg', 'text-xl',
    'text-2xl', 'text-3xl', 'text-hero',
    'z-base', 'z-elevated', 'z-sticky', 'z-overlay', 'z-modal', 'z-toast',
  ]) {
    assert.ok(hasToken(css, name), `legacy token --${name} REMOVED`);
  }
  // Legacy aliases (kolm-* / accent-* / good / warn / bad)
  for (const name of [
    'accent-cyan', 'accent-amber',
    'kolm-teal', 'kolm-cyan', 'kolm-amber', 'kolm-red',
    'kolm-ink', 'kolm-muted', 'kolm-faint',
    'good', 'warn', 'bad',
  ]) {
    assert.ok(hasToken(css, name), `legacy alias --${name} REMOVED`);
  }
});

test('3. WF01 color tokens present (brand + surface x4 + text x4 + border x3 + state x4 x 3)', () => {
  const css = read(TOKENS);
  // brand
  for (const name of [
    'ks-color-brand-primary',
    'ks-color-brand-primary-hover',
    'ks-color-brand-primary-active',
    'ks-color-brand-secondary',
    'ks-color-brand-on-primary',
  ]) {
    assert.ok(hasToken(css, name), `WF01 token --${name} missing`);
  }
  // surface x 4
  for (let i = 0; i <= 3; i++) {
    assert.ok(hasToken(css, `ks-color-surface-${i}`), `--ks-color-surface-${i} missing`);
  }
  // text x 4
  for (let i = 1; i <= 4; i++) {
    assert.ok(hasToken(css, `ks-color-text-${i}`), `--ks-color-text-${i} missing`);
  }
  // border x 3
  for (let i = 1; i <= 3; i++) {
    assert.ok(hasToken(css, `ks-color-border-${i}`), `--ks-color-border-${i} missing`);
  }
  // state x 4 x 3
  for (const tone of ['success', 'warning', 'error', 'info']) {
    for (let i = 1; i <= 3; i++) {
      assert.ok(hasToken(css, `ks-color-${tone}-${i}`),
        `--ks-color-${tone}-${i} missing`);
    }
  }
  // focus ring
  assert.ok(hasToken(css, 'ks-color-focus-ring'), '--ks-color-focus-ring missing');
});

test('4. WF01 space scale present (4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96)', () => {
  const css = read(TOKENS);
  for (const n of [4, 8, 12, 16, 24, 32, 48, 64, 96]) {
    assert.ok(hasToken(css, `ks-space-${n}`), `--ks-space-${n} missing`);
    const v = tokenValue(css, `ks-space-${n}`);
    assert.ok(v && v.endsWith('px'),
      `--ks-space-${n} value should be a px literal (got ${v})`);
    assert.strictEqual(parseInt(v, 10), n,
      `--ks-space-${n} should resolve to ${n}px (got ${v})`);
  }
});

test('5. WF01 type scale present (12 / 14 / 16 / 18 / 24 / 32 / 48 / 64 / 96)', () => {
  const css = read(TOKENS);
  for (const n of [12, 14, 16, 18, 24, 32, 48, 64, 96]) {
    assert.ok(hasToken(css, `ks-type-${n}`), `--ks-type-${n} missing`);
    const v = tokenValue(css, `ks-type-${n}`);
    assert.strictEqual(parseInt(v, 10), n,
      `--ks-type-${n} should resolve to ${n}px (got ${v})`);
  }
  // line-height + tracking + weight tokens
  for (const name of [
    'ks-leading-tight', 'ks-leading-snug', 'ks-leading-normal', 'ks-leading-relaxed',
    'ks-tracking-tight', 'ks-tracking-normal', 'ks-tracking-wide',
    'ks-weight-regular', 'ks-weight-medium', 'ks-weight-semibold', 'ks-weight-bold',
  ]) {
    assert.ok(hasToken(css, name), `${name} missing`);
  }
});

test('6. WF01 radius scale present (4 / 8 / 12 / 16 / 24)', () => {
  const css = read(TOKENS);
  const expected = { sm: 4, md: 8, lg: 12, xl: 16, '2xl': 24 };
  for (const [k, n] of Object.entries(expected)) {
    const tok = `ks-radius-${k}`;
    assert.ok(hasToken(css, tok), `--${tok} missing`);
    const v = tokenValue(css, tok);
    assert.strictEqual(parseInt(v, 10), n,
      `--${tok} should resolve to ${n}px (got ${v})`);
  }
  assert.ok(hasToken(css, 'ks-radius-pill'), '--ks-radius-pill missing');
  assert.ok(hasToken(css, 'ks-radius-circle'), '--ks-radius-circle missing');
});

test('7. WF01 shadow scale present (sm / md / lg / xl / 2xl + focus)', () => {
  const css = read(TOKENS);
  for (const k of ['sm', 'md', 'lg', 'xl', '2xl', 'focus']) {
    assert.ok(hasToken(css, `ks-shadow-${k}`), `--ks-shadow-${k} missing`);
  }
});

test('8. WF01 motion scale present (75 / 150 / 250 / 350 / 500 ms + 5 ease curves)', () => {
  const css = read(TOKENS);
  const expected = {
    instant: 75, fast: 150, base: 250, slow: 350, deliberate: 500,
  };
  for (const [k, n] of Object.entries(expected)) {
    const tok = `ks-motion-${k}`;
    assert.ok(hasToken(css, tok), `--${tok} missing`);
    const v = tokenValue(css, tok);
    assert.strictEqual(parseInt(v, 10), n,
      `--${tok} should resolve to ${n}ms (got ${v})`);
  }
  for (const k of ['standard', 'emphasized', 'decelerate', 'accelerate', 'spring']) {
    const tok = `ks-ease-${k}`;
    assert.ok(hasToken(css, tok), `--${tok} missing`);
    const v = tokenValue(css, tok);
    assert.match(v || '', /cubic-bezier/,
      `--${tok} should be a cubic-bezier curve (got ${v})`);
  }
});

test('9. font stack tokens declare Geist + Geist Mono with system fallback', () => {
  const css = read(TOKENS);
  assert.ok(hasToken(css, 'ks-font-sans'), '--ks-font-sans missing');
  assert.ok(hasToken(css, 'ks-font-mono'), '--ks-font-mono missing');
  const sans = tokenValue(css, 'ks-font-sans') || '';
  const mono = tokenValue(css, 'ks-font-mono') || '';
  assert.match(sans, /Geist/, '--ks-font-sans should list Geist');
  assert.match(sans, /system-ui/, '--ks-font-sans must include system-ui fallback');
  assert.match(mono, /Geist Mono/, '--ks-font-mono should list Geist Mono');
  assert.match(mono, /(monospace|ui-monospace)/,
    '--ks-font-mono must include a monospace fallback');
});

test('10. all 12 component primitive selectors present', () => {
  const css = read(COMPONENTS);
  const selectors = [
    '.ks-btn',
    '.ks-input',
    '.ks-select',
    '.ks-card',
    '.ks-badge',
    '.ks-toast',
    '.ks-modal',
    '.ks-drawer',
    '.ks-tooltip',
    '.ks-tabs',
    '.ks-accordion',
    '.ks-avatar',
  ];
  for (const sel of selectors) {
    // search for selector at start of a rule (followed by space, comma, brace,
    // colon, or BEM separator)
    const safe = sel.replace(/[.\\]/g, (c) => '\\' + c);
    const re = new RegExp(safe + '(\\s|,|\\{|:|__|--|$)');
    assert.match(css, re, `selector ${sel} missing from wf01-components.css`);
  }
});

test('11. Button: 5 variants x 3 sizes complete', () => {
  const css = read(COMPONENTS);
  for (const v of ['primary', 'secondary', 'outline', 'ghost', 'danger']) {
    assert.match(css, new RegExp('\\.ks-btn--' + v + '\\b'),
      `.ks-btn--${v} missing`);
  }
  for (const s of ['sm', 'md', 'lg']) {
    assert.match(css, new RegExp('\\.ks-btn--' + s + '\\b'),
      `.ks-btn--${s} missing`);
  }
  // focus-visible posture on .ks-btn
  assert.match(css, /\.ks-btn:focus-visible/,
    '.ks-btn must define a :focus-visible style for a11y');
});

test('12. light-mode override block present and overrides --ks-color-*', () => {
  const css = read(TOKENS);
  assert.match(css, /\[data-theme="light"\]\s*\{/,
    'light-mode override selector [data-theme="light"] missing');
  // The light block must redefine at least surface-0, text-1, brand-primary
  const lightBlockMatch = css.match(/\[data-theme="light"\]\s*\{([\s\S]+?)\n\}/);
  assert.ok(lightBlockMatch, 'could not isolate light-mode block');
  const light = lightBlockMatch[1];
  for (const name of [
    'ks-color-brand-primary',
    'ks-color-surface-0',
    'ks-color-surface-1',
    'ks-color-text-1',
    'ks-color-text-2',
  ]) {
    assert.match(light, new RegExp(`--${name}\\s*:`),
      `light-mode override missing for --${name}`);
  }
});

test('13. prefers-reduced-motion clause present in tokens AND components', () => {
  const tokensCss = read(TOKENS);
  const compsCss = read(COMPONENTS);
  assert.match(tokensCss, /@media \(prefers-reduced-motion: reduce\)/,
    'tokens must include prefers-reduced-motion clause');
  assert.match(compsCss, /@media \(prefers-reduced-motion: reduce\)/,
    'components must include prefers-reduced-motion clause');
  // the components reduced-motion block must disable transitions on .ks-btn
  const blockMatch = compsCss.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]+?)\n\}/);
  assert.ok(blockMatch, 'could not isolate components reduced-motion block');
  assert.match(blockMatch[1], /\.ks-btn/,
    'reduced-motion block must collapse .ks-btn transitions');
});

test('14. showcase page links design-tokens.css and wf01-components.css', () => {
  const html = read(SHOWCASE);
  assert.match(html, /href="\/design-tokens\.css"/,
    '/design-system.html must link /design-tokens.css');
  assert.match(html, /href="\/wf01-components\.css"/,
    '/design-system.html must link /wf01-components.css');
  // canonical URL must declare /design-system not the .html
  assert.match(html, /<link rel="canonical" href="https:\/\/kolm\.ai\/design-system"/,
    '/design-system.html must declare canonical kolm.ai/design-system');
  // showcase must include at least one example of every variant
  for (const v of ['primary', 'secondary', 'outline', 'ghost', 'danger']) {
    assert.match(html, new RegExp('ks-btn--' + v),
      `showcase must render at least one ks-btn--${v}`);
  }
  for (const tone of ['success', 'warning', 'error', 'info']) {
    assert.match(html, new RegExp('ks-badge--' + tone),
      `showcase must render at least one ks-badge--${tone}`);
  }
});

test('15. wf01-components.css contains zero raw hex values inside rule bodies', () => {
  const css = read(COMPONENTS);
  // Strip comments first (the comment header documents tokens).
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Find every #RGB or #RRGGBB literal in the remaining text.
  const hexMatches = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepStrictEqual(hexMatches, [],
    `wf01-components.css must not contain raw hex literals — found: ${hexMatches.join(', ')}. Use var(--ks-color-*) tokens.`);
});

test('16. vercel.json declares the /design-system rewrite to /design-system.html', () => {
  const vercelRaw = read(VERCEL);
  const vercel = JSON.parse(vercelRaw);
  assert.ok(Array.isArray(vercel.rewrites), 'vercel.json missing rewrites array');
  const found = vercel.rewrites.find(
    (r) => r && r.source === '/design-system' && r.destination === '/design-system.html',
  );
  assert.ok(found,
    'vercel.json rewrites must include { source: "/design-system", destination: "/design-system.html" }');
});

test('17. a11y posture: showcase exposes visible focus rings + aria attributes', () => {
  const html = read(SHOWCASE);
  // Modal / drawer / tablist / accordion expose ARIA contracts
  assert.match(html, /role="dialog"/, 'showcase modal must declare role="dialog"');
  assert.match(html, /aria-modal="true"/, 'showcase modal must declare aria-modal="true"');
  assert.match(html, /role="tablist"/, 'showcase tabs must declare role="tablist"');
  assert.match(html, /aria-selected="true"/, 'showcase tabs must mark the active tab');
  assert.match(html, /aria-expanded="true"/, 'showcase accordion must mark an expanded item');
  assert.match(html, /role="tooltip"/, 'showcase tooltip must declare role="tooltip"');
  assert.match(html, /role="(status|alert)"/, 'showcase toast must declare role="status" or "alert"');
  // Focus ring token is wired into the components
  const compsCss = read(COMPONENTS);
  assert.match(compsCss, /var\(--ks-shadow-focus\)/,
    'components must consume var(--ks-shadow-focus) for visible focus');
});

test('18. CSS-var sanity: token value resolution chain ends in a usable literal', () => {
  // jsdom-free resolution: walk the var() chain manually inside the file.
  const css = read(TOKENS);
  function resolveVar(name, seen = new Set()) {
    if (seen.has(name)) return null; // cycle guard
    seen.add(name);
    const v = tokenValue(css, name);
    if (!v) return null;
    const m = v.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)$/i);
    if (m) return resolveVar(m[1].replace(/^--/, ''), seen);
    return v;
  }
  // brand-primary chain: --ks-color-brand-primary must end in a #hex
  const brand = resolveVar('ks-color-brand-primary');
  assert.ok(brand, '--ks-color-brand-primary did not resolve to any value');
  assert.match(brand, /^#[0-9a-fA-F]{3,8}$/,
    `--ks-color-brand-primary should resolve to a hex literal (got ${brand})`);
  // surface-0 chain
  const s0 = resolveVar('ks-color-surface-0');
  assert.ok(s0 && /^#[0-9a-fA-F]{3,8}$/.test(s0),
    `--ks-color-surface-0 should resolve to a hex literal (got ${s0})`);
  // legacy alias --good must still resolve to a color via the chain
  const good = resolveVar('good');
  assert.ok(good && /^#[0-9a-fA-F]{3,8}$/.test(good),
    `legacy alias --good must still resolve to a hex literal (got ${good})`);
});
