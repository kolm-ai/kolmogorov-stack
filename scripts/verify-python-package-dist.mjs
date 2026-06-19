#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import { PACKAGE_RELEASE_TARGETS } from '../src/package-release-readiness.js';

const SPEC = 'kolm-python-package-dist-verifier-1';
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  usage(process.stdout);
  process.exit(0);
}

const json = args.includes('--json') || !args.includes('--summary');
const packageArgs = valuesFor('--package');
const targetArgs = valuesFor('--target');
const packageRoots = resolvePackageRoots();
const results = packageRoots.map((packageRoot) => verifyPythonPackageDist(packageRoot));
const failures = results.flatMap((result) => result.failures.map((failure) => `${result.package_root}:${failure}`));
const report = {
  spec: SPEC,
  ok: failures.length === 0,
  secret_values_included: false,
  package_count: results.length,
  packages: results,
  failures,
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`ok=${report.ok} packages=${report.package_count} failures=${failures.length}`);
  for (const result of results) {
    console.log(`${result.package_root}: ${result.ok ? 'pass' : 'fail'} wheel=${result.wheel?.path || 'missing'} sdist=${result.sdist?.path || 'missing'}`);
  }
  for (const failure of failures) console.log(failure);
}

process.exit(report.ok ? 0 : 1);

function usage(stream) {
  stream.write(`kolm Python package dist verifier

USAGE
  node scripts/verify-python-package-dist.mjs [--summary] [--json]
  node scripts/verify-python-package-dist.mjs --package packages/sdk-python
  node scripts/verify-python-package-dist.mjs --target sdk-python

SCOPE
  Local only. Inspects checked-in wheel/sdist artifacts without publishing,
  installing dependencies, or importing package code.
`);
}

function valuesFor(name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1]) values.push(args[i + 1]);
    else if (args[i].startsWith(`${name}=`)) values.push(args[i].slice(name.length + 1));
  }
  return values;
}

function resolvePackageRoots() {
  const pypiTargets = PACKAGE_RELEASE_TARGETS.filter((target) => target.channel === 'pypi');
  if (targetArgs.length) {
    const byId = new Map(pypiTargets.map((target) => [target.id, target]));
    return targetArgs.map((id) => {
      const target = byId.get(id);
      if (!target) throwExit(`unknown_pypi_target:${id}`);
      return target.root;
    });
  }
  if (packageArgs.length) return packageArgs;
  return pypiTargets.map((target) => target.root);
}

function throwExit(message) {
  console.error(message);
  process.exit(2);
}

function verifyPythonPackageDist(packageRootInput) {
  const packageRoot = normalizeRel(packageRootInput);
  const root = path.resolve(packageRoot);
  const failures = [];
  const warnings = [];
  const pyprojectPath = path.join(root, 'pyproject.toml');
  const pyproject = readText(pyprojectPath, failures, 'pyproject.toml');
  const project = parsePyproject(pyproject);
  for (const key of ['name', 'version', 'requires_python', 'license', 'readme', 'build_backend']) {
    if (!project[key]) failures.push(`pyproject:${key}:missing`);
  }
  const distDir = path.join(root, 'dist');
  if (!fs.existsSync(distDir)) failures.push('dist:missing');
  const distFiles = fs.existsSync(distDir)
    ? fs.readdirSync(distDir).filter((name) => fs.statSync(path.join(distDir, name)).isFile())
    : [];
  const wheelBase = normalizeWheelName(project.name);
  const version = project.version || 'missing';
  const wheelName = distFiles.find((name) => name.startsWith(`${wheelBase}-${version}-`) && name.endsWith('.whl'));
  const sdistName = distFiles.find((name) => name.startsWith(`${wheelBase}-${version}`) && name.endsWith('.tar.gz'));
  if (!wheelName) failures.push(`wheel:missing:${wheelBase}-${version}-*.whl`);
  if (!sdistName) failures.push(`sdist:missing:${wheelBase}-${version}.tar.gz`);

  const packagePrefix = project.package_prefix || wheelBase;
  const wheel = wheelName ? inspectWheel(path.join(distDir, wheelName), packagePrefix, project, failures, warnings) : null;
  const sdist = sdistName ? inspectSdist(path.join(distDir, sdistName), packagePrefix, project, failures, warnings) : null;

  return {
    package_root: packageRoot,
    ok: failures.length === 0,
    project,
    wheel,
    sdist,
    warnings,
    failures,
  };
}

function readText(file, failures, label) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    failures.push(`${label}:read_failed:${String(e.message || e)}`);
    return '';
  }
}

function parsePyproject(text) {
  const value = (key) => {
    const match = text.match(new RegExp(`^\\s*${key.replace('-', '[-_]')}\\s*=\\s*["']([^"']+)["']`, 'm'));
    return match ? match[1] : null;
  };
  const licenseMatch = text.match(/^\s*license\s*=\s*(.+)$/m);
  const includeMatch = text.match(/^\s*include\s*=\s*\[\s*["']([^"']+)["']/m);
  const include = includeMatch ? includeMatch[1].replace(/\*.*$/, '') : null;
  return {
    name: value('name'),
    version: value('version'),
    requires_python: value('requires-python'),
    readme: value('readme'),
    license: licenseMatch ? licenseMatch[1].trim() : null,
    build_backend: value('build-backend'),
    package_prefix: include ? include.replace(/[-.]/g, '_').replace(/\/$/, '') : null,
  };
}

function inspectWheel(file, packagePrefix, project, failures, warnings) {
  let zip;
  try {
    zip = new AdmZip(file);
  } catch (e) {
    warnings.push(`wheel:read_skipped:${String(e.code || e.message || e)}`);
    return artifactSummary(file, null, e);
  }
  const entries = zip.getEntries().map((entry) => entry.entryName.replace(/\\/g, '/'));
  const distInfoPrefix = `${normalizeWheelName(project.name)}-${project.version}.dist-info/`;
  requireEntry(entries, `${packagePrefix}/__init__.py`, 'wheel', failures);
  for (const rel of [`${distInfoPrefix}METADATA`, `${distInfoPrefix}WHEEL`, `${distInfoPrefix}RECORD`]) {
    requireEntry(entries, rel, 'wheel', failures);
  }
  const metadataEntry = zip.getEntry(`${distInfoPrefix}METADATA`);
  const metadata = metadataEntry ? metadataEntry.getData().toString('utf8') : '';
  if (project.name && !new RegExp(`^Name:\\s*${escapeRe(project.name)}\\s*$`, 'mi').test(metadata)) failures.push('wheel:metadata_name_mismatch');
  if (project.version && !new RegExp(`^Version:\\s*${escapeRe(project.version)}\\s*$`, 'mi').test(metadata)) failures.push('wheel:metadata_version_mismatch');
  if (entries.some((entry) => /(?:^|\/)__pycache__\/|\.pyc$/i.test(entry))) failures.push('wheel:contains_pycache_or_pyc');
  return artifactSummary(file, entries);
}

function inspectSdist(file, packagePrefix, project, failures, warnings) {
  let entries;
  try {
    entries = listTarGz(file);
  } catch (e) {
    warnings.push(`sdist:read_skipped:${String(e.code || e.message || e)}`);
    return artifactSummary(file, null, e);
  }
  if (!entries.some((entry) => entry.endsWith('/pyproject.toml'))) failures.push('sdist:pyproject_missing');
  if (!entries.some((entry) => entry.endsWith(`/${packagePrefix}/__init__.py`))) failures.push(`sdist:${packagePrefix}/__init__.py:missing`);
  if (entries.some((entry) => /(?:^|\/)__pycache__\/|\.pyc$/i.test(entry))) failures.push('sdist:contains_pycache_or_pyc');
  if (project.name && !entries.some((entry) => entry.startsWith(`${normalizeWheelName(project.name)}-${project.version}/`))) {
    failures.push('sdist:root_directory_mismatch');
  }
  return artifactSummary(file, entries);
}

function listTarGz(file) {
  const buffer = zlib.gunzipSync(fs.readFileSync(file));
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const name = cleanTarString(block.subarray(0, 100));
    const sizeText = cleanTarString(block.subarray(124, 136)).replace(/\0/g, '').trim();
    const prefix = cleanTarString(block.subarray(345, 500));
    const size = Number.parseInt(sizeText || '0', 8) || 0;
    const fullName = [prefix, name].filter(Boolean).join('/');
    if (fullName) entries.push(fullName);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function cleanTarString(bytes) {
  const nul = bytes.indexOf(0);
  const slice = nul >= 0 ? bytes.subarray(0, nul) : bytes;
  return slice.toString('utf8').trim();
}

function requireEntry(entries, rel, kind, failures) {
  if (!entries.includes(rel)) failures.push(`${kind}:${rel}:missing`);
}

function artifactSummary(file, entries, readError = null) {
  const stat = fs.statSync(file);
  let digest = null;
  if (!readError) {
    try {
      const bytes = fs.readFileSync(file);
      digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    } catch (e) {
      readError = e;
    }
  }
  return {
    path: normalizeRel(file),
    sha256: digest,
    bytes: stat.size,
    entries: Array.isArray(entries) ? entries.length : null,
    readable: !readError,
    read_error: readError ? String(readError.code || readError.message || readError) : null,
  };
}

function normalizeWheelName(name) {
  return String(name || '').trim().toLowerCase().replace(/[-.]+/g, '_');
}

function normalizeRel(value) {
  return path.relative(process.cwd(), path.resolve(value)).replace(/\\/g, '/') || '.';
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
