#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.ico':'image/x-icon' };
function resolveFile(u){let p=decodeURIComponent(u.split('?')[0].split('#')[0]);if(p.endsWith('/'))p+='index.html';let a=path.join(PUB,p);if(fs.existsSync(a)&&fs.statSync(a).isFile())return a;if(fs.existsSync(a+'.html'))return a+'.html';return null;}
const server=http.createServer((req,res)=>{const f=resolveFile(req.url==='/'?'/index.html':req.url);if(!f){res.statusCode=404;return res.end('404');}res.setHeader('Content-Type',(MIME[path.extname(f).toLowerCase()]||'application/octet-stream')+'; charset=utf-8');fs.createReadStream(f).pipe(res);});
const port=await new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)));
const base=`http://127.0.0.1:${port}`;
const browser=await chromium.launch();
for (const [label, opts] of [['desktop',{viewport:{width:1440,height:900}}],['mobile',{...devices['iPhone 13']}]]) {
  const ctx=await browser.newContext(opts);
  const page=await ctx.newPage();
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  // sample immediately (first paint) AND after settle
  for (const when of ['t0','settled']) {
    if (when==='settled') await page.waitForTimeout(1400);
    const info=await page.evaluate(()=>{
      const h1=document.querySelector('h1, .hero h1, .hero__title');
      if(!h1) return {none:true};
      const cs=getComputedStyle(h1);
      const r=h1.getBoundingClientRect();
      return {text:h1.textContent.trim().slice(0,40),opacity:cs.opacity,color:cs.color,fontSize:cs.fontSize,fontWeight:cs.fontWeight,fontFamily:cs.fontFamily.split(',')[0],w:Math.round(r.width),h:Math.round(r.height),htmlClass:document.documentElement.className};
    });
    console.log(`${label}/${when}:`, JSON.stringify(info));
  }
  await ctx.close();
}
await browser.close();server.close();
