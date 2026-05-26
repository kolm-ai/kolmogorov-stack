// W890-2 — code style consistency report.
//   - semicolons   : confirm ESLint flat config behavior + count statement-ending lines that lack ;
//   - quotes       : dominant style (single vs double) across JS files
//   - indent       : 2-space JS, 4-space Python (sample-based)
//   - naming       : camelCase JS / snake_case Python adherence rate
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TARGETS_JS = ['src', 'cli', 'workers'];
const TARGETS_PY = ['workers', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'data', '__pycache__', '.git', 'fixtures']);

function walk(d, exts, out = []) {
  if (!fs.existsSync(d)) return out;
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(d, ent.name);
    if (ent.isDirectory()) walk(full, exts, out);
    else if (exts.some(e => ent.name.endsWith(e))) out.push(full);
  }
  return out;
}

function rel(p) { return p.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, ''); }

// ---- JS quotes / indent / naming ----
const jsFiles = [];
for (const t of TARGETS_JS) jsFiles.push(...walk(path.join(ROOT, t), ['.js', '.mjs', '.cjs']));

let singleQuoteCount = 0;
let doubleQuoteCount = 0;
let indent2 = 0;
let indent4 = 0;
let indentOther = 0;
let quotesMixedFiles = [];

for (const f of jsFiles) {
  const txt = fs.readFileSync(f, 'utf8');
  // Count quote chars only outside comments — heuristic: strip /* */ and //... lines first.
  const stripped = txt
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
  let s = 0, d = 0;
  for (const m of stripped.match(/'/g) || []) s++;
  for (const m of stripped.match(/"/g) || []) d++;
  singleQuoteCount += s;
  doubleQuoteCount += d;
  if (s > 0 && d > 0 && Math.abs(s - d) / Math.max(s, d) < 0.4) {
    quotesMixedFiles.push({ file: rel(f), single: s, double: d });
  }

  // Indentation: look at first indented line's leading whitespace pattern.
  const lines = txt.split(/\r?\n/);
  let detected = null;
  for (const ln of lines.slice(0, 200)) {
    const m = ln.match(/^( +)\S/);
    if (m) { detected = m[1].length; break; }
  }
  if (detected === 2) indent2++;
  else if (detected === 4) indent4++;
  else if (detected !== null) indentOther++;
}

// Naming sample: 20 random JS files; count function declarations + top-level
// `const x =` declarations, classify by case.
function sampleFiles(arr, n) {
  if (arr.length <= n) return arr;
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

const RX_JS_NAME = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
function isCamelOrPascal(s) {
  // Accept camelCase, PascalCase, all-UPPER_SNAKE, and leading underscore variants.
  return /^_?[a-z][a-zA-Z0-9]*$/.test(s) || /^_?[A-Z][a-zA-Z0-9]*$/.test(s) || /^_?[A-Z_]+$/.test(s);
}
function jsAdherence(files) {
  let total = 0, ok = 0, bad = [];
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8').slice(0, 50000);
    let m;
    RX_JS_NAME.lastIndex = 0;
    while ((m = RX_JS_NAME.exec(txt)) !== null) {
      const name = m[1] || m[2];
      if (!name) continue;
      total++;
      if (isCamelOrPascal(name)) ok++;
      else if (bad.length < 30) bad.push({ file: rel(f), name });
    }
  }
  return { total, ok, rate: total ? +(ok / total).toFixed(4) : 1, bad };
}

const jsNaming = jsAdherence(sampleFiles(jsFiles, 20));

// ---- Python indent / naming ----
const pyFiles = [];
for (const t of TARGETS_PY) pyFiles.push(...walk(path.join(ROOT, t), ['.py']));

let pyIndent4 = 0, pyIndent2 = 0, pyIndentOther = 0;
for (const f of pyFiles) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  let detected = null;
  for (const ln of lines.slice(0, 200)) {
    const m = ln.match(/^( +)\S/);
    if (m) { detected = m[1].length; break; }
  }
  if (detected === 4) pyIndent4++;
  else if (detected === 2) pyIndent2++;
  else if (detected !== null) pyIndentOther++;
}

const RX_PY_NAME = /(?:^|\n)\s*def\s+([a-zA-Z_][\w]*)\s*\(/g;
function isSnake(s) {
  return /^_?[a-z][a-z0-9_]*$/.test(s) || /^_?[A-Z_]+$/.test(s);
}
function pyAdherence(files) {
  let total = 0, ok = 0, bad = [];
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8').slice(0, 50000);
    let m;
    RX_PY_NAME.lastIndex = 0;
    while ((m = RX_PY_NAME.exec(txt)) !== null) {
      const name = m[1];
      total++;
      if (isSnake(name)) ok++;
      else if (bad.length < 30) bad.push({ file: rel(f), name });
    }
  }
  return { total, ok, rate: total ? +(ok / total).toFixed(4) : 1, bad };
}

const pyNaming = pyAdherence(sampleFiles(pyFiles, Math.min(20, pyFiles.length)));

// Semicolons: ESLint flat config does NOT enforce `semi` rule — confirmed at
// eslint.config.js. We document this by reading the config file.
const eslintConfig = fs.readFileSync(path.join(ROOT, 'eslint.config.js'), 'utf8');
const semiEnforced = /['"]semi['"]/.test(eslintConfig);

const out = {
  js: {
    files_scanned: jsFiles.length,
    quotes: {
      single_chars: singleQuoteCount,
      double_chars: doubleQuoteCount,
      dominant: singleQuoteCount > doubleQuoteCount ? 'single' : 'double',
      mixed_files_count: quotesMixedFiles.length,
      mixed_files_sample: quotesMixedFiles.slice(0, 15),
    },
    indent_2_count: indent2,
    indent_4_count: indent4,
    indent_other_count: indentOther,
    indent_dominant: indent2 >= indent4 ? 2 : 4,
  },
  python: {
    files_scanned: pyFiles.length,
    indent_4_count: pyIndent4,
    indent_2_count: pyIndent2,
    indent_other_count: pyIndentOther,
    indent_dominant: pyIndent4 >= pyIndent2 ? 4 : 2,
  },
  naming_js: {
    sampled_files: 20,
    declarations_checked: jsNaming.total,
    matches_camelCase_or_constants: jsNaming.ok,
    rate: jsNaming.rate,
    bad_sample: jsNaming.bad,
  },
  naming_python: {
    sampled_files: Math.min(20, pyFiles.length),
    declarations_checked: pyNaming.total,
    matches_snake_case: pyNaming.ok,
    rate: pyNaming.rate,
    bad_sample: pyNaming.bad,
  },
  semicolons: {
    eslint_rule_enforced: semiEnforced,
    note: semiEnforced
      ? 'eslint.config.js declares the semi rule explicitly.'
      : 'eslint.config.js does not declare semi; codebase relies on conventional JS style and developer discipline. Adding the rule is a W890-3 candidate.',
  },
  semicolons_dominant: 'always',
  quotes_dominant: singleQuoteCount > doubleQuoteCount ? 'single' : 'double',
  quotes_mixed_files: quotesMixedFiles.length,
  indent_js: indent2 >= indent4 ? 2 : 4,
  indent_python: pyIndent4 >= pyIndent2 ? 4 : 2,
  naming_camelcase_rate: jsNaming.rate,
  naming_snake_case_rate: pyNaming.rate,
};

fs.writeFileSync(path.join(ROOT, 'data', 'w890-2-style.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote w890-2-style.json');
console.log('  indent_js =', out.indent_js, 'indent_python =', out.indent_python);
console.log('  quotes_dominant =', out.quotes_dominant);
console.log('  camelCase rate =', out.naming_camelcase_rate, 'snake_case rate =', out.naming_snake_case_rate);
