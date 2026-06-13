import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';

const TEXT_EXTENSIONS = new Set([
  '.html', '.css', '.js', '.svg', '.json', '.webmanifest', '.xml', '.txt', '.md',
]);

const LEGACY_BRAND_PATTERNS = [
  '#05040a',
  '#080908',
  '#10120f',
  '#151712',
  '#f6f1e7',
  '#a9aaa2',
  '#70756d',
  '#a7ff5f',
  '#63e7ff',
  '#ff8a5f',
  '#0b0d16',
  '#101522',
  '#8ea4ff',
  '#78f0d4',
  '#ffca7a',
  'rgba(142,164,255',
  'rgba(120,240,212',
  'rgba(255,202,122',
  'rgba(5,4,10',
  'rgba(10,10,10',
  'rgba(170, 156, 255',
  'rgba(170,156,255',
  '#7c8cff',
  '#93a1ff',
  '#7ce3b6',
  '#e3deff',
  'rgba(124,140,255',
  'rgba(124,232,182',
  '#aa9cff',
  '#d4c8ff',
  '#65d4ff',
  '#5be8b6',
  '#0d1224',
  '#11172a',
  'rgba(22,19,42',
  'rgba(14,12,28',
  'Compile any AI task into a Specialist',
  'Compile your data into a model',
  'AI that ships as a',
];

const FORBIDDEN_PUBLIC_PATTERNS = [
  'install.sh',
  'brew install ' + 'kolmo' + 'gorov/tap/kolm',
  'brew install kolm',
  'cargo install kolm',
  'pip install kolm',
  'curl kolm.ai/install',
  'curl -fsSL https://kolm.ai/install',
  'npm i -g @kolm/kolm',
  'kolm key add',
  '.kolm bundle',
  'kolm anchor ',
  'kolm recall ',
  'kolm resolve ',
  '--tpl',
  '~/.kolm/credentials',
  'phone cold-start',
  '3B INT4',
  'kolmo' + 'gorov-stack-production.up.railway.app',
  'Type I evidence available now',
  'SOC 2 Type II evidence',
  'EU AI Act compliant',
  'HIPAA-ready',
  'DPA signed at sign-up',
  'Conformity assessment in flight',
  'On-chain receipt anchoring',
  'On-chain receipt anchor',
  'on-chain receipt anchoring',
  'Bitcoin OP_RETURN',
  'Arweave',
  'kolm anchor --on-chain',
  'Air-gap mode',
  'Air-gapped registry mirror',
  'On-prem compile bridge',
  'Mobile SDK',
  'kolm-swift',
  'ai.kolm:kolm-runtime',
  '@kolm-ai/runtime',
  'Cleared App Review',
  'iOS \u7e5a Android SDK',
  'WASM runtime',
  'kolm WASM',
  'HMAC chain to registry',
  'anchored to the public registry',
  'PHI never leaves',
  'data never moves',
  'Your data never moves',
  'No bytes leave at runtime',
  'No data leaves at runtime',
  'No internet at runtime',
  'Zero network. Works',
  'strictly better than the last',
  'strictly better.</b>',
  'Inference runs on the phone',
  'phone-native runtime',
  'BAA boundary',
  'inside the BAA boundary',
  'VPC peering optional',
  'On-device runtime with',
  'on-chain anchor today',
  'air-gapped box',
  'runs on any modern phone',
  'FedRAMP Moderate roadmap',
  'CMMC 2.0 Level 2 evidence',
  'ITAR-aware',
  'SAML \u7e5a SCIM',
  'unlimited Specialists',
  'Postgres database on Railway',
  'Cloudflare R2',
  'zero runtime egress',
  'inside your VPC',
  'fully self-contained',
  'anchored to public registry',
  'anchored to the public registry',
  'HMAC chain ??public registry',
  'every phone shipped',
  'wllama.wasm',
  'Executorch bindings',
  'never persisted server-side',
  'Public append-only registry',
  '\u7e5a',
  '\u7e55',
  '??/span',
  '??/a',
  'ks_??',
  '\u875c',
  '?\uea04',
];

// Canonical surfaces of the compiler-first main site. Audit/report-specific
// pages live on audit.kolm.ai and must not be indexed as primary kolm.ai pages.
const REQUIRED_SITEMAP_ROUTES = [
  '/',
  '/how-it-works',
  '/platform',
  '/integrations',
  '/runtimes',
  '/capabilities',
  '/pricing',
  '/docs',
  '/enterprise',
  '/security',
  '/trust',
  '/contact',
  '/research',
  '/changelog',
  '/status',
  '/signup',
  '/privacy',
  '/terms',
  '/dpa',
  '/baa',
  '/acceptable-use',
  '/sla',
  '/subprocessors',
];

const AUDIT_HOST_ONLY_ROUTES = [
  '/verify',
  '/checks',
  '/report',
  '/report-viewer',
  '/badge',
  '/roi',
  '/regulatory-clock',
  '/transparency-log',
  '/trust-center',
  '/buyer',
  '/spec',
  '/security/threat-model',
  '/solutions/ai-vendors',
  '/solutions/enterprise-buyers',
];

const COMPILER_PRODUCT_ROUTES = [
  '/how-it-works',
];

const IMAGE_TWO_PAPER_FILES = [
  'compiler-product.html',
  'how-it-works.html',
  'docs.html',
  'pricing.html',
  'signup.html',
  'integrations.html',
  'compare.html',
  'runtimes.html',
  'enterprise.html',
  'platform.html',
  'capabilities.html',
  'research.html',
  'changelog.html',
  'contact.html',
  'security.html',
  'trust.html',
  'status.html',
  '404.html',
  'compiler-terms.html',
];

const IMAGE_TWO_SOCIAL_CARD_FILES = new Set([
  'compiler-product.html',
  'how-it-works.html',
  'docs.html',
  'pricing.html',
  'signup.html',
  'integrations.html',
  'compare.html',
  'runtimes.html',
  'enterprise.html',
  'platform.html',
  'capabilities.html',
  'research.html',
  'changelog.html',
  'contact.html',
  'security.html',
  'trust.html',
  'status.html',
]);

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// W224 cut routes ??these MUST NOT appear in sitemap. Negative assertion locks
// in the deletion so a future regenerate can't silently re-add them.
const FORBIDDEN_SITEMAP_ROUTES = [
  '/run', '/recall', '/serve', '/anatomy',
  '/agents', '/defense', '/evolve', '/bounty', '/bounties',
  '/cloud', '/edge', '/cookbook', '/playground',
  '/onboarding', '/showcase', '/openai',
  // Cutover-retired: /soc2 now 308-redirects to /trust (no soc2.html). A
  // redirect source must never appear in the sitemap, so lock it out here.
  '/soc2',
  ...AUDIT_HOST_ONLY_ROUTES,
];

const STALE_SOURCE_PATTERNS = [
  '# Recipe',
  'kolmo' + 'gorov-stack-production.up.railway.app',
  'Retail brand: **Recipe**',
  'Recipe is the **Skills** layer',
  '@kolm/recipe',
  'kolmo' + 'gorov-recipe',
];

function walkFiles(dir, predicate, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(file, predicate, out);
    else if (!predicate || predicate(file)) out.push(file);
  }
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, retries = 120) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(base + '/health');
      if (res.ok) return;
    } catch {} // deliberate: cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not come up');
}

function normalizeInternalUrl(raw) {
  if (!raw) return null;
  let value = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!value || value.startsWith('#')) return null;
  if (/^(mailto|tel|javascript|data|blob):/i.test(value)) return null;
  if (value.startsWith('https://kolm.ai/')) value = value.slice('https://kolm.ai'.length);
  if (value.startsWith('http://kolm.ai/')) value = value.slice('http://kolm.ai'.length);
  if (!value.startsWith('/')) return null;
  if (value.startsWith('/v1/')) return null;
  return value.split('#')[0];
}

function collectInternalReferences() {
  const refs = new Set(['/sitemap.xml']);
  const htmlFiles = walkFiles('public', file =>
    file.endsWith('.html') &&
    !file.includes(`${path.sep}_archive${path.sep}`)
  );

  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/\b(?:href|src|poster|action)=["']([^"']+)["']/gi)) {
      const ref = normalizeInternalUrl(match[1]);
      if (ref) refs.add(ref);
    }
    for (const match of html.matchAll(/url\(([^)]+)\)/gi)) {
      const ref = normalizeInternalUrl(match[1]);
      if (ref) refs.add(ref);
    }
  }

  for (const cssFile of walkFiles('public', file => file.endsWith('.css'))) {
    const css = fs.readFileSync(cssFile, 'utf8');
    for (const match of css.matchAll(/url\(([^)]+)\)/gi)) {
      const ref = normalizeInternalUrl(match[1]);
      if (ref) refs.add(ref);
    }
  }

  const sitemap = fs.readFileSync(path.join('public', 'sitemap.xml'), 'utf8');
  for (const match of sitemap.matchAll(/<loc>https:\/\/kolm\.ai([^<]+)<\/loc>/g)) {
    const ref = normalizeInternalUrl(match[1]);
    if (ref) refs.add(ref);
  }

  return [...refs].sort();
}

test('static text assets have clean encoding and current brand tokens', () => {
  const files = walkFiles('public', file => TEXT_EXTENSIONS.has(path.extname(file)));
  const failures = [];

  for (const file of files) {
    const buf = fs.readFileSync(file);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      failures.push(`${file}: UTF-8 BOM`);
      continue;
    }

    const text = buf.toString('utf8');
    if (text.includes('`r`n')) failures.push(`${file}: literal PowerShell newline escape`);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0xfffd || (code >= 0xe000 && code <= 0xf8ff)) {
        failures.push(`${file}: mojibake/private-use glyph at offset ${i}`);
        break;
      }
    }

    if (!file.includes(`${path.sep}_archive${path.sep}`)) {
      for (const pattern of LEGACY_BRAND_PATTERNS) {
        if (text.includes(pattern)) failures.push(`${file}: legacy brand token ${pattern}`);
      }
      for (const pattern of FORBIDDEN_PUBLIC_PATTERNS) {
        if (text.includes(pattern)) failures.push(`${file}: forbidden public pattern ${pattern}`);
      }
      if (file.endsWith('.html') && text.includes('href="/benchmarks"') && !text.includes('href="/compare"')) {
        failures.push(`${file}: benchmarks nav without compare nav`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test('server and source text assets have clean encoding', () => {
  const sourceFiles = [
    'README.md',
    'server.js',
    '.env.example',
    'package.json',
    'cli/kolm.js',
    ...walkFiles(path.join('sdk', 'node'), file => TEXT_EXTENSIONS.has(path.extname(file))),
    ...walkFiles('docs', file =>
      TEXT_EXTENSIONS.has(path.extname(file)) &&
      !file.includes(`${path.sep}research${path.sep}`) &&
      !file.includes(`${path.sep}internal${path.sep}`)
    ),
    ...walkFiles('src', file => TEXT_EXTENSIONS.has(path.extname(file))),
    ...walkFiles('tests', file =>
      TEXT_EXTENSIONS.has(path.extname(file)) &&
      !file.endsWith(path.join('tests', 'site.test.js'))
    ),
  ];
  const failures = [];

  for (const file of sourceFiles) {
    const buf = fs.readFileSync(file);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      failures.push(`${file}: UTF-8 BOM`);
      continue;
    }

    const text = buf.toString('utf8');
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0xfffd || (code >= 0xe000 && code <= 0xf8ff)) {
        failures.push(`${file}: mojibake/private-use glyph at offset ${i}`);
        break;
      }
    }

    const scansPositioningCopy =
      file === 'README.md' ||
      file.startsWith('docs' + path.sep) ||
      file.startsWith(path.join('sdk', 'node') + path.sep);
    if (scansPositioningCopy) {
      for (const pattern of STALE_SOURCE_PATTERNS) {
        if (text.includes(pattern)) failures.push(`${file}: stale source pattern ${pattern}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test('public inline scripts parse successfully', () => {
  const htmlFiles = walkFiles('public', file =>
    file.endsWith('.html') &&
    !file.includes(`${path.sep}_archive${path.sep}`)
  );
  const failures = [];

  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attrs = match[1] || '';
      if (/\bsrc\s*=/.test(attrs)) continue;
      const type = (attrs.match(/\btype=["']([^"']+)/i) || [])[1] || '';
      if (type && !/javascript|module/i.test(type)) continue;
      if (/module/i.test(type)) continue;
      try {
        new Function(match[2]);
      } catch (error) {
        failures.push(`${file}: ${error.message}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test('trust page exposes readiness gates without overclaiming', () => {
  const trust = fs.readFileSync(path.join('public', 'trust.html'), 'utf8');
  const readiness = JSON.parse(fs.readFileSync(path.join('public', 'product-readiness-closeout.json'), 'utf8'));
  const statuses = new Set(readiness.open_requirements.map(item => item.status.replaceAll('_', ' ')));

  assert.match(trust, /Product Readiness and Evidence Center/);
  assert.match(trust, /<b>8<\/b> open readiness gates/);
  assert.match(trust, /product-readiness-closeout\.json/);
  assert.match(trust, /Marketing and product UI must not describe these as fully shipped/);

  for (const status of statuses) {
    assert.match(trust, new RegExp(status.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `trust page should expose ${status}`);
  }

  assert.doesNotMatch(trust, /Run the free scan/);
  assert.doesNotMatch(trust, /SOC 2 Type II evidence/);
  assert.doesNotMatch(trust, /HIPAA-ready/);
  assert.doesNotMatch(trust, /Public append-only registry/);
});

test('security page exposes control posture without overclaiming', () => {
  const security = fs.readFileSync(path.join('public', 'security.html'), 'utf8');

  assert.match(security, /Kolm Security and Control Posture/);
  assert.match(security, /Security starts at the API boundary/);
  assert.match(security, /Unknown schemas stay opaque/);
  assert.match(security, /Certification and Package Gates/);
  assert.match(security, /needs live certification/);
  assert.match(security, /needs package release/);
  assert.match(security, /needs public benchmark data/);
  assert.match(security, /needs external partner/);

  assert.doesNotMatch(security, /Run the free scan/);
  assert.doesNotMatch(security, /Start an audit/);
  assert.doesNotMatch(security, /SOC 2 Type II evidence/);
  assert.doesNotMatch(security, /HIPAA-ready/);
  assert.doesNotMatch(security, /FedRAMP Moderate roadmap/);
});

test('homepage exposes control-plane loop without overclaiming', () => {
  const home = fs.readFileSync(path.join('public', 'index.html'), 'utf8');

  // clean linear-grade homepage: the compiler loop, told simply
  assert.match(home, /Compile your API behavior into a model that runs anywhere/);
  assert.match(home, /The AI compiler/);
  assert.match(home, /Route your model traffic through one endpoint/);
  assert.match(home, /Turn captured behavior into a signed artifact/);
  assert.match(home, /Run it on the smallest runtime that fits/);
  assert.match(home, /Capture/);
  assert.match(home, /Compile/);
  assert.match(home, /Compose/);
  assert.match(home, /Deploy/);
  assert.match(home, /.kolm/);
  assert.match(home, /Ed25519/);
  assert.match(home, /Get an API key/);
  assert.match(home, /Read the docs/);
  assert.match(home, /Own the behavior you/);
  assert.match(home, /runtime targets/);
  assert.match(home, /your hardware/);
  // clean standalone homepage — no kolm-main.css, no heavy product renders inline
  assert.doesNotMatch(home, /kolm-main.css/);

  assert.doesNotMatch(home, /better than every/i);
  assert.doesNotMatch(home, /objectively better/i);
  assert.doesNotMatch(home, /100x/i);
  assert.doesNotMatch(home, /Run the free scan/i);
  assert.doesNotMatch(home, /Start an audit/i);
  assert.doesNotMatch(home, /Reviewed Attestation/i);
  assert.doesNotMatch(home, /SOC 2 Type II evidence/i);
  assert.doesNotMatch(home, /HIPAA-ready/i);
  assert.doesNotMatch(home, /FedRAMP Moderate/i);
});

test('primary compiler pages use the image-2 paper design contract', () => {
  for (const file of IMAGE_TWO_PAPER_FILES) {
    const html = fs.readFileSync(path.join('public', file), 'utf8');

    assert.match(html, /compiler-site--paper/, `${file} should use the shared paper surface`);
    assert.match(html, /data-design-reference="image-2"/, `${file} should keep the image-2 design marker`);

    if (IMAGE_TWO_SOCIAL_CARD_FILES.has(file)) {
      assert.match(html, /<meta name="theme-color" content="#06080A">/, `${file} should use the obsidian reactor browser theme`);
      assert.match(html, /compiler-brand-hero\.png/, `${file} should use the compiler social card`);
      assert.doesNotMatch(html, /https:\/\/kolm\.ai\/brand-hero\.png/, `${file} should not use the retired audit social card`);
    }

    const header = html.match(/<header class="nav">[\s\S]*?<\/header>/)?.[0] || '';
    if (header) {
      assert.match(header, />Solutions<\/a>/, `${file} should use the image-2 Solutions nav label`);
      assert.match(header, /href="\/docs"[^>]*>Developers<\/a>/, `${file} should use the image-2 Developers nav label`);
      assert.match(header, /href="\/pricing"[^>]*>Pricing<\/a>/, `${file} should keep pricing in the compact nav`);
      assert.match(header, /class="nav__icon" href="\/status" aria-label="System status"/, `${file} should expose the compact status icon control`);
      assert.match(header, /href="\/account\/overview">sign in<\/a>/, `${file} should keep sign-in as the quiet secondary action`);
      assert.match(header, /href="\/signup">Get API key/, `${file} should use the image-2 API-key CTA`);
      assert.doesNotMatch(header, /https:\/\/audit\.kolm\.ai/i, `${file} should not put audit in the primary header`);
      assert.doesNotMatch(header, />Audit<\/a>/i, `${file} should not put Audit in the primary header`);
      assert.doesNotMatch(header, />Pipeline<\/a>|>Control<\/a>|>Integrations<\/a>|>Runtimes<\/a>|>Compare<\/a>/, `${file} should not use the old crowded product nav`);
      assert.doesNotMatch(header, />API docs<\/a>|>API Docs<\/a>|>Open control<\/a>|>Open Control<\/a>|>Create Workspace<\/a>|>Plan JSON<\/a>|>Open workspace<\/a>/, `${file} should not use page-specific header actions`);
    }
  }
});

test('account workspace uses compiler-first product shell instead of stale audit dashboard', () => {
  const overview = fs.readFileSync(path.join('public', 'account', 'overview.html'), 'utf8');
  const dashboard = fs.readFileSync(path.join('public', 'dashboard.html'), 'utf8');

  assert.match(overview, /Compiler Workspace/);
  assert.match(overview, /data-design-reference="image-2"/);
  assert.match(overview, /Compiler workspace source-to-artifact console/);
  assert.match(overview, /behavior-to-artifact workspace/);
  assert.match(overview, /secret_values_included: false/);
  assert.match(overview, /Open Compiler Workspace/);
  assert.match(overview, /Open API Control Center/);
  assert.match(overview, /Read API Contract/);
  assert.match(overview, /Preview mode/);
  assert.match(overview, /Workspace visible\. Tenant actions stay locked\./);
  assert.match(overview, /demoCompilerOverviewPayload/);
  assert.match(overview, /render\(demoCompilerOverviewPayload\(\), \{/);
  assert.match(overview, /type="password"/);
  assert.match(overview, /Evidence archive/);
  assert.match(overview, /925<\/b> owned routes/);
  assert.match(overview, /8<\/b> open gates/);
  assert.doesNotMatch(overview, /Your reports/);
  assert.doesNotMatch(overview, /Run the free scan/);
  assert.doesNotMatch(overview, /Audit module/);

  assert.match(dashboard, /location\.replace\('\/account\/overview'\)/);
  assert.match(dashboard, /Opening Compiler Workspace/);
  assert.doesNotMatch(dashboard, /Agent Security-Review/);
  assert.doesNotMatch(dashboard, /Your reports/);
});

test('status page exposes compiler platform posture without stale audit pipeline copy', () => {
  const status = fs.readFileSync(path.join('public', 'status.html'), 'utf8');

  assert.match(status, /Kolm Status - API Control Center, Compiler, Exports/);
  assert.match(status, /API behavior in\. Device-fit models out\./);
  assert.match(status, /source-to-proof status/i);
  assert.match(status, /API Control Center/);
  assert.match(status, /runtime targets/);
  assert.match(status, /governance exports/);
  assert.match(status, /Readiness-gated/);
  assert.match(status, /Deploy command center/);
  assert.match(status, /data-deploy-readiness/);
  assert.match(status, /Live readiness gate/);
  assert.match(status, /data-status-live-state/);
  assert.match(status, /data-status-health/);
  assert.match(status, /data-status-ready/);
  assert.match(status, /data-status-routes/);
  assert.match(status, /data-status-gates/);
  assert.match(status, /getJson\('\/health'\)/);
  assert.match(status, /getJson\('\/ready'\)/);
  assert.match(status, /getJson\('\/v1\/product\/graph'\)/);
  assert.match(status, /getJson\('\/product-readiness-closeout\.json'\)/);
  assert.match(status, /railway up/);
  assert.match(status, /npx\.cmd vercel --prod/);
  assert.match(status, /backend first, frontend second/);
  assert.match(status, /package-release and benchmark gates remain explicit/);
  assert.match(status, /secret-safe status/i);
  assert.match(status, /Get API key/);

  assert.doesNotMatch(status, /System Status: Verifier, API, Audit Pipeline/i);
  assert.doesNotMatch(status, /Audit infrastructure status/i);
  assert.doesNotMatch(status, /Audit pipeline/i);
  assert.doesNotMatch(status, /Run the free scan/i);
  assert.doesNotMatch(status, /Verify a report/i);
  assert.doesNotMatch(status, /https:\/\/kolm\.ai\/brand-hero\.png/);
  assert.doesNotMatch(status, /SOC 2 Type II/i);
  assert.doesNotMatch(status, /HIPAA-ready/i);
  assert.doesNotMatch(status, /FedRAMP Moderate/i);
  assert.doesNotMatch(status, /\u875c/);
});

test('enterprise page exposes API control workflow without overclaiming', () => {
  const enterprise = fs.readFileSync(path.join('public', 'enterprise.html'), 'utf8');

  assert.match(enterprise, /Kolm Enterprise Control Center/);
  assert.match(enterprise, /Enterprise AI control starts before a model ships/);
  assert.match(enterprise, /API behavior in\. Device-fit models out\./);
  assert.match(enterprise, /17 API data channel families/);
  assert.match(enterprise, /12 ingress modes/);
  assert.match(enterprise, /10 export modes/);
  assert.match(enterprise, /8 governance stages/);
  assert.match(enterprise, /8 open readiness gates/);
  assert.match(enterprise, /Readiness-gated claims/);
  assert.match(enterprise, /Do not imply certification/);

  assert.doesNotMatch(enterprise, /Run the free scan/);
  assert.doesNotMatch(enterprise, /Start an audit/);
  assert.doesNotMatch(enterprise, /Reviewed Attestation/);
  assert.doesNotMatch(enterprise, /\$25,000/);
  assert.doesNotMatch(enterprise, /co-signed/i);
  assert.doesNotMatch(enterprise, /SOC 2 Type II evidence/);
  assert.doesNotMatch(enterprise, /HIPAA-ready/);
  assert.doesNotMatch(enterprise, /FedRAMP Moderate roadmap/);
});

test('platform page exposes architecture without stale audit packaging', () => {
  const platform = fs.readFileSync(path.join('public', 'platform.html'), 'utf8');

  assert.match(platform, /Kolm Platform Architecture/);
  assert.match(platform, /behavior-to-artifact control plane/);
  assert.match(platform, /API behavior in\. Device-fit models out\./);
  assert.match(platform, /17 API data channel families/);
  assert.match(platform, /12 ingress modes/);
  assert.match(platform, /10 export modes/);
  assert.match(platform, /8 governance stages/);
  assert.match(platform, /Unknown schemas stay opaque/);
  assert.match(platform, /Every write emits an audit event/);
  assert.match(platform, /Readiness-gated claims/);

  assert.doesNotMatch(platform, /Run the free scan/i);
  assert.doesNotMatch(platform, /Start an audit/i);
  assert.doesNotMatch(platform, /AI Audit Platform/i);
  assert.doesNotMatch(platform, /Logs to Signed Evidence/i);
  assert.doesNotMatch(platform, /Reviewed Attestation/);
  assert.doesNotMatch(platform, /\$750|\$25,000/);
  assert.doesNotMatch(platform, /co-signed/i);
  assert.doesNotMatch(platform, /SOC 2 Type II evidence/);
  assert.doesNotMatch(platform, /HIPAA-ready/);
  assert.doesNotMatch(platform, /FedRAMP Moderate roadmap/);
  assert.doesNotMatch(platform, /\u875c/);
});

test('capabilities page exposes lifecycle capabilities without stale audit SKUs', () => {
  const capabilities = fs.readFileSync(path.join('public', 'capabilities.html'), 'utf8');

  assert.match(capabilities, /Kolm Capabilities Matrix/);
  assert.match(capabilities, /Capabilities are lifecycle controls, not audit SKUs/);
  assert.match(capabilities, /API behavior in\. Device-fit models out\./);
  assert.match(capabilities, /<b>8<\/b> capability domains/);
  assert.match(capabilities, /<b>17<\/b> channel families/);
  assert.match(capabilities, /<b>12<\/b> ingress modes/);
  assert.match(capabilities, /<b>10<\/b> export modes/);
  assert.match(capabilities, /Every capability has input, control, output, proof/);
  assert.match(capabilities, /Readiness-gated claims/);

  assert.doesNotMatch(capabilities, /Run the free scan/i);
  assert.doesNotMatch(capabilities, /Ten audit surfaces/i);
  assert.doesNotMatch(capabilities, /One signed engine/i);
  assert.doesNotMatch(capabilities, /MCP Server Audit/i);
  assert.doesNotMatch(capabilities, /OSCAL/i);
  assert.doesNotMatch(capabilities, /\$750|\$10,000|\$15,000|\$999/);
  assert.doesNotMatch(capabilities, /Reviewed Attestation/);
  assert.doesNotMatch(capabilities, /co-signed/i);
  assert.doesNotMatch(capabilities, /SOC 2 Type II evidence/);
  assert.doesNotMatch(capabilities, /HIPAA-ready/);
  assert.doesNotMatch(capabilities, /FedRAMP Moderate roadmap/);
  assert.doesNotMatch(capabilities, /\u875c/);
});

test('why-kolm page exposes source-backed operator scorecard without public competitor copy', () => {
  const compare = fs.readFileSync(path.join('public', 'compare.html'), 'utf8');

  assert.match(compare, /Why Kolm: AI API Control Center, Compiler, and Proof Layer/);
  assert.match(compare, /One control loop from API behavior to signed proof/);
  assert.match(compare, /17<\/b> channel families/);
  assert.match(compare, /17<\/b> API data channels/);
  assert.match(compare, /id="operator-scorecard"/);
  assert.match(compare, /The buyer decision should be an operating checklist/);
  assert.match(compare, /Gateway and routing/);
  assert.match(compare, /Observability and evals/);
  assert.match(compare, /Closed-loop improvement/);
  assert.match(compare, /Training and serving/);
  assert.match(compare, /Security and GRC/);
  assert.match(compare, /Data and ops plane/);
  assert.match(compare, /closed_loop_improvement/);
  assert.match(compare, /observe-failures/);
  assert.match(compare, /compile-artifact/);
  assert.match(compare, /12 ingress modes/);
  assert.match(compare, /10 export modes/);
  assert.match(compare, /product requirement, not a benchmark claim/i);
  assert.match(compare, /API Control Center/);
  assert.match(compare, /Integration Fabric/);
  assert.match(compare, /Trust Path/);

  assert.doesNotMatch(compare, /better than every/i);
  assert.doesNotMatch(compare, /objectively better/i);
  assert.doesNotMatch(compare, /Run the free scan/i);
  assert.doesNotMatch(compare, /Verify a report/i);
  assert.doesNotMatch(compare, /SOC 2 Type II evidence/i);
  assert.doesNotMatch(compare, /HIPAA-ready/i);
  assert.doesNotMatch(compare, /FedRAMP Moderate/i);
  assert.doesNotMatch(compare, /\u875c/);
});

test('integrations page exposes source-to-proof integration fabric without overclaiming', () => {
  const integrations = fs.readFileSync(path.join('public', 'integrations.html'), 'utf8');

  assert.match(integrations, /Every API signal becomes governed proof/);
  assert.match(integrations, /API \/ data command fabric/);
  assert.match(integrations, /integration-switchboard/);
  assert.match(integrations, /kolm switchboard/);
  assert.match(integrations, /POST \/v1\/account\/api-control-center\/events/);
  assert.match(integrations, /adapter-manifests\/validate/);
  assert.match(integrations, /Governance packet/);
  assert.match(integrations, /Source-to-proof map/);
  assert.match(integrations, /operator workbench/);
  assert.match(integrations, /GET \/v1\/account\/api-control-center/);
  assert.match(integrations, /source-to-proof map/);
  assert.match(integrations, /workflow\/api/);
  assert.match(integrations, /catalog\/lineage/);
  assert.match(integrations, /Control fabric/);
  assert.match(integrations, /Workflow engines, OpenAPI assets, MCP tools/);
  assert.match(integrations, /Connectors, queues, topics, warehouses, lakehouses/);
  assert.match(integrations, /SIEM, GRC, incident, API inventory/);
  assert.match(integrations, /does not claim live certification/);
  assert.match(integrations, /opaque until adapter-proven/);

  assert.doesNotMatch(integrations, /Run the free scan/i);
  assert.doesNotMatch(integrations, /Start an audit/i);
  assert.doesNotMatch(integrations, /SOC 2 Type II evidence/i);
  assert.doesNotMatch(integrations, /HIPAA-ready/i);
  assert.doesNotMatch(integrations, /FedRAMP Moderate/i);
  assert.doesNotMatch(integrations, /better than every/i);
  assert.doesNotMatch(integrations, /100x/i);
});

test('docs page exposes API control contracts without stale audit module copy', () => {
  const docs = fs.readFileSync(path.join('public', 'docs.html'), 'utf8');

  assert.match(docs, /Kolm Developer Docs/);
  assert.match(docs, /Docs should show the product contract/);
  assert.match(docs, /API behavior in\. Device-fit models out\./);
  assert.match(docs, /<b>929<\/b> route inventory/);
  assert.match(docs, /<b>214<\/b> route groups/);
  assert.match(docs, /<b>17<\/b> data channel families/);
  assert.match(docs, /API Control Center/);
  assert.match(docs, /Every credible API data path in and out/);
  assert.match(docs, /Every dashboard control needs an API contract/);
  assert.match(docs, /Every write should leave an event/);
  assert.match(docs, /\/docs\/api/);
  assert.match(docs, /\/openapi\.json/);
  assert.match(docs, /\/docs\/api-routes\.json/);
  assert.match(docs, /\/account\/api-control-center/);

  assert.doesNotMatch(docs, /Audit module/i);
  assert.doesNotMatch(docs, /audit API still exists/i);
  assert.doesNotMatch(docs, /audit property/i);
  assert.doesNotMatch(docs, /Security-readiness audit/i);
  assert.doesNotMatch(docs, /Audit docs/i);
  assert.doesNotMatch(docs, /Local audit docs/i);
  assert.doesNotMatch(docs, /Run the free scan/i);
  assert.doesNotMatch(docs, /Verify a report/i);
  assert.doesNotMatch(docs, /SOC 2/i);
  assert.doesNotMatch(docs, /HIPAA-ready/i);
  assert.doesNotMatch(docs, /\u875c/);
});

test('generated API reference is an operating surface, not a route dump', () => {
  const api = fs.readFileSync(path.join('public', 'docs', 'api.html'), 'utf8');

  assert.match(api, /<title>API reference - kolm\.ai<\/title>/);
  assert.match(api, /<meta name="theme-color" content="#06080A">/);
  assert.match(api, /compiler-brand-hero\.png/);
  assert.match(api, /kolm-2026\.css/);
  assert.match(api, /compiler-site--paper api-reference-page/);
  assert.match(api, /data-design-reference="image-2"/);
  const apiHeader = api.match(/<header class="nav">[\s\S]*?<\/header>/)?.[0] || '';
  assert.match(apiHeader, />Solutions<\/a>/);
  assert.match(apiHeader, /href="\/docs" aria-current="page">Developers<\/a>/);
  assert.match(apiHeader, /href="\/pricing">Pricing<\/a>/);
  assert.match(apiHeader, /class="nav__icon" href="\/status" aria-label="System status"/);
  assert.match(apiHeader, /href="\/signup">Get API key/);
  assert.doesNotMatch(apiHeader, /site-nav|https:\/\/audit\.kolm\.ai|>Audit<\/a>/i);
  assert.match(api, /API operating reference/);
  assert.match(api, /API reference command center/);
  assert.match(api, /API command center/);
  assert.match(api, /Search Route Surface/);
  assert.match(api, /data-api-search-form/);
  assert.match(api, /data-api-search-status aria-live="polite"/);
  assert.match(api, /data-api-route data-route-status="reference-ready"/);
  assert.match(api, /data-route-search=/);
  assert.match(api, /data-api-live-only/);
  assert.match(api, /API operating proof surface/);
  assert.match(api, /source-to-proof API runbook/);
  assert.match(api, /POST \/v1\/signup/);
  assert.match(api, /POST \/v1\/route\/chat\/completions/);
  assert.match(api, /GET \/v1\/account\/api-control-center/);
  assert.match(api, /GET \/openapi\.json/);
  assert.match(api, /GET \/product-readiness-closeout\.json/);
  assert.match(api, /GET \/v1\/evidence\/readiness/);
  assert.match(api, /Show Reference-Ready Routes Only/);
  assert.match(api, /generated from source/);

  assert.doesNotMatch(api, /Start at <a href="\/api">\/api<\/a>/);
  assert.doesNotMatch(api, /onclick="document\.body\.setAttribute/);
  assert.doesNotMatch(api, /href="\/api"/);
  assert.doesNotMatch(api, /Audit module/i);
  assert.doesNotMatch(api, /SOC 2 Type II/i);
  assert.doesNotMatch(api, /HIPAA-ready/i);
});

test('research page exposes product lab without stale audit or competitor copy', () => {
  const research = fs.readFileSync(path.join('public', 'research.html'), 'utf8');

  assert.match(research, /Kolm Product Lab/);
  assert.match(research, /Evidence should ship as product, not decorate the website/);
  assert.match(research, /API behavior in\. Device-fit models out\./);
  assert.match(research, /<b>17<\/b> channel families/);
  assert.match(research, /<b>17<\/b> product clusters/);
  assert.match(research, /<b>11<\/b> product standards/);
  assert.match(research, /behavior-to-artifact product requirements/);
  assert.match(research, /Every public claim needs a product object/);
  assert.match(research, /Readiness-gated claims/);

  assert.doesNotMatch(research, /Agent Security Research/i);
  assert.doesNotMatch(research, /The Audit Method/i);
  assert.doesNotMatch(research, /prompt-injection battery/i);
  assert.doesNotMatch(research, /Audit verifier/i);
  assert.doesNotMatch(research, /Verify a report/i);
  assert.doesNotMatch(research, /Run the free scan/i);
  assert.doesNotMatch(research, /SOC 2/i);
  assert.doesNotMatch(research, /ISO 42001/i);
  assert.doesNotMatch(research, /NIST AI RMF/i);
  assert.doesNotMatch(research, /EU AI Act/i);
  assert.doesNotMatch(research, /OWASP/i);
  assert.doesNotMatch(research, /MITRE/i);
  assert.doesNotMatch(research, /\u875c/);
});

test('public compiler pages keep competitor research out of visible website copy', () => {
  const files = [
    'index.html',
    'compiler-product.html',
    'how-it-works.html',
    'docs.html',
    'pricing.html',
    'signup.html',
    'integrations.html',
    'compare.html',
    'runtimes.html',
    'enterprise.html',
    'platform.html',
    'capabilities.html',
    'research.html',
    'changelog.html',
    'contact.html',
    'security.html',
    'trust.html',
    'status.html',
  ];
  const forbidden = [
    /Pioneer/i,
    /Workato/i,
    /MuleSoft/i,
    /Airbyte/i,
    /Fivetran/i,
    /Confluent/i,
    /OpenLineage/i,
    /Akto/i,
    /Vanta/i,
    /Drata/i,
    /LangSmith/i,
    /Langfuse/i,
    /Braintrust/i,
    /competitor/i,
    /unicorn/i,
    /market map/i,
    /pitch deck/i,
    /honesty bible/i,
    /better-funded/i,
  ];

  for (const file of files) {
    const text = visibleText(fs.readFileSync(path.join('public', file), 'utf8'));
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${file} should not expose ${pattern} in visible public copy`);
    }
  }
});

test('changelog page exposes product release ledger without stale audit verifier copy', () => {
  const changelog = fs.readFileSync(path.join('public', 'changelog.html'), 'utf8');

  assert.match(changelog, /Kolm Product Release Ledger/);
  assert.match(changelog, /A changelog should show what changed and what is still gated/);
  assert.match(changelog, /API behavior in\. Device-fit models out\./);
  assert.match(changelog, /<b>8<\/b> product surfaces tracked/);
  assert.match(changelog, /<b>13<\/b> route tests/);
  assert.match(changelog, /<b>8<\/b> open readiness gates/);
  assert.match(changelog, /needs external partner/);
  assert.match(changelog, /needs live certification/);
  assert.match(changelog, /needs package release/);
  assert.match(changelog, /needs public benchmark data/);
  assert.match(changelog, /Readiness-gated claims/);

  assert.doesNotMatch(changelog, /Audit verifier/i);
  assert.doesNotMatch(changelog, /Verify a report/i);
  assert.doesNotMatch(changelog, /Agent Security Readiness/i);
  assert.doesNotMatch(changelog, /sample audit report/i);
  assert.doesNotMatch(changelog, /third-party pentest/i);
  assert.doesNotMatch(changelog, /SOC 2/i);
  assert.doesNotMatch(changelog, /\u875c/);
});

test('contact page routes implementation intake without stale audit packaging', () => {
  const contact = fs.readFileSync(path.join('public', 'contact.html'), 'utf8');

  assert.match(contact, /Kolm Implementation Intake/);
  assert.match(contact, /Bring one production AI\/API loop/);
  assert.match(contact, /API behavior in\. Device-fit models out\./);
  assert.match(contact, /Email Implementation Intake/);
  assert.match(contact, /dev@kolm\.ai/);
  assert.match(contact, /Readiness-gated claims/);
  assert.match(contact, /<b>8<\/b> open readiness gates/);
  assert.match(contact, /source, risk, gate, target, and export/);

  assert.doesNotMatch(contact, /Run a free scan/i);
  assert.doesNotMatch(contact, /Run the free scan/i);
  assert.doesNotMatch(contact, /Start an AI Security Audit/i);
  assert.doesNotMatch(contact, /Start an audit/i);
  assert.doesNotMatch(contact, /\$750/);
  assert.doesNotMatch(contact, /Reviewed Attestation/);
  assert.doesNotMatch(contact, /co-signed/i);
  assert.doesNotMatch(contact, /SOC 2 Type II evidence/);
  assert.doesNotMatch(contact, /HIPAA-ready/);
});

test('api control center UI exposes enterprise data-plane and improvement-loop controls', () => {
  const control = fs.readFileSync(path.join('public', 'account', 'api-control-center.html'), 'utf8');

  assert.match(control, /API Control Center - kolm\.ai/);
  assert.match(control, /One tenant-scoped console for AI API ingress, egress/);
  assert.match(control, /control-hero-shell/);
  assert.match(control, /control-hero__summary/);
  assert.match(control, /Source-to-proof API control plane visual/);
  assert.match(control, /workspace\/prod-ai-loop/);
  assert.match(control, /Every credible source/);
  assert.match(control, /Preview mode/);
  assert.match(control, /Full console visible\. Tenant writes stay locked\./);
  assert.match(control, /demoControlCenterPayload/);
  assert.match(control, /render\(demoControlCenterPayload\(\), \{/);
  assert.match(control, /previewControlIntakeResponse/);
  assert.match(control, /previewAdapterManifestResponse/);
  assert.match(control, /Preview receipt only/);
  assert.match(control, /Preview validation only/);
  assert.match(control, /type="password"/);
  assert.match(control, /Policy before interpretation/);
  assert.match(control, /Behavior becomes an artifact/);
  assert.match(control, /Proof leaves the dashboard/);
  assert.match(control, /Read API Contract/);
  assert.match(control, /View Readiness Gates/);
  assert.match(control, /API data channel matrix/);
  assert.match(control, /Collection and export modes/);
  assert.match(control, /First-class control objects/);
  assert.match(control, /Adapter confidence states/);
  assert.match(control, /Adapter evidence/);
  assert.match(control, /Promote semantics only when a manifest proves them/);
  assert.match(control, /\/v1\/account\/api-control-center\/adapter-manifests\/validate/);
  assert.match(control, /live adapter manifest validator/);
  assert.match(control, /data-control-adapter-form/);
  assert.match(control, /data-control-adapter-result/);
  assert.match(control, /Validate Manifest/);
  assert.match(control, /renderAdapterManifestWorkbench/);
  assert.match(control, /renderAdapterManifestResult/);
  assert.match(control, /setupAdapterManifest/);
  assert.match(control, /Event envelope/);
  assert.match(control, /Egress destination recipes/);
  assert.match(control, /Readiness scoreboard/);
  assert.match(control, /Universal intake/);
  assert.match(control, /Every source enters as a governed event/);
  assert.match(control, /\/v1\/account\/api-control-center\/events/);
  assert.match(control, /live canonical event workbench/);
  assert.match(control, /data-control-intake-form/);
  assert.match(control, /data-control-intake-result/);
  assert.match(control, /Send Control Event/);
  assert.match(control, /Source ID/);
  assert.match(control, /Channel family/);
  assert.match(control, /Payload JSON/);
  assert.match(control, /renderControlIntakeResult/);
  assert.match(control, /setupControlIntake/);
  assert.match(control, /secret_values_included: false/);
  assert.match(control, /Operational contract/);
  assert.match(control, /Closed-loop improvement/);
  assert.match(control, /Failure to artifact/);
  assert.match(control, /Promotion gates/);
  assert.match(control, /Operator workbench/);
  assert.match(control, /Source-to-proof runbook/);
  assert.match(control, /High-priority intake/);
  assert.match(control, /Proof exports/);
  assert.match(control, /renderLoopStep/);
  assert.match(control, /renderWorkbench/);
  assert.match(control, /renderObjectGroup/);
  assert.match(control, /renderAdapterState/);
  assert.match(control, /adapter-owned field mapping/);
  assert.match(control, /unknown fields stay opaque/);
  assert.match(control, /renderEnvelope/);
  assert.match(control, /renderUniversalIntake/);
  assert.match(control, /renderEgressRecipe/);
  assert.match(control, /renderReadinessItem/);
  assert.match(control, /semantic claim:/);
  assert.match(control, /Canonical event envelope/);
  assert.match(control, /Required declaration/);
  assert.match(control, /Evidence:/);
  assert.match(control, /Gate:/);
  assert.match(control, /Data channels/);
  assert.match(control, /Filter API data channels/);
  assert.match(control, /\['ingress', 'Ingress'\]/);
  assert.match(control, /applyChannelFilter/);
  assert.match(control, /Integration map/);
  assert.match(control, /Policy layers/);
  assert.match(control, /Enterprise controls/);
  assert.match(control, /Differentiators/);
  assert.match(control, /fetch\('\/v1\/account\/api-control-center'/);

  assert.doesNotMatch(control, /Run the free scan/i);
  assert.doesNotMatch(control, /Verify a report/i);
  assert.doesNotMatch(control, /SOC 2 Type II evidence/i);
  assert.doesNotMatch(control, /HIPAA-ready/i);
  assert.doesNotMatch(control, /FedRAMP Moderate/i);
  assert.doesNotMatch(control, /\u875c/);
});

test('pricing page mirrors compiler plan catalog without stale audit packaging', () => {
  const pricing = fs.readFileSync(path.join('public', 'pricing.html'), 'utf8');

  assert.match(pricing, /Kolm Compiler Pricing/);
  assert.match(pricing, /Price the controlled loop, not generic AI seats/);
  assert.match(pricing, /API behavior in\. Device-fit models out\./);
  assert.match(pricing, /Workload Estimator/);
  assert.match(pricing, /Price the source-to-proof loop before procurement does/);
  assert.match(pricing, /data-pricing-estimator/);
  assert.match(pricing, /data-estimate-result/);
  assert.match(pricing, /Gateway calls \/ month/);
  assert.match(pricing, /Compile credits \/ month/);
  assert.match(pricing, /Control profile/);
  assert.match(pricing, /Private deployment/);
  assert.match(pricing, /SSO \/ SCIM required/);
  assert.match(pricing, /recommended plan/);
  assert.match(pricing, /\/v1\/pricing\/estimate/);
  assert.match(pricing, /compiler-brand-hero\.png/);
  assert.match(pricing, /6<\/b> catalog tiers/);
  assert.match(pricing, /25M<\/b> Business gateway calls/);
  assert.match(pricing, /200<\/b> Business compile credits/);
  assert.match(pricing, /17%<\/b> annual savings/);
  assert.match(pricing, /\$0\/mo/);
  assert.match(pricing, /\$29\/mo/);
  assert.match(pricing, /\$49\/mo/);
  assert.match(pricing, /\$99\/mo/);
  assert.match(pricing, /\$499\/mo/);
  assert.match(pricing, /Custom/);
  assert.match(pricing, /50K/);
  assert.match(pricing, /500K/);
  assert.match(pricing, /5M/);
  assert.match(pricing, /250M/);
  assert.match(pricing, /\/signup\?plan=indie/);
  assert.match(pricing, /\/signup\?plan=pro/);
  assert.match(pricing, /\/signup\?plan=teams/);
  assert.match(pricing, /\/signup\?plan=business/);
  assert.match(pricing, /\/v1\/plans/);
  assert.match(pricing, /\/v1\/billing\/tiers/);
  assert.match(pricing, /\/v1\/account\/api-control-center/);

  assert.doesNotMatch(pricing, /Audit module/i);
  assert.doesNotMatch(pricing, /signed audit reports/i);
  assert.doesNotMatch(pricing, /audit pricing/i);
  assert.doesNotMatch(pricing, /Run the free scan/i);
  assert.doesNotMatch(pricing, /Verify a report/i);
  assert.doesNotMatch(pricing, /SOC 2/i);
  assert.doesNotMatch(pricing, /HIPAA-ready/i);
  assert.doesNotMatch(pricing, /FedRAMP/i);
  assert.doesNotMatch(pricing, /Reviewed Attestation/i);
  assert.doesNotMatch(pricing, /co-signed/i);
  assert.doesNotMatch(pricing, /\$750|\$10,000|\$15,000|\$999/);
  assert.doesNotMatch(pricing, /private beta/i);
  assert.doesNotMatch(pricing, /Request access/i);
  assert.doesNotMatch(pricing, /\u875c/);
});

test('signup page exposes workspace onboarding without stale audit packaging', () => {
  const signup = fs.readFileSync(path.join('public', 'signup.html'), 'utf8');

  assert.match(signup, /Kolm Workspace Setup/);
  assert.match(signup, /Create the workspace that controls one AI\/API loop/);
  assert.match(signup, /API behavior in\. Device-fit models out\./);
  assert.match(signup, /API Control Center/);
  assert.match(signup, /17<\/b> data channel families/);
  assert.match(signup, /8<\/b> readiness gates visible/);
  assert.match(signup, /id="form-card"/);
  assert.match(signup, /id="done-card"/);
  assert.match(signup, /id="email"/);
  assert.match(signup, /id="apikey"/);
  assert.match(signup, /id="snippet"/);
  assert.match(signup, /id="plan-note"/);
  assert.match(signup, /id="workspace-status"/);
  assert.match(signup, /id="billing-link"/);
  assert.match(signup, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(signup, /payload\.plan=selectedPlan/);
  assert.match(signup, /pending billing/);
  assert.match(signup, /Continue to Checkout/);
  assert.match(signup, /fetch\('\/v1\/signup'/);
  assert.match(signup, /\/account\/api-control-center/);
  assert.match(signup, /\/docs\/api/);

  assert.doesNotMatch(signup, /Audit module/i);
  assert.doesNotMatch(signup, /Run a free scan/i);
  assert.doesNotMatch(signup, /Run the free scan/i);
  assert.doesNotMatch(signup, /Verify artifacts/i);
  assert.doesNotMatch(signup, /Trust center/i);
  assert.doesNotMatch(signup, /SOC 2/i);
  assert.doesNotMatch(signup, /HIPAA-ready/i);
  assert.doesNotMatch(signup, /Create account/i);
  assert.doesNotMatch(signup, /\u875c/);
});

test('node SDK package presents the current kolm brand', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join('sdk', 'node', 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join('sdk', 'node', 'README.md'), 'utf8');
  const esm = fs.readFileSync(path.join('sdk', 'node', 'index.mjs'), 'utf8');
  const cjs = fs.readFileSync(path.join('sdk', 'node', 'index.cjs'), 'utf8');

  assert.equal(pkg.name, '@kolm/kolm-sdk');
  assert.equal(pkg.homepage, 'https://kolm.ai');
  assert.equal(pkg.repository.url, 'git+https://github.com/kolm-ai/kolm.git');
  assert.match(readme, /KOLM_API_KEY/);
  assert.match(esm, /const DEFAULT_BASE = "https:\/\/kolm\.ai"/);
  assert.match(cjs, /const DEFAULT_BASE = "https:\/\/kolm\.ai"/);
});

test('public site routes, sitemap URLs, and referenced assets resolve', async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = path.join(os.tmpdir(), `kolm-site-${process.pid}-${Date.now()}`);

  rmSyncBestEffort(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  // after() is LIFO. Registered first ??fires SECOND (after kill releases sqlite/log handles).
  t.after(() => rmSyncBestEffort(dataDir));

  const child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DEFAULT_TENANT: 'site-test',
      ANTHROPIC_API_KEY: '',
      KOLM_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', data => process.stderr.write(data));
  t.after(() => killAndWait(child));

  await waitForHealth(base);

  const failures = [];
  for (const ref of [...collectInternalReferences(), '/ready']) {
    const res = await fetch(base + ref, { redirect: 'manual' });
    if (AUDIT_HOST_ONLY_ROUTES.includes(ref) && res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') || '';
      if (!location.startsWith('https://audit.kolm.ai/')) failures.push(`${ref}: audit redirect location ${location || '(empty)'}`);
      continue;
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') || '';
      if (location.startsWith('/')) {
        const followed = await fetch(base + location, { redirect: 'manual' });
        if (followed.status >= 400) failures.push(`${ref}: ${res.status} -> ${location}: ${followed.status}`);
        continue;
      }
    }
    if (res.status >= 400) failures.push(`${ref}: ${res.status}`);
  }

  for (const route of COMPILER_PRODUCT_ROUTES) {
    const product = await fetch(base + route, { redirect: 'manual' });
    assert.equal(product.status, 200, `${route} should render the main compiler product page`);
    assert.match(await product.text(), /API behavior in\. Device-fit models out\./);
  }

  const trust = await fetch(base + '/trust', { redirect: 'manual' });
  assert.equal(trust.status, 200, '/trust should render the product readiness center');
  const trustHtml = await trust.text();
  assert.match(trustHtml, /Product Readiness and Evidence Center/);
  assert.match(trustHtml, /<b>8<\/b> open readiness gates/);

  const security = await fetch(base + '/security', { redirect: 'manual' });
  assert.equal(security.status, 200, '/security should render the security and control posture page');
  const securityHtml = await security.text();
  assert.match(securityHtml, /Kolm Security and Control Posture/);
  assert.match(securityHtml, /Security starts at the API boundary/);
  assert.match(securityHtml, /Certification and Package Gates/);

  const enterprise = await fetch(base + '/enterprise', { redirect: 'manual' });
  assert.equal(enterprise.status, 200, '/enterprise should render the enterprise control center');
  const enterpriseHtml = await enterprise.text();
  assert.match(enterpriseHtml, /Kolm Enterprise Control Center/);
  assert.match(enterpriseHtml, /Enterprise AI control starts before a model ships/);
  assert.match(enterpriseHtml, /17 API data channel families/);

  const contact = await fetch(base + '/contact', { redirect: 'manual' });
  assert.equal(contact.status, 200, '/contact should render the implementation intake page');
  const contactHtml = await contact.text();
  assert.match(contactHtml, /Kolm Implementation Intake/);
  assert.match(contactHtml, /Bring one production AI\/API loop/);
  assert.match(contactHtml, /Email Implementation Intake/);

  const platform = await fetch(base + '/platform', { redirect: 'manual' });
  assert.equal(platform.status, 200, '/platform should render the platform architecture page');
  const platformHtml = await platform.text();
  assert.match(platformHtml, /Kolm Platform Architecture/);
  assert.match(platformHtml, /behavior-to-artifact control plane/);
  assert.match(platformHtml, /Every write emits an audit event/);

  const capabilities = await fetch(base + '/capabilities', { redirect: 'manual' });
  assert.equal(capabilities.status, 200, '/capabilities should render the capabilities matrix page');
  const capabilitiesHtml = await capabilities.text();
  assert.match(capabilitiesHtml, /Kolm Capabilities Matrix/);
  assert.match(capabilitiesHtml, /Capabilities are lifecycle controls, not audit SKUs/);
  assert.match(capabilitiesHtml, /Every capability has input, control, output, proof/);

  const pricing = await fetch(base + '/pricing', { redirect: 'manual' });
  assert.equal(pricing.status, 200, '/pricing should render the compiler pricing plan catalog');
  const pricingHtml = await pricing.text();
  assert.match(pricingHtml, /Kolm Compiler Pricing/);
  assert.match(pricingHtml, /Price the controlled loop, not generic AI seats/);
  assert.match(pricingHtml, /\$499\/mo/);
  assert.match(pricingHtml, /\/signup\?plan=pro/);
  assert.match(pricingHtml, /\/v1\/plans/);

  const docs = await fetch(base + '/docs', { redirect: 'manual' });
  assert.equal(docs.status, 200, '/docs should render the developer docs page');
  const docsHtml = await docs.text();
  assert.match(docsHtml, /Kolm Developer Docs/);
  assert.match(docsHtml, /Docs should show the product contract/);
  assert.match(docsHtml, /Every credible API data path in and out/);
  assert.match(docsHtml, /\/docs\/api/);

  const research = await fetch(base + '/research', { redirect: 'manual' });
  assert.equal(research.status, 200, '/research should render the product lab');
  const researchHtml = await research.text();
  assert.match(researchHtml, /Kolm Product Lab/);
  assert.match(researchHtml, /Evidence should ship as product/);

  const changelog = await fetch(base + '/changelog', { redirect: 'manual' });
  assert.equal(changelog.status, 200, '/changelog should render the product release ledger');
  const changelogHtml = await changelog.text();
  assert.match(changelogHtml, /Kolm Product Release Ledger/);
  assert.match(changelogHtml, /what changed and what is still gated/);

  const signup = await fetch(base + '/signup', { redirect: 'manual' });
  assert.equal(signup.status, 200, '/signup should render the workspace setup page');
  const signupHtml = await signup.text();
  assert.match(signupHtml, /Kolm Workspace Setup/);
  assert.match(signupHtml, /Create the workspace that controls one AI\/API loop/);
  assert.match(signupHtml, /Create Workspace/);
  assert.match(signupHtml, /fetch\('\/v1\/signup'/);

  const compatRedirects = new Map([
    ['/product', '/compiler-product'],
    ['/models', '/platform'],
    ['/api', '/docs/api'],
    ['/api-routes.json', '/docs/api-routes.json'],
    ['/quickstart', '/docs#quickstart'],
    ['/captures', '/compiler-product#pipeline'],
    ['/training', '/compiler-product#pipeline'],
    ['/distill', '/compiler-product#pipeline'],
    ['/tui', '/account/overview'],
    ['/control-center', '/account/api-control-center'],
    ['/api-control-center', '/account/api-control-center'],
    ['/enterprise-control', '/account/api-control-center'],
    ['/self-host', '/security'],
    ['/airgap', '/security'],
  ]);
  for (const [source, destination] of compatRedirects) {
    const res = await fetch(base + source, { redirect: 'manual' });
    assert.equal(res.status, 302, `${source} should redirect to the canonical compiler surface`);
    assert.equal(res.headers.get('location'), destination);
  }

  const openapi = await fetch(base + '/openapi.json', { redirect: 'manual' });
  assert.equal(openapi.status, 200, '/openapi.json should serve the generated OpenAPI JSON, not redirect to docs');
  assert.match(openapi.headers.get('content-type') || '', /json/);
  assert.match((await openapi.json()).openapi || '', /^3\./);

  const auditOnly = await fetch(base + '/checks', { redirect: 'manual' });
  assert.equal(auditOnly.status, 302, '/checks should move off the main compiler domain');
  assert.equal(auditOnly.headers.get('location'), 'https://audit.kolm.ai/checks');

  assert.deepEqual(failures, []);
});

test('sitemap includes indexable product/docs/article routes only', () => {
  const sitemap = fs.readFileSync(path.join('public', 'sitemap.xml'), 'utf8');
  const robots = fs.readFileSync(path.join('public', 'robots.txt'), 'utf8');
  const urls = [...sitemap.matchAll(/<loc>https:\/\/kolm\.ai([^<]+)<\/loc>/g)]
    .map(match => match[1])
    .sort();
  const urlSet = new Set(urls);

  const missing = REQUIRED_SITEMAP_ROUTES.filter(route => !urlSet.has(route));
  assert.deepEqual(missing, []);

  const forbiddenPresent = FORBIDDEN_SITEMAP_ROUTES.filter(route => urlSet.has(route));
  assert.deepEqual(forbiddenPresent, [], 'deleted W224 routes must not reappear in sitemap');

  const disallowed = robots.split(/\r?\n/)
    .map(line => line.match(/^Disallow:\s*(\S+)/))
    .filter(Boolean)
    .map(match => match[1]);
  const blockedInSitemap = urls.filter(url =>
    disallowed.some(rule => rule !== '/' && (url === rule || url.startsWith(rule.endsWith('/') ? rule : rule + '/')))
  );

  assert.deepEqual(blockedInSitemap, []);
});

test('vercel routing keeps compiler pages primary and audit pages on audit host', () => {
  const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  const hasHost = (rule, host) => (rule.has || []).some(entry => entry.type === 'host' && entry.value === host);
  const firstRewrite = source => config.rewrites.find(rule => rule.source === source && !rule.has);

  assert.equal(firstRewrite('/platform')?.destination, '/platform.html');
  assert.equal(firstRewrite('/capabilities')?.destination, '/capabilities.html');
  assert.equal(firstRewrite('/research')?.destination, '/research.html');
  assert.equal(firstRewrite('/changelog')?.destination, '/changelog.html');
  assert.equal(firstRewrite('/integrations')?.destination, '/integrations.html');
  assert.equal(firstRewrite('/runtimes')?.destination, '/runtimes.html');
  assert.equal(firstRewrite('/security')?.destination, '/security.html');
  assert.equal(firstRewrite('/trust')?.destination, '/trust.html');
  assert.equal(firstRewrite('/enterprise')?.destination, '/enterprise.html');
  assert.equal(firstRewrite('/contact')?.destination, '/contact.html');
  assert.equal(firstRewrite('/terms')?.destination, '/compiler-terms.html');
  assert.ok(!config.redirects.some(rule => rule.source === '/openapi.json'), '/openapi.json must be served as static JSON');
  assert.ok(!config.redirects.some(rule => rule.source === '/integrations' && rule.destination === '/docs'), '/integrations must be a product page, not a docs redirect');
  assert.ok(!config.redirects.some(rule => rule.source === '/runtimes' && rule.destination === '/platform'), '/runtimes must be a product page, not a platform redirect');
  assert.ok(!config.rewrites.some(rule => rule.source === '/security' && rule.destination === '/compiler-product.html'), '/security must be a security posture page, not a compiler-product alias');
  assert.ok(!config.rewrites.some(rule => rule.source === '/trust' && rule.destination === '/compiler-product.html'), '/trust must be a readiness center, not a compiler-product alias');
  assert.ok(!config.rewrites.some(rule => rule.source === '/enterprise' && rule.destination === '/compiler-product.html'), '/enterprise must be an enterprise control center, not a compiler-product alias');
  assert.ok(!config.rewrites.some(rule => rule.source === '/contact' && rule.destination === '/compiler-product.html'), '/contact must be an implementation intake page, not a compiler-product alias');
  assert.ok(!config.rewrites.some(rule => rule.source === '/platform' && rule.destination === '/compiler-product.html'), '/platform must be a platform architecture page, not a compiler-product alias');
  assert.ok(!config.rewrites.some(rule => rule.source === '/capabilities' && rule.destination === '/compiler-product.html'), '/capabilities must be a capabilities matrix page, not a compiler-product alias');
  assert.ok(!config.rewrites.some(rule => rule.source === '/research' && rule.destination === '/compiler-product.html'), '/research must be a product lab, not a compiler-product alias');
  assert.ok(!config.rewrites.some(rule => rule.source === '/changelog' && rule.destination === '/compiler-product.html'), '/changelog must be a product release ledger, not a compiler-product alias');
  assert.ok(config.redirects.some(rule =>
    rule.source === '/api' &&
    rule.destination === '/docs/api'
  ));
  assert.ok(config.redirects.some(rule =>
    rule.source === '/api-routes.json' &&
    rule.destination === '/docs/api-routes.json'
  ));
  assert.ok(config.redirects.some(rule =>
    rule.source === '/product' &&
    rule.destination === '/compiler-product'
  ));
  assert.ok(config.redirects.some(rule =>
    rule.source === '/control-center' &&
    rule.destination === '/account/api-control-center'
  ));
  assert.ok(config.redirects.some(rule =>
    rule.source === '/api-control-center' &&
    rule.destination === '/account/api-control-center'
  ));
  assert.ok(config.redirects.some(rule =>
    rule.source === '/enterprise-control' &&
    rule.destination === '/account/api-control-center'
  ));

  assert.ok(config.redirects.some(rule =>
    rule.source === '/:compilerPath(how-it-works|platform|capabilities|enterprise|security|trust|contact|research|changelog).html' &&
    rule.destination === '/:compilerPath' &&
    hasHost(rule, 'kolm.ai')
  ));
  assert.ok(config.redirects.some(rule =>
    rule.source === '/terms.html' &&
    rule.destination === '/terms' &&
    hasHost(rule, 'kolm.ai')
  ));
  assert.ok(config.redirects.some(rule =>
    rule.source === '/:auditPath(verify|checks|report|report-viewer|badge|roi|regulatory-clock|transparency-log|trust-center|buyer|spec).html' &&
    rule.destination === 'https://audit.kolm.ai/:auditPath.html' &&
    hasHost(rule, 'kolm.ai')
  ));
  assert.ok(config.rewrites.some(rule =>
    rule.source === '/platform' &&
    rule.destination === '/platform.html' &&
    hasHost(rule, 'audit.kolm.ai')
  ));
});
