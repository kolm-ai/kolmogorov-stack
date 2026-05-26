// Lock-in: src/sentry-init.js is env-gated and safe-by-default.
//
// Properties under test:
//   1. With no SENTRY_DSN, initSentry() returns null synchronously-resolved.
//   2. Default export and named export agree.
//   3. With a DSN set but @sentry/node not installed, initSentry() still
//      returns null instead of throwing.
//   4. Explicit { dsn: null } overrides the env var to null and returns null.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function modUrl(rel) {
  return pathToFileURL(path.join(ROOT, rel)).href;
}

test('sentry-init: returns null when SENTRY_DSN is missing', async () => {
  const prev = process.env.SENTRY_DSN;
  delete process.env.SENTRY_DSN;
  try {
    const { initSentry } = await import(modUrl('src/sentry-init.js'));
    const result = await initSentry();
    assert.equal(result, null, 'expected null when no DSN is configured');
  } finally {
    if (prev !== undefined) process.env.SENTRY_DSN = prev;
  }
});

test('sentry-init: default export and named export are the same function', async () => {
  const mod = await import(modUrl('src/sentry-init.js'));
  assert.equal(typeof mod.initSentry, 'function');
  assert.equal(typeof mod.default, 'function');
  assert.equal(mod.default, mod.initSentry);
});

test('sentry-init: returns null when @sentry/node is not installed even with DSN set', async () => {
  // We exercise the catch branch by passing a DSN explicitly. The dynamic
  // import('@sentry/node') will throw ERR_MODULE_NOT_FOUND when the package
  // is absent from node_modules; the shim swallows it and returns null.
  // If the package IS installed in this environment, the call returns a
  // Sentry namespace object — also acceptable. Either way: never throws.
  const { initSentry } = await import(modUrl('src/sentry-init.js'));
  const result = await initSentry({ dsn: 'https://public@example.invalid/1' });
  assert.ok(result === null || typeof result === 'object', 'expected null or Sentry namespace, never a throw');
});

test('sentry-init: explicit { dsn: null } short-circuits to null', async () => {
  const prev = process.env.SENTRY_DSN;
  process.env.SENTRY_DSN = 'https://public@example.invalid/2';
  try {
    const { initSentry } = await import(modUrl('src/sentry-init.js'));
    const result = await initSentry({ dsn: null });
    assert.equal(result, null, 'explicit null DSN must override env var');
  } finally {
    if (prev === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = prev;
  }
});

test('sentry-init: does not pollute process listeners when DSN is missing', async () => {
  const prev = process.env.SENTRY_DSN;
  delete process.env.SENTRY_DSN;
  const before = process.listenerCount('uncaughtException');
  try {
    const { initSentry } = await import(modUrl('src/sentry-init.js'));
    await initSentry();
    const after = process.listenerCount('uncaughtException');
    assert.equal(after, before, 'no-op path must not register process listeners');
  } finally {
    if (prev !== undefined) process.env.SENTRY_DSN = prev;
  }
});
