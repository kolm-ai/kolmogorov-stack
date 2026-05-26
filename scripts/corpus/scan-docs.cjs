#!/usr/bin/env node
// W888-M scan-docs — walk docs/**/*.md + public/docs/**/*.html and emit a
// flat index of every documentation page: title, slug, headings (H1+H2+H3),
// first non-empty paragraph, canonical_url.
//
// Output: data/assistant-corpus/docs-index.json
// Schema per row: { title, slug, source, kind: 'md'|'html', headings: [...],
//                   first_paragraph, canonical_url }
//
// Canonical URL rules:
//   - public/docs/<slug>.html -> https://kolm.ai/docs/<slug>
//   - docs/<slug>.md          -> https://kolm.ai/docs/<slug>
// (We do not verify the URL resolves — that's the audit-href job.)

'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const DOCS_DIR = path.join(REPO, 'docs');
const PUBLIC_DOCS_DIR = path.join(REPO, 'public', 'docs');
const OUT_PATH = path.join(REPO, 'data', 'assistant-corpus', 'docs-index.json');

function walk(root, exts, hits) {
  hits = hits || [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (_) { return hits; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      walk(full, exts, hits);
    } else if (exts.some(x => e.name.toLowerCase().endsWith(x))) {
      hits.push(full);
    }
  }
  return hits;
}

function slugFor(rootDir, filePath) {
  let rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
  rel = rel.replace(/\.(md|html)$/i, '');
  return rel;
}

function canonical(slug) {
  return `https://kolm.ai/docs/${slug}`;
}

// Markdown extraction: title is first H1, headings are # / ## / ###,
// first_paragraph is the first non-blank line block that isn't a heading or
// fenced code.
function parseMd(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const lines = src.split(/\r?\n/);
  const headings = [];
  let title = '';
  let firstPara = '';
  let inCode = false;
  const paraBuf = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const h = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (h) {
      const text = h[2].trim();
      headings.push({ level: h[1].length, text });
      if (!title && h[1].length === 1) title = text;
      // If we were building a paragraph, finalize it.
      if (!firstPara && paraBuf.length) {
        firstPara = paraBuf.join(' ').trim();
      }
      paraBuf.length = 0;
      continue;
    }
    if (line.trim() === '') {
      if (!firstPara && paraBuf.length) {
        firstPara = paraBuf.join(' ').trim();
      }
      paraBuf.length = 0;
      continue;
    }
    if (line.startsWith('---') || line.startsWith('==')) continue;
    paraBuf.push(line.trim());
  }
  if (!firstPara && paraBuf.length) firstPara = paraBuf.join(' ').trim();
  if (!title) {
    // Fallback: filename slug, prettified.
    title = path.basename(filePath, path.extname(filePath)).replace(/[-_]/g, ' ');
  }
  return { title, headings, first_paragraph: firstPara.slice(0, 400) };
}

// HTML extraction: lightweight regex over <title>, <h1>..<h3>, and the first
// <p> body. We strip tags + collapse whitespace. This is intentionally NOT
// a real HTML parser — kolm docs pages are static, generated from a small
// template family.
function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function parseHtml(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const titleMatch = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = titleMatch ? stripTags(titleMatch[1]) : '';
  // Strip leading "kolm — " / "kolm · " etc.
  title = title.replace(/^\s*kolm\s*[—·\-:]\s*/i, '');
  const headings = [];
  const reHead = /<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = reHead.exec(src)) !== null) {
    const lvl = parseInt(m[1].slice(1), 10);
    const text = stripTags(m[2]);
    if (text) headings.push({ level: lvl, text });
  }
  if (!title && headings[0]) title = headings[0].text;
  // First <p> after the leading nav/header. We ignore <p> inside <header> /
  // <nav> by stripping those blocks first.
  const cleaned = src
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
  const pMatch = cleaned.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  let firstPara = pMatch ? stripTags(pMatch[1]) : '';
  if (!firstPara && headings[1]) firstPara = headings[1].text;
  if (!title) {
    title = path.basename(filePath, path.extname(filePath)).replace(/[-_]/g, ' ');
  }
  return { title, headings, first_paragraph: firstPara.slice(0, 400) };
}

function build() {
  const mdFiles = walk(DOCS_DIR, ['.md']);
  const htmlFiles = walk(PUBLIC_DOCS_DIR, ['.html']);
  const rows = [];
  for (const f of mdFiles) {
    try {
      const slug = slugFor(REPO, f);
      const parsed = parseMd(f);
      rows.push({
        title: parsed.title,
        slug,
        source: slug,
        kind: 'md',
        headings: parsed.headings,
        first_paragraph: parsed.first_paragraph,
        canonical_url: canonical(slugFor(DOCS_DIR, f)),
      });
    } catch (_) { /* skip unreadable */ }
  }
  for (const f of htmlFiles) {
    try {
      const slug = slugFor(REPO, f);
      const parsed = parseHtml(f);
      rows.push({
        title: parsed.title,
        slug,
        source: slug,
        kind: 'html',
        headings: parsed.headings,
        first_paragraph: parsed.first_paragraph,
        canonical_url: canonical(slugFor(PUBLIC_DOCS_DIR, f)),
      });
    } catch (_) { /* skip */ }
  }
  return { generated_at: new Date().toISOString(), count: rows.length, docs: rows };
}

function main() {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const result = build();
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
  if (result.count === 0) {
    process.stderr.write('warn: scan-docs found 0 doc pages in docs/ + public/docs/\n');
  } else {
    process.stdout.write(`scan-docs: ${result.count} docs -> ${path.relative(REPO, OUT_PATH)}\n`);
  }
}

if (require.main === module) main();
module.exports = { build };
