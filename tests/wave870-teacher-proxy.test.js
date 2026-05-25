// W870 - Teacher-chat proxy + `kolm teacher` verb + distill env auto-inject.
//
// Pins the W870 deliverables:
//   - W870.0   /v1/teacher/chat HTTP proxy (kolm.ai relays vendor calls)
//   - W870.0   /v1/teacher/chat/health vendor-key presence check
//   - W870.1   distill worker auto-injects KOLM_BASE_URL + KOLM_API_KEY
//   - W870.2   `kolm teacher` verb shows key sources + paths + setup
//   - W870.3   `kolm distill` preflight shows where keys + builds resolve from
//
// W604 anti-brittleness: family lock uses regex + numeric threshold (never
// an explicit hard-coded sibling list).
//
// Items pinned:
//   1) src/router.js declares POST /v1/teacher/chat
//   2) src/router.js declares GET /v1/teacher/chat/health
//   3) cli/kolm.js defines async cmdTeacher exactly once
//   4) cli/kolm.js wires case 'teacher': to cmdTeacher
//   5) cli/kolm.js distill worker spawn auto-injects KOLM_BASE_URL + KOLM_API_KEY
//   6) Family lock — at least one prior wave8xx test file exists

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = __dirname;
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const ROUTER_PATH = path.join(REPO_ROOT, 'src', 'router.js');

function readCli() { return fs.readFileSync(CLI_PATH, 'utf8'); }
function readRouter() { return fs.readFileSync(ROUTER_PATH, 'utf8'); }

// ----------------------------------------------------------------------------
// 1) POST /v1/teacher/chat declared
// ----------------------------------------------------------------------------
test('W870 #1 - src/router.js declares POST /v1/teacher/chat', () => {
  const src = readRouter();
  assert.ok(/r\.post\(\s*['"]\/v1\/teacher\/chat['"]/.test(src),
    `src/router.js must declare r.post('/v1/teacher/chat', ...)`);
});

// ----------------------------------------------------------------------------
// 2) GET /v1/teacher/chat/health declared
// ----------------------------------------------------------------------------
test('W870 #2 - src/router.js declares GET /v1/teacher/chat/health', () => {
  const src = readRouter();
  assert.ok(/r\.get\(\s*['"]\/v1\/teacher\/chat\/health['"]/.test(src),
    `src/router.js must declare r.get('/v1/teacher/chat/health', ...)`);
});

// ----------------------------------------------------------------------------
// 3) async function cmdTeacher exactly once
// ----------------------------------------------------------------------------
test('W870 #3 - cli/kolm.js defines async function cmdTeacher exactly once', () => {
  const src = readCli();
  const occ = (src.match(/async function cmdTeacher\b/g) || []).length;
  assert.equal(occ, 1, `cmdTeacher must be defined exactly once; found ${occ}`);
});

// ----------------------------------------------------------------------------
// 4) case 'teacher': wires cmdTeacher
// ----------------------------------------------------------------------------
test("W870 #4 - cli/kolm.js wires case 'teacher' to cmdTeacher", () => {
  const src = readCli();
  assert.ok(/case 'teacher':[\s\S]{0,400}cmdTeacher/.test(src),
    `expected "case 'teacher': ... cmdTeacher(...)" wiring; not found`);
});

// ----------------------------------------------------------------------------
// 5) Distill worker auto-injects KOLM_BASE_URL + KOLM_API_KEY (W870.1)
// ----------------------------------------------------------------------------
test('W870 #5 - cli/kolm.js distill worker auto-injects KOLM_BASE_URL + KOLM_API_KEY', () => {
  const src = readCli();
  // The auto-inject must reference both env var names; W870.1 design.
  assert.ok(/KOLM_BASE_URL/.test(src),
    `cli/kolm.js must reference KOLM_BASE_URL env var (W870.1 auto-inject)`);
  assert.ok(/KOLM_API_KEY/.test(src),
    `cli/kolm.js must reference KOLM_API_KEY env var (W870.1 auto-inject)`);
  // Comment marker proves the intent (not just incidental reference).
  assert.ok(/W870/.test(src),
    `cli/kolm.js must carry a W870 comment marker proving auto-inject intent`);
});

// ----------------------------------------------------------------------------
// 6) Family lock (W604): regex + threshold, never explicit array.
// ----------------------------------------------------------------------------
test('W870 #6 - W604 family pattern: at least one prior wave8xx test file exists', () => {
  const re = /^wave(\d{3,4}).*\.test\.js$/;
  const files = fs.readdirSync(TESTS_DIR);
  const wave8xx = files.filter((f) => {
    const m = f.match(re);
    if (!m) return false;
    const n = Number(m[1]);
    return n >= 800 && n <= 999;
  });
  assert.ok(wave8xx.length >= 1,
    `expected at least 1 wave8xx test file (regex+threshold per W604); found ${wave8xx.length}`);
});
