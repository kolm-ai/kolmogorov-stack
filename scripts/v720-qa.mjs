// v7.20 . full-page QA. Captures hero + train-any + lifecycle + the rest in
// dark + light theme at desktop 1440 and mobile 390. Affirmative probes:
// (a) .train-any section exists and has 6 ta-cards visible (any AI breadth),
// (b) .lifecycle section exists and has 3 lc-cards (compile/run/improve),
// (c) .after-compile is hidden (deduplicated),
// (d) section padding matches new rhythm tokens (--rhythm-5 = 96px desktop).
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const URL = process.env.URL || 'http://localhost:8787';
const OUT = process.env.OUT || join(process.cwd(), 'qa', 'v720');
mkdirSync(OUT, { recursive: true });

const SCENARIOS = [
  { name: 'dark-desktop-1440',  theme: 'dark',  width: 1440, height: 900, path: '/' },
  { name: 'light-desktop-1440', theme: 'light', width: 1440, height: 900, path: '/' },
  { name: 'dark-mobile-390',    theme: 'dark',  width: 390,  height: 844, path: '/' },
  { name: 'light-mobile-390',   theme: 'light', width: 390,  height: 844, path: '/' },
];

const browser = await chromium.launch();
const results = [];

for (const s of SCENARIOS) {
  const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript((theme) => {
    try { localStorage.setItem('kolm-theme', theme); } catch (_) {}
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  }, s.theme);
  await page.goto(URL + s.path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const probe = await page.evaluate(() => {
    const cs = (el) => el ? getComputedStyle(el) : null;
    const trainAny = document.querySelector('section.train-any');
    const taCards = document.querySelectorAll('section.train-any .ta-card');
    const lifecycle = document.querySelector('section.lifecycle');
    const lcCards = document.querySelectorAll('section.lifecycle .lc-card');
    const afterCompile = document.querySelector('section.after-compile');
    const rootStyle = cs(document.documentElement);
    const rhythm5 = rootStyle.getPropertyValue('--rhythm-5').trim();
    const rhythm6 = rootStyle.getPropertyValue('--rhythm-6').trim();
    const trainAnyPadding = trainAny ? cs(trainAny).paddingTop : null;
    const lifecyclePadding = lifecycle ? cs(lifecycle).paddingTop : null;
    return {
      theme: document.documentElement.getAttribute('data-theme') || 'dark',
      hasTrainAny: !!trainAny,
      taCardCount: taCards.length,
      hasLifecycle: !!lifecycle,
      lcCardCount: lcCards.length,
      afterCompileHidden: !!afterCompile && (afterCompile.hasAttribute('hidden') || cs(afterCompile).display === 'none'),
      rhythm5,
      rhythm6,
      trainAnyPadding,
      lifecyclePadding,
    };
  });

  await page.screenshot({ fullPage: true, path: join(OUT, `${s.name}-full.png`) });
  await page.screenshot({ fullPage: false, path: join(OUT, `${s.name}-fold.png`) });

  results.push({ scenario: s.name, probe });
  await ctx.close();
}

await browser.close();
writeFileSync(join(OUT, 'qa.json'), JSON.stringify(results, null, 2));

let pass = true;
for (const r of results) {
  const p = r.probe;
  console.log(`\n=== ${r.scenario} (theme: ${p.theme}) ===`);
  const isMobile = r.scenario.includes('mobile');
  const expectedRhythm = isMobile ? '72px' : '128px';
  const checks = [
    ['.train-any exists', p.hasTrainAny],
    ['.train-any has 6 cards', p.taCardCount === 6],
    ['.lifecycle exists', p.hasLifecycle],
    ['.lifecycle has 3 cards', p.lcCardCount === 3],
    ['.after-compile hidden', p.afterCompileHidden],
    ['--rhythm-5 = 96px (desktop default)', p.rhythm5 === '96px'],
    ['--rhythm-6 = 128px (signature breath)', p.rhythm6 === '128px'],
    [`train-any padding ${expectedRhythm}`, p.trainAnyPadding === expectedRhythm],
    [`lifecycle padding ${expectedRhythm}`, p.lifecyclePadding === expectedRhythm],
  ];
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) pass = false;
  }
  console.log(`  rhythm-5: ${p.rhythm5} / rhythm-6: ${p.rhythm6}`);
  console.log(`  train-any padding: ${p.trainAnyPadding} / lifecycle: ${p.lifecyclePadding}`);
  console.log(`  ta-cards: ${p.taCardCount} / lc-cards: ${p.lcCardCount} / after-compile hidden: ${p.afterCompileHidden}`);
}

process.exit(pass ? 0 : 1);
