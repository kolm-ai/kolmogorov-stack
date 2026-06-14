#!/usr/bin/env node
// W400D - generate public/docs/api.html from real route definitions.
//
// Idempotent: re-running produces byte-identical output unless router.js changed.
// Single source of truth: do NOT hand-edit api.html. Re-run this script.
//
// What it does:
//   1. Reads src/router.js and mounted route modules end-to-end.
//   2. Parses r.<method>('<path>', ...) and router.<method>('<path>', ...) call sites (Express-style).
//   3. Pulls the 5 lines of comments immediately above each route.
//   4. Resolves the one for-loop array-literal expansion at line 1835.
//   5. Groups by /v1/<prefix> and sorts inside each group.
//   6. Writes public/docs/api-routes.json (manifest) + public/docs/api.html (rendered).
//
// Run: node scripts/build-api-ref.cjs

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Core route files always parsed.
const CORE_ROUTE_FILES = [
  { label: 'src/router.js', file: path.join(ROOT, 'src', 'router.js') },
  { label: 'src/oauth.js', file: path.join(ROOT, 'src', 'oauth.js') },
];

// Auto-discover every src/*-routes.js wave module (W821..W835 and beyond).
// router.js imports each via registerXxxRoutes(app) so they ship as real
// production routes and must appear in the API reference + OpenAPI spec.
const WAVE_MODULE_FILES = (() => {
  const out = [];
  try {
    const entries = fs.readdirSync(path.join(ROOT, 'src'));
    for (const name of entries) {
      if (!/-routes\.js$/.test(name)) continue;
      out.push({ label: 'src/' + name, file: path.join(ROOT, 'src', name) });
    }
  } catch (_) {} // deliberate: cleanup
  return out;
})();

const ROUTE_SOURCES = [...CORE_ROUTE_FILES, ...WAVE_MODULE_FILES.filter(
  (m) => !CORE_ROUTE_FILES.some((c) => c.file === m.file)
)];
const OUT_HTML = path.join(ROOT, 'public', 'docs', 'api.html');
const OUT_JSON = path.join(ROOT, 'public', 'docs', 'api-routes.json');

const TODAY = '2026-05-20';

// ----------------- 1. PARSE ROUTER.JS -----------------

function normalizeExpressRoutePath(routePath) {
  // Express supports `:id(*)` to capture a wildcard tail. Public API
  // contracts should expose the stable parameter name, not path-to-regexp
  // implementation syntax that OpenAPI cannot represent.
  return String(routePath).replace(/:([a-zA-Z_][a-zA-Z0-9_]*)\(\*\)/g, ':$1');
}

function extractRoutes(source, sourceLabel) {
  const lines = source.split('\n');
  const routes = [];

  // Regex for r.<method>('<path>', ...) — path must be a single-quoted or
  // double-quoted string literal that starts with /. Template-literal and
  // identifier paths are handled separately. Binding names: r, router, app
  // (wave-module register functions take `app` as their parameter; core
  // router uses `r`). Core route binding regex: (?:r|router)\.<method>.
  const literalRe = /^\s*(?:r|router|app)\.(get|post|put|delete|patch|all)\s*\(\s*(['"])(\/[^'"]*?)\2/;

  // Regex route literals for drop-in provider bases such as:
  //   r.post(/^\/v1\/capture\/anthropic(?:\/.*)?$/, ...)
  // These accept SDK-appended suffixes at runtime, but the public contract is
  // the stable base path documented in API refs and OpenAPI.
  const regexLiteralRe = /^\s*(?:r|router|app)\.(get|post|put|delete|patch|all)\s*\(\s*\/\^((?:\\\/[^\\/(]+)+)(?:\(\?:\\\/\.\*\)\?)?\$\/,/;

  // The one for-loop expansion: `for (const p of [...]) { r.post(p, ...) }`
  // We capture the array literal and emit one route per element.
  const variableRe = /^\s*(?:r|router|app)\.(get|post|put|delete|patch|all)\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,/;

  const unparseable = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lit = line.match(literalRe);
    if (lit) {
      const method = lit[1].toUpperCase();
      const routePath = normalizeExpressRoutePath(lit[3]);
      const comments = harvestComments(lines, i);
      routes.push({
        method,
        path: routePath,
        line: i + 1,
        source: sourceLabel,
        comments,
        stub: comments.length === 0,
      });
      continue;
    }
    const regexLit = line.match(regexLiteralRe);
    if (regexLit) {
      const method = regexLit[1].toUpperCase();
      const routePath = regexLit[2].replace(/\\\//g, '/');
      const comments = harvestComments(lines, i);
      routes.push({
        method,
        path: routePath,
        line: i + 1,
        source: sourceLabel,
        comments,
        stub: comments.length === 0,
        expandedFrom: 'regex-literal',
      });
      continue;
    }
    const variable = line.match(variableRe);
    if (variable) {
      const method = variable[1].toUpperCase();
      const ident = variable[2];
      // Walk backwards up to 6 lines to find `for (const <ident> of [...])`
      const loopHit = findEnclosingArrayLoop(lines, i, ident);
      if (loopHit) {
        const comments = harvestComments(lines, loopHit.startLine);
        for (const p of loopHit.paths) {
          routes.push({
            method,
            path: normalizeExpressRoutePath(p),
            line: i + 1,
            source: sourceLabel,
            comments,
            stub: comments.length === 0,
            expandedFrom: ident,
          });
        }
      } else {
        unparseable.push({ source: sourceLabel, line: i + 1, snippet: line.trim() });
      }
    }
  }

  return { routes, unparseable };
}

function harvestComments(lines, routeLineIdx) {
  // Look at up to 5 lines above the route definition. We accept // line
  // comments and the body of an immediately-preceding /* ... */ block.
  // We stop the moment we hit a non-comment, non-blank line.
  const collected = [];
  for (let j = routeLineIdx - 1, taken = 0; j >= 0 && taken < 5; j--) {
    const raw = lines[j];
    const trimmed = raw.trim();
    if (trimmed === '') {
      // A blank line breaks the comment block unless we have nothing yet.
      if (collected.length) break;
      continue;
    }
    if (trimmed.startsWith('//')) {
      const content = trimmed.replace(/^\/\/+\s?/, '');
      // W934b: strip leading internal wave tag (e.g. "W888-D ") from public API descriptions
      const cleaned = content.replace(/^W\d+[a-z]?(?:-[A-Z0-9]+)?[\s:.\-]+/, '') || content;
      collected.unshift(cleaned);
      taken++;
      continue;
    }
    // Stop on first non-comment line.
    break;
  }
  // Drop decorative section dividers and rewrite em-dashes to ndash
  // (hard page-level constraint).
  return collected
    .map((c) => c.replace(/^-+\s*/, '').replace(/\s*-+$/, '').trim())
    .filter((c) => !isDecorativeComment(c))
    .map((c) => c.replace(/—/g, '–')) // em-dash to en-dash
    .filter((c) => c.length > 0);
}

function isDecorativeComment(c) {
  const s = String(c || '').trim();
  if (!s) return false;
  if (/^=+$/.test(s)) return true;
  if (/^=+\s*[^=].*?=+$/.test(s)) return true;
  const compact = s.replace(/[\s\-=+\u2500\u2501\u2550\uFFFD\u0080?]+/g, '');
  if (/^(GET|POST|PUT|PATCH|DELETE|ALL)\/v?\d?\//i.test(compact)) return true;
  if (/^(GET|POST|PUT|PATCH|DELETE|ALL)\/[a-z0-9]/i.test(compact)) return true;
  return false;
}

function findEnclosingArrayLoop(lines, routeLineIdx, ident) {
  // Walk up looking for `for (const <ident> of [ ... ])`. The array literal may
  // be on the same line or span multiple lines (look-back window up to 24
  // lines). We accept single- or double-quoted string elements.
  const SINGLE_LINE = new RegExp(
    'for\\s*\\(\\s*const\\s+' + ident + '\\s+of\\s*\\[([^\\]]+)\\]'
  );
  const MULTI_LINE_OPEN = new RegExp(
    'for\\s*\\(\\s*const\\s+' + ident + '\\s+of\\s*\\[\\s*$'
  );
  for (let j = routeLineIdx - 1; j >= Math.max(0, routeLineIdx - 24); j--) {
    const candidate = lines[j];
    // Same-line form.
    const hit = candidate.match(SINGLE_LINE);
    if (hit) {
      const elems = [];
      const inner = hit[1];
      const elemRe = /(['"])(\/[^'"]+?)\1/g;
      let m;
      while ((m = elemRe.exec(inner)) !== null) {
        elems.push(m[2]);
      }
      return { startLine: j, paths: elems };
    }
    // Multi-line form: opening `for (const X of [` on one line, closing `]`
    // on a later line, route call site after the closing bracket.
    if (MULTI_LINE_OPEN.test(candidate)) {
      const elems = [];
      const elemRe = /(['"])(\/[^'"]+?)\1/g;
      for (let k = j + 1; k < routeLineIdx; k++) {
        const inner = lines[k];
        let m;
        elemRe.lastIndex = 0;
        while ((m = elemRe.exec(inner)) !== null) {
          elems.push(m[2]);
        }
        if (/^\s*\]\s*\)/.test(inner)) break; // closing bracket reached
      }
      return { startLine: j, paths: elems };
    }
  }
  return null;
}

// ----------------- 2. GROUPING -----------------

function groupKeyFor(routePath) {
  // Group by the second segment for /v1/<group>/* paths. Top-level routes
  // (/health, /ready) get their own "system" group.
  if (!routePath.startsWith('/v1/')) return 'system';
  const rest = routePath.slice(4); // strip "/v1/"
  const first = rest.split('/')[0].split(':')[0];
  return first || 'root';
}

function groupRoutes(routes) {
  const groups = new Map();
  for (const r of routes) {
    const key = groupKeyFor(r.path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  // De-dup identical METHOD + path within a group (the for-loop expansion can
  // overlap with explicit definitions later in the file).
  for (const [k, arr] of groups) {
    const seen = new Set();
    const deduped = [];
    for (const r of arr) {
      const sig = r.method + ' ' + r.path;
      if (seen.has(sig)) continue;
      seen.add(sig);
      deduped.push(r);
    }
    // Stable alphabetical by path then method.
    deduped.sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.method < b.method ? -1 : 1;
    });
    groups.set(k, deduped);
  }
  return groups;
}

// ----------------- 3. RENDERING -----------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugForRoute(method, routePath) {
  // Stable HTML anchor id. Use the legacy shape: GET-v1-account-balance
  return (
    method +
    '-' +
    routePath
      .replace(/^\//, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/-+$/g, '')
  );
}

function curlFor(route) {
  const method = route.method;
  const placeholder = 'kolm-demo-key';
  const exampleHost = 'https://kolm.ai';
  // For path params, substitute :param with a literal example value.
  const samplePath = route.path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '<$1>');
  const lines = [];
  if (method === 'GET' || method === 'DELETE') {
    lines.push(
      'curl -X ' + method + ' "' + exampleHost + samplePath + '" \\'
    );
    lines.push('  -H "Authorization: Bearer ' + placeholder + '"');
  } else {
    lines.push(
      'curl -X ' + method + ' "' + exampleHost + samplePath + '" \\'
    );
    lines.push('  -H "Authorization: Bearer ' + placeholder + '" \\');
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push("  -d '{}'");
  }
  return lines.join('\n');
}

function stubResponseFor(route) {
  // We do not know per-route response shapes from comments alone. Emit the
  // shared envelope shape that the kolm.ai API uses.
  if (route.method === 'DELETE') {
    return JSON.stringify({ ok: true }, null, 2);
  }
  if (route.path === '/health' || route.path === '/ready' || route.path.endsWith('/health')) {
    return JSON.stringify({ status: 'ok', uptime_s: 0 }, null, 2);
  }
  return JSON.stringify({ ok: true, request_id: 'req_018x' }, null, 2);
}

function shortDescriptionFor(route) {
  // Take the first comment line that looks like a description (not a wave
  // marker like `W213` alone, not a bare divider).
  const routeSpecific = route.comments.find((c) => String(c || '').includes(route.path));
  if (routeSpecific) return routeSpecific.replace(/\s+/g, ' ').trim();
  for (const c of route.comments) {
    const cleaned = c.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    if (/^W\d+[a-z]?$/.test(cleaned)) continue;
    return cleaned;
  }
  return null;
}

function fullDescriptionFor(route) {
  // Combine all 5 lines into a single paragraph.
  return route.comments.join(' ').replace(/\s+/g, ' ').trim();
}

function groupLabelFor(key) {
  // Pretty group title with a brief explainer.
  const labels = {
    system: 'System',
    account: 'Account',
    admin: 'Admin',
    anon: 'Anonymous bootstrap',
    artifacts: 'Artifacts',
    'artifact-lineage': 'Artifact lineage',
    assistant: 'Assistant',
    attestations: 'Attestations',
    audit: 'Audit',
    bakeoff: 'Bakeoff',
    benchmarks: 'Benchmarks',
    billing: 'Billing',
    bridges: 'Bridges',
    builder: 'Builder',
    byoc: 'Bring-your-own-cloud',
    cache: 'Cache',
    capture: 'Capture',
    captures: 'Captures',
    'chat': 'OpenAI-compatible chat',
    cli: 'CLI metadata',
    cloud: 'Cloud',
    code: 'Code',
    compile: 'Compile',
    composability: 'Composability',
    compose: 'Compose',
    concepts: 'Concepts',
    'confidential-compute': 'Confidential compute',
    consumption: 'Consumption',
    coverage: 'Coverage',
    datasets: 'Datasets',
    'detector': 'Detector',
    devices: 'Devices',
    distill: 'Distill',
    eval: 'Evaluation',
    embeddings: 'Embeddings',
    embed: 'Embed',
    events: 'Events',
    'federated-learning': 'Federated learning',
    governance: 'Governance',
    health: 'Health',
    holdout: 'Holdout',
    jobs: 'Jobs',
    keys: 'Keys',
    lake: 'Lake',
    labels: 'Labels',
    library: 'Library',
    license: 'License',
    loop: 'Value-loop',
    marketplace: 'Marketplace',
    membership: 'Membership',
    messages: 'Anthropic-compatible messages',
    metrics: 'Metrics',
    moderations: 'Moderations',
    notifications: 'Notifications',
    oauth: 'OAuth',
    optimize: 'Optimize',
    pings: 'Pings',
    plans: 'Plans',
    pricing: 'Pricing',
    privacy: 'Privacy',
    proxy: 'Proxy',
    public: 'Public',
    quotas: 'Quotas',
    receipts: 'Receipts',
    recall: 'Recall',
    recipes: 'Recipes',
    registry: 'Registry',
    replay: 'Replay',
    responses: 'OpenAI Responses',
    rotation: 'Rotation',
    run: 'Run',
    runtime: 'Runtime',
    runtimes: 'Runtimes',
    session: 'Session',
    settings: 'Settings',
    sigstore: 'Sigstore',
    signin: 'Sign in',
    signout: 'Sign out',
    signup: 'Sign up',
    sim: 'Simulation',
    spec: 'Spec',
    synth: 'Synthesis',
    synthesize: 'Synthesis',
    sync: 'Sync',
    team: 'Team',
    telemetry: 'Telemetry',
    tier: 'Tier',
    tokens: 'Tokens',
    'trace-capture': 'Trace capture',
    training: 'Training',
    tunnel: 'Tunnel',
    'verified-inference': 'Verified inference',
    workflow: 'Workflow',
    workspaces: 'Workspaces',
    wrap: 'Wrap',
  };
  return labels[key] || key.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function renderRouteSection(route) {
  const anchorId = slugForRoute(route.method, route.path);
  const shortDesc = shortDescriptionFor(route);
  const fullDesc = fullDescriptionFor(route);
  const searchText = [
    route.method,
    route.path,
    route.source,
    route.stub ? 'source-indexed' : 'reference-ready',
    shortDesc,
    fullDesc,
  ].filter(Boolean).join(' ');
  const stubBadge = route.stub
      ? ' <span class="route-stub" title="Wired route indexed directly from source.">source-indexed</span>'
    : ' <span class="route-live" title="Reference includes route-specific source comments.">reference-ready</span>';
  const expandedNote = route.expandedFrom
    ? ' <span class="route-stub">' +
      (route.expandedFrom === 'regex-literal' ? 'regex route' : 'array-literal expansion') +
      '</span>'
    : '';
  const descBlock = shortDesc
    ? '<p class="route-desc">' + escapeHtml(shortDesc) + '</p>'
    : '<p class="route-desc">' +
      escapeHtml(
        'Route contract generated from source. Request and response use the shared JSON envelope.'
      ) +
      '</p>';
  const fullBlock =
    fullDesc && fullDesc !== shortDesc
      ? '<details class="route-detail"><summary>Full comment</summary><p>' +
        escapeHtml(fullDesc) +
        '</p></details>'
      : '';
  return [
    '<section class="api-route" id="' + anchorId + '" data-api-route data-route-status="' +
      (route.stub ? 'source-indexed' : 'reference-ready') +
      '" data-route-search="' +
      escapeHtml(searchText.toLowerCase()) +
      '">',
    '  <h3><span class="m m-' +
      route.method.toLowerCase() +
      '">' +
      route.method +
      '</span> <code>' +
      escapeHtml(route.path) +
      '</code>' +
      stubBadge +
      expandedNote +
      '</h3>',
    '  ' + descBlock,
    fullBlock ? '  ' + fullBlock : '',
    '  <pre><code>' + escapeHtml(curlFor(route)) + '</code></pre>',
    '  <pre><code>' + escapeHtml(stubResponseFor(route)) + '</code></pre>',
    '</section>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderGroup(key, routes) {
  const label = groupLabelFor(key);
  const groupId = 'group-' + key.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const intro = renderGroupIntro(key, routes);
  const routeBlocks = routes.map(renderRouteSection).join('\n\n');
  const groupSearch = [label, key, routes.map((r) => r.path).join(' ')].join(' ').toLowerCase();
  return [
    '<section class="api-group" id="' + groupId + '" data-api-group data-group-search="' + escapeHtml(groupSearch) + '">',
    '<h2>' + escapeHtml(label) + ' <span class="group-count">(' + routes.length + ')</span></h2>',
    intro,
    routeBlocks,
    '</section>',
  ].join('\n');
}

function renderGroupIntro(key, routes) {
  // One-paragraph note about auth + base URL conventions per group. Same
  // text for every group to keep the page consistent.
  const authNote =
    key === 'system' || key === 'anon' || key === 'signup' || key === 'signin' || key === 'public' || key === 'loop' || key === 'plans' || key === 'pricing' || key === 'spec' || key === 'keys' || key === 'sigstore' || key === 'health' || key === 'oauth'
      ? 'Public surface. No auth header required. Base URL: <code>https://kolm.ai</code> (prod) or <code>http://localhost:8787</code> (self-host).'
      : 'Authenticated surface. Send <code>Authorization: Bearer &lt;key&gt;</code> or <code>x-api-key: &lt;key&gt;</code>. Base URL: <code>https://kolm.ai</code> (prod) or <code>http://localhost:8787</code> (self-host).';
  return (
    '<details class="group-intro"><summary>About this group</summary><p>' +
    authNote +
    '</p></details>'
  );
}

function canonicalNavBlockForApi() {
  const begin = '<!-- KOLM_NAV_BEGIN (W221) -->';
  const end = '<!-- KOLM_NAV_END (W221) -->';
  try {
    const home = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const start = home.indexOf(begin);
    const finish = home.indexOf(end, start);
    if (start >= 0 && finish > start) {
      const lineStart = home.lastIndexOf('\n', start) + 1;
      return home.slice(lineStart, finish + end.length);
    }
  } catch (_) {} // deliberate: cleanup
  return [
    begin,
    '<nav class="nav__links" id="navLinks" aria-label="Primary">',
    '<a href="/#pipeline">Product</a>',
    '<a href="/docs" aria-current="page">Docs</a>',
    '<a href="/pricing">Pricing</a>',
    '</nav>',
    '<div class="nav__actions">',
    '<a class="nav__icon" href="/status" aria-label="System status"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3.25" stroke="currentColor" stroke-width="1.6"/><path d="M12 3.5v2M12 18.5v2M4.5 12h2M17.5 12h2M6.7 6.7l1.4 1.4M15.9 15.9l1.4 1.4M17.3 6.7l-1.4 1.4M8.1 15.9l-1.4 1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></a>',
    '<a class="btn btn--ghost btn--sm" href="/account/overview">sign in</a>',
    '<a class="btn btn--ghost btn--sm nav__cta is-solid" href="/signup">Get an API key</a>',
    '</div>',
    end,
  ].join('\n');
}

function renderPage(grouped, totalCount, unparseable) {
  const groupKeys = Array.from(grouped.keys()).sort();
  // P0-7 partition counts: surface reference-ready vs source-indexed routes at
  // the top of the page. Both counts are real, wired routes.
  let liveCount = 0;
  let previewCount = 0;
  for (const k of groupKeys) {
    for (const r of grouped.get(k)) {
      if (r.stub) previewCount++;
      else liveCount++;
    }
  }
  const tocBody = groupKeys
    .map((k) => {
      const arr = grouped.get(k);
      const id = 'group-' + k.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      return (
        '<li><a href="#' +
        id +
        '">' +
        escapeHtml(groupLabelFor(k)) +
        '</a> <span class="toc-count">' +
        arr.length +
        '</span></li>'
      );
    })
    .join('\n  ');
  const groupsHtml = groupKeys
    .map((k) => renderGroup(k, grouped.get(k)))
    .join('\n\n');
  const navBlock = canonicalNavBlockForApi();
  const title = 'API reference - kolm.ai';
  const titleEntity = 'API reference - kolm.ai';
  const description =
    'Auto-generated REST API reference for kolm.ai. ' +
    totalCount +
    ' wired routes across ' +
    groupKeys.length +
    ' groups, sourced directly from route source files.';

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: 'API reference',
    description: description,
    url: 'https://kolm.ai/docs/api',
    datePublished: TODAY,
    dateModified: TODAY,
    author: { '@type': 'Organization', name: 'kolm.ai' },
    publisher: { '@type': 'Organization', name: 'kolm.ai' },
  });
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'kolm.ai', item: 'https://kolm.ai/' },
      { '@type': 'ListItem', position: 2, name: 'Docs', item: 'https://kolm.ai/docs' },
      { '@type': 'ListItem', position: 3, name: 'API reference', item: 'https://kolm.ai/docs/api' },
    ],
  });

  const unparseableNote =
    unparseable.length > 0
      ? '<p class="route-stub">Note: ' +
        unparseable.length +
        ' route call site(s) could not be parsed (variable or template-literal path). They are listed in the manifest JSON.</p>'
      : '';

  return `<!DOCTYPE html>
<html lang="en" style="background:#08090A;color-scheme:dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>html,body{background:#08090A;color:#C3C8D0}html{color-scheme:dark}</style>
<title>${title}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#08090A">
<meta property="og:title" content="${titleEntity}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="https://kolm.ai/docs/api">
<meta property="og:image" content="https://kolm.ai/compiler-brand-hero.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${titleEntity}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="https://kolm.ai/compiler-brand-hero.png">
<link rel="canonical" href="https://kolm.ai/docs/api">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/Geist.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/GeistMono.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/kolm-2026.css">
<script type="application/ld+json">${jsonLd}</script>
<script type="application/ld+json">${breadcrumbLd}</script>
<style>
:root{--ink:#ece7dc;--ink-mute:#b5bdb1;--ink-faint:#737c73;--line:rgba(236,231,220,0.08);--bg:#0b0d10;--bg-elev:#101316;--accent:#2563eb;--accent-soft:rgba(16,185,129,0.10);--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
[data-theme=light]{--ink:#1f2429;--ink-mute:#4b5158;--ink-faint:#737c73;--line:rgba(0,0,0,0.08);--bg:#fdfcf8;--bg-elev:#ffffff;--accent:#2563eb;--accent-soft:rgba(5,150,105,0.10)}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,Inter,system-ui,sans-serif;margin:0}
main,.wrap,.api-route,.api-group,pre,code{max-width:100%}
.skip-link{position:absolute;left:12px;top:12px;z-index:9999;transform:translateY(-160%);border:1px solid var(--accent);border-radius:999px;background:var(--accent);color:#06120b;padding:10px 14px;font:700 13px/1 var(--mono);text-decoration:none}
.skip-link:focus{transform:translateY(0)}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
header.site-header{padding:18px 0;border-bottom:1px solid var(--line)}
header.site-header .wrap{display:grid;grid-template-columns:auto minmax(0,1fr);gap:18px;align-items:center}
header.site-header nav{display:flex;justify-content:flex-end;gap:8px;font-family:var(--mono);font-size:12px;flex-wrap:wrap}
header.site-header nav a{min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:0 10px;color:inherit;text-decoration:none;border-radius:6px}
header.site-header nav a:hover{background:rgba(255,255,255,.04)}
header.site-header .logo{min-height:44px;display:inline-flex;align-items:center;font-family:var(--mono);font-size:13px;color:inherit;text-decoration:none}
main{padding:48px 0 96px}
.crumbs{font-family:var(--mono);font-size:11.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 18px}
.crumbs a{color:inherit;text-decoration:none;border-bottom:1px dashed var(--line)}
h1{font-size:42px;line-height:1.08;font-weight:500;letter-spacing:0;margin:0 0 18px;max-width:920px}
.lede{font-size:18px;line-height:1.55;color:var(--ink-mute);max-width:780px;margin:0 0 36px}
h2{font-size:24px;font-weight:500;letter-spacing:0;margin:48px 0 12px;max-width:780px;scroll-margin-top:80px}
h3{font-size:15px;font-weight:500;letter-spacing:0;margin:28px 0 8px;max-width:840px;font-family:var(--mono);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
p{color:var(--ink-mute);font-size:15px;line-height:1.65;max-width:780px}
pre{background:#06080a;color:#e9eef3;border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:hidden;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:12.5px/1.55 var(--mono);margin:10px 0 14px}
pre code{background:none;border:none;padding:0;color:inherit;font:inherit;white-space:inherit;overflow-wrap:anywhere;word-break:break-word}
code{font-family:var(--mono);font-size:13px;color:var(--ink);background:var(--bg-elev);padding:1px 6px;border-radius:4px;border:1px solid var(--line)}
.api-route,.api-group{min-width:0;overflow:hidden}
.api-route h3,.api-route code,.api-route p,.api-route li,.api-route summary,.route-desc,.route-detail,.group-intro p{min-width:0;white-space:normal;overflow-wrap:anywhere;word-break:break-word}
ul,ol{color:var(--ink-mute);font-size:15px;line-height:1.7;max-width:780px}
li{margin:4px 0}
.api-group{margin:48px 0 32px;padding-top:8px;border-top:1px solid var(--line)}
.api-group h2{margin-top:24px}
.api-route{margin:18px 0 22px;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--bg-elev)}
.api-route h3{margin:0 0 8px}
.api-route .route-desc{margin:0 0 8px;font-size:14px;color:var(--ink-mute)}
.api-route .route-detail{margin:6px 0 10px;font-size:13.5px}
.api-route .route-detail summary{cursor:pointer;color:var(--ink-faint);font-family:var(--mono);font-size:12px}
.m{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11.5px;font-weight:500;letter-spacing:0.04em;text-transform:uppercase;color:#0b0d10}
.m-get{background:#5eb88b}
.m-post{background:#7faedc}
.m-put{background:#d6b15e}
.m-patch{background:#c89fdc}
.m-delete{background:#dc8a8a}
.route-stub{display:inline-block;padding:2px 8px;border-radius:4px;background:rgba(236,231,220,0.06);color:var(--ink-faint);font-family:var(--mono);font-size:10.5px;letter-spacing:0.04em;text-transform:uppercase}
.route-live{display:inline-block;padding:2px 8px;border-radius:4px;background:var(--accent-soft);color:var(--accent);font-family:var(--mono);font-size:10.5px;letter-spacing:0.04em;text-transform:uppercase}
.partition-toolbar{display:flex;gap:14px;align-items:center;margin:10px 0 22px;font-family:var(--mono);font-size:12.5px;color:var(--ink-mute)}
.partition-toolbar label{min-height:44px;cursor:pointer;display:flex;gap:8px;align-items:center}
.api-hero{display:grid;grid-template-columns:minmax(0,.92fr) minmax(360px,.58fr);gap:clamp(28px,5vw,76px);align-items:start;margin:0 0 28px}
.api-hero__copy{min-width:0}
.api-cockpit{min-width:0;border:1px solid rgba(236,246,240,.14);border-radius:8px;background:#101619;color:#eaf2ec;box-shadow:0 34px 88px rgba(16,19,18,.2);overflow:hidden}
.api-cockpit__bar{min-height:46px;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:0 16px;border-bottom:1px solid rgba(236,246,240,.11);font:12px/1.25 var(--mono);color:#aeb8b2}
.api-cockpit__bar b{color:#f2f6f1}
.api-cockpit__bar span:last-child{color:#75d19f;text-align:right}
.api-cockpit__body{display:grid;gap:12px;padding:16px}
.api-cockpit__metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.api-cockpit__metric{min-width:0;min-height:68px;padding:11px;border:1px solid rgba(236,246,240,.11);border-radius:6px;background:rgba(7,11,12,.52)}
.api-cockpit__metric b{display:block;color:#f2f6f1;font:700 22px/1 var(--mono)}
.api-cockpit__metric span{display:block;margin-top:6px;color:#aeb8b2;font-size:12px;line-height:1.35}
.api-command{display:grid;gap:8px;padding:12px;border:1px solid rgba(236,246,240,.11);border-radius:6px;background:rgba(7,11,12,.58)}
.api-command label,.api-cockpit__toggles label{font:700 11px/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:#c7d0ca}
.api-command__row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
.api-command input{min-width:0;min-height:44px;width:100%;border:1px solid rgba(236,246,240,.16);border-radius:6px;background:#070b0c;color:#f2f6f1;padding:0 12px;font:13px/1.35 var(--mono)}
.api-command input::placeholder{color:#728078}
.api-command input:focus-visible,.api-command__clear:focus-visible,.api-cockpit__toggles input:focus-visible{outline:2px solid #75d19f;outline-offset:2px}
.api-command__clear{min-height:44px;border:1px solid rgba(236,246,240,.16);border-radius:6px;background:rgba(255,255,255,.05);color:#f2f6f1;padding:0 12px;font:700 12px/1 var(--mono);cursor:pointer}
.api-command__clear:hover{background:rgba(255,255,255,.09)}
.api-command__hint,.api-command__status{margin:0;color:#aeb8b2;font:12px/1.5 var(--mono)}
.api-command__status{color:#75d19f}
.api-cockpit__toggles{display:grid;gap:10px;padding:12px;border:1px solid rgba(236,246,240,.11);border-radius:6px;background:rgba(7,11,12,.44)}
.api-cockpit__toggles label{min-height:44px;display:flex;align-items:center;gap:9px;cursor:pointer}
.api-cockpit__toggles input{width:18px;height:18px;accent-color:#75d19f}
.api-proof-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:6px 0 28px}
.api-proof-card{min-width:0;min-height:148px;display:flex;flex-direction:column;justify-content:space-between;gap:12px;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--bg-elev);color:inherit;text-decoration:none}
.api-proof-card:hover{border-color:rgba(236,231,220,.22);background:rgba(255,255,255,.035)}
.api-proof-card b{display:block;color:var(--ink);font-size:13px;line-height:1.35}
.api-proof-card span{display:block;color:var(--ink-mute);font-size:12.5px;line-height:1.45}
.api-proof-card code{align-self:flex-start;font-size:11.5px}
.api-proof-card--green{box-shadow:inset 3px 0 0 #22c55e}
.api-proof-card--blue{box-shadow:inset 3px 0 0 #60a5fa}
.api-proof-card--amber{box-shadow:inset 3px 0 0 #f59e0b}
.api-proof-card--rose{box-shadow:inset 3px 0 0 #fb7185}
.api-bridge{margin:-4px 0 18px;font-size:14px;color:var(--ink-faint,#737c73)}
.api-bridge a{min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;color:var(--ink);text-decoration:none;border-bottom:1px dashed var(--line)}
.api-jump-links a{min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;color:var(--ink);text-decoration:none;border-bottom:1px dashed var(--line)}
.api-runbook-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:16px 0 28px}
.api-runbook-step{min-width:0;min-height:176px;padding:14px;border:1px solid var(--line);border-radius:8px;background:rgba(255,255,255,.024)}
.api-runbook-step span{display:block;color:var(--ink-faint);font-family:var(--mono);font-size:11px;margin-bottom:8px}
.api-runbook-step strong{display:block;color:var(--ink);font-size:13px;line-height:1.35;margin-bottom:8px}
.api-runbook-step p{font-size:12.5px;line-height:1.5;margin:9px 0 0;color:var(--ink-mute)}
.api-runbook-step code{font-size:11px}
@media(max-width:980px){.api-proof-board{grid-template-columns:repeat(2,minmax(0,1fr))}.api-runbook-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:640px){.api-proof-board,.api-runbook-grid{grid-template-columns:1fr}.api-proof-card,.api-runbook-step{min-height:auto}}
.surface-media-panel{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;min-height:132px;margin:22px 0 30px;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--bg-elev)}
.surface-media-panel div{min-width:0;padding:12px;border:1px solid var(--line);border-radius:8px;background:rgba(255,255,255,.026)}
.surface-media-panel b{display:block;color:var(--ink);font-family:var(--mono);font-size:11px;line-height:1.35}
.surface-media-panel span{display:block;margin-top:7px;color:var(--ink-mute);font-size:12px;line-height:1.45}
@media(max-width:820px){.surface-media-panel{grid-template-columns:1fr}}
body[data-api-filter="live"] .api-route:has(.route-stub){display:none}
body[data-api-filter="live"] .api-group:not(:has(.route-live)){display:none}
.api-route[hidden],.api-group[hidden]{display:none!important}
.group-count,.toc-count{color:var(--ink-faint);font-family:var(--mono);font-size:11.5px;font-weight:400;margin-left:6px}
.toc-grid{column-count:3;column-gap:24px;list-style:none;padding:0;margin:18px 0 32px;font-size:13.5px;font-family:var(--mono)}
@media(max-width:820px){.toc-grid{column-count:1}}
.toc-grid li{margin:2px 0;break-inside:avoid}
.toc-grid a{color:var(--ink);text-decoration:none;border-bottom:1px dashed var(--line)}
.group-intro{margin:6px 0 14px;font-size:13.5px}
.group-intro summary,.route-detail summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--ink-faint);font-family:var(--mono);font-size:12px}
.totals{font-family:var(--mono);font-size:12.5px;color:var(--ink-mute);margin:0 0 24px}
.legacy{font-family:var(--mono);font-size:11.5px;color:var(--ink-faint);max-width:780px;line-height:1.65}
.legacy code{font-size:11.5px}
footer{padding:32px 0;color:var(--ink-faint);font-family:var(--mono);font-size:11.5px;border-top:1px solid var(--line)}
footer a{color:inherit;text-decoration:none;border-bottom:1px dashed var(--line)}
@media(max-width:640px){header.site-header .wrap{grid-template-columns:1fr;gap:8px}header.site-header nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));justify-content:stretch}header.site-header nav a{border:1px solid var(--line);background:rgba(255,255,255,.018)}.wrap{padding:0 20px}main{padding:38px 0 80px}h1{font-size:38px}.lede{font-size:17px}}
:root{--ink:#F7F8F8;--ink-mute:#C3C8D0;--ink-faint:#868B94;--line:rgba(255,255,255,.08);--line-2:rgba(255,255,255,.13);--bg:#08090A;--bg-elev:#0E0F12;--paper-sink:#0B0C0E;--accent:#3FE5A0;--accent-soft:rgba(63,229,160,.12);--mono:"Spline Sans Mono",ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
body.api-reference-page{background:radial-gradient(920px 420px at 18% 12%,rgba(247,255,250,.78),transparent 74%),radial-gradient(760px 330px at 82% 0%,rgba(117,255,157,.13),transparent 72%),radial-gradient(700px 300px at 100% 25%,rgba(111,166,232,.07),transparent 72%),linear-gradient(rgba(7,16,13,.036) 1px,transparent 1px),linear-gradient(90deg,rgba(7,16,13,.03) 1px,transparent 1px),var(--bg);background-size:auto,auto,auto,72px 72px,72px 72px,auto;color:var(--ink);font-family:"Switzer",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.api-reference-page .wrap{max-width:1160px}
.api-reference-page header.site-header{position:sticky;top:0;z-index:50;padding:0;background:rgba(216,229,222,.86);border-bottom:1px solid rgba(7,16,13,.1);backdrop-filter:saturate(140%) blur(12px);-webkit-backdrop-filter:saturate(140%) blur(12px);box-shadow:0 1px 0 rgba(247,255,250,.72)}
.api-reference-page header.site-header .wrap{min-height:62px;display:flex;gap:24px;align-items:center}
.api-reference-page header.site-header .logo{gap:9px;color:var(--ink);font-family:"Cabinet Grotesk",var(--display),sans-serif;font-size:18.5px;font-weight:640}
.api-reference-page header.site-header .logo::before{content:"";width:18px;height:18px;display:inline-block;background:linear-gradient(90deg,var(--accent) 0 22%,transparent 22% 38%,var(--accent) 38% 60%,transparent 60% 76%,var(--accent) 76% 100%);clip-path:polygon(0 22%,22% 22%,22% 86%,0 86%,0 22%,38% 12%,60% 12%,60% 78%,38% 78%,38% 12%,76% 32%,100% 32%,100% 68%,76% 68%,76% 32%)}
.api-reference-page header.site-header nav{margin-left:auto;display:flex;gap:22px;font:500 14px/1 "Switzer",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.api-reference-page header.site-header nav a{min-width:44px;min-height:44px;padding:0;color:var(--ink-mute);border:0;border-radius:0;background:transparent}
.api-reference-page header.site-header nav a:hover{color:var(--ink);background:transparent;text-decoration:underline;text-underline-offset:10px;text-decoration-thickness:1px}
.api-reference-page main{padding:clamp(68px,9vw,108px) 0 96px}
.api-reference-page .crumbs{display:inline-flex;gap:8px;align-items:center;padding:7px 12px;border:1px solid rgba(7,16,13,.18);border-radius:999px;background:rgba(247,255,250,.58);box-shadow:inset 0 1px 0 rgba(255,255,255,.74),0 10px 28px rgba(7,16,13,.055);color:var(--ink-mute);letter-spacing:.13em}
.api-reference-page .crumbs::before{content:"";width:6px;height:6px;border-radius:999px;background:var(--accent)}
.api-reference-page .crumbs a{border:0}
.api-reference-page h1{max-width:760px;margin-top:28px;color:var(--ink);font-family:"Cabinet Grotesk",var(--display),sans-serif;font-size:clamp(58px,7vw,84px);font-weight:640;line-height:.98;text-wrap:balance}
.api-reference-page .lede{max-width:780px;color:var(--ink-mute);font-size:18px;line-height:1.58}
.api-reference-page .api-cockpit{margin-top:28px}
.api-reference-page .api-cockpit code{background:rgba(255,255,255,.06);border-color:rgba(236,246,240,.14);color:#75d19f}
.api-reference-page .surface-media-panel{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;min-height:164px;margin:28px 0 22px;padding:14px;border:1px solid rgba(236,246,240,.14);border-radius:8px;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.014)),#101619;box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 28px 72px rgba(16,19,18,.18);color:#f2f6f1}
.api-reference-page .surface-media-panel div{border-color:rgba(236,246,240,.12);background:rgba(8,12,13,.66)}
.api-reference-page .surface-media-panel b{color:#f2f6f1}
.api-reference-page .surface-media-panel span{color:#b9c5be}
.api-reference-page .api-proof-board{gap:14px;margin:24px 0 28px}
.api-reference-page .api-proof-card,.api-reference-page .api-runbook-step,.api-reference-page .api-route{background:radial-gradient(300px 180px at 100% 0%,rgba(117,255,157,.07),transparent 72%),linear-gradient(180deg,rgba(247,255,250,.68),rgba(231,243,236,.42)),rgba(247,255,250,.56);border-color:var(--line);box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 14px 42px rgba(7,16,13,.05)}
.api-reference-page .api-proof-card:hover{border-color:var(--line-2);background:rgba(247,255,250,.84)}
.api-reference-page .api-proof-card b,.api-reference-page .api-runbook-step strong{font-family:"Cabinet Grotesk",var(--display),sans-serif;color:var(--ink);font-size:17px;font-weight:640}
.api-reference-page .api-proof-card span,.api-reference-page .api-runbook-step p,.api-reference-page .route-desc,.api-reference-page .route-detail p{color:var(--ink-mute)}
.api-reference-page code{background:rgba(247,255,250,.58);border-color:var(--line);color:var(--ink)}
.api-reference-page pre{background:#101619;color:#dce7df;border-color:rgba(236,246,240,.14);box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
.api-reference-page pre code{background:none;border:0;color:inherit}
.api-reference-page .route-live{background:rgba(10,123,83,.1);color:var(--accent)}
.api-reference-page .route-stub{background:rgba(16,19,18,.05);color:var(--ink-faint)}
.api-reference-page .m{color:#06120b}
.api-reference-page .m-get{background:#74c69d}.api-reference-page .m-post{background:#90bde8}.api-reference-page .m-put{background:#dcbf73}.api-reference-page .m-patch{background:#c9b0e7}.api-reference-page .m-delete{background:#e6a19d}
.api-reference-page .api-group{border-top-color:rgba(7,16,13,.12)}
.api-reference-page .toc-grid a,.api-reference-page .api-bridge a,.api-reference-page .api-jump-links a{color:var(--ink)}
.api-reference-page footer{background:rgba(216,229,222,.74);border-top-color:rgba(7,16,13,.12)}
@media(max-width:980px){.api-hero{grid-template-columns:1fr}.api-reference-page .api-cockpit{margin-top:0}}
@media(max-width:820px){.api-reference-page .surface-media-panel{grid-template-columns:1fr 1fr}.api-reference-page header.site-header nav{gap:12px}}
@media(max-width:640px){.api-reference-page header.site-header .wrap{display:flex;flex-wrap:wrap;gap:4px 14px;padding-block:8px}.api-reference-page header.site-header .logo{min-height:38px}.api-reference-page header.site-header nav{width:100%;margin-left:0;display:flex;gap:18px;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none}.api-reference-page header.site-header nav::-webkit-scrollbar{display:none}.api-reference-page header.site-header nav a{flex:0 0 auto;min-height:44px;border:0;border-radius:0;background:transparent}.api-reference-page main{padding:52px 0 80px}.api-reference-page h1{font-size:clamp(44px,12vw,58px)}.api-cockpit__metrics,.api-command__row{grid-template-columns:1fr}.api-reference-page .surface-media-panel{grid-template-columns:1fr}.api-reference-page .api-proof-board,.api-reference-page .api-runbook-grid{grid-template-columns:1fr}}
</style>
</head>
<body class="api-reference-page">
<a class="skip-link" href="#main">Skip to content</a>
<header class="nav"><div class="wrap nav__in">
  <a class="nav__brand" href="/" aria-label="kolm home"><svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="6" width="4.5" height="20" rx="0.4"/><rect x="13" y="9" width="4.5" height="14" rx="0.4"/><rect x="22" y="12" width="4.5" height="8" rx="0.4"/></svg><span>kolm</span></a>
${navBlock}
  <button class="nav__toggle" type="button" aria-label="Menu" aria-expanded="false" aria-controls="navLinks"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
</div></header>
<script defer src="/kolm-2026.js"></script>

<main id="main" tabindex="-1"><div class="wrap">

<section class="api-hero" aria-labelledby="api-title">
  <div class="api-hero__copy">
    <div class="crumbs"><a href="/">kolm.ai</a> / <a href="/docs">docs</a> / api</div>
    <h1 id="api-title">API operating reference</h1>
    <p class="lede">The kolm.ai REST surface. ${totalCount} wired routes across ${groupKeys.length} groups, auto-extracted from route source files and re-rendered on every wave. Every endpoint is JSON in, JSON out, bearer-auth on protected routes, and rate-limited per tenant.</p>
  </div>
  <aside class="api-cockpit" aria-label="API reference command center">
    <div class="api-cockpit__bar">
      <span><b>API command center</b> / source indexed</span>
      <span>no hand-written drift</span>
    </div>
    <div class="api-cockpit__body">
      <div class="api-cockpit__metrics" aria-label="Generated route counts">
        <div class="api-cockpit__metric"><b>${totalCount}</b><span>wired routes from source</span></div>
        <div class="api-cockpit__metric"><b>${groupKeys.length}</b><span>route groups</span></div>
        <div class="api-cockpit__metric"><b>${liveCount}</b><span>reference-ready routes</span></div>
        <div class="api-cockpit__metric"><b>${previewCount}</b><span>source-indexed routes</span></div>
      </div>
      <form class="api-command" role="search" data-api-search-form>
        <label for="apiRouteSearch">Search Route Surface</label>
        <div class="api-command__row">
          <input id="apiRouteSearch" name="api_route_search" type="search" inputmode="search" autocomplete="off" spellcheck="false" placeholder="/v1/compile, evidence, device&hellip;" data-api-search>
          <button class="api-command__clear" type="button" data-api-search-clear>Clear</button>
        </div>
        <p class="api-command__hint">Try <code>POST</code>, <code>capture</code>, <code>readiness</code>, <code>/v1/route</code>, or <code>warehouse</code>.</p>
        <p class="api-command__status" data-api-search-status aria-live="polite">${totalCount} routes visible.</p>
      </form>
      <div class="api-cockpit__toggles">
        <label><input type="checkbox" id="hide-preview" aria-label="Show reference-ready routes only" data-api-live-only> Show Reference-Ready Routes Only</label>
      </div>
    </div>
  </aside>
</section>
<div class="kolm-surface-media surface-media-panel" aria-label="API reference surface map">
  <div><b>capture and route</b><span>Provider-compatible chat, messages, responses, gateway dispatch and capture ingestion endpoints.</span></div>
  <div><b>compile and verify</b><span>Build jobs, artifacts, receipts, signatures, OpenAPI references and verifier routes.</span></div>
  <div><b>train and evaluate</b><span>Datasets, labels, bakeoffs, quality prediction, K-score and distillation workflows.</span></div>
  <div><b>deploy and govern</b><span>Devices, fleets, trust links, transparency logs, usage controls and enterprise governance routes.</span></div>
</div>

<div class="api-proof-board" aria-label="API operating proof surface">
  <a class="api-proof-card api-proof-card--green" href="/signup"><span><b>Create a tenant workspace</b><span>Issue the first tenant-scoped key, select plan context, and land operators in the control center.</span></span><code>POST /v1/signup</code></a>
  <a class="api-proof-card api-proof-card--blue" href="/account/api-control-center"><span><b>Govern ingress and egress</b><span>Inspect capture channels, egress policy, opaque payload posture, compile targets, and exports.</span></span><code>GET /v1/account/api-control-center</code></a>
  <a class="api-proof-card api-proof-card--amber" href="/openapi.json"><span><b>Export the machine contract</b><span>Use the generated OpenAPI and route manifest as CI inputs instead of trusting hand-written docs.</span></span><code>GET /openapi.json</code></a>
  <a class="api-proof-card api-proof-card--rose" href="/product-readiness-closeout.json"><span><b>Verify claim limits</b><span>Read the readiness ledger before making benchmark, package, certification, or adoption claims.</span></span><code>GET /product-readiness-closeout.json</code></a>
</div>

<p data-w704="api-landing-bridge" class="api-bridge">Need the guided path? Start at <a href="/docs#quickstart">/docs#quickstart</a>. Need the tenant console? Open <a href="/account/api-control-center">/account/api-control-center</a>. This page is the exhaustive endpoint catalog generated from source.</p>

<p class="totals"><strong>${totalCount} wired routes</strong> &middot; <span class="route-live">${liveCount} reference-ready</span> &middot; <span class="route-stub">${previewCount} source-indexed</span> &middot; ${groupKeys.length} groups &middot; generated ${TODAY} &middot; source <code>src/router.js</code></p>

${unparseableNote}

<h2 id="operate">Source-to-proof API runbook</h2>
<p>Use this sequence when checking whether the backend and public site describe the same product. It starts with a tenant, moves live traffic through the gateway, applies enterprise controls, compiles behavior, then exports verifiable proof.</p>
<div class="api-runbook-grid" aria-label="source-to-proof API runbook">
  <div class="api-runbook-step"><span>01</span><strong>Create workspace and key</strong><code>POST /v1/signup</code><p>Returns the first workspace envelope, selected plan, API key once, and control-center destination.</p></div>
  <div class="api-runbook-step"><span>02</span><strong>Route model traffic</strong><code>POST /v1/route/chat/completions</code><p>OpenAI-compatible traffic enters the capture and confidence-aware routing path.</p></div>
  <div class="api-runbook-step"><span>03</span><strong>Control data movement</strong><code>GET /v1/account/api-control-center</code><p>Operators declare sources, policy, egress, redaction, routing, eval gates, targets, and exports.</p></div>
  <div class="api-runbook-step"><span>04</span><strong>Compile portable behavior</strong><code>POST /v1/compile</code><p>Stable behavior turns into artifacts, manifests, hashes, receipts, and runtime target metadata.</p></div>
  <div class="api-runbook-step"><span>05</span><strong>Export proof and limits</strong><code>GET /v1/evidence/readiness</code><p>Read receipts and readiness gates before promoting production-final claims.</p></div>
</div>

<h2 id="base">Base URL &amp; auth</h2>
<p class="api-jump-links">Start with the guided setup at <a href="/docs#quickstart">/docs#quickstart</a>, then keep this API reference open for exact endpoints and payloads. Runtime behavior and acceptance gates are covered from <a href="/docs">/docs</a> and <a href="/platform">/platform</a>.</p>
<p>Local proxy: <code>http://localhost:8787</code>. Hosted: <code>https://kolm.ai</code>. Self-hosted enterprise: your domain.</p>
<p>Public routes (such as <code>/health</code>, <code>/v1/loop/try</code>, <code>/v1/anon/bootstrap</code>) need no auth header. Every other <code>/v1/*</code> route accepts either:</p>
<ul>
<li><code>Authorization: Bearer &lt;key&gt;</code></li>
<li><code>x-api-key: &lt;key&gt;</code> (the alias used by Anthropic-style clients)</li>
</ul>
<pre><code>export KOLM_BASE=https://kolm.ai
export KOLM_KEY=kolm-demo-key
curl -s "$KOLM_BASE/health" | jq .
curl -s "$KOLM_BASE/v1/lake/stats" -H "Authorization: Bearer $KOLM_KEY"</code></pre>

<h2 id="toc">Groups</h2>
<ul class="toc-grid">
  ${tocBody}
</ul>

<h2 id="legacy">Legacy anchor compatibility</h2>
<p class="legacy">The previous hand-written <code>/docs/api</code> used short anchor names. They are preserved as anchor aliases below so external links keep working:</p>
<p class="legacy">
  <a id="chat"></a><a id="messages"></a><a id="capture"></a><a id="lake"></a><a id="optimize"></a><a id="datasets"></a><a id="labels"></a><a id="synth"></a><a id="sim"></a><a id="bakeoff"></a><a id="training"></a><a id="runtime"></a><a id="devices"></a><a id="sync"></a><a id="team"></a><a id="errors"></a><a id="next"></a><a id="auth"></a>
  <code>#chat</code> &rarr; OpenAI-compatible chat group.
  <code>#messages</code> &rarr; Anthropic-compatible messages group.
  <code>#capture</code>, <code>#lake</code>, <code>#optimize</code>, <code>#datasets</code>, <code>#labels</code>, <code>#synth</code>, <code>#sim</code>, <code>#bakeoff</code>, <code>#training</code>, <code>#runtime</code>, <code>#devices</code>, <code>#sync</code>, <code>#team</code> jump to the matching group below.
</p>

${groupsHtml}

<script>
(function () {
  'use strict';
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  ready(function () {
    var form = document.querySelector('[data-api-search-form]');
    var search = document.querySelector('[data-api-search]');
    var clear = document.querySelector('[data-api-search-clear]');
    var liveOnly = document.querySelector('[data-api-live-only]');
    var status = document.querySelector('[data-api-search-status]');
    var routes = Array.prototype.slice.call(document.querySelectorAll('[data-api-route]'));
    var groups = Array.prototype.slice.call(document.querySelectorAll('[data-api-group]'));
    if (!search || !routes.length) return;
    function applyFilter() {
      var q = search.value.trim().toLowerCase();
      var onlyReady = !!(liveOnly && liveOnly.checked);
      var visible = 0;
      document.body.setAttribute('data-api-filter', onlyReady ? 'live' : 'all');
      routes.forEach(function (route) {
        var haystack = route.getAttribute('data-route-search') || '';
        var matchesText = !q || haystack.indexOf(q) !== -1;
        var matchesStatus = !onlyReady || route.getAttribute('data-route-status') === 'reference-ready';
        var show = matchesText && matchesStatus;
        route.hidden = !show;
        if (show) visible++;
      });
      groups.forEach(function (group) {
        var anyVisible = Array.prototype.some.call(group.querySelectorAll('[data-api-route]'), function (route) {
          return !route.hidden;
        });
        group.hidden = !anyVisible;
      });
      if (status) status.textContent = visible + ' of ' + routes.length + ' routes visible.';
    }
    if (form) form.addEventListener('submit', function (event) { event.preventDefault(); applyFilter(); });
    search.addEventListener('input', applyFilter);
    if (liveOnly) liveOnly.addEventListener('change', applyFilter);
    if (clear) clear.addEventListener('click', function () {
      search.value = '';
      search.focus();
      applyFilter();
    });
    applyFilter();
  });
})();
</script>

<h2 id="errors-envelope">Error envelope</h2>
<p>Every 4xx and 5xx response carries the same shape.</p>
<pre><code>{
  "error": {
    "code": "privacy_blocked",
    "message": "ssn class set to block in policy.json",
    "request_id": "req_018k",
    "details": { "class": "ssn", "namespace": "billing" }
  }
}</code></pre>

</div></main>

<footer><div class="wrap">
  kolm.ai &middot; the AI compiler
</div></footer>

</body>
</html>
`;
}

// ----------------- 4. MAIN -----------------

function main() {
  const parsed = ROUTE_SOURCES.map((src) => {
    const source = fs.readFileSync(src.file, 'utf8');
    return extractRoutes(source, src.label);
  });
  const routes = parsed.flatMap((p) => p.routes);
  const unparseable = parsed.flatMap((p) => p.unparseable);
  const grouped = groupRoutes(routes);

  // Total documented = sum of de-duplicated grouped routes (the "X documented
  // routes" line on the page).
  let total = 0;
  for (const [, arr] of grouped) total += arr.length;

  // Manifest JSON — re-emit in a stable, sorted shape for byte-identical output.
  const manifest = {
    generated: TODAY,
    source: 'src/router.js',
    sources: ROUTE_SOURCES.map((src) => src.label),
    total_routes: total,
    group_count: grouped.size,
    groups: Array.from(grouped.keys())
      .sort()
      .map((k) => ({
        key: k,
        label: groupLabelFor(k),
        routes: grouped.get(k).map((r) => ({
          method: r.method,
          path: r.path,
          line: r.line,
          source: r.source,
          short: shortDescriptionFor(r),
          comments: r.comments,
          stub: r.stub,
          expanded_from: r.expandedFrom || null,
        })),
      })),
    unparseable: unparseable,
  };

  const html = renderPage(grouped, total, unparseable);
  const json = JSON.stringify(manifest, null, 2) + '\n';

  fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true });

  // Idempotent write — skip if content matches.
  let touched = 0;
  for (const [filePath, content] of [
    [OUT_HTML, html],
    [OUT_JSON, json],
  ]) {
    let existing = null;
    try {
      existing = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
      existing = null;
    }
    if (existing !== content) {
      fs.writeFileSync(filePath, content);
      touched++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    'build-api-ref: total_routes=' +
      total +
      ' groups=' +
      grouped.size +
      ' unparseable=' +
      unparseable.length +
      ' touched=' +
      touched
  );
}

main();
