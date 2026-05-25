#!/usr/bin/env node
'use strict';

// kolm.design_cascade_ledger.v1 — classify every public CSS file + runtime
// visual guard, count !important / raw hex / negative letter-spacing / inline
// style / fixed width / border-radius / box-shadow / backdrop-filter usage,
// and seed exception budgets. Direct response to the W852 cascade chaos.
//
// Usage: node scripts/build-design-cascade-ledger.cjs [--check]
//
// Spec: docs/research/kolm-design-cascade-ledger-seed-2026-05-25.md
//       docs/research/kolm-p0-control-files-implementation-spec-2026-05-25.md

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'design-cascade-ledger.json');
const PUBLIC = path.join(ROOT, 'public');
const SCHEMA = 'kolm.design_cascade_ledger.v1';

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

// Classification table from the seed doc. `kind` follows the schema enum:
// tokens | component | route | transitional | generated | deprecated |
// emergency_guard.
const CSS_CLASSIFICATION = [
  { match: /^design-tokens\.css$/, kind: 'tokens', canonical_layer: 'tokens', note: 'canonical token source' },
  { match: /^ks\.css$/, kind: 'component', canonical_layer: 'base', note: 'global reset + base components' },
  { match: /^wf01-components\.css$/, kind: 'component', canonical_layer: 'component', note: 'reusable component layer' },
  { match: /^styles\.css$/, kind: 'component', canonical_layer: 'base', note: 'legacy shared sheet — promote rules into ks/wf01 over time' },
  { match: /^frontier\.css$/, kind: 'route', canonical_layer: 'page-family', note: 'frontier/product visual layer' },
  { match: /^home-refresh\.css$/, kind: 'route', canonical_layer: 'page-family', note: 'homepage finish layer' },
  { match: /^warm-paper\.css$/, kind: 'transitional', canonical_layer: 'page-family', note: 'theme layer — being collapsed into tokens after W852' },
  { match: /^brand-refresh\.css$/, kind: 'transitional', canonical_layer: 'page-family', note: 'finish/override sheet — promote rules and shrink over time' },
  { match: /^surface-polish\.css$/, kind: 'transitional', canonical_layer: 'page-family', note: 'cross-surface polish sheet — classify ownership by component family' },
  { match: /^supplement\.css$/, kind: 'transitional', canonical_layer: 'page-family', note: 'supplemental finish layer including cookie banner' },
  { match: /^w\d+\.css$/, kind: 'transitional', canonical_layer: 'page-family', note: 'wave-specific sheet — keep until rules promoted or retired' },
  { match: /^kolm-/, kind: 'component', canonical_layer: 'component', note: 'kolm-prefixed component sheet' },
];

const PAGE_FAMILY_FOR_FILE = {
  'home-refresh.css': ['homepage'],
  'frontier.css': ['homepage', 'product'],
  'warm-paper.css': ['homepage', 'product', 'docs', 'account'],
  'brand-refresh.css': ['homepage', 'product', 'pricing', 'docs', 'account'],
  'surface-polish.css': ['homepage', 'product', 'pricing', 'docs', 'account'],
  'supplement.css': ['homepage', 'product', 'docs', 'account'],
  'ks.css': ['homepage', 'product', 'pricing', 'docs', 'account', 'trust-legal', 'vertical', 'comparison', 'runtime-device', 'demo-media'],
  'wf01-components.css': ['homepage', 'product', 'pricing', 'docs', 'account', 'trust-legal'],
  'design-tokens.css': ['homepage', 'product', 'pricing', 'docs', 'account', 'trust-legal', 'vertical', 'comparison', 'runtime-device', 'demo-media'],
  'styles.css': ['homepage', 'product', 'pricing', 'docs', 'account', 'trust-legal'],
};

function classifyCss(basename) {
  for (const row of CSS_CLASSIFICATION) {
    if (row.match.test(basename)) {
      return { kind: row.kind, canonical_layer: row.canonical_layer, note: row.note };
    }
  }
  return { kind: 'transitional', canonical_layer: 'page-family', note: 'unclassified — needs owner' };
}

function pageFamilyFor(basename) {
  return PAGE_FAMILY_FOR_FILE[basename] || [];
}

// Strip /* ... */ block comments from CSS so we don't double-count comment
// text. Keeps line-style // comments alone (not a thing in CSS but cheap).
function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Strip <script> and <style> bodies + HTML comments so DOM-level counts are
// honest — inline JS strings full of CSS hex would otherwise dominate.
function stripHtmlNoise(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');
}

const RE = {
  important: /!important\b/g,
  raw_hex: /#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g,
  neg_letter_spacing: /letter-spacing\s*:\s*-/g,
  vw_font: /font-size\s*:\s*[^;}]*\b\d+(\.\d+)?vw\b/g,
  clamp_font: /font-size\s*:\s*clamp\(/g,
  fixed_width_px: /\bwidth\s*:\s*\d+px\b/g,
  border_radius: /\bborder-radius\s*:/g,
  box_shadow: /\bbox-shadow\s*:/g,
  backdrop_filter: /\bbackdrop-filter\s*:/g,
  focus_visible: /:focus-visible\b/g,
  reduced_motion: /@media\s*\([^)]*prefers-reduced-motion[^)]*\)/g,
  theme_dark: /\[data-theme=["']?dark["']?\]/g,
  theme_light: /\[data-theme=["']?light["']?\]/g,
  style_tag: /<style\b[^>]*>/gi,
  inline_style: /\sstyle\s*=\s*["']/g,
};

function countMatches(re, src) {
  const m = src.match(re);
  return m ? m.length : 0;
}

function scanCss(file, basename) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripCssComments(raw);
  const bytes = Buffer.byteLength(raw, 'utf8');
  const lines = raw.split(/\n/).length;
  const cls = classifyCss(basename);
  return {
    path: 'public/' + basename,
    kind: cls.kind,
    canonical_layer: cls.canonical_layer,
    page_families: pageFamilyFor(basename),
    note: cls.note,
    bytes,
    lines,
    important_count: countMatches(RE.important, src),
    raw_hex_count: countMatches(RE.raw_hex, src),
    negative_letter_spacing_count: countMatches(RE.neg_letter_spacing, src),
    vw_font_size_count: countMatches(RE.vw_font, src),
    clamp_font_size_count: countMatches(RE.clamp_font, src),
    fixed_width_px_count: countMatches(RE.fixed_width_px, src),
    border_radius_count: countMatches(RE.border_radius, src),
    box_shadow_count: countMatches(RE.box_shadow, src),
    backdrop_filter_count: countMatches(RE.backdrop_filter, src),
    focus_visible_count: countMatches(RE.focus_visible, src),
    reduced_motion_rules: countMatches(RE.reduced_motion, src),
    theme_dark_selectors: countMatches(RE.theme_dark, src),
    theme_light_selectors: countMatches(RE.theme_light, src),
  };
}

// Runtime visual guards live in JS — scan public/nav.js for embedded <style>
// or string-templated CSS so they're represented in the ledger.
function scanRuntimeGuards() {
  const navJs = path.join(PUBLIC, 'nav.js');
  if (!fs.existsSync(navJs)) return [];
  const raw = fs.readFileSync(navJs, 'utf8');
  const styleTagCount = countMatches(/<style[\s>]/g, raw);
  const importantCount = countMatches(RE.important, raw);
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (styleTagCount === 0 && importantCount === 0) return [];
  return [
    {
      path: 'public/nav.js',
      kind: 'emergency_guard',
      canonical_layer: 'runtime-guard',
      page_families: ['homepage', 'product', 'pricing', 'docs', 'account'],
      note: 'runtime nav guard — touch targets, a11y, mobile actions; required to be temporary',
      bytes,
      style_tag_injections: styleTagCount,
      important_count: importantCount,
      promotion_plan: 'Promote each !important block into ks.css or wf01-components.css and remove from runtime',
    },
  ];
}

function scanPublicHtml() {
  // Walk top-level + account/ + docs/ + integrations/ so we can sample inline
  // style + style-tag counts without paging the entire 729-page surface.
  const files = [];
  function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue;
        if (e.name === 'img' || e.name === 'og' || e.name === 'images' || e.name === 'media' || e.name === 'fonts') continue;
        walk(abs, depth + 1);
      } else if (e.name.endsWith('.html')) {
        files.push(abs);
      }
    }
  }
  walk(PUBLIC, 0);

  let styleTagTotal = 0;
  let inlineStyleTotal = 0;
  let rawHexTotal = 0;
  let importantTotal = 0;
  const inlineStyleHotspots = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const stripped = stripHtmlNoise(raw);
    const styleTags = countMatches(RE.style_tag, raw);
    const inline = countMatches(RE.inline_style, raw);
    styleTagTotal += styleTags;
    inlineStyleTotal += inline;
    // Count raw hex in stripped HTML (not inside <style>/<script>) — those
    // are the page-local color overrides we want to flag.
    rawHexTotal += countMatches(RE.raw_hex, stripped);
    importantTotal += countMatches(RE.important, raw);
    if (inline >= 30) {
      inlineStyleHotspots.push({
        path: 'public/' + path.relative(PUBLIC, file).replace(/\\/g, '/'),
        inline_styles: inline,
        style_tags: styleTags,
      });
    }
  }
  inlineStyleHotspots.sort((a, b) => b.inline_styles - a.inline_styles);
  return {
    public_html_files: files.length,
    style_tag_total: styleTagTotal,
    inline_style_total: inlineStyleTotal,
    raw_hex_in_html: rawHexTotal,
    important_in_html: importantTotal,
    inline_style_hotspots_top_10: inlineStyleHotspots.slice(0, 10),
  };
}

function main() {
  if (!fs.existsSync(PUBLIC)) {
    console.error('design-cascade-ledger: public/ not found');
    process.exit(1);
  }
  const cssFiles = fs.readdirSync(PUBLIC)
    .filter((n) => n.endsWith('.css'))
    .sort();

  const files = [];
  let cssBytes = 0;
  let importantTotal = 0;
  let rawHexTotal = 0;
  let negLetterTotal = 0;
  let vwFontTotal = 0;
  let fixedWidthTotal = 0;
  let borderRadiusTotal = 0;
  let boxShadowTotal = 0;
  let backdropTotal = 0;
  let focusVisibleTotal = 0;
  let reducedMotionTotal = 0;

  for (const basename of cssFiles) {
    const row = scanCss(path.join(PUBLIC, basename), basename);
    files.push(row);
    cssBytes += row.bytes;
    importantTotal += row.important_count;
    rawHexTotal += row.raw_hex_count;
    negLetterTotal += row.negative_letter_spacing_count;
    vwFontTotal += row.vw_font_size_count;
    fixedWidthTotal += row.fixed_width_px_count;
    borderRadiusTotal += row.border_radius_count;
    boxShadowTotal += row.box_shadow_count;
    backdropTotal += row.backdrop_filter_count;
    focusVisibleTotal += row.focus_visible_count;
    reducedMotionTotal += row.reduced_motion_rules;
  }

  const runtimeGuards = scanRuntimeGuards();
  const htmlInventory = scanPublicHtml();

  // Top-cascade-pressure files (biggest !important + raw_hex contributors).
  const pressure = files
    .map((f) => ({
      path: f.path,
      pressure_score: (f.important_count * 3) + (f.raw_hex_count) + (f.negative_letter_spacing_count * 2),
      important: f.important_count,
      raw_hex: f.raw_hex_count,
      negative_letter_spacing: f.negative_letter_spacing_count,
    }))
    .sort((a, b) => b.pressure_score - a.pressure_score)
    .slice(0, 10);

  const exceptions = [
    {
      id: 'nav-runtime-guard',
      path: 'public/nav.js',
      reason: 'Defense-in-depth for touch targets, focus rings, and headline tracking on legacy header conventions.',
      owner: 'frontend',
      expires_after_wave: 'W900',
      promotion_plan: 'Migrate per-selector rules into ks.css or wf01-components.css; remove runtime injection.',
    },
    {
      id: 'wave-numbered-sheets',
      paths_pattern: 'public/w[0-9]+.css',
      reason: 'Wave-specific finish layers retained until rules promoted into ks.css / wf01-components.css.',
      owner: 'frontend',
      expires_after_wave: 'W900',
      promotion_plan: 'Per-wave rules either land in canonical component layer or get deleted with wave completion.',
    },
  ];

  // Initial budgets are warn-only: pinned to the current count so the build
  // does not regress past today's baseline. Tighten in a later wave.
  const exception_budget_baseline = {
    important_total: importantTotal,
    raw_hex_total_css: rawHexTotal,
    negative_letter_spacing_total: negLetterTotal,
    inline_style_total_html: htmlInventory.inline_style_total,
    style_tag_total_html: htmlInventory.style_tag_total,
    important_total_html: htmlInventory.important_in_html,
    raw_hex_total_html: htmlInventory.raw_hex_in_html,
  };

  const counts = {
    css_files: cssFiles.length,
    css_bytes: cssBytes,
    important_count_css: importantTotal,
    raw_hex_count_css: rawHexTotal,
    negative_letter_spacing_count_css: negLetterTotal,
    vw_font_size_count_css: vwFontTotal,
    fixed_width_px_count_css: fixedWidthTotal,
    border_radius_count_css: borderRadiusTotal,
    box_shadow_count_css: boxShadowTotal,
    backdrop_filter_count_css: backdropTotal,
    focus_visible_selectors_css: focusVisibleTotal,
    reduced_motion_rules_css: reducedMotionTotal,
    runtime_visual_guards: runtimeGuards.length,
    public_html_files: htmlInventory.public_html_files,
    style_tag_total_html: htmlInventory.style_tag_total,
    inline_style_total_html: htmlInventory.inline_style_total,
    raw_hex_total_html: htmlInventory.raw_hex_in_html,
    important_total_html: htmlInventory.important_in_html,
  };

  const failures = [];
  // No fail-mode rules yet — design cascade ledger seed explicitly says start
  // permissive in warn mode, tighten after inventory exists. failures left
  // intentionally empty so the first generation captures the baseline.

  const doc = {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    secret_values_included: false,
    root: ROOT.replace(/\\/g, '/'),
    counts,
    exception_budget_baseline,
    top_cascade_pressure: pressure,
    runtime_guards: runtimeGuards,
    html_inventory: htmlInventory,
    files,
    exceptions,
    failures,
  };

  if (CHECK && fs.existsSync(OUT)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (existing && typeof existing.generated_at === 'string') {
        doc.generated_at = existing.generated_at;
      }
    } catch (e) { /* fall through */ }
  }

  const body = stableStringify(doc);
  if (CHECK) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== body) {
      console.error('design-cascade-ledger: docs/internal/design-cascade-ledger.json is out of date');
      process.exit(1);
    }
    console.log(`design-cascade-ledger: ok css=${cssFiles.length} important=${importantTotal} raw_hex=${rawHexTotal} inline_html=${htmlInventory.inline_style_total}`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body);
  console.log(`design-cascade-ledger: wrote docs/internal/design-cascade-ledger.json css=${cssFiles.length} important=${importantTotal} raw_hex=${rawHexTotal} neg_ls=${negLetterTotal} guards=${runtimeGuards.length} html_inline=${htmlInventory.inline_style_total}`);
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
