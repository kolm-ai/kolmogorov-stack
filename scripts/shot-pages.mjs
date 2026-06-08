#!/usr/bin/env node
// Screenshot a set of pages (full + hero crop) under the live Signet CSS for triage.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'tmp', 'pages');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.xml':'application/xml','.txt':'text/plain' };
function resolveFile(u){let p=decodeURIComponent(u.split('?')[0].split('#')[0]);if(p.endsWith('/'))p+='index.html';let a=path.join(PUB,p);if(fs.existsSync(a)&&fs.statSync(a).isFile())return a;if(fs.existsSync(a+'.html'))return a+'.html';return null;}
const server=http.createServer((req,res)=>{const f=resolveFile(req.url==='/'?'/index.html':req.url);if(!f){res.statusCode=404;return res.end('404');}res.setHeader('Content-Type',(MIME[path.extname(f).toLowerCase()]||'application/octet-stream')+'; charset=utf-8');fs.createReadStream(f).pipe(res);});
const port=await new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)));
const base=`http://127.0.0.1:${port}`;
const pages = process.argv.slice(2);
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errs=[];
for(const route of pages){
  errs.length=0;
  page.removeAllListeners('pageerror');
  page.on('pageerror',e=>errs.push(String(e)));
  await page.goto(base+route,{waitUntil:'networkidle'}).catch(e=>errs.push('GOTO '+e));
  await page.evaluate(async()=>{const s=Math.round(innerHeight*0.7);for(let y=0;y<=document.body.scrollHeight;y+=s){scrollTo(0,y);await new Promise(r=>setTimeout(r,80));}scrollTo(0,0);});
  await page.waitForTimeout(400);
  const slug=route==='/'?'home':route.replace(/^\//,'').replace(/\//g,'-');
  await page.screenshot({path:path.join(OUT,slug+'.png'),fullPage:true});
  console.log(`${route}  errs=${errs.length}${errs.length?'  '+errs.slice(0,2).join(' | '):''}`);
}
await browser.close();server.close();
