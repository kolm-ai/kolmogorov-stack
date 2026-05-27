#!/usr/bin/env node
// W905 demo video recorder: play /demo-live cinematic, capture as MP4.
import { chromium } from 'playwright';
import { mkdirSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const URL = process.env.URL || 'https://kolm.ai/demo-live';
const OUT = resolve(process.env.OUT || '_audit/w905/video');
mkdirSync(OUT, { recursive: true });
const RECORD_MS = parseInt(process.env.RECORD_MS || '90000', 10);

console.log(`[w905-video] recording ${URL} for ${RECORD_MS/1000}s → ${OUT}`);

const VIEWPORT = { width: 1920, height: 1080 };

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  recordVideo: { dir: OUT, size: VIEWPORT },
});
const page = await context.newPage();

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });

// auto-start the walkthrough — demo-live has id="playBtn"
try {
  await page.waitForSelector('#playBtn', { timeout: 5000 });
  await page.click('#playBtn');
  console.log('[w905-video] #playBtn clicked');
} catch (e) {
  console.log('[w905-video] #playBtn not found — trying fallbacks:', e.message);
  try {
    const playBtn = await page.$('button:has-text("play"), button:has-text("Play"), button:has-text("Start"), [data-play]');
    if (playBtn) { await playBtn.click(); console.log('[w905-video] fallback play button clicked'); }
  } catch (e2) { console.log('[w905-video] no play trigger:', e2.message); }
}

// scroll briefly to surface any below-fold reveal
await page.waitForTimeout(2000);

console.log(`[w905-video] waiting ${RECORD_MS/1000}s for cinematic playback...`);
await page.waitForTimeout(RECORD_MS);

await context.close();
await browser.close();

// Find the webm Playwright wrote and convert to MP4
const webms = readdirSync(OUT).filter(f => f.endsWith('.webm')).sort((a,b) => statSync(join(OUT, b)).mtimeMs - statSync(join(OUT, a)).mtimeMs);
if (!webms.length) {
  console.error('[w905-video] no .webm produced');
  process.exit(1);
}
const webmPath = join(OUT, webms[0]);
const mp4Path = join(OUT, 'demo-w905.mp4');
const webmSize = (statSync(webmPath).size / 1024 / 1024).toFixed(2);
console.log(`[w905-video] webm: ${webmPath} (${webmSize} MB)`);
console.log(`[w905-video] converting to MP4 (h264 + aac silent)...`);

try {
  execSync(`ffmpeg -y -i "${webmPath}" -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -movflags +faststart -f mp4 "${mp4Path}"`, { stdio: 'inherit' });
  const mp4Size = (statSync(mp4Path).size / 1024 / 1024).toFixed(2);
  console.log(`[w905-video] mp4: ${mp4Path} (${mp4Size} MB)`);
  // keep both
} catch (e) {
  console.error('[w905-video] ffmpeg failed:', e.message);
  process.exit(2);
}
