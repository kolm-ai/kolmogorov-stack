#!/usr/bin/env node
// Records public/demo-90s.html as a 90s MP4 demo.
// Loads from file:// (no server needed) and waits for data-demo-done.
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = pathToFileURL(join(ROOT, 'public', 'demo-90s.html')).href;
const OUT = resolve(process.env.OUT || join(ROOT, '_audit', 'w905', 'video'));
mkdirSync(OUT, { recursive: true });

const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '110000', 10);
const VIEWPORT = { width: 1920, height: 1080 };

console.log(`[demo-90s] recording ${SRC}`);
console.log(`[demo-90s]   out=${OUT}  timeout=${TIMEOUT_MS/1000}s`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  recordVideo: { dir: OUT, size: VIEWPORT },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

const startedAt = Date.now();
await page.goto(SRC, { waitUntil: 'load' });
console.log('[demo-90s] page loaded — waiting for animation to complete...');

try {
  await page.waitForSelector('body[data-demo-done="1"]', { timeout: TIMEOUT_MS });
  console.log(`[demo-90s] animation finished after ${((Date.now()-startedAt)/1000).toFixed(1)}s`);
} catch (e) {
  console.error(`[demo-90s] animation did not finish within ${TIMEOUT_MS/1000}s — stopping anyway`);
}

await context.close();
await browser.close();

// Find the freshly-written webm and convert to MP4 (both web-compressed + lossless)
const webms = readdirSync(OUT)
  .filter(f => f.endsWith('.webm'))
  .map(f => ({ f, mtime: statSync(join(OUT, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (!webms.length) { console.error('[demo-90s] no webm captured'); process.exit(1); }

const webmPath = join(OUT, webms[0].f);
const stampPath = join(OUT, 'demo-90s.webm');
try { unlinkSync(stampPath); } catch {}
renameSync(webmPath, stampPath);

const mp4Path = join(OUT, 'demo-90s.mp4');
const webPath = join(OUT, 'demo-90s-web.mp4');
const posterPath = join(OUT, 'demo-90s-poster.jpg');
const gifPath = join(OUT, 'demo-90s-preview.gif');

console.log(`[demo-90s] webm: ${stampPath} (${(statSync(stampPath).size/1024/1024).toFixed(2)} MB)`);
console.log('[demo-90s] encoding h264 high-quality MP4 ...');

try {
  execSync(`ffmpeg -y -i "${stampPath}" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -f mp4 "${mp4Path}"`, { stdio: 'inherit' });
  console.log(`[demo-90s] mp4 (HQ): ${mp4Path} (${(statSync(mp4Path).size/1024/1024).toFixed(2)} MB)`);

  execSync(`ffmpeg -y -i "${stampPath}" -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p -movflags +faststart -vf "scale=1280:-2" -f mp4 "${webPath}"`, { stdio: 'inherit' });
  console.log(`[demo-90s] mp4 (web 1280): ${webPath} (${(statSync(webPath).size/1024/1024).toFixed(2)} MB)`);

  execSync(`ffmpeg -y -i "${mp4Path}" -ss 00:00:01 -vframes 1 -q:v 2 "${posterPath}"`, { stdio: 'inherit' });
  console.log(`[demo-90s] poster: ${posterPath}`);

  execSync(`ffmpeg -y -i "${mp4Path}" -t 12 -vf "fps=12,scale=960:-2:flags=lanczos" -loop 0 "${gifPath}"`, { stdio: 'inherit' });
  console.log(`[demo-90s] preview gif: ${gifPath} (${(statSync(gifPath).size/1024/1024).toFixed(2)} MB)`);
} catch (e) {
  console.error('[demo-90s] ffmpeg failed:', e.message);
  process.exit(2);
}

console.log('\n[demo-90s] DONE');
console.log('  publish:  cp _audit/w905/video/demo-90s-web.mp4 public/demo-90s.mp4');
console.log('  publish:  cp _audit/w905/video/demo-90s-poster.jpg public/demo-90s-poster.jpg');
