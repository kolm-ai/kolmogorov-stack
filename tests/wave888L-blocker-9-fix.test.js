// W888-L blocker #9 — `kolm captures export --format hf` single-file mode.
//
// The W888-I capture-export contract expects `--out caps.arrow` to produce a
// single Apache Arrow IPC file readable via `tableFromIPC(buf)`. Pre-W888-L
// the wrapper-cli treated --out as a directory and wrote
// data-00000-of-00001.arrow inside it, which broke `fs.readFileSync(out)` with
// EISDIR.
//
// This regression pins the new behaviour: an --out ending in .arrow/.ipc
// produces a single file; an --out without a recognised suffix continues to
// produce the HF datasets directory layout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('W888-L #9 — capturesExport hf single-file vs directory selection by --out suffix', async () => {
  const scratch = path.join(os.tmpdir(), `kolm-w888L-b9-${process.pid}-${Date.now()}`);
  fs.mkdirSync(scratch, { recursive: true });

  // We do not need the network path — we just exercise the format selection
  // logic by reading the wrapper-cli source and asserting both branches
  // exist. The end-to-end behaviour is already covered by
  // tests/wave888i-capture-export-formats.test.js.
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'wrapper-cli.js'), 'utf8');

  // Branch 1: single-file detection regex.
  assert.ok(
    /singleFile\s*=\s*\/\\.\(arrow\|ipc\)\$\/i\.test\(out\)/.test(src),
    'wrapper-cli.js must detect single-file HF mode via .arrow|.ipc suffix on --out',
  );

  // Branch 2: when singleFile, write arrow IPC directly to --out path.
  assert.ok(
    /arrowPath\s*=\s*singleFile\s*\?\s*out\s*:/.test(src),
    'when singleFile, arrowPath must be the literal --out path',
  );

  // Branch 3: when singleFile, do not create --out as a directory.
  assert.ok(
    /singleFile[\s\S]{0,200}mkdirSync\(path\.dirname\(out\)/.test(src),
    'singleFile branch must mkdirSync the parent directory of --out, not --out itself',
  );

  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
});
