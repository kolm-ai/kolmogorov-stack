// Multimodal Markdown sidecar tokenizer.
//
// qmd indexes Markdown. We make every modality look like Markdown by
// generating a sidecar `<file>.md` next to the original media file. The sidecar
// contains frontmatter metadata, a human-readable section, and stable local
// feature tokens that make the file searchable even when no external captioner
// or transcription package is configured.
//
// Covered locally:
//   text/markdown/code - passthrough because qmd already indexes them
//   pdf                - pdf-parse text extraction when installed; otherwise
//                        deterministic binary feature tokens
//   image              - Anthropic vision caption when keyed; otherwise local
//                        dimensions/container/hash/histogram tokens
//   audio              - configured local transcript command when present;
//                        otherwise WAV/container/hash/histogram tokens
//   video              - configured local transcript command when present;
//                        otherwise container/hash/histogram tokens

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.rst']);
const CODE_EXT = new Set(['.js', '.ts', '.py', '.rs', '.go', '.java', '.cs', '.cpp', '.c', '.h', '.rb', '.php', '.html', '.css', '.json', '.yaml', '.yml', '.toml']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.heic']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus', '.aac']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']);
const PDF_EXT = new Set(['.pdf']);

export function detectModality(file) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXT.has(ext)) return 'text';
  if (CODE_EXT.has(ext)) return 'code';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (PDF_EXT.has(ext)) return 'pdf';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'audio';
    if (buf.toString('ascii', 4, 8) === 'ftyp') return 'video';
  } catch {}
  return 'unknown';
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fileHash(file) {
  return sha256(fs.readFileSync(file)).slice(0, 16);
}

function frontmatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map(x => JSON.stringify(x)).join(', ')}]`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function splitNameTokens(file) {
  return Array.from(new Set(path.basename(file)
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .slice(0, 40)));
}

function byteHistogram(buf, buckets = 16) {
  const hist = Array.from({ length: buckets }, () => 0);
  if (!buf.length) return hist;
  for (const b of buf) hist[Math.floor((b / 256) * buckets)]++;
  return hist.map((n) => Number((n / buf.length).toFixed(6)));
}

function byteEntropy(buf) {
  if (!buf.length) return 0;
  const counts = new Array(256).fill(0);
  for (const b of buf) counts[b]++;
  let h = 0;
  for (const n of counts) {
    if (!n) continue;
    const p = n / buf.length;
    h -= p * Math.log2(p);
  }
  return Number(h.toFixed(4));
}

function imageMeta(buf) {
  if (buf.length >= 29
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf.toString('ascii', 12, 16) === 'IHDR') {
    return {
      image_format: 'png',
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      color_type: buf[25],
    };
  }
  if (buf.length >= 10 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return {
          image_format: 'jpeg',
          width: buf.readUInt16BE(off + 7),
          height: buf.readUInt16BE(off + 5),
          components: buf[off + 9],
        };
      }
      off += 2 + len;
    }
    return { image_format: 'jpeg' };
  }
  if (buf.length >= 10 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
    return {
      image_format: 'gif',
      width: buf.readUInt16LE(6),
      height: buf.readUInt16LE(8),
    };
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { image_format: 'webp' };
  }
  return {};
}

function wavMeta(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return {};
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  const dataBytes = Math.max(0, buf.readUInt32LE(40));
  const bytesPerSecond = Math.max(1, sampleRate * Math.max(1, channels) * Math.max(1, bitsPerSample) / 8);
  return {
    audio_format: 'wav',
    channels,
    sample_rate_hz: sampleRate,
    bits_per_sample: bitsPerSample,
    duration_s: Number((dataBytes / bytesPerSecond).toFixed(3)),
  };
}

function videoMeta(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    return {
      container: 'mp4-family',
      major_brand: buf.toString('ascii', 8, 12).replace(/\0/g, ''),
    };
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { container: 'matroska-webm' };
  }
  return {};
}

function localFeatureSet(file, modality, buf) {
  const stat = fs.statSync(file);
  const digest = sha256(buf);
  const sample = buf.length > 131072
    ? Buffer.concat([buf.subarray(0, 65536), buf.subarray(buf.length - 65536)])
    : buf;
  const meta = {
    tokenizer: 'kolm-local-multimodal-features-v1',
    modality,
    source_name_tokens: splitNameTokens(file),
    bytes: stat.size,
    sha256: digest,
    sha256_16: digest.slice(0, 16),
    byte_entropy: byteEntropy(sample),
    byte_histogram_16: byteHistogram(sample, 16),
  };
  if (modality === 'image') Object.assign(meta, imageMeta(buf));
  if (modality === 'audio') Object.assign(meta, wavMeta(buf));
  if (modality === 'video') Object.assign(meta, videoMeta(buf));
  return meta;
}

function featureMarkdown(features) {
  const tokens = [
    features.modality,
    features.tokenizer,
    ...(features.source_name_tokens || []),
    features.image_format,
    features.audio_format,
    features.container,
    features.major_brand,
    features.width ? `width_${features.width}` : null,
    features.height ? `height_${features.height}` : null,
    features.sample_rate_hz ? `sample_rate_${features.sample_rate_hz}` : null,
    features.channels ? `channels_${features.channels}` : null,
    features.sha256_16 ? `sha_${features.sha256_16}` : null,
  ].filter(Boolean);
  return [
    '## Local feature tokens',
    '',
    tokens.join(' '),
    '',
    '```json',
    JSON.stringify(features, null, 2),
    '```',
    '',
  ].join('\n');
}

function runConfiguredTextCommand(envName, file) {
  const raw = process.env[envName];
  if (!raw) return null;
  const quoted = file.replace(/"/g, '\\"');
  const command = raw.includes('{file}') ? raw.replace(/\{file\}/g, quoted) : `${raw} "${quoted}"`;
  const r = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return {
      ok: false,
      provider: envName,
      error: (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 1000),
    };
  }
  return {
    ok: true,
    provider: envName,
    text: (r.stdout || '').trim(),
  };
}

async function captionImage({ file, hash }) {
  const buf = fs.readFileSync(file);
  const features = localFeatureSet(file, 'image', buf);
  const stat = fs.statSync(file);
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const data = buf.toString('base64');
      const ext = path.extname(file).slice(1).toLowerCase();
      const media_type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      const r = await c.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type, data } },
          { type: 'text', text: 'Caption this image in two short paragraphs. First paragraph: what is shown. Second paragraph: 6-10 searchable keywords as a comma-separated list. Be concrete.' },
        ] }],
      });
      const caption = r.content?.[0]?.type === 'text' ? r.content[0].text : '';
      return { caption: `${caption}\n\n${featureMarkdown(features)}`, captioned_at: new Date().toISOString(), captioner: 'claude-haiku', features };
    } catch (e) {
      return { caption: `image: ${path.basename(file)} (${stat.size} bytes, ${hash})\n\n${featureMarkdown(features)}`, captioner: 'local-feature-tokenizer', error: String(e.message || e), features };
    }
  }
  return { caption: `image: ${path.basename(file)} (${stat.size} bytes, ${hash})\n\n${featureMarkdown(features)}`, captioner: 'local-feature-tokenizer', features };
}

async function transcribeAudio({ file }) {
  const external = runConfiguredTextCommand('KOLM_AUDIO_TRANSCRIBE_CMD', file)
    || runConfiguredTextCommand('KOLM_WHISPER_CMD', file);
  const features = localFeatureSet(file, 'audio', fs.readFileSync(file));
  if (external?.ok) return { transcript: `${external.text}\n\n${featureMarkdown(features)}`, transcriber: external.provider, features };
  const err = external && !external.ok ? `\n\nexternal_transcriber_error: ${external.error}` : '';
  return { transcript: `${featureMarkdown(features)}${err}`, transcriber: 'local-feature-tokenizer', features };
}

async function transcribeVideo({ file }) {
  const external = runConfiguredTextCommand('KOLM_VIDEO_TRANSCRIBE_CMD', file)
    || runConfiguredTextCommand('KOLM_WHISPER_CMD', file);
  const features = localFeatureSet(file, 'video', fs.readFileSync(file));
  if (external?.ok) return { transcript: `${external.text}\n\n${featureMarkdown(features)}`, transcriber: external.provider, features };
  const err = external && !external.ok ? `\n\nexternal_transcriber_error: ${external.error}` : '';
  return { transcript: `${featureMarkdown(features)}${err}`, transcriber: 'local-feature-tokenizer', features };
}

async function extractPdf({ file }) {
  try {
    const { default: pdfParse } = await import('pdf-parse');
    const buf = fs.readFileSync(file);
    const r = await pdfParse(buf);
    return { text: r.text || '', pages: r.numpages || null, extractor: 'pdf-parse' };
  } catch {
    const features = localFeatureSet(file, 'pdf', fs.readFileSync(file));
    return { text: featureMarkdown(features), pages: null, extractor: 'local-feature-tokenizer', features };
  }
}

// Build a Markdown sidecar for `file`. Returns the path of the .md and its body.
export async function tokenize(file, { force = false } = {}) {
  if (!fs.existsSync(file)) throw new Error('not found: ' + file);
  const modality = detectModality(file);
  const sidecarPath = file + '.md';
  if (!force && fs.existsSync(sidecarPath)) {
    return { sidecarPath, modality, skipped: true };
  }
  const hash = fileHash(file);
  const stat = fs.statSync(file);
  const meta = {
    modality,
    source: path.basename(file),
    bytes: stat.size,
    hash,
    indexed_at: new Date().toISOString(),
  };

  let body = '';
  if (modality === 'text' || modality === 'code') {
    return { sidecarPath: null, modality, skipped: true, reason: 'qmd-native' };
  }
  if (modality === 'image') {
    const { caption, captioner, features } = await captionImage({ file, hash });
    meta.captioner = captioner;
    meta.feature_tokenizer = features?.tokenizer || null;
    body = `# ${path.basename(file)}\n\n![${path.basename(file)}](${path.basename(file)})\n\n## Caption\n\n${caption}\n`;
  } else if (modality === 'audio') {
    const { transcript, transcriber, features } = await transcribeAudio({ file });
    meta.transcriber = transcriber;
    meta.feature_tokenizer = features?.tokenizer || null;
    body = `# ${path.basename(file)}\n\n[audio file](${path.basename(file)})\n\n## Transcript\n\n${transcript}\n`;
  } else if (modality === 'video') {
    const { transcript, transcriber, features } = await transcribeVideo({ file });
    meta.transcriber = transcriber;
    meta.feature_tokenizer = features?.tokenizer || null;
    body = `# ${path.basename(file)}\n\n[video file](${path.basename(file)})\n\n## Transcript\n\n${transcript}\n`;
  } else if (modality === 'pdf') {
    const { text, pages, extractor, features } = await extractPdf({ file });
    meta.pages = pages;
    meta.extractor = extractor;
    meta.feature_tokenizer = features?.tokenizer || null;
    body = `# ${path.basename(file)}\n\n[pdf](${path.basename(file)})\n\n## Extracted text\n\n${(text || '').slice(0, 200000)}\n`;
  } else {
    const features = localFeatureSet(file, modality, fs.readFileSync(file));
    meta.feature_tokenizer = features.tokenizer;
    body = `# ${path.basename(file)}\n\nunsupported modality: ${modality}. file size ${stat.size} bytes, hash ${hash}.\n\n${featureMarkdown(features)}`;
  }

  fs.writeFileSync(sidecarPath, frontmatter(meta) + body);
  return { sidecarPath, modality, skipped: false };
}

// Walk a directory and tokenize every supported file in it.
export async function tokenizeDir(dir, { force = false, onProgress } = {}) {
  const out = { added: 0, skipped: 0, errors: [], by_modality: {} };
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.name === 'node_modules') continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.isFile() && full.endsWith('.md') && fs.existsSync(full.replace(/\.md$/, ''))) continue;
      try {
        const r = await tokenize(full, { force });
        out.by_modality[r.modality] = (out.by_modality[r.modality] || 0) + 1;
        if (r.skipped) out.skipped++; else out.added++;
        if (onProgress) onProgress({ file: full, ...r });
      } catch (e) {
        out.errors.push({ file: full, error: String(e.message || e) });
      }
    }
  }
  return out;
}
