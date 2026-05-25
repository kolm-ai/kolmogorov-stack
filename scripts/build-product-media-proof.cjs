#!/usr/bin/env node
'use strict';

// kolm.product_media_proof.v1 — scan every public/**/*.html for every img,
// video, source, picture, poster, canvas, audio, and inline-svg reference,
// resolve each one to a local file (or external URL), verify the asset
// exists, and emit per-page + per-surface + global counts so a missing
// product hero never ships unnoticed.
//
// Usage: node scripts/build-product-media-proof.cjs [--check]
//
// Spec: docs/research/kolm-p0-control-files-buildbook-2026-05-25.md
//       docs/research/kolm-p0-control-files-implementation-spec-2026-05-25.md

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'docs', 'internal', 'product-media-proof.json');
const SCHEMA = 'kolm.product_media_proof.v1';

const args = process.argv.slice(2);
const CHECK = args.includes('--check');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stable(value), null, 2) + '\n';
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && p.endsWith('.html')) out.push(p);
  }
  return out;
}

// Surface classification — derive from path prefix. Order matters: most
// specific first.
const SURFACE_RULES = [
  { match: /^public\/account\//, surface: 'account' },
  { match: /^public\/admin\//, surface: 'admin' },
  { match: /^public\/api\//, surface: 'api' },
  { match: /^public\/docs\//, surface: 'docs' },
  { match: /^public\/guides\//, surface: 'docs' },
  { match: /^public\/research\//, surface: 'research' },
  { match: /^public\/legal\//, surface: 'legal' },
  { match: /^public\/integrations\//, surface: 'integrations' },
  { match: /^public\/playbooks\//, surface: 'playbooks' },
  { match: /^public\/use-cases\//, surface: 'use_cases' },
  { match: /^public\/blog\//, surface: 'blog' },
  { match: /^public\/pricing/, surface: 'pricing' },
  { match: /^public\/studio/, surface: 'studio' },
  { match: /^public\/index\.html$/, surface: 'homepage' },
  { match: /^public\/about/, surface: 'homepage' },
  { match: /^public\/manifesto/, surface: 'homepage' },
  { match: /^public\//, surface: 'product' },
];

function surfaceFor(relPath) {
  for (const rule of SURFACE_RULES) {
    if (rule.match.test(relPath)) return rule.surface;
  }
  return 'product';
}

// Collect every URL-like attribute on every media-bearing tag. Cheap regex —
// catalog only, not browser-accurate. The tags we audit and the attrs we
// read:
//
//   img         src, srcset, data-src, data-srcset, alt, width, height, loading
//   source      src, srcset, type, media
//   video       src, poster, preload
//   audio       src, preload
//   picture     (container only — children carry src)
//   link        href, as, rel (filter rel=icon|preload|mask-icon|apple-touch-icon)
//   meta        content (filter property=og:image|twitter:image)
//   canvas      width, height (no asset; recorded as inline-only)
//   svg         (inline — recorded but not a file ref)
//   embed/object data, src, type
//
// We extract <tag ... > slices then attribute-by-attribute. Avoids the cost
// of a full HTML parser while being good enough for proof-of-coverage.

const RE_TAG = /<(img|source|video|audio|link|meta|canvas|svg|embed|object|iframe|picture)\b([^>]*)>/gi;
const RE_ATTR = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]+))/g;

function extractAttrs(rawAttrs) {
  const out = {};
  RE_ATTR.lastIndex = 0;
  let m;
  while ((m = RE_ATTR.exec(rawAttrs))) {
    const name = m[1].toLowerCase();
    const val = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : ''));
    out[name] = val;
  }
  return out;
}

function parseSrcSet(srcset) {
  if (!srcset) return [];
  return String(srcset)
    .split(',')
    .map(s => s.trim().split(/\s+/)[0])
    .filter(Boolean);
}

const EXTERNAL_RE = /^(https?:|data:|blob:|mailto:|tel:)/i;
const DATA_URI_RE = /^data:/i;

function classifyRef(ref) {
  if (!ref) return 'empty';
  if (DATA_URI_RE.test(ref)) return 'data_uri';
  if (EXTERNAL_RE.test(ref)) return 'external';
  if (ref.startsWith('//')) return 'protocol_relative';
  return 'local';
}

function resolveLocalRef(htmlAbsPath, ref) {
  // Strip query + fragment.
  const clean = ref.split('#')[0].split('?')[0];
  if (!clean) return null;
  if (clean.startsWith('/')) {
    return path.join(PUBLIC, clean.slice(1));
  }
  return path.join(path.dirname(htmlAbsPath), clean);
}

function scanHtmlFile(absPath) {
  const html = fs.readFileSync(absPath, 'utf8');
  const refs = [];

  RE_TAG.lastIndex = 0;
  let m;
  while ((m = RE_TAG.exec(html))) {
    const tag = m[1].toLowerCase();
    const attrs = extractAttrs(m[2] || '');

    const push = (kind, url, extra = {}) => {
      if (!url) return;
      refs.push({ tag, kind, url, ...extra });
    };

    if (tag === 'img') {
      push('image', attrs.src, { alt: attrs.alt || '', width: attrs.width || null, height: attrs.height || null, loading: attrs.loading || null });
      if (attrs['data-src']) push('image', attrs['data-src'], { alt: attrs.alt || '', source: 'data-src' });
      for (const u of parseSrcSet(attrs.srcset)) push('image', u, { source: 'srcset' });
      for (const u of parseSrcSet(attrs['data-srcset'])) push('image', u, { source: 'data-srcset' });
    } else if (tag === 'source') {
      push('source', attrs.src, { type: attrs.type || null });
      for (const u of parseSrcSet(attrs.srcset)) push('source', u, { type: attrs.type || null, source: 'srcset' });
    } else if (tag === 'video') {
      push('video', attrs.src);
      push('poster', attrs.poster);
    } else if (tag === 'audio') {
      push('audio', attrs.src);
    } else if (tag === 'link') {
      const r = (attrs.rel || '').toLowerCase();
      if (r.includes('icon') || r.includes('apple-touch-icon') || r.includes('mask-icon') || r === 'preload') {
        push('link', attrs.href, { rel: r, as: attrs.as || null });
      }
    } else if (tag === 'meta') {
      const prop = (attrs.property || attrs.name || '').toLowerCase();
      if (prop === 'og:image' || prop === 'twitter:image' || prop === 'og:image:url' || prop === 'twitter:image:src') {
        push('og_image', attrs.content);
      }
    } else if (tag === 'iframe') {
      push('iframe', attrs.src);
    } else if (tag === 'embed') {
      push('embed', attrs.src);
    } else if (tag === 'object') {
      push('object', attrs.data);
    } else if (tag === 'canvas') {
      refs.push({ tag, kind: 'inline_canvas', url: null, width: attrs.width || null, height: attrs.height || null });
    } else if (tag === 'svg') {
      refs.push({ tag, kind: 'inline_svg', url: null });
    } else if (tag === 'picture') {
      refs.push({ tag, kind: 'picture_container', url: null });
    }
  }

  return refs;
}

const KNOWN_MEDIA_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp',
  '.mp4', '.webm', '.ogg', '.ogv', '.m4v', '.mov',
  '.mp3', '.wav', '.m4a', '.flac', '.aac',
  '.json', '.woff', '.woff2', '.ttf', '.otf',
  '.css', '.js', '.mjs', '.map', '.pdf',
]);

function isMediaExt(p) {
  const ext = path.extname(p).toLowerCase();
  return KNOWN_MEDIA_EXTS.has(ext) || ext === '';
}

function build() {
  const htmlFiles = walk(PUBLIC).sort();

  const perPage = [];
  const perSurface = {};
  const missingLocal = [];
  const altGapImages = []; // images with empty alt that are NOT decorative
  const dimensionGapImages = [];
  const externalRefs = new Map(); // host → count
  const refKindTotals = {};

  let totalRefs = 0;

  for (const abs of htmlFiles) {
    const relP = rel(abs);
    const surface = surfaceFor(relP);
    const refs = scanHtmlFile(abs);

    let pageMissing = 0;
    let pageExternal = 0;
    let pageDataUri = 0;
    let pageLocalOk = 0;
    let pageInlineSvg = 0;
    let pageInlineCanvas = 0;
    let pageAltGap = 0;
    let pageDimGap = 0;

    for (const r of refs) {
      totalRefs++;
      refKindTotals[r.kind] = (refKindTotals[r.kind] || 0) + 1;

      if (r.kind === 'inline_svg') { pageInlineSvg++; continue; }
      if (r.kind === 'inline_canvas') { pageInlineCanvas++; continue; }
      if (r.kind === 'picture_container') continue;

      const cls = classifyRef(r.url);
      if (cls === 'data_uri') { pageDataUri++; continue; }
      if (cls === 'external' || cls === 'protocol_relative') {
        pageExternal++;
        try {
          const u = new URL(r.url.startsWith('//') ? 'https:' + r.url : r.url);
          externalRefs.set(u.host, (externalRefs.get(u.host) || 0) + 1);
        } catch { /* invalid URL, skip */ }
        continue;
      }
      if (cls === 'empty') continue;

      const localAbs = resolveLocalRef(abs, r.url);
      if (!localAbs) continue;
      if (fs.existsSync(localAbs)) {
        pageLocalOk++;
      } else if (isMediaExt(localAbs)) {
        pageMissing++;
        missingLocal.push({ page: relP, surface, ref: r.url, kind: r.kind, expected_path: rel(localAbs) });
      }

      if (r.kind === 'image') {
        const altIsEmpty = !r.alt || !r.alt.trim();
        if (altIsEmpty) {
          pageAltGap++;
          altGapImages.push({ page: relP, surface, src: r.url });
        }
        if (!r.width || !r.height) {
          pageDimGap++;
          dimensionGapImages.push({ page: relP, surface, src: r.url });
        }
      }
    }

    const pageRow = {
      page: relP,
      surface,
      ref_count: refs.length,
      local_ok: pageLocalOk,
      local_missing: pageMissing,
      external: pageExternal,
      data_uri: pageDataUri,
      inline_svg: pageInlineSvg,
      inline_canvas: pageInlineCanvas,
      img_alt_gaps: pageAltGap,
      img_dimension_gaps: pageDimGap,
    };
    perPage.push(pageRow);

    if (!perSurface[surface]) {
      perSurface[surface] = {
        surface,
        pages: 0,
        ref_count: 0,
        local_ok: 0,
        local_missing: 0,
        external: 0,
        data_uri: 0,
        inline_svg: 0,
        inline_canvas: 0,
        img_alt_gaps: 0,
        img_dimension_gaps: 0,
      };
    }
    const s = perSurface[surface];
    s.pages++;
    s.ref_count += pageRow.ref_count;
    s.local_ok += pageRow.local_ok;
    s.local_missing += pageRow.local_missing;
    s.external += pageRow.external;
    s.data_uri += pageRow.data_uri;
    s.inline_svg += pageRow.inline_svg;
    s.inline_canvas += pageRow.inline_canvas;
    s.img_alt_gaps += pageRow.img_alt_gaps;
    s.img_dimension_gaps += pageRow.img_dimension_gaps;
  }

  const surfaces = Object.values(perSurface).sort((a, b) => (a.surface < b.surface ? -1 : 1));

  const externalHostsSorted = [...externalRefs.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || (a.host < b.host ? -1 : 1));

  const summary = {
    html_pages: htmlFiles.length,
    total_refs: totalRefs,
    by_kind: refKindTotals,
    local_missing: missingLocal.length,
    external_refs: externalRefs.size,
    img_alt_gaps: altGapImages.length,
    img_dimension_gaps: dimensionGapImages.length,
  };

  // Triage budgets. Today's snapshot becomes baseline; future drift > budget
  // is the failure signal. Initial mode: warn (record-only).
  const exception_budget_baseline = {
    mode: 'warn',
    started_at: '2026-05-25',
    img_alt_gaps_baseline: altGapImages.length,
    img_dimension_gaps_baseline: dimensionGapImages.length,
    local_missing_baseline: missingLocal.length,
    drift_tolerance_pct: 5,
  };

  let generated_at = new Date().toISOString();
  if (CHECK && fs.existsSync(OUT)) {
    try {
      const prior = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (prior && typeof prior.generated_at === 'string') generated_at = prior.generated_at;
    } catch { /* ignore */ }
  }

  const payload = {
    schema: SCHEMA,
    generated_at,
    public_root: 'public/',
    summary,
    exception_budget_baseline,
    surfaces,
    pages: perPage,
    local_missing: missingLocal.slice().sort((a, b) => (a.page < b.page ? -1 : a.page > b.page ? 1 : (a.ref < b.ref ? -1 : 1))),
    external_hosts: externalHostsSorted,
  };

  return stableStringify(payload);
}

function main() {
  const next = build();

  if (CHECK) {
    if (!fs.existsSync(OUT)) {
      process.stderr.write(`[product-media-proof --check] missing ${rel(OUT)}\n`);
      process.exit(1);
    }
    const prior = fs.readFileSync(OUT, 'utf8');
    if (prior !== next) {
      process.stderr.write(`[product-media-proof --check] ${rel(OUT)} drift — run npm run build:product-media-proof\n`);
      process.exit(1);
    }
    process.stdout.write(`[product-media-proof --check] ok (${rel(OUT)})\n`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, next, 'utf8');
  const parsed = JSON.parse(next);
  process.stdout.write(`[product-media-proof] wrote ${rel(OUT)} (${parsed.summary.html_pages} pages; ${parsed.summary.total_refs} refs; missing=${parsed.summary.local_missing} alt-gaps=${parsed.summary.img_alt_gaps} dim-gaps=${parsed.summary.img_dimension_gaps})\n`);
}

try { main(); } catch (err) {
  process.stderr.write(`[product-media-proof] FAILED: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
}
