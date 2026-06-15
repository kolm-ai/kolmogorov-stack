// Verify the signup page's passwordless email sign-in affordance.
import { chromium } from 'playwright';
const base = process.env.BASE || 'http://127.0.0.1:8805';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1500 } });
await page.goto(base + '/signup', { waitUntil: 'networkidle' });
await page.waitForSelector('#emaillink', { timeout: 8000 });
await page.fill('#email', 'returning@kolm.test');
await page.click('#emaillink');
await page.waitForSelector('#emaillink-msg:not([hidden])', { timeout: 8000 });
const msg = (await page.locator('#emaillink-msg').innerText()).trim();
await page.screenshot({ path: process.env.OUT || 'tmp-distill/signup-email.png', fullPage: false });
await browser.close();
console.log('EMAILLINK_MSG', JSON.stringify(msg));
const ok = /email|link|check/i.test(msg);
console.log('SIGNUP_EMAIL_OK', ok);
process.exit(ok ? 0 : 1);
