#!/usr/bin/env node
// W905 / W921 demo video recorder: play /demo-live cinematic, capture as MP4.
//
// W921 fixes (DEMO-9 / DEMO-10):
//   - Target a PINNED LOCAL build by default (a static server over ./public),
//     not live prod, so the asset is reproducible-by-construction and does not
//     depend on whatever is currently deployed.
//   - Drive the page with ?record=1, which DISABLES the page's 500ms autoplay
//     so the recorder is the sole play trigger. We then click #playBtn exactly
//     once (no double-toggle that would pause a self-started timeline).
//   - Derive RECORD_MS from the timeline's actual TOTAL (sum of beat spans +
//     per-beat tail pad, mirroring demo-live.html BEAT_PAD), so there is no
//     dead tail. RECORD_MS env still overrides for manual runs.
import { chromium } from 'playwright';
import { mkdirSync, renameSync, readdirSync, statSync, readFileSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import http from 'node:http';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_DIR = join(REPO_ROOT, 'public');
const OUT = resolve(process.env.OUT || '_audit/w905/video');
mkdirSync(OUT, { recursive: true });

// --- derive the record duration from the committed timeline (no dead tail) ---
const BEAT_PAD = 1.6; // MUST match public/demo-live.html BEAT_PAD
function timelineTotalMs() {
  try {
    const tl = JSON.parse(readFileSync(join(PUBLIC_DIR, 'demo-live-timeline.json'), 'utf8'));
    let total = 0;
    for (const b of (tl.beats || [])) {
      const evs = (b.events || []).slice().sort((a, c) => a.at - c.at);
      const span = evs.length ? evs[evs.length - 1].at : 0;
      total += span + BEAT_PAD;
    }
    // +1.8s lead for the click + +2.0s tail so the final verified frame settles
    return Math.round((total + 1.8 + 2.0) * 1000);
  } catch {
    return 42000;
  }
}
const RECORD_MS = parseInt(process.env.RECORD_MS || String(timelineTotalMs()), 10);

// --- pinned local static server over ./public (the build under test) ---
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff',
};
let server = null;
let baseUrl = process.env.URL || null;
async function startLocalServer() {
  return new Promise((res) => {
    server = http.createServer((req, resp) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/demo-live') p = '/demo-live.html';
      if (p === '/' || p === '') p = '/index.html';
      const file = join(PUBLIC_DIR, p.replace(/^\/+/, ''));
      if (!file.startsWith(PUBLIC_DIR)) { resp.statusCode = 403; return resp.end('forbidden'); }
      try {
        statSync(file);
        const ext = file.slice(file.lastIndexOf('.'));
        resp.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        createReadStream(file).pipe(resp);
      } catch {
        resp.statusCode = 404; resp.end('not found');
      }
    }).listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      res(`http://127.0.0.1:${port}`);
    });
  });
}

if (!baseUrl) {
  const origin = await startLocalServer();
  baseUrl = `${origin}/demo-live.html`;
  console.log(`[w905-video] pinned local build: serving ./public at ${origin}`);
}
// always drive with ?record=1 so the page does NOT autoplay
const URL = baseUrl.includes('?') ? `${baseUrl}&record=1` : `${baseUrl}?record=1`;

console.log(`[w905-video] recording ${URL} for ${(RECORD_MS / 1000).toFixed(1)}s -> ${OUT}`);

const VIEWPORT = { width: 1920, height: 1080 };

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  recordVideo: { dir: OUT, size: VIEWPORT },
});
const page = await context.newPage();

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });

// The page is NOT autoplaying (?record=1). We are the sole play trigger:
// click #playBtn exactly once. No play-state guesswork, no double-toggle.
try {
  await page.waitForSelector('#playBtn', { timeout: 5000 });
  await page.click('#playBtn');
  console.log('[w905-video] #playBtn clicked once (recorder is sole trigger)');
} catch (e) {
  console.log('[w905-video] #playBtn not found:', e.message);
}

console.log(`[w905-video] waiting ${(RECORD_MS / 1000).toFixed(1)}s for cinematic playback...`);
await page.waitForTimeout(RECORD_MS);

await context.close();
await browser.close();
if (server) server.close();

// Find the webm Playwright wrote and convert to MP4
const webms = readdirSync(OUT).filter((f) => f.endsWith('.webm')).sort((a, b) => statSync(join(OUT, b)).mtimeMs - statSync(join(OUT, a)).mtimeMs);
if (!webms.length) {
  console.error('[w905-video] no .webm produced');
  process.exit(1);
}
const webmPath = join(OUT, webms[0]);
const mp4Path = join(OUT, 'demo-w905.mp4');
const webmSize = (statSync(webmPath).size / 1024 / 1024).toFixed(2);
console.log(`[w905-video] webm: ${webmPath} (${webmSize} MB)`);
console.log('[w905-video] converting to MP4 (h264 + faststart)...');

try {
  execSync(`ffmpeg -y -i "${webmPath}" -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -movflags +faststart -f mp4 "${mp4Path}"`, { stdio: 'inherit' });
  const mp4Size = (statSync(mp4Path).size / 1024 / 1024).toFixed(2);
  console.log(`[w905-video] mp4: ${mp4Path} (${mp4Size} MB)`);
} catch (e) {
  console.error('[w905-video] ffmpeg failed:', e.message);
  process.exit(2);
}
