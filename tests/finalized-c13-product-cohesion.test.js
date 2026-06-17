import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const activeContractFiles = [
  'docs/product-journeys.json',
  'docs/product-sota-readiness.json',
  'docs/product-surfaces.json',
  'public/product-graph.json',
  'public/product-readiness-closeout.json',
  'scripts/build-catalog-manifest.mjs',
  'src/build-strategy-brain.js',
  'src/next-actions.js',
  'src/platform-capabilities.js',
  'src/product-experience.js',
  'src/repo-codegraph.js',
];

const retiredAccountUiPaths = [
  '/account/connectors',
  '/account/lake',
  '/account/builds',
  '/account/datasets',
  '/account/privacy-events',
  '/account/opportunities',
];

const activeAccountPages = [
  'public/account/overview.html',
  'public/account/train.html',
  'public/account/api-control-center.html',
  'public/account/org.html',
  'public/account/dashboard.html',
  'public/account-billing.html',
];

test('C13 product contracts point at the current account spine', () => {
  for (const rel of activeContractFiles) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const retired of retiredAccountUiPaths) {
      assert.equal(
        text.includes(retired),
        false,
        `${rel} must not reference retired account UI path ${retired}`,
      );
    }
  }
});

test('C13 active account pages are source-owned in the file ledger', () => {
  const ledger = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/internal/codebase-file-ledger.json'), 'utf8'));
  const rows = ledger.paths || ledger.files || [];
  for (const rel of activeAccountPages) {
    const row = rows.find((entry) => entry.path === rel);
    assert.ok(row, `${rel} must appear in the file ledger`);
    assert.equal(row.kind, 'source', `${rel} must be classified as source`);
    assert.equal(row.generated_by, null, `${rel} must not be owned by the retired account generator`);
    assert.equal(row.dirty_state, 'clean', `${rel} must not make the ledger dirty`);
  }
});

test('C13 retired account generator fails closed by default', () => {
  const script = path.join(REPO, 'scripts/build-account-pages.cjs');
  const result = spawnSync(process.execPath, [script], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, KOLM_ALLOW_RETIRED_ACCOUNT_GENERATOR: '' },
    timeout: 5000,
  });

  assert.notEqual(result.status, 0, 'retired account generator must not run unless explicitly enabled');
  assert.match(result.stderr, /build-account-pages\.cjs is retired/);
  assert.match(result.stderr, /KOLM_ALLOW_RETIRED_ACCOUNT_GENERATOR=1/);
});
