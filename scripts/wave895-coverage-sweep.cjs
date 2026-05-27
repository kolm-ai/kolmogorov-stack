#!/usr/bin/env node
// W895 — extend W894 coverage:
//   1. add `kolm-account-surface` to every public/account/**/*.html body
//   2. add nav.js + canonical-chrome placeholders to 3 W893 stragglers
//      that have stale pre-baked nav (questionnaire, demo, spec/toml)
//   3. retune one residual warm-paper #faf9f7 in book-demo.html to cool slate
//
// Idempotent: re-running is a no-op on already-fixed files.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function walk(dir, acc = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (p.endsWith('.html')) acc.push(p);
  }
  return acc;
}

// ---------- 1. account body-class sweep -----------------------------------

function ensureAccountSurfaceClass(file) {
  const src = fs.readFileSync(file, 'utf8');

  // <body class="..."> — augment
  const withClass = /<body\b([^>]*)\bclass="([^"]*)"/i;
  if (withClass.test(src)) {
    const next = src.replace(withClass, (m, pre, cls) => {
      if (/\bkolm-account-surface\b/.test(cls)) return m;
      const newCls = cls.trim() ? `kolm-account-surface ${cls}` : 'kolm-account-surface';
      return `<body${pre}class="${newCls}"`;
    });
    if (next !== src) {
      fs.writeFileSync(file, next);
      return 'augmented';
    }
    return 'already';
  }

  // <body ...> (no class attr) — inject class attr
  const bareBody = /<body\b([^>]*)>/i;
  if (bareBody.test(src)) {
    const next = src.replace(bareBody, (m, attrs) => {
      // Don't double-inject if some quirky variant already has kolm-account-surface
      if (/kolm-account-surface/.test(m)) return m;
      return `<body${attrs} class="kolm-account-surface">`;
    });
    if (next !== src) {
      fs.writeFileSync(file, next);
      return 'injected';
    }
  }

  return 'no-body-tag';
}

const accountFiles = walk(path.join(PUBLIC, 'account'));
const accountStats = { augmented: 0, injected: 0, already: 0, 'no-body-tag': 0 };
for (const f of accountFiles) {
  const r = ensureAccountSurfaceClass(f);
  accountStats[r] = (accountStats[r] || 0) + 1;
}
console.log(`[1] account body class: total=${accountFiles.length}  ` +
  Object.entries(accountStats).map(([k, v]) => `${k}=${v}`).join('  '));

// ---------- 2. W893 nav stragglers ----------------------------------------
// Their pre-baked <nav class="ks-nav"> already renders chrome — we just need
// nav.js loaded for theme toggle + mega-menu + mobile sheet. Don't strip the
// pre-baked nav (risk of layout regression) and don't add a placeholder
// (would double-render).

const STRAGGLERS = [
  path.join(PUBLIC, 'security', 'questionnaire.html'),
  path.join(PUBLIC, 'demo.html'),
  path.join(PUBLIC, 'spec', 'toml.html'),
];

let stragglerFixed = 0;
for (const f of STRAGGLERS) {
  if (!fs.existsSync(f)) {
    console.log(`[2] MISSING file: ${f}`);
    continue;
  }
  const src = fs.readFileSync(f, 'utf8');
  if (/src="\/nav\.js"/.test(src)) {
    continue;
  }
  // Inject right before </body> if present, else right before </html>
  let next;
  if (/<\/body>/i.test(src)) {
    next = src.replace(/<\/body>/i, '<script src="/nav.js" defer></script>\n</body>');
  } else if (/<\/html>/i.test(src)) {
    next = src.replace(/<\/html>/i, '<script src="/nav.js" defer></script>\n</html>');
  } else {
    next = src + '\n<script src="/nav.js" defer></script>\n';
  }
  fs.writeFileSync(f, next);
  stragglerFixed += 1;
}
console.log(`[2] W893 nav stragglers: fixed=${stragglerFixed}/${STRAGGLERS.length}`);

// ---------- 3. book-demo.html cool-slate retune ---------------------------
// Single residual #faf9f7 lives in a [data-theme="light"] .bd-card rule —
// swap to cool slate #f3f5f7 to match the W850 design tokens.

const bookDemo = path.join(PUBLIC, 'book-demo.html');
if (fs.existsSync(bookDemo)) {
  const src = fs.readFileSync(bookDemo, 'utf8');
  if (src.includes('#faf9f7')) {
    const next = src.replace(/#faf9f7/g, '#f3f5f7');
    fs.writeFileSync(bookDemo, next);
    console.log('[3] book-demo.html: #faf9f7 -> #f3f5f7');
  } else {
    console.log('[3] book-demo.html: clean');
  }
} else {
  console.log('[3] book-demo.html: not found');
}

console.log('\nW895 sweep done.');
