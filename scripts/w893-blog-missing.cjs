const fs = require('fs');
const path = require('path');
const PUB = path.resolve(__dirname, '..', 'public');
const missing = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && e.name.endsWith('.html')) {
      const raw = fs.readFileSync(p, 'utf-8');
      const bi = raw.indexOf('>Build</h4>');
      if (bi < 0) continue;
      const w = raw.slice(bi, bi + 700);
      if (!w.includes('href="/blog"')) missing.push(p);
    }
  }
}
walk(PUB);
console.log('missing:', missing.length);
for (const p of missing.slice(0, 25)) {
  console.log('  ' + p.replace(PUB, '').split(path.sep).join('/'));
}
