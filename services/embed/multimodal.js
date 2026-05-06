// Multimodal → Markdown sidecar tokenizer.
//
// qmd indexes Markdown. We make every modality look like Markdown by
// generating a sidecar `<file>.md` next to the original media file.
// The sidecar contains:
//   - a frontmatter block of structured metadata (modality, hashes, tags)
//   - a heading line for full-text search
//   - the LLM caption / transcript / extracted text as the body
//   - links back to the binary
//
// Once sidecars exist, qmd's normal BM25 + vector + RRF + reranker treat
// every modality identically. A search for "lakehouse trip" matches the
// transcript line "we drove out to the lake house Saturday" embedded in
// the sidecar of `IMG_4421.mov`.
//
// This module covers:
//   text/markdown  → passthrough (already qmd-native)
//   pdf            → pdf-parse text extraction
//   image          → CLIP-or-API caption + EXIF
//   audio          → Whisper-or-API transcription
//   video          → ffmpeg keyframe captions + ASR transcript
//   url/html       → readability + main-text extract
//
// For Sprint 1 we ship:
//   - the file-type detector (`magika`-equivalent: extension + magic byte)
//   - text/markdown/pdf passthrough
//   - image/audio/video stubs that call out to a configurable embedder
//     endpoint (KOLM_EMBED_URL, defaults to Anthropic vision/audio if
//     ANTHROPIC_API_KEY is set; otherwise emit a placeholder caption that
//     records the file path + size + hash so qmd can still index it).
//
// Sprint 2 extends to: full local-only path via wllama vision + Whisper-
// via-onnxruntime — so the user never has to send media off-device.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
  // Fallback: read first 4 bytes for magic-number detection. Cheap.
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';   // %PDF
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image';                                        // jpeg
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image'; // png
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'audio'; // RIFF
  } catch {}
  return 'unknown';
}

function fileHash(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
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

async function captionImage({ file, hash }) {
  // No-key fallback: emit a placeholder caption with EXIF-ish metadata
  // so the file is at least findable by name. Sprint 2 wires CLIP locally.
  const stat = fs.statSync(file);
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const data = fs.readFileSync(file).toString('base64');
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
      return { caption, captioned_at: new Date().toISOString(), captioner: 'claude-haiku' };
    } catch (e) {
      return { caption: `image: ${path.basename(file)} (${stat.size} bytes, ${hash})`, captioner: 'placeholder', error: String(e.message || e) };
    }
  }
  return { caption: `image: ${path.basename(file)} (${stat.size} bytes, ${hash})`, captioner: 'placeholder' };
}

async function transcribeAudio({ file }) {
  // Placeholder until Sprint 2 wires Whisper. Returns enough metadata for
  // qmd to index the file by name, modality, and hash.
  const stat = fs.statSync(file);
  return { transcript: `[transcript pending — audio: ${path.basename(file)}, ${stat.size} bytes]`, transcriber: 'placeholder' };
}

async function transcribeVideo({ file }) {
  const stat = fs.statSync(file);
  return { transcript: `[transcript pending — video: ${path.basename(file)}, ${stat.size} bytes]`, transcriber: 'placeholder' };
}

async function extractPdf({ file }) {
  // Best-effort plain-text extract via pdf-parse if installed; otherwise
  // emit a placeholder. We don't add pdf-parse as a hard dep because it
  // pulls a chunk of native code and many users only ingest text/code.
  try {
    const { default: pdfParse } = await import('pdf-parse');
    const buf = fs.readFileSync(file);
    const r = await pdfParse(buf);
    return { text: r.text || '', pages: r.numpages || null };
  } catch {
    const stat = fs.statSync(file);
    return { text: `[install pdf-parse for full extraction — pdf: ${path.basename(file)}, ${stat.size} bytes]`, pages: null };
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
    // Passthrough — qmd already indexes the original. Don't write a sidecar.
    return { sidecarPath: null, modality, skipped: true, reason: 'qmd-native' };
  }
  if (modality === 'image') {
    const { caption, captioner } = await captionImage({ file, hash });
    meta.captioner = captioner;
    body = `# ${path.basename(file)}\n\n![${path.basename(file)}](${path.basename(file)})\n\n## Caption\n\n${caption}\n`;
  } else if (modality === 'audio') {
    const { transcript, transcriber } = await transcribeAudio({ file });
    meta.transcriber = transcriber;
    body = `# ${path.basename(file)}\n\n[audio file](${path.basename(file)})\n\n## Transcript\n\n${transcript}\n`;
  } else if (modality === 'video') {
    const { transcript, transcriber } = await transcribeVideo({ file });
    meta.transcriber = transcriber;
    body = `# ${path.basename(file)}\n\n[video file](${path.basename(file)})\n\n## Transcript\n\n${transcript}\n`;
  } else if (modality === 'pdf') {
    const { text, pages } = await extractPdf({ file });
    meta.pages = pages;
    body = `# ${path.basename(file)}\n\n[pdf](${path.basename(file)})\n\n## Extracted text\n\n${(text || '').slice(0, 200000)}\n`;
  } else {
    body = `# ${path.basename(file)}\n\nunsupported modality: ${modality}. file size ${stat.size} bytes, hash ${hash}.\n`;
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
      if (e.name.startsWith('.')) continue;             // skip hidden
      if (e.name === 'node_modules') continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.isFile() && full.endsWith('.md') && fs.existsSync(full.replace(/\.md$/, ''))) continue; // skip our sidecars
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
