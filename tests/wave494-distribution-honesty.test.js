// Wave 494 - public install/distribution copy must not imply unverified registry channels.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const CANONICAL = 'npm i -g github:kolm-ai/kolm';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(html|md|json|js|cjs|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

test('W494 #1 - public install surfaces never point users at unverified package names', () => {
  const forbidden = [
    /\bnpm\s+(?:i|install)\s+-g\s+kolm\b/i,
    /\bwinget\s+install\s+kolm\b/i,
    /\bbrew\s+install\s+kolm\b/i,
    /\bapt(?:-get)?\s+install\s+kolm\b/i,
    /\bpip\s+install\s+kolm\b/i,
    /\bcargo\s+install\s+kolm\b/i,
    /\bdocker\s+pull\s+(?:ghcr\.io\/)?kolm\b/i,
  ];
  const hits = [];
  for (const file of walk(PUBLIC)) {
    if (rel(file).startsWith('public/research/')) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const rx of forbidden) {
      if (rx.test(text)) hits.push(`${rel(file)} :: ${rx}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('W494 #2 - first-party install docs use the GitHub npm source path', () => {
  for (const relPath of [
    'public/docs/cli/index.html',
    'public/docs/install/mac.html',
    'public/docs/install/linux.html',
    'public/docs/install/windows.html',
    'public/download.html',
    'public/quickstart.html',
  ]) {
    const html = read(relPath);
    assert.ok(html.includes('github:kolm-ai/kolm'), `${relPath} must show source install`);
  }

  for (const relPath of [
    'public/docs/install/mac.html',
    'public/docs/install/linux.html',
    'public/docs/install/windows.html',
  ]) {
    assert.match(read(relPath), /GitHub source package/i, `${relPath} must not imply npm-registry publication`);
  }
});

test('W494 #3 - Homebrew, winget, scoop, and Docker are runtime setup, not shipped Kolm channels', () => {
  const html = read('public/integrations.html');
  assert.match(html, /<h2>Runtime Setup<\/h2>/);
  assert.doesNotMatch(html, /<h3>Homebrew<\/h3>\s*<span class="stat shipped">/i);
  assert.doesNotMatch(html, /<h3>winget \/ scoop<\/h3>\s*<span class="stat shipped">/i);
  assert.doesNotMatch(html, /<h3>Docker<\/h3>\s*<span class="stat shipped">/i);
  assert.match(html, /<h3>Homebrew<\/h3><span class="stat">node setup<\/span>/i);
  assert.match(html, /<h3>winget \/ scoop<\/h3><span class="stat">node setup<\/span>/i);
});

test('W494 #4 - marketing copy and CLI help name the canonical source install', () => {
  const why = read('public/why-kolm.html');
  assert.ok(why.includes('npm install -g github:kolm-ai/kolm'));
  assert.equal(why.includes('Homebrew, winget, apt'), false);

  const cli = read('cli/kolm.js');
  assert.ok(cli.includes('npm i -g github:kolm-ai/kolm'));
  assert.doesNotMatch(cli, /\bnpm\s+(?:i|install)\s+-g\s+kolm\b/i);
});

