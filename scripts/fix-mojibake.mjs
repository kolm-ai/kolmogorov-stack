import fs from 'fs';
import path from 'path';

const root = 'C:/Users/user/Desktop/kolmogorov-stack/public';

function walk(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(html|css|js|xml|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

const REPL = [
  [/繚/g, '·'],
  [/蝜\?/g, '·'],
  [/蝜/g, '·'],
  [/穢/g, '©'],
  [/蝛\?/g, '©'],
  [/蝛/g, '©'],
  [/禮/g, '§'],
  [/繕/g, 'µ'],
  [/蝪\?/g, '±'],
  [/\?謒\?/g, "'"],
  [/謒\?/g, "'"],
  [/謒/g, "'"],
  [/竏\?/g, '·'],
  [/笆\?/g, '·'],
  [/笸\?/g, '·'],
  [/竢\?/g, '·'],
];

let total = 0;
let touched = 0;
for (const f of walk(root)) {
  const orig = fs.readFileSync(f, 'utf8');
  let fixed = orig;
  let count = 0;
  for (const [re, sub] of REPL) {
    const m = fixed.match(re);
    if (m) count += m.length;
    fixed = fixed.replace(re, sub);
  }
  if (fixed === orig) continue;
  fs.writeFileSync(f, fixed);
  total += count;
  touched++;
  console.log(f.replace(root, ''), '-', count);
}
console.log('done. files:', touched, 'replacements:', total);
