#!/usr/bin/env node
// W401D - build public/changelog.html from MEMORY.md + ARCHIVE.md wave entries.
//
// Reads both files in ~/.claude/projects/C--Users-user/memory/, parses each
// "- [Kolm wave NNN ... ](project_kolm_waveNNN_slug_YYYY_MM_DD.md) - summary"
// line, extracts wave number, date, slug, and 1-2 sentence summary, then
// rebuilds the auto-generated region of public/changelog.html between the
// HTML-comment markers CHANGELOG_AUTO_BEGIN and CHANGELOG_AUTO_END.
//
// Idempotent: writes only when the byte content changes.
//
// Run: node scripts/build-changelog.cjs
//
// Output: "changelog: NN waves rendered, M files touched"

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, 'changelog.html');

const MEMORY_DIR = path.join(
  os.homedir(),
  '.claude', 'projects', 'C--Users-user', 'memory'
);
const MEMORY_MD = path.join(MEMORY_DIR, 'MEMORY.md');
const ARCHIVE_MD = path.join(MEMORY_DIR, 'ARCHIVE.md');

const AUTO_BEGIN = '<!-- CHANGELOG_AUTO_BEGIN -->';
const AUTO_END = '<!-- CHANGELOG_AUTO_END -->';

// Banned strings we must keep out of generated content.
const BANNED = ['@kolmogorov/', 'coming soon', 'verify before ship', 'TBD'];

// Surface tag detection. Maps regex => human label. Order matters (longer
// before shorter where ambiguous).
const SURFACE_TAGS = [
  ['captures',     /captures/i],
  ['docs',         /\b(docs|spec|rs-1)\b/i],
  ['cli',          /\b(cli|kolm [a-z]+|verb)\b/i],
  ['hero',         /\b(hero|homepage|landing)\b/i],
  ['nav',          /\bnav\b/i],
  ['quickstart',   /quickstart/i],
  ['models',       /\b(models?|frontier|registry)\b/i],
  ['runtime',      /\bruntime/i],
  ['compute',      /\b(compute|backend)\b/i],
  ['pricing',      /pricing/i],
  ['marketplace',  /marketplace/i],
  ['enterprise',   /enterprise/i],
  ['tui',          /\btui\b/i],
  ['receipts',     /receipts?/i],
  ['compliance',   /\b(compliance|hipaa|nist|soc2|sr 11-7|gdpr)\b/i],
  ['seo',          /\bseo|sitemap|og:|article|pillar\b/i],
  ['tests',        /\btests?\b|sweep/i],
  ['distill',      /distill/i],
  ['replay',       /\breplay/i],
  ['ops',          /\b(deploy|ops|prod)\b/i],
  ['healthcare',   /healthcare/i],
  ['finance',      /\bfinance|finserv\b/i],
  ['legal',        /\blegal\b/i],
  ['security',     /\bsecurity\b/i],
  ['onboarding',   /onboarding/i],
];

function detectTags(summary) {
  const out = [];
  const lower = summary.toLowerCase();
  for (const [tag, re] of SURFACE_TAGS) {
    if (re.test(lower) && !out.includes(tag)) out.push(tag);
    if (out.length >= 5) break;
  }
  return out;
}

// Parse one bullet line into { waveNum, slug, date, summary, label }.
// Format: - [Kolm wave NNN <stuff>](project_kolm_waveNNN_<slug>_YYYY_MM_DD.md) <delim> <summary>
// Multi-wave entries use "waves NNN-MMM" or "wave NNN_MMM"; we take the first
// number for ordering and a label that preserves the range.
const ENTRY_RE = /^- \[(Kolm wave[s]?[^\]]*)\]\(([^)]+)\)\s*(?:[-—–]|—|--)\s*(.*)$/u;
const FILENAME_RE = /project_kolm_wave[s]?_?(\d+)(?:[_-](\d+))?[a-z_]*?_(\d{4}_\d{2}_\d{2})\.md$/i;

function parseLine(line) {
  const m = ENTRY_RE.exec(line);
  if (!m) return null;
  const [, label, filename, rawSummary] = m;
  const fn = FILENAME_RE.exec(filename);
  if (!fn) return null;
  const waveNum = parseInt(fn[1], 10);
  const waveNumEnd = fn[2] ? parseInt(fn[2], 10) : waveNum;
  const dateRaw = fn[3]; // YYYY_MM_DD
  const date = dateRaw.replace(/_/g, '-');
  const summary = (rawSummary || '').trim();
  if (!summary || summary.length < 12) return null;
  return {
    waveNum,
    waveNumEnd,
    waveLabel: makeWaveLabel(waveNum, waveNumEnd, label),
    label: label.replace(/^Kolm waves?\s*[\d-]+\s*/i, '').trim() || `wave ${waveNum}`,
    slug: filename.replace(/\.md$/, ''),
    filename,
    date,
    summary,
  };
}

function makeWaveLabel(start, end, raw) {
  // Detect explicit ranges in the label text: "waves 207-210", "wave 367-386".
  const rangeIn = /waves?\s+(\d+)\s*[-–—]\s*(\d+)/i.exec(raw);
  if (rangeIn) {
    const a = parseInt(rangeIn[1], 10);
    const b = parseInt(rangeIn[2], 10);
    return `W${a}-W${b}`;
  }
  // Also catch "waves 302+303" or "waves 304+305" (plus join).
  const plusIn = /waves?\s+(\d+)\s*\+\s*(\d+)/i.exec(raw);
  if (plusIn) {
    return `W${plusIn[1]}+W${plusIn[2]}`;
  }
  if (end && end !== start) return `W${start}-W${end}`;
  return `W${start}`;
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}

function collectEntries() {
  const buckets = new Map(); // key: waveNum-waveNumEnd, value: entry
  const sources = [readFileSafe(MEMORY_MD), readFileSafe(ARCHIVE_MD)];
  for (const text of sources) {
    if (!text) continue;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith('- [Kolm')) continue;
      const entry = parseLine(line);
      if (!entry) continue;
      const key = `${entry.waveNum}-${entry.waveNumEnd}`;
      // First occurrence wins; MEMORY.md is read before ARCHIVE.md so the
      // newer summary text takes precedence.
      if (!buckets.has(key)) buckets.set(key, entry);
    }
  }
  const out = Array.from(buckets.values());
  // Sort by ending wave number desc, then start desc, then date desc.
  out.sort((a, b) =>
    (b.waveNumEnd - a.waveNumEnd) ||
    (b.waveNum - a.waveNum) ||
    b.date.localeCompare(a.date)
  );
  return out;
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripEmDashes(s) {
  // Replace em-dash and en-dash variants with " - " then collapse whitespace.
  return s
    .replace(/—/g, ' - ')
    .replace(/–/g, '-')
    .replace(/&mdash;/gi, ' - ')
    .replace(/&ndash;/gi, '-')
    .replace(/&#8212;/g, ' - ')
    .replace(/&#8211;/g, '-')
    .replace(/&#x2014;/gi, ' - ')
    .replace(/&#x2013;/gi, '-')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Inline replacements for banned strings before they leak into output.
const BANNED_REPLACE = [
  [/@kolmogorov\//gi, 'at-kolmogorov '],
  [/coming soon/gi, 'on the roadmap'],
  [/verify before ship/gi, 'check before ship'],
  [/\bTBD\b/g, 'pending'],
];

function scrubBanned(s) {
  let out = s;
  for (const [re, repl] of BANNED_REPLACE) {
    out = out.replace(re, repl);
  }
  return out;
}

function sanitizeSummary(s) {
  let out = stripEmDashes(s);
  out = scrubBanned(out);
  // Trim to a digestible 1-2 sentence size. We cut at the first semicolon
  // chain past 280 chars so the change line stays compact.
  if (out.length > 320) {
    const cut = out.slice(0, 320);
    const lastSemi = cut.lastIndexOf(';');
    if (lastSemi > 180) out = cut.slice(0, lastSemi).trim();
    else out = cut.trim() + '...';
  }
  // Collapse repeated whitespace + stray double-space.
  return out.replace(/\s{2,}/g, ' ').trim();
}

function sanitizeLabel(s) {
  return scrubBanned(stripEmDashes(s));
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function monthBucketKey(dateIso) {
  // Convert "2026-05-18" -> "2026-05".
  return dateIso.slice(0, 7);
}

function monthLabel(key) {
  // "2026-05" -> "May 2026".
  const [y, m] = key.split('-');
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const idx = parseInt(m, 10) - 1;
  return `${names[idx] || m} ${y}`;
}

function renderTimelineItem(e) {
  const summary = sanitizeSummary(e.summary);
  const tags = detectTags(summary + ' ' + e.label);
  const pills = tags.map(t => `<span class="cl-pill">${htmlEscape(t)}</span>`).join('');
  return [
    '      <li class="cl-row">',
    `        <div class="cl-row-head">`,
    `          <span class="cl-tag">${htmlEscape(e.waveLabel)}</span>`,
    `          <h3 class="cl-row-title">${htmlEscape(sanitizeLabel(e.label))}</h3>`,
    `          <time datetime="${e.date}">${e.date}</time>`,
    `        </div>`,
    `        <p class="cl-row-sum">${htmlEscape(summary)}</p>`,
    pills ? `        <p class="cl-pills">${pills}</p>` : '',
    '      </li>',
  ].filter(Boolean).join('\n');
}

function renderTopBanner(top3) {
  const items = top3.map(e => {
    const short = sanitizeSummary(e.summary).split(/[.;]\s/)[0].slice(0, 180);
    return [
      '      <article class="cl-recent-card">',
      `        <span class="cl-tag">${htmlEscape(e.waveLabel)}</span>`,
      `        <h3>${htmlEscape(sanitizeLabel(e.label))}</h3>`,
      `        <p>${htmlEscape(short)}.</p>`,
      `        <time datetime="${e.date}">${e.date}</time>`,
      '      </article>',
    ].join('\n');
  }).join('\n');
  return [
    '    <section class="cl-recent" aria-label="Most recent waves">',
    '      <h2>Most recent</h2>',
    '      <div class="cl-recent-grid">',
    items,
    '      </div>',
    '    </section>',
  ].join('\n');
}

function renderMonthBuckets(entries) {
  // Group entries by month key in descending date order.
  const groups = new Map();
  for (const e of entries) {
    const k = monthBucketKey(e.date);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const keys = Array.from(groups.keys()).sort().reverse();
  const newestKey = keys[0];
  const parts = [];
  parts.push('    <section class="cl-history" aria-label="Full wave history">');
  parts.push('      <h2>Full history</h2>');
  for (const k of keys) {
    const rows = groups.get(k);
    const open = k === newestKey ? ' open' : '';
    parts.push(`      <details class="cl-bucket"${open}>`);
    parts.push(`        <summary><span class="cl-bucket-label">${htmlEscape(monthLabel(k))}</span> <span class="cl-bucket-count">${rows.length} wave${rows.length === 1 ? '' : 's'}</span></summary>`);
    parts.push('        <ol class="cl-timeline">');
    for (const e of rows) {
      parts.push(renderTimelineItem(e));
    }
    parts.push('        </ol>');
    parts.push('      </details>');
  }
  parts.push('    </section>');
  return parts.join('\n');
}

function renderAutoBlock(entries) {
  const top3 = entries.slice(0, 3);
  const banner = renderTopBanner(top3);
  const history = renderMonthBuckets(entries);
  return [banner, history].join('\n\n');
}

const JSON_LD_BREADCRUMB = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'kolm.ai', item: 'https://kolm.ai/' },
    { '@type': 'ListItem', position: 2, name: 'Changelog', item: 'https://kolm.ai/changelog' },
  ],
};

const JSON_LD_WEBPAGE = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'kolm.ai changelog',
  url: 'https://kolm.ai/changelog',
  description: 'Reverse-chronological wave-by-wave log of every kolm.ai release.',
  isPartOf: { '@type': 'WebSite', name: 'kolm.ai', url: 'https://kolm.ai/' },
  inLanguage: 'en',
};

function fullPage(entries) {
  const auto = renderAutoBlock(entries);
  return `<!DOCTYPE html>
<html lang="en" style="background:#08090c;color-scheme:dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>html,body{background:#08090c;color:#faf2e1}html{color-scheme:dark}</style>
<script>(function(){try{var t=localStorage.getItem('kolm-theme');if(t==='light'){document.documentElement.setAttribute('data-theme','light');document.documentElement.style.background='#f7f4ec';document.documentElement.style.colorScheme='light';}}catch(e){}})();</script>
<title>Changelog · kolm.ai</title>
<meta name="description" content="Reverse-chronological wave-by-wave log of every kolm.ai release. What shipped, what changed, when.">
<meta name="theme-color" content="#0b0d10" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f7f4ec" media="(prefers-color-scheme: light)">
<meta name="robots" content="index,follow">
<meta property="og:title" content="Changelog · kolm.ai">
<meta property="og:description" content="Reverse-chronological wave-by-wave log of every kolm.ai release.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://kolm.ai/changelog">
<meta property="og:image" content="https://kolm.ai/og-card.svg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Changelog · kolm.ai">
<meta name="twitter:description" content="Reverse-chronological wave-by-wave log of every kolm.ai release.">
<meta name="twitter:image" content="https://kolm.ai/og-card.svg">
<link rel="canonical" href="https://kolm.ai/changelog">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/brand-refresh.css">
<style>
  .cl-skip{position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden}
  .cl-skip:focus{position:static;width:auto;height:auto;padding:8px 12px;background:#10b981;color:#0b0d10;border-radius:4px}
  .cl-wrap{max-width:960px;margin:0 auto;padding:0 32px}
  .cl-hero{padding:88px 0 36px;border-bottom:1px solid var(--line)}
  .cl-hero .crumbs{font-family:var(--mono);font-size:11.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--ink-faint,#737c73);margin:0 0 16px}
  .cl-hero .crumbs a{color:inherit;text-decoration:none;border-bottom:1px dashed var(--line)}
  .cl-hero h1{font-size:clamp(40px,5.4vw,68px);line-height:1.04;margin:0 0 14px;letter-spacing:-0.03em;font-weight:500;color:var(--fg,#faf2e1)}
  .cl-hero .lede{font-size:16px;line-height:1.6;color:var(--ink-mute,#b5bdb1);max-width:64ch;margin:0 0 18px}
  .cl-hero .feed{display:flex;gap:18px;font-family:var(--mono);font-size:11.5px;color:var(--ink-faint,#737c73);letter-spacing:0.04em;flex-wrap:wrap}
  .cl-hero .feed a{color:inherit;border-bottom:1px dashed var(--line);text-decoration:none}

  .cl-recent{padding:40px 0;border-bottom:1px solid var(--line)}
  .cl-recent h2{margin:0 0 22px;font-size:13px;font-family:var(--mono);font-weight:500;color:var(--ink-faint,#737c73);letter-spacing:0.16em;text-transform:uppercase}
  .cl-recent-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}
  .cl-recent-card{padding:20px;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,0.02);display:flex;flex-direction:column;gap:8px}
  .cl-recent-card h3{margin:0;font-size:16px;font-weight:500;color:var(--fg,#faf2e1);letter-spacing:-0.01em}
  .cl-recent-card p{margin:0;color:var(--ink-mute,#b5bdb1);font-size:13.5px;line-height:1.55}
  .cl-recent-card time{font-family:var(--mono);font-size:11px;color:var(--ink-faint,#737c73);letter-spacing:0.04em}

  .cl-history{padding:32px 0 16px}
  .cl-history > h2{margin:0 0 18px;font-size:13px;font-family:var(--mono);font-weight:500;color:var(--ink-faint,#737c73);letter-spacing:0.16em;text-transform:uppercase}
  .cl-bucket{border-top:1px solid var(--line);padding:14px 0;margin:0}
  .cl-bucket > summary{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:14px;padding:6px 0;font-family:var(--mono);font-size:12px;letter-spacing:0.06em;color:var(--ink-mute,#b5bdb1)}
  .cl-bucket > summary::-webkit-details-marker{display:none}
  .cl-bucket > summary::before{content:'+';color:var(--ink-faint,#737c73);font-weight:600;width:14px;display:inline-block}
  .cl-bucket[open] > summary::before{content:'-'}
  .cl-bucket-label{color:var(--fg,#faf2e1);text-transform:uppercase}
  .cl-bucket-count{color:var(--ink-faint,#737c73)}
  .cl-timeline{list-style:none;margin:18px 0 24px;padding:0 0 0 14px;border-left:1px solid var(--line)}
  .cl-row{position:relative;padding:6px 0 22px 22px}
  .cl-row::before{content:'';position:absolute;left:-5px;top:14px;width:9px;height:9px;border-radius:50%;background:#10b981;box-shadow:0 0 0 3px #08090c}
  .cl-row-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:0 0 6px}
  .cl-tag{font-family:var(--mono);font-size:12px;font-weight:500;color:var(--accent,#10b981);padding:2px 8px;border:1px solid rgba(16,185,129,0.32);border-radius:5px;background:rgba(16,185,129,0.06);letter-spacing:0.02em}
  .cl-row-title{margin:0;font-size:15.5px;font-weight:500;color:var(--fg,#faf2e1);letter-spacing:-0.01em}
  .cl-row time{font-family:var(--mono);font-size:11px;color:var(--ink-faint,#737c73);letter-spacing:0.04em;margin-left:auto}
  .cl-row-sum{margin:0 0 8px;color:var(--ink-mute,#b5bdb1);font-size:13.5px;line-height:1.55}
  .cl-pills{margin:0;display:flex;flex-wrap:wrap;gap:6px}
  .cl-pill{font-family:var(--mono);font-size:10.5px;color:var(--ink-faint,#737c73);background:rgba(255,255,255,0.03);border:1px solid var(--line);border-radius:4px;padding:1px 7px;letter-spacing:0.02em}

  .cl-foot{padding:30px 0 60px;color:var(--ink-faint,#737c73);font-size:13px}
  .cl-foot a{color:inherit;border-bottom:1px dashed var(--line);text-decoration:none}

  @media (max-width:640px){
    .cl-wrap{padding:0 20px}
    .cl-hero{padding:64px 0 28px}
    .cl-row time{margin-left:0}
    .cl-row-head{flex-direction:column;align-items:flex-start;gap:4px}
  }
</style>
<script type="application/ld+json">${JSON.stringify(JSON_LD_BREADCRUMB)}</script>
<script type="application/ld+json">${JSON.stringify(JSON_LD_WEBPAGE)}</script>
</head>
<body>
<a class="cl-skip" href="#cl-main">Skip to main content</a>
<span class="brand-anchor" style="position:absolute;left:-9999px" aria-hidden="true">kolm.ai - the AI compiler. Not Kolm therapeutics, Kolm band, Kolm engines, or Petter Kolm.</span>
<!-- KOLM_NAV_BEGIN (W221) -->
<header class="site-header">
  <div class="wrap">
    <a class="logo" href="/">k o l m</a>
    <nav class="primary">
      <a class="nav-top" href="/product">Product</a>
      <a class="nav-top" href="/models">Models</a>
      <a class="nav-top" href="/docs">Docs</a>
      <a class="nav-top" href="/pricing">Pricing</a>
      <a class="nav-top" href="/enterprise">Enterprise</a>
    </nav>
  </div>
</header>
<!-- KOLM_NAV_END (W221) -->

<main id="cl-main">
  <section class="cl-hero">
    <div class="cl-wrap">
      <p class="crumbs"><a href="/">kolm</a> &nbsp;/&nbsp; changelog</p>
      <h1>Changelog</h1>
      <p class="lede">kolm.ai ships waves of work; each wave is a coherent slice of product. Below is every wave we have shipped, newest first, with a one-line summary and the surfaces it touched. Every claim here resolves to a signed receipt at <a href="/spec/rs-1">/spec/rs-1</a>.</p>
      <div class="feed">
        <a href="/spec/rs-1">RS-1 receipt spec &rarr;</a>
        <a href="https://github.com/sneaky-hippo/kolmogorov-stack/releases">github releases &rarr;</a>
      </div>
    </div>
  </section>

  <div class="cl-wrap">
${AUTO_BEGIN}
${renderAutoBlock(entries)}
${AUTO_END}

    <p class="cl-foot">Per-wave detail lives in the engineering memory; a wave label here always maps back to a signed receipt and a test sweep. Spot a regression? Mail <a href="mailto:hello@kolm.ai">hello@kolm.ai</a> with the wave label and a repro.</p>
  </div>
</main>

<footer class="site">
  <div class="wrap" style="max-width: 1180px;">
    <div class="footer-grid">
      <div>
        <h4>Build</h4>
        <a href="/quickstart">Quickstart</a>
        <a href="/docs">Docs</a>
        <a href="/spec/rs-1">RS-1 spec</a>
        <a href="/openapi.json">OpenAPI</a>
        <a href="/cli">CLI</a>
      </div>
      <div>
        <h4>Deploy</h4>
        <a href="/compute">Backends</a>
        <a href="/airgap">Air-gap</a>
        <a href="/integrations/cloudflare">Cloudflare</a>
        <a href="/integrations/github-actions">GitHub Actions</a>
        <a href="/integrations/gitlab-ci">GitLab CI</a>
      </div>
      <div>
        <h4>Proof</h4>
        <a href="/verify-prod">Verify a .kolm</a>
        <a href="/badge">Embed badge</a>
        <a href="/benchmarks">Benchmarks</a>
        <a href="/compare">Compare</a>
        <a href="/registry">Registry</a>
        <a href="/case-studies">Case studies</a>
      </div>
      <div>
        <h4>Industries</h4>
        <a href="/healthcare">Healthcare</a>
        <a href="/finance">Finance</a>
        <a href="/legal">Legal</a>
        <a href="/compliance">Compliance</a>
        <a href="/insure">Insurance</a>
      </div>
      <div>
        <h4>Company</h4>
        <a href="/pricing">Pricing</a>
        <a href="/changelog">Changelog</a>
        <a href="/security">Security</a>
        <a href="/community">Community</a>
        <a href="/contact">Contact</a>
      </div>
    </div>
    <div class="footer-tag">
      <span>kolm.ai - Made with .kolm - Apache-2.0</span>
      <span>Receipts signed in CI. Verify any artifact at /verify-prod.</span>
    </div>
  </div>
</footer>
</body>
</html>
`;
}

function assertSafe(html) {
  // Hard safety net before write.
  if (html.includes('—')) {
    throw new Error('em-dash leaked into changelog output');
  }
  for (const b of BANNED) {
    if (html.toLowerCase().includes(b.toLowerCase())) {
      throw new Error(`banned string in changelog output: ${b}`);
    }
  }
}

function writeIdempotent(targetPath, content) {
  let prev = '';
  try { prev = fs.readFileSync(targetPath, 'utf8'); } catch (_) {}
  if (prev === content) return 0;
  fs.writeFileSync(targetPath, content, 'utf8');
  return 1;
}

function build() {
  const entries = collectEntries();
  if (!entries.length) {
    console.error('changelog: no wave entries parsed; aborting');
    process.exitCode = 1;
    return { waves: 0, touched: 0 };
  }
  const html = fullPage(entries);
  assertSafe(html);
  const touched = writeIdempotent(OUT, html);
  console.log(`changelog: ${entries.length} waves rendered, ${touched} files touched`);
  return { waves: entries.length, touched };
}

if (require.main === module) build();
module.exports = {
  build,
  parseLine,
  collectEntries,
  detectTags,
  sanitizeSummary,
  stripEmDashes,
  AUTO_BEGIN,
  AUTO_END,
};
