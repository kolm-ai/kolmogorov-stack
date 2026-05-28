// One-off: strip trailing " - kolm.ai" / " · kolm.ai" from og:title and
// twitter:title meta tags across public/ (so SERPs that concat og:site_name +
// og:title stop rendering "kolm.ai · X · kolm.ai"), and rename the old GitHub
// repo URL kolm-ai/kolmogorov-stack -> kolm-ai/kolm so the upcoming repo
// rename's auto-redirect just works.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'archive' || e.name === 'audit-shots' || e.name === 'data') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const titleSuffixRe = /(<meta\s+(?:property|name)="(?:og:title|twitter:title)"\s+content=")([^"]*?)(\s*[·\-–—]\s*kolm\.ai)("\s*\/?>)/gi;
const repoRe = /kolm-ai\/kolmogorov-stack/g;

const files = walk(ROOT).filter((f) => {
  if (f.includes(path.sep + '.tmp-')) return false;
  if (/release-verify-\d{4}-\d{2}-\d{2}\.err$/.test(f)) return false;
  return /\.(html|md|js|cjs|mjs|json|yaml|yml|toml|ts|tsx|rs|py|sh|ps1|rb|css|svg)$/i.test(f);
});

let titleFixes = 0;
let repoFixes = 0;
let touched = 0;

for (const f of files) {
  let s;
  try { s = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  let next = s;
  let localTitle = 0;
  let localRepo = 0;

  // Only strip title suffix in HTML files (avoid touching JSON, JS, etc).
  if (/\.html$/i.test(f)) {
    next = next.replace(titleSuffixRe, (_m, p1, p2, _p3, p4) => {
      localTitle++;
      return p1 + p2 + p4;
    });
  }

  // Repo rename across all file types, but skip the scrub script itself and
  // any file that is supposed to keep the historical URL (changelogs / archive).
  if (!f.endsWith(path.join('scripts', 'w917-title-and-org-scrub.cjs'))) {
    next = next.replace(repoRe, () => {
      localRepo++;
      return 'kolm-ai/kolm';
    });
  }

  if (next !== s) {
    fs.writeFileSync(f, next);
    touched++;
    titleFixes += localTitle;
    repoFixes += localRepo;
    if (localTitle || localRepo) {
      console.log('  ' + path.relative(ROOT, f) + '  title=' + localTitle + ' repo=' + localRepo);
    }
  }
}

console.log('---');
console.log('Files touched:', touched);
console.log('Title-suffix strips:', titleFixes);
console.log('Repo URL rewrites:', repoFixes);
