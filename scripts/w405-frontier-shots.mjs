// W405 — frontier comparison screenshot rig.
// 5 frontier AI sites + our current production homepage.
// Output: .audit-w405/<name>.png at 1440x900 viewport, full page, 3s settle.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, '.audit-w405');

fs.mkdirSync(OUT, { recursive: true });

const TARGETS = [
  ['https://anthropic.com/',  'frontier-anthropic.png'],
  ['https://openai.com/',     'frontier-openai.png'],
  ['https://mistral.ai/',     'frontier-mistral.png'],
  ['https://replicate.com/',  'frontier-replicate.png'],
  ['https://modal.com/',      'frontier-modal.png'],
  ['https://kolm.ai/',        'kolm-home-current.png'],
];

async function shotOne(browser, url, file) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  const outPath = path.join(OUT, file);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: outPath, fullPage: true });
    const stat = fs.statSync(outPath);
    console.log(`[ok] ${file.padEnd(28)} ${url}  ${(stat.size/1024).toFixed(1)}KB`);
  } catch (e) {
    console.log(`[ERR] ${file.padEnd(28)} ${url}  ${e.message}`);
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const queue = [...TARGETS];
const concurrency = 3;
async function worker() {
  while (queue.length) {
    const item = queue.shift();
    if (!item) return;
    const [url, file] = item;
    await shotOne(browser, url, file);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
await browser.close();

console.log('\n--- files in', OUT, '---');
for (const f of fs.readdirSync(OUT)) {
  const s = fs.statSync(path.join(OUT, f));
  console.log(`  ${f.padEnd(32)} ${(s.size/1024).toFixed(1)}KB`);
}
console.log('done');
