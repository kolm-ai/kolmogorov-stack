#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  auditPackageReleaseReadiness,
  PACKAGE_RELEASE_TARGETS,
  packageReleaseManifestTemplate,
  validatePackageReleaseManifest,
} from '../src/package-release-readiness.js';

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const catalog = args.includes('--catalog');
const template = args.includes('--template');
const smokeInstallers = args.includes('--smoke-installers');
const runLocalChecks = args.includes('--run-local-checks');
const strictLocalChecks = args.includes('--strict-local-checks');
const validateIdx = args.indexOf('--validate');
const validatePath = validateIdx >= 0 ? args[validateIdx + 1] : null;
const json = args.includes('--json') || (!summary && !catalog && !template && !smokeInstallers && !runLocalChecks && validateIdx < 0);
const requireLocal = args.includes('--require-local-contract');
const requirePublish = args.includes('--require-publish-ready');
const targetFlag = args.find((arg) => arg.startsWith('--target='));
const targetId = targetFlag ? targetFlag.slice('--target='.length) : null;

function usage() {
  console.log(`kolm package release readiness

USAGE
  node scripts/package-release-readiness.mjs [--summary] [--json]
  node scripts/package-release-readiness.mjs --catalog
  node scripts/package-release-readiness.mjs --target=sdk-ts --json
  node scripts/package-release-readiness.mjs --smoke-installers
  node scripts/package-release-readiness.mjs --run-local-checks [--target=<id>]
  node scripts/package-release-readiness.mjs --template
  node scripts/package-release-readiness.mjs --validate reports/package-release-manifest.json

FLAGS
  --require-local-contract   exit non-zero if any local manifest/docs contract fails
  --require-publish-ready    exit non-zero if any package still needs channel artifacts
  --strict-local-checks      fail local check runs when a toolchain/dependency is missing

SCOPE
  Local only. This never publishes packages, contacts registries, or prints secrets.`);
}

function runSmoke(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, KOLM_INSTALL_DIR: '__kolm_dry_run_install__', KOLM_BIN_DIR: '__kolm_dry_run_bin__' },
  });
  return {
    label,
    command: [command, ...args].join(' '),
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').slice(0, 2000),
    stderr: String(result.stderr || '').slice(0, 2000),
  };
}

function findPowerShellCommand() {
  for (const candidate of ['powershell', 'pwsh']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function smokeInstallerScripts() {
  const checks = [];
  const ps = findPowerShellCommand();
  if (ps) {
    checks.push(runSmoke('powershell-whatif', ps, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/install.ps1',
      '-WhatIf',
    ]));
  } else {
    checks.push({
      label: 'powershell-whatif',
      command: 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -WhatIf',
      ok: true,
      skipped: true,
      reason: 'powershell_unavailable',
    });
  }
  const shProbe = spawnSync('sh', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (shProbe.error) {
    checks.push({
      label: 'posix-shell-syntax',
      command: 'sh -n scripts/install.sh',
      ok: true,
      skipped: true,
      reason: 'sh_unavailable',
    });
  } else {
    checks.push(runSmoke('posix-shell-syntax', 'sh', ['-n', 'scripts/install.sh']));
  }
  checks.push(runSmoke('deb-build-plan', process.execPath, ['scripts/build-deb.mjs', '--dry-run', '--json']));
  return {
    ok: checks.every((check) => check.ok || check.skipped),
    secret_values_included: false,
    checks,
  };
}

function tokeniseCommand(command) {
  return String(command).trim().split(/\s+/).filter(Boolean);
}

function normalizeExecutable(command) {
  if (command === 'node') return process.execPath;
  if (command === 'powershell') return findPowerShellCommand() || 'powershell';
  return command;
}

function localCheckCwd(root, target, check) {
  if (/^(node|sh|powershell|pwsh|winget)\b/.test(check)) return root;
  return path.join(root, target.root);
}

function classifySkipped(result, command) {
  const output = `${result.error ? String(result.error.message || result.error) : ''}\n${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.error && result.error.code === 'ENOENT') return 'tool_unavailable';
  if (/not recognized as an internal or external command/i.test(output)) {
    if (/\b(tsc|gradle|cargo|swift|brew|winget|sh)\b/i.test(output)) return 'toolchain_unavailable';
    return 'command_unavailable';
  }
  if (/No module named build/i.test(output)) return 'python_build_module_unavailable';
  if (/Cannot find module|MODULE_NOT_FOUND/i.test(output)) return 'package_dependency_uninstalled';
  if (/Could not connect to server|failed to download from|Updating crates\.io index|crates\.io/i.test(output)) return 'network_unavailable_for_dependency_resolution';
  if (/command not found|not found/i.test(output) && /\b(tsc|gradle|cargo|swift|brew|winget|sh)\b/i.test(output)) return 'toolchain_unavailable';
  return null;
}

function runLocalCheck(root, target, check, options = {}) {
  const tokens = tokeniseCommand(check);
  if (!tokens.length) {
    return { label: check, command: check, ok: false, skipped: false, status: null, error: 'empty_command' };
  }
  let executable = normalizeExecutable(tokens[0]);
  let childArgs = tokens.slice(1);
  if (tokens[0] === 'npm' && process.platform === 'win32') {
    executable = process.env.ComSpec || 'cmd.exe';
    childArgs = ['/d', '/s', '/c', 'npm.cmd', ...tokens.slice(1)];
  }
  const cwd = localCheckCwd(root, target, check);
  const npmCache = path.join(root, '.tmp', `package-release-npm-cache-${process.pid}`);
  fs.mkdirSync(npmCache, { recursive: true });
  const env = {
    ...process.env,
    npm_config_cache: npmCache,
    npm_config_loglevel: process.env.npm_config_loglevel || 'warn',
    KOLM_INSTALL_DIR: '__kolm_dry_run_install__',
    KOLM_BIN_DIR: '__kolm_dry_run_bin__',
  };
  const result = spawnSync(executable, childArgs, {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env,
  });
  const skipReason = result.status === 0 ? null : classifySkipped(result, check);
  const skipped = Boolean(skipReason && !options.strict);
  return {
    target: target.id,
    label: check,
    command: tokens[0] === 'npm' && process.platform === 'win32'
      ? ['npm.cmd', ...tokens.slice(1)].join(' ')
      : [executable, ...childArgs].join(' '),
    cwd: path.relative(root, cwd) || '.',
    ok: result.status === 0 || skipped,
    skipped,
    reason: skipped ? skipReason : undefined,
    status: result.status,
    stdout: String(result.stdout || '').slice(0, 2000),
    stderr: String(result.stderr || '').slice(0, 2000),
    error: result.error ? String(result.error.message || result.error) : undefined,
  };
}

function runLocalPackageChecks(options = {}) {
  const root = process.cwd();
  const targets = PACKAGE_RELEASE_TARGETS
    .filter((target) => !options.targetId || target.id === options.targetId);
  const checks = [];
  for (const target of targets) {
    for (const check of target.checks || []) {
      checks.push(runLocalCheck(root, target, check, { strict: options.strict }));
    }
  }
  if (options.targetId && targets.length === 0) {
    return {
      ok: false,
      secret_values_included: false,
      target_count: 0,
      checks: [],
      failures: [`unknown_target:${options.targetId}`],
    };
  }
  const failures = checks
    .filter((check) => !check.ok)
    .map((check) => `${check.target}:${check.label}:${check.status ?? check.error ?? 'failed'}`);
  return {
    ok: failures.length === 0,
    secret_values_included: false,
    strict: Boolean(options.strict),
    target_count: targets.length,
    check_count: checks.length,
    passed: checks.filter((check) => check.ok && !check.skipped).length,
    skipped: checks.filter((check) => check.skipped).length,
    failed: checks.filter((check) => !check.ok).length,
    checks,
    failures,
  };
}

if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

if (template) {
  console.log(JSON.stringify({ ok: true, template: packageReleaseManifestTemplate() }, null, 2));
  process.exit(0);
}

if (smokeInstallers) {
  const smoke = smokeInstallerScripts();
  if (summary) {
    console.log(`ok=${smoke.ok} checks=${smoke.checks.length}`);
    for (const check of smoke.checks) {
      console.log(`${check.label}: ${check.skipped ? 'skipped' : check.ok ? 'pass' : 'fail'}`);
    }
  } else {
    console.log(JSON.stringify(smoke, null, 2));
  }
  if (!smoke.ok) process.exit(1);
  process.exit(0);
}

if (runLocalChecks) {
  const checks = runLocalPackageChecks({ targetId, strict: strictLocalChecks });
  if (summary) {
    console.log(`ok=${checks.ok} targets=${checks.target_count} checks=${checks.check_count} passed=${checks.passed} skipped=${checks.skipped} failed=${checks.failed}`);
    for (const check of checks.checks) {
      console.log(`${check.target}:${check.label}: ${check.skipped ? `skipped:${check.reason}` : check.ok ? 'pass' : 'fail'}`);
    }
    for (const failure of checks.failures) console.log(failure);
  } else {
    console.log(JSON.stringify(checks, null, 2));
  }
  if (!checks.ok) process.exit(1);
  process.exit(0);
}

if (validateIdx >= 0) {
  if (!validatePath) {
    console.error('error: --validate requires a package release manifest JSON path');
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(validatePath, 'utf8'));
  } catch (e) {
    console.error(`error: cannot read package release manifest: ${String(e.message || e)}`);
    process.exit(2);
  }
  const validation = validatePackageReleaseManifest(parsed);
  if (summary) {
    console.log(`ok=${validation.ok} publish_ready=${validation.publish_ready} targets=${validation.counts.complete_targets}/${validation.counts.required_targets} failures=${validation.counts.failures}`);
    for (const failure of validation.failures) console.log(failure);
  } else {
    console.log(JSON.stringify(validation, null, 2));
  }
  if (!validation.ok) process.exit(1);
  process.exit(0);
}

if (catalog) {
  console.log(JSON.stringify({
    ok: true,
    secret_values_included: false,
    targets: PACKAGE_RELEASE_TARGETS,
  }, null, 2));
  process.exit(0);
}

const audit = auditPackageReleaseReadiness();
const out = targetId
  ? { ...audit, targets: audit.targets.filter((target) => target.id === targetId) }
  : audit;

if (targetId && out.targets.length === 0) {
  console.error(`unknown package target: ${targetId}`);
  process.exit(64);
}

if (summary) {
  console.log(`ok=${audit.ok} publish_ready=${audit.publish_ready} targets=${audit.counts.targets} structural_ok=${audit.counts.structural_ok} pending=${audit.counts.package_channel_pending} blocked=${audit.counts.blocked}`);
  for (const [id, req] of Object.entries(audit.by_requirement)) {
    console.log(`${id}: ${req.status} targets=${req.targets.join(',')}`);
  }
  if (audit.publish_blockers.length) {
    console.log('publish blockers: ' + audit.publish_blockers.join(', '));
  }
} else if (json) {
  console.log(JSON.stringify(out, null, 2));
}

if (requireLocal && !audit.ok) process.exit(1);
if (requirePublish && !audit.publish_ready) process.exit(1);
