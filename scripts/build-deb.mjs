#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const json = args.includes('--json');
const versionArg = args.find((arg) => arg.startsWith('--version='));
const outArg = args.find((arg) => arg.startsWith('--out='));

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) copyFile(s, d);
  }
}

function commandExists(cmd) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [cmd] : ['-v', cmd], {
    encoding: 'utf8',
    shell: process.platform !== 'win32',
    timeout: 5000,
  });
  return probe.status === 0;
}

const pkg = readJson('package.json');
const version = versionArg ? versionArg.slice('--version='.length) : pkg.version;
const outDir = path.resolve(root, outArg ? outArg.slice('--out='.length) : path.join('build', 'deb'));
const stage = path.join(outDir, `kolm_${version}_all`);
const debPath = path.join(outDir, `kolm_${version}_all.deb`);

const files = [
  'package.json',
  'server.js',
  'README.md',
  'LICENSE',
];
const dirs = [
  'cli',
  'src',
  'services',
  'sdk',
  'public',
];

const plan = {
  spec: 'kolm-deb-build-plan-1',
  ok: true,
  dry_run: dryRun,
  package: 'kolm',
  version,
  architecture: 'all',
  stage,
  deb_path: debPath,
  files,
  dirs,
  dpkg_deb_available: commandExists('dpkg-deb'),
  secret_values_included: false,
};

if (!dryRun) {
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'DEBIAN'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'usr', 'lib', 'kolm'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'usr', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'usr', 'share', 'doc', 'kolm'), { recursive: true });

  const control = fs.readFileSync(path.join(root, 'packages', 'apt', 'kolm.control'), 'utf8')
    .replace(/^Version:\s*.+$/m, `Version: ${version}`);
  fs.writeFileSync(path.join(stage, 'DEBIAN', 'control'), `${control.trim()}\n`);
  for (const rel of files) {
    const src = path.join(root, rel);
    if (fs.existsSync(src)) copyFile(src, path.join(stage, 'usr', 'lib', 'kolm', rel));
  }
  for (const rel of dirs) copyDir(path.join(root, rel), path.join(stage, 'usr', 'lib', 'kolm', rel));
  fs.writeFileSync(path.join(stage, 'usr', 'bin', 'kolm'), '#!/usr/bin/env sh\nexec node /usr/lib/kolm/cli/kolm.js "$@"\n');
  fs.chmodSync(path.join(stage, 'usr', 'bin', 'kolm'), 0o755);
  copyFile(path.join(root, 'LICENSE'), path.join(stage, 'usr', 'share', 'doc', 'kolm', 'copyright'));

  if (plan.dpkg_deb_available) {
    const build = spawnSync('dpkg-deb', ['--build', stage, debPath], { encoding: 'utf8', timeout: 120000 });
    plan.ok = build.status === 0;
    plan.dpkg_status = build.status;
    plan.dpkg_stdout = String(build.stdout || '').slice(0, 2000);
    plan.dpkg_stderr = String(build.stderr || '').slice(0, 2000);
  } else {
    plan.ok = true;
    plan.note = 'dpkg-deb unavailable; staged package layout only';
  }
}

if (json) console.log(JSON.stringify(plan, null, 2));
else {
  console.log(`ok=${plan.ok} dry_run=${plan.dry_run} package=${plan.package} version=${plan.version} dpkg_deb_available=${plan.dpkg_deb_available}`);
  console.log(`stage=${plan.stage}`);
  console.log(`deb=${plan.deb_path}`);
  if (plan.note) console.log(`note=${plan.note}`);
}

if (!plan.ok) process.exit(1);
