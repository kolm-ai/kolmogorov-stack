import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const KEY = 'ks_b5712beb6495d42a834d83a48a828efa';

// Inject session cookie + localStorage on first real-origin nav
await page.goto('http://localhost:8787/signup');
await page.evaluate((k) => {
  localStorage.setItem('kolm_api_key', k);
  localStorage.setItem('apiKey', k);
}, KEY);
// Also signin so the cookie is set
const res = await page.evaluate(async (k) => {
  const r = await fetch('/v1/signin', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: k }) });
  return { ok: r.ok, status: r.status };
}, KEY);
console.log('signin:', JSON.stringify(res));

await page.goto('http://localhost:8787/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const data = await page.evaluate(() => {
  const m = document.querySelector('main');
  const greet = document.getElementById('hd-greet');
  const plan = document.getElementById('m-plan');
  const pill = document.querySelector('.kolm-auth-pill');
  return {
    mainClass: m ? m.className : null,
    mainPadTop: m ? getComputedStyle(m).paddingTop : null,
    greet: greet ? greet.textContent.trim() : null,
    plan: plan ? plan.textContent.trim() : null,
    pillVisible: pill ? true : false,
    pillText: pill ? pill.textContent.trim() : null,
    url: location.pathname,
  };
});
console.log('dashboard state:', JSON.stringify(data, null, 2));

await page.screenshot({ path: 'scripts/qa-dashboard-authed.png', fullPage: false });
await b.close();
