#!/usr/bin/env node
// W619 docs reorg: walk public/docs, extract title + first paragraph,
// categorize by file path, emit /public/docs-manifest.json.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'public');
const DOCS = path.join(ROOT, 'docs');

function walk(d, acc) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.html')) acc.push(p);
  }
  return acc;
}

function pageMeta(abs) {
  const s = fs.readFileSync(abs, 'utf8');
  const t = (s.match(/<title>([^<]+)<\/title>/i) || [, ''])[1]
    .replace(/\s*[·•]\s*kolm\.ai.*$/i, '')
    .trim();
  const d = (s.match(/<meta name="description" content="([^"]+)"/i) || [, ''])[1];
  return { title: t, desc: d };
}

function urlOf(abs) {
  let r = '/' + path.relative(ROOT, abs).replace(/\\/g, '/');
  // strip .html for clean URLs, but keep /docs/ paths as-is (vercel rewrites)
  r = r.replace(/\.html$/, '');
  r = r.replace(/\/index$/, '/');
  return r;
}

const files = walk(DOCS, []).filter((f) => !/\.md$|\/showcase\//.test(f));

// Manual category map — high-traffic curated lists. Anything not mentioned
// here lands in "More". Order matters: items appear in the sidebar as listed.
const CATEGORIES = [
  {
    id: 'start',
    title: 'Get started',
    pages: [
      { url: '/quickstart',           label: 'Quickstart' },
      { url: '/docs/quickstart',      label: 'Docs quickstart' },
      { url: '/why-kolm',             label: 'Why kolm' },
      { url: '/docs/install/mac',     label: 'Install on macOS' },
      { url: '/docs/install/linux',   label: 'Install on Linux' },
      { url: '/docs/install/windows', label: 'Install on Windows' },
    ],
  },
  {
    id: 'core',
    title: 'Core concepts',
    pages: [
      { url: '/docs/distillation',  label: 'Distillation' },
      { url: '/docs/distill',       label: 'Distill (CLI)' },
      { url: '/docs/runtime',       label: 'Runtime targets' },
      { url: '/docs/verify',        label: 'Verify a .kolm' },
      { url: '/k-score',            label: 'K-score gate' },
      { url: '/docs/evals',         label: 'Eval packs' },
      { url: '/docs/optimizer',     label: 'Optimizer' },
      { url: '/docs/glossary',      label: 'Glossary' },
    ],
  },
  {
    id: 'cli',
    title: 'CLI reference',
    primary: [
      // The 12 verbs that cover the authoring loop. Sidebar pins these
      // at the top of the CLI category so first-time readers see the
      // happy path before the alphabetized full list of every verb.
      'init', 'login', 'whoami', 'capture', 'distill', 'compile',
      'quantize', 'verify', 'run', 'score', 'serve', 'doctor',
    ],
    pages: [{ url: '/docs/cli', label: 'CLI overview' }],
    // Empty — filled by the auto-discover pass below from every
    // public/docs/cli/*.html file. Keeps the manifest in sync with
    // the actual shipped verb pages without manual edits.
    autoAppendFrom: '/docs/cli',
  },
  {
    id: 'sdks',
    title: 'SDKs',
    pages: [
      { url: '/docs/sdk',           label: 'SDK overview' },
      { url: '/sdks',               label: 'SDK catalog' },
      { url: '/sdks/node',          label: 'Node.js' },
      { url: '/sdks/python',        label: 'Python' },
      { url: '/sdks/mcp',           label: 'MCP server' },
      { url: '/sdks/vscode',        label: 'VS Code' },
      { url: '/sdks/c',             label: 'C (single-header)' },
      { url: '/sdks/rust',          label: 'Rust' },
    ],
  },
  {
    id: 'connect',
    title: 'Connect a provider',
    pages: [
      { url: '/docs/connect/openai',      label: 'OpenAI' },
      { url: '/docs/connect/anthropic',   label: 'Anthropic' },
      { url: '/docs/connect/gemini',      label: 'Google Gemini' },
      { url: '/docs/connect/openrouter',  label: 'OpenRouter' },
    ],
  },
  {
    id: 'runtimes',
    title: 'Runtimes & deployment',
    pages: [
      { url: '/runtimes',         label: 'Runtime matrix' },
      { url: '/docs/devices',     label: 'Devices' },
      { url: '/docs/sandbox',     label: 'Sandbox' },
      { url: '/docs/state',       label: 'State management' },
      { url: '/docs/storage',     label: 'Storage' },
      { url: '/docs/lake',        label: 'Capture lake' },
      { url: '/docs/datasets',    label: 'Datasets' },
      { url: '/docs/cloud-sync',  label: 'Cloud sync' },
    ],
  },
  {
    id: 'api',
    title: 'API & schemas',
    pages: [
      { url: '/docs/api',            label: 'HTTP API reference' },
      { url: '/openapi.json',        label: 'OpenAPI JSON' },
      { url: '/docs/manifest-v0.1.json', label: '.kolm manifest schema' },
      { url: '/docs/receipt-v0.1.json',  label: 'Receipt schema' },
      { url: '/docs/kolm-yaml-v0.1.json', label: 'kolm.yaml schema' },
      { url: '/docs/webhooks',       label: 'Webhooks' },
      { url: '/docs/webauthn',       label: 'WebAuthn' },
      { url: '/docs/tickets',        label: 'Tickets' },
    ],
  },
  {
    id: 'security',
    title: 'Security & compliance',
    pages: [
      { url: '/security',                  label: 'Security overview' },
      { url: '/soc2',                      label: 'SOC 2' },
      { url: '/hipaa-mapping',             label: 'HIPAA mapping' },
      { url: '/baa',                       label: 'BAA' },
      { url: '/docs/privacy',              label: 'Privacy' },
      { url: '/docs/k-score-methodology',  label: 'K-score methodology' },
      { url: '/docs/cve-in-kscore',        label: 'CVE in K-score' },
      { url: '/docs/rs-1',                 label: 'RS-1 receipt' },
      { url: '/docs/enterprise',           label: 'Enterprise patterns' },
    ],
  },
  {
    id: 'integrations',
    title: 'Integrations',
    pages: [
      { url: '/docs/integrations/langchain-py',  label: 'LangChain (Python)' },
      { url: '/docs/integrations/langchain-js',  label: 'LangChain (JS)' },
      { url: '/docs/integrations/llamaindex-py', label: 'LlamaIndex (Python)' },
      { url: '/docs/integrations/llamaindex-js', label: 'LlamaIndex (JS)' },
      { url: '/docs/integrations/zapier',        label: 'Zapier' },
      { url: '/docs/integrations/make',          label: 'Make.com' },
      { url: '/docs/connectors',                 label: 'Connector index' },
    ],
  },
  {
    id: 'guides',
    title: 'Agent & workflow guides',
    pages: [
      { url: '/docs/agent-guide',      label: 'Build a kolm agent' },
      { url: '/docs/dev-agents',       label: 'Dev-time agents' },
      { url: '/docs/training',         label: 'Training loop' },
      { url: '/docs/cookbook',         label: 'Cookbook' },
      { url: '/docs/team',             label: 'Teams' },
      { url: '/docs/troubleshooting',  label: 'Troubleshooting' },
    ],
  },
  {
    id: 'lang',
    title: 'Localized',
    pages: [
      { url: '/docs/i18n/es', label: 'Espanol' },
      { url: '/docs/i18n/fr', label: 'Francais' },
      { url: '/docs/i18n/de', label: 'Deutsch' },
      { url: '/docs/i18n/ja', label: 'Japanese' },
      { url: '/docs/i18n/ko', label: 'Korean' },
      { url: '/docs/i18n/zh', label: 'Chinese' },
    ],
  },
];

// Pages on disk we haven't categorized — surface so we know. NOTE we
// compute this AFTER the autoAppend pass below (see out.categories).

// Build manifest with file existence filter — drop sidebar items whose
// target file is missing (so we don't show dead links).
const onDiskUrls = new Set(files.map((f) => urlOf(f).replace(/\/$/, '')));
// Also accept extra URLs that the site serves via vercel rewrites (no disk file).
const SERVED_BY_REWRITE = new Set([
  '/quickstart', '/why-kolm', '/k-score', '/runtimes', '/sdks',
  '/sdks/node', '/sdks/python', '/sdks/mcp', '/sdks/vscode', '/sdks/c', '/sdks/rust',
  '/security', '/soc2', '/hipaa-mapping', '/baa',
  '/openapi.json',
]);

const out = { generated_at: new Date().toISOString(), categories: [] };
for (const cat of CATEGORIES) {
  const live = cat.pages.filter((p) => {
    const u = p.url.replace(/\/$/, '');
    return onDiskUrls.has(u) || SERVED_BY_REWRITE.has(u);
  });
  // Auto-discover sibling pages under a path prefix (e.g. /docs/cli).
  // Used so the CLI category lists every verb file without manual
  // book-keeping when a new verb ships.
  if (cat.autoAppendFrom) {
    const prefix = cat.autoAppendFrom.replace(/\/$/, '') + '/';
    const already = new Set(live.map((p) => p.url));
    const extra = [];
    for (const u of onDiskUrls) {
      if (u === cat.autoAppendFrom) continue;
      if (!u.startsWith(prefix)) continue;
      if (already.has(u)) continue;
      const name = u.split('/').pop();
      extra.push({ url: u, label: 'kolm ' + name });
    }
    extra.sort((a, b) => a.url.localeCompare(b.url));
    live.push(...extra);
  }
  // Primary verbs get pinned at the top with a label change.
  const entry = { id: cat.id, title: cat.title, pages: live };
  if (cat.primary) entry.primary = cat.primary;
  out.categories.push(entry);
}

// Compute uncategorized AFTER autoAppend so CLI verbs don't double-count.
const categorized = new Set();
for (const cat of out.categories) for (const p of cat.pages) {
  categorized.add(p.url.replace(/\/$/, ''));
}
const uncategorized = [];
for (const f of files) {
  let u = urlOf(f).replace(/\/$/, '');
  if (u === '/docs' || u === '') continue;
  if (!categorized.has(u)) {
    const meta = pageMeta(f);
    uncategorized.push({ url: u, label: meta.title });
  }
}

if (uncategorized.length) {
  out.categories.push({
    id: 'more',
    title: 'More',
    pages: uncategorized
      .map((u) => ({ url: u.url, label: u.label || u.url.split('/').pop() }))
      .sort((a, b) => a.url.localeCompare(b.url)),
  });
}

const outPath = path.join(ROOT, 'docs-manifest.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log('wrote', outPath);
console.log('categories:', out.categories.length);
console.log('total pages:', out.categories.reduce((a, c) => a + c.pages.length, 0));
console.log('uncategorized routed to More:', uncategorized.length);
