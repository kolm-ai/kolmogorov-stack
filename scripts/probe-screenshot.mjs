import { chromium } from 'playwright';
const b = await chromium.launch();

// Sign in first
const ctx1 = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p1 = await ctx1.newPage();
await p1.goto('http://localhost:8787/signup');
const KEY = 'ks_b5712beb6495d42a834d83a48a828efa';
await p1.evaluate(async (k) => {
  localStorage.setItem('kolm_api_key', k);
  await fetch('/v1/signin', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: k }) });
}, KEY);
const cookies = await ctx1.cookies();
await ctx1.close();

// Snap all key pages with the session
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
await page.evaluate((k) => localStorage.setItem('kolm_api_key', k), KEY).catch(() => {});
for (const [u, name] of [['/', 'home'], ['/pricing', 'pricing'], ['/use-cases', 'solutions'], ['/docs', 'docs'], ['/dashboard', 'dashboard'], ['/account', 'account']]) {
  await page.goto('http://localhost:8787' + u, { waitUntil: 'domcontentloaded' });
  await page.evaluate((k) => localStorage.setItem('kolm_api_key', k), KEY);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `scripts/qa-authed-${name}.png`, fullPage: false });
}
await b.close();
console.log('captured 6 pages');
