// SOTA visual audit of kolm.ai across critical pages × 4 contexts
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://kolm.ai';
const OUT = 'C:/Users/user/Desktop/kolmogorov-stack/audit-shots';
mkdirSync(OUT, { recursive: true });

const pages = [
  '/',
  '/quickstart',
  '/pricing',
  '/research',
  '/developers',
  '/solutions',
  '/docs',
  '/api',
  '/leaderboard',
  '/k-score',
  '/healthcare',
  '/compare',
];

const contexts = [
  { name: 'desktop-dark', vp: { width: 1440, height: 900 }, theme: 'dark' },
  { name: 'desktop-light', vp: { width: 1440, height: 900 }, theme: 'light' },
  { name: 'mobile-dark', vp: { width: 390, height: 844 }, theme: 'dark' },
  { name: 'mobile-light', vp: { width: 390, height: 844 }, theme: 'light' },
];

const issues = [];
const report = (page, ctx, sel, desc) => {
  issues.push({ page, ctx, sel, desc });
};

const auditPage = async (browser, urlPath, ctx) => {
  const context = await browser.newContext({
    viewport: ctx.vp,
    userAgent: ctx.vp.width < 500
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      : undefined,
  });
  const page = await context.newPage();
  const url = BASE + urlPath;
  let status = 0;
  try {
    if (ctx.theme === 'light') {
      // pre-set theme so FOUC-safe boot picks it up (key is 'kolm-theme', verified)
      await context.addInitScript(() => {
        try { localStorage.setItem('kolm-theme', 'light'); } catch {}
      });
    }
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    status = resp ? resp.status() : 0;
    if (status >= 400) {
      await context.close();
      return { status, skipped: true };
    }
    // wait briefly for fonts/animations
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);

    // verify theme attr matches what we asked for
    const themeAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme') || 'dark');

    // ---- Audit checks ----
    const data = await page.evaluate(({ vw, askedTheme }) => {
      const out = {
        themeAttr: document.documentElement.getAttribute('data-theme') || 'dark',
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyColor: getComputedStyle(document.body).color,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        viewportWidth: vw,
        emDashes: [],
        mojibake: [],
        wideElements: [],
        inlineDarkStyle: [],
        inlineLightOnDark: [],
        ctaCollisions: [],
        tabBleed: [],
        rawBg: [],
      };

      // 1. em-dashes in visible text
      const treeWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      const emDashSet = new Set();
      const mojibakeSet = new Set();
      while ((n = treeWalker.nextNode())) {
        const t = n.nodeValue || '';
        if (!t.trim()) continue;
        const parent = n.parentElement;
        if (!parent) continue;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') continue;
        const cs = getComputedStyle(parent);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        // em-dash
        if (t.includes('—')) {
          const snip = t.replace(/\s+/g, ' ').trim().slice(0, 80);
          if (!emDashSet.has(snip)) {
            emDashSet.add(snip);
            out.emDashes.push({ tag, snip });
          }
        }
        // mojibake: stray ??, CJK in non-CJK page, replacement char
        if (/�/.test(t) || /[一-鿿぀-ヿ]/.test(t)) {
          const snip = t.replace(/\s+/g, ' ').trim().slice(0, 80);
          if (!mojibakeSet.has(snip)) {
            mojibakeSet.add(snip);
            out.mojibake.push({ tag, snip });
          }
        }
      }

      // 2. mobile overflow — elements wider than viewport
      if (vw <= 500) {
        const all = document.querySelectorAll('*');
        const seen = new Set();
        for (const el of all) {
          const r = el.getBoundingClientRect();
          if (r.width > vw + 1 && r.height > 0) {
            const sel = (el.tagName + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).slice(0, 2).join('.') : '')).slice(0, 100);
            if (!seen.has(sel)) {
              seen.add(sel);
              out.wideElements.push({ sel, w: Math.round(r.width), vw });
            }
            if (out.wideElements.length >= 8) break;
          }
        }
      }

      // 3. inline style leaks — light page but elements with dark bg inline
      const askedLight = askedTheme === 'light';
      const inlineEls = document.querySelectorAll('[style]');
      const seenStyle = new Set();
      for (const el of inlineEls) {
        const s = el.getAttribute('style') || '';
        const sel = (el.tagName + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).slice(0, 2).join('.') : '')).slice(0, 80);
        if (askedLight) {
          // dark bg colors inline on light page
          if (/background\s*:\s*(#0[0-9a-f]{5}|#1[0-9a-f]{5}|black|rgb\(0\s*,\s*0\s*,\s*0\)|rgba\(0\s*,\s*0\s*,\s*0)/i.test(s) ||
              /background-color\s*:\s*(#0[0-9a-f]{5}|#1[0-9a-f]{5}|black)/i.test(s)) {
            if (!seenStyle.has(sel + ':bg')) {
              seenStyle.add(sel + ':bg');
              out.inlineDarkStyle.push({ sel, s: s.slice(0, 100) });
            }
          }
          // white text inline on light page
          if (/color\s*:\s*(#fff|#ffffff|white|rgb\(255\s*,\s*255\s*,\s*255\))/i.test(s)) {
            const cs = getComputedStyle(el);
            const bg = cs.backgroundColor;
            // only report if backdrop is also lightish
            if (bg && /rgba?\((\d+),\s*(\d+),\s*(\d+)/.test(bg)) {
              const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
              const lum = (+m[1] + +m[2] + +m[3]) / 3;
              if (lum > 180) {
                if (!seenStyle.has(sel + ':color')) {
                  seenStyle.add(sel + ':color');
                  out.inlineLightOnDark.push({ sel, s: s.slice(0, 100), bg });
                }
              }
            }
          }
        }
      }

      // 4. CTA collision on mobile — adjacent buttons with <6px gap
      if (vw <= 500) {
        const btnSelectors = ['.btn', '.button', '[class*="cta"]', 'a.btn', 'button'];
        const btns = Array.from(document.querySelectorAll(btnSelectors.join(',')));
        for (let i = 0; i < btns.length - 1; i++) {
          const a = btns[i].getBoundingClientRect();
          const b = btns[i + 1].getBoundingClientRect();
          if (a.height === 0 || b.height === 0) continue;
          // if stacked vertically same column
          if (Math.abs(a.left - b.left) < 30 && b.top > a.top) {
            const gap = b.top - (a.top + a.height);
            if (gap >= 0 && gap < 6) {
              out.ctaCollisions.push({
                sel: btns[i].tagName + '.' + (btns[i].className || '').split(/\s+/)[0],
                gap: Math.round(gap),
              });
              if (out.ctaCollisions.length >= 4) break;
            }
          }
        }
      }

      // 5. tab bleed — adjacent inline tab elements with <6px gap
      const tabSelectors = ['[role="tab"]', '.tab', '.uc-tab', '[data-tab]', '.nav-link', '.tabs button', '.tabs a'];
      const tabs = Array.from(document.querySelectorAll(tabSelectors.join(',')));
      for (let i = 0; i < tabs.length - 1; i++) {
        const a = tabs[i].getBoundingClientRect();
        const b = tabs[i + 1].getBoundingClientRect();
        if (a.height === 0 || b.height === 0) continue;
        // horizontally adjacent
        if (Math.abs(a.top - b.top) < 8 && b.left > a.left + a.width - 2) {
          const gap = b.left - (a.left + a.width);
          if (gap >= 0 && gap < 6) {
            // check for divider via border-right/left
            const cs = getComputedStyle(tabs[i]);
            const csB = getComputedStyle(tabs[i + 1]);
            const hasDivider = (cs.borderRightWidth && parseFloat(cs.borderRightWidth) > 0) ||
                               (csB.borderLeftWidth && parseFloat(csB.borderLeftWidth) > 0);
            if (!hasDivider) {
              out.tabBleed.push({
                sel: (tabs[i].tagName + '.' + (tabs[i].className || '').split(/\s+/)[0]).slice(0, 60),
                gap: Math.round(gap),
              });
              if (out.tabBleed.length >= 4) break;
            }
          }
        }
      }

      // 6. body background mismatch — light page but body bg appears dark
      if (askedLight) {
        const bm = out.bodyBg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (bm) {
          const lum = (+bm[1] + +bm[2] + +bm[3]) / 3;
          if (lum < 100) {
            out.rawBg.push({ where: 'body', bg: out.bodyBg, lum });
          }
        }
      }

      return out;
    }, { vw: ctx.vp.width, askedTheme: ctx.theme });

    // record results
    if (ctx.theme === 'light' && data.themeAttr !== 'light') {
      report(urlPath, ctx.name, 'html[data-theme]', `Theme attribute is "${data.themeAttr}" not "light" (toggle script may have failed)`);
    }
    for (const e of data.emDashes) {
      report(urlPath, ctx.name, e.tag, `Em-dash regression: "${e.snip}"`);
    }
    for (const e of data.mojibake) {
      report(urlPath, ctx.name, e.tag, `Mojibake/CJK char: "${e.snip}"`);
    }
    for (const e of data.wideElements) {
      report(urlPath, ctx.name, e.sel, `Mobile overflow: width ${e.w}px > viewport ${e.vw}px`);
    }
    for (const e of data.inlineDarkStyle) {
      report(urlPath, ctx.name, e.sel, `Light-mode bleed: dark inline style "${e.s}"`);
    }
    for (const e of data.inlineLightOnDark) {
      report(urlPath, ctx.name, e.sel, `Light text on light bg: "${e.s}" bg=${e.bg}`);
    }
    for (const e of data.ctaCollisions) {
      report(urlPath, ctx.name, e.sel, `CTA collision: stacked buttons with ${e.gap}px gap`);
    }
    for (const e of data.tabBleed) {
      report(urlPath, ctx.name, e.sel, `Tab bleed: ${e.gap}px gap with no divider`);
    }
    for (const e of data.rawBg) {
      report(urlPath, ctx.name, 'body', `Light-mode bleed: body bg ${e.bg} (lum ${e.lum.toFixed(0)}) on light page`);
    }

    // screenshot
    const fname = `${urlPath === '/' ? 'home' : urlPath.replace(/^\//, '').replace(/\//g, '_')}__${ctx.name}.png`;
    await page.screenshot({ path: join(OUT, fname), fullPage: true, timeout: 15000 }).catch(() => {});

    await context.close();
    return { status, data };
  } catch (e) {
    await context.close().catch(() => {});
    return { status, error: String(e).slice(0, 200) };
  }
};

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  for (const p of pages) {
    for (const ctx of contexts) {
      const r = await auditPage(browser, p, ctx);
      const tag = r.skipped ? `skip ${r.status}` : r.error ? `err ${r.error.slice(0, 40)}` : `ok ${r.status}`;
      console.log(`${p}  ${ctx.name}  ${tag}`);
    }
  }
  await browser.close();
  writeFileSync(join(OUT, 'issues.json'), JSON.stringify(issues, null, 2));
  console.log(`\nTotal issues: ${issues.length}`);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
