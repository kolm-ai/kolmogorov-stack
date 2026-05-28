// W918 Wave 2 — CLI lock-in.
//
// Pins:
//   1. `kolm --help` lists `org` as a top-level verb.
//   2. `kolm org --help` (or bare `kolm org`) lists at least six of the seven
//      P5.6 subcommands (list, create, members, invite, role, remove, transfer-owner).
//   3. `kolm distill --help` documents the `--mode=agent` flag.
//   4. `kolm org list --json` exits with code 0 (success) or 5 (sign-in
//      required) and stdout parses as JSON or is empty.
//
// The CLI is spawned via process.execPath + an absolute path to cli/kolm.js
// (instead of `node`) so the test works on Windows shells where `node` may
// not be on PATH and where ESM imports require an explicit driver.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');

function runCli(args, opts = {}) {
  // execFileSync throws when exit != 0. Use spawnSync instead so we can read
  // both exit code AND stdout even when the verb intentionally exits non-zero
  // (e.g. `org list --json` returning exit 5 with `[]` on stdout for an
  // unauthenticated session). KOLM_API_KEY is forcibly empty so the test does
  // not pick up an operator's saved key.
  const env = {
    ...process.env,
    KOLM_API_KEY: '',
    NO_COLOR: '1',
    // Pin the data dir to a throwaway temp path so an existing data/orgs.json
    // never leaks into the test. The path doesn't have to exist; orgs.js
    // creates it lazily on first write.
    KOLM_DATA_DIR: path.join(REPO_ROOT, 'tests', '_tmp_w918_wave2_' + Date.now()),
  };
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
    ...opts,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('W918 Wave 2 — CLI', () => {
  it('kolm --help mentions org', () => {
    const { status, stdout } = runCli(['--help']);
    assert.equal(status, 0, 'help should exit 0');
    assert.match(stdout, /\borg\b/, 'expected --help to mention `org`');
  });

  it('kolm org --help lists at least six subcommands', () => {
    const { stdout } = runCli(['org', '--help']);
    const wanted = ['list', 'create', 'members', 'invite', 'role', 'remove', 'transfer-owner'];
    let hits = 0;
    for (const sub of wanted) {
      // Word-boundary check on the help text. transfer-owner has a hyphen so
      // we anchor both sides.
      const re = new RegExp('(^|[^\\w-])' + sub.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '(?=[^\\w-]|$)');
      if (re.test(stdout)) hits += 1;
    }
    assert.ok(
      hits >= 6,
      `expected at least 6 of [${wanted.join(', ')}] in org help; found ${hits}\n--- stdout ---\n${stdout}`
    );
  });

  it('bare `kolm org` shows the help screen with subcommands', () => {
    const { stdout } = runCli(['org']);
    assert.match(stdout, /SUBCOMMANDS/, 'bare org should print SUBCOMMANDS section');
    assert.match(stdout, /\blist\b/, 'bare org help should mention list');
    assert.match(stdout, /\binvite\b/, 'bare org help should mention invite');
  });

  it('kolm distill --help mentions --mode=agent', () => {
    const { stdout } = runCli(['distill', '--help']);
    assert.match(stdout, /--mode=agent/, 'distill help should document --mode=agent');
    assert.match(stdout, /agent_turn|tool-use|tool-use trajectory/i,
      'distill help should describe the agent mode behaviour');
  });

  it('kolm org list --json exits with code 0 or 5 and stdout parses as JSON', () => {
    const { status, stdout } = runCli(['org', 'list', '--json']);
    assert.ok([0, 5].includes(status), `exit code should be 0 or 5, got ${status}`);
    const text = stdout.trim();
    if (text.length === 0) return; // empty stdout is allowed
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      assert.fail('stdout should be valid JSON, got: ' + text.slice(0, 200));
    }
    // Either an array (signed-in: empty or populated) or null/empty array (unauth fallback).
    assert.ok(Array.isArray(parsed) || parsed === null,
      'expected an array or null, got ' + typeof parsed);
  });
});
