#!/usr/bin/env node
// Clean aesthetic crops: top hero (light), hero exhibit plate, the seal, the vault.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'tmp');
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.xml':'application/xml','.txt':'text/plain' };
function resolveFile(u){let p=decodeURIComponent(u.split('?')[0].split('#')[0]);if(p.endsWith('/'))p+='index.html';let a=path.join(PUB,p);if(fs.existsSync(a)&&fs.statSync(a).isFile())return a;if(fs.existsSync(a+'.html'))return a+'.html';return null;}
const server=http.createServer((req,res)=>{const f=resolveFile(req.url==='/'?'/index.html':req.url);if(!f){res.statusCode=404;return res.end('404');}res.setHeader('Content-Type',(MIME[path.extname(f).toLowerCase()]||'application/octet-stream')+'; charset=utf-8');fs.createReadStream(f).pipe(res);});
const port=await new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)));
const base=`http://127.0.0.1:${port}`;
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:2});
await page.goto(base+'/',{waitUntil:'networkidle'});
await page.waitForTimeout(1200);
// top hero, at scroll 0, no locator scrolling
await page.evaluate(()=>window.scrollTo(0,0));
await page.waitForTimeout(300);
await page.screenshot({path:path.join(OUT,'crop-hero.png'),clip:{x:0,y:0,width:1440,height:1000}});
// hero exhibit plate (the seal card on the right)
const plate=page.locator('.hero .card, .hero__plate, .hero [class*="plate"], .hero .exhibit').first();
if(await plate.count()) await plate.screenshot({path:path.join(OUT,'crop-plate.png')}).catch(()=>{});
// the seal itself
const seal=page.locator('.seal').first();
if(await seal.count()) await seal.screenshot({path:path.join(OUT,'crop-seal.png')}).catch(()=>{});
console.log('done');
await browser.close();server.close();
