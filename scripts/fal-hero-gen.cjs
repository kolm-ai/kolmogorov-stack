#!/usr/bin/env node
/**
 * Generate kolm.ai hero background via FAL.
 *
 * Tries gpt-image-1 first (per user ask), falls back to flux-pro/v1.1-ultra,
 * then flux/dev. Downloads the resulting image to
 *   public/assets/hero-warm-paper-bg.png
 *
 * Usage:
 *   FAL_KEY=... node scripts/fal-hero-gen.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error('FAL_KEY env var required');
  process.exit(1);
}

const OUT_PATH = path.resolve(__dirname, '..', 'public', 'assets', 'hero-warm-paper-bg.png');
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

const PROMPT = (
  "An elegant editorial paper background, warm cream off-white #f7f4ec base, "
  + "with a faint hand-drawn architectural blueprint of interconnected server "
  + "racks and a neural-network compilation flow diagram overlaid in subtle 8% "
  + "opacity charcoal ink lines, occasional accents in burnt sienna #c2410c "
  + "(5% of pixels), centered composition with calm negative space in the middle "
  + "for headline text, very low contrast, no photorealism, no people, no logos, "
  + "no text, vintage technical schematic aesthetic in the style of Stripe Press "
  + "book covers and Linear marketing pages, 16:9 ratio, hero web background, "
  + "museum-quality printmaking feel"
);

// Attempts ordered by user preference. Each entry knows its sync URL and how
// to shape its body (different models accept slightly different params).
const ATTEMPTS = [
  {
    name: 'gpt-image-1',
    url: 'https://fal.run/fal-ai/gpt-image-1',
    body: {
      prompt: PROMPT,
      image_size: { width: 1792, height: 1024 },
      quality: 'high',
      num_images: 1,
    },
  },
  {
    name: 'gpt-image-1/text-to-image',
    url: 'https://fal.run/fal-ai/gpt-image-1/text-to-image',
    body: {
      prompt: PROMPT,
      // gpt-image-1 only accepts a literal enum here. 1536x1024 is its
      // widest 3:2 landscape option (closest to our 16:9 target). The hero
      // CSS uses background-size:cover so the slight crop is fine.
      image_size: '1536x1024',
      quality: 'high',
      num_images: 1,
    },
  },
  {
    name: 'flux-pro/v1.1-ultra',
    url: 'https://fal.run/fal-ai/flux-pro/v1.1-ultra',
    body: {
      prompt: PROMPT,
      aspect_ratio: '16:9',
      num_images: 1,
      output_format: 'png',
      safety_tolerance: '5',
    },
  },
  {
    name: 'flux/dev',
    url: 'https://fal.run/fal-ai/flux/dev',
    body: {
      prompt: PROMPT,
      image_size: 'landscape_16_9',
      num_images: 1,
    },
  },
];

function pickImageUrl(json) {
  if (!json || typeof json !== 'object') return null;
  if (Array.isArray(json.images) && json.images[0]) {
    const im = json.images[0];
    if (typeof im === 'string') return im;
    if (im && typeof im.url === 'string') return im.url;
  }
  if (Array.isArray(json.image) && json.image[0]) return json.image[0].url || json.image[0];
  if (json.image && typeof json.image.url === 'string') return json.image.url;
  if (typeof json.url === 'string') return json.url;
  if (json.data && Array.isArray(json.data) && json.data[0]) return json.data[0].url || json.data[0].b64_json || null;
  return null;
}

async function downloadTo(url, dest) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`download ${resp.status} ${resp.statusText}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function callFal(attempt) {
  const startedAt = Date.now();
  console.log(`\n[fal] -> ${attempt.name}`);
  console.log(`[fal]    POST ${attempt.url}`);
  const resp = await fetch(attempt.url, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(attempt.body),
  });
  const dur = Date.now() - startedAt;
  const reqId = resp.headers.get('x-fal-request-id') || resp.headers.get('x-request-id') || '(none)';
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) { /* not json */ }
  console.log(`[fal]    <- ${resp.status} in ${dur}ms  request_id=${reqId}`);
  if (!resp.ok) {
    console.log(`[fal]    body: ${text.slice(0, 400)}`);
    throw new Error(`${attempt.name} responded ${resp.status}`);
  }
  if (!json) throw new Error(`${attempt.name} returned non-json`);
  const imageUrl = pickImageUrl(json);
  if (!imageUrl) {
    console.log(`[fal]    body: ${text.slice(0, 400)}`);
    throw new Error(`${attempt.name} response had no image url`);
  }
  return { imageUrl, reqId, model: attempt.name };
}

(async () => {
  let last;
  for (const attempt of ATTEMPTS) {
    try {
      const { imageUrl, reqId, model } = await callFal(attempt);
      console.log(`[fal] image url: ${imageUrl.slice(0, 120)}${imageUrl.length > 120 ? '...' : ''}`);
      const bytes = await downloadTo(imageUrl, OUT_PATH);
      console.log(`\n[done] model=${model}  request_id=${reqId}`);
      console.log(`[done] wrote ${OUT_PATH}  (${bytes.toLocaleString()} bytes)`);
      process.exit(0);
    } catch (err) {
      console.warn(`[fal] ${attempt.name} failed: ${err.message}`);
      last = err;
    }
  }
  console.error(`\nall attempts failed: ${last && last.message}`);
  process.exit(2);
})();
