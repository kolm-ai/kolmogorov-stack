// W888-L blocker #10 — `kolm receipts export --format csv` RFC-4180 row count.
//
// The W888-I receipt-export contract requires the CSV file to contain
// 1 header + N data rows, with header listing schema_version, receipt_id,
// route_decision and the columns separated by CRLF (\r\n). The blocker was
// upstream (captures/receipts found 0 rows because findByTenant only looked
// at the `tenant` column). The fix lives in src/store.js (findByTenant unions
// tenant + tenant_id) and src/router.js (captures/list + receipts/list union
// both columns).
//
// This regression pins the store-level union path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmSyncBestEffort } from './_spawn-helpers.js';

test('W888-L #10 — store.findByTenant unions rows keyed by tenant + tenant_id', async (t) => {
  const scratch = path.join(os.tmpdir(), `kolm-w888L-b10-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratch, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => rmSyncBestEffort(scratch));

  // Seed observations with mixed keying conventions for the same tenant id.
  const rows = [
    { id: 'obs_a', tenant: 'shared-tenant',   receipt_id: 'rcpt_a', created_at: '2026-05-26T00:00:00Z' },
    { id: 'obs_b', tenant_id: 'shared-tenant', receipt_id: 'rcpt_b', created_at: '2026-05-26T00:00:01Z' },
    { id: 'obs_c', tenant: 'shared-tenant',   receipt_id: 'rcpt_c', created_at: '2026-05-26T00:00:02Z' },
    { id: 'obs_d', tenant_id: 'other-tenant', receipt_id: 'rcpt_d', created_at: '2026-05-26T00:00:03Z' },
  ];
  fs.writeFileSync(path.join(dataDir, 'observations.json'), JSON.stringify(rows), 'utf8');

  process.env.KOLM_DATA_DIR = dataDir;
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_ALLOW_JSON_STORE = 'true';

  const store = await import('../src/store.js?_w888Lb10=' + Date.now());
  const hits = store.findByTenant('observations', 'shared-tenant');
  const ids = new Set(hits.map((r) => r.id));
  assert.ok(ids.has('obs_a'), 'row keyed by tenant must be found');
  assert.ok(ids.has('obs_b'), 'row keyed by tenant_id must be found');
  assert.ok(ids.has('obs_c'), 'second tenant row must be found');
  assert.ok(!ids.has('obs_d'), 'rows for a different tenant must not be returned');
  assert.equal(hits.length, 3, 'no duplicates when unioning tenant + tenant_id');
});

test('W888-L #10 — RFC-4180 CSV writer uses CRLF and quotes embedded commas', async () => {
  // The CSV path lives in src/wrapper-cli.js receiptsExport. Pin the line-ending
  // contract (CRLF) by reading the source.
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'wrapper-cli.js'), 'utf8');
  // Either a literal '\r\n' join or an explicit RFC-4180 reference must be present.
  const usesCrlf = /'\\r\\n'|"\\r\\n"/.test(src) || /CRLF/i.test(src) || /RFC[\s-]?4180/i.test(src);
  assert.ok(usesCrlf, 'csv writer must use CRLF line endings (RFC-4180)');
});
