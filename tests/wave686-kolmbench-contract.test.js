import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AUTHORITATIVE_TASKS,
  KOLMBENCH_LIMITS,
  KOLMBENCH_VERSION,
  appendLeaderboardEntry,
  readLeaderboard,
  scoreSubmission,
  validateSubmission,
  _findTenantKolmbenchEvents,
} from '../src/kolmbench.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const VALID_CID = 'sha256:' + 'a'.repeat(64);

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w686-kolmbench-'));
  return {
    dir,
    leaderboard: path.join(dir, 'leaderboard.json'),
    receiptRoot: path.join(dir, 'receipts'),
  };
}

function validRow(task = AUTHORITATIVE_TASKS[0]) {
  return {
    task_id: task,
    response: 'bounded public benchmark answer',
    model: 'kolm-local-fixture',
    artifact_cid_or_null: null,
  };
}

test('W686 KolmBench source pins bounded evidence, receipt verifier, and depth wiring', () => {
  const source = read('src/kolmbench.js');
  const router = read('src/router.js');
  const pkg = readJson('package.json');

  assert.equal(KOLMBENCH_VERSION, 'w756-v2');
  assert.match(KOLMBENCH_VERSION, /^w756-/);
  assert.equal(KOLMBENCH_LIMITS.MAX_ROWS, 64);
  assert.equal(KOLMBENCH_LIMITS.MAX_LEADERBOARD_ENTRIES, 500);
  assert.match(source, /KOLMBENCH_LIMITS/);
  assert.match(source, /_submissionSha/);
  assert.match(source, /chain_head_sha256/);
  assert.match(source, /leaderboard_sha256/);
  assert.match(source, /receipt_verifier_not_wired/);
  assert.match(source, /receipt_path_outside_allowed_root/);
  assert.match(source, /crypto\.randomBytes\(8\)/);
  assert.match(source, /flag: 'wx'/);
  assert.doesNotMatch(source, /verifiedFinal/);
  assert.doesNotMatch(source, /[^\x00-\x7F]/);
  assert.match(router, /submission_sha256: result\.submission_sha256/);
  assert.match(router, /task_set_sha256: result\.task_set_sha256/);

  assert.equal(pkg.scripts['verify:kolmbench'], 'node --test --test-concurrency=1 tests/wave686-kolmbench-contract.test.js');
  assert.match(pkg.scripts['verify:depth'], /verify:eval-humaneval && npm run verify:homebrew-formula && npm run verify:kolmbench && npm run verify:package-release/);
});

test('W686 validateSubmission is bounded, hash-backed, and control-clean', () => {
  const rows = [
    validRow(),
    { ...validRow(AUTHORITATIVE_TASKS[1]), response: 'x'.repeat(KOLMBENCH_LIMITS.MAX_RESPONSE_CHARS + 1) },
    { task_id: 'unknown\nid', response: 'ok', artifact_cid_or_null: 'bad-cid' },
    validRow(),
  ];
  const result = validateSubmission(rows);

  assert.equal(result.ok, false);
  assert.equal(result.row_count, 4);
  assert.equal(result.accepted_task_count, 2);
  assert.match(result.submission_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.task_set_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.limits.max_rows, KOLMBENCH_LIMITS.MAX_ROWS);
  assert.ok(result.errors.some((e) => e.code === 'response_too_large'));
  assert.ok(result.errors.some((e) => e.code === 'unknown_task_id' && e.task_id === 'unknown id'));
  assert.ok(result.errors.some((e) => e.code === 'invalid_artifact_cid_format'));
  assert.ok(result.errors.some((e) => e.code === 'duplicate_task_id'));

  const tooMany = validateSubmission(Array.from({ length: KOLMBENCH_LIMITS.MAX_ROWS + 1 }, () => validRow()));
  assert.ok(tooMany.errors.some((e) => e.code === 'too_many_rows'));
});

test('W686 scoreSubmission remains honest but carries submission evidence', () => {
  const result = scoreSubmission([validRow()]);
  assert.equal(result.ok, true);
  assert.equal(result.k_score, null);
  assert.equal(result.reason, 'kolmbench_v1_scoring_offline_pending_pack');
  assert.match(result.submission_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.task_set_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.coverage, { covered: 1, expected: AUTHORITATIVE_TASKS.length });
});

test('W686 readLeaderboard normalizes entries and returns chain evidence', () => {
  const { dir, leaderboard } = tmpPaths();
  try {
    const missing = readLeaderboard({ leaderboard_path: leaderboard });
    assert.equal(missing.ok, true);
    assert.equal(missing.empty_reason, 'leaderboard_file_missing');
    assert.equal(missing.entry_count, 0);
    assert.match(missing.chain_head_sha256, /^[a-f0-9]{64}$/);

    fs.writeFileSync(leaderboard, JSON.stringify({
      version: 'legacy',
      updated_at: '2026-06-18T00:00:00Z',
      entries: [{
        submitter: ' Alice\nOps ',
        model: ' model-a ',
        k_score: 1.2,
        verified: true,
      }],
    }));
    const board = readLeaderboard({ leaderboard_path: leaderboard });
    assert.equal(board.ok, true);
    assert.equal(board.entry_count, 1);
    assert.equal(board.entries[0].submitter, 'Alice Ops');
    assert.equal(board.entries[0].k_score, 1);
    assert.equal(board.entries[0].verified, false);
    assert.equal(board.entries[0].verification_status, 'legacy_entry');
    assert.match(board.entries[0].entry_id, /^kolmbench_[a-f0-9]{16}$/);
    assert.match(board.entries[0].entry_sha256, /^[a-f0-9]{64}$/);
    assert.match(board.leaderboard_sha256, /^[a-f0-9]{64}$/);
    assert.match(board.chain_head_sha256, /^[a-f0-9]{64}$/);

    fs.writeFileSync(leaderboard, '{bad json');
    const corrupt = readLeaderboard({ leaderboard_path: leaderboard });
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.error, 'leaderboard_parse_error');
    assert.match(corrupt.leaderboard_sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W686 appendLeaderboardEntry writes hashed entries and refuses arbitrary receipt verification', () => {
  const { dir, leaderboard, receiptRoot } = tmpPaths();
  try {
    const outsideReceipt = path.join(dir, 'outside.receipt');
    fs.writeFileSync(outsideReceipt, 'receipt bytes');
    const untrusted = appendLeaderboardEntry({
      leaderboard_path: leaderboard,
      receipt_root: receiptRoot,
      submitter: ' Team\nA ',
      model: ' model-a ',
      k_score: 0.72,
      k_axes: { reasoning: 0.7, coding: 0.8 },
      artifact_cid: VALID_CID,
      source_repo: 'https://example.invalid/repo',
      verified: true,
      ed25519_receipt_path: outsideReceipt,
      submitted_at: '2026-06-18T00:00:00Z',
    });
    assert.equal(untrusted.ok, true);
    assert.equal(untrusted.entry_added.verified, false);
    assert.equal(untrusted.entry_added.verification_status, 'receipt_path_outside_allowed_root');
    assert.match(untrusted.entry_added.entry_id, /^kolmbench_[a-f0-9]{16}$/);
    assert.match(untrusted.entry_added.entry_sha256, /^[a-f0-9]{64}$/);
    assert.match(untrusted.chain_head_sha256, /^[a-f0-9]{64}$/);

    fs.mkdirSync(receiptRoot, { recursive: true });
    const allowedReceipt = path.join(receiptRoot, 'entry.receipt');
    fs.writeFileSync(allowedReceipt, 'signed receipt fixture');
    const verified = appendLeaderboardEntry({
      leaderboard_path: leaderboard,
      receipt_root: receiptRoot,
      receipt_verifier: ({ receipt_sha256, bytes }) => ({ ok: /^[a-f0-9]{64}$/.test(receipt_sha256) && bytes > 0 }),
      submitter: 'Team B',
      model: 'model-b',
      k_score: 0.93,
      verified: true,
      ed25519_receipt_path: allowedReceipt,
      submitted_at: '2026-06-18T00:01:00Z',
    });
    assert.equal(verified.ok, true);
    assert.equal(verified.sort_position, 1);
    assert.equal(verified.entry_added.verified, true);
    assert.equal(verified.entry_added.verification_status, 'verified_by_receipt_verifier');
    assert.match(verified.entry_added.receipt_sha256, /^[a-f0-9]{64}$/);

    const board = readLeaderboard({ leaderboard_path: leaderboard });
    assert.equal(board.entry_count, 2);
    assert.equal(board.entries[0].submitter, 'Team B');
    assert.equal(board.entries[1].submitter, 'Team A');
    assert.match(board.chain_head_sha256, /^[a-f0-9]{64}$/);

    const badAxes = appendLeaderboardEntry({
      leaderboard_path: leaderboard,
      submitter: 'Team C',
      model: 'model-c',
      k_score: 0.5,
      k_axes: { reasoning: 2 },
    });
    assert.equal(badAxes.ok, false);
    assert.equal(badAxes.error, 'invalid_k_axes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W686 tenant event helper keeps tenant fence and fails closed', () => {
  assert.deepEqual(_findTenantKolmbenchEvents(null), []);
  const rows = _findTenantKolmbenchEvents('tenant-that-does-not-exist');
  assert.ok(Array.isArray(rows));
  assert.equal(rows.some((r) => r && r.tenant !== 'tenant-that-does-not-exist'), false);
});
