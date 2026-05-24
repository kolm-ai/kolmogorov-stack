// W707 - Frontend supplement bundle (WF02/WF04/WF05/WF25/WF26).
//
// Pins the supplement.css + supplement.js + companion HTML pages with the
// W604 anti-brittleness pattern: regex+threshold, never explicit arrays.
//
// Atomic items pinned:
//
//   1)  /supplement.css exists + version marker /w707/ + non-empty
//   2)  /supplement.js exists + version marker /w707-supp-v\d+/ + window.__kolmSupplementLoaded guard
//   3)  supplement.js exports cmdkItems with >= 30 entries (palette breadth)
//   4)  supplement.js cmdkItems include /shortcuts, /dpa, /acceptable-use links (new pages discoverable)
//   5)  supplement.js wires Cmd+K + slash key + Escape handlers
//   6)  supplement.js cookie consent stores choice in localStorage (key includes /kolm.cookie/)
//   7)  supplement.js announcement bar is dismissible + remembers dismissal
//   8)  supplement.css scopes all rules under /kolm-/ prefixes (no global pollution)
//   9)  >= 5 public pages opt in to supplement.js (broad surface coverage)
//   10) /status, /shortcuts, /dpa, /acceptable-use pages all include supplement bundle + data-test marker
//   11) vercel.json does NOT redirect /status away (must serve status.html) + does NOT redirect /dpa away
//   12) vercel.json rewrites for /status, /dpa, /acceptable-use, /shortcuts present

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

test('W707 #1 supplement.css present with w707 version marker', () => {
  const css = readPublic('supplement.css');
  assert.ok(css.length > 1000, 'supplement.css should be non-trivial');
  assert.ok(/w707/i.test(css), 'should carry w707 marker');
});

test('W707 #2 supplement.js present with w707-supp version + idempotency guard', () => {
  const js = readPublic('supplement.js');
  assert.ok(/w707-supp-v\d+/.test(js), 'should expose semver-ish w707-supp version');
  assert.ok(/__kolmSupplementLoaded/.test(js), 'should set load-once guard');
});

test('W707 #3 cmdk palette has >= 30 items (broad coverage)', () => {
  const js = readPublic('supplement.js');
  const m = js.match(/var CMDK_ITEMS = \[([\s\S]*?)\];/);
  assert.ok(m, 'CMDK_ITEMS array should exist');
  const count = (m[1].match(/\{[^}]*group:/g) || []).length;
  assert.ok(count >= 30, `expected >= 30 cmdk items, got ${count}`);
});

test('W707 #4 cmdk includes new page hrefs (/shortcuts /dpa /acceptable-use)', () => {
  const js = readPublic('supplement.js');
  assert.ok(/href:\s*'\/shortcuts'/.test(js), 'shortcuts in palette');
  assert.ok(/href:\s*'\/dpa'/.test(js), 'dpa in palette');
  assert.ok(/href:\s*'\/acceptable-use'/.test(js), 'aup in palette');
});

test('W707 #5 supplement.js wires Cmd+K + / + Escape', () => {
  const js = readPublic('supplement.js');
  assert.ok(/metaKey\s*\|\|\s*e\.ctrlKey/.test(js), 'Cmd/Ctrl detection');
  assert.ok(/e\.key === '\/'/.test(js), 'slash opens palette');
  assert.ok(/e\.key === 'Escape'/.test(js), 'Escape closes palette');
});

test('W707 #6 cookie consent persists choice in localStorage', () => {
  const js = readPublic('supplement.js');
  assert.ok(/kolm\.cookie\.consent/.test(js), 'cookie key in storage');
  assert.ok(/storeSet\(COOKIE_KEY/.test(js), 'persists chosen mode');
});

test('W707 #7 announcement bar dismissal remembered', () => {
  const js = readPublic('supplement.js');
  assert.ok(/kolm\.announce\.dismiss/.test(js), 'announce key in storage');
  assert.ok(/storeSet\(ANNOUNCE_KEY/.test(js), 'persists dismissal');
});

test('W707 #8 supplement.css selectors are kolm-prefixed (no global pollution)', () => {
  const css = readPublic('supplement.css');
  // Strip comments and @-rules to count concrete selectors
  const rules = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\}/)
    .map(s => s.trim())
    .filter(s => s && s.indexOf('{') !== -1 && !/^@/.test(s));
  let nonScoped = 0;
  let total = 0;
  rules.forEach(r => {
    const selectorBlock = r.split('{')[0];
    selectorBlock.split(',').forEach(sel => {
      sel = sel.trim();
      if (!sel) return;
      total++;
      // Allow :root, [data-theme=...], header.site, header.site-header (sticky-nav hooks)
      if (/^:root\b/.test(sel)) return;
      if (/^\[data-theme/.test(sel)) return;
      if (/^header\.site/.test(sel)) return;
      if (/^@/.test(sel)) return;
      if (/\.kolm-/.test(sel) || /\bkolm-/.test(sel)) return;
      nonScoped++;
    });
  });
  assert.ok(total > 10, 'should have non-trivial selector count');
  const ratio = nonScoped / total;
  // Allow up to 10% non-scoped for @keyframes children / media-query nested rules.
  assert.ok(ratio < 0.10, `>=90% selectors must be kolm- scoped (was ${(ratio * 100).toFixed(1)}% non-scoped)`);
});

test('W707 #9 >= 5 public pages opt into supplement.js', () => {
  const files = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));
  let optedIn = 0;
  files.forEach(f => {
    const content = fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8');
    if (/src="\/supplement\.js"/.test(content)) optedIn++;
  });
  assert.ok(optedIn >= 5, `expected >= 5 pages with supplement bundle, got ${optedIn}`);
});

test('W707 #10 new pages include supplement + data-test markers', () => {
  const cases = [
    { file: 'status.html',         marker: /data-test=["']wf21-status-page["']/ },
    { file: 'shortcuts.html',      marker: /data-test=["']wf29-shortcuts-page["']/ },
    { file: 'dpa.html',            marker: /data-test=["']wf28-dpa-page["']/ },
    { file: 'acceptable-use.html', marker: /data-test=["']wf28-aup-page["']/ }
  ];
  cases.forEach(({ file, marker }) => {
    const html = readPublic(file);
    assert.ok(/src="\/supplement\.js"/.test(html), `${file} must include supplement.js`);
    assert.ok(/href="\/supplement\.css"/.test(html), `${file} must include supplement.css`);
    assert.ok(marker.test(html), `${file} must include lock-in data-test marker`);
  });
});

test('W707 #11 vercel.json does NOT redirect /status or /dpa away', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8'));
  const redirects = cfg.redirects || [];
  const statusRedir = redirects.find(r => r.source === '/status');
  const dpaRedir = redirects.find(r => r.source === '/dpa');
  assert.equal(statusRedir, undefined, '/status must NOT redirect (status.html owns this path)');
  assert.equal(dpaRedir, undefined, '/dpa must NOT redirect (dpa.html owns this path)');
});

test('W707 #12 vercel.json rewrites present for /status /dpa /acceptable-use /shortcuts', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8'));
  const rewrites = cfg.rewrites || [];
  const have = new Set(rewrites.map(r => r.source));
  ['/status', '/dpa', '/acceptable-use', '/shortcuts'].forEach(p => {
    assert.ok(have.has(p), `vercel.json must rewrite ${p} → ${p}.html`);
  });
  rewrites.forEach(r => {
    if (['/status', '/dpa', '/acceptable-use', '/shortcuts'].indexOf(r.source) !== -1) {
      assert.equal(r.destination, r.source + '.html', `${r.source} must rewrite to ${r.source}.html`);
    }
  });
});
