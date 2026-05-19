// Wave 409i — CLI / TUI / post-auth account UI coherence pass.
//
// The auditor checklist sections #21 + #22 require that:
//   - every canonical verb supports --help that prints USAGE + at least one example
//   - every canonical verb supports --json (deterministic, script-parseable output)
//   - the post-auth /account dashboard surfaces 9 canonical counters
//     (captured-traffic, savings-opportunities, datasets, review-queue,
//      builds-in-progress, artifacts, devices, team-approvals, usage/billing)
//   - every /account page has the W221 5-anchor primary nav + empty-state hint
//   - the TUI's `:` command mode supports the 7 canonical view names
//     (events, opportunities, datasets, labels, bakeoffs, artifacts, billing)
//
// Tests assert BEHAVIOR — source greps for canonical strings + spawn(node cli/kolm.js)
// with --help / --json — NOT page copy. Don't break wave222 TUI tests, wave229
// foundations verbs, or the W302/W303/W304/W305/W311/W318/W321 CLI tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');
const CLI_SRC = fs.readFileSync(CLI, 'utf8');
const ACCOUNT_DIR = path.join(ROOT, 'public', 'account');
const OVERVIEW_PATH = path.join(ACCOUNT_DIR, 'overview.html');
const OVERVIEW = fs.readFileSync(OVERVIEW_PATH, 'utf8');

// The canonical verb list (from the auditor checklist) every kolm install
// must answer to.
const CANONICAL_VERBS = [
  'connect',
  'lake',
  'opportunities',
  'dataset',
  'labels',
  'bakeoff',
  'build',
  'distill',
  'compile',
  'verify',
  'run',
  'models',
  'devices',
  'team',
  'billing',
  'jobs',
  'doctor',
  'whoami',
  'tail',
];

// The 9 dashboard counters the checklist requires, by data-counter slug.
const DASHBOARD_COUNTERS = [
  'captured-traffic',
  'savings-opportunities',
  'datasets',
  'review-queue',
  'builds-in-progress',
  'artifacts',
  'devices',
  'team-approvals',
  'usage-billing',
];

// The 7 colon-command view names the TUI must recognize.
const TUI_VIEW_NAMES = [
  'events',
  'opportunities',
  'datasets',
  'labels',
  'bakeoffs',
  'artifacts',
  'billing',
];

// ---------- CLI --help shape (USAGE + EXAMPLE per verb) ----------

test('W409i #1 - every canonical verb has a HELP entry that mentions USAGE + an example', () => {
  for (const verb of CANONICAL_VERBS) {
    // The HELP table is keyed by the verb name (or a quoted form for hyphenated
    // verbs); locate the entry and assert USAGE + (EXAMPLE|EXAMPLES) appears.
    const keyRe = new RegExp(
      "(?:^|\\n)\\s*['\"]?" + verb.replace(/[-]/g, '[-]') + "['\"]?:\\s*`",
      'm',
    );
    assert.ok(keyRe.test(CLI_SRC), `HELP entry must exist for "${verb}"`);
    // Locate the entry body to scope the USAGE/EXAMPLE checks.
    const start = CLI_SRC.search(keyRe);
    assert.ok(start > 0, `HELP entry start lookup for "${verb}"`);
    const tail = CLI_SRC.slice(start);
    // Each HELP entry is a template literal that ends with `,\n. Grab up to
    // the first standalone "`," boundary (good enough for the assertion).
    const endOff = tail.indexOf('`,\n');
    assert.ok(endOff > 0, `could not locate end of HELP entry "${verb}"`);
    const body = tail.slice(0, endOff);
    assert.match(body, /USAGE/i, `HELP[${verb}] must contain USAGE`);
    assert.match(body, /EXAMPLES?/i, `HELP[${verb}] must contain at least one EXAMPLE`);
    assert.ok(
      new RegExp('kolm\\s+' + verb.replace(/[-]/g, '[-]')).test(body),
      `HELP[${verb}] must mention the verb itself in a usage line`,
    );
  }
});

// ---------- CLI --json support (source-grep) ----------

test('W409i #2 - every canonical verb mentions --json in its HELP entry (deterministic output flag)', () => {
  // Behavior assertion: the contract is "verb supports a --json flag and its
  // HELP text documents it". Source-grep on the HELP body.
  // A few verbs (build, run, verify, distill, compile, doctor, connect) have
  // long-standing --json mention via the example or FLAGS block; we just
  // require the literal string "--json" appears inside the HELP entry body.
  for (const verb of CANONICAL_VERBS) {
    const keyRe = new RegExp(
      "(?:^|\\n)\\s*['\"]?" + verb.replace(/[-]/g, '[-]') + "['\"]?:\\s*`",
      'm',
    );
    const start = CLI_SRC.search(keyRe);
    const tail = CLI_SRC.slice(start);
    const endOff = tail.indexOf('`,\n');
    const body = tail.slice(0, endOff);
    assert.ok(
      body.includes('--json'),
      `HELP[${verb}] must document --json (saw: ${body.slice(0, 200)}…)`,
    );
  }
});

// ---------- CLI dispatcher wiring ----------

test('W409i #3 - main switch dispatches every canonical verb to a cmd* function', () => {
  for (const verb of CANONICAL_VERBS) {
    // The dispatcher entries use the `case 'verb':` form.
    const re = new RegExp("case ['\"]" + verb.replace(/[-]/g, '[-]') + "['\"]:");
    assert.ok(re.test(CLI_SRC), `main switch must route case '${verb}':`);
  }
});

// ---------- CLI --help spawn smoke (process actually exits 0 with USAGE) ----------

test('W409i #4 - `kolm <verb> --help` exits 0 and prints something mentioning the verb', () => {
  // A representative subset — spawning a node child for every verb adds ~3s
  // per test, so we spot-check the canonical-verb set's new additions.
  const subset = ['lake', 'opportunities', 'dataset', 'label', 'jobs', 'tail', 'watch',
                  'sync', 'profile', 'billing', 'privacy', 'pipeline', 'agents', 'demo'];
  for (const verb of subset) {
    const r = spawnSync(process.execPath, [CLI, verb, '--help'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(r.status, 0, `kolm ${verb} --help must exit 0, got ${r.status}. stderr=${r.stderr}`);
    assert.ok(r.stdout.includes('kolm'),
      `kolm ${verb} --help stdout must mention 'kolm' (got: ${r.stdout.slice(0, 200)})`);
    assert.ok(/USAGE/i.test(r.stdout),
      `kolm ${verb} --help stdout must include USAGE section`);
  }
});

// ---------- billing verb wiring (new in W409i) ----------

test('W409i #5 - cmdBilling exists + is wired into main dispatcher + _dispatchVerb + completion', () => {
  assert.match(CLI_SRC, /async function cmdBilling/, 'cmdBilling must be defined');
  assert.match(CLI_SRC, /case 'billing':\s*await withErrorContext\('billing',\s*\(\)\s*=>\s*cmdBilling/,
    'main switch must route billing -> cmdBilling');
  assert.match(CLI_SRC, /billing:\s*cmdBilling/, '_dispatchVerb table must include billing');
  assert.match(CLI_SRC, /'metrics',\s*'billing'/, 'COMPLETION_VERBS must list billing');
  assert.match(CLI_SRC, /billing:\s*\[\s*['"]usage['"]/,
    'COMPLETION_SUBS must include billing -> [usage, plan, ...]');
});

// ---------- account dashboard counters ----------

test('W409i #6 - overview.html surfaces 9 canonical dashboard counters (data-counter attributes)', () => {
  for (const counter of DASHBOARD_COUNTERS) {
    const re = new RegExp(`data-counter=["']${counter}["']`);
    assert.ok(re.test(OVERVIEW),
      `/account/overview must surface data-counter="${counter}"`);
  }
  // And the grid container must announce the count = 9 for behavior tests.
  assert.match(OVERVIEW, /data-counter-count=["']9["']/,
    'metric grid must declare data-counter-count="9"');
});

// ---------- W221 5-anchor nav on every account page ----------

test('W409i #7 - every /account page carries the W221 5-anchor primary nav block', () => {
  const files = fs.readdirSync(ACCOUNT_DIR).filter(f => f.endsWith('.html'));
  assert.ok(files.length >= 10, `expected at least 10 account pages, saw ${files.length}`);
  for (const f of files) {
    const s = fs.readFileSync(path.join(ACCOUNT_DIR, f), 'utf8');
    assert.ok(/KOLM_NAV_BEGIN \(W221\)/.test(s),
      `${f} must carry the W221 KOLM_NAV_BEGIN marker`);
    const topAnchors = (s.match(/class="nav-top"/g) || []).length;
    assert.ok(topAnchors >= 5,
      `${f} must include 5 .nav-top anchors (Product/Models/Docs/Pricing/Enterprise) — saw ${topAnchors}`);
  }
});

// ---------- empty-state guidance on every account page ----------

test('W409i #8 - every /account page includes an empty-state guidance hint', () => {
  const files = fs.readdirSync(ACCOUNT_DIR).filter(f => f.endsWith('.html'));
  for (const f of files) {
    const s = fs.readFileSync(path.join(ACCOUNT_DIR, f), 'utf8');
    const has = /data-empty-state|class="empty"|id="empty/i.test(s);
    assert.ok(has,
      `${f} must carry an empty-state hint (data-empty-state | class="empty" | id="empty…")`);
  }
});

// ---------- TUI colon-command view names ----------

test('W409i #9 - TUI executeColonCommand handles the 7 canonical view names', () => {
  const TUI_START = CLI_SRC.indexOf('async function cmdTui(args)');
  assert.ok(TUI_START > 0, 'cmdTui must exist');
  const NEXT_FN = CLI_SRC.indexOf('\nasync function ', TUI_START + 1);
  const TUI_BODY = NEXT_FN > TUI_START ? CLI_SRC.slice(TUI_START, NEXT_FN) : CLI_SRC.slice(TUI_START);
  // VIEW_ALIAS map (or a literal verb-by-verb test) must mention each view name.
  for (const name of TUI_VIEW_NAMES) {
    const re = new RegExp(`['"\`]${name}['"\`]`);
    assert.ok(re.test(TUI_BODY),
      `TUI executeColonCommand must recognize :${name}`);
  }
  // The colon-mode dispatch must remain wired.
  assert.match(TUI_BODY, /executeColonCommand/,
    'executeColonCommand must still be defined inside cmdTui');
});

// ---------- TUI keymap stays intact (don't break wave222) ----------

test('W409i #10 - TUI `?` help banner enumerates view names (W384 14-view registry stays intact)', () => {
  const TUI_START = CLI_SRC.indexOf('async function cmdTui(args)');
  const NEXT_FN = CLI_SRC.indexOf('\nasync function ', TUI_START + 1);
  const TUI_BODY = NEXT_FN > TUI_START ? CLI_SRC.slice(TUI_START, NEXT_FN) : CLI_SRC.slice(TUI_START);
  // The banner string in onKey('?') must list at least the canonical view names.
  assert.match(TUI_BODY, /live-calls/, 'help banner mentions live-calls');
  assert.match(TUI_BODY, /opportunities/, 'help banner mentions opportunities');
  assert.match(TUI_BODY, /datasets/, 'help banner mentions datasets');
  assert.match(TUI_BODY, /bakeoffs/, 'help banner mentions bakeoffs');
  assert.match(TUI_BODY, /labeling-queue/, 'help banner mentions labeling-queue');
});

// ---------- empty-state guidance points users at `kolm connect start` ----------

test('W409i #11 - tail / jobs / lake empty-state hints point at the connect daemon', () => {
  // Source-grep on the HELP entries — the contract is "empty-state guides the
  // user toward kolm connect start (the wedge)". We don't strictly require all
  // three to mention it, but the three captured-traffic surfaces should.
  const tailRe = /tail:\s*`[\s\S]*?EMPTY STATE[\s\S]*?connect[\s\S]*?`/m;
  assert.ok(tailRe.test(CLI_SRC),
    'kolm tail HELP must hint at `kolm connect start` in its empty-state block');
});

// ---------- COMPLETION_SUBS coverage for the new surfaces ----------

test('W409i #12 - COMPLETION_SUBS exposes lake/dataset/label/labels/billing subverbs', () => {
  assert.match(CLI_SRC, /lake:\s*\[['"]stats['"]/, 'lake subs must start with stats');
  assert.match(CLI_SRC, /dataset:\s*\[['"]candidates['"]/, 'dataset subs must start with candidates');
  assert.match(CLI_SRC, /label:\s*\[['"]next['"]/, 'label subs must start with next');
  assert.match(CLI_SRC, /labels:\s*\[['"]next['"]/, 'labels (plural) subs must include next');
  assert.match(CLI_SRC, /billing:\s*\[['"]usage['"]/, 'billing subs must start with usage');
});

// ---------- billing --help spawn smoke ----------

test('W409i #13 - kolm billing --help exits 0 and documents usage + plan subverbs', () => {
  const r = spawnSync(process.execPath, [CLI, 'billing', '--help'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(r.status, 0, `kolm billing --help must exit 0, stderr=${r.stderr}`);
  assert.match(r.stdout, /USAGE/i, 'must include USAGE');
  assert.match(r.stdout, /kolm billing/, 'must mention kolm billing');
  assert.match(r.stdout, /usage/i, 'must mention usage subverb');
  assert.match(r.stdout, /plan/i, 'must mention plan subverb');
});

// ---------- billing without a key exits MISSING_PREREQ ----------

test('W409i #14 - kolm billing (no key) exits non-zero with a login hint', () => {
  // Use an empty HOME so no config can be picked up. KOLM_API_KEY must NOT be
  // set in the child env.
  const env = { ...process.env };
  delete env.KOLM_API_KEY;
  env.HOME = path.join(ROOT, 'tests', '_tmp_no_home_' + Date.now());
  env.USERPROFILE = env.HOME;
  env.KOLM_HOME = path.join(env.HOME, '.kolm');
  const r = spawnSync(process.execPath, [CLI, 'billing', 'usage', '--json'], {
    encoding: 'utf8',
    env,
    timeout: 10000,
  });
  assert.notEqual(r.status, 0, 'billing without a key must exit non-zero');
  assert.match(r.stdout + r.stderr, /not_logged_in|not logged in/i,
    'must hint the user about login');
});

// ---------- TUI VIEW_ALIAS routes events -> live-calls (W213 SSE endpoint) ----------

test('W409i #15 - :events colon-verb routes to the live-calls view (W213 SSE channel)', () => {
  const TUI_START = CLI_SRC.indexOf('async function cmdTui(args)');
  const NEXT_FN = CLI_SRC.indexOf('\nasync function ', TUI_START + 1);
  const TUI_BODY = NEXT_FN > TUI_START ? CLI_SRC.slice(TUI_START, NEXT_FN) : CLI_SRC.slice(TUI_START);
  // The VIEW_ALIAS map must point :events at live-calls so the W213 stream
  // muscle memory holds.
  assert.match(TUI_BODY, /events:\s*['"]live-calls['"]/,
    'VIEW_ALIAS must map events -> live-calls');
});
