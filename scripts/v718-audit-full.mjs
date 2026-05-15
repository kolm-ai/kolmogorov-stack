import { chromium } from 'playwright';
const URL = process.env.URL || 'https://kolm.ai';
const browser = await chromium.launch();

// 1440 desktop full-page
const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const p1 = await ctx1.newPage();
await p1.goto(URL + '/', { waitUntil: 'networkidle', timeout: 30000 });
await p1.waitForTimeout(1500);
await p1.screenshot({ path: 'tmp/v718-audit-1440-full.png', fullPage: true });

// 390 mobile full-page
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const p2 = await ctx2.newPage();
await p2.goto(URL + '/', { waitUntil: 'networkidle', timeout: 30000 });
await p2.waitForTimeout(1500);
await p2.screenshot({ path: 'tmp/v718-audit-390-full.png', fullPage: true });

// Section-by-section captures on desktop
const sections = [
  { sel: '.home-hero-centered',   name: 'hero' },
  { sel: '.demo-anchor',          name: 'demo' },
  { sel: '.ticker',               name: 'ticker' },
  { sel: '.provider-strip',       name: 'provider' },
  { sel: '.live-registry',        name: 'live-registry' },
  { sel: '.brand-mark-moment',    name: 'brand-mark' },
];
for (const s of sections) {
  const el = await p1.$(s.sel);
  if (!el) { console.log('skip', s.name); continue; }
  await el.scrollIntoViewIfNeeded();
  await p1.waitForTimeout(200);
  await el.screenshot({ path: `tmp/v718-section-${s.name}.png` });
}

// Document height
const heights = await p1.evaluate(() => {
  return {
    body: document.body.scrollHeight,
    main: document.querySelector('main')?.scrollHeight || 0,
  };
});
console.log('heights:', heights);

await browser.close();
console.log('done');
