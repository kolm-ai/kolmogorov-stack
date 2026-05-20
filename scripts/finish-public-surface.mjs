import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(repo, 'public');
const site = 'https://kolm.ai';

const overrides = new Map([
  ['index.html', {
    title: 'kolm.ai - Capture, distill, run locally',
    description: 'kolm is the local AI stack: capture model traffic, build reviewed datasets, distill repeated workflows, and run signed artifacts on your devices.'
  }],
  ['capture.html', {
    title: 'kolm capture - OpenAI-compatible AI gateway',
    description: 'Point OpenAI-compatible traffic at kolm capture. Build a local event lake, redact sensitive data, review training rows, and promote repeated workflows.'
  }],
  ['404.html', {
    title: 'Page not found | kolm',
    description: 'This kolm.ai page was not found. Return to the product, docs, quickstart, pricing, or account surfaces.'
  }]
]);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(full);
  }
  return files;
}

function rel(file) {
  return path.relative(publicDir, file).split(path.sep).join('/');
}

function routeFor(relativePath) {
  if (relativePath === 'index.html') return '/';
  let route = '/' + relativePath.replace(/\.html$/i, '');
  route = route.replace(/\/index$/i, '');
  return route || '/';
}

function titleFromPath(relativePath) {
  const stem = relativePath
    .replace(/\.html$/i, '')
    .replace(/\/index$/i, '')
    .split('/')
    .pop() || 'kolm';
  return stem
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function decodeHtml(text) {
  let out = String(text || '');
  for (let i = 0; i < 2; i += 1) {
    out = out
      .replace(/&middot;|&#183;/gi, ' ')
      .replace(/&ndash;|&#8211;|&mdash;|&#8212;/gi, ' - ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
  }
  return out;
}

function escapeAttr(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripHtml(html) {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(html, tagName) {
  const match = html.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? stripHtml(match[1]) : '';
}

function extractMeta(html, key, value) {
  const re = new RegExp(`<meta\\b(?=[^>]*\\b${key}=["']${value}["'])[^>]*>`, 'i');
  const tag = html.match(re)?.[0] || '';
  return tag.match(/\bcontent=["']([^"']*)["']/i)?.[1] || '';
}

function firstParagraph(html) {
  const paras = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
  for (const para of paras) {
    const text = stripHtml(para[1]);
    if (text.length >= 40) return text;
  }
  return '';
}

function normalizeTitle(raw, relativePath) {
  let base = decodeHtml(raw || '').replace(/\s+/g, ' ').trim();
  base = base.replace(/\s*&\s*/g, ' and ');
  base = base
    .replace(/\s*(?:[|·-]\s*)?Account\s*·\s*kolm\.ai\s*$/i, '')
    .replace(/\s*[|·-]\s*kolm(?:\.ai)?\s*$/i, '')
    .replace(/\s+kolm(?:\.ai)?\s*$/i, '')
    .trim();
  if (!base || base.length < 5) base = titleFromPath(relativePath);
  if (/^kolm\.ai$/i.test(base)) base = 'kolm.ai';
  if (/^kolm$/i.test(base)) base = 'kolm local AI';
  if (/^kolm\s+\w+/i.test(base) && base.length < 14) base = `${base} command`;
  if (base.length < 8) base = `${base} guide`;
  const suffix = relativePath.startsWith('account/') ? ' · Account · kolm.ai' : ' · kolm.ai';
  const maxBase = 65 - suffix.length;
  if (base.length > maxBase) {
    base = base.slice(0, Math.max(24, maxBase - 1)).replace(/\s+\S*$/, '').trim();
  }
  return `${base}${suffix}`.slice(0, 65);
}

function normalizeDescription(raw, fallbackTitle) {
  let desc = decodeHtml(raw || '').replace(/\s+/g, ' ').trim();
  desc = desc.replace(/\bThe AI compiler\.\s*/gi, '');
  if (desc.length < 60) {
    const subject = fallbackTitle
      .replace(/\s+·\s+Account\s+·\s+kolm\.ai$/i, '')
      .replace(/\s+·\s+kolm\.ai$/i, '')
      .replace(/\s+\|\s+kolm(?:\.ai)?$/i, '')
      .replace(/^kolm\.ai\s*-\s*/i, '');
    desc = `${subject}: capture model traffic, review datasets, distill repeated work, and run signed local AI artifacts.`;
  }
  if (desc.length > 160) {
    desc = desc.slice(0, 157).replace(/\s+\S*$/, '').trim() + '...';
  }
  return desc;
}

function upsertTitle(html, title) {
  const tag = `<title>${escapeAttr(title)}</title>`;
  if (/<title>[\s\S]*?<\/title>/i.test(html)) return html.replace(/<title>[\s\S]*?<\/title>/i, tag);
  return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
}

function upsertMetaName(html, name, content) {
  const tag = `<meta name="${name}" content="${escapeAttr(content)}">`;
  const re = new RegExp(`<meta\\b(?=[^>]*\\bname=["']${name}["'])[^>]*>`, 'i');
  if (re.test(html)) return html.replace(re, tag);
  return html.replace(/<\/head>/i, `${tag}\n</head>`);
}

function upsertMetaProperty(html, property, content) {
  const tag = `<meta property="${property}" content="${escapeAttr(content)}">`;
  const re = new RegExp(`<meta\\b(?=[^>]*\\bproperty=["']${property.replace(':', '\\:')}["'])[^>]*>`, 'i');
  if (re.test(html)) return html.replace(re, tag);
  return html.replace(/<\/head>/i, `${tag}\n</head>`);
}

function upsertCanonical(html, url) {
  const tag = `<link rel="canonical" href="${escapeAttr(url)}">`;
  if (/<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/i.test(html)) {
    return html.replace(/<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/i, tag);
  }
  return html.replace(/<\/head>/i, `${tag}\n</head>`);
}

function ensureViewport(html) {
  if (/<meta\b(?=[^>]*\bname=["']viewport["'])[^>]*>/i.test(html)) return html;
  return html.replace(/<head[^>]*>/i, (m) => `${m}\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`);
}

function processFile(file) {
  const relativePath = rel(file);
  const route = routeFor(relativePath);
  const url = site + (route === '/' ? '/' : route);
  const before = fs.readFileSync(file, 'utf8');
  let html = before;

  const override = overrides.get(relativePath);
  const rawTitle = override?.title || extractTag(html, 'title') || extractTag(html, 'h1') || titleFromPath(relativePath);
  const title = normalizeTitle(rawTitle, relativePath);
  const rawDesc = override?.description || extractMeta(html, 'name', 'description') || firstParagraph(html);
  const description = normalizeDescription(rawDesc, title);
  const image = `${site}/og-card.svg`;

  html = ensureViewport(html);
  html = upsertTitle(html, title);
  html = upsertMetaName(html, 'description', description);
  html = upsertCanonical(html, url);
  html = upsertMetaProperty(html, 'og:title', title);
  html = upsertMetaProperty(html, 'og:description', description);
  html = upsertMetaProperty(html, 'og:type', 'website');
  html = upsertMetaProperty(html, 'og:url', url);
  html = upsertMetaProperty(html, 'og:image', image);
  html = upsertMetaName(html, 'twitter:card', 'summary_large_image');
  html = upsertMetaName(html, 'twitter:title', title);
  html = upsertMetaName(html, 'twitter:description', description);
  html = upsertMetaName(html, 'twitter:image', image);
  if (relativePath === '404.html') {
    html = upsertMetaName(html, 'robots', 'noindex,follow');
  }

  if (html !== before) {
    fs.writeFileSync(file, html, 'utf8');
    return true;
  }
  return false;
}

let touched = 0;
const files = walk(publicDir);
for (const file of files) {
  if (processFile(file)) touched += 1;
}

console.log(`finish-public-surface: touched=${touched} total=${files.length}`);
