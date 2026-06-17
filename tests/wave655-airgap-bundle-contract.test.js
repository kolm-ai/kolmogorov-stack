// W655 - direct contract/security test for src/airgap-bundle.js.
//
// The repo-wide airgap bundle is a stateful export boundary. It must not
// follow symlinks out of the repo, include its own output tarball, or leak
// host-local source paths into the in-bundle manifest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { AIRGAP_BUNDLE_VERSION, buildAirgapBundle } from '../src/airgap-bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TARGET = 'src/airgap-bundle.js';

function writeFile(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function tarEntries(tgzPath) {
  const buf = zlib.gunzipSync(fs.readFileSync(tgzPath));
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!rawName) break;
    const rawPrefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const name = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeText || '0', 8);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    entries.set(name.replace(/\\/g, '/'), buf.subarray(dataStart, dataEnd));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function makeRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-airgap-w655-'));
  const repo = path.join(tmp, 'repo');
  const outside = path.join(tmp, 'outside');
  const models = path.join(outside, 'private-model-source');
  fs.mkdirSync(repo, { recursive: true });
  writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'w655-airgap', version: '0.0.0' }));
  writeFile(path.join(repo, 'cli', 'kolm.js'), 'console.log("kolm");\n');
  writeFile(path.join(repo, 'src', 'index.js'), 'export const ok = true;\n');
  writeFile(path.join(repo, 'docs', 'readme.md'), '# offline docs\n');
  writeFile(path.join(repo, '.env'), 'SECRET=must-not-ship\n');
  writeFile(path.join(repo, '.kolm', 'state.json'), '{"secret":true}\n');
  writeFile(path.join(models, 'model.bin'), 'model-weights\n');
  writeFile(path.join(outside, 'outside-secret.txt'), 'DO_NOT_BUNDLE_SECRET\n');
  let symlinkCreated = false;
  try {
    fs.symlinkSync(path.join(outside, 'outside-secret.txt'), path.join(repo, 'src', 'leak-secret.txt'));
    symlinkCreated = true;
  } catch {
    symlinkCreated = false;
  }
  return { tmp, repo, outside, models, symlinkCreated };
}

test('W655 airgap bundle rejects invalid destinations without throwing', async () => {
  assert.equal(TARGET, 'src/airgap-bundle.js');
  const src = fs.readFileSync(path.join(ROOT, TARGET), 'utf8');
  assert.match(src, /fs\.lstatSync/);
  assert.match(src, /st\.isSymbolicLink\(\)/);
  assert.match(src, /excludeAbs/);

  const invalidType = await buildAirgapBundle({ dest_path: 42 });
  assert.equal(invalidType.ok, false);
  assert.equal(invalidType.error, 'dest_path_required');

  const invalidExt = await buildAirgapBundle({ dest_path: path.join(os.tmpdir(), 'bundle.zip') });
  assert.equal(invalidExt.ok, false);
  assert.equal(invalidExt.error, 'dest_path_extension');
});

test('W655 airgap bundle excludes symlink targets, self-output, secrets, and host source paths', async () => {
  const repo = makeRepo();
  const dest = path.join(repo.repo, 'docs', 'kolm-airgap.tar.gz');
  const result = await buildAirgapBundle({
    repo_root: repo.repo,
    dest_path: dest,
    with_models: true,
    models_dir: repo.models,
  });

  assert.equal(result.ok, true);
  assert.equal(result.version, AIRGAP_BUNDLE_VERSION);
  assert.equal(result.path, dest);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);

  const entries = tarEntries(dest);
  assert.ok(entries.has('MANIFEST.json'));
  assert.ok(entries.has('BUNDLE-README.md'));
  assert.ok(entries.has('VERSION'));
  assert.equal(entries.has('docs/kolm-airgap.tar.gz'), false, 'bundle must not include itself');
  assert.equal(entries.has('.env'), false, 'repo secrets must not be bundled');
  assert.equal(entries.has('.kolm/state.json'), false, 'user state must not be bundled');
  assert.equal(entries.has('models/model.bin'), true, 'configured models are copied under the in-bundle models/ path');
  if (repo.symlinkCreated) {
    assert.equal(entries.has('src/leak-secret.txt'), false, 'symlinks must not be followed into the bundle');
  }

  const allBytes = Buffer.concat([...entries.values()]);
  assert.equal(allBytes.includes(Buffer.from('DO_NOT_BUNDLE_SECRET')), false);

  const manifest = JSON.parse(entries.get('MANIFEST.json').toString('utf8'));
  assert.equal(manifest.version, AIRGAP_BUNDLE_VERSION);
  assert.equal(manifest.options.with_models, true);
  assert.equal(manifest.options.models_dir, 'models', 'manifest must name the in-bundle model path, not the host source path');
  assert.equal(manifest.files.some((f) => f.path === 'docs/kolm-airgap.tar.gz'), false);
  assert.equal(manifest.files.some((f) => f.path === 'src/leak-secret.txt'), false);
  assert.equal(manifest.files.some((f) => f.path === 'models/model.bin'), true);
  assert.equal(result.manifest_files, manifest.files.length);

  for (const f of manifest.files) {
    const entry = entries.get(f.path);
    assert.ok(entry, `manifest entry ${f.path} must exist in tarball`);
    assert.equal(entry.length, f.bytes, `${f.path} byte count must match`);
    assert.equal(sha256(entry), f.sha256, `${f.path} sha256 must match`);
  }
});
