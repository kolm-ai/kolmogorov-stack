#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const CRITICAL_ROUTES = [
  '/',
  '/compiler-product',
  '/platform',
  '/integrations',
  '/runtimes',
  '/compare',
  '/docs',
  '/pricing',
  '/enterprise',
  '/signup',
  '/dashboard',
  '/account/overview',
  '/account/api-control-center',
  '/docs/api',
  '/trust',
  '/security',
];

const DEFAULT_VIEWPORTS = {
  desktop: {
    width: 1440,
    height: 960,
    userAgent: undefined,
  },
  mobile: {
    width: 390,
    height: 844,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
};

const AUDIT_HOST_REDIRECT_PREFIX = 'https://audit.kolm.ai/';

const GENERATED_MEDIA_REQUIRED_ROUTES = new Set([
  '/compiler-product',
  '/platform',
  '/integrations',
  '/runtimes',
  '/compare',
  '/docs',
  '/pricing',
  '/enterprise',
  '/docs/api',
  '/trust',
  '/security',
  '/capabilities',
  '/changelog',
  '/contact',
  '/research',
  '/how-it-works',
]);

function routeRequiresGeneratedMedia(route) {
  return GENERATED_MEDIA_REQUIRED_ROUTES.has(route);
}

async function auditHostRedirect(url) {
  try {
    const res = await fetch(url, { redirect: 'manual' });
    const location = res.headers.get('location') || '';
    if (res.status >= 300 && res.status < 400 && location) {
      const absolute = new URL(location, url).toString();
      if (absolute.startsWith(AUDIT_HOST_REDIRECT_PREFIX)) {
        return { status: res.status, location: absolute };
      }
    }
  } catch (e) {
    // The browser pass below will report the navigational failure with context.
  }
  return null;
}

function allowedConsoleError(route, message) {
  if (route === '/account-billing' && /\b401\b|Unauthorized/i.test(message)) return true;
  return false;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq >= 0) {
      out[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function walkHtmlRoutes(dir = PUBLIC_DIR, files = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkHtmlRoutes(full, files);
      continue;
    }
    if (!ent.isFile() || !ent.name.endsWith('.html')) continue;
    const rel = path.relative(PUBLIC_DIR, full).replace(/\\/g, '/');
    let route;
    if (rel === 'index.html') route = '/';
    else if (rel.endsWith('/index.html')) route = '/' + rel.slice(0, -'/index.html'.length);
    else route = '/' + rel.slice(0, -'.html'.length);
    files.push(route.replace(/\/+/g, '/'));
  }
  return Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
}

function pickRoutes(args, allRoutes) {
  if (args.routes) {
    return args.routes.split(',').map(s => s.trim()).filter(Boolean);
  }
  const base = args.all ? allRoutes : CRITICAL_ROUTES;
  const routeSet = new Set(allRoutes);
  const picked = base.filter(r => routeSet.has(r));
  const missing = base.filter(r => !routeSet.has(r));
  if (missing.length) {
    console.warn(`ui-surface-audit: ${missing.length} requested critical routes are not static files: ${missing.join(', ')}`);
  }
  if (args.limit) return picked.slice(0, Number(args.limit));
  return picked;
}

function slug(route) {
  if (route === '/') return 'home';
  return route.replace(/^\//, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-');
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function outputLines(s, max = 12000) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '\n[truncated]\n' : s;
}

function parseViewportNames(args) {
  const raw = args.viewports || 'desktop,mobile';
  return raw.split(',').map(s => s.trim()).filter(Boolean).filter(name => DEFAULT_VIEWPORTS[name]);
}

function parseThemes(args) {
  const raw = args.themes || 'dark';
  const picked = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const allowed = new Set(['dark', 'light']);
  return picked.filter(name => allowed.has(name)).length ? picked.filter(name => allowed.has(name)) : ['dark'];
}

function runLabel(viewportName, themeName) {
  return themeName === 'dark' ? viewportName : `${viewportName}-${themeName}`;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < end) {
    try {
      const r = await fetch(new URL('/health', base));
      if (r.ok) return true;
      lastErr = new Error(`status ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 350));
  }
  throw new Error(`local server did not become healthy: ${lastErr ? lastErr.message : 'timeout'}`);
}

async function startLocalServer() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-ui-audit-'));
  const env = {
    ...process.env,
    PORT: String(port),
    KOLM_DATA_DIR: path.join(temp, 'data'),
    KOLM_HOME: path.join(temp, 'home', '.kolm'),
    HOME: path.join(temp, 'home'),
    USERPROFILE: path.join(temp, 'home'),
    ADMIN_KEY: 'ui-audit-admin',
    RECIPE_RECEIPT_SECRET: 'ui-audit-receipt-secret',
    KOLM_DISABLE_RATE_LIMIT: '1',
    KOLM_CONNECTOR_FIXTURE: '1',
    NO_COLOR: '1',
  };
  ensureDir(env.HOME);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', b => logs.push(String(b)));
  child.stderr.on('data', b => logs.push(String(b)));
  await waitForHealth(base);
  return {
    base,
    env,
    temp,
    logs,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    },
  };
}

async function provisionAnon(base) {
  try {
    const r = await fetch(new URL('/v1/anon/bootstrap', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ user_agent: 'ui-surface-audit', hostname: os.hostname() }),
    });
    if (!r.ok) return { ok: false, status: r.status, token: '' };
    const json = await r.json();
    return { ok: true, status: r.status, token: json.anon_token || json.api_key || '', tenant_id: json.tenant_id || '' };
  } catch (e) {
    return { ok: false, status: 0, token: '', error: e.message };
  }
}

async function runCommand(name, args, env, outDir, timeoutMs = 25000) {
  const started = Date.now();
  return await new Promise(resolve => {
    const child = spawn(process.execPath, ['cli/kolm.js', ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...env,
        NO_COLOR: '1',
        KOLM_NO_INTERACTIVE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', b => { stdout += String(b); });
    child.stderr.on('data', b => { stderr += String(b); });
    child.on('close', code => {
      clearTimeout(timer);
      const transcript = [
        `$ node cli/kolm.js ${args.join(' ')}`,
        '',
        'STDOUT:',
        outputLines(stdout),
        '',
        'STDERR:',
        outputLines(stderr),
        '',
        `exit=${code} duration_ms=${Date.now() - started}`,
      ].join('\n');
      const file = path.join(outDir, `${name}.txt`);
      fs.writeFileSync(file, transcript);
      resolve({ name, args, code, duration_ms: Date.now() - started, stdout: outputLines(stdout, 3000), stderr: outputLines(stderr, 3000), file });
    });
  });
}

async function runCliSurfaceChecks(base, auth, serverEnv, outDir) {
  const cliDir = path.join(outDir, 'cli-tui');
  ensureDir(cliDir);
  const env = {
    ...serverEnv,
    KOLM_BASE: base,
    KOLM_BASE_URL: base,
  };
  if (auth && auth.token) env.KOLM_API_KEY = auth.token;
  const commands = [
    ['root-help', ['--help']],
    // Doctor probes Python, GPU, package imports, and network reachability.
    // On Windows GPU workstations that can legitimately exceed the generic
    // 25s CLI smoke budget even when it exits successfully.
    ['doctor-json', ['doctor', '--json'], 60000],
    ['whoami-json', ['whoami', '--json']],
    ['billing-tiers-json', ['billing', 'tiers', '--json']],
    ['tui-help', ['tui', '--help']],
    ['chat-tui-help', ['chat-tui', '--help']],
  ];
  const results = [];
  for (const [name, argv, timeoutMs] of commands) {
    results.push(await runCommand(name, argv, env, cliDir, timeoutMs || 25000));
  }
  return results;
}

async function evaluateRoute(page, route, viewportName, themeName) {
  const findings = [];
  const metrics = await page.evaluate(({ viewportName }) => {
    function visible(el) {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    const doc = document.documentElement;
    const body = document.body;
    const header = document.querySelector('header.site-header, header.site');
    const h1 = document.querySelector('h1');
    const navLinks = Array.from(document.querySelectorAll('header .nav__links a, header.site-header nav a, header.site-header .site-nav > .nav-item > a.nav-top, header.site-header .site-nav > a, header.site .left nav a, body > .site-nav a'))
      .filter(visible)
      .map(a => (a.textContent || '').trim().replace(/\s+/g, ' '));
    function controlName(el) {
      const labelledBy = (el.getAttribute('aria-labelledby') || '').trim();
      const labelledText = labelledBy
        ? labelledBy.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(node => (node.textContent || '').trim()).join(' ')
        : '';
      const labelEl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const text = [
        el.getAttribute('aria-label'),
        labelledText,
        labelEl ? labelEl.textContent : '',
        el.getAttribute('alt'),
        el.getAttribute('title'),
        el.getAttribute('value'),
        el.textContent,
      ].filter(Boolean).join(' ');
      return text.trim().replace(/\s+/g, ' ');
    }
    const interactiveEls = Array.from(document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])'))
      .filter(visible)
      .filter(el => !el.disabled && el.getAttribute('aria-hidden') !== 'true');
    const controlContracts = interactiveEls.map(el => {
      const r = el.getBoundingClientRect();
      const targetEl = (el.matches('input[type="checkbox"], input[type="radio"]') && el.closest('label, .kolm-check-hit')) || el;
      const targetRect = targetEl.getBoundingClientRect();
      const rawHref = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
      const name = controlName(el);
      const actionLike = el.matches('button, input, select, textarea, summary, [role="button"], a.btn, a.cta, a.button, .nav-top, .theme-toggle, .nav-toggle, .kolm-product-spine a, .site-actions a, .site-nav a, .account-nav a, .tabs a, .actions a')
        || !!el.closest('header, .site-actions, .site-nav, .kolm-product-spine, .account-nav, .tabs, .actions, .hero-actions, .cta-row, .pagination, [role="tablist"]');
      let hashTargetMissing = false;
      if (rawHref.startsWith('#') && rawHref.length > 1) hashTargetMissing = !document.getElementById(rawHref.slice(1));
      return {
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') || '').toLowerCase(),
        role: el.getAttribute('role') || '',
        name: name.slice(0, 120),
        label: (name || el.className || el.tagName).toString().trim().replace(/\s+/g, ' ').slice(0, 80),
        href: rawHref,
        target: el.getAttribute('target') || '',
        rel: el.getAttribute('rel') || '',
        width: Math.round(r.width),
        height: Math.round(r.height),
        targetWidth: Math.round(targetRect.width),
        targetHeight: Math.round(targetRect.height),
        actionLike,
        hashTargetMissing,
      };
    });
    const smallTargets = controlContracts
      .filter(c => c.actionLike && (c.targetWidth < 38 || c.targetHeight < 38))
      .slice(0, 8);
    const namelessControls = controlContracts
      .filter(c => !c.name && !(c.tag === 'input' && ['hidden', 'submit', 'button'].includes(c.type)))
      .slice(0, 8);
    const invalidActionHrefs = controlContracts
      .filter(c => c.tag === 'a' && (!c.href || c.href === '#' || /^javascript:/i.test(c.href)))
      .slice(0, 8);
    const missingHashTargets = controlContracts
      .filter(c => c.tag === 'a' && c.hashTargetMissing)
      .slice(0, 8);
    const unsafeBlankTargets = controlContracts
      .filter(c => c.tag === 'a' && c.target === '_blank' && !/\bnoopener\b/i.test(c.rel))
      .slice(0, 8);
    const bodyText = (body.innerText || '').replace(/\s+/g, ' ').trim();
    const h1Style = h1 ? getComputedStyle(h1) : null;
    const homeMedia = document.querySelector('.kolm-hero-system');
    const generatedMedia = document.querySelector('.kolm-surface-media');
    const media = homeMedia || generatedMedia;
    const mediaRect = media ? media.getBoundingClientRect() : null;
    const compilerHero = document.querySelector('.compiler-hero');
    const compilerHeroWrap = compilerHero ? compilerHero.querySelector(':scope > .wrap') : null;
    const compilerHeroWrapRect = compilerHeroWrap ? compilerHeroWrap.getBoundingClientRect() : null;
    return {
      title: document.title || '',
      htmlTheme: doc.getAttribute('data-theme') || 'dark',
      bodyTextLength: bodyText.length,
      hasHeader: !!header,
      headerClass: header ? header.className : '',
      bodyClass: body.className || '',
      hasSurfaceCss: !!document.querySelector('link[href*="surface-polish.css"], link[href*="kolm-2026.css"], link[href*="kolm-main.css"]'),
      hasCompilerCss: !!document.querySelector('link[href*="kolm-main.css"]'),
      hasNavWidget: !!document.querySelector('.nav__toggle, .nav__links'),
      hasNavScript: !!document.querySelector('script[src*="nav.js"], script[src*="kolm-main.js"], script[src*="kolm-2026.js"]'),
      navLinks,
      h1Text: h1 ? (h1.textContent || '').trim().replace(/\s+/g, ' ') : '',
      h1FontSize: h1Style ? h1Style.fontSize : '',
      h1LetterSpacing: h1Style ? h1Style.letterSpacing : '',
      bodyFont: getComputedStyle(body).fontFamily,
      overflowX: Math.max(0, doc.scrollWidth - window.innerWidth),
      scrollWidth: doc.scrollWidth,
      innerWidth: window.innerWidth,
      compilerHeroClipX: compilerHero ? Math.max(0, compilerHero.scrollWidth - compilerHero.clientWidth) : 0,
      compilerHeroWrapOverflowX: compilerHeroWrapRect ? Math.max(0, Math.round(compilerHeroWrapRect.right - window.innerWidth)) : 0,
      interactiveCount: controlContracts.length,
      namelessControls,
      invalidActionHrefs,
      missingHashTargets,
      unsafeBlankTargets,
      smallTargets,
      hasHomeMedia: !!homeMedia,
      hasGeneratedMedia: !!generatedMedia,
      mediaVisible: !!media && visible(media),
      mediaWidth: mediaRect ? Math.round(mediaRect.width) : 0,
      mediaHeight: mediaRect ? Math.round(mediaRect.height) : 0,
      mediaTextLength: media ? ((media.innerText || '').replace(/\s+/g, ' ').trim().length) : 0,
      viewportName,
    };
  }, { viewportName });

  const requiresGeneratedMedia = routeRequiresGeneratedMedia(route);
  if (!metrics.title || metrics.title.length < 3) findings.push({ severity: 'fail', rule: 'title', message: 'missing useful document title' });
  if (metrics.bodyTextLength < 40) findings.push({ severity: 'fail', rule: 'content', message: 'surface rendered nearly empty' });
  if (metrics.overflowX > 2) findings.push({ severity: 'fail', rule: 'horizontal-overflow', message: `scrollWidth exceeds viewport by ${metrics.overflowX}px` });
  if (viewportName === 'mobile' && (metrics.compilerHeroClipX > 2 || metrics.compilerHeroWrapOverflowX > 2)) {
    findings.push({ severity: 'fail', rule: 'clipped-hero-content', message: `compiler hero clips ${metrics.compilerHeroClipX}px; wrapper exceeds viewport by ${metrics.compilerHeroWrapOverflowX}px` });
  }
  if (themeName === 'light' && metrics.htmlTheme !== 'light') findings.push({ severity: 'fail', rule: 'light-mode', message: `expected light theme, got ${metrics.htmlTheme}` });
  if (route === '/' && !metrics.hasHomeMedia) findings.push({ severity: 'fail', rule: 'product-media', message: 'home hero product media missing' });
  if (requiresGeneratedMedia && !metrics.hasGeneratedMedia) findings.push({ severity: 'fail', rule: 'product-media', message: 'route-specific generated media missing' });
  if ((route === '/' || requiresGeneratedMedia) && (!metrics.mediaVisible || metrics.mediaWidth < 280 || metrics.mediaHeight < 100 || metrics.mediaTextLength < 80)) {
    findings.push({ severity: 'fail', rule: 'product-media-visible', message: `media weak or invisible (${metrics.mediaWidth}x${metrics.mediaHeight}, text ${metrics.mediaTextLength})` });
  }
  if (!metrics.h1Text && !route.startsWith('/account/')) findings.push({ severity: 'warn', rule: 'h1', message: 'missing visible h1' });
  if (!metrics.hasSurfaceCss) findings.push({ severity: 'warn', rule: 'shared-css', message: 'shared surface CSS is not loaded' });
  if (/\bcompiler-site\b/.test(metrics.bodyClass) && !metrics.hasCompilerCss) findings.push({ severity: 'warn', rule: 'compiler-css', message: 'kolm-main.css is not loaded on compiler surface' });
  if (metrics.hasNavWidget && !metrics.hasNavScript) findings.push({ severity: 'warn', rule: 'nav-js', message: 'navigation script is not loaded' });
  if (metrics.h1LetterSpacing && /^-/.test(metrics.h1LetterSpacing)) findings.push({ severity: 'fail', rule: 'tracking', message: `negative h1 letter-spacing: ${metrics.h1LetterSpacing}` });
  if (metrics.namelessControls.length) findings.push({ severity: 'fail', rule: 'control-name', message: `visible controls without accessible names: ${metrics.namelessControls.map(t => `${t.tag}${t.href ? ` ${t.href}` : ''} ${t.width}x${t.height}`).join('; ')}` });
  if (metrics.invalidActionHrefs.length) findings.push({ severity: 'fail', rule: 'action-href', message: `visible action links with invalid hrefs: ${metrics.invalidActionHrefs.map(t => `${t.label || t.tag} -> ${t.href || '(empty)'}`).join('; ')}` });
  if (metrics.missingHashTargets.length) findings.push({ severity: 'fail', rule: 'hash-target', message: `visible hash links without matching targets: ${metrics.missingHashTargets.map(t => `${t.label || t.tag} -> ${t.href}`).join('; ')}` });
  if (metrics.unsafeBlankTargets.length) findings.push({ severity: 'warn', rule: 'blank-target-rel', message: `target=_blank links missing noopener: ${metrics.unsafeBlankTargets.map(t => `${t.label || t.tag} -> ${t.href}`).join('; ')}` });
  if (metrics.smallTargets.length) findings.push({ severity: 'warn', rule: 'target-size', message: `small action targets: ${metrics.smallTargets.map(t => `${t.label || 'control'} ${t.targetWidth || t.width}x${t.targetHeight || t.height}`).join('; ')}` });
  if (viewportName === 'desktop' && metrics.hasHeader) {
    for (const label of ['Docs', 'Pricing']) {
      if (!metrics.navLinks.includes(label)) findings.push({ severity: 'fail', rule: 'primary-nav', message: `missing desktop nav label: ${label}` });
    }
    if (!metrics.navLinks.some(label => ['Product', 'Pipeline', 'Platform'].includes(label))) {
      findings.push({ severity: 'fail', rule: 'primary-nav', message: 'missing desktop product/platform nav label' });
    }
  }
  return { metrics, findings };
}

async function exerciseKeyboardPath(page) {
  const findings = [];
  const focusableCount = await page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    return Array.from(document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])'))
      .filter(el => visible(el) && !el.disabled && el.getAttribute('aria-hidden') !== 'true')
      .length;
  }).catch(() => 0);
  if (!focusableCount) return findings;

  await page.keyboard.press('Home').catch(() => {});
  const maxTabs = Math.min(8, focusableCount);
  const seen = [];
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab').catch(e => findings.push({ severity: 'fail', rule: 'keyboard-tab', message: e.message }));
    await page.waitForTimeout(20);
    const state = await page.evaluate(() => {
      function controlName(el) {
        if (!el) return '';
        const labelledBy = (el.getAttribute('aria-labelledby') || '').trim();
        const labelledText = labelledBy
          ? labelledBy.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(node => (node.textContent || '').trim()).join(' ')
          : '';
        const labelEl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
        return [el.getAttribute('aria-label'), labelledText, labelEl ? labelEl.textContent : '', el.getAttribute('title'), el.getAttribute('value'), el.textContent]
          .filter(Boolean).join(' ').trim().replace(/\s+/g, ' ');
      }
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return { tag: 'body', visible: false, width: 0, height: 0, top: 0, left: 0, name: '' };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0 && r.width > 0 && r.height > 0;
      return {
        tag: el.tagName.toLowerCase(),
        visible,
        width: Math.round(r.width),
        height: Math.round(r.height),
        top: Math.round(r.top),
        left: Math.round(r.left),
        name: controlName(el).slice(0, 80),
      };
    }).catch(() => null);
    if (!state) continue;
    if (state.tag === 'body' || state.tag === 'html') {
      if (seen.some(s => s.tag !== 'body' && s.tag !== 'html')) break;
      findings.push({ severity: 'fail', rule: 'keyboard-tab', message: `${focusableCount} focusable controls exist but first Tab landed on ${state.tag}` });
      break;
    }
    seen.push(state);
    if (!state.visible) {
      findings.push({ severity: 'fail', rule: 'keyboard-tab', message: `tab ${i + 1} landed on hidden/unmeasurable ${state.tag || 'element'}` });
      break;
    }
    if (state.width < 1 || state.height < 1) {
      findings.push({ severity: 'fail', rule: 'keyboard-tab', message: `tab ${i + 1} landed on zero-size ${state.tag || 'element'}` });
      break;
    }
  }
  if (!seen.some(s => s.tag !== 'body')) {
    findings.push({ severity: 'fail', rule: 'keyboard-tab', message: `${focusableCount} focusable controls exist but Tab did not reach a visible control` });
  }
  return findings;
}

async function exerciseInteractions(page, route, viewportName, screenshotName, screenshotDir) {
  const findings = [];
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(40);
  const hasTheme = await page.locator('.theme-toggle').first().isVisible().catch(() => false);
  if (hasTheme) {
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme') || 'dark');
    await page.locator('.theme-toggle').first().click({ timeout: 3000 }).catch(e => findings.push({ severity: 'fail', rule: 'theme-toggle', message: e.message }));
    await page.waitForTimeout(80);
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme') || 'dark');
    if (after === before) findings.push({ severity: 'fail', rule: 'theme-toggle', message: 'theme toggle did not change html[data-theme]' });
    await page.locator('.theme-toggle').first().click({ timeout: 3000 }).catch(() => {});
  }

  if (viewportName === 'mobile') {
    const hasToggle = await page.locator('.nav-toggle').first().isVisible().catch(() => false);
    if (hasToggle) {
      await page.locator('.nav-toggle').first().click({ timeout: 3000 }).catch(e => findings.push({ severity: 'fail', rule: 'mobile-nav', message: e.message }));
      await page.waitForTimeout(120);
      const open = await page.evaluate(() => {
        const btn = document.querySelector('.nav-toggle');
        const nav = document.querySelector('.site-nav');
        return !!btn && btn.getAttribute('aria-expanded') === 'true' && !!nav && nav.classList.contains('is-open');
      });
      if (!open) findings.push({ severity: 'fail', rule: 'mobile-nav', message: 'mobile nav did not open with aria-expanded=true and .is-open' });
      await page.screenshot({ path: path.join(screenshotDir, `${slug(route)}__${screenshotName}__nav-open.png`), fullPage: false }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  if (viewportName === 'desktop') {
    const topCount = await page.locator('header.site-header .site-nav .nav-item.has-mega > a.nav-top').count().catch(() => 0);
    for (let i = 0; i < topCount; i++) {
      const top = page.locator('header.site-header .site-nav .nav-item.has-mega > a.nav-top').nth(i);
      const label = (await top.textContent().catch(() => '') || '').trim();
      await top.hover({ timeout: 3000 }).catch(e => findings.push({ severity: 'fail', rule: 'mega-menu', message: `${label || 'nav'} hover failed: ${e.message}` }));
      await page.waitForTimeout(80);
      const open = await top.evaluate(el => {
        const item = el.closest('.nav-item');
        const menu = item && item.querySelector('.mega-menu');
        if (!menu) return false;
        const cs = getComputedStyle(menu);
        return cs.visibility !== 'hidden' && cs.opacity !== '0' && menu.getBoundingClientRect().height > 0;
      }).catch(() => false);
      if (!open) findings.push({ severity: 'fail', rule: 'mega-menu', message: `${label || 'nav'} mega menu did not open on hover` });
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  findings.push(...await exerciseKeyboardPath(page));
  return findings;
}

async function main() {
  const args = parseArgs(process.argv);
  const allRoutes = walkHtmlRoutes();
  const routes = pickRoutes(args, allRoutes);
  const viewportNames = parseViewportNames(args);
  const themeNames = parseThemes(args);
  const outDir = path.resolve(ROOT, args.out || path.join('reports', 'ui-surface-audit', nowStamp()));
  const screenshotDir = path.join(outDir, 'screenshots');
  ensureDir(screenshotDir);

  let server = null;
  let base = args.base || '';
  if (!base) {
    server = await startLocalServer();
    base = server.base;
  }
  base = String(base).replace(/\/+$/, '');

  const auth = args['no-auth'] ? { ok: false, token: '' } : await provisionAnon(base);
  const cliResults = args['no-cli'] ? [] : await runCliSurfaceChecks(base, auth, server ? server.env : {}, outDir);

  console.log(`ui-surface-audit: ${routes.length} routes x ${viewportNames.length} viewports`);
  console.log(`base: ${base}`);
  console.log(`out: ${outDir}`);
  console.log(`auth: ${auth.ok ? `anon tenant ${auth.tenant_id || 'provisioned'}` : `not provisioned (${auth.status || auth.error || 'disabled'})`}`);

  const browser = await chromium.launch();
  const results = [];
  try {
    for (const themeName of themeNames) {
    for (const viewportName of viewportNames) {
      const vp = DEFAULT_VIEWPORTS[viewportName];
      const label = runLabel(viewportName, themeName);
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: themeName,
        userAgent: vp.userAgent,
      });
      await context.addInitScript(theme => {
        try {
          localStorage.setItem('kolm-theme', theme);
          if (theme === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
            document.documentElement.style.colorScheme = 'light';
          } else {
            localStorage.setItem('kolm-theme', 'dark');
            document.documentElement.removeAttribute('data-theme');
            document.documentElement.style.colorScheme = 'dark';
          }
        } catch (e) {} // deliberate: cleanup
      }, themeName);
      if (auth.ok && auth.token) {
        await context.addInitScript(token => {
          try { localStorage.setItem('ks_api_key', token); } catch (e) {} // deliberate: cleanup
        }, auth.token);
      }
      for (const route of routes) {
        const url = new URL(route, `${base}/`).toString();
        const consoleErrors = [];
        const result = { route, viewport: label, theme: themeName, url, status: 0, screenshot: '', findings: [], consoleErrors };
        const redirect = await auditHostRedirect(url);
        if (redirect) {
          result.status = redirect.status;
          result.redirect = redirect.location;
          result.skipped = 'audit-host-redirect';
          results.push(result);
          console.log(`OK   ${label.padEnd(13)} ${route} audit-host redirect`);
          continue;
        }

        const page = await context.newPage();
        page.on('console', msg => {
          if (msg.type() === 'error') consoleErrors.push(msg.text());
        });
        page.on('pageerror', err => {
          consoleErrors.push(err.message);
        });

        try {
          const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(args.timeout || 20000) });
          result.status = resp ? resp.status() : 0;
          await page.waitForTimeout(Number(args.settle || 450));
          if (!resp || result.status >= 400) {
            result.findings.push({ severity: 'fail', rule: 'http-status', message: `HTTP ${result.status || 'no response'}` });
          }
          const evalResult = await evaluateRoute(page, route, viewportName, themeName);
          result.metrics = evalResult.metrics;
          result.findings.push(...evalResult.findings);
          const shot = path.join(screenshotDir, `${slug(route)}__${label}.png`);
          await page.screenshot({ path: shot, fullPage: false });
          result.screenshot = path.relative(outDir, shot).replace(/\\/g, '/');
          result.findings.push(...await exerciseInteractions(page, route, viewportName, label, screenshotDir));
          await page.keyboard.press('Escape').catch(() => {});
          await page.mouse.move(1, 1).catch(() => {});
          const actionableConsoleErrors = consoleErrors.filter(message => !allowedConsoleError(route, message));
          result.consoleErrors = actionableConsoleErrors;
          if (actionableConsoleErrors.length) {
            result.findings.push({ severity: 'fail', rule: 'console-error', message: actionableConsoleErrors.slice(0, 3).join(' | ') });
          }
        } catch (e) {
          result.findings.push({ severity: 'fail', rule: 'exception', message: e.message });
        } finally {
          await page.close().catch(() => {});
        }
        results.push(result);
        const fails = result.findings.filter(f => f.severity === 'fail').length;
        const warns = result.findings.filter(f => f.severity === 'warn').length;
        console.log(`${fails ? 'FAIL' : 'OK  '} ${label.padEnd(13)} ${route} ${fails ? `${fails} fail` : ''}${warns ? ` ${warns} warn` : ''}`);
      }
      await context.close();
    }
    }
  } finally {
    await browser.close();
    if (server) await server.stop();
  }

  for (const cmd of cliResults) {
    if (cmd.code !== 0) {
      results.push({
        route: `cli:${cmd.name}`,
        viewport: 'terminal',
        status: cmd.code,
        screenshot: path.relative(outDir, cmd.file).replace(/\\/g, '/'),
        findings: [{ severity: 'fail', rule: 'cli-exit', message: `${cmd.name} exited ${cmd.code}` }],
      });
    }
  }

  const flatFindings = results.flatMap(r => r.findings.map(f => ({ ...f, route: r.route, viewport: r.viewport })));
  const failCount = flatFindings.filter(f => f.severity === 'fail').length;
  const warnCount = flatFindings.filter(f => f.severity === 'warn').length;
  const uiResults = results.filter(r => r.metrics);
  const interactionControls = uiResults.reduce((sum, r) => sum + Number(r.metrics.interactiveCount || 0), 0);
  const generatedMediaRenders = uiResults.filter(r => r.metrics.hasGeneratedMedia || r.metrics.hasHomeMedia).length;
  const report = {
    ok: failCount === 0,
    generated_at: new Date().toISOString(),
    base,
    all_static_routes: allRoutes.length,
    audited_routes: routes.length,
    viewports: viewportNames,
    themes: themeNames,
    auth: { ok: !!auth.ok, tenant_id: auth.tenant_id || '', status: auth.status || 0 },
    totals: {
      results: results.length,
      failures: failCount,
      warnings: warnCount,
      ui_renders: uiResults.length,
      interactive_controls_reviewed: interactionControls,
      product_media_renders: generatedMediaRenders,
    },
    cli: cliResults.map(c => ({ name: c.name, code: c.code, duration_ms: c.duration_ms, file: path.relative(outDir, c.file).replace(/\\/g, '/') })),
    results,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const md = [
    '# UI Surface Audit',
    '',
    `Generated: ${report.generated_at}`,
    `Base: ${base}`,
    `Routes audited: ${routes.length} of ${allRoutes.length}`,
    `Viewports: ${viewportNames.join(', ')}`,
    `Themes: ${themeNames.join(', ')}`,
    `Auth: ${auth.ok ? `anon tenant ${auth.tenant_id || 'provisioned'}` : 'not provisioned'}`,
    '',
    `Result: ${report.ok ? 'PASS' : 'FAIL'} (${failCount} failures, ${warnCount} warnings)`,
    '',
    '## Failures',
    '',
    ...(flatFindings.filter(f => f.severity === 'fail').length
      ? flatFindings.filter(f => f.severity === 'fail').map(f => `- ${f.viewport} ${f.route}: ${f.rule} - ${f.message}`)
      : ['- None']),
    '',
    '## Warnings',
    '',
    ...(flatFindings.filter(f => f.severity === 'warn').length
      ? flatFindings.filter(f => f.severity === 'warn').slice(0, 200).map(f => `- ${f.viewport} ${f.route}: ${f.rule} - ${f.message}`)
      : ['- None']),
    '',
    '## Interaction Coverage',
    '',
    `- UI renders inspected: ${uiResults.length}`,
    `- Visible interactive controls reviewed: ${interactionControls}`,
    `- Product media renders verified: ${generatedMediaRenders}`,
    '',
    '## CLI/TUI',
    '',
    ...(report.cli.length ? report.cli.map(c => `- ${c.name}: exit ${c.code}, ${c.file}`) : ['- Not run']),
    '',
    '## Screenshots',
    '',
    `Screenshots are under ${path.relative(ROOT, screenshotDir).replace(/\\/g, '/')}/.`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), md);
  console.log(`summary: ${report.ok ? 'PASS' : 'FAIL'} (${failCount} failures, ${warnCount} warnings)`);
  console.log(`report: ${path.relative(ROOT, path.join(outDir, 'report.md')).replace(/\\/g, '/')}`);
  if (!report.ok && !args['no-fail']) process.exit(1);
}

main().catch(async err => {
  console.error(`ui-surface-audit fatal: ${err.stack || err.message}`);
  process.exit(1);
});
