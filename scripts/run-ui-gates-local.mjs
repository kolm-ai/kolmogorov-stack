#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';
import app from '../server.js';

const port = Number(process.env.PORT || 8787);
const base = `http://localhost:${port}`;
const routes = [
  '/',
  '/capture',
  '/marketplace',
  '/pricing',
  '/docs',
  '/api',
  '/security',
  '/trust',
  '/training',
  '/compile',
  '/ask',
  '/verify-prod',
  '/product',
  '/runtimes',
  '/sdks',
  '/self-host',
  '/build-your-own',
  '/benchmarks',
  '/account/overview'
].join(',');

function run(label, args) {
  console.log(`\n[ui-gate] ${label}`);
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env },
    windowsHide: true
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
  });
}

const server = app.listen(port);
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});

try {
  console.log(`[ui-gate] local server listening on ${base}`);
  await run('rendered surface audit', [
    'scripts/audit-rendered-surface.mjs',
    '--base',
    base,
    '--timeout-ms',
    '5000',
    '--wait-ms',
    '40',
    '--progress-every',
    '100'
  ]);
  await run('screenshot QA', ['scripts/qa-screenshots.mjs', '--base', base, '--routes', routes]);
} finally {
  await new Promise((resolve) => server.close(resolve));
  console.log('[ui-gate] local server closed');
}
