#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'tmp');
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.xml':'application/xml','.txt':'text/plain' };
function resolveFile(u){let p=decodeURIComponent(u.split('?')[0].split('#')[0]);if(p.endsWith('/'))p+='index.html';let a=path.join(PUB,p);if(fs.existsSync(a)&&fs.statSync(a).isFile())return a;if(fs.existsSync(a+'.html'))return a+'.html';return null;}
const server=http.createServer((req,res)=>{const f=resolveFile(req.url==='/'?'/index.html':req.url);if(!f){res.statusCode=404;return res.end('404');}res.setHeader('Content-Type',(MIME[path.extname(f).toLowerCase()]||'application/octet-stream')+'; charset=utf-8');fs.createReadStream(f).pipe(res);});
const port=await new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)));
const base=`http://127.0.0.1:${port}`;
const browser=await chromium.launch();
const ctx=await browser.newContext({...devices['iPhone 13']});
const page=await ctx.newPage();
const errs=[];page.on('pageerror',e=>errs.push(String(e)));
await page.goto(base+'/',{waitUntil:'networkidle'});
await page.evaluate(async()=>{const s=Math.round(innerHeight*0.7);for(let y=0;y<=document.body.scrollHeight;y+=s){scrollTo(0,y);await new Promise(r=>setTimeout(r,80));}scrollTo(0,0);});
await page.waitForTimeout(500);
// check for horizontal overflow (a classic mobile-amateur tell)
const overflow=await page.evaluate(()=>({docW:document.documentElement.scrollWidth,winW:window.innerWidth}));
await page.screenshot({path:path.join(OUT,'home-mobile.png'),fullPage:true});
await page.screenshot({path:path.join(OUT,'home-mobile-top.png'),clip:{x:0,y:0,width:390,height:844}});
console.log('mobile errs='+errs.length+' scrollW='+overflow.docW+' winW='+overflow.winW+(overflow.docW>overflow.winW+1?' OVERFLOW!':' (no h-overflow)'));
await browser.close();server.close();
