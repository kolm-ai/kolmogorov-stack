// Capture readable viewport-height slices of a live page for visual audit.
// Slow pre-scroll so IntersectionObserver reveals fire naturally (.in is one-shot, stays).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'https://kolm.ai';
const route = process.argv[3] || '/';
const tag = process.argv[4] || 'slice';
const OUT = path.join(ROOT, 'tmp', 'live-slices', tag);
fs.rmSync(OUT, { recursive:true, force:true });
fs.mkdirSync(OUT, { recursive: true });

const VH = 900;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{width:1440,height:VH}, deviceScaleFactor:2, colorScheme:'dark' });
const page = await ctx.newPage();
await page.goto(`${BASE}${route}`, { waitUntil:'networkidle', timeout:45000 });
const H = await page.evaluate(()=>document.body.scrollHeight);
// slow pre-scroll: 350ms per step lets the reveal observer fire and .in latch on
for(let y=0; y<H; y+=450){ await page.evaluate(_y=>window.scrollTo(0,_y), y); await page.waitForTimeout(350); }
await page.evaluate(()=>window.scrollTo(0,0)); await page.waitForTimeout(400);
let i=0;
for(let y=0; y<H; y+=VH){
  await page.evaluate(_y=>window.scrollTo(0,_y), y); await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, String(i).padStart(2,'0')+'.png') });
  i++;
}
console.log(tag, 'slices', i, 'height', H);
await browser.close();
