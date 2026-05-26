// scripts/shard-install-verify.cjs
//
// Node-side install verifier for the Shard KV cache Python library.
//
// Does NOT pip install. Reports installed/not-installed + version + hint.
//
// Usage:
//   node scripts/shard-install-verify.cjs            # human-readable
//   node scripts/shard-install-verify.cjs --json     # JSON envelope
//
// Exit codes:
//   0 — Shard is installed; version reported
//   3 — Shard is not installed; install hint printed
//   2 — Python interpreter not found

'use strict';

const { spawnSync } = require('node:child_process');

const JSON_MODE = process.argv.includes('--json');

const ANSI = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
};

function _emit(payload, humanLine) {
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else if (humanLine) {
    process.stdout.write(humanLine + '\n');
  }
}

function _findPython() {
  // Try python3 then python (Windows commonly ships only `python`).
  for (const exe of ['python3', 'python']) {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 || /python/i.test(String(r.stdout || r.stderr || ''))) {
      return exe;
    }
  }
  return null;
}

function main() {
  const python = _findPython();
  if (!python) {
    _emit(
      {
        ok: false,
        reason: 'python_not_found',
        hint: 'Install Python 3.10+ and ensure `python3` or `python` is on PATH.',
      },
      `${ANSI.red}Python interpreter not found.${ANSI.reset} Install Python 3.10+ and ensure \`python3\` or \`python\` is on PATH.`
    );
    process.exit(2);
  }

  const probe = spawnSync(
    python,
    [
      '-c',
      [
        'import sys',
        'try:',
        '    import shard',
        '    v = getattr(shard, "__version__", "unknown")',
        '    print("OK " + str(v))',
        'except ImportError as e:',
        '    print("MISSING " + str(e))',
        '    sys.exit(3)',
        'except Exception as e:',
        '    print("ERROR " + repr(e))',
        '    sys.exit(4)',
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );

  const stdout = String(probe.stdout || '').trim();
  const stderr = String(probe.stderr || '').trim();

  if (probe.status === 0 && stdout.startsWith('OK ')) {
    const version = stdout.slice(3).trim();
    _emit(
      {
        ok: true,
        installed: true,
        version,
        python,
      },
      `${ANSI.green}Shard installed:${ANSI.reset} ${ANSI.bold}${version}${ANSI.reset} (via ${python})`
    );
    process.exit(0);
  }

  if (probe.status === 3 || stdout.startsWith('MISSING')) {
    _emit(
      {
        ok: false,
        installed: false,
        reason: 'shard_not_installed',
        hint: 'pip install shard-kv',
        python,
        detail: stdout || stderr || null,
      },
      `${ANSI.yellow}Shard not installed.${ANSI.reset} Install with: ${ANSI.bold}pip install shard-kv${ANSI.reset}\n  (reference: github.com/krish1905/shard)`
    );
    process.exit(3);
  }

  _emit(
    {
      ok: false,
      installed: false,
      reason: 'probe_failed',
      python,
      exit_code: probe.status,
      stdout,
      stderr,
    },
    `${ANSI.red}Shard install probe failed${ANSI.reset} (exit ${probe.status}). stdout=${stdout} stderr=${stderr}`
  );
  process.exit(probe.status || 1);
}

main();
