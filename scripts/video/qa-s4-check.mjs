import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const url = 'file://' + path.join(__dirname, 'demo-page.html').replace(/\\/g, '/');
await page.goto(url);
await page.waitForFunction(() => typeof window.kolmSeek === 'function');

const checks = [
  ['s1-typed', 3.0],
  ['s2-mid', 9.5],
  ['s2-late', 12.5],
  ['s4-land', 13.6],
  ['s4-name', 14.6],
  ['s4-tag', 16.2],
  ['s4-cycle-early', 16.95],
  ['s4-cycle-mid', 17.25],
  ['s4-cycle-late', 17.50],
  ['s4-cycle-end', 17.85],
  ['s5-closing', 19.5],
];
for (const [name, t] of checks) {
  await page.evaluate((tt) => window.kolmSeek(tt), t);
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(__dirname, `qa-${name}.png`) });
  console.log('captured', name, 'at t=' + t);
}
await browser.close();
