// W414 — TUI gains a Next-actions view that mirrors `kolm next` (CLI) and
// /account/overview Next-Actions panel (web). Same source for all three:
// snapshotContext + recommendNext via the W413 /v1/intent/next route.
//
// Lock-in contracts (all source-grep, no spawn — the W384 #25 TTY guard
// already covers the spawned non-TTY exit path):
//   1) cmdTui's TUI_VIEWS registry includes a `next` row with key 'N',
//      endpoint '/v1/intent/next', kind 'get'.
//   2) loadViewGet unwraps the {recommendations:[...]} envelope so the TUI
//      shows the list of recommendations rather than the whole envelope as
//      one row.
//   3) The status bar advertises `N=next` so the keybind is discoverable.
//   4) The in-pane keybind hint (when the right pane is empty) also lists
//      `N=next`.
//   5) The `:` command-mode VIEW_ALIAS table maps `next` → `next` so
//      `:next<Enter>` switches to the view (matches the :events / :datasets
//      pattern the help banner advertises).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const KOLM_JS = fs.readFileSync(CLI_PATH, 'utf8');

// Helper — extract the cmdTui body so subsequent assertions don't false-match
// on a literal that lives elsewhere in cli/kolm.js.
function cmdTuiBody() {
  const idx = KOLM_JS.indexOf('async function cmdTui(args)');
  assert.ok(idx > 0, 'cmdTui must exist in cli/kolm.js');
  const next = KOLM_JS.indexOf('\nasync function ', idx + 1);
  return next > idx ? KOLM_JS.slice(idx, next) : KOLM_JS.slice(idx);
}

// =============================================================================
// 1) TUI_VIEWS lists the `next` row with key:'N' + /v1/intent/next.
// =============================================================================

test('W414 #1 — TUI_VIEWS registers a next row (id=next, key=N, endpoint=/v1/intent/next)', () => {
  const body = cmdTuiBody();
  // The id literal.
  assert.ok(/id:\s*'next'/.test(body),
    'TUI_VIEWS must include a {id: "next", ...} row');
  // The key literal — `N` is the binding to switch to this view.
  assert.ok(/key:\s*'N'/.test(body),
    'next view must bind key N');
  // The endpoint literal — the W413 server-side recommender route.
  assert.ok(/endpoint:\s*'\/v1\/intent\/next'/.test(body),
    'next view must call /v1/intent/next');
});

// =============================================================================
// 2) loadViewGet unwraps the {recommendations:[...]} envelope.
// =============================================================================

test('W414 #2 — loadViewGet unwraps {recommendations:[...]} so the TUI shows the list', () => {
  const body = cmdTuiBody();
  // The W414 fix to loadViewGet adds a branch for `recommendations`.
  assert.ok(/Array\.isArray\(data\.recommendations\)\s*\?\s*data\.recommendations/.test(body),
    'loadViewGet must include an Array.isArray(data.recommendations) ? data.recommendations branch');
});

// =============================================================================
// 3) Status bar advertises N=next.
// =============================================================================

test('W414 #3 — status bar advertises N=next', () => {
  const body = cmdTuiBody();
  // Match the literal "N=next" substring inside the status field initializer.
  assert.ok(/N\s*=\s*next/.test(body),
    'cmdTui status banner must include N=next so the keybind is discoverable');
});

// =============================================================================
// 4) In-pane keybind hint also advertises N=next.
// =============================================================================

test('W414 #4 — in-pane (empty-detail) keybind hint advertises N=next', () => {
  const body = cmdTuiBody();
  // Count `N=next` occurrences — there must be 2+ (status bar + empty-detail
  // help). The first is asserted by #3; this lower-bound covers the help.
  const matches = body.match(/N\s*=\s*next/g) || [];
  assert.ok(matches.length >= 2,
    'N=next must appear in BOTH the status bar and the empty-detail help (got ' + matches.length + ')');
});

// =============================================================================
// 5) `:next` command-mode alias.
// =============================================================================

test('W414 #5 — VIEW_ALIAS maps :next → next so the colon-command works', () => {
  const body = cmdTuiBody();
  // The shorthand-key form (`next: 'next'`) is the one the docstring above
  // VIEW_ALIAS describes as the "runtime truth". Accept either form.
  assert.ok(/(\bnext:\s*'next')|('next'\s*:\s*'next')/.test(body),
    'VIEW_ALIAS must map next → next so `:next<Enter>` opens the Next-actions view');
});
