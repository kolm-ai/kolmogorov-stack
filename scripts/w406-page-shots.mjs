// W406 — restraint audit shots of the 6 next-tier pages on production.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(path.resolve(__dirname, '..'), '.audit-w406');
fs.mkdirSync(OUT, { recursive: true });

const TARGETS = [
  ['https://kolm.ai/product',     'product.png'],
  ['https://kolm.ai/models',      'models.png'],
  ['https://kolm.ai/pricing',     'pricing.png'],
  ['https://kolm.ai/enterprise',  'enterprise.png'],
  ['https://kolm.ai/captures',    'captures.png'],
  ['https://kolm.ai/value-loop',  'value-loop.png'],
];

async function shotOne(browser, url, file) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const outPath = path.join(OUT, file);
  try {
    await page.goto(url + '?_=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: outPath, fullPage: true });
    const s = fs.statSync(outPath);
    console.log(`[ok] ${file.padEnd(20)} ${(s.size/1024).toFixed(1)}KB`);
  } catch (e) {
    console.log(`[ERR] ${file} ${e.message}`);
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
await Promise.all(TARGETS.map(([u, f]) => shotOne(browser, u, f)));
await browser.close();
console.log('done');
