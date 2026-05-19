// W405 — post-deploy verification shot only of our home (re-uses w405-frontier-shots rig).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(path.resolve(__dirname, '..'), '.audit-w405');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const url = `https://kolm.ai/?_=${Date.now()}`;
const file = 'kolm-home-w405-after.png';
const outPath = path.join(OUT, file);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3500);
await page.screenshot({ path: outPath, fullPage: true });
const s = fs.statSync(outPath);
console.log(`[ok] ${file}  ${(s.size/1024).toFixed(1)}KB`);

await ctx.close();
await browser.close();
