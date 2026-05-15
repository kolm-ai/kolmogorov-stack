import { chromium } from 'playwright';
const URL = process.env.URL || 'http://localhost:8787';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: 'dark' });
const page = await ctx.newPage();

const targets = ['/', '/api', '/whitepaper', '/changelog', '/pricing', '/threat-model', '/use-cases'];
for (const u of targets) {
  await page.goto(URL + u, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const probe = await page.evaluate(() => {
    const docW = document.documentElement.scrollWidth;
    const winW = window.innerWidth;
    const ems = (document.body.innerHTML.match(/&mdash;|—/g) || []).length;
    const oversize = [...document.querySelectorAll('section, .wrap, .card, .panel, .api-section, article')]
      .filter((el) => el.getBoundingClientRect().width > winW + 2)
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className.split(' ')[0]}@${Math.round(el.getBoundingClientRect().width)}`);
    return { docW, winW, ems, pageH: document.documentElement.scrollHeight, oversize };
  });
  console.log(u.padEnd(18), 'docW='+probe.docW, 'winW='+probe.winW, 'em='+probe.ems, 'h='+probe.pageH, probe.oversize.length?'OVERSIZE='+probe.oversize.join(','):'');
}
await browser.close();
