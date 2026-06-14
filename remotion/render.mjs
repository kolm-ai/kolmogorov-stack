// Isolated Remotion render script for kolm.ai.
// Usage: node render.mjs <compositionId> <outputPath> [codec]
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const compId = process.argv[2] || 'test';
const outArg = process.argv[3] || 'out/test.webm';
const codec = process.argv[4] || 'vp8';

const outPath = path.isAbsolute(outArg) ? outArg : path.resolve(__dirname, outArg);

const run = async () => {
  console.log('[render] bundling...');
  const serveUrl = await bundle({
    entryPoint: path.resolve(__dirname, 'src/index.jsx'),
    onProgress: (p) => {
      if (p % 25 === 0) console.log(`[bundle] ${p}%`);
    },
  });

  console.log('[render] selecting composition:', compId);
  const composition = await selectComposition({serveUrl, id: compId});
  console.log(`[render] ${composition.width}x${composition.height} @ ${composition.fps}fps, ${composition.durationInFrames} frames`);

  console.log('[render] rendering to', outPath);
  await renderMedia({
    composition,
    serveUrl,
    codec,
    outputLocation: outPath,
    muted: true, // no audio track (visual-only loop)
    // VP8/VP9 quality knobs (lower CRF = higher quality). 28-32 is a good web range.
    crf: codec === 'vp8' || codec === 'vp9' ? 30 : 23,
    chromiumOptions: {gl: 'angle'},
    onProgress: ({progress}) => {
      const pct = Math.round(progress * 100);
      if (pct % 10 === 0) process.stdout.write(`\r[render] ${pct}%   `);
    },
  });
  console.log('\n[render] DONE ->', outPath);
};

run().catch((e) => {
  console.error('[render] FAILED');
  console.error(e);
  process.exit(1);
});
