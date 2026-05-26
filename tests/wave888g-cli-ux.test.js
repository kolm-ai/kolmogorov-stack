// Wave W888-G — shared CLI UX helpers (cli/kolm-ux.js) tests.
//
// Locks in:
//   1. color() respects NO_COLOR + --no-color + non-TTY (strips ANSI).
//   2. supportsColor / supportsUnicode return false in the test environment
//      (non-TTY) so tests get deterministic plain output.
//   3. spinner() stops cleanly with 'ok' / 'fail' / 'warn' and reports ms.
//   4. progress() reaches 100% via update() calls; finish() returns the summary.
//   5. errorWithNextStep() emits "Run:" / "See:" / "Fix:" footer to stderr
//      and returns an Error the caller can throw with the right exitCode.
//   6. tableJsonOr() with json:true prints JSON; else prints a header + rows.
//   7. stripAnsi() removes color codes for plain-text assertions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Writable } from 'node:stream';

const REPO = path.resolve(import.meta.dirname, '..');
const UX_URL = 'file://' + path.join(REPO, 'cli', 'kolm-ux.js').replace(/\\/g, '/');

// Tiny in-memory writable so we can capture what the helpers write to
// "stderr" / "stdout" without touching the real streams. The `.isTTY`
// boolean is settable per-test so we can exercise both branches.
function memStream({ isTTY = false } = {}) {
  const chunks = [];
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  w.isTTY = isTTY;
  Object.defineProperty(w, 'text', { get() { return Buffer.concat(chunks).toString('utf8'); } });
  return w;
}

// -----------------------------------------------------------------------------
// color() / supportsColor / stripAnsi
// -----------------------------------------------------------------------------

test('W888-G #1 — supportsColor returns false when NO_COLOR is set', async () => {
  const ux = await import(UX_URL + '?w888g1=' + Date.now());
  const savedNo = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const fakeTty = { isTTY: true };
    assert.equal(ux.supportsColor(fakeTty), false, 'NO_COLOR=1 must disable color even on a TTY');
  } finally {
    if (savedNo === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = savedNo;
  }
});

test('W888-G #2 — color() returns plain text when stream is not a TTY (CI/pipe safe)', async () => {
  const ux = await import(UX_URL + '?w888g2=' + Date.now());
  const nonTty = memStream({ isTTY: false });
  const wrapped = ux.color('hello', 'red', { stream: nonTty });
  assert.equal(wrapped, 'hello', 'non-TTY must skip ANSI wrapping');
});

test('W888-G #3 — stripAnsi removes any ANSI sequences', async () => {
  const ux = await import(UX_URL + '?w888g3=' + Date.now());
  const ansi = '\x1b[31m\x1b[1mhi\x1b[0m there';
  assert.equal(ux.stripAnsi(ansi), 'hi there');
  // Empty / null inputs do not throw.
  assert.equal(ux.stripAnsi(null), '');
  assert.equal(ux.stripAnsi(''), '');
});

// -----------------------------------------------------------------------------
// spinner()
// -----------------------------------------------------------------------------

test('W888-G #4 — spinner.stop("ok") writes a success line with ms suffix', async () => {
  const ux = await import(UX_URL + '?w888g4=' + Date.now());
  const stderr = memStream({ isTTY: false }); // non-TTY -> no animation, only stop line
  const sp = ux.spinner('loading', { stream: stderr });
  const result = sp.stop('ok');
  assert.equal(result.result, 'ok');
  assert.ok(typeof result.ms === 'number' && result.ms >= 0, 'ms must be a non-negative number');
  // Output should mention the label and an ms duration.
  assert.match(stderr.text, /loading/, 'output must include the label');
  assert.match(stderr.text, /\d+ms/, 'output must include an ms duration');
});

test('W888-G #5 — spinner.stop("fail") writes a failure marker', async () => {
  const ux = await import(UX_URL + '?w888g5=' + Date.now());
  const stderr = memStream({ isTTY: false });
  const sp = ux.spinner('upload', { stream: stderr });
  sp.stop('fail');
  const plain = ux.stripAnsi(stderr.text);
  // Either unicode glyph "✗" or ASCII fallback "[fail]".
  assert.ok(/✗|\[fail\]/.test(plain), 'fail stop must include ✗ or [fail] glyph');
});

test('W888-G #6 — spinner.stop is idempotent — calling twice does not double-print', async () => {
  const ux = await import(UX_URL + '?w888g6=' + Date.now());
  const stderr = memStream({ isTTY: false });
  const sp = ux.spinner('idem', { stream: stderr });
  sp.stop('ok');
  const after1 = stderr.text;
  sp.stop('ok');
  assert.equal(stderr.text, after1, 'second stop() must be a no-op');
});

// -----------------------------------------------------------------------------
// progress()
// -----------------------------------------------------------------------------

test('W888-G #7 — progress reaches 100% after total updates (non-TTY: prints every 10%)', async () => {
  const ux = await import(UX_URL + '?w888g7=' + Date.now());
  const stderr = memStream({ isTTY: false });
  const total = 100;
  const bar = ux.progress({ total, label: 'work', stream: stderr });
  for (let i = 0; i < total; i++) bar.update(1);
  const summary = bar.finish();
  assert.equal(summary.current, total, 'finish() must report current=total');
  assert.equal(summary.total, total);
  // Non-TTY output emits the per-10% lines; final summary should include "100%".
  assert.match(stderr.text, /100%/, 'non-TTY progress must include "100%" at completion');
});

test('W888-G #8 — progress indeterminate mode (no total) still finishes cleanly', async () => {
  const ux = await import(UX_URL + '?w888g8=' + Date.now());
  const stderr = memStream({ isTTY: false });
  const bar = ux.progress({ label: 'streaming', stream: stderr });
  for (let i = 0; i < 5; i++) bar.update(1);
  const r = bar.finish();
  assert.equal(r.current, 5, 'indeterminate finish() must report current count');
  assert.match(stderr.text, /done \(5\)/, 'indeterminate finish must print "done (N)"');
});

// -----------------------------------------------------------------------------
// errorWithNextStep()
// -----------------------------------------------------------------------------

test('W888-G #9 — errorWithNextStep emits the "Run:" footer to stderr and returns an Error', async () => {
  const ux = await import(UX_URL + '?w888g9=' + Date.now());
  const stderr = memStream({ isTTY: false });
  const err = ux.errorWithNextStep('No API key', { run: 'kolm login' }, { stream: stderr });
  assert.ok(err instanceof Error, 'must return an Error');
  assert.equal(err.message, 'No API key');
  assert.equal(err._formatted, true, '_formatted must be set so wrappers do not re-format');
  const plain = ux.stripAnsi(stderr.text);
  assert.match(plain, /No API key/, 'message must be on stderr');
  assert.match(plain, /Run:\s*kolm login/, '"Run: kolm login" footer must appear');
});

test('W888-G #10 — errorWithNextStep supports {see, fix, try} hint shapes', async () => {
  const ux = await import(UX_URL + '?w888g10=' + Date.now());
  const stderr = memStream({ isTTY: false });
  ux.errorWithNextStep('spec.toml not found', {
    see: 'docs/reference/spec-toml.md',
    fix: 'create spec.toml in the project root',
    try: ['kolm new my-skill --from classifier', 'kolm init'],
  }, { stream: stderr });
  const plain = ux.stripAnsi(stderr.text);
  assert.match(plain, /See:\s*docs\/reference\/spec-toml\.md/);
  assert.match(plain, /Fix:\s*create spec\.toml/);
  assert.match(plain, /Try:/);
  assert.match(plain, /kolm new my-skill --from classifier/);
});

test('W888-G #11 — NO_COLOR/non-TTY guarantees stderr output is plain (no ANSI bytes)', async () => {
  const ux = await import(UX_URL + '?w888g11=' + Date.now());
  const stderr = memStream({ isTTY: false });
  ux.errorWithNextStep('test', { run: 'kolm doctor' }, { stream: stderr });
  // The text MUST equal its stripped version when output stream is non-TTY.
  assert.equal(ux.stripAnsi(stderr.text), stderr.text,
    'non-TTY stream must receive plain text with no ANSI escape bytes');
});

// -----------------------------------------------------------------------------
// panel()
// -----------------------------------------------------------------------------

test('W888-G #12 — panel renders a boxed key/value table with the title', async () => {
  const ux = await import(UX_URL + '?w888g12=' + Date.now());
  const stdout = memStream({ isTTY: false });
  ux.panel({
    title: 'whoami',
    rows: [
      { key: 'tenant', value: 'tenant_abc' },
      { key: 'plan', value: 'free' },
    ],
    stream: stdout,
  });
  const plain = ux.stripAnsi(stdout.text);
  assert.match(plain, /whoami/, 'title must render');
  assert.match(plain, /tenant\s+:\s+tenant_abc/, 'key:value rows must render');
  assert.match(plain, /plan\s+:\s+free/);
});

// -----------------------------------------------------------------------------
// tableJsonOr()
// -----------------------------------------------------------------------------

test('W888-G #13 — tableJsonOr({ json: true }) emits parseable JSON', async () => {
  const ux = await import(UX_URL + '?w888g13=' + Date.now());
  const stdout = memStream({ isTTY: false });
  ux.tableJsonOr(
    [{ a: 1, b: 'x' }, { a: 2, b: 'y' }],
    { columns: [{ key: 'a' }, { key: 'b' }], json: true, stream: stdout },
  );
  const parsed = JSON.parse(stdout.text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].a, 1);
  assert.equal(parsed[1].b, 'y');
});

test('W888-G #14 — tableJsonOr({ json: false }) emits header, rule, rows, and row count', async () => {
  const ux = await import(UX_URL + '?w888g14=' + Date.now());
  const stdout = memStream({ isTTY: false });
  ux.tableJsonOr(
    [{ a: 1, b: 'x' }, { a: 2, b: 'y' }],
    {
      columns: [{ key: 'a', header: 'A' }, { key: 'b', header: 'B' }],
      json: false,
      stream: stdout,
    },
  );
  const plain = ux.stripAnsi(stdout.text);
  const lines = plain.trim().split('\n');
  assert.match(lines[0], /A\s+B/, 'header row must contain column names');
  assert.match(plain, /\(2 rows\)/, 'row count summary must appear');
});
