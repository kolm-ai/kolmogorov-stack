// W482 — SDK catalog honesty lock-in. The audit flagged "idk if we even are on
// npm fix all that ish" — meaning the cli/kolm.js KOLM_SDKS catalog must agree
// with each sdk/<lang>/{package.json,Cargo.toml,pyproject.toml} or it's lying
// about install commands. This test pins the contract.
//
// Lock-ins:
//   1) KOLM_SDKS has exactly 6 entries, one per shipped sdk/ subdir.
//   2) Every catalog `pkg` matches the canonical name in the SDK manifest.
//   3) Every catalog row carries `install_source` (no registry = false isn't
//      enough; the source path always works from a repo checkout).
//   4) Python README's headlined package name == pyproject.toml name (the prior
//      drift: README and manifest named different Python packages).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const CLI_SRC = fs.readFileSync(path.join(REPO, 'cli', 'kolm.js'), 'utf8');

function extractSdkCatalog() {
  // Pull out the KOLM_SDKS literal so the test runs without booting the CLI.
  const m = CLI_SRC.match(/const KOLM_SDKS = \[([\s\S]*?)\];/);
  assert.ok(m, 'KOLM_SDKS const must exist in cli/kolm.js');
  const body = m[1];
  const rows = [];
  const rowRx = /\{\s*lang:\s*'([^']+)',\s*pkg:\s*'([^']*)',\s*install_registry:\s*(null|'[^']*'),\s*install_source:\s*'([^']*)',\s*readme:\s*'([^']*)',\s*notes:\s*'([^']*)'\s*\}/g;
  let match;
  while ((match = rowRx.exec(body))) {
    rows.push({
      lang: match[1],
      pkg: match[2],
      install_registry: match[3] === 'null' ? null : match[3].slice(1, -1),
      install_source: match[4],
      readme: match[5],
      notes: match[6],
    });
  }
  return rows;
}

test('W482 #1 — KOLM_SDKS has exactly 6 entries', () => {
  const rows = extractSdkCatalog();
  assert.equal(rows.length, 6, `expected 6 SDKs in catalog, got ${rows.length}: ${rows.map(r => r.lang).join(', ')}`);
  const langs = new Set(rows.map(r => r.lang));
  for (const expected of ['node', 'python', 'mcp', 'vscode', 'c', 'rust']) {
    assert.ok(langs.has(expected), `missing lang '${expected}' from KOLM_SDKS`);
  }
});

test('W482 #12 - registry install commands stay null until publication is verified', () => {
  for (const r of extractSdkCatalog()) {
    assert.equal(r.install_registry, null,
      `${r.lang}: registry install must be null until the package is verified as published under Kolm control`);
  }
});

test('W482 #2 — every catalog row carries install_source (the always-works fallback)', () => {
  const rows = extractSdkCatalog();
  for (const r of rows) {
    assert.ok(r.install_source && r.install_source.length > 8,
      `${r.lang}: install_source must be a real command, got "${r.install_source}"`);
  }
});

test('W482 #3 — node catalog pkg matches sdk/node/package.json name', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'sdk', 'node', 'package.json'), 'utf8'));
  const node = extractSdkCatalog().find(r => r.lang === 'node');
  assert.equal(node.pkg, pkg.name, `catalog says "${node.pkg}", sdk/node/package.json says "${pkg.name}"`);
});

test('W482 #4 — mcp catalog pkg matches sdk/mcp/package.json name', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'sdk', 'mcp', 'package.json'), 'utf8'));
  const mcp = extractSdkCatalog().find(r => r.lang === 'mcp');
  assert.equal(mcp.pkg, pkg.name, `catalog says "${mcp.pkg}", sdk/mcp/package.json says "${pkg.name}"`);
});

test('W482 #5 — python catalog pkg matches sdk/python/pyproject.toml name', () => {
  const toml = fs.readFileSync(path.join(REPO, 'sdk', 'python', 'pyproject.toml'), 'utf8');
  const nm = toml.match(/^\s*name\s*=\s*"([^"]+)"/m);
  assert.ok(nm, 'pyproject.toml has no [project].name');
  const py = extractSdkCatalog().find(r => r.lang === 'python');
  assert.equal(py.pkg, nm[1], `catalog says "${py.pkg}", pyproject.toml says "${nm[1]}"`);
});

test('W482 #6 — rust catalog pkg matches sdk/rust/Cargo.toml package name', () => {
  const toml = fs.readFileSync(path.join(REPO, 'sdk', 'rust', 'Cargo.toml'), 'utf8');
  const nm = toml.match(/^\s*name\s*=\s*"([^"]+)"/m);
  assert.ok(nm, 'Cargo.toml has no [package].name');
  const rs = extractSdkCatalog().find(r => r.lang === 'rust');
  assert.equal(rs.pkg, nm[1], `catalog says "${rs.pkg}", Cargo.toml says "${nm[1]}"`);
});

test('W482 #7 — vscode catalog pkg matches publisher.name from package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'sdk', 'vscode', 'package.json'), 'utf8'));
  const want = `${pkg.publisher}.${pkg.name}`;
  const vs = extractSdkCatalog().find(r => r.lang === 'vscode');
  assert.equal(vs.pkg, want, `catalog says "${vs.pkg}", VS Code marketplace identifier is "${want}"`);
});

test('W482 #8 — c catalog pkg is literally "kolm.h" (no registry — vendor it)', () => {
  const c = extractSdkCatalog().find(r => r.lang === 'c');
  assert.equal(c.pkg, 'kolm.h');
  assert.equal(c.install_registry, null, 'C SDK is vendor-only — install_registry must be null');
});

test('W482 #9 - python README headlines the manifest package name without legacy drift', () => {
  const readme = fs.readFileSync(path.join(REPO, 'sdk', 'python', 'README.md'), 'utf8');
  const toml = fs.readFileSync(path.join(REPO, 'sdk', 'python', 'pyproject.toml'), 'utf8');
  const nm = toml.match(/^\s*name\s*=\s*"([^"]+)"/m)[1];
  // README first H1 line — the headlined package name must match the manifest.
  const h1 = readme.match(/^#\s+([^\n]+)/);
  assert.ok(h1, 'README must start with an H1');
  assert.equal(h1[1].trim(), nm, `README H1 says "${h1[1]}", but pyproject.toml ships "${nm}"`);
  assert.match(readme, /not published under Kolm control/i,
    'README must not imply the PyPI name is controlled by Kolm');
  assert.match(readme, /unrelated Korean language-modeling toolkit/i,
    'README must name the PyPI collision risk directly');
  assert.ok(readme.includes('pip install -e .'),
    'README must show the supported source install path');
});

test('W482 #10 — python kolm/__init__ version matches pyproject.toml version', () => {
  const init = fs.readFileSync(path.join(REPO, 'sdk', 'python', 'kolm', '__init__.py'), 'utf8');
  const toml = fs.readFileSync(path.join(REPO, 'sdk', 'python', 'pyproject.toml'), 'utf8');
  const initVer = init.match(/__version__\s*=\s*"([^"]+)"/);
  const tomlVer = toml.match(/^\s*version\s*=\s*"([^"]+)"/m);
  assert.ok(initVer && tomlVer, 'both version markers must exist');
  assert.equal(initVer[1], tomlVer[1], `__init__.py version "${initVer[1]}" != pyproject.toml "${tomlVer[1]}"`);
});

test('W482 #11 — HELP.sdk advertises every catalog pkg', () => {
  const help = CLI_SRC.match(/\bsdk:\s*`kolm sdk[\s\S]*?\n`/);
  assert.ok(help, 'HELP.sdk literal must exist');
  const helpText = help[0];
  for (const r of extractSdkCatalog()) {
    if (r.lang === 'c') {
      // C SDK has no registry pkg; HELP shows the vendor path
      assert.ok(helpText.includes('kolm.h'), 'HELP.sdk must mention kolm.h for C');
      continue;
    }
    assert.ok(helpText.includes(r.pkg),
      `HELP.sdk does not advertise ${r.pkg} (lang=${r.lang}) — README/manifest/catalog drift will recur`);
  }
});
