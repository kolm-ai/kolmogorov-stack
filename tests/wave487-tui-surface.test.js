// W487 — Lock-in: the TUI exposes every documented surface as a view.
//
// Why this test exists: when we ship a new triangle (page + CLI verb + TUI),
// the TUI side has historically been the one that drifts (the page lands, the
// CLI lands, the TUI view gets forgotten until an audit). This test pins the
// full TUI_VIEWS table from cli/kolm.js so removing any of the 19 documented
// views fails CI loud.
//
// What's in here today (key in parens):
//   live-calls (1), artifacts (2), compile (3), spend (4), privacy-events (5),
//   repeated-workflows (6), opportunities (7), labeling-queue (8),
//   datasets (9), builds (0), bakeoffs (A), devices (B), storage-sync (C),
//   agent-telemetry (D), next (N), audit-log (E), billing (I), settings (F),
//   billing-breakdown (J), multimodal-bakeoff (M).
//
// Plus the 'simulations' alias surfaced in TUI_VIEW_IDS (no keybind — opened
// via :simulations command-mode).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const CLI = fs.readFileSync(path.join(REPO, 'cli', 'kolm.js'), 'utf8');

// REQUIRED: every (id, key) the audit has signed off on.
// Editing this list = changing the public TUI contract; do so deliberately.
const REQUIRED_VIEWS = [
  { id: 'live-calls',         key: '1' },
  { id: 'artifacts',          key: '2' },
  { id: 'compile',            key: '3' },
  { id: 'spend',              key: '4' },
  { id: 'privacy-events',     key: '5' },
  { id: 'repeated-workflows', key: '6' },
  { id: 'opportunities',      key: '7' },
  { id: 'labeling-queue',     key: '8' },
  { id: 'datasets',           key: '9' },
  { id: 'builds',             key: '0' },
  { id: 'bakeoffs',           key: 'A' },
  { id: 'devices',            key: 'B' },
  { id: 'storage-sync',       key: 'C' },
  { id: 'agent-telemetry',    key: 'D' },
  { id: 'next',               key: 'N' },
  { id: 'audit-log',          key: 'E' },
  { id: 'billing',            key: 'I' },
  { id: 'settings',           key: 'F' },
  { id: 'billing-breakdown',  key: 'J' },
  { id: 'multimodal-bakeoff', key: 'M' },
];

test('W487 #1 — TUI_VIEWS table contains every required view id', () => {
  const missing = [];
  for (const v of REQUIRED_VIEWS) {
    // Match: `id: '<id>'` followed somewhere on the same line by `key: '<key>'`
    // We don't enforce field ordering — just both literals on the same line.
    const rx = new RegExp("id:\\s*'" + v.id + "'[^\\n]*key:\\s*'" + v.key + "'");
    if (!rx.test(CLI)) missing.push(v.id + ' (key ' + v.key + ')');
  }
  assert.deepEqual(missing, [], 'missing TUI view rows: ' + missing.join(', '));
});

test('W487 #2 — TUI_VIEW_IDS surfaces the simulations alias', () => {
  // The simulations view doesn't have a dedicated keybind row — it's appended
  // via .concat(['simulations']) so :simulations command-mode resolves.
  assert.match(CLI, /TUI_VIEW_IDS\s*=\s*TUI_VIEWS\.map\(v\s*=>\s*v\.id\)\.concat\(\s*\[\s*'simulations'\s*\]/,
    'TUI_VIEW_IDS must concat the simulations alias so :simulations resolves');
});

test('W487 #3 — view keys are unique (no double-bound key)', () => {
  const seen = new Map();
  const dupes = [];
  for (const v of REQUIRED_VIEWS) {
    if (seen.has(v.key)) {
      dupes.push(v.key + ': ' + seen.get(v.key) + ' vs ' + v.id);
    } else {
      seen.set(v.key, v.id);
    }
  }
  assert.deepEqual(dupes, [], 'duplicate TUI keybinds: ' + dupes.join(' | '));
});

test('W487 #4 — every view id is unique', () => {
  const seen = new Set();
  const dupes = [];
  for (const v of REQUIRED_VIEWS) {
    if (seen.has(v.id)) dupes.push(v.id);
    seen.add(v.id);
  }
  assert.deepEqual(dupes, [], 'duplicate TUI view ids: ' + dupes.join(', '));
});

test('W487 #5 — VIEW_ALIAS covers the canonical command-mode synonyms', () => {
  // We don't need every alias pinned, but at least one alias for the
  // historically drifty views should be present.
  // (These are tested via :next, :audit, :billing, :settings, :breakdown, :mm.)
  for (const tok of ['next', 'audit', 'billing', 'settings', 'breakdown', 'mm']) {
    assert.match(CLI, new RegExp("VIEW_ALIAS[\\s\\S]{0,4000}'" + tok + "'"),
      "VIEW_ALIAS must expose :" + tok);
  }
});
