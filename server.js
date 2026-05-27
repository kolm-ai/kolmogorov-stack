import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRouter } from './src/router.js';
import { provisionTenant } from './src/auth.js';
import { isProductionRuntime } from './src/env.js';
import { init as initOtel, expressMiddleware as otelMiddleware } from './src/otel.js';
import { initSentry } from './src/sentry-init.js';
import { synthesize } from './src/synthesis.js';
import { createConcept, publishVersion } from './src/registry.js';
import { all } from './src/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable('x-powered-by');
// Two-hop proxy chain in prod: Client → Vercel CDN → Railway edge → Express.
// `trust proxy: 2` makes express read X-Forwarded-For from the right hop so
// the rate-limit keyGenerator sees the real client IP, not Railway's edge IP.
app.set('trust proxy', isProductionRuntime() ? 2 : false);

const cspConnectSrc = [
  "'self'",
  'https://api.anthropic.com',
  'https://kolm.ai',
  'https://*.vercel-insights.com',
  'https://api.stripe.com',
];
for (const origin of String(process.env.KOLM_CSP_CONNECT_SRC || '').split(',')) {
  const trimmed = origin.trim();
  if (trimmed && !cspConnectSrc.includes(trimmed)) cspConnectSrc.push(trimmed);
}

// Security headers (S3, S4) — mounted BEFORE express.static so static
// assets get HSTS, CSP, nosniff, etc. CSP allows 'unsafe-inline' for now
// because every page still has inline <script> blocks; Sprint 1 moves
// inline scripts to /js/<page>.js and tightens CSP. 'wasm-unsafe-eval' is
// required by the on-device runtime (wllama, sqlite-vec).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", 'https://js.stripe.com', 'https://*.vercel-insights.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      connectSrc: cspConnectSrc,
      frameSrc: ['https://js.stripe.com'],
      workerSrc: ["'self'", 'blob:'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'deny' },
  noSniff: true,
}));

// gzip everything except SSE streams (compression breaks event delivery).
app.use(compression({ filter: (req, res) => res.getHeader('Content-Type') !== 'text/event-stream' && compression.filter(req, res) }));
app.use(cookieParser());
// Stripe webhook signature verification needs the raw request body — JSON
// reparse reorders keys and breaks the HMAC. Mount express.raw() for the
// webhook route ahead of express.json() so req.body is a Buffer there only.
app.use((req, res, next) => {
  if (req.path === '/v1/stripe/webhook') {
    return express.raw({ type: '*/*', limit: '4mb' })(req, res, next);
  }
  return express.json({ limit: '4mb' })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));
if (initOtel()) app.use(otelMiddleware());

// /articles serves the index page directly (no 301 redirect) — must come
// BEFORE express.static so the static directory-redirect doesn't fire.
app.get('/articles', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'articles', 'index.html'));
});

// /use-cases serves the index page directly. Same reasoning — public/use-cases/
// exists as a directory, so express.static would 301-redirect /use-cases to
// /use-cases/. Pre-empt with an explicit handler.
app.get('/use-cases', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'use-cases', 'index.html'));
});

// Explicit /docs handler — serves the docs hub HTML before express.static
// can 301-redirect /docs to /docs/ (directory listing) since public/docs/
// exists as the spec-asset folder.
app.get('/docs', (_req, res) => {
  const f = path.join(__dirname, 'public', 'docs.html');
  if (fs.existsSync(f)) {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return res.sendFile(f);
  }
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// /cookbook is a W224 cut. The canonical destination is /docs (per CUTS dict
// in tests/wave224-slop-cut.test.js). vercel.json declares the 301; here we
// mirror it so self-host / direct-server.js paths follow the same contract.
// Tests fetch with redirect:'follow' so the 301 resolves to /docs (200).
app.get('/cookbook', (_req, res) => {
  res.redirect(301, '/docs');
});

// /registry — same trick. public/registry/ exists (submit.html), so without
// an explicit pre-static handler express.static fires a 301 to /registry/.
// /atlas alias maps onto registry.html as well.
for (const url of ['/registry', '/atlas']) {
  app.get(url, (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'registry.html'));
  });
}

// /community + /device-transfer — same dir-collision pattern. public/community/
// holds bootstrap copy (devto-article, discord-bootstrap, hn-launch) and
// public/device-transfer/ holds device-specific guides (browser-wasm, iphone,
// jetson). Without these explicit handlers express.static 301-redirects to the
// trailing-slash form and then 404s since neither directory has an index.html.
app.get('/community', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'community.html'));
});
app.get('/device-transfer', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'device-transfer.html'));
});

// Same dir-collision pattern for the rest of the top-level surfaces whose
// names also exist as directories under public/ (marketplace/, foundations/,
// benchmarks/, healthcare/, finance/, legal/, enterprise/, migrate/,
// research/, security/, compare/, training/, quickstart/). Without an
// explicit pre-static handler, express.static 301-redirects /<name> to
// /<name>/ and then 404s because no <name>/index.html exists. Vercel handles
// this in prod via vercel.json rewrites; this loop keeps Railway-direct and
// local self-host serving the same set of routes.
const DIR_COLLISION_PAGES = [
  'marketplace', 'foundations', 'benchmarks', 'healthcare', 'finance', 'legal',
  'enterprise', 'migrate', 'research', 'security', 'compare', 'training',
  'quickstart',
];
for (const name of DIR_COLLISION_PAGES) {
  app.get('/' + name, (_req, res) => {
    const f = path.join(__dirname, 'public', name + '.html');
    if (fs.existsSync(f)) {
      res.set('Cache-Control', 'public, max-age=60, must-revalidate');
      return res.sendFile(f);
    }
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  });
}

// /docs/:lang i18n alias — vercel.json:152-157 rewrites /docs/{ja,zh,es,fr,de,ko}
// to /docs/i18n/{lang}.html. Mirror that here so Railway-direct and self-host
// serve the same set of translated docs. Whitelist the 6 shipped locales so an
// untranslated locale 404s cleanly instead of leaking the i18n folder layout.
const DOCS_I18N_LANGS = new Set(['ja', 'zh', 'es', 'fr', 'de', 'ko']);
app.get('/docs/:lang', (req, res, next) => {
  const lang = req.params.lang;
  if (!DOCS_I18N_LANGS.has(lang)) return next();
  const file = path.join(__dirname, 'public', 'docs', 'i18n', lang + '.html');
  if (fs.existsSync(file)) {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return res.sendFile(file);
  }
  next();
});

// RFC 9116 security.txt — serve from .well-known and as a top-level
// alias. express.static skips dot-directories on some hosts, so we serve
// explicitly to guarantee both URLs resolve.
const SECURITY_TXT = path.join(__dirname, 'public', '.well-known', 'security.txt');
for (const url of ['/.well-known/security.txt', '/security.txt']) {
  app.get(url, (_req, res) => {
    if (!fs.existsSync(SECURITY_TXT)) return res.status(404).type('text/plain').send('not found');
    res.type('text/plain; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(SECURITY_TXT);
  });
}

// vercel.json rewrites mirrored to server.js so Railway-direct + self-host
// serves the same routes the live Vercel deploy does. Each entry maps an
// externally-referenced path to a real on-disk asset. Mounted BEFORE
// express.static so directory-collision 301s don't fire.
//
// /account/audit       (vercel.json:1103) → public/account/audit-log.html
// /api-routes.json     (vercel.json:91-94) → public/openapi.json (canonical schema)
// /bench/leaderboard   (vercel.json:1971) → public/bench/leaderboard.json (JSON, not HTML)
// /security/hof        (vercel.json:197) → public/security.html (Hall of Fame folded in)
const VERCEL_MIRROR_REWRITES = [
  { url: '/account/audit', file: 'account/audit-log.html' },
  { url: '/api-routes.json', file: 'openapi.json' },
  { url: '/bench/leaderboard', file: 'bench/leaderboard.json' },
  { url: '/security/hof', file: 'security.html' },
  // W889-8.1 + 8.2 — vertical landing + /vs/ comparison aliases that need to
  // resolve on Railway-direct + self-host, not only via Vercel rewrites.
  { url: '/account/signup', file: 'signup.html' },
  { url: '/government', file: 'government.html' },
  { url: '/education', file: 'education.html' },
  { url: '/customer-support', file: 'customer-support.html' },
  { url: '/code-gen', file: 'code-gen.html' },
  { url: '/eu-sovereign', file: 'eu-sovereign.html' },
  { url: '/vs/openai', file: 'vs/openai.html' },
  { url: '/vs/fireworks', file: 'vs/fireworks.html' },
  { url: '/vs/openpipe', file: 'vs/openpipe.html' },
  { url: '/vs/self-built', file: 'vs/self-built.html' },
];
for (const { url, file } of VERCEL_MIRROR_REWRITES) {
  app.get(url, (_req, res) => {
    const f = path.join(__dirname, 'public', file);
    if (fs.existsSync(f)) {
      res.set('Cache-Control', 'public, max-age=60, must-revalidate');
      return res.sendFile(f);
    }
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  });
}

// Static dashboard with strong caching for hashed assets, weak for HTML.
// /sdk.js gets a versioned alias (S6) — the unversioned URL stays for
// back-compat but we encourage `/sdk-<sha>.js` for SRI-pinned imports.
app.use(express.static(path.join(__dirname, 'public'), {
  // extensions: ['html'] gives extensionless URL serving so /docs/observability,
  // /docs/runtime, /docs/sdk, /account/captures etc. resolve to their .html
  // siblings — matching the Vercel deploy behaviour where vercel.json:rewrites
  // does the same fallback. Without this, the bare server returns 404 for
  // every extensionless path that isn't explicitly listed in the SPA-route
  // table below.
  // redirect: false avoids the directory-collision 301 — when /docs/observability
  // exists as BOTH a directory AND .html, the default would 301 to /docs/observability/
  // and 404 (no index.html). Disabling the redirect lets the extensions fallback fire.
  extensions: ['html'],
  redirect: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    else if (/sdk-[a-f0-9]{8,}\.js$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // Images, fonts, and WASM rarely change between deploys — cache 1 day.
    else if (filePath.match(/\.(svg|png|jpg|jpeg|webp|gif|ico|woff2?|wasm)$/)) res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
    // CSS/JS change with deploys — 1 hour with revalidate keeps deploys fresh
    // while removing the 5-minute thrash that was hammering edge caches.
    else if (filePath.match(/\.(css|js|map)$/)) res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
  },
}));

// RS-1 schema bundle — canonical JSON Schemas + spec markdown live in /docs
// so the homepage anchors (/docs#rs-1, #manifest, #receipts) and direct
// schema fetches both work. We mount the directory at /docs-static so the
// /docs SPA route below can still own the HTML page; specific filenames
// are then aliased back into /docs/* via explicit routes.
const DOCS_DIR = path.join(__dirname, 'docs');
for (const name of ['manifest-v0.1.json', 'receipt-v0.1.json', 'rs-1.md']) {
  app.get('/docs/' + name, (_req, res) => {
    const file = path.join(DOCS_DIR, name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'spec asset not found' });
    if (name.endsWith('.json')) res.type('application/schema+json');
    else if (name.endsWith('.md')) res.type('text/markdown');
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(file);
  });
}

app.use('/', buildRouter());

// SPA fallback for HTML routes — every public page maps to a static file under /public.
// /compile, /run, /recall, /cloud, /manual, /mobile are the v5 (`kolm`) surfaces.
// Legacy v4 pages (/optimize, /audit, /why, /how-it-works, /economics, /spec,
// /receipts, /verified, /specialists) stay reachable until Sprint 1's kill-list
// pass — the static files still live in public/.
// Page aliases — same file serves multiple URLs.
//  /signin → public/signup.html (one page, two tabs)
//  /atlas  → public/registry.html (registry → atlas rename, /registry kept for back-compat)
const ROUTE_ALIASES = {
  '/signin': 'signup',
  '/atlas': 'registry',
  '/spec/grammar': 'spec-grammar',
  '/developers': 'build-your-own',
  '/solutions': 'use-cases/index',
  '/teams/accept': 'teams-accept',
  '/login': 'signup',
  // wave 104: parity with vercel.json alias rewrites.
  '/audit': 'audit-log',
  '/cli': 'quickstart',
  '/contact': 'community',
  '/insurance': 'insurance',
  // W403 added /datasets vercel rewrite to /docs/datasets.html. Mirror it here
  // so Railway-direct + self-host serve the same route.
  '/datasets': 'docs/datasets',
  // vercel.json:242-244 redirects /trust → /security; mirror so Railway-direct
  // resolves the 59 in-repo refs that still point at /trust (footers, CLI doc
  // shells). Map serves the security page directly to avoid a redirect hop.
  '/trust': 'security',
  // vercel.json:97-99 redirects /gateway → /capture; mirror.
  '/gateway': 'capture',
  // vercel.json:247-249 redirects /how-it-works → /quickstart (W705 redirect).
  // No how-it-works.html exists in /public — the destination is /quickstart.
  '/how-it-works': 'quickstart',
};
// /registry + /atlas are handled BEFORE express.static (see top of file) because
// public/registry/ exists as a subdirectory (submit.html).
for (const route of ['/', '/dashboard', '/playground', '/docs', '/signup', '/signin', '/login', '/why', '/pricing', '/status', '/account', '/how-it-works', '/device', '/compile', '/run', '/recall', '/cloud', '/k-score', '/benchmarks', '/compare', '/research', '/serve', '/evolve', '/anatomy', '/security', '/privacy', '/terms', '/healthcare', '/finance', '/legal', '/edge', '/cookbook', '/defense', '/manifesto', '/faq', '/quickstart', '/trust', '/integrations', '/press', '/vs-ollama', '/vs-rag', '/vs-fine-tune', '/vs-predibase', '/vs-openpipe', '/vs-langsmith', '/vs-mem0', '/vs-hindsight', '/vs-openai-fine-tune', '/vs-together', '/why-now', '/threat-model', '/roi', '/api', '/whitepaper', '/build-your-own', '/developers', '/solutions', '/audit-log', '/baa', '/captures', '/capture', '/enterprise', '/glossary', '/leaderboard', '/hub', '/spec', '/spec/grammar', '/models', '/compute', '/troubleshooting', '/teams', '/teams/accept', '/tunnels', '/byoc', '/airgap', '/showcase', '/sdks', '/compliance-packs', '/audit', '/cli', '/contact', '/insurance', '/health-insurance', '/distill', '/train', '/frontier-stack', '/license', '/datasets', '/gateway']) {
  app.get(route, (_req, res) => {
    const name = route === '/' ? 'index' : (ROUTE_ALIASES[route] || route.slice(1));
    const file = path.join(__dirname, 'public', name + '.html');
    if (fs.existsSync(file)) {
      res.set('Cache-Control', 'public, max-age=60, must-revalidate');
      return res.sendFile(file);
    }
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  });
}

// Extensionless use-case URLs: /use-cases/<slug> → public/use-cases/<slug>.html
app.get('/use-cases/:slug', (req, res, next) => {
  const slug = req.params.slug;
  if (!/^[a-z0-9-]+$/.test(slug)) return next();
  const file = path.join(__dirname, 'public', 'use-cases', slug + '.html');
  if (fs.existsSync(file)) {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return res.sendFile(file);
  }
  next();
});

// W889-8.3 — extensionless compile pair pages: /compile/<source>-to-<format> →
// public/compile/<slug>.html. Slugs include `.` and `_` (e.g. qwen2.5-7b-to-gguf-q4_k_m)
// so the validation regex is permissive but still anchored.
app.get('/compile/:slug', (req, res, next) => {
  const slug = req.params.slug;
  if (!/^[a-z0-9._-]+$/.test(slug)) return next();
  const file = path.join(__dirname, 'public', 'compile', slug + '.html');
  if (fs.existsSync(file)) {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return res.sendFile(file);
  }
  next();
});

// W889-8.4 — /book-demo → public/book-demo.html (mirrors vercel rewrite).
app.get('/book-demo', (req, res, next) => {
  const file = path.join(__dirname, 'public', 'book-demo.html');
  if (fs.existsSync(file)) {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return res.sendFile(file);
  }
  next();
});

// Extensionless integration URLs: /integrations/<slug> → public/integrations/<slug>.html
app.get('/integrations/:slug', (req, res, next) => {
  const slug = req.params.slug;
  if (!/^[a-z0-9-]+$/.test(slug)) return next();
  const file = path.join(__dirname, 'public', 'integrations', slug + '.html');
  if (fs.existsSync(file)) {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return res.sendFile(file);
  }
  next();
});

// Extensionless article URLs: /articles/<slug> → public/articles/<slug>.html
app.get('/articles/:slug', (req, res, next) => {
  const slug = req.params.slug;
  if (!/^[a-z0-9-]+$/.test(slug)) return next();
  const file = path.join(__dirname, 'public', 'articles', slug + '.html');
  if (fs.existsSync(file)) {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return res.sendFile(file);
  }
  next();
});

// Extensionless research-article URLs: /research/<slug> → public/research/<slug>.html
app.get('/research/:slug', (req, res, next) => {
  const slug = req.params.slug;
  if (!/^[a-z0-9-]+$/.test(slug)) return next();
  const file = path.join(__dirname, 'public', 'research', slug + '.html');
  if (fs.existsSync(file)) {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return res.sendFile(file);
  }
  next();
});

// /cookbook/<slug>: serves recipes from public/cookbook/<slug>.html if present.
// Vertical aliases (healthcare/finance/legal/edge) keep their canonical /<vertical> URLs;
// /cookbook/<vertical> serves the same file so either path works.
const COOKBOOK_VERTICALS = new Set(['healthcare', 'finance', 'legal', 'edge']);
app.get('/cookbook/:slug', (req, res, next) => {
  const slug = req.params.slug;
  if (!/^[a-z0-9-]+$/.test(slug)) return next();
  if (COOKBOOK_VERTICALS.has(slug)) {
    const file = path.join(__dirname, 'public', slug + '.html');
    if (fs.existsSync(file)) {
      res.set('Cache-Control', 'public, max-age=60, must-revalidate');
      return res.sendFile(file);
    }
  }
  const file = path.join(__dirname, 'public', 'cookbook', slug + '.html');
  if (fs.existsSync(file)) {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return res.sendFile(file);
  }
  next();
});

// Public receipt page: /r/:hash mirrors vercel.json:200 rewrite to /r.html?hash=:hash.
// Generic fallback below cannot handle this because the file lives at public/r.html
// (singular) and the param is consumed via query string by the page JS, not a
// nested file path.
app.get('/r/:hash', (req, res, next) => {
  const hash = req.params.hash;
  if (!/^[a-z0-9_-]+$/i.test(hash)) return next();
  const file = path.join(__dirname, 'public', 'r.html');
  if (fs.existsSync(file)) {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return res.sendFile(file);
  }
  next();
});

// Generic extensionless static fallback — mirrors Vercel's "try public/<path>.html"
// rewrite behavior so self-host / Docker / Railway-direct serves the same routes
// the live Vercel deploy does. Without this, the manual route list at L178 drifts
// behind every new vercel.json rewrite (e.g. /agents /train /why-kolm /docs/api
// /compare/* /case-studies/* /security/* /spec/* /benchmarks/*). Conservative: only
// matches GET requests for paths without an extension and rejects traversal (..).
app.get('*', (req, res, next) => {
  if (req.method !== 'GET') return next();
  const p = req.path;
  if (!p || p === '/' || p.startsWith('/v1') || p === '/health' || p === '/ready' || p.includes('..')) return next();
  if (/\.[a-z][a-z0-9]*$/i.test(p)) return next();
  const rel = p.slice(1);
  if (!/^[a-z0-9][a-z0-9_\-\/\.]*$/i.test(rel)) return next();
  const direct = path.join(__dirname, 'public', rel + '.html');
  if (fs.existsSync(direct)) {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return res.sendFile(direct);
  }
  const indexed = path.join(__dirname, 'public', rel, 'index.html');
  if (fs.existsSync(indexed)) {
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return res.sendFile(indexed);
  }
  next();
});

// 404 fallback for unknown HTML routes — branded page from /public/404.html if it exists.
const _404Path = path.join(__dirname, 'public', '404.html');
app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html') && !req.path.startsWith('/v1') && !req.path.startsWith('/health') && req.path !== '/ready' && req.path !== '/404') {
    if (fs.existsSync(_404Path)) return res.status(404).sendFile(_404Path);
    return res.status(404).type('html').send(`<!DOCTYPE html><html><head><title>404 · kolm</title><link rel="stylesheet" href="/styles.css"></head><body style="padding:48px;text-align:center;font-family:system-ui;color:#e8ecf3;background:#0a0b0e;min-height:100vh;"><h1 style="font-size:48px;margin:0;letter-spacing:-0.02em;">404</h1><p style="color:#8b94a8;margin-top:8px">That page doesn't exist.</p><p style="margin-top:24px;"><a href="/" style="color:#7dd3fc;">&larr; Home</a> &middot; <a href="/registry" style="color:#7dd3fc;">Registry</a> &middot; <a href="/docs" style="color:#7dd3fc;">Docs</a></p></body></html>`);
  }
  next();
});

// Generic 500 — catches any unhandled error in routes. Standardized shape:
// `{ error, detail?, error_id }` where `detail` is omitted in production to
// avoid leaking stack-tail strings or internal paths and `error_id` is a
// short opaque id the operator can grep for in logs and Sentry.
app.use((err, req, res, _next) => {
  // Short error id — 12 hex chars from a timestamped random source. Stable
  // for the lifetime of the response; surfaced to the client AND logged so
  // an operator can correlate the user's report with the server log/Sentry.
  const errorId = `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  console.error(`[500] error_id=${errorId} path=${req && req.path} method=${req && req.method}`, err);
  // W890-3 — every 500 is reported to Sentry with context (request path,
  // method, tenant if attached). No-op when SENTRY_DSN is unset.
  try {
    if (globalThis.__kolmSentry && typeof globalThis.__kolmSentry.captureException === 'function') {
      globalThis.__kolmSentry.captureException(err, {
        tags: { kind: 'http_500', method: req && req.method, error_id: errorId },
        extra: { path: req && req.path, query: req && req.query, tenant: req && req.tenant && req.tenant.id },
      });
    }
  } catch { /* deliberate: cleanup */ }
  if (req.accepts('html')) {
    const _500Path = path.join(__dirname, 'public', '500.html');
    if (fs.existsSync(_500Path)) {
      res.set('X-Kolm-Error-Id', errorId);
      return res.status(500).sendFile(_500Path);
    }
  }
  const body = { error: 'internal server error', error_id: errorId };
  if (process.env.NODE_ENV !== 'production' || process.env.KOLM_DEBUG) {
    body.detail = String(err.message || err);
  }
  res.set('X-Kolm-Error-Id', errorId);
  res.status(500).json(body);
});

const PORT = parseInt(process.env.PORT || '8787');

async function bootSeedDemoConcepts(tenant) {
  const dir = path.resolve('examples');
  if (!fs.existsSync(dir)) return { added: 0, skipped: 0 };
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const existing = new Set(all('concepts').filter(c => c.tenant === tenant).map(c => c.name));
  let added = 0, skipped = 0;
  for (const file of files) {
    try {
      const ex = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (existing.has(ex.name)) { skipped++; continue; }
      const r = await synthesize({ positives: ex.positives, negatives: ex.negatives || [], output_spec: ex.output_spec, priors: ex.priors || {} });
      if (!r.accepted) { skipped++; continue; }
      const concept = createConcept({
        name: ex.name, description: ex.description || ex.name, tenant,
        schema: ex.output_spec || null, tags: ex.tags || [], visibility: ex.visibility || 'public',
      });
      publishVersion({
        concept_id: concept.id, source: r.source,
        evaluation: { quality_score: r.quality_score, pass_rate_positive: r.pass_rate_positive, reject_rate_negative: r.reject_rate_negative, latency_p50_us: r.latency_p50_us, size_bytes: r.size_bytes, source_hash: r.source_hash, strategy: r.strategy, trace: r.test_trace },
        lineage: { synthesized_from_n: ex.positives.length + (ex.negatives?.length || 0), attempts_n: r.attempts_n },
      });
      added++;
    } catch { skipped++; }
  }
  return { added, skipped };
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  // Opt-in crash reporting. No-op when SENTRY_DSN is unset OR @sentry/node
  // is not installed in this deploy.
  const sentry = await initSentry();
  // Make the Sentry handle reachable from the 500 middleware below so the
  // generic error handler can capture context (request URL, status code,
  // tenant if known) before responding to the client.
  if (sentry) globalThis.__kolmSentry = sentry;

  // W890-3 — process-level guards. Every entry point registers BOTH handlers
  // before listen() so a stray throw or unhandled promise can't take the
  // server down without a structured trail. uncaughtException triggers a
  // graceful shutdown (drain in-flight requests via server.close()), while
  // unhandledRejection logs + reports without crashing — the same Node 20
  // default behaviour, but with Sentry context attached.
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[unhandledRejection]', reason);
    try {
      if (globalThis.__kolmSentry && typeof globalThis.__kolmSentry.captureException === 'function') {
        globalThis.__kolmSentry.captureException(reason, { tags: { kind: 'unhandledRejection' } });
      }
    } catch { /* deliberate: cleanup */ }
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
    try {
      if (globalThis.__kolmSentry && typeof globalThis.__kolmSentry.captureException === 'function') {
        globalThis.__kolmSentry.captureException(err, { tags: { kind: 'uncaughtException' } });
      }
    } catch { /* deliberate: cleanup */ }
    // Graceful shutdown: stop accepting new connections, let in-flight finish,
    // then exit. setTimeout fallback guarantees we don't hang on a stuck conn.
    try {
      if (globalThis.__kolmServer && typeof globalThis.__kolmServer.close === 'function') {
        globalThis.__kolmServer.close(() => process.exit(1));
        setTimeout(() => process.exit(1), 10_000).unref();
        return;
      }
    } catch { /* deliberate: cleanup */ }
    process.exit(1);
  });
  // SIGTERM / SIGINT — Railway sends SIGTERM on deploys; honour it by closing
  // the listening socket and exiting cleanly so we don't drop in-flight
  // requests on rolling restarts.
  const onSig = (sig) => () => {
    console.log(`[${sig}] graceful shutdown initiated`);
    try {
      if (globalThis.__kolmServer && typeof globalThis.__kolmServer.close === 'function') {
        globalThis.__kolmServer.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 10_000).unref();
        return;
      }
    } catch { /* deliberate: cleanup */ }
    process.exit(0);
  };
  process.on('SIGTERM', onSig('SIGTERM'));
  process.on('SIGINT', onSig('SIGINT'));

  // Auto-provision the demo tenant. Wrapped: if the durable store is
  // unrecoverable (corrupt JSON + EACCES on backup + EACCES on writes), we
  // STILL want the HTTP server to start so /health responds and operators
  // can introspect — auth-bearing routes degrade to 503 downstream rather
  // than crash-looping the whole container.
  const demoName = process.env.DEFAULT_TENANT || 'demo';
  let demo;
  try {
    demo = provisionTenant(demoName);
  } catch (err) {
    console.error('[boot] provisionTenant failed; continuing in degraded mode:', err && err.message);
    demo = { name: demoName, api_key: null, plan: 'free', degraded: true };
  }

  // Idempotent seed: synthesizes any missing example/*.json concepts.
  // Skip if we couldn't provision the tenant — seeding without a real
  // tenant row would write orphan concepts.
  if (!demo.degraded) {
    try {
      const { added, skipped } = await bootSeedDemoConcepts(demo.name);
      if (added > 0 || skipped > 0) console.log(`  seed: +${added} added, ${skipped} skipped`);
    } catch (err) {
      console.error('[boot] bootSeedDemoConcepts failed; continuing:', err && err.message);
    }
  } else {
    console.log('  seed: skipped (tenant provision degraded)');
  }

  // Stripe configuration sanity check. Counts how many of the 5 payment links
  // are wired so a misconfigured deploy logs a single line at boot rather than
  // surfacing as a 503 the first time a customer clicks Upgrade. Webhook secret
  // is required for paid plans to flip; surface the gap explicitly.
  const stripeLinks = [
    'STRIPE_PAYMENT_LINK_STARTER', 'STRIPE_PAYMENT_LINK_PRO',
    'STRIPE_PAYMENT_LINK_TEAMS', 'STRIPE_PAYMENT_LINK_BUSINESS',
    'STRIPE_PAYMENT_LINK_ENT',
  ];
  const stripePresent = stripeLinks.filter(v => !!process.env[v]).length;
  const webhookOk = !!process.env.STRIPE_WEBHOOK_SECRET;
  const stripeStatus = stripePresent === 5 && webhookOk ? 'wired' : `degraded (${stripePresent}/5 links, webhook ${webhookOk ? 'ok' : 'missing'})`;

  // W890-3 — keep a handle to the http.Server so graceful-shutdown hooks
  // above can call .close() and let in-flight requests drain on SIGTERM /
  // uncaughtException.
  const httpServer = app.listen(PORT, () => {
    console.log('\nkolm server');
    console.log(`  home:       http://localhost:${PORT}`);
    console.log(`  dashboard:  http://localhost:${PORT}/dashboard`);
    console.log(`  playground: http://localhost:${PORT}/playground`);
    console.log(`  docs:       http://localhost:${PORT}/docs`);
    console.log(`  demo key:   ${!!demo.api_key ? 'configured' : 'missing'}`);
    console.log(`  admin key:  ${!!process.env.ADMIN_KEY ? 'configured' : 'not set'}`);
    console.log(`  synthesis:  ${process.env.ANTHROPIC_API_KEY ? 'Claude (' + (process.env.ANTHROPIC_MODEL || 'claude-opus-4-7') + ') + Pattern' : 'Pattern (no API key set)'}`);
    console.log(`  stripe:     ${stripeStatus}`);
    console.log('');
  });
  globalThis.__kolmServer = httpServer;
}

export { app };
export default app;
