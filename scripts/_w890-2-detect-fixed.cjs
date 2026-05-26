'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
function rel(p) { return p.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, ''); }
const before = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '_eslint-before.json'), 'utf8'));
const after = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '_eslint-after.json'), 'utf8'));
const beforeWarn = new Map();
for (const f of before) beforeWarn.set(f.filePath, f.warningCount);
const fixed = [];
for (const f of after) {
  const b = beforeWarn.get(f.filePath) || 0;
  if (b > f.warningCount) fixed.push({ file: rel(f.filePath), warnings_before: b, warnings_after: f.warningCount });
}
fs.writeFileSync(path.join(ROOT, 'data', '_w890-2-eslint-files-autofixed.json'), JSON.stringify(fixed, null, 2) + '\n');
console.log('autofixed:', fixed.length);
for (const e of fixed) console.log(' ', e.file, '(', e.warnings_before, '->', e.warnings_after, ')');
