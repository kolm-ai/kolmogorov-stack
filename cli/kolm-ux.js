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
  const frames = useUnicode ? SPINNER_FRAMES_UNICODE : SPINNER_FRAMES_ASCII;
  let i = 0;
  let timer = null;
  let stopped = false;

  if (isTty && !opts.silent) {
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
