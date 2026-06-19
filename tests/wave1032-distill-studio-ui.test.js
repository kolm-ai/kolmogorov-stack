// W1032 - no-code Distill Studio surface contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(rel) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

test('W1032 Distill Studio is a real no-code train, distill, compile workspace', () => {
  const html = read('public/studio.html');
  assert.match(html, /data-studio-version="w1034-studio-evidence-cockpit-v1"/);
  assert.match(html, /Distill Studio/);
  assert.match(html, /No-code train, distill, compile loop/);
  assert.match(html, /id="namespace"/);
  assert.match(html, /id="preset"/);
  assert.match(html, /QDoRA/);
  assert.match(html, /id="backend"/);
  assert.match(html, /id="provider"/);
  assert.match(html, /id="startDistill"/);
  assert.match(html, /id="startCompile"/);
  assert.match(html, /id="submitCloud"/);
  assert.match(html, /id="artifactLink"/);
  assert.match(html, /Live run timeline/);
  assert.match(html, /Readiness and provenance/);
  assert.match(html, /aria-live="polite"/);
});

test('W1032 Studio wires the production distill APIs without unsafe DOM sinks', () => {
  const html = read('public/studio.html');
  for (const endpoint of [
    '/v1/distill/from-captures/preview',
    '/v1/distill/from-captures',
    '/v1/distill/strategy',
    '/v1/cloud/distill/submit',
    '/v1/account/compiler-overview',
    '/v1/compile',
    '/v1/compile/stream/:job',
    '/v1/distill/runs',
    '/v1/captures/list',
  ]) {
    assert.match(html, new RegExp(endpoint.replace(/[/.]/g, '\\$&')));
  }
  assert.doesNotMatch(html, /\.innerHTML\s*=/);
  assert.match(html, /textContent/);
  assert.match(html, /localStorage/);
  assert.match(html, /authorization.*Bearer/s);
  assert.match(html, /job_id \|\| data\.job/);
  assert.match(html, /step\.start/);
  assert.match(html, /step\.end/);
});

test('W1032 Studio is linked from the existing train workspace', () => {
  const train = read('public/account/train.html');
  assert.match(train, /href="\/studio"/);
  assert.match(train, /job_id \|\| o\.body\.job/);
  assert.match(train, /step\.start/);
  assert.match(train, /step\.end/);
});
