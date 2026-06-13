#!/usr/bin/env node
/**
 * kolm brand imagery pipeline — gpt-image-2 (via FAL).
 *
 * Generates premium brand assets EXTENSIVELY: every asset in the manifest is
 * rendered as N variants so the best can be selected (generate -> select ->
 * wire into the design). Robust: concurrency pool, retries w/ backoff, resumable
 * (skips existing unless --force), full provenance log.
 *
 *   node scripts/gen-brand-imagery.mjs                 # all assets, default variants
 *   node scripts/gen-brand-imagery.mjs --only hero     # one asset slug
 *   node scripts/gen-brand-imagery.mjs --variants 4    # N variants each
 *   node scripts/gen-brand-imagery.mjs --force         # re-render existing
 *   node scripts/gen-brand-imagery.mjs --manifest path # custom manifest
 *
 * FAL_KEY is read from env or .env.local. image_size: landscape_16_9 |
 * portrait_16_9 | square_hd | landscape_4_3 | portrait_4_3 | square.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const ENDPOINT = 'https://queue.fal.run/fal-ai/gpt-image-2';
const OUT_DIR = path.join(ROOT, 'public', 'img', 'v8');
const CONCURRENCY = 4;
const MAX_RETRIES = 3;

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def; }
function loadKey() {
  if (process.env.FAL_KEY) return process.env.FAL_KEY;
  if (process.env.FAL_API_KEY) return process.env.FAL_API_KEY;
  for (const f of ['.env.local', '.env.research.local', '.env.prod', '.env']) {
    try { const m = fs.readFileSync(path.join(ROOT, f), 'utf8').match(/^FAL_(?:API_)?KEY=(.+)$/m); if (m && m[1].trim().length > 10) return m[1].trim(); } catch {}
  }
  throw new Error('FAL_KEY not found (env or .env.local)');
}
const KEY = loadKey();
const HEADERS = { Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submit(asset) {
  const body = {
    prompt: asset.prompt,
    image_size: asset.image_size || 'landscape_16_9',
    num_images: 1,
    quality: asset.quality || 'high',
    moderation: 'auto',
    background: asset.background || 'auto',
  };
  const r = await fetch(ENDPOINT, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`submit ${r.status}: ${(await r.text()).slice(0, 240)}`);
  return r.json();
}
async function poll(q, label) {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    await sleep(4000);
    const s = await (await fetch(q.status_url, { headers: HEADERS })).json();
    if (s.status === 'COMPLETED') return (await fetch(q.response_url, { headers: HEADERS })).json();
    if (s.status === 'FAILED' || s.status === 'CANCELLED') throw new Error(`${label}: ${JSON.stringify(s).slice(0, 240)}`);
  }
  throw new Error(`${label}: timeout`);
}
async function renderOne(asset, variant) {
  const slug = `${asset.slug}__v${variant}`;
  const dest = path.join(OUT_DIR, `${slug}.png`);
  if (!arg('force', false) && fs.existsSync(dest)) { console.log(`[${slug}] exists, skip`); return { slug, dest, skipped: true, role: asset.role }; }
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const q = await submit(asset);
      const res = await poll(q, slug);
      const url = res.images?.[0]?.url;
      if (!url) throw new Error(`no image: ${JSON.stringify(res).slice(0, 200)}`);
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      fs.writeFileSync(dest, buf);
      console.log(`[${slug}] saved ${path.relative(ROOT, dest)} (${Math.round(buf.length / 1024)} KB)`);
      return { slug, dest: path.relative(ROOT, dest), kb: Math.round(buf.length / 1024), role: asset.role, image_size: asset.image_size, prompt: asset.prompt };
    } catch (e) { lastErr = e; console.warn(`[${slug}] attempt ${attempt} failed: ${e.message}`); await sleep(1500 * attempt); }
  }
  console.error(`[${slug}] GAVE UP: ${lastErr?.message}`);
  return { slug, error: String(lastErr?.message || lastErr), role: asset.role };
}

async function pool(tasks, n) {
  const results = []; let i = 0;
  const workers = Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) { const idx = i++; results[idx] = await tasks[idx](); }
  });
  await Promise.all(workers);
  return results;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifestPath = path.resolve(ROOT, arg('manifest', 'scripts/brand-imagery.manifest.json'));
  let assets = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const only = arg('only', null);
  if (only && only !== true) assets = assets.filter((a) => a.slug === only);
  const variants = Number(arg('variants', 3)) || 3;
  console.log(`gpt-image-2: ${assets.length} assets x ${variants} variants = ${assets.length * variants} renders -> ${path.relative(ROOT, OUT_DIR)}/`);
  const tasks = [];
  for (const a of assets) for (let v = 1; v <= (a.variants || variants); v++) tasks.push(() => renderOne(a, v));
  const results = await pool(tasks, CONCURRENCY);
  const ok = results.filter((r) => r && r.dest && !r.skipped);
  const manifestOut = path.join(OUT_DIR, '_provenance.json');
  fs.writeFileSync(manifestOut, JSON.stringify(results.filter(Boolean), null, 2));
  console.log(`\ndone: ${ok.length} rendered, ${results.filter((r) => r?.skipped).length} skipped, ${results.filter((r) => r?.error).length} failed. provenance -> ${path.relative(ROOT, manifestOut)}`);
})();
