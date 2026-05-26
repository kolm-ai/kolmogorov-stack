// W723 — Streaming compilation tests.
//
// Atomic items pinned (matches the W723 implementation):
//
//   1) python3 apps/runtime/streaming_load.py --help exits 0
//   2) streaming on a tiny synthesized .kolm fixture: events have
//      monotonic shard_index 0..N-1, total_shards matches, layer_names
//      are present
//   3) honest envelope on a non-zip file: non-zero exit, stderr carries
//      not_a_kolm_artifact
//   4) bench: --shards 4 --shard-mb 1 --json -> savings_ms > 0
//   5) SDK kolm/client.py: Client.run(stream=True) returns generator,
//      Client.run(stream=False) returns dict
//   6) lock-in: streaming_load.py defines stream_artifact_layers
//   7) lock-in: client.py run() signature carries the stream kwarg
//   8) anti-brittleness sibling-wave count threshold (no explicit-array)
//
// W604 anti-brittleness: no explicit-array family checks, no assertions
// on sw.js or frontend-version.json (orchestrator owns those).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const STREAMING_LOAD = path.join(REPO_ROOT, 'apps', 'runtime', 'streaming_load.py');
const BENCH = path.join(REPO_ROOT, 'apps', 'runtime', 'streaming_load_bench.py');
const SDK_CLIENT = path.join(REPO_ROOT, 'sdk', 'python', 'kolm', 'client.py');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');

// ---------------------------------------------------------------------------
// Python locator (mirrors the wave722 / wave721 sibling pattern).
// ---------------------------------------------------------------------------

function findPython() {
  const candidates = process.platform === 'win32'
    ? ['python3', 'python', 'py']
    : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 5000 });
      if (!r.error && (r.status === 0 || /python/i.test((r.stdout || '') + (r.stderr || '')))) {
        return c;
      }
    } catch { // deliberate: cleanup
      // continue
    }
  }
  return null;
}

function pythonExe(py) {
  // Resolve the absolute path of the python executable so the test can
  // spawn it directly (bypassing PATH lookup) AND can scope the child's
  // PATH to ONLY python's own directory — which forces the SDK's
  // `_cli_or_none` to return null and exercise the honest-envelope
  // fallback for stream=False.
  const r = spawnSync(py, ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8', timeout: 5000,
  });
  if (r.status !== 0) return null;
  const exe = (r.stdout || '').trim();
  return exe || null;
}

// Each test gets a fresh tmp dir.
function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w723-'));
}

// ---------------------------------------------------------------------------
// Tiny .kolm fixture synthesizer (pure Node, no Python).
// We need a real zip with a manifest.json + a few weights/* entries so
// streaming_load.py walks the central directory without needing Python
// to build the fixture for us.
// ---------------------------------------------------------------------------

function crc32(buf) {
  let c;
  const table = crc32._table || (crc32._table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let cc = n;
      for (let k = 0; k < 8; k += 1) {
        cc = (cc & 1) ? (0xEDB88320 ^ (cc >>> 1)) : (cc >>> 1);
      }
      t[n] = cc >>> 0;
    }
    return t;
  })());
  c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) {
    c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function writeZip(outPath, files) {
  // Minimal ZIP writer (STORED + DEFLATE not needed; we use STORED).
  // Builds local headers + central directory + EOCD per APPNOTE 6.3.4.
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const dataBuf = Buffer.from(f.data);
    const crc = crc32(dataBuf);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header sig
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(0, 8);             // STORED
    local.writeUInt16LE(0, 10);            // mod time
    local.writeUInt16LE(0, 12);            // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBuf.length, 18); // compressed
    local.writeUInt32LE(dataBuf.length, 22); // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra len
    parts.push(local, nameBuf, dataBuf);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4); // version made by
    centralEntry.writeUInt16LE(20, 6); // version needed
    centralEntry.writeUInt16LE(0, 8);  // flags
    centralEntry.writeUInt16LE(0, 10); // STORED
    centralEntry.writeUInt16LE(0, 12); // mod time
    centralEntry.writeUInt16LE(0, 14); // mod date
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(dataBuf.length, 20);
    centralEntry.writeUInt32LE(dataBuf.length, 24);
    centralEntry.writeUInt16LE(nameBuf.length, 28);
    centralEntry.writeUInt16LE(0, 30);
    centralEntry.writeUInt16LE(0, 32);
    centralEntry.writeUInt16LE(0, 34);
    centralEntry.writeUInt16LE(0, 36);
    centralEntry.writeUInt32LE(0, 38);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, nameBuf);

    offset += local.length + nameBuf.length + dataBuf.length;
  }
  const centralStart = offset;
  const centralBufs = Buffer.concat(central);
  parts.push(centralBufs);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBufs.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);
  fs.writeFileSync(outPath, Buffer.concat(parts));
  // Sanity touch — keep zlib import alive so lints don't complain.
  void zlib;
}

function synthesizeKolm(outPath, nShards) {
  const shards = [];
  for (let i = 0; i < nShards; i += 1) {
    shards.push({
      path: `weights/model-${String(i + 1).padStart(5, '0')}-of-${String(nShards).padStart(5, '0')}.safetensors`,
      layers: [`model.layers.${i}.input_layernorm.weight`, `model.layers.${i}.self_attn.q_proj.weight`],
    });
  }
  const manifest = {
    name: 'w723-test-fixture',
    version: 'w723-test-v1',
    weights: { shards },
  };
  const files = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
  ];
  for (const s of shards) {
    files.push({ name: s.path, data: Buffer.from(`shard-bytes-for-${s.path}\n`, 'utf8') });
  }
  writeZip(outPath, files);
}

// ===========================================================================
// 1) python3 streaming_load.py --help exits 0
// ===========================================================================

test('W723 #1 — streaming_load.py --help exits 0', () => {
  // Defensive: confirm the source file exists even when Python is absent,
  // so an accidental delete is still caught on python-less hosts.
  assert.ok(fs.existsSync(STREAMING_LOAD),
    `expected ${STREAMING_LOAD} to exist`);
  const py = findPython();
  if (!py) return;
  const r = spawnSync(py, [STREAMING_LOAD, '--help'], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(r.status, 0,
    `--help should exit 0; got ${r.status}; stderr=${(r.stderr || '').slice(0, 400)}`);
  // Sanity check the help text mentions streaming.
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(/stream|shard/i.test(out),
    'help text should mention streaming or shards');
});

// ===========================================================================
// 2) Stream events have monotonic shard_index 0..N-1
// ===========================================================================

test('W723 #2 — streaming yields monotonic shard_index 0..N-1', () => {
  const py = findPython();
  if (!py) return;
  const tmp = freshDir();
  const fixture = path.join(tmp, 'tiny.kolm');
  synthesizeKolm(fixture, 5);
  const r = spawnSync(py, [STREAMING_LOAD, fixture, '--json'], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(r.status, 0,
    `streaming should exit 0; got ${r.status}; stderr=${(r.stderr || '').slice(0, 400)}`);
  const lines = (r.stdout || '').split('\n').filter(Boolean);
  assert.equal(lines.length, 5, `expected 5 events, got ${lines.length}`);
  for (let i = 0; i < lines.length; i += 1) {
    const ev = JSON.parse(lines[i]);
    assert.equal(ev.event, 'shard_ready');
    assert.equal(ev.shard_index, i, `event ${i}: shard_index should be ${i}; got ${ev.shard_index}`);
    assert.equal(ev.total_shards, 5);
    assert.ok(ev.bytes >= 0, 'bytes must be a non-negative integer');
    assert.ok(Array.isArray(ev.layer_names) && ev.layer_names.length > 0,
      `event ${i}: layer_names must be a non-empty array`);
  }
  // Final event must have bytes_loaded == total_bytes.
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.bytes_loaded, last.total_bytes,
    'final shard event must close the loaded-bytes accounting');
});

// ===========================================================================
// 3) Honest envelope on non-zip file
// ===========================================================================

test('W723 #3 — non-zip file emits not_a_kolm_artifact + exits non-zero', () => {
  const py = findPython();
  if (!py) return;
  const tmp = freshDir();
  const badPath = path.join(tmp, 'definitely-not-a-zip.kolm');
  fs.writeFileSync(badPath, 'this is just some text, not a zip archive\n');
  const r = spawnSync(py, [STREAMING_LOAD, badPath, '--json'], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.notEqual(r.status, 0,
    `non-zip artifact should exit non-zero; got ${r.status}`);
  const combined = (r.stdout || '') + (r.stderr || '');
  assert.ok(combined.includes('not_a_kolm_artifact'),
    `stderr should include not_a_kolm_artifact code; got: ${combined.slice(0, 400)}`);
});

// ===========================================================================
// 4) Bench: savings_ms > 0 for 4 tiny shards
// ===========================================================================

test('W723 #4 — bench shows positive savings_ms for tiny shards', () => {
  assert.ok(fs.existsSync(BENCH), `expected ${BENCH} to exist`);
  const py = findPython();
  if (!py) return;
  const r = spawnSync(py, [BENCH, '--shards', '4', '--shard-mb', '1', '--json'], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(r.status, 0,
    `bench should exit 0; got ${r.status}; stderr=${(r.stderr || '').slice(0, 400)}`);
  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON object on stdout; got: ${stdout.slice(0, 400)}`);
  const out = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(out.ok, true, `bench envelope must be ok:true; got ${JSON.stringify(out)}`);
  assert.equal(out.shards, 4);
  assert.equal(out.shard_mb, 1);
  assert.ok(typeof out.baseline_first_layer_ms === 'number');
  assert.ok(typeof out.streaming_first_layer_ms === 'number');
  assert.ok(out.savings_ms > 0,
    `streaming MUST beat baseline; baseline=${out.baseline_first_layer_ms} streaming=${out.streaming_first_layer_ms} savings=${out.savings_ms}`);
  // Streaming must be strictly smaller than baseline.
  assert.ok(out.streaming_first_layer_ms < out.baseline_first_layer_ms,
    'streaming first-layer must be strictly less than baseline');
});

// ===========================================================================
// 5) SDK client.py: stream=True returns generator, stream=False returns dict
// ===========================================================================

test('W723 #5 — Client.run(stream=True) is a generator; stream=False returns a dict', () => {
  const py = findPython();
  if (!py) return;
  const tmp = freshDir();
  const fixture = path.join(tmp, 'sdk-tiny.kolm');
  synthesizeKolm(fixture, 3);

  // Resolve python's absolute exe path so we spawn it without depending
  // on PATH for lookup. We then narrow the child's PATH to ONLY python's
  // own directory — which makes the SDK's `_cli_or_none` return null
  // and exercises the honest-envelope `cli_not_installed` branch (a
  // dict, per the spec contract).
  const pyExe = pythonExe(py);
  if (!pyExe) {
    // Cannot resolve python's absolute exe — skip without failing.
    return;
  }
  const pyDir = path.dirname(pyExe);
  const env = {
    ...process.env,
    PATH: pyDir,
    Path: pyDir, // Windows
    KOLM_KEY: 'k_test_w723',
    PYTHONPATH: path.join(REPO_ROOT, 'sdk', 'python'),
  };
  // Forward fixture path via env so we don't have to JSON-escape Windows paths.
  env.W723_FIXTURE = fixture;

  const probe = [
    'import os, sys, json, types',
    'from kolm.client import Client',
    'c = Client(api_key=os.environ.get("KOLM_KEY", "test"))',
    'fixture = os.environ["W723_FIXTURE"]',
    // stream=True path
    'g = c.run(fixture, stream=True)',
    'is_gen = isinstance(g, types.GeneratorType) or (hasattr(g, "__iter__") and hasattr(g, "__next__"))',
    'evs = list(g)',
    // stream=False path
    'r = c.run(fixture, stream=False)',
    'is_dict = isinstance(r, dict)',
    'out = {',
    '  "stream_true_is_iterator": bool(is_gen),',
    '  "stream_true_event_count": len(evs),',
    '  "stream_true_first_shard_index": evs[0].get("shard_index") if evs else None,',
    '  "stream_true_first_event_kind": evs[0].get("event") if evs else None,',
    '  "stream_false_is_dict": bool(is_dict),',
    '  "stream_false_keys": sorted(list(r.keys())) if isinstance(r, dict) else [],',
    '}',
    'sys.stdout.write(json.dumps(out))',
  ].join('\n');

  const r = spawnSync(pyExe, ['-c', probe], { env, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) {
    assert.fail(
      `python smoke failed status=${r.status} err=${r.error ? r.error.message : 'none'} signal=${r.signal || 'none'}; stdout=${(r.stdout || '').slice(0, 800)} stderr=${(r.stderr || '').slice(0, 800)}`,
    );
  }
  const stdout = (r.stdout || '').trim();
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `python probe must emit JSON on stdout; got: ${stdout.slice(0, 400)}`);
  const result = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));

  // stream=True branch
  assert.equal(result.stream_true_is_iterator, true,
    'Client.run(stream=True) must return an iterator/generator');
  assert.equal(result.stream_true_event_count, 3,
    `stream=True should yield one event per shard; got ${result.stream_true_event_count}`);
  assert.equal(result.stream_true_first_shard_index, 0,
    'first streaming event should carry shard_index 0');
  assert.equal(result.stream_true_first_event_kind, 'shard_ready',
    'first streaming event should be a shard_ready event');

  // stream=False branch — when the kolm CLI is not on PATH the SDK
  // returns an honest-envelope dict. This validates the type contract
  // without requiring a full Node CLI install in the test environment.
  assert.equal(result.stream_false_is_dict, true,
    'Client.run(stream=False) must return a dict');
  // The honest envelope MUST carry ok:false + error fields when CLI absent.
  assert.ok(result.stream_false_keys.includes('ok'),
    `stream=False dict should include "ok" key; got keys: ${JSON.stringify(result.stream_false_keys)}`);
  assert.ok(result.stream_false_keys.includes('error'),
    `stream=False dict should include "error" key; got keys: ${JSON.stringify(result.stream_false_keys)}`);
});

// ===========================================================================
// 6) Lock-in: streaming_load.py contains "def stream_artifact_layers"
// ===========================================================================

test('W723 #6 — streaming_load.py defines stream_artifact_layers', () => {
  const src = fs.readFileSync(STREAMING_LOAD, 'utf8');
  assert.ok(src.includes('def stream_artifact_layers'),
    'apps/runtime/streaming_load.py must define stream_artifact_layers (load-bearing lock-in for W723-1)');
});

// ===========================================================================
// 7) Lock-in: client.py run() signature carries the stream kwarg
// ===========================================================================

test('W723 #7 — client.py run() signature carries the stream kwarg', () => {
  const src = fs.readFileSync(SDK_CLIENT, 'utf8');
  // Match: def run(...) signature that includes `stream`. We use a
  // regex (not exact string) so future formatting tweaks (line breaks,
  // type-hint additions) don't false-fail. The regex spans multiple
  // lines via the `s` flag so the signature can be split across lines.
  const sigRe = /def\s+run\s*\(([^)]*\bstream\b[^)]*)\)/s;
  assert.ok(sigRe.test(src),
    'sdk/python/kolm/client.py run() must declare a stream kwarg (load-bearing lock-in for W723-3)');
  // Also verify the kwarg defaults to False (default streaming OFF preserves
  // backward compat with v0.2.0 callers).
  const defRe = /stream\s*:\s*\w+\s*=\s*False|stream\s*=\s*False/;
  assert.ok(defRe.test(src),
    'run() stream kwarg should default to False (preserves v0.2.0 callers)');
});

// ===========================================================================
// 8) Anti-brittleness: sibling-wave count threshold (regex, not array)
// ===========================================================================

test('W723 #8 — sibling W7xx tests exist (regex threshold, no explicit-array)', () => {
  // Use a count threshold pattern: there must be at least 3 wave72x or
  // wave7xx test files on disk. This is the W454+/W720-W722 proven
  // anti-brittleness pattern — never write `^family^ === [...]` checks
  // that break the next time a sibling wave ships.
  const entries = fs.readdirSync(TESTS_DIR);
  const re = /^wave(7\d\d)-/;
  const matches = entries.filter((n) => re.test(n));
  assert.ok(matches.length >= 3,
    `expected at least 3 wave7xx-* tests on disk; found ${matches.length}: ${matches.join(', ')}`);
  // Sanity: at least one of them is W723 itself (this file).
  assert.ok(matches.some((n) => n.startsWith('wave723-')),
    'W723 test file must itself be discoverable under tests/');
});
