// One-off audit: list public/docs/*.html files with no matching rewrite in vercel.json.
const fs = require('fs');
const path = require('path');

const vj = fs.readFileSync('vercel.json', 'utf8');
const rewrites = new Set();
const re = /"source":\s*"(\/docs\/[^"]+)"/g;
let m;
while ((m = re.exec(vj))) rewrites.add(m[1]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const files = walk('public/docs');
const missing = [];
for (const f of files) {
  const url = '/' + f.split(path.sep).join('/').replace(/^public\//, '').replace(/\.html$/, '');
  if (!rewrites.has(url) && !rewrites.has(url + '/')) missing.push({ file: f, url });
}

console.log('Total docs files:', files.length);
console.log('Rewrites in vercel.json:', rewrites.size);
console.log('Missing rewrites:', missing.length);
for (const m of missing) console.log(' MISSING: ' + m.url + '  (file: ' + m.file + ')');
