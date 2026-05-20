import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(repo, 'public');
const link = '<link rel="stylesheet" href="/surface-polish.css">';

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(full);
  }
  return files;
}

let changed = 0;
for (const file of walk(publicDir)) {
  const html = fs.readFileSync(file, 'utf8');
  if (html.includes('/surface-polish.css')) continue;

  let next = html;
  if (/<\/head>/i.test(html)) {
    next = html.replace(/<\/head>/i, `  ${link}\n</head>`);
  } else if (/<body\b/i.test(html)) {
    next = html.replace(/<body\b/i, `${link}\n<body`);
  } else {
    next = `${link}\n${html}`;
  }

  if (next !== html) {
    fs.writeFileSync(file, next);
    changed += 1;
  }
}

console.log(`surface-polish linked in ${changed} html files`);
