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
    } else if (f.endsWith('.html') && !p.includes('404')) {
      all.push(p.split(path.sep).join('/'));
    }
  }
}
walk('public');

const issues = { noTitle: [], titleTooLong: [], titleTooShort: [], noDesc: [], descTooLong: [], descTooShort: [], noH1: [], multiH1: [], noCanonical: [] };

for (const f of all) {
  const s = fs.readFileSync(f, 'utf8');
  const tm = s.match(/<title>([^<]+)<\/title>/i);
  if (!tm) issues.noTitle.push(f);
  else {
    const t = tm[1].trim();
    if (t.length > 65) issues.titleTooLong.push(`${f} (${t.length}: "${t}")`);
    if (t.length < 12) issues.titleTooShort.push(`${f} (${t.length}: "${t}")`);
  }
  const dm = s.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  if (!dm) issues.noDesc.push(f);
  else {
    const d = dm[1].trim();
    if (d.length > 165) issues.descTooLong.push(`${f} (${d.length})`);
    if (d.length < 60) issues.descTooShort.push(`${f} (${d.length}: "${d}")`);
  }
  const h1m = s.match(/<h1\b/gi);
  if (!h1m) issues.noH1.push(f);
  else if (h1m.length > 1) issues.multiH1.push(`${f} (${h1m.length})`);
  if (!/<link\s+rel="canonical"/i.test(s)) issues.noCanonical.push(f);
}

for (const [k, v] of Object.entries(issues)) {
  if (v.length === 0) continue;
  console.log(`\n=== ${k} (${v.length}) ===`);
  for (const x of v.slice(0, 10)) console.log(' ', x);
  if (v.length > 10) console.log(`  ... and ${v.length - 10} more`);
}
