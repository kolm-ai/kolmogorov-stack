// Inject /nav.js before </body> on every public HTML page that has a
// site header (either `<header class="site-header">` or the older
// `<header class="site">` variant). Skips _archive and _generations.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const TAG = '<script src="/nav.js" defer></script>';
const HEADER_RE = /<header[^>]*class="(?:site-header|site)\b[^"]*"/;
const SKIP_DIRS = new Set(['_archive', '_generations']);

let touched = 0;
let already = 0;
let skipped = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.html')) continue;
    let s;
    try { s = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (!HEADER_RE.test(s)) { skipped++; continue; }
    if (s.includes('/nav.js')) { already++; continue; }
    if (!s.includes('</body>')) { console.warn('no </body>:', full); continue; }
    s = s.replace('</body>', TAG + '\n</body>');
    fs.writeFileSync(full, s);
    touched++;
  }
}

walk(ROOT);
console.log(`nav.js injected: ${touched} touched, ${already} already had it, ${skipped} no site header.`);
