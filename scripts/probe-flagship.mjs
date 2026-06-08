// probe-flagship.mjs — flagship gate. Renders index.html at 1440/768/390 and
// asserts the interactive proof points:
//   • hero H1 wraps clean (no overflow) at every width
//   • hamburger hidden >860, visible+opens <=860
//   • nav-CTA flips ghost->solid on hero scroll-out (solid on mobile)
//   • hero verifier .vw__status == "Verified · demo"
//   • SS04 Forge control => .vw__status "Signed · issuer unknown"
//   • reveal-on-scroll: all .reveal sections become visible (motion-on, human scroll)
// Reduced-motion pass = deterministic screenshots + instant verify settle; a
// separate motion-on pass exercises the real IntersectionObserver reveal path.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'tmp', 'flagship');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
function resolveFile(u) { let p = decodeURIComponent(u.split('?')[0].split('#')[0]); if (p.endsWith('/')) p += 'index.html'; let abs = path.join(PUB, p); if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs; if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) { const i = path.join(abs, 'index.html'); if (fs.existsSync(i)) return i; } if (fs.existsSync(abs + '.html')) return abs + '.html'; return null; }
const server = http.createServer((req, res) => { const f = resolveFile(req.url === '/' ? '/index.html' : req.url); if (!f) { res.statusCode = 404; res.end('nf'); return; } res.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const base = `http://127.0.0.1:${port}`;

const results = [];
const T = (cond, m) => results.push([cond ? 'ok' : 'FAIL', m]);
const note = (m) => results.push(['ok', m]);
const browser = await chromium.launch();
try {
  for (const vp of [{ w: 1440, h: 1024 }, { w: 768, h: 1024 }, { w: 390, h: 844 }]) {
    const errors = [], consoleErrors = [], failed = [];
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, reducedMotion: 'reduce' });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('requestfailed', (r) => { const u = r.url(); if (u.startsWith(base)) failed.push(`${u} :: ${r.failure()?.errorText}`); });
    await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(400);

    // hero H1 wrap
    const h1 = await page.evaluate(() => { const el = document.querySelector('.hero__h1'); if (!el) return null; const tops = new Set(); for (const r of el.getClientRects()) tops.add(Math.round(r.top)); const cs = getComputedStyle(el); return { text: el.textContent.trim(), lines: tops.size, font: cs.fontSize, w: Math.round(el.getBoundingClientRect().width), overflow: el.scrollWidth > el.clientWidth + 1 }; });
    T(h1 && !h1.overflow, `[${vp.w}] hero H1 lines=${h1?.lines} font=${h1?.font} overflow=${h1?.overflow}`);

    // hero verifier status (reduced-motion => checks resolve instantly)
    await page.waitForFunction(() => { const s = document.querySelector('.hero .vw__status'); return s && !/loading|verifying/i.test(s.textContent); }, { timeout: 8000 }).catch(() => {});
    const heroStatus = await page.evaluate(() => { const s = document.querySelector('.hero .vw__status'); return s ? s.textContent.replace(/\s+/g, ' ').trim() : null; });
    T(/verified . demo/i.test(heroStatus || ''), `[${vp.w}] hero verifier status = ${JSON.stringify(heroStatus)}`);

    // hamburger visibility
    const tog = await page.evaluate(() => { const t = document.querySelector('.nav__toggle'); return t ? { vis: t.offsetParent !== null, disp: getComputedStyle(t).display } : null; });
    if (vp.w <= 860) T(tog?.vis, `[${vp.w}] hamburger visible`);
    else T(!tog?.vis, `[${vp.w}] hamburger hidden on desktop (display=${tog?.disp})`);

    // hamburger opens
    if (vp.w <= 860) {
      await page.click('.nav__toggle'); await page.waitForTimeout(200);
      const o = await page.evaluate(() => ({ vis: (document.querySelector('.nav__links')?.offsetParent !== null), exp: document.querySelector('.nav__toggle')?.getAttribute('aria-expanded') }));
      T(o.vis && o.exp === 'true', `[${vp.w}] hamburger opens (aria-expanded=${o.exp})`);
      await page.click('.nav__toggle').catch(() => {}); await page.waitForTimeout(120);
    }

    // nav CTA flip
    const before = await page.evaluate(() => document.querySelector('.nav__cta')?.classList.contains('is-solid'));
    await page.evaluate(() => window.scrollTo(0, document.querySelector('.hero').getBoundingClientRect().height + innerHeight));
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({ solid: document.querySelector('.nav__cta')?.classList.contains('is-solid'), bg: getComputedStyle(document.querySelector('.nav__cta')).backgroundColor }));
    if (vp.w <= 860) T(after.solid, `[${vp.w}] nav CTA solid on mobile (bg=${after.bg})`);
    else T(!before && after.solid, `[${vp.w}] nav CTA flips ghost(${before})->solid(${after.solid}) on hero scroll-out`);
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(150);

    // screenshot (reduced-motion => all reveals visible, full content shown)
    await page.screenshot({ path: path.join(OUT, `home-${vp.w}.png`), fullPage: true });
    T(errors.length === 0, `[${vp.w}] pageerrors=${errors.length}${errors.length ? ' :: ' + errors.join(' | ') : ''}`);
    T(consoleErrors.length === 0, `[${vp.w}] console=${consoleErrors.length}${consoleErrors.length ? ' :: ' + consoleErrors.slice(0, 3).join(' | ') : ''}`);
    T(failed.length === 0, `[${vp.w}] failedReq=${failed.length}${failed.length ? ' :: ' + failed.slice(0, 4).join(' | ') : ''}`);
    await page.close();
  }

  // ---- reveal-on-scroll: motion ON, human-like slow scroll ----
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1024 }, reducedMotion: 'no-preference' });
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    await page.evaluate(async () => { for (let y = 0; y <= document.body.scrollHeight; y += 220) { window.scrollTo(0, y); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 55))); } });
    await page.waitForTimeout(500);
    const rv = await page.evaluate(() => { const all = [...document.querySelectorAll('.reveal')]; return { total: all.length, stuck: all.filter((e) => parseFloat(getComputedStyle(e).opacity) < 0.5).length }; });
    T(rv.stuck === 0, `[reveal] ${rv.total} sections, ${rv.stuck} stuck after human scroll`);
    await page.close();
  }

  // ---- SS04 Forge control ----
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1024 }, reducedMotion: 'reduce' });
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const btn = await page.$('button:has-text("Forge with a rogue key")');
    if (!btn) { T(false, '[forge] Forge button not found'); }
    else {
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => /Restore genuine|forge unsupported/i.test(x.textContent)); return !!b; }, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(600);
      const st = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /Restore genuine|forge unsupported/i.test(x.textContent));
        const w = b ? b.closest('.vw') : null;
        const status = w ? w.querySelector('.vw__status') : null;
        const prov = w ? w.querySelector('.vw__prov') : null;
        return { btn: b?.textContent.trim(), status: status?.textContent.replace(/\s+/g, ' ').trim(), provBad: prov?.classList.contains('is-bad'), prov: prov?.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) };
      });
      T(/issuer unknown/i.test(st.status || ''), `[forge] btn="${st.btn}" status=${JSON.stringify(st.status)}`);
      T(st.provBad === true, `[forge] provenance is-bad=${st.provBad} :: ${st.prov}`);
      await page.screenshot({ path: path.join(OUT, 'forge-state.png') });
    }
    await page.close();
  }
} finally { await browser.close(); server.close(); }

console.log('\n==== FLAGSHIP PROBE ====');
let bad = 0;
for (const [s, m] of results) { if (s === 'FAIL') bad++; console.log(`${s === 'FAIL' ? 'FAIL ' : 'ok   '}${m}`); }
console.log(`\n${bad ? `FLAGSHIP: ${bad} issue(s)` : 'FLAGSHIP: PASS'} — shots in tmp/flagship/`);
process.exit(bad ? 1 : 0);
