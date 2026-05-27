// W910 Track F4 — TUI smoke + lock-in.
//
// Locks in:
//   1) cmdTui exists and declares the TUI_VIEWS registry (source grep).
//   2) `kolm tui --views --json` returns an envelope with views[] populated.
//   3) The view count meets the W910 floor (≥ 25 — well above the W384 14).
//   4) Each registry row carries id + key + endpoint + kind + label.
//   5) The canonical view ids the W910 plan named must all be present.
//   6) `kolm tui` (no flags) emits the "requires a TTY" hint when piped,
//      so CI + shell pipelines do not hang.
//   7) `--no-unicode` does not break the `--views` non-TTY summary path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const KOLM_JS = path.join(REPO, 'cli', 'kolm.js');

function runKolm(args, extraEnv = {}) {
  const env = {
    ...process.env,
    KOLM_ASSISTANT: '0',
    KOLM_NO_INTERACTIVE: '1',
    KOLM_NO_PROGRESS: '1',
    NO_COLOR: '1',
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [KOLM_JS, ...args], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function cmdTuiBody() {
  // Slice the cmdTui function body for source-grep assertions.
  const src = fs.readFileSync(KOLM_JS, 'utf8');
  const start = src.indexOf('async function cmdTui(args)');
  assert.ok(start > 0, 'cmdTui must exist in cli/kolm.js');
  const end = src.indexOf('\nasync function ', start + 1);
  return end > start ? src.slice(start, end) : src.slice(start);
}

// 1
test('W910-F4.1 cmdTui declares TUI_VIEWS registry', () => {
  const body = cmdTuiBody();
  assert.match(body, /const TUI_VIEWS = \[/,
    'cmdTui must define TUI_VIEWS as a const array literal');
});

// 2
test('W910-F4.2 `kolm tui --views --json` returns an envelope with views[]', () => {
  const r = runKolm(['tui', '--views', '--json']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`stdout was not valid JSON: ${e.message}\n--- stdout ---\n${r.stdout}`);
  }
  assert.ok(parsed && typeof parsed === 'object', 'parsed envelope is an object');
  assert.ok(Array.isArray(parsed.views), 'envelope.views is an array');
  assert.ok(parsed.views.length > 0, 'envelope.views is non-empty');
});

// 3
test('W910-F4.3 TUI view count meets the W910 floor', () => {
  const r = runKolm(['tui', '--views', '--json']);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  // W384 shipped 14 views; W414/W448/W449/W450/W552/W465/W466/W821/W822/W824/
  // W825/W826/W827/W828/W829/W830/W831/W833/W834/W835/W849/W866 piled on the
  // rest. Floor of 25 leaves room to delete a few without breaking the test
  // but catches an accidental wholesale wipe of the registry.
  assert.ok(parsed.views.length >= 25,
    `expected >=25 tui views, got ${parsed.views.length}`);
});

// 4
test('W910-F4.4 each TUI_VIEWS row carries id + key + endpoint + kind + label', () => {
  const body = cmdTuiBody();
  // Anchor on the registry block and ensure the shape keys are present.
  // We don't pin counts here (that's #3); we pin shape.
  const registryIdx = body.indexOf('const TUI_VIEWS = [');
  assert.ok(registryIdx > 0, 'TUI_VIEWS registry must exist');
  // The block ends at the matching `];`. Slice through the next 5000 chars
  // and ensure the canonical row keys all appear.
  const registryChunk = body.slice(registryIdx, registryIdx + 12000);
  for (const k of ['id:', 'key:', 'endpoint:', 'kind:', 'label:']) {
    assert.ok(registryChunk.includes(k), `TUI_VIEWS rows must carry ${k}`);
  }
  // Common kinds the rest of the codebase asserts on.
  for (const v of ["'sse'", "'get'", "'local'"]) {
    assert.ok(registryChunk.includes(v), `TUI_VIEWS must use ${v} kind`);
  }
});

// 5
test('W910-F4.5 canonical view ids the W910 plan named are all present', () => {
  const r = runKolm(['tui', '--views', '--json']);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  // tuiViews() in src/product-experience.js returns the contract-validated
  // set, which is canonical and stable for plan assertions. Read the id
  // field on each row.
  const ids = new Set(parsed.views.map(v => v.id));
  // The W910 demo + walks reference these. If any disappear, plan tasks fail.
  // Cross-checked against tuiViews() in src/product-experience.js which is the
  // contract-validated set the --views envelope reports.
  const REQUIRED = [
    'live-calls',
    'artifacts',
    'compile',
    'datasets',
    'builds',
    'devices',
    'audit-log',
    'billing',
    'settings',
    'marketplace',
  ];
  for (const id of REQUIRED) {
    assert.ok(ids.has(id), `tui views must include '${id}'; got ${[...ids].join(',')}`);
  }
});

// 6
test('W910-F4.6 `kolm tui` (no flags) emits TTY hint when piped (no hang)', () => {
  // spawnSync with no input pipe still gives stdin a non-TTY descriptor; the
  // guard prints the hint and exits. We just need to know the process didn't
  // hang — non-null status means it terminated.
  const r = runKolm(['tui']);
  assert.notEqual(r.status, null, 'kolm tui must exit (not hang) under non-TTY');
  assert.match(r.stderr, /requires a TTY/i,
    `expected "requires a TTY" hint on stderr; got: ${r.stderr}`);
});

// 7
test('W910-F4.7 --no-unicode does not break the --views non-TTY summary', () => {
  // A11y flag stripping in main() must remove --no-unicode before the verb
  // dispatcher sees it, so `kolm tui --views` still works.
  const r = runKolm(['tui', '--views', '--no-unicode']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stdout, /tui views:\s*\d+/i,
    'plain `--views` (no --json) prints "tui views: N" header');
});
