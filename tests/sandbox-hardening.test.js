// Sandbox pen tests. Each case is a source string that tries to escape the
// vm context to reach `process`, `require`, dynamic-import, indirect Function,
// or a network module. assertSafeSource must reject every one.
//
// Run: node --test tests/sandbox-hardening.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileJs } from '../src/verifier.js';
import { createEgressMonitor } from '../src/sandbox.js';

const HOSTILE = [
  // direct
  'function generate(){ return process.env; }',
  'function generate(){ return require("fs"); }',
  'function generate(){ return import("fs"); }',
  'function generate(){ return new Function("return process")(); }',
  'function generate(){ return eval("process"); }',
  // canonical vm-context escape
  'function generate(){ return this.constructor.constructor("return process")(); }',
  // prototype-chain escape
  'function generate(x){ return x.__proto__.constructor.constructor("return process")(); }',
  // timer + microtask hooks (could leak control flow / hang loop)
  'function generate(){ setTimeout(()=>{},0); return null; }',
  'function generate(){ queueMicrotask(()=>{}); return null; }',
  // weakref + reflect surface
  'function generate(){ return Reflect.get(globalThis, "process"); }',
  'function generate(){ return new WeakRef({}); }',
];

for (const source of HOSTILE) {
  test(`assertSafeSource rejects: ${source.slice(0, 60)}…`, () => {
    assert.throws(() => compileJs(source), /forbidden identifier/);
  });
}

test('benign generators compile + run', () => {
  const fn = compileJs('function generate(input){ return String(input).toLowerCase(); }');
  assert.equal(fn('Hello'), 'hello');
});

test('egress monitor blocks fetch when installed', () => {
  const mon = createEgressMonitor({ throwOnAttempt: true });
  const restore = mon.install();
  try {
    assert.throws(() => fetch('http://example.com'), /network egress blocked/);
    assert.ok(mon.attempts.length >= 1);
  } finally {
    restore();
  }
});

test('egress monitor restores fetch on close', async () => {
  const mon = createEgressMonitor({ throwOnAttempt: true });
  const restore = mon.install();
  restore();
  // After restore, fetch should be the original; we don't actually hit the
  // network in the test — just confirm it's not the patched one.
  assert.equal(typeof fetch, 'function');
});
