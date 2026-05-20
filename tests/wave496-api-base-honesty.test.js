// Wave 496 - public API examples must use the canonical hosted base URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CANONICAL = 'https://kolm.ai';
const LEGACY_API_BASE = 'https://' + 'api' + '.kolm.ai';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(html|md|json|js|cjs|mjs|yml|yaml|toml)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

test('W496 #1 - public docs and generated specs do not advertise the legacy api subdomain', () => {
  const roots = ['public', 'scripts', 'packages', 'sdk'];
  const hits = [];
  for (const root of roots) {
    for (const file of walk(path.join(ROOT, root))) {
      const relative = rel(file);
      if (relative === 'public/changelog.html') continue;
      if (relative.startsWith('public/research/')) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (/api\.kolm\.ai/i.test(text)) hits.push(relative);
    }
  }
  assert.deepEqual([...new Set(hits)].sort(), []);
});

test('W496 #2 - OpenAPI production server is kolm.ai', () => {
  const spec = JSON.parse(read('public/openapi.json'));
  assert.ok(Array.isArray(spec.servers), 'openapi servers must be present');
  assert.equal(spec.servers[0].url, CANONICAL);
  assert.equal(spec.servers.some((s) => s.url === LEGACY_API_BASE), false);

  const builder = read('scripts/build-openapi.cjs');
  assert.match(builder, /url:\s*'https:\/\/kolm\.ai'/);
  assert.doesNotMatch(builder, /https:\/\/api\.kolm\.ai/);
});

test('W496 #3 - workflow automation examples use the canonical hosted API base', () => {
  const html = read('public/integrations.html');
  assert.match(html, /POST https:\/\/kolm\.ai\/v1\/run/);
  assert.doesNotMatch(html, /POST https:\/\/api\.kolm\.ai\/v1\/run/);
});

test('W496 #4 - status page names the same hosted API surface as the rest of the docs', () => {
  const html = read('public/status.html');
  assert.match(html, /API<small>kolm\.ai\/v1<\/small>/);
  assert.doesNotMatch(html, /api\.kolm\.ai/);
});
