#!/usr/bin/env node
// W905 full UI/UX screenshot sweep: ~80 user-facing routes x 5 breakpoints.
// Output: _audit/w905/screens/<slug>__<breakpoint>.png + contact-sheet.html
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.URL || 'https://kolm.ai';
const OUT = resolve(process.env.OUT || '_audit/w905/screens');
mkdirSync(OUT, { recursive: true });

const BREAKPOINTS = [
  { name: 'mobile-375',   width: 375,  height: 667,  isMobile: true,  device: 'iPhone SE' },
  { name: 'mobile-428',   width: 428,  height: 926,  isMobile: true,  device: 'iPhone 13 Pro Max' },
  { name: 'tablet-768',   width: 768,  height: 1024, isMobile: false, device: 'iPad' },
  { name: 'desktop-1280', width: 1280, height: 800,  isMobile: false, device: 'Desktop' },
  { name: 'desktop-1920', width: 1920, height: 1080, isMobile: false, device: 'Desktop XL' },
];

const ROUTES = [
  // Core marketing
  ['/',                   'home'],
  ['/pricing',            'pricing'],
  ['/docs',               'docs'],
  ['/quickstart',         'quickstart'],
  ['/changelog',          'changelog'],
  ['/manifesto',          'manifesto'],
  ['/security',           'security'],
  ['/book-demo',          'book-demo'],
  ['/about',              'about'],
  ['/faq',                'faq'],
  ['/terms',              'terms'],
  ['/privacy',            'privacy'],
  ['/press',              'press'],
  ['/community',          'community'],
  ['/blog',               'blog'],
  ['/verify',             'verify'],
  ['/demo',               'demo'],
  ['/demo-live',          'demo-live'],
  ['/marketplace',        'marketplace'],
  ['/signup',             'signup'],
  ['/login',              'login'],
  // Product
  ['/api',                'api'],
  ['/benchmarks',         'benchmarks'],
  ['/k-score',            'k-score'],
  ['/integrations',       'integrations'],
  ['/models',             'models'],
  ['/sdks',               'sdks'],
  ['/enterprise',         'enterprise'],
  ['/forge',              'forge'],
  ['/merge',              'merge'],
  ['/hardware',           'hardware'],
  ['/studio',             'studio'],
  ['/frozen-eval',        'frozen-eval'],
  ['/gateway',            'gateway'],
  // Verticals
  ['/defense',            'vert-defense'],
  ['/education',          'vert-education'],
  ['/eu-sovereign',       'vert-eu-sovereign'],
  ['/government',         'vert-government'],
  ['/insurance',          'vert-insurance'],
  ['/healthcare',         'vert-healthcare'],
  ['/finance',            'vert-finance'],
  ['/legal',              'vert-legal'],
  ['/code-gen',           'vert-code-gen'],
  ['/customer-support',   'vert-customer-support'],
  // Comparisons
  ['/vs/openai',          'vs-openai'],
  ['/vs/together',        'vs-together'],
  ['/vs/fireworks',       'vs-fireworks'],
  ['/vs/openpipe',        'vs-openpipe'],
  ['/vs/self-built',      'vs-self-built'],
  // Case studies
  ['/case-studies/finance-sr11-7',           'case-finance'],
  ['/case-studies/healthcare-phi-redactor',  'case-healthcare'],
  ['/case-studies/legal-contract-extraction','case-legal'],
  // Quickstart language pages
  ['/quickstart/c',       'qs-c'],
  ['/quickstart/rust',    'qs-rust'],
  ['/quickstart/python',  'qs-python'],
  ['/quickstart/sdk',     'qs-sdk'],
  ['/quickstart/embed',   'qs-embed'],
  // SEO compile (sample)
  ['/compile/deepseek-r1-distill-32b-to-awq',        'seo-32b-awq'],
  ['/compile/deepseek-r1-distill-32b-to-gguf-q4_k_m','seo-32b-gguf-q4'],
  ['/compile/deepseek-r1-distill-7b-to-mlx',         'seo-7b-mlx'],
  ['/compile/deepseek-r1-distill-7b-to-gptq',        'seo-7b-gptq'],
  // Docs (sample)
  ['/docs/gateway-region-lock',  'docs-region-lock'],
  ['/docs/runtime-passport',     'docs-passport'],
  ['/docs/copyright-scan',       'docs-copyright'],
  ['/docs/cross-lingual',        'docs-cross-lingual'],
  ['/docs/seasonal',             'docs-seasonal'],
  ['/security/prompt-extraction','docs-prompt-extract'],
  ['/training/data-sources',     'docs-data-sources'],
  ['/benchmarks/swe-bench-mini', 'docs-swe-bench'],
  ['/compliance/eu-ai-act',      'docs-eu-ai-act'],
  ['/migrate/openpipe',          'docs-migrate-openpipe'],
  ['/migrate/predibase',         'docs-migrate-predibase'],
  ['/spec/kolm-format-v1',       'docs-spec'],
  ['/spec/toml',                 'docs-spec-toml'],
];

console.log(`[w905-sweep] ${ROUTES.length} routes x ${BREAKPOINTS.length} breakpoints = ${ROUTES.length * BREAKPOINTS.length} screenshots`);
console.log(`[w905-sweep] base=${BASE}  out=${OUT}`);

const browser = await chromium.launch();
const errors = [];
let done = 0;
const total = ROUTES.length * BREAKPOINTS.length;
const startT = Date.now();

for (const [route, slug] of ROUTES) {
  for (const bp of BREAKPOINTS) {
    const file = join(OUT, `${slug}__${bp.name}.png`);
    try {
      const ctx = await browser.newContext({
        viewport: { width: bp.width, height: bp.height },
        deviceScaleFactor: bp.isMobile ? 2 : 1,
        userAgent: bp.isMobile
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
          : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });
      const page = await ctx.newPage();
      const resp = await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 25000 });
      const status = resp ? resp.status() : 0;
      // small settle for animations
      await page.waitForTimeout(800);
      await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
      await ctx.close();
      done++;
      if (done % 25 === 0 || done === total) {
        const elapsed = ((Date.now() - startT) / 1000).toFixed(0);
        console.log(`[${done}/${total}] ${elapsed}s ${route} @ ${bp.name} status=${status}`);
      }
      if (status >= 400) errors.push({ route, bp: bp.name, status });
    } catch (e) {
      errors.push({ route, bp: bp.name, error: String(e.message).slice(0, 120) });
      done++;
    }
  }
}

await browser.close();

// Build contact sheet
const files = readdirSync(OUT).filter(f => f.endsWith('.png') && f.includes('__')).sort();
const byRoute = new Map();
for (const f of files) {
  const [slug, bpFile] = f.split('__');
  if (!bpFile) continue;
  const bp = bpFile.replace('.png', '');
  if (!byRoute.has(slug)) byRoute.set(slug, {});
  byRoute.get(slug)[bp] = f;
}
const html = [
  '<!doctype html><html><head><meta charset="utf-8"><title>W905 UI/UX Sweep · kolm.ai</title>',
  '<style>',
  'body{font:14px/1.4 ui-sans-serif,system-ui,sans-serif;background:#0f1419;color:#e8eaed;margin:0;padding:24px}',
  'h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;color:#b8bcc4;margin:0 0 16px;font-weight:400}',
  '.meta{color:#888;font-size:12px;margin-bottom:24px}',
  '.row{display:grid;grid-template-columns:160px repeat(5,1fr);gap:8px;margin-bottom:16px;padding:8px;background:#1a2026;border-radius:6px}',
  '.row h3{margin:0;padding:8px 4px;color:#b8bcc4;font-size:13px;font-weight:500;align-self:center;font-family:ui-monospace,monospace}',
  '.cell{display:flex;flex-direction:column;gap:4px;align-items:center}',
  '.cell a{display:block;width:100%}',
  '.cell img{width:100%;height:120px;object-fit:cover;object-position:top;border:1px solid #2d3540;border-radius:4px;background:#000;display:block}',
  '.cell img:hover{border-color:#b8bcc4}',
  '.cell label{font-size:10px;color:#7a8190;font-family:ui-monospace,monospace}',
  '.header{display:grid;grid-template-columns:160px repeat(5,1fr);gap:8px;margin-bottom:8px;font-size:11px;color:#7a8190;text-transform:uppercase;letter-spacing:0.04em;padding:0 8px}',
  '.errors{background:#2a1818;border:1px solid #5a2828;color:#ff8888;padding:12px;border-radius:6px;margin-bottom:16px;font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap}',
  '</style></head><body>',
  '<h1>W905 UI/UX Sweep · kolm.ai</h1>',
  `<h2>${ROUTES.length} routes &times; ${BREAKPOINTS.length} breakpoints = ${ROUTES.length * BREAKPOINTS.length} screenshots</h2>`,
  `<div class="meta">Captured ${new Date().toISOString()} from ${BASE} &middot; click any image for full-size</div>`,
  errors.length ? `<div class="errors">${errors.length} errors:\n${errors.map(e => `  ${e.route} @ ${e.bp} ${e.status || ''} ${e.error || ''}`).join('\n')}</div>` : '',
  '<div class="header"><div>route</div>',
  ...BREAKPOINTS.map(bp => `<div>${bp.name}<br>${bp.width}&times;${bp.height}<br>${bp.device}</div>`),
  '</div>',
];
for (const [slug, shots] of byRoute) {
  html.push(`<div class="row"><h3>${slug}</h3>`);
  for (const bp of BREAKPOINTS) {
    const f = shots[bp.name];
    if (f) html.push(`<div class="cell"><a href="${f}" target="_blank"><img src="${f}" loading="lazy" alt=""></a><label>${bp.name}</label></div>`);
    else html.push('<div class="cell"><div style="width:100%;height:120px;background:#2a1818;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#ff8888;font-size:10px">missing</div></div>');
  }
  html.push('</div>');
}
html.push('</body></html>');
const sheetPath = join(OUT, 'contact-sheet.html');
writeFileSync(sheetPath, html.join('\n'));

const elapsed = ((Date.now() - startT) / 1000).toFixed(0);
const sizes = files.map(f => statSync(join(OUT, f)).size);
const totalMB = (sizes.reduce((a,b) => a+b, 0) / 1024 / 1024).toFixed(1);
console.log(`\n[w905-sweep] done in ${elapsed}s`);
console.log(`  screenshots: ${files.length}/${total} (${totalMB} MB)`);
console.log(`  errors: ${errors.length}`);
console.log(`  contact sheet: ${sheetPath}`);
if (errors.length) {
  console.log(`\n[w905-sweep] error detail:`);
  errors.slice(0, 20).forEach(e => console.log(`  ${e.route} @ ${e.bp} ${e.status || ''} ${e.error || ''}`));
}
