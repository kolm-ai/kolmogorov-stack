// Phase F: full-page screenshots of the LIVE site for visual audit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tmp', 'live-audit');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.argv[2] || 'https://kolm.ai';
const ROUTES = (process.argv[3] || '/,/checks,/report-viewer,/trust,/contact,/how-it-works,/verify,/spec,/capabilities,/solutions/ai-vendors,/solutions/enterprise-buyers,/badge,/compare,/pricing').split(',');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{width:1440,height:1000}, deviceScaleFactor:1.5, colorScheme:'dark' });
for(const route of ROUTES){
  try{
    const page = await ctx.newPage();
    await page.goto(`${BASE}${route}`, { waitUntil:'networkidle', timeout:45000 });
    for(let y=0; y<await page.evaluate(()=>document.body.scrollHeight); y+=400){ await page.evaluate(_y=>window.scrollTo(0,_y), y); await page.waitForTimeout(50); }
    await page.evaluate(()=>window.scrollTo(0,0)); await page.waitForTimeout(400);
    const name = (route==='/'?'home':route.replace(/^\//,'').replace(/\//g,'-'))+'.png';
    await page.screenshot({ path: path.join(OUT, name), fullPage: true });
    console.log('ok', name);
    await page.close();
  }catch(e){ console.log('ERR', route, String(e).slice(0,90)); }
}
await browser.close();
