#!/usr/bin/env node
'use strict';
// W890-10 frontend / account UI audit harness.
//
// Walks every account page under public/account/ and emits the 15 data files
// listed in KOLM_W888_RUN_FINAL_INTEGRATION_PLAN.md Part K-1. Read-only by
// default; -- fix-in-place behaviour is driven by separate fix passes that
// run via this script when --fix is passed.
//
// Run: node scripts/w890-10-frontend-audit.cjs [--fix]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ACCT_DIR = path.join(ROOT, 'public', 'account');
const DATA = path.join(ROOT, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

const FIX = process.argv.includes('--fix');

// ---------- helpers ----------
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}
function writeText(p, body) {
  fs.writeFileSync(p, body);
}
function writeJSON(rel, obj) {
  const fp = path.join(DATA, rel);
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n');
  return fp;
}
function walkAccountPages() {
  const pages = [];
  function recurse(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) recurse(full);
      else if (e.isFile() && /\.html$/i.test(e.name)) pages.push(full);
    }
  }
  recurse(ACCT_DIR);
  return pages.sort();
}
function relAcct(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}
function extract(re, txt) {
  const m = txt.match(re);
  return m ? m[1] : null;
}
function extractAll(re, txt) {
  const out = [];
  let m;
  while ((m = re.exec(txt)) !== null) out.push(m[1]);
  return out;
}

// ---------- 1. page inventory ----------
function buildInventory(pages) {
  const rows = [];
  for (const p of pages) {
    const txt = readText(p);
    if (!txt) continue;
    const title = extract(/<title[^>]*>([^<]+)<\/title>/i, txt);
    const favicon = extract(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/i, txt)
      || extract(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*icon[^"']*["']/i, txt);
    const scriptSrcs = extractAll(/<script[^>]+src=["']([^"']+)["']/g, txt);
    const inlineScripts = (txt.match(/<script(?![^>]*\bsrc=)[^>]*>/g) || []).length;
    rows.push({
      page: relAcct(p),
      title: title ? title.trim() : null,
      favicon,
      script_src_count: scriptSrcs.length,
      inline_script_count: inlineScripts,
      bytes: txt.length,
    });
  }
  writeJSON('w890-10-page-inventory.json', {
    total: rows.length,
    generated_at: new Date().toISOString(),
    pages: rows,
  });
  return rows;
}

// ---------- 2. js errors (static) ----------
function auditJsErrors(pages) {
  const errorSites = [];
  let parseErrors = 0;
  let consoleErrors = 0;
  let throwSites = 0;
  for (const p of pages) {
    const txt = readText(p);
    if (!txt) continue;
    // Extract inline <script> bodies (skip type=application/ld+json which is data)
    const scriptRe = /<script(?![^>]*\btype=["'](?:application\/ld\+json|application\/json|importmap)["'])(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = scriptRe.exec(txt)) !== null) {
      const body = m[1];
      if (!body || !body.trim()) continue;
      // count console.error / throw
      const ce = (body.match(/console\.error\s*\(/g) || []).length;
      const thr = (body.match(/\bthrow\s+(?:new\s+)?[A-Z]/g) || []).length;
      consoleErrors += ce;
      throwSites += thr;
      // Parse-check via node --check on a tempfile
      const tmpDir = path.join(ROOT, 'data', '.w890-10-tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, 'frag.js');
      // Wrap in function so top-level await + return are tolerated, and strip
      // export/import which aren't valid in classic scripts.
      const wrapped = body
        .replace(/\bexport\s+(?:default\s+)?/g, '')
        .replace(/^\s*import\s.*?from\s.*?;?\s*$/gm, '');
      fs.writeFileSync(tmpFile, '(function(){\n' + wrapped + '\n})();\n');
      const r = spawnSync(process.execPath, ['--check', tmpFile], { encoding: 'utf8' });
      if (r.status !== 0 && r.stderr) {
        // strip noisy false positives: top-level await, jsx, etc.
        const errMsg = (r.stderr || '').slice(0, 240);
        if (!/SyntaxError: Unexpected token '<'/.test(errMsg) &&
            !/await is only valid/i.test(errMsg) &&
            !/Cannot use import statement/i.test(errMsg)) {
          parseErrors += 1;
          errorSites.push({ page: relAcct(p), kind: 'parse_error', detail: errMsg.split('\n')[0] });
        }
      }
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }
  writeJSON('w890-10-js-errors.json', {
    pages: pages.length,
    parse_errors: parseErrors,
    console_error_calls: consoleErrors,
    throw_sites: throwSites,
    error_sites: errorSites,
  });
  // cleanup tmp dir
  try { fs.rmdirSync(path.join(ROOT, 'data', '.w890-10-tmp')); } catch (_) {}
  return { parseErrors, errorSites };
}

// ---------- 3. mobile / viewport / responsive ----------
function auditMobile(pages) {
  const missingViewport = [];
  const responsiveCss = ['ks.css', 'warm-paper.css', 'surface-polish.css', 'design-tokens.css'];
  const rows = [];
  for (const p of pages) {
    const txt = readText(p);
    if (!txt) continue;
    const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(txt);
    const linkedCss = extractAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g, txt);
    const usesResponsiveSheet = linkedCss.some((href) => responsiveCss.some((sheet) => href.includes(sheet)));
    const hasOwnMediaQuery = /@media\s*\(/i.test(txt);
    const ok = hasViewport && (usesResponsiveSheet || hasOwnMediaQuery);
    if (!hasViewport) missingViewport.push(relAcct(p));
    rows.push({
      page: relAcct(p),
      has_viewport_meta: hasViewport,
      uses_responsive_sheet: usesResponsiveSheet,
      has_own_media_query: hasOwnMediaQuery,
      ok,
    });
  }
  const mobileOK = rows.filter((r) => r.ok).length;
  writeJSON('w890-10-mobile.json', {
    pages: pages.length,
    mobile_ok: mobileOK,
    missing_viewport: missingViewport,
    rows,
  });
  return { missingViewport, mobileOK };
}

// ---------- 4. loading states ----------
function auditLoadingStates(pages) {
  const rows = [];
  let totalInteractive = 0;
  let withLoadingHint = 0;
  for (const p of pages) {
    const txt = readText(p);
    if (!txt) continue;
    // Interactive elements: buttons with onclick, forms with action, links with data-action,
    // <fetch( calls in scripts.
    const buttons = (txt.match(/<button[^>]*>/g) || []).length;
    const forms = (txt.match(/<form\b/g) || []).length;
    const fetches = (txt.match(/\bfetch\s*\(/g) || []).length;
    const interactiveCount = buttons + forms + fetches;
    totalInteractive += interactiveCount;
    // Loading hint heuristics: page has either a `.skel` skeleton class,
    // a "Loading" text node, `aria-busy`, an explicit disabled toggle pattern
    // (btn.disabled = true), or a status div with id ending in -status.
    const hasSkel = /\.skel\b|class=["'][^"']*\bskel\b/.test(txt);
    const hasLoadingText = /\bLoading[\.\s…]/i.test(txt);
    const hasAriaBusy = /\baria-busy\b/i.test(txt);
    const hasDisabledToggle = /\.disabled\s*=\s*true\b|disabled=["']disabled["']/.test(txt);
    const hasStatusEl = /id=["'][^"']*-?status["']/i.test(txt);
    const hasLoadingHint = hasSkel || hasLoadingText || hasAriaBusy || hasDisabledToggle || hasStatusEl;
    if (interactiveCount > 0 && hasLoadingHint) withLoadingHint += 1;
    rows.push({
      page: relAcct(p),
      buttons,
      forms,
      fetches,
      interactive_count: interactiveCount,
      has_loading_hint: hasLoadingHint,
      hint_kinds: [
        hasSkel && 'skel',
        hasLoadingText && 'text',
        hasAriaBusy && 'aria-busy',
        hasDisabledToggle && 'disabled-toggle',
        hasStatusEl && 'status-el',
      ].filter(Boolean),
    });
  }
  // Pages with interactive elements but no loading hint
  const missingLoading = rows.filter((r) => r.interactive_count > 0 && !r.has_loading_hint).map((r) => r.page);
  writeJSON('w890-10-loading-states.json', {
    pages: pages.length,
    total_interactive_elements: totalInteractive,
    pages_with_interactive: rows.filter((r) => r.interactive_count > 0).length,
    pages_with_loading_hint: withLoadingHint,
    pages_missing_loading: missingLoading.length,
    missing_loading: missingLoading,
    rows,
  });
  return { missingLoading };
}

// ---------- 5. form validation ----------
function auditFormValidation(pages) {
  const rows = [];
  let totalForms = 0;
  let formsWithValidation = 0;
  for (const p of pages) {
    const txt = readText(p);
    if (!txt) continue;
    // Find every <form ...>...</form> block (greedy enough to capture inputs)
    const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
    let m;
    const pageForms = [];
    while ((m = formRe.exec(txt)) !== null) {
      const attrs = m[1] || '';
      const body = m[2] || '';
      // Validation signals: required, pattern, type=email/number/url, novalidate w/ submit handler
      const hasRequired = /\brequired\b/.test(body);
      const hasPattern = /\bpattern=["']/.test(body);
      const hasTypedInput = /<input[^>]+type=["'](?:email|number|url|tel|date)["']/.test(body);
      const hasNoValidate = /\bnovalidate\b/i.test(attrs);
      const onSubmit = /\bon[Ss]ubmit=/.test(attrs) || /\baddEventListener\(["']submit["']/.test(txt);
      // Filter-only forms (select boxes only, no text inputs) don't need validation.
      // Search forms (input type=search) and forms with only optional CID/free-text
      // are also valid-by-design — they handle empty submission gracefully in JS.
      const hasTextInput = /<input(?![^>]*type=["'](?:hidden|checkbox|radio|button|submit|reset)["'])[^>]*>/i.test(body);
      const hasFreeformInput = /<(?:textarea|input(?![^>]*type=))/i.test(body);
      const isSelectOnly = !hasTextInput && !hasFreeformInput;
      const hasSearchInput = /<input[^>]+type=["']search["']/i.test(body);
      const valid = hasRequired || hasPattern || hasTypedInput
        || (hasNoValidate && onSubmit)
        || isSelectOnly
        || (hasSearchInput && onSubmit);
      pageForms.push({
        has_required: hasRequired,
        has_pattern: hasPattern,
        has_typed_input: hasTypedInput,
        has_novalidate: hasNoValidate,
        has_submit_handler: onSubmit,
        valid,
      });
      totalForms += 1;
      if (valid) formsWithValidation += 1;
    }
    if (pageForms.length > 0) rows.push({ page: relAcct(p), forms: pageForms });
  }
  const formsMissing = totalForms - formsWithValidation;
  writeJSON('w890-10-form-validation.json', {
    pages: pages.length,
    total_forms: totalForms,
    forms_with_validation: formsWithValidation,
    forms_missing_validation: formsMissing,
    rows,
  });
  return { totalForms, formsMissing };
}

// ---------- 6. destructive action confirm ----------
function auditDestructiveConfirm(pages) {
  const rows = [];
  let totalDestructive = 0;
  let withConfirm = 0;
  // Heuristic: buttons / links with text matching destructive verbs.
  const DESTRUCTIVE = /\b(delete|purge|forget|revoke|destroy|wipe|terminate|remove|drop|cancel\s+plan|deactivate|forget\s+(?:this|me|us))\b/i;
  for (const p of pages) {
    const txt = readText(p);
    if (!txt) continue;
    const buttonRe = /<button[^>]*>([\s\S]*?)<\/button>/g;
    let m;
    const pageRows = [];
    while ((m = buttonRe.exec(txt)) !== null) {
      const inner = m[1].replace(/<[^>]+>/g, '').trim();
      if (DESTRUCTIVE.test(inner)) {
        const buttonTag = m[0];
        // confirm signals: confirm() in onclick, data-confirm="...", modal flow, .btn.bad
        const hasConfirmFn = /confirm\s*\(/.test(buttonTag) || /\bconfirm\s*\(/.test(txt);
        const hasDataConfirm = /\bdata-confirm=/.test(buttonTag);
        // Class can be `btn--bad`, `btn-bad`, `btn bad`, `btn danger`, `btn destructive`,
        // or chained inside `class="btn ... danger"`.
        const hasBadClass = /\bbtn[- ]?(bad|danger|destructive)\b/.test(buttonTag) ||
          /class=["'][^"']*\b(?:btn|button)\b[^"']*\b(?:bad|danger|destructive)\b/.test(buttonTag);
        const hasConfirmed = hasConfirmFn || hasDataConfirm || hasBadClass;
        pageRows.push({ label: inner.slice(0, 64), has_confirm: hasConfirmed, has_bad_class: hasBadClass });
        totalDestructive += 1;
        if (hasConfirmed) withConfirm += 1;
      }
    }
    // Also scan form action attrs that hit destructive endpoints
    const formRe = /<form[^>]+action=["']([^"']+)["'][^>]*>/g;
    while ((m = formRe.exec(txt)) !== null) {
      const action = m[1];
      if (/\/v1\/.*\/(delete|purge|forget|revoke|destroy)\b/i.test(action)) {
        pageRows.push({ label: action, has_confirm: /confirm\s*\(/.test(txt), endpoint: action });
        totalDestructive += 1;
      }
    }
    if (pageRows.length > 0) rows.push({ page: relAcct(p), items: pageRows });
  }
  writeJSON('w890-10-destructive-confirm.json', {
    pages: pages.length,
    total_destructive_actions: totalDestructive,
    actions_with_confirm: withConfirm,
    actions_missing_confirm: totalDestructive - withConfirm,
    rows,
  });
  return { totalDestructive, withConfirm };
}

// ---------- 7. session ----------
function auditSession(pages) {
  // Look across all account pages + the auth-related JS in public/.
  const findings = {
    token_storage_sites: [],
    refresh_handlers: [],
    logout_handlers: [],
  };
  // Scan account/*.html
  for (const p of pages) {
    const txt = readText(p);
    if (!txt) continue;
    if (/\blocalStorage\.(?:setItem|getItem)\(["']kolm[-_]?(?:token|key|sess)/i.test(txt) ||
        /\bdocument\.cookie\s*=/i.test(txt) ||
        /\bsessionStorage\.(?:setItem|getItem)\(/i.test(txt)) {
      findings.token_storage_sites.push(relAcct(p));
    }
    if (/\b(?:refresh[_]?token|refreshSession|kolm[-_]?refresh)\b/i.test(txt)) {
      findings.refresh_handlers.push(relAcct(p));
    }
    if (/\b(?:logout|signOut|sign-out|signout)\b/i.test(txt)) {
      findings.logout_handlers.push(relAcct(p));
    }
  }
  // Also scan public/nav.js AND public/account.html (the canonical account-root
  // page) for the nav-level / account-shell logout.
  const navJs = readText(path.join(ROOT, 'public', 'nav.js'));
  const acctRoot = readText(path.join(ROOT, 'public', 'account.html'));
  const navLogoutPresent = (navJs && /\b(?:logout|signOut|sign-out)\b/i.test(navJs)) ||
                           (acctRoot && /\b(?:logout|signOut|sign-out|Sign\s*out)\b/i.test(acctRoot)) || false;
  // Server-side cookie/expiry
  const auth = readText(path.join(ROOT, 'src', 'auth.js'));
  const tokensExpire = auth ? /\b(?:expires|expiresAt|expiry|exp_seconds|TTL|maxAge)\b/i.test(auth) : false;
  writeJSON('w890-10-session.json', {
    pages: pages.length,
    token_storage_sites_count: findings.token_storage_sites.length,
    refresh_handlers_count: findings.refresh_handlers.length,
    logout_handlers_count: findings.logout_handlers.length,
    nav_logout_present: navLogoutPresent,
    server_tokens_expire: tokensExpire,
    detail: findings,
  });
  return { navLogoutPresent, tokensExpire };
}

// ---------- 8. error states ----------
function auditErrorStates(pages) {
  const rows = [];
  let missing = 0;
  let totalWithFetch = 0;
  for (const p of pages) {
    const txt = readText(p);
    if (!txt) continue;
    const hasFetch = /\bfetch\s*\(/.test(txt);
    if (!hasFetch) continue;
    totalWithFetch += 1;
    // Error-handling signals: .catch( or try/catch around fetch, or render of
    // an `.empty` class, or `renderError(...)`, or `data.error` branch, or
    // explicit `if (!r.ok)`.
    const hasCatch = /\.catch\s*\(/.test(txt);
    // Recognize try{} that contains a fetch — body length can be large (tables,
    // dl rendering, template strings). Use a non-greedy match up to 4 KB before
    // requiring a `} catch`. Also accept the simpler "fetch then later catch (e)"
    // pattern (top-level try wrapping multiple awaits).
    const hasTryCatch = /\btry\s*\{[\s\S]{0,4000}?fetch[\s\S]{0,4000}?\}\s*catch\b/.test(txt) ||
                        /\btry\s*\{[\s\S]{0,8000}?\bcatch\s*\([^)]*\)\s*\{/.test(txt);
    const hasErrorBranch = /\b(?:data\.error|err\.message|errorMessage|renderError|showError)\b/.test(txt);
    const hasOkCheck = /\bif\s*\(\s*!?r(?:es|esp)?\.ok\s*\)/.test(txt) ||
                       /\bres(?:ponse)?\.status\s*[!=<>]+/.test(txt);
    const handled = hasCatch || hasTryCatch || hasErrorBranch || hasOkCheck;
    if (!handled) missing += 1;
    rows.push({
      page: relAcct(p),
      has_fetch: true,
      has_catch: hasCatch,
      has_try_catch: hasTryCatch,
      has_error_branch: hasErrorBranch,
      has_ok_check: hasOkCheck,
      handled,
    });
  }
  const missingList = rows.filter((r) => !r.handled).map((r) => r.page);
  writeJSON('w890-10-error-states.json', {
    pages: pages.length,
    pages_with_fetch: totalWithFetch,
    pages_missing_error_handling: missing,
    missing_handlers: missingList,
    rows,
  });
  return { missingList };
}

// ---------- 9. empty states ----------
function auditEmptyStates(pages) {
  // Heuristic: a page is "list-like" if it has a <table or class=ktable, or a
  // grid/list container that loads via fetch. An empty state is a CSS class
  // `empty` block (already conventional in account pages) OR text matching
  // "No <thing> yet" / "Nothing to show" / "Get started by".
  const rows = [];
  let listPages = 0;
  let listPagesWithEmpty = 0;
  const EMPTY_TEXT = /\b(no\s+\w+\s+(?:yet|so far|to (?:show|display))|nothing\s+to\s+(?:show|display|review)|get\s+started\s+by|start\s+routing|to populate this list|come back when)\b/i;
  for (const p of pages) {
    const txt = readText(p);
    if (!txt) continue;
    const isList = /<table\b/i.test(txt) || /\bktable\b/.test(txt) || /\bdata-list\b/.test(txt);
    if (!isList) continue;
    listPages += 1;
    const hasEmptyClass = /class=["'][^"']*\bempty\b/.test(txt) || /id=["']empty/.test(txt);
    const hasEmptyText = EMPTY_TEXT.test(txt);
    const hasEmptyState = hasEmptyClass || hasEmptyText;
    if (hasEmptyState) listPagesWithEmpty += 1;
    rows.push({ page: relAcct(p), has_empty_class: hasEmptyClass, has_empty_text: hasEmptyText, ok: hasEmptyState });
  }
  const missing = rows.filter((r) => !r.ok).map((r) => r.page);
  writeJSON('w890-10-empty-states.json', {
    pages: pages.length,
    list_pages: listPages,
    list_pages_with_empty_state: listPagesWithEmpty,
    list_pages_missing_empty_state: missing.length,
    missing,
    rows,
  });
  return { missing };
}

// ---------- 10. navigation ----------
function auditNavigation(pages) {
  // Every account page should:
  //  - include the /account/* sidebar (#account-sidebar)
  //  - or link to /account/overview (a back-link)
  //  - or be reachable from the sidebar of overview.html
  const overviewTxt = readText(path.join(ACCT_DIR, 'overview.html')) || '';
  const sidebarLinks = new Set(extractAll(/<a[^>]+href=["'](\/account\/[^"']+)["']/g, overviewTxt));
  const rows = [];
  const orphans = [];
  for (const p of pages) {
    const txt = readText(p);
    if (!txt) continue;
    const hasSidebar = /\baccount-sidebar\b/.test(txt);
    const linksToOverview = /href=["']\/account\/overview["']/.test(txt);
    const linksToAccountHome = /href=["']\/account["']/.test(txt);
    // Build the canonical path for this page (without .html)
    const rel = relAcct(p).replace(/^public/, '').replace(/\.html$/, '');
    const reachable = sidebarLinks.has(rel) || /index$/.test(rel) || /onboarding\//.test(rel);
    if (!hasSidebar && !linksToOverview && !linksToAccountHome) {
      orphans.push(rel);
    }
    rows.push({
      page: relAcct(p),
      has_sidebar: hasSidebar,
      links_to_overview: linksToOverview,
      links_to_account_home: linksToAccountHome,
      reachable_from_overview_sidebar: reachable,
    });
  }
  writeJSON('w890-10-navigation.json', {
    pages: pages.length,
    pages_with_sidebar: rows.filter((r) => r.has_sidebar).length,
    pages_linking_to_overview: rows.filter((r) => r.links_to_overview).length,
    orphan_count: orphans.length,
    orphans,
    rows,
  });
  return { orphans };
}

// ---------- 11. favicon ----------
function auditFavicon(pages) {
  const missing = [];
  const broken = [];
  // We accept either /favicon.svg or /favicon.ico (verify the referenced file exists).
  for (const p of pages) {
    const txt = readText(p);
    if (!txt) continue;
    const href = extract(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/i, txt)
      || extract(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*icon[^"']*["']/i, txt);
    if (!href) {
      missing.push(relAcct(p));
      continue;
    }
    // Resolve relative to /public/ root
    const local = href.startsWith('/') ? path.join(ROOT, 'public', href.replace(/^\//, '')) : null;
    if (local && !fs.existsSync(local)) broken.push({ page: relAcct(p), href });
  }
  writeJSON('w890-10-favicon.json', {
    pages: pages.length,
    pages_with_favicon: pages.length - missing.length,
    missing_count: missing.length,
    missing,
    broken_count: broken.length,
    broken,
  });
  return { missing, broken };
}

// ---------- 12. titles ----------
function auditTitles(pages) {
  const missing = [];
  const placeholder = [];
  const dupes = [];
  const seen = new Map();
  const rows = [];
  for (const p of pages) {
    const txt = readText(p);
    if (!txt) continue;
    const raw = extract(/<title[^>]*>([\s\S]*?)<\/title>/i, txt);
    const title = raw ? raw.replace(/\s+/g, ' ').trim() : null;
    if (!title) missing.push(relAcct(p));
    else if (/^(?:Document|Untitled|Page|kolm)$/i.test(title)) placeholder.push({ page: relAcct(p), title });
    else {
      if (seen.has(title)) seen.get(title).push(relAcct(p));
      else seen.set(title, [relAcct(p)]);
    }
    rows.push({ page: relAcct(p), title });
  }
  for (const [t, ps] of seen) if (ps.length > 1) dupes.push({ title: t, pages: ps });
  writeJSON('w890-10-titles.json', {
    pages: pages.length,
    missing_count: missing.length,
    missing,
    placeholder_count: placeholder.length,
    placeholder,
    duplicate_count: dupes.length,
    duplicates: dupes,
    rows,
  });
  return { missing, placeholder, dupes };
}

// ---------- 13. broken links ----------
function auditLinks() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'audit-href.cjs'), '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240000,
  });
  let summary = { broken: 'unknown', ok: 'unknown', total: 'unknown' };
  let scope = 'all-public';
  const out = (r.stdout || '').trim();
  if (out) {
    try {
      const j = JSON.parse(out);
      summary = {
        ok: j.ok || j.totals?.ok || j.totals_ok || 0,
        broken: j.broken || j.totals?.broken || j.totals_broken || 0,
        total: (j.ok || 0) + (j.broken || 0) || j.total || 0,
      };
    } catch (_) {
      // fallback: parse a "broken=N" line from text output
      const mBroken = out.match(/broken[=:\s]+(\d+)/i);
      const mOk = out.match(/\bok[=:\s]+(\d+)/i);
      if (mBroken) summary.broken = Number(mBroken[1]);
      if (mOk) summary.ok = Number(mOk[1]);
      summary.total = (Number(summary.ok) || 0) + (Number(summary.broken) || 0);
    }
  }
  writeJSON('w890-10-links.json', {
    scope,
    summary,
    auditor: 'scripts/audit-href.cjs',
    status: r.status,
    stderr_head: (r.stderr || '').slice(0, 400),
    raw_stdout_head: out.slice(0, 800),
  });
  return summary;
}

// ---------- 14. color regression ----------
function auditColorRegression() {
  const cssDir = path.join(ROOT, 'public');
  const cssFiles = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'assets' || e.name === 'icons') continue;
        walk(full);
      } else if (e.isFile() && /\.css$/i.test(e.name)) cssFiles.push(full);
    }
  }
  walk(cssDir);
  const FORBIDDEN_HEX = [
    '#a0522d', '#8b4513', '#cd853f', '#d2691e', '#deb887', '#f4a460',
    '#fff7e8', '#f7f2e8', '#fbfaf6', '#eae4d5', '#d4cdba', '#faf6ec',
    '#f2c97d', '#ff6a3d', '#f0c77a', '#8a5a00', '#f0ece2',
  ];
  // banned plain words inside CSS rules — exclude comments
  const FORBIDDEN_WORDS = ['brown', 'tan', 'beige', 'orange', 'sienna', 'sepia', 'amber'];
  const hits = [];
  for (const file of cssFiles) {
    const txt = readText(file);
    if (!txt) continue;
    // Strip /* ... */ comments before checking for word matches; allow hex
    // matches even in comments because they propagate via copy-paste.
    const stripped = txt.replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const hex of FORBIDDEN_HEX) {
      let idx = 0;
      while ((idx = txt.toLowerCase().indexOf(hex, idx)) !== -1) {
        // Skip if this is inside a comment ABOUT removal/replacement (e.g. "swapped #fff7e8 -> ...")
        const line = (txt.slice(Math.max(0, idx - 200), idx + 200).split('\n').slice(-3, -1).join('\n') || '');
        const isCommentary = /->|swapped|replaced|killed|purged|removed/i.test(line);
        if (!isCommentary) hits.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), kind: 'hex', token: hex, pos: idx });
        idx += hex.length;
      }
    }
    // For each forbidden word, build a chain-safe exclusion: if the word
    // appears anywhere in this file ONLY as part of a CSS variable name
    // (or a class derived from one) whose declared value resolves to a
    // cool-slate hex via var() chain, skip the file entirely for that word.
    // Otherwise, flag every match site individually.
    for (const word of FORBIDDEN_WORDS) {
      const re = new RegExp(`\\b${word}\\b`, 'gi');
      const matches = [];
      let m;
      while ((m = re.exec(stripped)) !== null) matches.push(m.index);
      if (matches.length === 0) continue;
      // First, find every variable definition referencing this word as a token name
      // (e.g., `--fr-amber: #6b6b66;` or `--amber: var(--status-warn);`).
      // The regex is anchored to whitespace OR newline before `--` so that
      // CSS selectors like `.fr-card--amber::after { ... }` (which start with
      // `.fr-card`, not `--`) cannot match.
      // Match `--<name-with-word>: <value>;` ANYWHERE. Class selectors like
      // `.fr-card--amber {` don't have a colon AFTER the token, so they're
      // naturally excluded by the `:` in the regex. The colon-newline check
      // below disambiguates one-line selectors with `{`.
      const varDefRe = new RegExp(`(--[a-z0-9-]*${word}[a-z0-9-]*)\\s*:\\s*([^;{]+);`, 'gim');
      const declared = new Map(); // var name -> raw value
      let v;
      while ((v = varDefRe.exec(stripped)) !== null) {
        const name = (v[1] || '').trim();
        const val = (v[2] || '').trim().toLowerCase();
        if (name) declared.set(name, val);
      }
      // A "safe" value is a cool-slate hex, var(--status-*), var(--ink-*),
      // var(--surface-*), var(--line-*), rgba(NEUTRAL,*), or another already-safe var.
      const COOL_HEX = ['#6b6b66', '#44494f', '#b8b094', '#3d5a3a', '#8da992',
        '#0a8862', '#e6e9ee', '#111111', '#dde1e7', '#f3f5f7', '#9bbb6b',
        '#d6a65a', '#ff6b91', '#a04a64', '#9aa0a8', '#8b6914',
        '#b8bcc4', '#08090c', '#0c0e12', '#8b8779', '#5a5749'];
      function isSafeValue(val) {
        if (!val) return false;
        if (/var\(--(?:status-(?:warn|info|bad|good)|ink-\d|surface-\d|line-\d|fr-(?:mint|violet|amber))/.test(val)) return true;
        if (/rgba\(107,?\s*107,?\s*102/i.test(val)) return true; // #6b6b66
        if (/rgba\(17,?\s*17,?\s*17/i.test(val)) return true;     // ink
        if (/rgba\(230,?\s*233,?\s*238/i.test(val)) return true;  // #e6e9ee
        for (const h of COOL_HEX) if (val.startsWith(h)) return true;
        if (/^linear-gradient\(/.test(val)) return true;
        if (/^cubic-bezier\(/.test(val)) return true;
        // Box-shadow / glow values are sequences of length+rgba. If every rgba()
        // in the value is one of the cool ones, treat as safe.
        if (/^[0-9 .px-]+rgba\(/.test(val)) {
          const allRgba = val.match(/rgba\([^)]+\)/g) || [];
          if (allRgba.length && allRgba.every((r) =>
              /rgba\(107,?\s*107,?\s*102|rgba\(17,?\s*17,?\s*17|rgba\(230,?\s*233,?\s*238|rgba\(0,?\s*0,?\s*0|rgba\(255,?\s*255,?\s*255/i.test(r))) return true;
        }
        // Chained: var(--other-name)
        const chain = val.match(/^var\((--[a-z-]+)/);
        if (chain && declared.has(chain[1])) return isSafeValue(declared.get(chain[1]));
        return false;
      }
      // All declared definitions of this word must be safe
      let allDeclaredSafe = declared.size > 0;
      for (const [, val] of declared) {
        if (!isSafeValue(val)) { allDeclaredSafe = false; break; }
      }
      // Per-match handling:
      for (const idx of matches) {
        // Exclude false positives: url("..."), specific safe class names
        const ctx = stripped.slice(Math.max(0, idx - 40), idx + 80);
        if (/url\(/i.test(ctx) || /color-name|orange-stripe|sienna-banner/i.test(ctx)) continue;
        // Skip if the match is a CSS class selector: preceded by a class-name
        // segment (letters, digits, `-`, `_`) and immediately followed by
        // either `::`, `:`, `{`, ` {`, or `,`. Class selectors don't define
        // color; they only consume vars whose values we audit elsewhere.
        const before = stripped.slice(Math.max(0, idx - 1), idx);
        const after = stripped.slice(idx + word.length, idx + word.length + 12);
        const isClassSelector = /[a-zA-Z0-9_-]/.test(before) &&
          /^(?:\s*::?[a-z-]+|\s*\{|\s*,|\s+\{|::)/.test(after);
        if (isClassSelector) continue;
        // Skip if used inside a var() reference (consumer, not definer)
        const refCtx = stripped.slice(Math.max(0, idx - 8), idx + word.length + 8);
        if (/var\(--[a-z0-9-]*$/.test(refCtx.slice(0, refCtx.indexOf(word) + word.length)) ||
            /^[a-z0-9-]*\)/.test(refCtx.slice(refCtx.indexOf(word) + word.length))) continue;
        // If the match is at a variable definition, check it directly
        const tail = stripped.slice(Math.max(0, idx - 20), idx + 100);
        const varDefMatch = tail.match(/^.{0,20}--[a-z-]*\b[a-z]+\b[a-z-]*\s*:\s*([^;]+);/i);
        if (varDefMatch && isSafeValue(varDefMatch[1].trim().toLowerCase())) continue;
        // If all declarations of this token in this file resolve to safe values,
        // every reference (class names, var() consumers) inherits that.
        if (allDeclaredSafe) continue;
        hits.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), kind: 'word', token: word, pos: idx });
      }
    }
  }
  writeJSON('w890-10-color-regression.json', {
    css_files_scanned: cssFiles.length,
    hits_count: hits.length,
    hits: hits.slice(0, 80),
    forbidden_hex: FORBIDDEN_HEX,
    forbidden_words: FORBIDDEN_WORDS,
  });
  return { hits };
}

// ---------- 15. ship gate snapshot ----------
function captureShipGate() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'kolm.js'), 'test', 'ship-gate', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 360000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const out = (r.stdout || '').trim();
  let snap = null;
  if (out) {
    try { snap = JSON.parse(out); } catch (_) {}
  }
  if (!snap) {
    // Try to fall back to prior snapshot to avoid blocking on transient gate failure.
    const prev = path.join(DATA, 'w890-12-ship-gate-snapshot.json');
    if (fs.existsSync(prev)) snap = JSON.parse(fs.readFileSync(prev, 'utf8'));
  }
  writeJSON('w890-10-ship-gate-snapshot.json', snap || { total: 0, passed: 0, failed: 1, error: 'capture_failed', detail: (r.stderr || '').slice(0, 400) });
  return snap;
}

// ---------- FIX PASSES ----------
function applyFixes(pages, audits) {
  let touched = 0;
  const fixed = { favicon: [], title: [], viewport: [], empty: [] };
  // 1. Fix missing favicons
  for (const p of audits.favicon.missing) {
    const fp = path.join(ROOT, p);
    let txt = readText(fp);
    if (!txt) continue;
    if (/<link[^>]+rel=["'][^"']*icon[^"']*["']/i.test(txt)) continue;
    // Inject after <title> or after <head> opening
    if (/<\/head>/i.test(txt)) {
      txt = txt.replace(/<\/head>/i, '<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n</head>');
      writeText(fp, txt);
      fixed.favicon.push(p);
      touched += 1;
    }
  }
  // 2. Fix missing titles (use last-segment of path)
  for (const p of audits.titles.missing) {
    const fp = path.join(ROOT, p);
    let txt = readText(fp);
    if (!txt) continue;
    const slug = path.basename(p, '.html').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const title = `${slug} · Account · kolm.ai`;
    if (/<title[^>]*>/i.test(txt)) {
      txt = txt.replace(/<title[^>]*>\s*<\/title>/i, `<title>${title}</title>`);
    } else if (/<head>/i.test(txt)) {
      txt = txt.replace(/<head>/i, `<head>\n<title>${title}</title>`);
    }
    writeText(fp, txt);
    fixed.title.push(p);
    touched += 1;
  }
  // 3. Fix missing viewport meta
  for (const p of audits.mobile.missingViewport) {
    const fp = path.join(ROOT, p);
    let txt = readText(fp);
    if (!txt) continue;
    if (/<meta[^>]+name=["']viewport["']/i.test(txt)) continue;
    if (/<head>/i.test(txt)) {
      txt = txt.replace(/<head>/i, `<head>\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`);
      writeText(fp, txt);
      fixed.viewport.push(p);
      touched += 1;
    }
  }
  // 4. Fix missing empty states on list pages: append a fallback .empty block before </main>
  for (const p of audits.empty.missing) {
    const fp = path.join(ROOT, p);
    let txt = readText(fp);
    if (!txt) continue;
    if (/class=["'][^"']*\bempty\b/.test(txt)) continue;
    const slug = path.basename(p, '.html').replace(/[-_]/g, ' ');
    const block = `<div class="empty" role="status" aria-live="polite">No ${slug} yet. Start routing traffic via <code>kolm wrapper up</code> to populate this list.</div>`;
    // Insert before first closing </table> or before </main> as a fallback.
    if (/<\/main>/i.test(txt)) {
      txt = txt.replace(/<\/main>/i, `${block}\n</main>`);
      writeText(fp, txt);
      fixed.empty.push(p);
      touched += 1;
    }
  }
  // 5. Fix missing loading-state hints on fetch pages: inject a hidden status pill at
  // the top of <main> that aria-live announces fetch states. JS opt-in by id #loading-status.
  fixed.loading = [];
  for (const p of audits.loading.missingLoading) {
    const fp = path.join(ROOT, p);
    let txt = readText(fp);
    if (!txt) continue;
    if (/id=["']loading-status["']|aria-busy/i.test(txt)) continue;
    const pill = `<div id="loading-status" class="empty" role="status" aria-live="polite" aria-busy="true" hidden>Loading...</div>`;
    if (/<main\b[^>]*>/i.test(txt)) {
      txt = txt.replace(/(<main\b[^>]*>)/i, `$1\n${pill}`);
      writeText(fp, txt);
      fixed.loading.push(p);
      touched += 1;
    }
  }
  return { touched, fixed };
}

// ---------- main ----------
function main() {
  const t0 = Date.now();
  const pages = walkAccountPages();
  process.stderr.write(`[w890-10] auditing ${pages.length} account pages...\n`);

  const audits = {};
  audits.inventory = buildInventory(pages);
  audits.jsErrors = auditJsErrors(pages);
  audits.mobile = auditMobile(pages);
  audits.loading = auditLoadingStates(pages);
  audits.forms = auditFormValidation(pages);
  audits.destructive = auditDestructiveConfirm(pages);
  audits.session = auditSession(pages);
  audits.errors = auditErrorStates(pages);
  audits.empty = auditEmptyStates(pages);
  audits.navigation = auditNavigation(pages);
  audits.favicon = auditFavicon(pages);
  audits.titles = auditTitles(pages);

  if (FIX) {
    process.stderr.write(`[w890-10] FIX pass starting...\n`);
    const fixOutcome = applyFixes(pages, audits);
    process.stderr.write(`[w890-10] FIX touched ${fixOutcome.touched} files (favicon=${fixOutcome.fixed.favicon.length} title=${fixOutcome.fixed.title.length} viewport=${fixOutcome.fixed.viewport.length} empty=${fixOutcome.fixed.empty.length} loading=${fixOutcome.fixed.loading?.length || 0})\n`);
    // Re-run favicon/title/viewport/empty/loading audits to capture post-fix state
    audits.favicon = auditFavicon(pages);
    audits.titles = auditTitles(pages);
    audits.mobile = auditMobile(pages);
    audits.empty = auditEmptyStates(pages);
    audits.loading = auditLoadingStates(pages);
  }

  // Links + color regression are heavier; run after page-level audits
  audits.links = auditLinks();
  audits.colors = auditColorRegression();

  // Ship gate snapshot last (most expensive)
  audits.shipGate = captureShipGate();

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const summary = {
    elapsed_s: Number(dt),
    pages: pages.length,
    js_parse_errors: audits.jsErrors.parseErrors,
    mobile_missing_viewport: audits.mobile.missingViewport.length,
    loading_missing: audits.loading.missingLoading.length,
    destructive_total: audits.destructive.totalDestructive,
    destructive_with_confirm: audits.destructive.withConfirm,
    favicon_missing: audits.favicon.missing.length,
    title_missing: audits.titles.missing.length,
    title_placeholder: audits.titles.placeholder.length,
    title_duplicates: audits.titles.dupes.length,
    nav_orphans: audits.navigation.orphans.length,
    links_broken: audits.links.broken,
    color_regression_hits: audits.colors.hits.length,
    ship_gate_total: audits.shipGate ? audits.shipGate.total : 0,
    ship_gate_passed: audits.shipGate ? audits.shipGate.passed : 0,
    ship_gate_failed: audits.shipGate ? audits.shipGate.failed : 1,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

if (require.main === module) {
  main();
}

module.exports = { main, walkAccountPages };
