const fs = require('fs');
const path = require('path');

const all = [];
function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (f === '_generations' || f === 'img' || f.startsWith('.')) continue;
      walk(p);
    } else if (f.endsWith('.html')) {
      all.push(p.split(path.sep).join('/'));
    }
  }
}
walk('public');

const sitemap = fs.readFileSync('public/sitemap.xml', 'utf8');
const inSitemap = new Set();
const re = /<loc>https:\/\/kolm\.ai([^<]*)<\/loc>/g;
let m;
while ((m = re.exec(sitemap)) !== null) {
  let p = m[1];
  if (p === '' || p === '/') inSitemap.add('/');
  else inSitemap.add(p);
}

const missing = [];
for (const f of all) {
  let route = f.replace(/^public/, '').replace(/\.html$/, '');
  if (route === '/index') route = '/';
  if (route.endsWith('/index')) route = route.replace(/\/index$/, '');
  if (route === '/404' || route.startsWith('/_') || route === '/offline') continue;
  if (!inSitemap.has(route)) missing.push(route);
}
console.log('total html:', all.length);
console.log('in sitemap:', inSitemap.size);
console.log('missing from sitemap:');
for (const m2 of missing.sort()) console.log(' ', m2);
