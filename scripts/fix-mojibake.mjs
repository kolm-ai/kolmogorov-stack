import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || path.join(process.cwd(), 'public'));

const TEXT_EXTENSIONS = new Set([
  '.html',
  '.css',
  '.js',
  '.xml',
  '.json',
  '.md',
  '.txt',
  '.svg',
  '.webmanifest',
]);

const REPLACEMENTS = [
  [/\u7e5a/g, '\u00b7'],
  [/\ufffd/g, ''],
  [/\u875c\?/g, '\u00b7'],
  [/\u875b\?/g, '\u00b7'],
  [/\u8773\?/g, '\u00b7'],
  [/\u8761[^\x00-\x7F]?/g, '\u00b7'],
  [/\u875a[^\x00-\x7F]?/g, '\u00b7'],
  [/\?\u96d3[^\x00-\x7F]?/g, "'"],
  [/\u96d3[^\x00-\x7F]?/g, "'"],
  [/HMAC chain \?\? public registry/g, 'HMAC chain to public registry'],
  [/\?\?\/span/g, '</span'],
  [/\?\?\/a/g, '</a'],
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '.git', 'tmp', 'tmp-screenshots'].includes(entry.name)) {
        walk(file, out);
      }
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(file);
    }
  }
  return out;
}

let total = 0;
let touched = 0;

for (const file of walk(root)) {
  const orig = fs.readFileSync(file, 'utf8');
  let fixed = orig;
  let count = 0;

  for (const [re, sub] of REPLACEMENTS) {
    const matches = fixed.match(re);
    if (matches) count += matches.length;
    fixed = fixed.replace(re, sub);
  }

  if (count > 0) {
    fixed = fixed
      .replace(/\s+\u00b7\s+kolm\.ai/g, ' \u00b7 kolm.ai')
      .replace(/ {2,}/g, ' ');
  }

  if (fixed === orig) continue;
  fs.writeFileSync(file, fixed);
  total += count;
  touched += 1;
  console.log(`${path.relative(root, file)} - ${count}`);
}

console.log(`done. files: ${touched} replacements: ${total}`);
