#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const srcDir = path.resolve(root, process.argv[2] || 'packages/winget');
const required = [
  'kolm.kolm.yaml',
  'kolm.kolm.installer.yaml',
  'kolm.kolm.locale.en-US.yaml',
];

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const probe = spawnSync('winget', ['--version'], { encoding: 'utf8' });
if (probe.error) {
  fail(`winget tool unavailable: ${probe.error.message}`, 127);
}

if (!fs.existsSync(srcDir)) fail(`winget manifest source missing: ${srcDir}`, 2);
for (const name of required) {
  const full = path.join(srcDir, name);
  if (!fs.existsSync(full)) fail(`winget manifest file missing: ${name}`, 2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-winget-'));
try {
  for (const name of required) {
    fs.copyFileSync(path.join(srcDir, name), path.join(tmp, name));
  }
  const result = spawnSync('winget', ['validate', '--manifest', tmp], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (
    result.status !== 0
    && /Manifest validation succeeded with warnings\./.test(output)
    && !/Manifest Error:/i.test(output)
  ) {
    process.exit(0);
  }
  process.exit(result.status == null ? 1 : result.status);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
