#!/usr/bin/env node
// W890-7 — kolm doctor with zero configuration.
// Strategy:
//   1) Create a pristine $HOME (empty .kolm dir).
//   2) Strip every KOLM_*, ANTHROPIC_*, OPENAI_*, STRIPE_*, RESEND_* env var.
//   3) Run `kolm doctor --allow-logged-out --json`. Per W481 P0-8, that flag
//      is the established "first-time CI" semantics: doctor exit 0 means
//      every blocker except optional auth is satisfied.
//   4) Record exit_code, blockers count, list of critical_failures.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function pristineEnv() {
  const env = {};
  // Preserve only the bare minimum POSIX env so node can launch on Windows.
  const allow = ['PATH','SYSTEMROOT','SYSTEMDRIVE','WINDIR','COMSPEC','PATHEXT','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','OS','TEMP','TMP'];
  for (const k of allow) if (process.env[k] != null) env[k] = process.env[k];
  // Pristine user dir
  const home = path.join(os.tmpdir(), 'kolm-pristine-w890-7-' + Date.now());
  fs.mkdirSync(path.join(home, '.kolm'), { recursive: true });
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = path.join(home, 'AppData/Roaming');
  env.LOCALAPPDATA = path.join(home, 'AppData/Local');
  fs.mkdirSync(env.APPDATA, { recursive: true });
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  return { env, home };
}

const { env, home } = pristineEnv();
const r = spawnSync(process.execPath, ['cli/kolm.js', 'doctor', '--allow-logged-out', '--json'], {
  cwd: ROOT,
  env,
  encoding: 'utf8',
  timeout: 120000,
});
const out = r.stdout || '';
const idx = out.indexOf('{');
let parsed = null;
if (idx >= 0) {
  try { parsed = JSON.parse(out.slice(idx)); } catch (_) { /* parse failed */ }
}

const critical = parsed && parsed.checks ? parsed.checks.filter(c => c.status === 'blocker' || c.status === 'missing').map(c => ({
  name: c.name, status: c.status, detail: (c.detail || '').slice(0, 200),
})) : [];

const result = {
  generated_at: new Date().toISOString(),
  scenario: 'pristine HOME (no .kolm/config.toml, no .kolm/config.json) + stripped KOLM_*/ANTHROPIC_*/STRIPE_*/RESEND_* env',
  flag: '--allow-logged-out (W481 P0-8 first-time/CI semantics: optional auth demoted to warn)',
  exit_code: r.status === null ? -1 : r.status,
  doctor_ok: parsed ? parsed.ok : null,
  blockers: parsed ? parsed.blockers : null,
  warnings: parsed ? parsed.warnings : null,
  critical_failures: critical,
  pristine_home: home,
};
fs.writeFileSync(path.join(ROOT, 'data/w890-7-zero-config-doctor.json'), JSON.stringify(result, null, 2));
console.log('exit_code:', result.exit_code, 'blockers:', result.blockers, 'warnings:', result.warnings);
