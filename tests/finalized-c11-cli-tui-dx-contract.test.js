import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const KOLM_JS = path.join(REPO, 'cli', 'kolm.js');
const KOLM_TUI = path.join(REPO, 'cli', 'kolm-tui.mjs');

function runNode(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd: REPO,
    env: {
      ...process.env,
      KOLM_ASSISTANT: '0',
      KOLM_NO_INTERACTIVE: '1',
      KOLM_NO_PROGRESS: '1',
      NO_COLOR: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

test('C11 root help advertises the current dashboard/workbench split', () => {
  const r = runNode([KOLM_JS, '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tui\s+operator dashboard; use --workbench for artifact training/);
  assert.match(r.stdout, /play \[file\.kolm\]\s+artifact workbench TUI/);
  assert.doesNotMatch(r.stdout, /tui\s+interactive \.kolm shell/);
});

test('C11 direct workbench --help is a plain help screen, not an alt-screen launch', () => {
  const r = runNode([KOLM_TUI, '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kolm workbench TUI/);
  assert.match(r.stdout, /kolm play \[file\.kolm\]/);
  assert.doesNotMatch(r.stdout, /\x1b\[\?1049h/, 'help must not enter the alternate screen');
  assert.equal(r.stderr, '');
});

test('C11 direct workbench refuses non-TTY execution before entering alt-screen', () => {
  const r = runNode([KOLM_TUI]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /requires a TTY/i);
  assert.doesNotMatch(r.stdout + r.stderr, /\x1b\[\?1049h/, 'non-TTY guard must run before alt-screen');
});

test('C11 direct workbench rejects unknown flags instead of treating them as paths', () => {
  const r = runNode([KOLM_TUI, '--definitely-not-real']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown flag/);
  assert.match(r.stderr, /kolm workbench TUI/);
  assert.doesNotMatch(r.stdout + r.stderr, /\x1b\[\?1049h/, 'flag errors must not enter the alternate screen');
});

test('C11 direct workbench reports a missing artifact path before TTY setup', () => {
  const r = runNode([KOLM_TUI, 'definitely-missing.kolm']);
  assert.equal(r.status, 5);
  assert.match(r.stderr, /not found: definitely-missing\.kolm/);
  assert.doesNotMatch(r.stdout + r.stderr, /\x1b\[\?1049h/);
});

test('C11 public play entrypoint keeps the same non-TTY guard', () => {
  const r = runNode([KOLM_JS, 'play']);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /kolm play requires a TTY/i);
  assert.doesNotMatch(r.stdout + r.stderr, /\x1b\[\?1049h/);
});
