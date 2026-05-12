#!/usr/bin/env node
// gen-hero-video.mjs
//
// Tier-1 product video pipeline for the kolm.ai hero. Goes idea -> training ->
// final product in four scenes. Each scene is a still keyframe (FAL flux-pro)
// then image-to-video animated (FAL Seedance Lite). The four clips are
// stitched together with ffmpeg into a single autoplay-friendly mp4 + webm.
//
// Usage: node scripts/video/gen-hero-video.mjs [--phase=keyframes|video|stitch|all]
//
// Env: FAL_KEY in .env.local
//
// Output: public/video/kolm-hero.mp4 + .webm + poster.jpg

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

const FFMPEG = 'C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe';

// --- env -----------------------------------------------------------------
function loadFalKey() {
  const envPath = path.join(ROOT, '.env.local');
  const txt = fs.readFileSync(envPath, 'utf8');
  const m = txt.match(/^FAL_KEY=(.+)$/m);
  if (!m) throw new Error('FAL_KEY missing from .env.local');
  return m[1].trim().replace(/^["']|["']$/g, '');
}
const FAL_KEY = loadFalKey();

// --- scene definitions ---------------------------------------------------
// The shared visual grammar binds them together: dim modern dev office,
// MacBook on desk, cream/charcoal palette (kolm brand), volumetric light,
// shallow depth of field, 35mm anamorphic feel. Each scene advances the
// story: capture -> threshold -> compile -> run.

const STYLE = 'Cinematic 35mm anamorphic, shallow depth of field, dim modern developer office at dusk, warm tungsten + cool blue rim light, cream and charcoal color grading, subtle film grain, photorealistic, 8k, soft volumetric haze, no text overlays';

const SCENES = [
  {
    id: '01-capture',
    keyframePrompt: `${STYLE}. A developer's hands on an aluminum MacBook keyboard, glow of a terminal screen visible reflecting on their face, the screen shows a green prompt cursor blinking, ambient teal data-stream particles flowing out of the laptop into a translucent glass box hovering above the desk labeled with a small cream "kolm" wordmark, the room is otherwise dark, single dramatic key light from above, depth of field bokeh in background, hyper-detailed.`,
    motionPrompt: 'Slow cinematic dolly in toward the laptop screen. Translucent teal data-stream particles flow continuously from the laptop into the glass box above. The cursor on the screen blinks slowly. Subtle camera shake. Volumetric dust catches the light. No text appears.',
    capNum: '01',
    capLabel: 'capture',
    capText: 'Point your existing OpenAI calls at kolm capture. Every paid pair is recorded.',
    durationSec: 5,
  },
  {
    id: '02-threshold',
    keyframePrompt: `${STYLE}. A clean architectural data visualization floating in a dark space, hundreds of small cream-white data pair tokens stacking up inside a glass cylinder, a thin glowing teal threshold line marks "1000" near the top, the cylinder is mostly full, the developer's hands at the edge of frame on a keyboard, a soft holographic counter displays "987" climbing, dim charcoal-grey background, dramatic side lighting, photorealistic still life, no text labels other than the counter.`,
    motionPrompt: 'The counter ticks upward smoothly from 987 to 1000. Cream-white data pair tokens accumulate inside the glass cylinder, rising. When the threshold line is reached, a single soft teal pulse ripples through the cylinder. Camera holds steady, locked-off shot. No text appears beyond the existing counter.',
    capNum: '02',
    capLabel: 'threshold',
    capText: 'At 1,000 verified pairs the corpus hands off to the trainer. K-score gate. Signed artifact.',
    durationSec: 5,
  },
  {
    id: '03-compile',
    keyframePrompt: `${STYLE}. A small cream-colored binary file icon hovering centered above a dark desk, a thin teal halo behind it, a glowing K-score badge "0.92" floating to its right in monospace cream type, the file casts a soft warm glow on the desk surface, fine particles of cream light spiral inward suggesting compression, the developer's silhouette out of focus in deep background, single dramatic spot lighting from above, architectural product still life, hyper-detailed.`,
    motionPrompt: 'The cream binary file rotates very slowly in place. The teal halo behind it gently pulses once. Cream light particles spiral inward toward the file, condensing. The K-score badge "0.92" remains crisp and locked. Camera does not move. Cinematic, restrained motion. No text changes other than the badge being readable.',
    capNum: '03',
    capLabel: 'compile',
    capText: 'kolm produces one signed file. Model, examples, evaluator, K-score, receipt.',
    durationSec: 5,
  },
  {
    id: '04-run',
    keyframePrompt: `${STYLE}. A MacBook open on a wooden desk in a quiet dim office, the screen displays a clean monospace terminal with cream type on charcoal background showing readable JSON output, in the menubar a small airplane mode icon glows faintly indicating offline operation, the laptop sits in warm pool of focused light, the wider room recedes into shadow, the developer's hand rests next to the laptop relaxed, an architectural product hero shot, photorealistic, 8k.`,
    motionPrompt: 'Slow ease-out push toward the laptop screen. The terminal text is already on screen; cursor below it blinks slowly twice. The airplane mode icon in the menubar remains lit. Subtle warm light flicker on the keys. No text changes during the shot. Final hold is a steady locked-off product shot.',
    capNum: '04',
    capLabel: 'run',
    capText: 'Run the artifact on your laptop, your VPC, or a phone. Same task, your boundary.',
    durationSec: 5,
  },
];

// --- fal helpers ---------------------------------------------------------
async function falSubmit(endpoint, body) {
  const url = `https://queue.fal.run/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`fal submit ${endpoint} ${res.status}: ${txt.slice(0, 400)}`);
  }
  return res.json();
}

async function falPoll(statusUrl, { timeoutMs = 600_000, intervalMs = 4000 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(statusUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`fal poll ${statusUrl} ${res.status}: ${txt.slice(0, 400)}`);
    }
    last = await res.json();
    if (last.status === 'COMPLETED') return last;
    if (last.status === 'FAILED' || last.status === 'ERROR') {
      throw new Error(`fal failed: ${JSON.stringify(last).slice(0, 400)}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`fal timeout after ${timeoutMs}ms, last status: ${last?.status}`);
}

async function falResponse(responseUrl) {
  const res = await fetch(responseUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
  if (!res.ok) throw new Error(`fal response ${res.status}`);
  return res.json();
}

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

// --- phase 1: keyframes --------------------------------------------------
async function generateKeyframe(scene) {
  const outDir = path.join(ROOT, 'public', 'video', 'keyframes');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${scene.id}.jpg`);
  if (fs.existsSync(out)) {
    console.log(`[keyframe ${scene.id}] cached -> ${out}`);
    return out;
  }
  console.log(`[keyframe ${scene.id}] generating ...`);
  // flux-pro/v1.1 for cinematic stills; 16:9 wide aspect.
  const sub = await falSubmit('fal-ai/flux-pro/v1.1', {
    prompt: scene.keyframePrompt,
    image_size: { width: 1920, height: 1080 },
    num_images: 1,
    enable_safety_checker: false,
    safety_tolerance: '6',
    output_format: 'jpeg',
  });
  const final = await falPoll(sub.status_url);
  const resp = await falResponse(sub.response_url);
  const imageUrl = resp.images?.[0]?.url;
  if (!imageUrl) throw new Error(`no image url for ${scene.id}: ${JSON.stringify(resp).slice(0, 200)}`);
  await downloadTo(imageUrl, out);
  console.log(`[keyframe ${scene.id}] -> ${out}`);
  return out;
}

// --- phase 2: image-to-video --------------------------------------------
async function animateScene(scene, keyframePath) {
  const outDir = path.join(ROOT, 'public', 'video', 'clips');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${scene.id}.mp4`);
  if (fs.existsSync(out)) {
    console.log(`[clip ${scene.id}] cached -> ${out}`);
    return out;
  }
  console.log(`[clip ${scene.id}] animating ...`);
  // Convert the local jpg to a data URL so FAL can fetch it. Use FAL storage if size is large.
  const imgBuf = fs.readFileSync(keyframePath);
  const b64 = imgBuf.toString('base64');
  const dataUrl = `data:image/jpeg;base64,${b64}`;
  // Seedance 2.0 Fast reference-to-video. Slug has no fal-ai/ prefix.
  // Fast variant tops out at 720p but ships substantially better motion fidelity
  // than v1 Lite, plus reference-to-video locks the keyframe.
  const sub = await falSubmit('bytedance/seedance-2.0/fast/reference-to-video', {
    prompt: scene.motionPrompt,
    image_urls: [dataUrl],
    duration: '5',
    resolution: '720p',
    aspect_ratio: '16:9',
    generate_audio: false,
    seed: 42,
  });
  const final = await falPoll(sub.status_url, { timeoutMs: 900_000, intervalMs: 6000 });
  const resp = await falResponse(sub.response_url);
  const videoUrl = resp.video?.url || resp.url;
  if (!videoUrl) throw new Error(`no video url for ${scene.id}: ${JSON.stringify(resp).slice(0, 200)}`);
  await downloadTo(videoUrl, out);
  console.log(`[clip ${scene.id}] -> ${out}`);
  return out;
}

// --- phase 3: stitch with ffmpeg ----------------------------------------
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-600)}`));
    });
  });
}

async function stitchClips(clipPaths) {
  const outDir = path.join(ROOT, 'public', 'video');
  fs.mkdirSync(outDir, { recursive: true });
  const concatTxt = path.join(outDir, 'concat.txt');
  // Use the concat demuxer; relative paths from concat file's dir.
  const concatBody = clipPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
  fs.writeFileSync(concatTxt, concatBody);

  // 1) raw concat without re-encoding to verify clips are uniform; if not, re-encode.
  // We re-encode anyway with consistent h264 + scale 1280x720 + 24fps + crossfade-friendly.
  const rawOut = path.join(outDir, 'kolm-hero-raw.mp4');
  await runFfmpeg([
    '-y',
    '-f', 'concat', '-safe', '0', '-i', concatTxt,
    '-vf', 'scale=1280:720,fps=24,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-movflags', '+faststart',
    '-an',
    rawOut,
  ]);

  // 2) Build caption overlay (drawtext) for each scene. We use ass/srt subtitles
  // for typography control. Build .ass file.
  const assPath = path.join(outDir, 'captions.ass');
  const assBody = buildAss(clipPaths);
  fs.writeFileSync(assPath, assBody);

  const mp4 = path.join(outDir, 'kolm-hero.mp4');
  await runFfmpeg([
    '-y',
    '-i', rawOut,
    '-vf', `ass='${assPath.replace(/\\/g, '/').replace(/:/g, '\\:')}'`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-an',
    mp4,
  ]);

  const webm = path.join(outDir, 'kolm-hero.webm');
  await runFfmpeg([
    '-y',
    '-i', mp4,
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34',
    '-row-mt', '1', '-cpu-used', '4',
    '-an',
    webm,
  ]);

  // 3) Poster frame at t=0.5s from mp4.
  const poster = path.join(outDir, 'kolm-hero-poster.jpg');
  await runFfmpeg([
    '-y',
    '-ss', '0.5', '-i', mp4,
    '-vframes', '1',
    '-q:v', '3',
    poster,
  ]);

  return { mp4, webm, poster };
}

function buildAss(clipPaths) {
  // Compute start times based on probed durations. For simplicity, assume each
  // scene is 5s (matches the FAL request) -> 5 * 4 = 20s total.
  const SCENE_LEN = 5.0;
  let header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: NumStyle, Helvetica Neue, 22, &H00B5BDB1, &H00B5BDB1, &H80000000, &H80000000, 0, 0, 0, 0, 100, 100, 2, 0, 1, 0, 0, 1, 60, 60, 56, 1
Style: TextStyle, Helvetica Neue, 30, &H00FAF2E1, &H00FAF2E1, &H80000000, &H80000000, 0, 0, 0, 0, 100, 100, 0, 0, 1, 0, 0, 1, 60, 60, 24, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = SCENES.map((sc, i) => {
    const start = i * SCENE_LEN;
    const end = start + SCENE_LEN;
    const startStr = toAssTime(start);
    const endStr = toAssTime(end);
    const num = `${sc.capNum} · ${sc.capLabel}`.toUpperCase();
    // Two layered subtitles: small mono num on top, larger cream text below.
    const numLine = `Dialogue: 0,${startStr},${endStr},NumStyle,,0,0,0,,${num}`;
    const textLine = `Dialogue: 0,${startStr},${endStr},TextStyle,,0,0,0,,${sc.capText}`;
    return numLine + '\n' + textLine;
  }).join('\n');
  return header + events + '\n';
}

function toAssTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const cs = Math.floor((s % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// --- driver --------------------------------------------------------------
async function main() {
  const phase = (process.argv.find(a => a.startsWith('--phase=')) || '--phase=all').split('=')[1];
  console.log(`[run] phase=${phase} root=${ROOT}`);

  const keyframes = [];
  if (phase === 'keyframes' || phase === 'all') {
    for (const sc of SCENES) {
      const kf = await generateKeyframe(sc);
      keyframes.push({ scene: sc, path: kf });
    }
  } else {
    for (const sc of SCENES) {
      keyframes.push({ scene: sc, path: path.join(ROOT, 'public', 'video', 'keyframes', `${sc.id}.jpg`) });
    }
  }

  const clips = [];
  if (phase === 'video' || phase === 'all') {
    for (const { scene, path: kf } of keyframes) {
      const clip = await animateScene(scene, kf);
      clips.push(clip);
    }
  } else {
    for (const sc of SCENES) {
      clips.push(path.join(ROOT, 'public', 'video', 'clips', `${sc.id}.mp4`));
    }
  }

  if (phase === 'stitch' || phase === 'all') {
    const result = await stitchClips(clips);
    console.log(`[done] mp4=${result.mp4}`);
    console.log(`[done] webm=${result.webm}`);
    console.log(`[done] poster=${result.poster}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
