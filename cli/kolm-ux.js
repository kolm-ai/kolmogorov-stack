// W888-G — shared CLI UX helpers (color / spinner / progress / panel / next-step
// error formatter / table-or-json renderer). Lives next to cli/kolm.js so verbs
// can `import { color, spinner, errorWithNextStep } from './kolm-ux.js'` without
// hauling in a third-party dep.
//
// Accessibility rules (apply to EVERY helper):
//   - process.env.NO_COLOR / NO_UNICODE      -> strip ANSI / unicode
//   - process.env.TERM === 'dumb'            -> strip ANSI
//   - argv contains --no-color / --no-unicode / --plain -> strip
//   - !process.stdout.isTTY                  -> strip ANSI (CI / pipes / file capture)
// Output (errors + status lines) goes to stderr. Pure-data payloads go to
// stdout so pipelines like `kolm whoami --json | jq` stay clean.

// W921 — readline is needed by the prompt toolkit (emitKeypressEvents for arrow
// decoding + createInterface for the numbered fallback). Imported at module top
// per ESM rules (require() is not available in this `type: module` file).
import readline from 'node:readline';

const COLOR_CODES = {
  reset: '0',
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  brightred: '91',
  brightgreen: '92',
  brightyellow: '93',
  brightcyan: '96',
};

function _argvHas(flag) {
  const argv = process.argv || [];
  return argv.includes(flag);
}

export function supportsColor(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === 'dumb') return false;
  if (_argvHas('--no-color') || _argvHas('--plain')) return false;
  if (stream && stream.isTTY === false) return false;
  // Default true when we can't determine — tests run without a TTY but still
  // want predictable output, so we err on the side of "strip" by checking TTY
  // first. CI explicitly sets NO_COLOR or has !isTTY which both strip above.
  if (!stream || stream.isTTY !== true) return false;
  return true;
}

export function supportsUnicode() {
  if (process.env.LANG === 'C' || process.env.LANG === 'POSIX') return false;
  if (_argvHas('--no-unicode') || _argvHas('--plain')) return false;
  if (process.env.TERM === 'dumb') return false;
  return true;
}

// color(text, name) — wraps text in the named color when stdout supports it.
// Accepts an array of names for layered styles e.g. color('hi', ['bold', 'cyan']).
// Unknown names pass through uncolored — never throw on a typo.
export function color(text, name, opts = {}) {
  const stream = opts.stream || process.stdout;
  if (!supportsColor(stream)) return String(text);
  const names = Array.isArray(name) ? name : [name];
  const codes = names
    .map(n => COLOR_CODES[String(n || '').toLowerCase()])
    .filter(Boolean);
  if (codes.length === 0) return String(text);
  return '\x1b[' + codes.join(';') + 'm' + String(text) + '\x1b[0m';
}

// stripAnsi — public helper for tests + JSON pretty-printers that need to
// measure visible width without ANSI escapes counting.
export function stripAnsi(s) {
  return String(s == null ? '' : s).replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// spinner — animated indicator on a TTY, falls back to a single status line
// otherwise. Returns `{ stop(result, opts) }` where result is one of:
//   'ok' | 'fail' | 'warn' | string-message
// stop() prints "✓ <label> (123ms)" / "✗ <label> ..." / "⚠ <label> ...".
// When no TTY (pipes, CI), the spinner does not animate — only the final
// stop() line is written, so logs stay clean.
// ---------------------------------------------------------------------------
const SPINNER_FRAMES_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAMES_ASCII   = ['|', '/', '-', '\\'];

export function spinner(label, opts = {}) {
  const stream = opts.stream || process.stderr;
  const startedAt = Date.now();
  const useColor = supportsColor(stream);
  const useUnicode = supportsUnicode();
  const isTty = !!(stream && stream.isTTY);
  // W910-F3.8 — KOLM_NO_PROGRESS=1 strips all animation so test suites get
  // deterministic output without burning CPU on the spinner loop.
  const noProgress = !!(process.env.KOLM_NO_PROGRESS);
  const frames = useUnicode ? SPINNER_FRAMES_UNICODE : SPINNER_FRAMES_ASCII;
  let i = 0;
  let timer = null;
  let stopped = false;

  if (isTty && !opts.silent && !noProgress) {
    stream.write('\r' + frames[0] + ' ' + label);
    timer = setInterval(() => {
      i = (i + 1) % frames.length;
      stream.write('\r' + frames[i] + ' ' + label);
    }, 80);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return {
    update(newLabel) { if (newLabel) label = newLabel; },
    stop(result, stopOpts = {}) {
      if (stopped) return;
      stopped = true;
      if (timer) { try { clearInterval(timer); } catch (_) {} } // deliberate: cleanup
      const ms = Date.now() - startedAt;
      let glyph, glyphColor;
      const r = String(result || 'ok').toLowerCase();
      if (r === 'ok' || r === 'true' || r === 'success') {
        glyph = useUnicode ? '✓' : '[ok]';
        glyphColor = 'green';
      } else if (r === 'fail' || r === 'false' || r === 'error') {
        glyph = useUnicode ? '✗' : '[fail]';
        glyphColor = 'red';
      } else if (r === 'warn' || r === 'warning') {
        glyph = useUnicode ? '⚠' : '[warn]';
        glyphColor = 'yellow';
      } else {
        // Custom result message — print as a labeled badge.
        glyph = useUnicode ? '•' : '[*]';
        glyphColor = 'cyan';
        label = label + ' — ' + result;
      }
      const out = (useColor ? color(glyph, glyphColor, { stream }) : glyph)
        + ' ' + label
        + (useColor ? ' ' + color(`(${ms}ms)`, 'dim', { stream }) : ` (${ms}ms)`);
      if (isTty) stream.write('\r\x1b[K' + out + '\n');
      else stream.write(out + '\n');
      if (stopOpts.note) {
        const note = useColor ? color('  ' + stopOpts.note, 'dim', { stream }) : '  ' + stopOpts.note;
        stream.write(note + '\n');
      }
      return { ms, result: r };
    },
  };
}

// ---------------------------------------------------------------------------
// progress — ANSI progress bar with throughput + ETA. Falls back to periodic
// integer % print on non-TTY. Caller drives it: update(n) bumps current,
// finish() locks in 100% + prints summary line.
// ---------------------------------------------------------------------------
export function progress({ total, label = '', stream = process.stderr } = {}) {
  if (!Number.isFinite(total) || total <= 0) {
    // Indeterminate mode — count-only output, no bar.
    let current = 0;
    return {
      update(n = 1) {
        current += n;
        if (stream && stream.isTTY) stream.write('\r' + (label ? label + ' ' : '') + current);
      },
      finish() {
        if (stream && stream.isTTY) stream.write('\r\x1b[K');
        stream.write((label ? label + ': ' : '') + 'done (' + current + ')\n');
        return { current };
      },
    };
  }

  const useColor = supportsColor(stream);
  const useUnicode = supportsUnicode();
  const isTty = !!(stream && stream.isTTY);
  const startedAt = Date.now();
  let current = 0;
  let lastPct = -1;

  const barWidth = 30;
  const filledCh = useUnicode ? '█' : '#';
  const emptyCh = useUnicode ? '░' : '-';

  function render() {
    const pct = Math.min(100, Math.floor((current / total) * 100));
    const elapsed = (Date.now() - startedAt) / 1000;
    const tput = elapsed > 0 ? (current / elapsed) : 0;
    const remaining = tput > 0 ? Math.max(0, Math.round((total - current) / tput)) : 0;
    const filled = Math.round((current / total) * barWidth);
    const bar = filledCh.repeat(filled) + emptyCh.repeat(Math.max(0, barWidth - filled));
    const pieces = [
      label ? label : '',
      useColor ? color('[' + bar + ']', 'cyan', { stream }) : '[' + bar + ']',
      String(pct).padStart(3) + '%',
      `${current}/${total}`,
      tput > 0 ? `${tput.toFixed(1)}/s` : '',
      remaining > 0 ? `eta ${remaining}s` : '',
    ].filter(Boolean).join(' ');
    if (isTty) {
      stream.write('\r\x1b[K' + pieces);
    } else if (pct !== lastPct && pct % 10 === 0) {
      // On non-TTY, print every 10% so logs show progress without spam.
      stream.write(pieces + '\n');
      lastPct = pct;
    }
  }

  return {
    update(n = 1) {
      current = Math.min(total, current + n);
      render();
    },
    set(n) {
      current = Math.max(0, Math.min(total, n));
      render();
    },
    finish() {
      current = total;
      render();
      if (isTty) stream.write('\n');
      const elapsed = (Date.now() - startedAt) / 1000;
      return { current, total, ms: Date.now() - startedAt, throughput: elapsed > 0 ? current / elapsed : 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// panel — boxed key/value display. Rows accept { key, value, dim?, secret? }.
// Layout auto-widths the keys + values. Unicode box-drawing falls back to
// `+--+ | |` ASCII when --no-unicode / NO_UNICODE.
// ---------------------------------------------------------------------------
export function panel({ title = '', rows = [], stream = process.stdout } = {}) {
  const useColor = supportsColor(stream);
  const useUnicode = supportsUnicode();
  const TL = useUnicode ? '┌' : '+';
  const TR = useUnicode ? '┐' : '+';
  const BL = useUnicode ? '└' : '+';
  const BR = useUnicode ? '┘' : '+';
  const H  = useUnicode ? '─' : '-';
  const V  = useUnicode ? '│' : '|';

  const lines = [];
  const keyWidth = Math.max(0, ...rows.map(r => stripAnsi(r.key || '').length));
  const valueLines = rows.map(r => {
    const raw = r.value == null ? '' : String(r.value);
    return useColor && r.dim ? color(raw, 'dim', { stream }) : raw;
  });
  const valWidth = Math.max(0, ...valueLines.map(v => stripAnsi(v).length));
  const titleStr = title ? ' ' + title + ' ' : '';
  const innerWidth = Math.max(titleStr.length + 2, keyWidth + valWidth + 5);

  lines.push(TL + (title ? titleStr + H.repeat(Math.max(0, innerWidth - titleStr.length)) : H.repeat(innerWidth)) + TR);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const keyStr = (r.key || '').padEnd(keyWidth);
    const valStr = valueLines[i];
    const padding = innerWidth - keyWidth - stripAnsi(valStr).length - 3;
    const keyColored = useColor ? color(keyStr, 'cyan', { stream }) : keyStr;
    lines.push(V + ' ' + keyColored + ' : ' + valStr + ' '.repeat(Math.max(0, padding)) + V);
  }
  lines.push(BL + H.repeat(innerWidth) + BR);
  for (const line of lines) stream.write(line + '\n');
}

// ---------------------------------------------------------------------------
// errorWithNextStep — print an error message with a follow-up actionable
// hint. The hint is one of:
//   { run: 'kolm login' }            -> appends "→ Run: kolm login"
//   { see: 'docs/reference/x.md' }   -> appends "→ See: docs/reference/x.md"
//   { fix: 'short description' }     -> appends "→ Fix: short description"
// Always writes to stderr. Returns an Error object the caller can throw,
// so the existing withErrorContext wrapper picks up the exitCode.
// ---------------------------------------------------------------------------
export function errorWithNextStep(message, hint = {}, opts = {}) {
  const stream = opts.stream || process.stderr;
  const useColor = supportsColor(stream);
  const useUnicode = supportsUnicode();
  const arrow = useUnicode ? '→' : '->';
  const xmark = useUnicode ? '✗' : '[error]';
  const headPrefix = useColor ? color(xmark, 'red', { stream }) : xmark;
  stream.write(headPrefix + ' ' + message + '\n');

  if (hint && typeof hint === 'object') {
    if (hint.run) {
      const label = useColor ? color('Run:', 'cyan', { stream }) : 'Run:';
      const cmd = useColor ? color(hint.run, 'bold', { stream }) : hint.run;
      stream.write('  ' + arrow + ' ' + label + ' ' + cmd + '\n');
    }
    if (hint.see) {
      const label = useColor ? color('See:', 'cyan', { stream }) : 'See:';
      stream.write('  ' + arrow + ' ' + label + ' ' + hint.see + '\n');
    }
    if (hint.fix) {
      const label = useColor ? color('Fix:', 'cyan', { stream }) : 'Fix:';
      stream.write('  ' + arrow + ' ' + label + ' ' + hint.fix + '\n');
    }
    if (Array.isArray(hint.try)) {
      const label = useColor ? color('Try:', 'cyan', { stream }) : 'Try:';
      stream.write('  ' + arrow + ' ' + label + '\n');
      for (const t of hint.try) {
        const bullet = useUnicode ? '  •' : '  -';
        const cmd = useColor ? color(t, 'bold', { stream }) : t;
        stream.write(bullet + ' ' + cmd + '\n');
      }
    }
  }

  const err = new Error(message);
  if (opts.exitCode != null) err.exitCode = opts.exitCode;
  if (opts.code != null) err.code = opts.code;
  err._nextStep = hint;
  err._formatted = true;
  return err;
}

// ---------------------------------------------------------------------------
// tableJsonOr — emits either JSON (--json flag) or a pretty ASCII table.
// `columns` is an array of { key, header, align?, width?, format? }.
// `rows` is an array of plain objects keyed by column.key.
// Falls back to JSON if columns is empty.
// ---------------------------------------------------------------------------
export function tableJsonOr(rows, { columns = [], json = false, stream = process.stdout } = {}) {
  if (json || columns.length === 0) {
    stream.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }
  const useColor = supportsColor(stream);
  const widths = columns.map(c => {
    const headerLen = (c.header || c.key).length;
    const valLens = rows.map(r => {
      const v = c.format ? c.format(r[c.key], r) : r[c.key];
      return stripAnsi(v == null ? '' : String(v)).length;
    });
    return Math.max(c.width || 0, headerLen, ...valLens);
  });
  const header = columns.map((c, i) => {
    const text = (c.header || c.key).padEnd(widths[i]);
    return useColor ? color(text, ['bold', 'cyan'], { stream }) : text;
  }).join('  ');
  stream.write(header + '\n');
  const rule = columns.map((_, i) => '-'.repeat(widths[i])).join('  ');
  stream.write((useColor ? color(rule, 'dim', { stream }) : rule) + '\n');
  for (const r of rows) {
    const line = columns.map((c, i) => {
      let v = c.format ? c.format(r[c.key], r) : r[c.key];
      v = v == null ? '' : String(v);
      const visibleLen = stripAnsi(v).length;
      const pad = ' '.repeat(Math.max(0, widths[i] - visibleLen));
      return c.align === 'right' ? pad + v : v + pad;
    }).join('  ');
    stream.write(line + '\n');
  }
  stream.write(`(${rows.length} row${rows.length === 1 ? '' : 's'})\n`);
}

// ===========================================================================
// W921 — cursor-driven interactive prompt toolkit (select / multiselect /
// confirm / text / password / autocomplete / selectKey). Dependency-free,
// modeled on @clack/prompts' API + @clack/core's state-machine + charm-huh's
// ACCESSIBLE-mode fallback, using native readline.emitKeypressEvents for arrow
// decoding. Every primitive:
//   (a) gates on isInteractiveCapable() and falls back to a numbered-readline
//       path when not (non-TTY / --plain / ACCESSIBLE / TERM=dumb /
//       KOLM_NO_INTERACTIVE), preserving CI + screen-reader + pipe behavior;
//   (b) returns the CANCEL symbol on ctrl-c / ESC instead of throwing;
//   (c) ALWAYS restores the terminal in a finally block (raw off, cursor on);
//   (d) reuses supportsColor()/supportsUnicode().
//
// The headline security win: password() never echoes the secret to scrollback,
// so `kolm login` stops leaking the ks_... key in cleartext.
// ===========================================================================

export const CANCEL = Symbol('kolm.prompt.cancel');
export function isCancel(value) { return value === CANCEL; }

// isInteractiveCapable — the single gate that decides arrow-nav vs the numbered
// readline fallback. Mirrors the charm-huh ACCESSIBLE contract: a non-TTY,
// --plain, ACCESSIBLE=1, TERM=dumb, or KOLM_NO_INTERACTIVE=1 all force the
// deterministic dictation-friendly path. Exposed for tests + callers.
export function isInteractiveCapable({ stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin || !stdout) return false;
  if (stdin.isTTY !== true || stdout.isTTY !== true) return false;
  if (_argvHas('--plain')) return false;
  if (process.env.ACCESSIBLE) return false;
  if (process.env.TERM === 'dumb') return false;
  if (process.env.KOLM_NO_INTERACTIVE) return false;
  if (typeof stdin.setRawMode !== 'function') return false;
  return true;
}

// decodeKey — normalize the {sequence,name,ctrl,meta,shift} object that
// readline.emitKeypressEvents emits into a stable shape, with j/k/h/l vim
// aliases folded onto arrow names so callers branch on one vocabulary.
function decodeKey(str, key) {
  const k = key || {};
  let name = k.name || '';
  // ctrl-c / ESC are universal cancel.
  if (k.ctrl && (name === 'c')) return { name: 'cancel', ctrl: true, raw: str };
  if (name === 'escape') return { name: 'cancel', raw: str };
  // vim navigation aliases (only when not typing into a text field — callers
  // decide; for list nav we accept them).
  return {
    name,
    ctrl: !!k.ctrl,
    meta: !!k.meta,
    shift: !!k.shift,
    sequence: k.sequence,
    raw: str,
  };
}

// _withRawKeypresses — set up emitKeypressEvents + raw mode, run a handler that
// resolves via a callback, ALWAYS restore the terminal in finally. The handler
// receives (onKey, done) where done(value) ends the prompt.
function _rawSession(stdin, stdout, onKey) {
  return new Promise((resolve) => {
    let settled = false;
    const keyListener = (str, key) => {
      if (settled) return;
      const dk = decodeKey(str, key);
      onKey(dk, (value) => {
        if (settled) return;
        settled = true;
        teardown();
        resolve(value);
      });
    };
    function teardown() {
      try { stdin.removeListener('keypress', keyListener); } catch (_) {}
      try { if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false); } catch (_) {}
      try { stdin.pause(); } catch (_) {}
      try { stdout.write('\x1b[?25h'); } catch (_) {} // show cursor
    }
    try {
      readline.emitKeypressEvents(stdin);
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
      stdin.resume();
      stdout.write('\x1b[?25l'); // hide cursor during nav
      stdin.on('keypress', keyListener);
    } catch (_) {
      // Raw mode unavailable mid-flight — restore and bail to CANCEL so the
      // caller can fall back. Never leave the terminal in raw mode.
      teardown();
      resolve(CANCEL);
    }
  });
}

// renderList — shared in-place frame renderer with viewport windowing. Pure:
// (state, ctx) -> string[] of frame lines. Caller owns the repaint mechanics.
export function renderList(state, ctx) {
  const { items, cursor, selected, query, error } = state;
  const { message, useColor, useUnicode, maxItems = 10, multi = false } = ctx;
  const lines = [];
  const caret = useUnicode ? '❯' : '>';
  const checkOn = useUnicode ? '◉' : '[x]';
  const checkOff = useUnicode ? '◯' : '[ ]';
  const head = message + (query != null ? '  ' + (useColor ? color(query || '…', 'dim') : (query || '')) : '');
  lines.push((useColor ? color('?', 'cyan') : '?') + ' ' + head);
  const total = items.length;
  // Viewport windowing: keep the cursor roughly centered.
  let start = 0;
  if (total > maxItems) {
    start = Math.min(Math.max(0, cursor - Math.floor(maxItems / 2)), total - maxItems);
  }
  const end = Math.min(total, start + maxItems);
  if (start > 0) lines.push('  ' + (useColor ? color('↑ more', 'dim') : '... more'));
  for (let i = start; i < end; i++) {
    const it = items[i];
    const isCur = i === cursor;
    const box = multi ? ((selected && selected.has(it.value) ? checkOn : checkOff) + ' ') : '';
    let label = box + (it.label != null ? it.label : String(it.value));
    if (it.hint) label += '  ' + (useColor ? color('(' + it.hint + ')', 'dim') : '(' + it.hint + ')');
    if (isCur) {
      lines.push('  ' + (useColor ? color(caret + ' ' + label, 'cyan') : caret + ' ' + label));
    } else {
      lines.push('    ' + (it.disabled && useColor ? color(label, 'dim') : label));
    }
  }
  if (end < total) lines.push('  ' + (useColor ? color('↓ more', 'dim') : '... more'));
  if (error) lines.push('  ' + (useColor ? color('✗ ' + error, 'red') : 'error: ' + error));
  return lines;
}

// _repaint — erase the previous frame's N lines and write the new frame in
// place. Tracks line count between calls via the returned closure.
function _makeRepainter(stdout) {
  let prevLines = 0;
  return {
    paint(lines) {
      if (prevLines > 0) {
        // Move cursor up to the start of the previous frame, clearing each.
        stdout.write('\x1b[' + prevLines + 'A');
      }
      const out = lines.map(l => '\x1b[2K' + l).join('\n') + '\n';
      stdout.write(out);
      prevLines = lines.length;
    },
    clear() {
      if (prevLines > 0) stdout.write('\x1b[' + prevLines + 'A');
      prevLines = 0;
    },
  };
}

// _numberedFallback — the deterministic, screen-reader-friendly path. Reuses
// node:readline question(). Identical contract to the historic pickMenu/ask
// behavior so CI + pipes + --plain stay byte-stable. Returns value | CANCEL.
async function _numberedFallback(kind, spec) {
  const stdin = spec.stdin || process.stdin;
  const stdout = spec.stdout || process.stdout;
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  try {
    if (kind === 'confirm') {
      const def = spec.initialValue !== false;
      const ans = (await ask(spec.message + ' [' + (def ? 'Y/n' : 'y/N') + '] ')).trim().toLowerCase();
      if (ans === '') return def;
      if (/^(y|yes)$/.test(ans)) return true;
      if (/^(n|no)$/.test(ans)) return false;
      return def;
    }
    if (kind === 'text') {
      const hint = spec.placeholder ? ' (' + spec.placeholder + ')' : '';
      while (true) {
        let ans = (await ask(spec.message + hint + ': '));
        if (ans == null) return CANCEL;
        ans = ans.replace(/\r?\n$/, '');
        if (ans === '' && spec.defaultValue != null) ans = spec.defaultValue;
        if (typeof spec.validate === 'function') {
          const err = spec.validate(ans);
          if (err) { stdout.write('  ' + err + '\n'); continue; }
        }
        return ans;
      }
    }
    if (kind === 'password') {
      // No masking possible without raw mode; the fallback still avoids echoing
      // beyond what the terminal does for a piped/non-TTY stream. We DO NOT
      // print the typed value back.
      while (true) {
        const ans = (await ask(spec.message + ': '));
        if (ans == null) return CANCEL;
        const v = ans.replace(/\r?\n$/, '');
        if (typeof spec.validate === 'function') {
          const err = spec.validate(v);
          if (err) { stdout.write('  ' + err + '\n'); continue; }
        }
        return v;
      }
    }
    // select / multiselect / autocomplete / selectKey — numbered list.
    const opts = spec.options || [];
    for (let i = 0; i < opts.length; i++) {
      const o = opts[i];
      stdout.write('  ' + (i + 1) + ') ' + (o.label != null ? o.label : String(o.value)) +
        (o.hint ? '  (' + o.hint + ')' : '') + '\n');
    }
    if (kind === 'multiselect') {
      const ans = (await ask(spec.message + ' (comma-separated numbers, or Enter for none): ')).trim();
      if (ans === '') {
        if (spec.required) { stdout.write('  at least one selection required\n'); }
        return [];
      }
      const picks = ans.split(/[,\s]+/).map(s => Number(s) - 1).filter(n => n >= 0 && n < opts.length);
      return picks.map(n => opts[n].value);
    }
    // single select / autocomplete / selectKey
    const promptMsg = spec.message + ' [1-' + opts.length + ']' +
      (spec.initialValue != null ? ' (Enter=default)' : '') + ': ';
    while (true) {
      const ans = (await ask(promptMsg)).trim();
      if (ans === '' && spec.initialValue != null) return spec.initialValue;
      // Accept a number.
      const n = Number(ans);
      if (Number.isInteger(n) && n >= 1 && n <= opts.length) return opts[n - 1].value;
      // Accept a unique label/value substring (>=2 chars to avoid mis-match).
      if (ans.length >= 2) {
        const matches = opts.filter(o =>
          String(o.value).toLowerCase().includes(ans.toLowerCase()) ||
          String(o.label || '').toLowerCase().includes(ans.toLowerCase()));
        if (matches.length === 1) return matches[0].value;
      }
      // selectKey: single-char hotkey.
      if (kind === 'selectKey') {
        const hot = opts.find(o => String(o.value).toLowerCase() === ans.toLowerCase());
        if (hot) return hot.value;
      }
      stdout.write('  pick a number 1-' + opts.length + (kind === 'selectKey' ? ' or a hotkey' : '') + '\n');
    }
  } finally {
    try { rl.close(); } catch (_) {}
  }
}

function _normOptions(options) {
  return (options || []).map(o => {
    if (o && typeof o === 'object' && 'value' in o) return o;
    return { value: o, label: String(o) };
  });
}

// select — arrow-key single-choice picker. Returns the chosen value | CANCEL.
export async function select(spec = {}) {
  const { message = 'Select', options = [], initialValue, maxItems = 10, hint,
    stdin = process.stdin, stdout = process.stdout } = spec;
  const opts = _normOptions(options);
  if (opts.length === 0) return CANCEL;
  if (!isInteractiveCapable({ stdin, stdout })) {
    return _numberedFallback('select', { message, options: opts, initialValue, hint, stdin, stdout });
  }
  const useColor = supportsColor(stdout);
  const useUnicode = supportsUnicode();
  let cursor = Math.max(0, opts.findIndex(o => o.value === initialValue));
  if (cursor < 0) cursor = 0;
  const repaint = _makeRepainter(stdout);
  const ctx = { message, useColor, useUnicode, maxItems, multi: false };
  const draw = () => repaint.paint(renderList({ items: opts, cursor, selected: null, query: null, error: null }, ctx));
  draw();
  const result = await _rawSession(stdin, stdout, (key, done) => {
    if (key.name === 'cancel') return done(CANCEL);
    if (key.name === 'up' || key.name === 'k') { cursor = (cursor - 1 + opts.length) % opts.length; draw(); return; }
    if (key.name === 'down' || key.name === 'j') { cursor = (cursor + 1) % opts.length; draw(); return; }
    if (key.name === 'return' || key.name === 'enter') {
      if (opts[cursor] && opts[cursor].disabled) return;
      return done(opts[cursor].value);
    }
  });
  repaint.clear();
  return result;
}

// multiselect — space toggles, enter submits. Returns value[] | CANCEL.
export async function multiselect(spec = {}) {
  const { message = 'Select', options = [], initialValues = [], required = false,
    min, max, maxItems = 10, stdin = process.stdin, stdout = process.stdout } = spec;
  const opts = _normOptions(options);
  if (opts.length === 0) return [];
  if (!isInteractiveCapable({ stdin, stdout })) {
    return _numberedFallback('multiselect', { message, options: opts, required, stdin, stdout });
  }
  const useColor = supportsColor(stdout);
  const useUnicode = supportsUnicode();
  let cursor = 0;
  const selected = new Set(initialValues);
  let error = null;
  const repaint = _makeRepainter(stdout);
  const ctx = { message, useColor, useUnicode, maxItems, multi: true };
  const draw = () => repaint.paint(renderList({ items: opts, cursor, selected, query: null, error }, ctx));
  draw();
  const result = await _rawSession(stdin, stdout, (key, done) => {
    if (key.name === 'cancel') return done(CANCEL);
    if (key.name === 'up' || key.name === 'k') { cursor = (cursor - 1 + opts.length) % opts.length; error = null; draw(); return; }
    if (key.name === 'down' || key.name === 'j') { cursor = (cursor + 1) % opts.length; error = null; draw(); return; }
    if (key.name === 'space') {
      const v = opts[cursor].value;
      if (selected.has(v)) selected.delete(v); else selected.add(v);
      error = null; draw(); return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const picks = opts.filter(o => selected.has(o.value)).map(o => o.value);
      if (required && picks.length === 0) { error = 'at least one selection required'; draw(); return; }
      if (typeof min === 'number' && picks.length < min) { error = 'select at least ' + min; draw(); return; }
      if (typeof max === 'number' && picks.length > max) { error = 'select at most ' + max; draw(); return; }
      return done(picks);
    }
  });
  repaint.clear();
  return result;
}

// confirm — y/n with arrow-toggle. Returns boolean | CANCEL.
export async function confirm(spec = {}) {
  const { message = 'Confirm?', initialValue = true, stdin = process.stdin, stdout = process.stdout } = spec;
  if (!isInteractiveCapable({ stdin, stdout })) {
    return _numberedFallback('confirm', { message, initialValue, stdin, stdout });
  }
  const useColor = supportsColor(stdout);
  let value = initialValue !== false;
  const repaint = _makeRepainter(stdout);
  const draw = () => {
    const yes = value ? (useColor ? color('● Yes', 'cyan') : '(*) Yes') : 'Yes';
    const no = !value ? (useColor ? color('● No', 'cyan') : '(*) No') : 'No';
    repaint.paint([(useColor ? color('?', 'cyan') : '?') + ' ' + message + '   ' + yes + ' / ' + no]);
  };
  draw();
  const result = await _rawSession(stdin, stdout, (key, done) => {
    if (key.name === 'cancel') return done(CANCEL);
    if (key.name === 'left' || key.name === 'right' || key.name === 'h' || key.name === 'l' || key.name === 'tab') { value = !value; draw(); return; }
    if (key.name === 'y') return done(true);
    if (key.name === 'n') return done(false);
    if (key.name === 'return' || key.name === 'enter') return done(value);
  });
  repaint.clear();
  return result;
}

// text — single-line editor. Returns string | CANCEL.
export async function text(spec = {}) {
  const { message = '', placeholder, initialValue = '', defaultValue, validate,
    stdin = process.stdin, stdout = process.stdout } = spec;
  if (!isInteractiveCapable({ stdin, stdout })) {
    return _numberedFallback('text', { message, placeholder, initialValue, defaultValue, validate, stdin, stdout });
  }
  const useColor = supportsColor(stdout);
  let buf = String(initialValue || '');
  let error = null;
  const repaint = _makeRepainter(stdout);
  const draw = () => {
    const shown = buf.length ? buf : (placeholder ? (useColor ? color(placeholder, 'dim') : placeholder) : '');
    const lines = [(useColor ? color('?', 'cyan') : '?') + ' ' + message + '  ' + shown];
    if (error) lines.push('  ' + (useColor ? color('✗ ' + error, 'red') : 'error: ' + error));
    repaint.paint(lines);
  };
  draw();
  const result = await _rawSession(stdin, stdout, (key, done) => {
    if (key.name === 'cancel') return done(CANCEL);
    if (key.name === 'return' || key.name === 'enter') {
      let v = buf;
      if (v === '' && defaultValue != null) v = defaultValue;
      if (typeof validate === 'function') { const err = validate(v); if (err) { error = err; draw(); return; } }
      return done(v);
    }
    if (key.name === 'backspace') { buf = buf.slice(0, -1); error = null; draw(); return; }
    if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta && key.raw >= ' ') { buf += key.raw; error = null; draw(); return; }
  });
  repaint.clear();
  return result;
}

// password — masked single-line editor; the real value is NEVER echoed to
// scrollback. Returns string | CANCEL. The headline `kolm login` security win.
export async function password(spec = {}) {
  const { message = 'Password', mask = '•', validate, stdin = process.stdin, stdout = process.stdout } = spec;
  if (!isInteractiveCapable({ stdin, stdout })) {
    return _numberedFallback('password', { message, validate, stdin, stdout });
  }
  const useColor = supportsColor(stdout);
  const useUnicode = supportsUnicode();
  const maskCh = useUnicode ? mask : '*';
  let buf = '';
  let error = null;
  const repaint = _makeRepainter(stdout);
  const draw = () => {
    const lines = [(useColor ? color('?', 'cyan') : '?') + ' ' + message + '  ' + maskCh.repeat(buf.length)];
    if (error) lines.push('  ' + (useColor ? color('✗ ' + error, 'red') : 'error: ' + error));
    repaint.paint(lines);
  };
  draw();
  const result = await _rawSession(stdin, stdout, (key, done) => {
    if (key.name === 'cancel') return done(CANCEL);
    if (key.name === 'return' || key.name === 'enter') {
      if (typeof validate === 'function') { const err = validate(buf); if (err) { error = err; draw(); return; } }
      return done(buf);
    }
    if (key.name === 'backspace') { buf = buf.slice(0, -1); error = null; draw(); return; }
    if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta && key.raw >= ' ') { buf += key.raw; error = null; draw(); return; }
  });
  repaint.clear();
  return result;
}

// _fuzzyRank — subsequence prefilter + levenshtein tiebreak. Pure, exported for
// tests. Returns the matching options in ranked order.
export function _fuzzyRank(options, query, levenshteinFn) {
  const q = String(query || '').toLowerCase();
  if (!q) return options.slice();
  const lev = typeof levenshteinFn === 'function' ? levenshteinFn : null;
  const subseq = (hay, needle) => {
    let i = 0;
    for (const ch of hay) { if (ch === needle[i]) i++; if (i === needle.length) return true; }
    return needle.length === 0;
  };
  const scored = [];
  for (const o of options) {
    const text = String(o.label != null ? o.label : o.value).toLowerCase();
    if (text.includes(q) || subseq(text, q)) {
      const d = lev ? lev(q, text.slice(0, q.length)) : 0;
      const prefixBonus = text.startsWith(q) ? -100 : 0;
      scored.push({ o, score: d + prefixBonus });
    }
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.map(s => s.o);
}

// autocomplete — fuzzy-filter picker. Returns value | CANCEL.
export async function autocomplete(spec = {}) {
  const { message = 'Search', options = [], placeholder, limit = 10,
    levenshtein: levFn, stdin = process.stdin, stdout = process.stdout } = spec;
  const opts = _normOptions(options);
  if (opts.length === 0) return CANCEL;
  if (!isInteractiveCapable({ stdin, stdout })) {
    return _numberedFallback('autocomplete', { message, options: opts, placeholder, stdin, stdout });
  }
  const useColor = supportsColor(stdout);
  const useUnicode = supportsUnicode();
  let query = '';
  let cursor = 0;
  let filtered = opts.slice();
  const repaint = _makeRepainter(stdout);
  const ctx = { message, useColor, useUnicode, maxItems: limit, multi: false };
  const draw = () => repaint.paint(renderList({ items: filtered, cursor, selected: null, query: query || (placeholder || ''), error: null }, ctx));
  draw();
  const result = await _rawSession(stdin, stdout, (key, done) => {
    if (key.name === 'cancel') return done(CANCEL);
    if (key.name === 'up') { cursor = (cursor - 1 + Math.max(1, filtered.length)) % Math.max(1, filtered.length); draw(); return; }
    if (key.name === 'down') { cursor = (cursor + 1) % Math.max(1, filtered.length); draw(); return; }
    if (key.name === 'return' || key.name === 'enter') {
      if (filtered[cursor]) return done(filtered[cursor].value);
      return;
    }
    if (key.name === 'backspace') { query = query.slice(0, -1); filtered = _fuzzyRank(opts, query, levFn); cursor = 0; draw(); return; }
    if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta && key.raw >= ' ') {
      query += key.raw; filtered = _fuzzyRank(opts, query, levFn); cursor = 0; draw(); return;
    }
  });
  repaint.clear();
  return result;
}

// selectKey — single-char hotkey picker. options:[{value(single-char),label}].
// Returns value | CANCEL.
export async function selectKey(spec = {}) {
  const { message = 'Press a key', options = [], stdin = process.stdin, stdout = process.stdout } = spec;
  const opts = _normOptions(options);
  if (opts.length === 0) return CANCEL;
  if (!isInteractiveCapable({ stdin, stdout })) {
    return _numberedFallback('selectKey', { message, options: opts, stdin, stdout });
  }
  const useColor = supportsColor(stdout);
  const repaint = _makeRepainter(stdout);
  const lines = [(useColor ? color('?', 'cyan') : '?') + ' ' + message];
  for (const o of opts) lines.push('    ' + (useColor ? color(String(o.value), 'cyan') : String(o.value)) + ' — ' + (o.label != null ? o.label : ''));
  repaint.paint(lines);
  const result = await _rawSession(stdin, stdout, (key, done) => {
    if (key.name === 'cancel') return done(CANCEL);
    const hit = opts.find(o => String(o.value).toLowerCase() === String(key.raw || key.name || '').toLowerCase());
    if (hit) return done(hit.value);
  });
  repaint.clear();
  return result;
}

// ===========================================================================
// W921 — nested / concurrent multi-task renderer (listr2 / Charm-style task
// tree). A parent step with live child substeps, each with its own
// spinner+status, rolled up to one stable in-place terminal frame. Zero deps,
// accessibility-gated. The renderer is decoupled from the executor; non-TTY /
// KOLM_NO_PROGRESS / --plain degrade to append-only transition lines (zero
// cursor-move/erase escapes), and --json emits NDJSON one object per
// transition with no human frame — so log-scraping + JSON consumers never
// regress.
// ===========================================================================

// displayWidth — ANSI-stripped visible width (wide-glyph naive: counts code
// points). Reuses stripAnsi.
export function displayWidth(s) {
  return stripAnsi(s == null ? '' : String(s)).length;
}

// visibleLineCount — sum of WRAPPED rows, not '\n' count. This is the #1
// documented log-update footgun: erasing the newline count instead of the
// wrapped-row count corrupts the frame when a line is wider than the terminal.
export function visibleLineCount(lines, columns) {
  const cols = (Number.isFinite(columns) && columns > 0) ? columns : 80;
  let n = 0;
  for (const l of (lines || [])) {
    const w = displayWidth(l);
    n += Math.max(1, Math.ceil(w / cols));
  }
  return n;
}

const TASK_STATE = { PENDING: 'pending', RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', SKIPPED: 'skipped' };

// _renderTree — pure: task node array -> array of width-correct, truncated
// display lines. Each node: { title, state, depth, output, error, startedAt,
// endedAt }.
function _renderTree(nodes, o) {
  const { useUnicode, useColor, spinnerFrame, columns = 80, collapse = false } = o;
  const glyphs = useUnicode
    ? { running: spinnerFrame, completed: '✓', failed: '✗', skipped: '◌', pending: '·' }
    : { running: '*', completed: '[ok]', failed: '[x]', skipped: '[-]', pending: '.' };
  const colorOf = { completed: 'green', failed: 'red', skipped: 'dim', running: 'cyan', pending: 'dim' };
  const lines = [];
  for (const n of nodes) {
    if (collapse && n.state === TASK_STATE.COMPLETED && n.depth > 0) continue;
    const indent = '  '.repeat((n.depth || 0) + 1);
    const g = glyphs[n.state] || glyphs.pending;
    const gc = useColor ? color(g, colorOf[n.state] || 'dim') : g;
    let timer = '';
    if (n.startedAt && n.endedAt) timer = ' (' + (n.endedAt - n.startedAt) + 'ms)';
    let line = indent + gc + ' ' + (n.title || '');
    if (n.output) line += '  ' + (useColor ? color(String(n.output), 'dim') : String(n.output));
    if (n.state === TASK_STATE.FAILED && n.error) line += '  ' + (useColor ? color('— ' + n.error, 'red') : '-- ' + n.error);
    line += useColor ? color(timer, 'dim') : timer;
    // Hard-truncate to columns-1 so a node NEVER wraps and breaks the frame
    // line count (cli-truncate semantics).
    if (displayWidth(line) > columns - 1) {
      // Truncate by visible width while preserving the leading escape codes is
      // tricky; for safety we strip ANSI then truncate then leave uncolored.
      const plain = stripAnsi(line);
      line = plain.slice(0, columns - 2) + (useUnicode ? '…' : '~');
    }
    lines.push(line);
  }
  return lines;
}

// _FrameBuffer — in-place multi-line frame engine. render(lines) computes the
// wrapped line count, moves the cursor up + erases the prior frame, then writes
// the new frame. On non-TTY it is a no-op (the executor uses append-only).
function _FrameBuffer({ stream = process.stderr } = {}) {
  let prevLines = 0;
  const isTty = !!(stream && stream.isTTY);
  return {
    render(lines) {
      if (!isTty) return; // append-only path handles non-TTY
      const cols = stream.columns || 80;
      if (prevLines > 0) stream.write('\x1b[' + prevLines + 'A');
      const body = lines.map(l => '\x1b[2K' + l).join('\n') + '\n';
      stream.write(body);
      prevLines = visibleLineCount(lines, cols);
    },
    clear() {
      if (!isTty) { prevLines = 0; return; }
      if (prevLines > 0) stream.write('\x1b[' + prevLines + 'A\x1b[0J');
      prevLines = 0;
    },
    done() { prevLines = 0; },
  };
}

// _concurrencyPool — bounded async pool driving leaf execution + emitting
// transitions. Returns the per-task results (or {error}).
async function _concurrencyPool(tasks, limit, onTransition) {
  const lim = (limit === true || !Number.isFinite(limit)) ? tasks.length : Math.max(1, limit);
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      if (onTransition) onTransition(i, TASK_STATE.RUNNING);
      try {
        results[i] = await tasks[i]();
        if (onTransition) onTransition(i, TASK_STATE.COMPLETED, results[i]);
      } catch (e) {
        results[i] = { error: String(e && e.message || e) };
        if (onTransition) onTransition(i, TASK_STATE.FAILED, results[i]);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(lim, tasks.length) }, worker));
  return results;
}

// taskTree — execute + live-render a (one-level for now) task list. Each task:
// { title, task: async (ctx)=>void, skip?:()=>bool|string }. opts.concurrent
// (bool|number), opts.exitOnError, opts.collapse, opts.stream, opts.json,
// opts.tickMs. Returns { ok, results, durationMs, failed[] }.
export async function taskTree(rootTasks, opts = {}) {
  const stream = opts.stream || process.stderr;
  const json = !!opts.json;
  const noProgress = !!process.env.KOLM_NO_PROGRESS;
  const isTty = !!(stream && stream.isTTY) && !noProgress && !json;
  const useColor = supportsColor(stream);
  const useUnicode = supportsUnicode();
  const frames = useUnicode ? SPINNER_FRAMES_UNICODE : SPINNER_FRAMES_ASCII;
  const startedAll = Date.now();
  const tasks = (rootTasks || []).map((t, i) => ({
    title: t.title || ('task ' + (i + 1)), spec: t, depth: 0,
    state: TASK_STATE.PENDING, output: null, error: null, startedAt: null, endedAt: null,
  }));
  const failed = [];
  const results = new Array(tasks.length);
  const fb = _FrameBuffer({ stream });
  let spinIdx = 0;
  let timer = null;

  const emitNdjson = (obj) => { if (json) stream.write(JSON.stringify(obj) + '\n'); };
  const emitAppend = (node, kind) => {
    // Non-TTY / KOLM_NO_PROGRESS append-only: one immutable line per transition.
    if (isTty || json) return;
    if (kind === 'start') stream.write('start: ' + node.title + '\n');
    else if (kind === 'done') stream.write('done: ' + node.title + ' (' + (node.endedAt - node.startedAt) + 'ms)\n');
    else if (kind === 'fail') stream.write('fail: ' + node.title + ' — ' + node.error + '\n');
    else if (kind === 'skip') stream.write('skip: ' + node.title + '\n');
  };
  const repaint = () => {
    if (!isTty) return;
    const frame = _renderTree(tasks, {
      useUnicode, useColor, spinnerFrame: frames[spinIdx % frames.length],
      columns: stream.columns || 80, collapse: !!opts.collapse,
    });
    fb.render(frame);
  };

  if (isTty) {
    timer = setInterval(() => { spinIdx++; repaint(); }, opts.tickMs || 80);
    if (timer && typeof timer.unref === 'function') timer.unref();
    repaint();
  }

  const concurrent = opts.concurrent;
  const runOne = async (node) => {
    if (typeof node.spec.skip === 'function') {
      const sk = node.spec.skip();
      if (sk) { node.state = TASK_STATE.SKIPPED; node.output = typeof sk === 'string' ? sk : null; emitNdjson({ task: node.title, state: 'skipped' }); emitAppend(node, 'skip'); repaint(); return; }
    }
    node.state = TASK_STATE.RUNNING; node.startedAt = Date.now();
    emitNdjson({ task: node.title, state: 'running' }); emitAppend(node, 'start'); repaint();
    try {
      const ctx = {
        setOutput: (s) => { node.output = s; repaint(); },
        setTitle: (s) => { node.title = s; repaint(); },
      };
      results[tasks.indexOf(node)] = await node.spec.task(ctx, node);
      node.state = TASK_STATE.COMPLETED; node.endedAt = Date.now();
      emitNdjson({ task: node.title, state: 'completed', ms: node.endedAt - node.startedAt }); emitAppend(node, 'done'); repaint();
    } catch (e) {
      node.state = TASK_STATE.FAILED; node.endedAt = Date.now(); node.error = String(e && e.message || e);
      failed.push({ title: node.title, error: node.error });
      emitNdjson({ task: node.title, state: 'failed', error: node.error }); emitAppend(node, 'fail'); repaint();
      if (opts.exitOnError) throw e;
    }
  };

  try {
    if (concurrent && tasks.length > 1) {
      const lim = (concurrent === true) ? tasks.length : Number(concurrent);
      await _concurrencyPool(tasks.map(n => () => runOne(n)), lim, null);
    } else {
      for (const node of tasks) {
        if (opts.exitOnError && failed.length) {
          node.state = TASK_STATE.SKIPPED; emitNdjson({ task: node.title, state: 'skipped' }); emitAppend(node, 'skip'); repaint();
          continue;
        }
        try { await runOne(node); } catch (_) { /* exitOnError already recorded */ break; }
      }
    }
  } finally {
    if (timer) { try { clearInterval(timer); } catch (_) {} }
    if (isTty) { repaint(); fb.done(); }
  }
  return { ok: failed.length === 0, results, durationMs: Date.now() - startedAll, failed };
}

// fromStepStream — adapter for pipeline-make()-style {step,status,name,detail}
// async generators. Renders a flat tree, returns {ok, events}.
export async function fromStepStream(iter, opts = {}) {
  const stream = opts.stream || process.stderr;
  const json = !!opts.json;
  const noProgress = !!process.env.KOLM_NO_PROGRESS;
  const isTty = !!(stream && stream.isTTY) && !noProgress && !json;
  const useColor = supportsColor(stream);
  const useUnicode = supportsUnicode();
  const frames = useUnicode ? SPINNER_FRAMES_UNICODE : SPINNER_FRAMES_ASCII;
  const events = [];
  const nodes = [];
  const byStep = new Map();
  const fb = _FrameBuffer({ stream });
  let spinIdx = 0;
  let timer = null;
  let ok = true;
  const repaint = () => {
    if (!isTty) return;
    fb.render(_renderTree(nodes, { useUnicode, useColor, spinnerFrame: frames[spinIdx % frames.length], columns: stream.columns || 80 }));
  };
  if (isTty) { timer = setInterval(() => { spinIdx++; repaint(); }, opts.tickMs || 80); if (timer.unref) timer.unref(); }
  try {
    for await (const ev of iter) {
      events.push(ev);
      if (json) { stream.write(JSON.stringify(ev) + '\n'); continue; }
      let node = byStep.get(ev.step);
      if (!node) { node = { title: ev.name || ('step ' + ev.step), depth: 0, state: TASK_STATE.PENDING, startedAt: Date.now() }; byStep.set(ev.step, node); nodes.push(node); }
      if (ev.name) node.title = ev.name;
      if (ev.status === 'started' || ev.status === 'running') { node.state = TASK_STATE.RUNNING; if (!isTty) stream.write('start: ' + node.title + '\n'); }
      else if (ev.status === 'ok' || ev.status === 'done') { node.state = TASK_STATE.COMPLETED; node.endedAt = Date.now(); if (ev.detail != null) node.output = typeof ev.detail === 'string' ? ev.detail : JSON.stringify(ev.detail); if (!isTty) stream.write('done: ' + node.title + '\n'); }
      else if (ev.status === 'err' || ev.status === 'fail') { node.state = TASK_STATE.FAILED; node.endedAt = Date.now(); node.error = ev.detail ? String(ev.detail) : 'failed'; ok = false; if (!isTty) stream.write('fail: ' + node.title + ' — ' + node.error + '\n'); }
      repaint();
    }
  } finally {
    if (timer) { try { clearInterval(timer); } catch (_) {} }
    if (isTty) { repaint(); fb.done(); }
  }
  return { ok, events };
}

// fromPhaseStream — adapter for compileFull()-style {phase,...} async
// generators. phaseMap maps phase -> {title, summary?:(ev)=>string}.
export async function fromPhaseStream(iter, phaseMap = {}, opts = {}) {
  const stream = opts.stream || process.stderr;
  const json = !!opts.json;
  const noProgress = !!process.env.KOLM_NO_PROGRESS;
  const isTty = !!(stream && stream.isTTY) && !noProgress && !json;
  const useColor = supportsColor(stream);
  const useUnicode = supportsUnicode();
  const frames = useUnicode ? SPINNER_FRAMES_UNICODE : SPINNER_FRAMES_ASCII;
  const events = [];
  const nodes = [];
  const byPhase = new Map();
  const fb = _FrameBuffer({ stream });
  let spinIdx = 0; let timer = null; let ok = true; let done = null; let failedPhase = null;
  const repaint = () => {
    if (!isTty) return;
    fb.render(_renderTree(nodes, { useUnicode, useColor, spinnerFrame: frames[spinIdx % frames.length], columns: stream.columns || 80 }));
  };
  if (isTty) { timer = setInterval(() => { spinIdx++; repaint(); }, opts.tickMs || 80); if (timer.unref) timer.unref(); }
  try {
    for await (const ev of iter) {
      events.push(ev);
      if (json) { stream.write(JSON.stringify(ev) + '\n'); if (ev.phase === 'done') done = ev; continue; }
      const phase = ev.phase;
      if (phase === 'done') { done = ev; continue; }
      const meta = phaseMap[phase] || { title: phase };
      let node = byPhase.get(phase);
      if (!node) {
        // Mark the previous running node complete when a new phase begins.
        for (const pn of nodes) if (pn.state === TASK_STATE.RUNNING) { pn.state = TASK_STATE.COMPLETED; pn.endedAt = Date.now(); }
        node = { title: meta.title || phase, depth: 0, state: TASK_STATE.RUNNING, startedAt: Date.now() };
        byPhase.set(phase, node); nodes.push(node);
        if (!isTty) stream.write('start: ' + node.title + '\n');
      }
      if (ev.error || ev.status === 'error' || ev.ok === false) {
        node.state = TASK_STATE.FAILED; node.endedAt = Date.now(); node.error = ev.error ? String(ev.error) : 'failed'; ok = false; failedPhase = phase;
        if (!isTty) stream.write('fail: ' + node.title + ' — ' + node.error + '\n');
      } else if (typeof meta.summary === 'function') {
        try { node.output = meta.summary(ev); } catch (_) {}
      }
      repaint();
    }
    // Close any still-running node.
    for (const pn of nodes) if (pn.state === TASK_STATE.RUNNING) { pn.state = TASK_STATE.COMPLETED; pn.endedAt = Date.now(); if (!isTty && !json) stream.write('done: ' + pn.title + '\n'); }
  } finally {
    if (timer) { try { clearInterval(timer); } catch (_) {} }
    if (isTty) { repaint(); fb.done(); }
  }
  return { ok, events, done, failedPhase };
}
