// Wave 495 - integration pages must not claim native marketplace/app publication
// until the external listing is verified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OLD_REPO_RE = new RegExp(['sneaky-hippo/kolmo', 'gorov-stack'].join(''));

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function card(html, id) {
  const match = html.match(new RegExp(`<div\\s+class="ig"\\s+id="${id}">[\\s\\S]*?<\\/div>\\s*<\\/div>`));
  assert.ok(match, `missing integration card #${id}`);
  return match[0];
}

test('W495 #1 - Zapier and Make.com stay on the generic HTTP path', () => {
  const html = read('public/integrations.html');
  const zapier = card(html, 'zapier');
  assert.match(zapier, /class="stat">webhook</);
  assert.match(zapier, /no native Kolm app yet/i);
  assert.doesNotMatch(zapier, /native Zapier app/i);
  assert.doesNotMatch(zapier, /also available as a native app/i);
  assert.doesNotMatch(zapier, /class="stat shipped">shipped/i);

  const make = card(html, 'make');
  assert.match(make, /class="stat">HTTP module</);
  assert.match(make, /no native Kolm module yet/i);
  assert.doesNotMatch(make, /Native Make\.com/i);
  assert.doesNotMatch(make, /also available as a native module/i);
  assert.doesNotMatch(make, /class="stat shipped">shipped/i);

  assert.match(read('public/docs/integrations/zapier.html'), /Zapier has no native kolm app yet/i);
  assert.match(read('public/docs/integrations/make.html'), /has no native kolm module yet/i);
});

test('W495 #2 - VS Code extension copy is local VSIX, not marketplace-published', () => {
  const pkg = JSON.parse(read('sdk/vscode/package.json'));
  const html = read('public/integrations.html');
  assert.match(html, /<h3>VS Code extension<\/h3><span class="stat">local VSIX<\/span>/);
  assert.match(html, /not Marketplace-published yet/i);
  assert.match(html, new RegExp(`code --install-extension ${pkg.name}-${pkg.version}\\.vsix`));
  assert.doesNotMatch(html, /recipe-vscode-0\.1\.0\.vsix/);
});

test('W495 #3 - framework adapter snippets use source installs until registry publication is verified', () => {
  const html = read('public/integrations.html');
  assert.doesNotMatch(html, /brew,\s*npm/i);
  assert.match(html, /packages\/langchain-kolm/);
  assert.match(html, /packages\/llamaindex-kolm/);
  assert.match(html, /packages\/python-langchain-kolm\[langchain\]/);
  assert.match(html, /packages\/python-llamaindex-kolm\[llamaindex\]/);

  for (const forbidden of [
    /\bnpm\s+(?:i|install)\s+@kolm\/langchain\b/i,
    /\bnpm\s+(?:i|install)\s+@kolm\/llamaindex\b/i,
    /\bpip\s+install\s+kolm-langchain\b/i,
    /\bpip\s+install\s+kolm-llamaindex\b/i,
  ]) {
    assert.doesNotMatch(html, forbidden);
  }
});

test('W495 #4 - adapter READMEs and metadata point at the real source repo', () => {
  for (const rel of [
    'packages/langchain-kolm/README.md',
    'packages/llamaindex-kolm/README.md',
    'packages/python-langchain-kolm/README.md',
    'packages/python-llamaindex-kolm/README.md',
  ]) {
    const text = read(rel);
    assert.match(text, /github\.com\/sneaky-hippo\/kolm-stack/);
    assert.match(text, /not published under Kolm control/i);
  }

  for (const rel of [
    'packages/langchain-kolm/package.json',
    'packages/llamaindex-kolm/package.json',
    'packages/python-langchain-kolm/pyproject.toml',
    'packages/python-llamaindex-kolm/pyproject.toml',
  ]) {
    const text = read(rel);
    assert.match(text, /sneaky-hippo\/kolm-stack/);
    assert.doesNotMatch(text, OLD_REPO_RE);
  }
});
