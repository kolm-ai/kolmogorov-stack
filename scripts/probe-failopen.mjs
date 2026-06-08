#!/usr/bin/env node
// Critical robustness check: if kolm-2026.js fails to load, the failsafe must strip
// js-reveal so NO content stays hidden (the W921 bleed must be structurally impossible).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.ico':'image/x-icon' };
function resolveFile(u){let p=decodeURIComponent(u.split('?')[0].split('#')[0]);if(p.endsWith('/'))p+='index.html';let a=path.join(PUB,p);if(fs.existsSync(a)&&fs.statSync(a).isFile())return a;if(fs.existsSync(a+'.html'))return a+'.html';return null;}
const server=http.createServer((req,res)=>{const f=resolveFile(req.url==='/'?'/index.html':req.url);if(!f){res.statusCode=404;return res.end('404');}res.setHeader('Content-Type',(MIME[path.extname(f).toLowerCase()]||'application/octet-stream')+'; charset=utf-8');fs.createReadStream(f).pipe(res);});
const port=await new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)));
const base=`http://127.0.0.1:${port}`;
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1440,height:900}});
// simulate the reveal script failing to load
await page.route('**/kolm-2026.js', (route)=>route.fulfill({status:404,body:'not found'}));
await page.goto(base+'/',{waitUntil:'load'});
await page.waitForTimeout(1800); // wait past the 1400ms failsafe timer
const r = await page.evaluate(()=>{
  const reveals=[...document.querySelectorAll('.reveal')];
  const hidden=reveals.filter(el=>getComputedStyle(el).opacity==='0');
  return {
    htmlClass:document.documentElement.className,
    armed:document.documentElement.hasAttribute('data-reveal-armed'),
    totalReveal:reveals.length,
    hiddenReveal:hidden.length,
    hiddenSample:hidden.slice(0,3).map(el=>el.tagName+'.'+(el.className||'').slice(0,30)),
  };
});
console.log(JSON.stringify(r,null,2));
const pass = r.hiddenReveal===0 && r.armed===false;
console.log('FAIL-OPEN: '+(pass?'PASS — no content hidden when script dies':'FAIL — content stuck hidden'));
await browser.close();server.close();
process.exit(pass?0:1);
