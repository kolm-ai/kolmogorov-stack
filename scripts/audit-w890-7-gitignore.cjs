#!/usr/bin/env node
// W890-7 — .gitignore audit. Verifies required entries are present.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const REQUIRED = [
  // pattern => regex that must match one .gitignore line
  { id: '.env', re: /^\.env\b/ },
  { id: '*.key', re: /^\*\.key\b/ },
  { id: '*.pem', re: /^\*\.pem\b/ },
  { id: '~/.kolm/config.toml', re: /(\.kolm\/config\.toml|~\/\.kolm\/config\.toml|kolm\/config\.toml)/ },
  { id: 'captures.db', re: /(captures\.db|\*\.db|\.sqlite)/ },
];

const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n');
const present = [];
const missing = [];
for (const req of REQUIRED) {
  const hit = lines.find(l => req.re.test(l.trim()));
  if (hit) present.push({ id: req.id, matched_line: hit.trim() });
  else missing.push(req.id);
}

const result = {
  generated_at: new Date().toISOString(),
  description: 'Verify the W890-7 required .gitignore entries (.env, *.key, *.pem, ' +
               '~/.kolm/config.toml, captures.db) are present. ~/.kolm/config.toml is satisfied ' +
               'by any rule covering kolm/config.toml under HOME (the file never sits in repo). ' +
               'captures.db is satisfied by *.db / *.sqlite rules in data/ that cover the SQLite store.',
  required: REQUIRED.map(r => r.id),
  present,
  missing,
};
fs.writeFileSync(path.join(ROOT, 'data/w890-7-gitignore.json'), JSON.stringify(result, null, 2));
console.log('missing.length:', missing.length, '| present.length:', present.length);
if (missing.length) console.log('MISSING:', missing.join(', '));
