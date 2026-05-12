#!/usr/bin/env node
// render-demo.mjs
//
// Render the SOTA kolm hero demo as 1920x1080 @ 30fps video.
// Loads scripts/video/demo-page.html in headless Chromium, seeks
// frame-by-frame via window.kolmSeek(t), screenshots each, then
// encodes mp4 + webm + poster via ffmpeg.
//
// Output:
//   public/video/kolm-hero.mp4
//   public/video/kolm-hero.webm
//   public/video/kolm-hero-poster.jpg

import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..', '..');

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DURATION = 21.0;
const FRAMES = Math.round(DURATION * FPS);

const PAGE = path.join(__dirname, 'demo-page.html');
const OUT_DIR = path.join(REPO, 'public', 'video');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-render-'));
const FRAMES_DIR = path.join(TMP, 'frames');
fs.mkdirSync(FRAMES_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`[render] page=${PAGE}`);
console.log(`[render] frames=${FRAMES} (${FPS}fps × ${DURATION}s)`);
console.log(`[render] tmp=${FRAMES_DIR}`);

const browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const url = 'file://' + PAGE.replace(/\\/g, '/');
await page.goto(url);
await page.waitForFunction('window.kolmSeek !== undefined');

console.log('[render] page loaded, starting frame capture');

const t0 = Date.now();
for (let i = 0; i < FRAMES; i++) {
  const t = i / FPS;
  await page.evaluate((tt) => window.kolmSeek(tt), t);
  // small flush for layout
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const fp = path.join(FRAMES_DIR, `f${String(i).padStart(5, '0')}.png`);
  await page.screenshot({ path: fp, type: 'png', omitBackground: false, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  if (i % 30 === 0 || i === FRAMES - 1) {
    const pct = ((i + 1) / FRAMES * 100).toFixed(1);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[render] frame ${i + 1}/${FRAMES} (${pct}%) ${elapsed}s`);
  }
}

await browser.close();
console.log(`[render] capture complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---- ffmpeg encode ----
const MP4 = path.join(OUT_DIR, 'kolm-hero.mp4');
const WEBM = path.join(OUT_DIR, 'kolm-hero.webm');
const POSTER = path.join(OUT_DIR, 'kolm-hero-poster.jpg');
const FRAMES_GLOB = path.join(FRAMES_DIR, 'f%05d.png');

const FFMPEG = 'C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe';

function run(args) {
  console.log(`[ffmpeg] ${args.slice(0, 6).join(' ')} ...`);
  const r = spawnSync(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    console.error(r.stderr?.toString().slice(-1500));
    throw new Error(`ffmpeg exited ${r.status}`);
  }
}

// MP4 (H.264, high quality, web-optimized)
run([
  '-y', '-r', String(FPS), '-i', FRAMES_GLOB,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-preset', 'slow', '-crf', '20',
  '-movflags', '+faststart',
  '-vf', `scale=${WIDTH}:${HEIGHT}:flags=lanczos`,
  MP4
]);

// WebM (VP9)
run([
  '-y', '-r', String(FPS), '-i', FRAMES_GLOB,
  '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p',
  '-b:v', '0', '-crf', '32',
  '-deadline', 'good', '-cpu-used', '2',
  WEBM
]);

// Poster: K-score gate just passed during the compile centerpiece (~12.2s, frame 366)
run([
  '-y', '-i', path.join(FRAMES_DIR, 'f00366.png'),
  '-q:v', '3',
  POSTER
]);

// Sizes
for (const f of [MP4, WEBM, POSTER]) {
  const s = fs.statSync(f);
  console.log(`[out] ${path.basename(f)}  ${(s.size / 1024).toFixed(1)} KB`);
}

// Clean tmp
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}

console.log('[render] done');
