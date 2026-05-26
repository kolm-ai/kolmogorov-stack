// W888-I ship-gate check #46 — RSS feed is valid.
//
// Pin /blog/feed.xml to:
//   1. Resolve over HTTP from the live server.
//   2. Be well-formed XML rooted at <rss version="2.0">.
//   3. Carry an Atom self-link (RSS Best Practice §1.4) so feed readers can
//      discover their own canonical URL.
//   4. Carry >= 5 <item> entries — the blog hub committed to a 5-post launch
//      cohort per the W888-K docs sweep + product readiness gates.
//   5. Each <item> has <title>, <link>, <guid>, <pubDate>, <description>.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, retries = 80) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {} // deliberate: cleanup
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}

test('W888-I #46 — /blog/feed.xml is well-formed RSS 2.0 with >= 5 items', async (t) => {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const dataDir = path.join(os.tmpdir(), `kolm-w888i-rss-data-${process.pid}-${Date.now()}`);
  const home = path.join(os.tmpdir(), `kolm-w888i-rss-home-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  t.after(() => {
    rmSyncBestEffort(dataDir);
    rmSyncBestEffort(home);
  });

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir,
      KOLM_HOME: home,
      KOLM_STORE_DRIVER: 'json',
      KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1',
      DEFAULT_TENANT: 'w888i-rss',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  t.after(() => killAndWait(proc));

  await waitForHealth(BASE);

  const res = await fetch(BASE + '/blog/feed.xml');
  assert.equal(res.status, 200, 'feed.xml must return 200');
  // express.static serves .xml as application/xml; tolerate text/xml too.
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  assert.ok(/xml/.test(ctype), 'content-type must be an xml family; got ' + ctype);
  const xml = await res.text();

  assert.match(xml, /^<\?xml\s+version=["']1\.0["']/m, 'must start with XML decl');
  assert.match(xml, /<rss\s+version=["']2\.0["']/, 'must declare rss 2.0');
  assert.match(xml, /<channel>[\s\S]*<\/channel>/, 'must contain a single channel');
  // Channel-level required RSS 2.0 elements.
  assert.match(xml, /<title>[^<]+<\/title>/, 'channel must have <title>');
  assert.match(xml, /<link>[^<]+<\/link>/, 'channel must have <link>');
  assert.match(xml, /<description>[^<]+<\/description>/, 'channel must have <description>');
  // RSS Best Practice — atom self-link.
  assert.match(xml, /atom:link[^>]*rel=["']self["']/, 'channel must carry atom:link rel=self');

  // Items.
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  assert.ok(items.length >= 5, `feed must have >= 5 items; got ${items.length}`);

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    assert.match(it, /<title>[\s\S]+<\/title>/, `item ${i} missing <title>`);
    assert.match(it, /<link>[\s\S]+<\/link>/, `item ${i} missing <link>`);
    assert.match(it, /<guid[^>]*>[\s\S]+<\/guid>/, `item ${i} missing <guid>`);
    assert.match(it, /<pubDate>[\s\S]+<\/pubDate>/, `item ${i} missing <pubDate>`);
    assert.match(it, /<description>[\s\S]+<\/description>/, `item ${i} missing <description>`);
  }
});
