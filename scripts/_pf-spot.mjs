// Phase F spot-check: screenshot specific selectors across pages into tmp/pf-spot.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'tmp', 'pf-spot');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json' };
function resolveFile(u){ let p=decodeURIComponent(u.split('?')[0].split('#')[0]); if(p.endsWith('/'))p+='index.html'; let abs=path.join(PUB,p); if(fs.existsSync(abs)&&fs.statSync(abs).isFile())return abs; if(fs.existsSync(abs+'.html'))return abs+'.html'; return null; }
const server = http.createServer((req,res)=>{ if(req.url.startsWith('/v1/')){res.statusCode=401;res.end('{"ok":false}');return;} const f=resolveFile(req.url==='/'?'/index.html':req.url); if(!f){res.statusCode=404;res.end('nf');return;} res.setHeader('Content-Type',MIME[path.extname(f).toLowerCase()]||'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const port = await new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{width:1440,height:1000}, deviceScaleFactor:2, colorScheme:'dark' });

// [route, selector, outname]
const SHOTS = [
  ['/transparency-log.html', '.card:nth-of-type(1) .card__art', 'txlog-1'],
  ['/transparency-log.html', '.card:nth-of-type(2) .card__art', 'txlog-2'],
  ['/transparency-log.html', '.card:nth-of-type(3) .card__art', 'txlog-3'],
  ['/report.html', '.card:nth-of-type(1) .card__art', 'report-1'],
  ['/report.html', '.card:nth-of-type(2) .card__art', 'report-2'],
  ['/report.html', '.card:nth-of-type(3) .card__art', 'report-3'],
  ['/badge.html', '.card:nth-of-type(2) .card__art', 'badge-c2'],
  ['/badge.html', '.card:nth-of-type(3) .card__art', 'badge-c3'],
  ['/compare.html', '.kbars', 'compare-kbars'],
  ['/roi.html', '.kbars', 'roi-kbars'],
];
const done=[];
for(const [route,sel,name] of SHOTS){
  try{
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil:'networkidle', timeout:30000 });
    for(let y=0; y<await page.evaluate(()=>document.body.scrollHeight); y+=320){ await page.evaluate(_y=>window.scrollTo(0,_y), y); await page.waitForTimeout(40); }
    await page.waitForTimeout(200);
    const el = page.locator(sel).first();
    await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
    const out = path.join(OUT, name+'.png');
    await el.screenshot({ path: out });
    done.push(name); console.log('ok', name);
    await page.close();
  }catch(e){ console.log('ERR', name, String(e).slice(0,90)); }
}
await browser.close(); server.close();
