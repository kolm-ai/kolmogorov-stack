#!/usr/bin/env node
// Capture 8 QA frames at key moments for visual verification.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PAGE = path.join(__dirname, 'demo-page.html');
const OUT = path.join(__dirname, 'qa');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto('file://' + PAGE.replace(/\\/g, '/'));
await page.waitForFunction('window.kolmSeek !== undefined');

const moments = [
  { t: 2.5,  name: 's1-typing' },          // mid-type
  { t: 5.5,  name: 's1-end' },             // fully typed
  { t: 7.5,  name: 's2-synthesize' },      // synthesize stage
  { t: 10.0, name: 's2-score' },           // K-score ramping
  { t: 12.5, name: 's2-sign' },            // signing complete
  { t: 13.6, name: 's4-land' },            // icon dropping in
  { t: 14.6, name: 's4-name' },            // filename cascading
  { t: 15.5, name: 's4-sub' },             // subtitle in
  { t: 16.5, name: 's4-tag' },             // tag landed
  { t: 17.5, name: 's4-hold' },            // full settled hold
  { t: 19.5, name: 's5-closing' },         // closing tagline
];

for (const m of moments) {
  await page.evaluate((t) => window.kolmSeek(t), m.t);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const fp = path.join(OUT, `qa-t${m.t.toFixed(1).replace('.', '_')}-${m.name}.png`);
  await page.screenshot({ path: fp, type: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  console.log('wrote', fp);
}

await browser.close();
