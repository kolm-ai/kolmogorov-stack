// render-verify.mjs — functional test of the bespoke two-tier verifier on /verify.
// Serves public/ statically, drives the actual buttons, and asserts the WebCrypto
// verdict logic still works against the new kolm-2026.css. Exits non-zero on any
// failed assertion, page error, console error, or failed request.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function resolveFile(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (p.endsWith('/')) p = p + 'index.html';
  let abs = path.join(PUB, p);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) { const idx = path.join(abs, 'index.html'); if (fs.existsSync(idx)) return idx; }
  if (fs.existsSync(abs + '.html')) return abs + '.html';
  return null;
}
const server = http.createServer((req, res) => {
  const file = resolveFile(req.url === '/' ? '/index.html' : req.url);
  if (!file) { res.statusCode = 404; res.end('not found: ' + req.url); return; }
  res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const base = `http://127.0.0.1:${port}`;

const fails = [];
const ok = [];
function assert(cond, label, extra) { if (cond) ok.push(label); else fails.push(label + (extra ? ` :: ${extra}` : '')); }

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  const pageErrors = [], consoleErrors = [], failedReq = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', (r) => { const u = r.url(); if (u.startsWith(base)) failedReq.push(`${u} :: ${r.failure()?.errorText}`); });

  await page.goto(base + '/verify', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(400);

  const outStatus = () => page.locator('#outStatus').innerText();

  // run() sets outStatus to "verifying…" on entry, animates check rows in (~200ms
  // each), then sets the terminal verdict. So: click -> wait for the run to START
  // (status becomes "verifying") -> wait for it to FINISH (status is terminal),
  // which avoids reading the previous run's stale verdict mid-animation.
  async function triggerAndSettle(id) {
    await page.locator('#' + id).click();
    await page.waitForFunction(() => /verifying/i.test(document.getElementById('outStatus')?.textContent || ''), null, { timeout: 9000 });
    await page.waitForFunction(() => {
      const t = document.getElementById('outStatus')?.textContent || '';
      return t.length > 0 && !/verifying/i.test(t);
    }, null, { timeout: 20000 });
    await page.waitForTimeout(150);
    return outStatus();
  }

  // 1) Load the sample evidence report -> auto-verifies. Pin is checked by default,
  //    and the sample is signed by the demo issuer, so verdict should be green.
  const s1 = await triggerAndSettle('sampleBtn');
  assert(/^Verified/i.test(s1), 'sample report verifies green', `outStatus="${s1}"`);
  const checks1 = await page.locator('#out .vw__check').count();
  assert(checks1 >= 2, 'verification rendered multiple checks', `count=${checks1}`);
  const recognizedIssuer = await page.locator('#out .vw__check.ok', { hasText: 'recognized kolm issuer key' }).count();
  assert(recognizedIssuer >= 1, 'tier-2 recognizes the demo issuer key', `count=${recognizedIssuer}`);

  // 2) Tamper a field -> signature must break -> not verified (red).
  const s2 = await triggerAndSettle('tamperBtn');
  assert(/Not verified/i.test(s2), 'tampered report reads Not verified', `outStatus="${s2}"`);
  const badChecks = await page.locator('#out .vw__check.bad').count();
  assert(badChecks >= 1, 'tamper produced a failed check row', `badCount=${badChecks}`);

  // 3) Reload sample, then forge with a rogue key -> tier1 passes, tier2 fails ->
  //    "Untampered, but NOT a kolm-issued report".
  await triggerAndSettle('sampleBtn');
  const s3 = await triggerAndSettle('forgeBtn');
  assert(/NOT a kolm-issued report/i.test(s3), 'forged report flagged as not kolm-issued', `outStatus="${s3}"`);

  // 4) Sample receipt path (different verifier branch).
  const s4 = await triggerAndSettle('sampleRcptBtn');
  assert(/Verified offline/i.test(s4), 'sample receipt verifies offline', `outStatus="${s4}"`);

  // 5) Reveals fail-open: careful scroll, then assert no .reveal stuck invisible.
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.35);
    for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 220)); }
    window.scrollTo(0, document.body.scrollHeight); await new Promise((r) => setTimeout(r, 300));
  });
  const revealState = await page.evaluate(() => {
    const all = document.querySelectorAll('.reveal');
    let hidden = 0; all.forEach((el) => { if (parseFloat(getComputedStyle(el).opacity) < 0.5) hidden++; });
    return { total: all.length, hidden };
  });
  assert(revealState.hidden === 0, 'no reveal section stuck invisible', `hidden=${revealState.hidden}/${revealState.total}`);

  // 6) No page errors / console errors / failed requests.
  assert(pageErrors.length === 0, 'no page errors', pageErrors.join(' | '));
  assert(consoleErrors.length === 0, 'no console errors', consoleErrors.slice(0, 4).join(' | '));
  assert(failedReq.length === 0, 'no failed requests', failedReq.slice(0, 6).join(' | '));

  await page.screenshot({ path: path.join(ROOT, 'tmp', 'verify-functional.png'), fullPage: true });
  await page.close();
} finally { if (browser) await browser.close(); server.close(); }

for (const l of ok) console.log('  ok   ' + l);
for (const l of fails) console.log('  FAIL ' + l);
console.log('\n' + (fails.length ? `VERIFY: ${fails.length} assertion(s) failed` : `VERIFY: PASS — ${ok.length}/${ok.length} assertions`));
process.exit(fails.length ? 1 : 0);
