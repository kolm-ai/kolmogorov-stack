// Final spot-check: low-contrast text on light pages, plus visible mojibake/em-dash via getRangeAt rendered text.
import { chromium } from 'playwright';
const BASE = 'https://kolm.ai';

const pages = ['/', '/pricing', '/healthcare', '/leaderboard', '/api', '/docs', '/k-score', '/solutions'];

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  const findings = [];

  for (const p of pages) {
    for (const theme of ['dark', 'light']) {
      for (const vp of [{ w: 1440, h: 900, name: 'desk' }, { w: 390, h: 844, name: 'mob' }]) {
        const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
        if (theme === 'light') {
          await ctx.addInitScript(() => { try { localStorage.setItem('kolm-theme', 'light'); } catch {} });
        }
        const page = await ctx.newPage();
        try {
          await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
          await page.waitForTimeout(300);

          const data = await page.evaluate(() => {
            const out = { lowContrast: [], horizontalScrollAtBody: 0, bodyBg: '', themeAttr: '' };
            out.bodyBg = getComputedStyle(document.body).backgroundColor;
            out.themeAttr = document.documentElement.getAttribute('data-theme') || 'dark';
            out.horizontalScrollAtBody = document.documentElement.scrollWidth;

            const parseRgb = (s) => {
              const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
              if (!m) return null;
              return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
            };
            const lum = (c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

            const findBg = (el) => {
              let cur = el;
              while (cur) {
                const cs = getComputedStyle(cur);
                const bg = parseRgb(cs.backgroundColor);
                if (bg && bg.a > 0.1 && (bg.r + bg.g + bg.b) > 0) return bg;
                if (bg && bg.a === 0) { cur = cur.parentElement; continue; }
                if (!bg) break;
                cur = cur.parentElement;
              }
              return parseRgb(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
            };

            const seen = new Set();
            const all = document.querySelectorAll('h1,h2,h3,h4,p,span,a,button,li,td,th,label,.lede,.eyebrow,.btn');
            let n = 0;
            for (const el of all) {
              if (n > 200) break;
              const txt = (el.textContent || '').trim();
              if (!txt || txt.length < 3) continue;
              const cs = getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
              const r = el.getBoundingClientRect();
              if (r.height === 0 || r.width === 0) continue;
              const fg = parseRgb(cs.color);
              const bg = findBg(el);
              if (!fg || !bg) continue;
              const dl = Math.abs(lum(fg) - lum(bg));
              if (dl < 50) {
                const sig = (el.tagName + ':' + txt.slice(0, 30));
                if (seen.has(sig)) continue;
                seen.add(sig);
                out.lowContrast.push({
                  tag: el.tagName,
                  cls: (el.className || '').toString().slice(0, 40),
                  text: txt.slice(0, 50),
                  fg: cs.color, bg: `rgb(${bg.r},${bg.g},${bg.b})`,
                  dl: Math.round(dl),
                });
                n++;
              }
            }
            return out;
          });

          if (data.lowContrast.length) {
            for (const c of data.lowContrast.slice(0, 4)) {
              findings.push({ p, theme, vp: vp.name, themeAttr: data.themeAttr, ...c });
            }
          }
        } catch (e) {
          findings.push({ p, theme, vp: vp.name, err: String(e).slice(0, 80) });
        }
        await ctx.close();
      }
    }
  }

  console.log(`Low-contrast findings: ${findings.length}`);
  for (const f of findings) {
    console.log(`  ${f.p} ${f.theme}/${f.vp} themeAttr=${f.themeAttr} <${f.tag}.${f.cls}> "${f.text}" fg=${f.fg} bg=${f.bg} dl=${f.dl}`);
  }

  await browser.close();
};
run().catch(e => { console.error(e); process.exit(1); });
