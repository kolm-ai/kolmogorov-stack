// @public-routes-only
// Wave 491 - status page subscribe form must terminate in a real public API.
//
// The public /status page ships a "Notify me" form. A production site cannot
// leave that form pointing at an unwired endpoint, so this locks in the small
// anonymous subscription route and the page copy that calls it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import { buildRouter } from '../src/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATUS_PAGE = path.resolve(__dirname, '..', 'public', 'status.html');

function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, () => {
      resolve({ srv, port: srv.address().port });
    });
  });
}

async function postSubscribe(port, email) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/status/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  let body = null;
  try { body = await res.json(); } catch {} // deliberate: cleanup
  return { status: res.status, body };
}

test('W491 #1 - /v1/status/subscribe accepts anonymous valid emails', async () => {
  const { srv, port } = await startServer();
  try {
    const email = `ops-${process.pid}-${Date.now()}@example.com`;
    const out = await postSubscribe(port, email);
    assert.equal(out.status, 201);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.subscribed, true);
    assert.equal(out.body.email, email);
  } finally {
    srv.close();
  }
});

test('W491 #2 - /v1/status/subscribe validates email shape', async () => {
  const { srv, port } = await startServer();
  try {
    const out = await postSubscribe(port, 'not-an-email');
    assert.equal(out.status, 400);
    assert.equal(out.body.error, 'valid email required');
  } finally {
    srv.close();
  }
});

test('W491 #3 - /status form posts to the wired route without placeholder copy', () => {
  const html = fs.readFileSync(STATUS_PAGE, 'utf8');
  assert.match(html, /id="subscribe-form"[\s\S]*action="\/v1\/status\/subscribe"/);
  assert.match(html, /fetch\('\/v1\/status\/subscribe'/);
  assert.doesNotMatch(html, /placeholder until|not enabled yet|Historical uptime will populate/i);
});
