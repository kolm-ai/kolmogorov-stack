// Wave 596 - starter redactor must work on the exact first-run path.
//
// This exercises the product the way a developer does: scaffold a redactor,
// compile it, then run it with the portable --input file form. The starter
// help text uses local phone examples, so the template must redact those
// instead of only handling 10-digit national numbers.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w596-redactor-'));
}

function runCli(args, cwd, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      KOLM_AUTO_YES: '1',
      KOLM_DATA_DIR: path.join(cwd, '.kolm-data'),
      ...env,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

test('W596 #1 - redactor starter compiles and redacts local phone help example via --input file', () => {
  const cwd = tmpDir();
  try {
    const spec = path.join(cwd, 'pii-redactor.spec.json');
    const artifact = path.join(cwd, 'pii-redactor.kolm');
    const input = path.join(cwd, 'input.json');
    fs.writeFileSync(input, JSON.stringify({ text: 'Call Jane at 555-1212' }), 'utf8');

    const scaffold = runCli(['new', 'pii-redactor', '--from', 'redactor', '--out', spec, '--yes'], cwd);
    assert.equal(scaffold.status, 0, scaffold.stderr || scaffold.stdout);
    assert.match(scaffold.stdout, /template: redactor/);

    const compile = runCli(['compile', '--spec', spec, '--out', artifact, '--json'], cwd);
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    assert.doesNotMatch(compile.stderr, /spec\.evals\.n=.*cases\.length=/);
    const compileBody = JSON.parse(compile.stdout);
    assert.equal(compileBody.evals_report.total, 3);
    assert.equal(compileBody.evals_report.passed, 3);
    assert.ok(fs.existsSync(artifact));

    const run = runCli(['run', artifact, '--input', input, '--json'], cwd);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const runBody = JSON.parse(run.stdout);
    assert.equal(runBody.output.redacted, 'Call Jane at [PHONE]');
    assert.deepEqual(runBody.output.hits, [{ name: 'PHONE', count: 1 }]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('W596 #2 - redactor starter preserves standard 10-digit phone and SSN behavior', () => {
  const cwd = tmpDir();
  try {
    const spec = path.join(cwd, 'pii-redactor.spec.json');
    const artifact = path.join(cwd, 'pii-redactor.kolm');
    const phoneInput = path.join(cwd, 'phone.json');
    const ssnInput = path.join(cwd, 'ssn.json');
    fs.writeFileSync(phoneInput, JSON.stringify({ text: 'call 555-123-4567 today' }), 'utf8');
    fs.writeFileSync(ssnInput, JSON.stringify({ text: 'ssn 123-45-6789' }), 'utf8');

    assert.equal(runCli(['new', 'pii-redactor', '--from', 'redactor', '--out', spec, '--yes'], cwd).status, 0);
    assert.equal(runCli(['compile', '--spec', spec, '--out', artifact, '--json'], cwd).status, 0);

    const phone = JSON.parse(runCli(['run', artifact, '--input', phoneInput, '--json'], cwd).stdout);
    assert.equal(phone.output.redacted, 'call [PHONE] today');
    assert.deepEqual(phone.output.hits, [{ name: 'PHONE', count: 1 }]);

    const ssn = JSON.parse(runCli(['run', artifact, '--input', ssnInput, '--json'], cwd).stdout);
    assert.equal(ssn.output.redacted, 'ssn [SSN]');
    assert.deepEqual(ssn.output.hits, [{ name: 'SSN_LIKE', count: 1 }]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
