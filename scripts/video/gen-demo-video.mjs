#!/usr/bin/env node
// gen-demo-video.mjs
//
// Hero demo: faithful 1080p terminal screen-recording showing the real kolm
// CLI flow (capture → status → distill → run → install). Real commands, real
// flags, real output shapes. Typing animation per character. Animated
// progress bar. Round traffic lights.
//
// Output: public/video/kolm-hero.mp4 + .webm + kolm-hero-poster.jpg

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

const FFMPEG = 'C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe';
const FONT_REGULAR = 'C\\:/Windows/Fonts/consola.ttf';

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const TOTAL = 26.0;

// terminal grid
const FONT_SIZE = 28;
const CHAR_W = 15.4;            // empirical Consolas at 28pt
const LINE_H = 38;
const LEFT = 80;
const TOP = 132;

// typing speeds (seconds per character)
const TYPE_USER = 0.020;        // human typing
const TYPE_OUTPUT = 0.006;      // terminal streaming output
const TYPE_PASTE = 0.0;         // instant

// colors
const C = {
  bg:       '0x0a0c10',
  chrome:   '0x14181d',
  dim:      '0x5e5849',     // timestamps
  muted:    '0x9a8f76',     // arrows / hints
  cream:    '0xece1c4',     // body text
  prompt:   '0x1ed8b2',     // $ kolm-brand cyan
  ok:       '0x2cce8a',     // green
  hl:       '0xf6d36a',     // warm highlight
  rule:     '0x222831',     // separator
  label:    '0x6e6a5f',     // scene label
};

// One color "run" inside a line: [text, color, typingSpeed (sec/char)]
// typingSpeed: TYPE_USER for typed commands, TYPE_OUTPUT for stream output, TYPE_PASTE for instant
//
// Each scene fades in by progressive typing of its lines. Scene boundaries
// are hard cuts (terminal "clear") between t1 of one and t0 of the next.

const SCENES = [
  {
    id: 'capture',
    label: '01 · CAPTURE',
    t0: 0.0,
    t1: 7.0,
    lines: [
      { t: 0.4,  speed: TYPE_USER,   runs: [['$ ', C.prompt], ['kolm capture --provider openai --as support-bot --namespace support-bot', C.cream]] },
      { t: 2.2,  speed: TYPE_OUTPUT, runs: [['→ ', C.muted], ['wrote ', C.cream], ['~/.kolm/capture/support-bot.json', C.hl]] },
      { t: 2.9,  speed: TYPE_OUTPUT, runs: [['→ ', C.muted], ['proxy at ', C.cream], ['https://api.kolm.ai/v1/proxy/support-bot', C.hl]] },
      { t: 3.7,  speed: TYPE_OUTPUT, runs: [['→ ', C.muted], ['point ', C.cream], ['OPENAI_BASE_URL', C.hl], [' at the proxy · send key as ', C.cream], ['x-upstream-api-key', C.hl]] },
      { t: 4.6,  speed: TYPE_PASTE,  runs: [['', C.muted]] },
      { t: 4.8,  speed: TYPE_OUTPUT, runs: [['# ... your app makes 1,000 calls ...', C.dim]] },
    ],
  },
  {
    id: 'status',
    label: '02 · STATUS',
    t0: 7.4,
    t1: 11.5,
    lines: [
      { t: 7.6,  speed: TYPE_USER,   runs: [['$ ', C.prompt], ['kolm capture status --namespace support-bot', C.cream]] },
      { t: 8.8,  speed: TYPE_OUTPUT, runs: [['support-bot', C.hl]] },
      { t: 9.1,  speed: TYPE_OUTPUT, runs: [['  pairs    ', C.muted], ['1,000 / 1,000', C.cream], ['  threshold reached', C.ok]] },
      { t: 9.6,  speed: TYPE_OUTPUT, runs: [['  age      ', C.muted], ['14m 22s', C.cream]] },
      { t: 10.0, speed: TYPE_OUTPUT, runs: [['  ready    ', C.muted], ['yes', C.ok], [' · run ', C.cream], ['kolm distill', C.hl]] },
    ],
  },
  {
    id: 'distill',
    label: '03 · DISTILL',
    t0: 11.9,
    t1: 17.6,
    lines: [
      { t: 12.0, speed: TYPE_USER,   runs: [['$ ', C.prompt], ['kolm distill --namespace support-bot', C.cream]] },
      { t: 13.0, speed: TYPE_OUTPUT, runs: [['→ ', C.muted], ['loading ', C.cream], ['1,000', C.hl], [' captured pairs', C.cream]] },
      { t: 13.5, speed: TYPE_OUTPUT, runs: [['→ ', C.muted], ['fitting LoRA on ', C.cream], ['phi-3-mini', C.hl]], progressBar: { t0: 14.0, t1: 16.0, slots: 16 } },
      { t: 16.1, speed: TYPE_OUTPUT, runs: [['→ ', C.muted], ['K-score          ', C.cream], ['0.917', C.hl], ['   gate ≥ 0.85', C.cream], ['   OK', C.ok]] },
      { t: 16.5, speed: TYPE_OUTPUT, runs: [['→ ', C.muted], ['packing artifact ', C.cream], ['4.3 MB', C.hl]] },
      { t: 16.9, speed: TYPE_OUTPUT, runs: [['→ ', C.muted], ['signing manifest ', C.cream], ['HMAC v0.1', C.hl]] },
      { t: 17.2, speed: TYPE_OUTPUT, runs: [['→ ', C.ok], ['wrote ', C.cream], ['~/.kolm/artifacts/support-bot.kolm', C.hl], ['   sha256:8f3a…b21e', C.dim]] },
    ],
  },
  {
    id: 'run',
    label: '04 · RUN',
    t0: 18.0,
    t1: 23.0,
    lines: [
      { t: 18.1, speed: TYPE_USER,   runs: [['$ ', C.prompt], ['kolm run support-bot.kolm ', C.cream], ["'", C.dim], ['this charge looks wrong', C.cream], ["'", C.dim]] },
      { t: 19.6, speed: TYPE_PASTE,  runs: [['', C.muted]] },
      { t: 19.8, speed: TYPE_OUTPUT, runs: [['To dispute the charge:', C.cream]] },
      { t: 20.1, speed: TYPE_OUTPUT, runs: [['  1.  open Settings → Billing → Recent', C.cream]] },
      { t: 20.5, speed: TYPE_OUTPUT, runs: [['  2.  tap the charge in question', C.cream]] },
      { t: 20.9, speed: TYPE_OUTPUT, runs: [['  3.  select ', C.cream], ['"flag for review"', C.hl]] },
      { t: 21.3, speed: TYPE_PASTE,  runs: [['', C.muted]] },
      { t: 21.5, speed: TYPE_OUTPUT, runs: [['most disputes resolve in 3 business days.', C.cream]] },
      { t: 22.1, speed: TYPE_PASTE,  runs: [['', C.muted]] },
      { t: 22.3, speed: TYPE_OUTPUT, runs: [['42 ms', C.hl], ['   local', C.cream], ['   zero egress', C.cream]] },
    ],
  },
  {
    id: 'install',
    label: '05 · SHIP',
    t0: 23.3,
    t1: 26.0,
    lines: [
      { t: 23.4, speed: TYPE_USER,   runs: [['$ ', C.prompt], ['kolm install claude-code --apply', C.cream]] },
      { t: 24.4, speed: TYPE_OUTPUT, runs: [['→ ', C.ok], ['wrote ', C.cream], ['~/.claude/settings.json', C.hl]] },
      { t: 24.8, speed: TYPE_OUTPUT, runs: [['→ ', C.ok], ['kolm now available inside Claude Code', C.cream]] },
      { t: 25.3, speed: TYPE_PASTE,  runs: [['', C.muted]] },
      { t: 25.5, speed: TYPE_OUTPUT, runs: [['your artifact runs in your boundary.', C.muted]] },
    ],
  },
];

// ---------- filter complex builder ---------------------------------------

function esc(s) {
  // ffmpeg drawtext text escaping for single-quoted text.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '’')   // straight → curly quote
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/%/g, '\\%');
}

function buildFilter() {
  const parts = [];

  // Top chrome bar
  parts.push(`drawbox=x=0:y=0:w=${WIDTH}:h=72:color=${C.chrome}:t=fill`);
  parts.push(`drawbox=x=0:y=72:w=${WIDTH}:h=1:color=${C.rule}:t=fill`);

  // Round traffic lights via Unicode BLACK CIRCLE at large fontsize.
  // Position at left side of chrome bar.
  const lights = [
    { x: 30, color: '0xff5f57' },
    { x: 60, color: '0xfebc2e' },
    { x: 90, color: '0x28c840' },
  ];
  for (const l of lights) {
    parts.push(
      `drawtext=fontfile='${FONT_REGULAR}':text='●':` +
      `fontcolor=${l.color}:fontsize=24:x=${l.x}:y=26`
    );
  }

  // Window title (centered, slightly larger)
  parts.push(
    `drawtext=fontfile='${FONT_REGULAR}':text='kolm — terminal — 96×30':` +
    `fontcolor=0x9a8f76:fontsize=18:x=(w-text_w)/2:y=27`
  );

  // ---- per-scene rendering ----
  for (const scene of SCENES) {
    const sceneEnable = `enable=between(t\\,${scene.t0}\\,${scene.t1})`;

    // Scene label (top-right of terminal area)
    parts.push(
      `drawtext=fontfile='${FONT_REGULAR}':text='${esc(scene.label)}':` +
      `fontcolor=${C.label}:fontsize=18:x=w-text_w-48:y=112:${sceneEnable}`
    );

    // Each line: typing animation by drawing whole-run prefixes that grow
    // by one char at each typing tick. Each prefix is one drawtext = native
    // ffmpeg kerning/AA, so text reads crisp (no per-char rendering artifacts).
    for (let i = 0; i < scene.lines.length; i++) {
      const line = scene.lines[i];
      const lineY = TOP + i * LINE_H;
      let cursorX = LEFT;
      let charIndex = 0;     // chars typed since line start (for timing)

      for (const [text, color] of line.runs) {
        if (text.length === 0) continue;
        // Handle leading whitespace: advance cursor without drawing.
        const leadingMatch = text.match(/^ */);
        const leading = leadingMatch[0].length;
        cursorX += leading * CHAR_W;
        charIndex += leading;

        const visible = text.slice(leading);
        // For each prefix length k=1..N, draw the prefix at cursorX with
        // enable window [prefix_t, next_prefix_t]. The last prefix stays
        // visible until scene end.
        for (let k = 1; k <= visible.length; k++) {
          const prefix = visible.slice(0, k);
          const startT = line.t + (charIndex + k - 1) * line.speed;
          const endT = (k === visible.length) ? scene.t1 : line.t + (charIndex + k) * line.speed;
          const st = Math.min(startT, scene.t1 - 0.01);
          const et = Math.min(endT, scene.t1);
          parts.push(
            `drawtext=fontfile='${FONT_REGULAR}':text='${esc(prefix)}':` +
            `fontcolor=${color}:fontsize=${FONT_SIZE}:` +
            `x=${Math.round(cursorX)}:y=${lineY}:` +
            `enable=between(t\\,${st.toFixed(3)}\\,${et.toFixed(3)})`
          );
        }
        cursorX += visible.length * CHAR_W;
        charIndex += visible.length;
      }

      // Animated progress bar on this line if requested.
      if (line.progressBar) {
        const pb = line.progressBar;
        const totalLineChars = line.runs.reduce((acc, [t]) => acc + t.length, 0);
        // Place bar 2 chars after end of line text
        const barStartX = LEFT + (totalLineChars + 2) * CHAR_W;
        const slots = pb.slots;
        const baseT = line.t + totalLineChars * line.speed;
        const animDur = pb.t1 - pb.t0;

        // Render bar as: '[================]' progressive.
        // Step 1: brackets always visible (after baseT)
        parts.push(
          `drawtext=fontfile='${FONT_REGULAR}':text='\\[':` +
          `fontcolor=${C.muted}:fontsize=${FONT_SIZE}:` +
          `x=${Math.round(barStartX)}:y=${lineY}:` +
          `enable=between(t\\,${pb.t0.toFixed(3)}\\,${scene.t1})`
        );
        parts.push(
          `drawtext=fontfile='${FONT_REGULAR}':text='\\]':` +
          `fontcolor=${C.muted}:fontsize=${FONT_SIZE}:` +
          `x=${Math.round(barStartX + (slots + 1) * CHAR_W)}:y=${lineY}:` +
          `enable=between(t\\,${pb.t0.toFixed(3)}\\,${scene.t1})`
        );
        // Step 2: each slot fills at its time
        for (let s = 0; s < slots; s++) {
          const slotT = pb.t0 + (s / slots) * animDur;
          parts.push(
            `drawtext=fontfile='${FONT_REGULAR}':text='=':` +
            `fontcolor=${C.ok}:fontsize=${FONT_SIZE}:` +
            `x=${Math.round(barStartX + (s + 1) * CHAR_W)}:y=${lineY}:` +
            `enable=between(t\\,${slotT.toFixed(3)}\\,${scene.t1})`
          );
        }
        // Step 3: "done" label after bar fills
        const doneT = pb.t1 + 0.05;
        const doneX = barStartX + (slots + 2) * CHAR_W + CHAR_W * 0.5;
        const doneText = 'done';
        for (let k = 0; k < doneText.length; k++) {
          parts.push(
            `drawtext=fontfile='${FONT_REGULAR}':text='${esc(doneText[k])}':` +
            `fontcolor=${C.cream}:fontsize=${FONT_SIZE}:` +
            `x=${Math.round(doneX + k * CHAR_W)}:y=${lineY}:` +
            `enable=between(t\\,${(doneT + k * 0.02).toFixed(3)}\\,${scene.t1})`
          );
        }
      }
    }

    // Cursor: blink at end of LAST visible line in this scene, after last char.
    const lastLine = scene.lines[scene.lines.length - 1];
    const lastLineY = TOP + (scene.lines.length - 1) * LINE_H;
    let lastX = LEFT;
    let lastCharCount = 0;
    for (const [text] of lastLine.runs) {
      lastX += text.length * CHAR_W;
      lastCharCount += text.length;
    }
    const cursorRevealT = lastLine.t + lastCharCount * lastLine.speed + 0.05;
    parts.push(
      `drawbox=x=${Math.round(lastX) + 4}:y=${lastLineY + 6}:w=14:h=28:color=${C.cream}@0.85:t=fill:` +
      `enable=between(t\\,${cursorRevealT.toFixed(3)}\\,${scene.t1})*lt(mod(t\\,1)\\,0.55)`
    );
  }

  // Bottom watermark
  parts.push(
    `drawtext=fontfile='${FONT_REGULAR}':text='kolm.ai':` +
    `fontcolor=${C.dim}:fontsize=18:x=w-text_w-48:y=h-44`
  );

  // Very subtle vignette (almost imperceptible — just softens edges)
  parts.push(`vignette=PI/10`);

  return parts.join(',');
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-2400)}`));
    });
    proc.stdin.end();
  });
}

async function main() {
  const outDir = path.join(ROOT, 'public', 'video');
  fs.mkdirSync(outDir, { recursive: true });

  const filter = buildFilter();
  const scriptPath = path.join(outDir, 'demo-filter.txt');
  fs.writeFileSync(scriptPath, filter);
  const drawtextCount = (filter.match(/drawtext=/g) || []).length;
  console.log(`[demo] filter spec written (${filter.length} chars, ${drawtextCount} drawtexts, ${SCENES.flatMap(s => s.lines).length} lines)`);

  const mp4 = path.join(outDir, 'kolm-hero.mp4');
  const webm = path.join(outDir, 'kolm-hero.webm');
  const poster = path.join(outDir, 'kolm-hero-poster.jpg');

  // 1) mp4
  console.log('[demo] rendering mp4 ...');
  await runFfmpeg([
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${C.bg}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${TOTAL}`,
    '-filter_complex_script', scriptPath,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-an',
    mp4,
  ]);
  console.log(`[demo] mp4 -> ${mp4}`);

  // 2) webm
  console.log('[demo] rendering webm ...');
  await runFfmpeg([
    '-y',
    '-i', mp4,
    '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0',
    '-pix_fmt', 'yuv420p',
    '-an',
    webm,
  ]);
  console.log(`[demo] webm -> ${webm}`);

  // 3) poster
  console.log('[demo] rendering poster ...');
  await runFfmpeg([
    '-y',
    '-ss', '15.5',
    '-i', mp4,
    '-frames:v', '1',
    '-q:v', '2',
    poster,
  ]);
  console.log(`[demo] poster -> ${poster}`);

  console.log('[demo] done.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
