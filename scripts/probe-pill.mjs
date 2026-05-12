import { chromium } from 'playwright';
const b = await chromium.launch();

async function check(label, setup) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  if (setup) await setup(ctx, page);
  await page.goto('http://localhost:8787/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const pill = await page.$('.kolm-auth-pill');
  const visible = pill ? await pill.isVisible() : false;
  const lkey = await page.evaluate(() => localStorage.getItem('kolm_api_key'));
  console.log(`[${label}] pill=${visible ? 'SHOWN' : 'hidden'} localStorage=${lkey ? lkey.slice(0,12)+'…' : 'empty'}`);
  await ctx.close();
}

// 1. Fresh visitor — no cookie, no localStorage → no pill
await check('fresh-visitor', null);

// 2. Stale localStorage with junk key, no cookie → /v1/account 401 → clearKeys, no pill
await check('stale-junk-key', async (ctx, page) => {
  await page.goto('http://localhost:8787/404');
  await page.evaluate(() => {
    localStorage.setItem('kolm_api_key', 'ks_deadbeef00000000000000000000000a');
  });
});

// 3. Valid key in localStorage → /v1/account 200 → renderPill
await check('valid-key', async (ctx, page) => {
  await page.goto('http://localhost:8787/404');
  await page.evaluate((k) => {
    localStorage.setItem('kolm_api_key', k);
  }, 'ks_b5712beb6495d42a834d83a48a828efa');
});

await b.close();
