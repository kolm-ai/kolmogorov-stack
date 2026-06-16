// Phase F: fresh crops of every "presented" graphic on a page, for visual audit.
// Usage: node scripts/_pf-graphic-crops.mjs <route> <outdir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const route = process.argv[2] || '/';
const outdir = path.join(ROOT, process.argv[3] || 'tmp/pf-crops');
fs.mkdirSync(outdir, { recursive: true });
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json' };
function resolveFile(urlPath){ let p=decodeURIComponent(urlPath.split('?')[0].split('#')[0]); if(p.endsWith('/'))p+='index.html'; let abs=path.join(PUB,p); if(fs.existsSync(abs)&&fs.statSync(abs).isFile())return abs; if(fs.existsSync(abs+'.html'))return abs+'.html'; return null; }
const server = http.createServer((req,res)=>{ if(req.url.startsWith('/v1/')){res.statusCode=401;res.end('{"ok":false}');return;} const f=resolveFile(req.url==='/'?'/index.html':req.url); if(!f){res.statusCode=404;res.end('nf');return;} res.setHeader('Content-Type',MIME[path.extname(f).toLowerCase()]||'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const port = await new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{width:1440,height:1000}, deviceScaleFactor:2, colorScheme:'dark' });
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil:'networkidle', timeout:30000 });
// trigger reveals: careful scroll
for(let y=0; y<await page.evaluate(()=>document.body.scrollHeight); y+=300){ await page.evaluate(_y=>window.scrollTo(0,_y), y); await page.waitForTimeout(60); }
await page.evaluate(()=>window.scrollTo(0,0)); await page.waitForTimeout(300);
const figs = await page.locator('figure.kinst, figure.kolm-hero, figure.artifact, figure.instrument, figure.anat').all();
let i=0; const meta=[];
for(const fg of figs){
  try{
    await fg.scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
    const label = (await fg.getAttribute('aria-label'))||'';
    const cls = (await fg.getAttribute('class'))||'';
    const name = `${String(i).padStart(2,'0')}.png`;
    await fg.screenshot({ path: path.join(outdir, name) });
    meta.push({ i, name, cls, label: label.slice(0,120) });
    i++;
  }catch(e){ meta.push({ i, err:String(e).slice(0,80) }); i++; }
}
fs.writeFileSync(path.join(outdir,'_index.json'), JSON.stringify(meta,null,2));
for(const m of meta) console.log(m.name||'?', '::', m.cls||m.err);
await browser.close(); server.close();
