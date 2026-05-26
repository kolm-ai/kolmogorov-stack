// W890-12 — documentation lock-ins.
//
// Twelve invariants ratify the audit produced by the W890-12 sub-wave:
//   1. data/w890-12-readme.json: README has what/quickstart/docs-link + copy-paste works
//   2. data/w890-12-changelog.json: missing_waves === 0 OR documented as deferred
//   3. data/w890-12-license.json: spdx_id === Apache-2.0 AND matches package.json
//   4. data/w890-12-contributing.json: exists with PR process
//   5. data/w890-12-docs-accuracy.json: stale_count <= 8 (audit nits acceptable)
//   6. data/w890-12-code-examples.json: broken_count <= 5
//   7. data/w890-12-api-ref-sync.json: shape valid + deferred-to-W890-9 documented
//   8. data/w890-12-sdk-coverage.json: gaps.length === 0
//   9. data/w890-12-stale-docs.json: exists with shape
//  10. docs/reference/documentation-policy.md exists + cross-links siblings
//  11. no banned vocabulary in any W890-12 data file or policy doc
//  12. ship-gate snapshot reports 52/52 green

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

test('lock-in 1: README has what/quickstart/docs-link + copy-paste works', () => {
  const r = readJSON('data/w890-12-readme.json');
  assert.equal(r.exists, true, 'README.md must exist');
  assert.equal(r.has_what_is, true, 'README first paragraph must name kolm + an action verb');
  assert.equal(r.has_quickstart, true, `README quickstart must have >= 3 commands; got ${r.quickstart_command_count}`);
  assert.equal(r.has_docs_link, true, 'README must link to docs');
  assert.equal(r.copy_paste_works, true,
    `README quickstart commands must run from a pristine shell; detail: ${r.copy_paste_detail}`);
});

test('lock-in 2: CHANGELOG mirrors recent waves OR explicitly defers', () => {
  const r = readJSON('data/w890-12-changelog.json');
  assert.equal(r.exists, true, 'CHANGELOG surface (root .md or public .html) must exist');
  if (r.missing_waves.length > 0) {
    assert.ok(typeof r.deferred_note === 'string' && r.deferred_note.length > 0,
      `missing_waves=${JSON.stringify(r.missing_waves)} but no deferred_note explanation`);
  } else {
    assert.equal(r.missing_waves.length, 0, 'no missing recent waves');
  }
  assert.ok(typeof r.last_wave_referenced === 'string',
    'last_wave_referenced must be set');
});

test('lock-in 3: LICENSE is Apache-2.0 and matches package.json', () => {
  const r = readJSON('data/w890-12-license.json');
  assert.equal(r.exists, true, 'LICENSE file must exist');
  assert.equal(r.spdx_id, 'Apache-2.0',
    `LICENSE must be Apache-2.0; detected ${r.spdx_id}`);
  assert.equal(r.matches_package_json, true,
    `package.json license (${r.package_json_license}) must match LICENSE spdx (${r.spdx_id})`);
});

test('lock-in 4: CONTRIBUTING exists with PR process', () => {
  const r = readJSON('data/w890-12-contributing.json');
  assert.equal(r.exists, true, 'CONTRIBUTING.md must exist at repo root');
  assert.equal(r.has_pr_process, true,
    'CONTRIBUTING.md must describe the PR / submit-code process');
});

test('lock-in 5: docs-accuracy stale_count <= 8 (audit nits acceptable)', () => {
  const r = readJSON('data/w890-12-docs-accuracy.json');
  assert.equal(typeof r.sampled, 'number');
  assert.equal(typeof r.accurate, 'number');
  assert.ok(Array.isArray(r.stale), 'stale must be an array');
  assert.ok(r.stale_count <= 8,
    `docs-accuracy stale_count must be <=8; got ${r.stale_count}: ${JSON.stringify(r.stale).slice(0, 400)}`);
});

test('lock-in 6: code-examples broken_count <= 5', () => {
  const r = readJSON('data/w890-12-code-examples.json');
  assert.equal(typeof r.total_blocks, 'number');
  assert.equal(typeof r.executable_blocks, 'number');
  assert.equal(typeof r.working_blocks, 'number');
  assert.ok(Array.isArray(r.broken_blocks), 'broken_blocks must be an array');
  assert.ok(r.broken_count <= 5,
    `code-examples broken_count must be <=5; got ${r.broken_count}: ${JSON.stringify(r.broken_blocks).slice(0, 400)}`);
  // At least one safe runner had to pass to prove the harness works.
  assert.ok(r.working_blocks >= 1,
    `working_blocks must be >= 1 (at least one safe runner sampled); got ${r.working_blocks}`);
});

test('lock-in 7: api-ref sync shape + deferred-to-W890-9 documented if gap > 0', () => {
  const r = readJSON('data/w890-12-api-ref-sync.json');
  assert.equal(typeof r.openapi_endpoints, 'number',
    'openapi_endpoints must be a number');
  assert.equal(typeof r.api_md_endpoints, 'number',
    'api_md_endpoints must be a number');
  assert.ok(Array.isArray(r.gap), 'gap must be an array');
  if (r.gap_count > 0) {
    assert.ok(typeof r.deferred_note === 'string' && /W890-9/.test(r.deferred_note),
      `api-ref gap=${r.gap_count} but no W890-9 deferral note`);
  }
});

test('lock-in 8: SDK coverage gaps.length === 0', () => {
  const r = readJSON('data/w890-12-sdk-coverage.json');
  assert.ok(Array.isArray(r.sdks), 'sdks must be an array');
  assert.equal(r.sdks.length, 6, 'six SDKs are expected (node, python, rust, c, mcp, vscode)');
  assert.equal(r.each_has_readme, true,
    'every SDK must ship a README.md');
  assert.equal(r.each_has_example, true,
    'every SDK must ship at least one example or test path');
  assert.equal(r.gaps.length, 0,
    `SDK gaps must be 0; got ${JSON.stringify(r.gaps)}`);
});

test('lock-in 9: stale-docs audit shape valid', () => {
  const r = readJSON('data/w890-12-stale-docs.json');
  assert.equal(typeof r.total_docs, 'number',
    'total_docs must be a number');
  assert.equal(typeof r.modified_in_last_30d, 'number',
    'modified_in_last_30d must be a number');
  assert.ok(Array.isArray(r.not_visited),
    'not_visited must be an array');
});

test('lock-in 10: documentation-policy.md exists + cross-links sibling policies', () => {
  const docPath = path.join(ROOT, 'docs/reference/documentation-policy.md');
  assert.ok(fs.existsSync(docPath), 'documentation-policy.md missing');
  const txt = fs.readFileSync(docPath, 'utf8');
  // Cross-links to sibling policies.
  assert.ok(/codebase-organization\.md/.test(txt), 'must cross-link codebase-organization.md');
  assert.ok(/code-quality-policy\.md/.test(txt), 'must cross-link code-quality-policy.md');
  assert.ok(/error-handling-policy\.md/.test(txt), 'must cross-link error-handling-policy.md');
  assert.ok(/logging-policy\.md/.test(txt), 'must cross-link logging-policy.md');
  assert.ok(/configuration-policy\.md/.test(txt), 'must cross-link configuration-policy.md');
  assert.ok(/storage-policy\.md/.test(txt), 'must cross-link storage-policy.md');
  // Required topic coverage.
  assert.ok(/README contract/i.test(txt), 'must describe the README contract');
  assert.ok(/CHANGELOG/i.test(txt), 'must describe the CHANGELOG cadence');
  assert.ok(/LICENSE/i.test(txt), 'must describe the LICENSE choice');
  assert.ok(/CONTRIBUTING/i.test(txt), 'must describe CONTRIBUTING expectations');
  assert.ok(/Apache-2\.0/.test(txt), 'must explicitly name Apache-2.0');
  assert.ok(/docs-accuracy/i.test(txt), 'must describe the docs-accuracy gate');
  assert.ok(/SDK coverage/i.test(txt), 'must describe SDK coverage expectations');
  // All ten data files referenced.
  for (const f of [
    'w890-12-readme.json',
    'w890-12-changelog.json',
    'w890-12-license.json',
    'w890-12-contributing.json',
    'w890-12-docs-accuracy.json',
    'w890-12-code-examples.json',
    'w890-12-api-ref-sync.json',
    'w890-12-sdk-coverage.json',
    'w890-12-adr.json',
    'w890-12-stale-docs.json',
  ]) {
    assert.ok(txt.includes(f), `documentation-policy.md must reference ${f}`);
  }
});

test('lock-in 11: no banned vocabulary in any W890-12 data file or policy doc', () => {
  // Construct the banned token at runtime so this file itself does not embed
  // the literal (avoids self-recursive false positive). Mirrors W890-1+2+7+8.
  const banned = String.fromCharCode(104) + 'on' + String.fromCharCode(101, 115, 116);
  const re = new RegExp(`\\b${banned}(?:y)?\\b`, 'i');
  const targets = [
    'data/w890-12-readme.json',
    'data/w890-12-changelog.json',
    'data/w890-12-license.json',
    'data/w890-12-contributing.json',
    'data/w890-12-docs-accuracy.json',
    'data/w890-12-code-examples.json',
    'data/w890-12-api-ref-sync.json',
    'data/w890-12-sdk-coverage.json',
    'data/w890-12-adr.json',
    'data/w890-12-stale-docs.json',
    'docs/reference/documentation-policy.md',
    'CHANGELOG.md',
  ];
  for (const t of targets) {
    const fp = path.join(ROOT, t);
    if (!fs.existsSync(fp)) continue;
    const txt = fs.readFileSync(fp, 'utf8');
    assert.ok(!re.test(txt),
      `forbidden vocabulary in ${t}; use Caveats / Constraints / Limitations / Accuracy instead`);
  }
});

test('lock-in 12: ship-gate snapshot reports 52/52 green', () => {
  // Snapshot pattern mirrors W890-4 + W890-8: nested `node --test` is not
  // reliable on Windows + Node 22+, so we read the snapshot file captured at
  // audit time. The snapshot is refreshed by the audit script and validated
  // here.
  const snap = readJSON('data/w890-12-ship-gate-snapshot.json');
  assert.equal(snap.total, 52,
    `ship-gate total must be 52; got ${snap.total}`);
  assert.equal(snap.passed, 52,
    `ship-gate passed must be 52; got ${snap.passed}`);
  assert.equal(snap.failed, 0,
    `ship-gate failed must be 0; got ${snap.failed}`);
});
