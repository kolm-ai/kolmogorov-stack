// W404 — competitive screenshot rig.
//
// Usage:
//   node scripts/site-screenshot.mjs ours
//   node scripts/site-screenshot.mjs competitors
//   node scripts/site-screenshot.mjs <url> [outname]
//
// Output: screenshots/{ours,competitors}/<slug>.png  (viewport 1440x900 above-the-fold + full page)

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'screenshots');

const OURS = [
  ['https://kolm.ai/',                'home'],
  ['https://kolm.ai/product',         'product'],
  ['https://kolm.ai/captures',        'captures'],
  ['https://kolm.ai/pricing',         'pricing'],
  ['https://kolm.ai/enterprise',      'enterprise'],
  ['https://kolm.ai/models',          'models'],
  ['https://kolm.ai/quickstart',      'quickstart'],
  ['https://kolm.ai/tui',             'tui'],
  ['https://kolm.ai/healthcare',      'healthcare'],
];

const COMPETITORS = [
  // Frontier labs
  ['https://www.anthropic.com/',      'anthropic'],
  ['https://openai.com/',             'openai'],
  ['https://mistral.ai/',             'mistral'],
  ['https://cohere.com/',             'cohere'],
  // AI infra (compute/inference)
  ['https://groq.com/',               'groq'],
  ['https://www.together.ai/',        'together'],
  ['https://fireworks.ai/',           'fireworks'],
  ['https://replicate.com/',          'replicate'],
  ['https://modal.com/',              'modal'],
  ['https://huggingface.co/',         'huggingface'],
  // Direct competitors (compile/distill/proxy/eval)
  ['https://predibase.com/',          'predibase'],
  ['https://openpipe.ai/',            'openpipe'],
  ['https://langfuse.com/',           'langfuse'],
  ['https://www.helicone.ai/',        'helicone'],
  ['https://portkey.ai/',             'portkey'],
  ['https://www.braintrust.dev/',     'braintrust'],
  ['https://www.langchain.com/',      'langchain'],
  // Developer products with great marketing structure
  ['https://www.cursor.com/',         'cursor'],
  ['https://v0.dev/',                 'v0'],
  ['https://vercel.com/',             'vercel'],
];

async function shotOne(browser, url, name, dir) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const outPath = path.join(dir, `${name}.png`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: outPath, fullPage: false });
    const stat = fs.statSync(outPath);
    console.log(`[ok] ${name.padEnd(14)} ${url}  ${(stat.size/1024).toFixed(1)}KB`);
  } catch (e) {
    console.log(`[ERR] ${name.padEnd(14)} ${url}  ${e.message}`);
  } finally {
    await ctx.close();
  }
}

async function shotMany(list, dirName) {
  const dir = path.join(OUT, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  // run 3 at a time
  const queue = [...list];
  const concurrency = 3;
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (!item) return;
      const [url, name] = item;
      await shotOne(browser, url, name, dir);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  await browser.close();
}

const mode = process.argv[2] || 'ours';
if (mode === 'ours') await shotMany(OURS, 'ours');
else if (mode === 'competitors') await shotMany(COMPETITORS, 'competitors');
else if (mode.startsWith('http')) {
  const out = path.join(OUT, 'adhoc');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  await shotOne(browser, mode, process.argv[3] || 'shot', out);
  await browser.close();
}
console.log('done');
