// W-4b — render-verify the account dashboard against a live server.
// Usage: BASE=http://127.0.0.1:8799 KEY=ks_... node scripts/verify-dashboard.mjs
import { chromium } from 'playwright';

const base = process.env.BASE || 'http://127.0.0.1:8799';
const key = process.env.KEY || '';
const out = process.env.OUT || 'tmp-distill/dashboard.png';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1700 } });
// Seed the session key before any page script runs.
await page.addInitScript((k) => { try { sessionStorage.setItem('kolm_account_key', k); } catch (e) {} }, key);
await page.goto(base + '/account/dashboard', { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="hero-captures"]', { timeout: 10000 });

const panels = ['hero-captures', 'panel-keys', 'panel-usage', 'panel-sources', 'panel-jobs'];
const present = {};
for (const p of panels) present[p] = await page.locator(`[data-testid="${p}"]`).count();
const hero = (await page.locator('[data-testid="hero-captures"] b').innerText()).trim();
const usedText = await page.locator('[data-testid="panel-usage"]').innerText();

await page.screenshot({ path: out, fullPage: true });
await browser.close();

const ok = panels.every((p) => present[p] >= 1) && /\d/.test(hero);
console.log('PANELS', JSON.stringify(present));
console.log('HERO_CAPTURES', JSON.stringify(hero));
console.log('USAGE_HAS_PLAN', /Plan/.test(usedText));
console.log('SCREENSHOT', out);
console.log('DASHBOARD_OK', ok);
process.exit(ok ? 0 : 1);
