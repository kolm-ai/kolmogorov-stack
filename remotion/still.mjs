// Render the poster still (final VERIFIED state) for the pipeline loop.
import {bundle} from '@remotion/bundler';
import {renderStill, selectComposition} from '@remotion/renderer';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, '../public/media/pipeline-poster.png');
const frame = Number(process.argv[2] || 205);

const run = async () => {
  console.log('[still] bundling...');
  const serveUrl = await bundle({entryPoint: path.resolve(__dirname, 'src/index.jsx')});
  const composition = await selectComposition({serveUrl, id: 'Pipeline'});
  console.log('[still] rendering frame', frame, '->', outPath);
  await renderStill({
    composition,
    serveUrl,
    output: outPath,
    frame,
    imageFormat: 'png',
    chromiumOptions: {gl: 'angle'},
  });
  console.log('[still] DONE');
};

run().catch((e) => {
  console.error('[still] FAILED', e);
  process.exit(1);
});
