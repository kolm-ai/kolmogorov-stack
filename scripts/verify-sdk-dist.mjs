#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TARGETS = new Map([
  ['sdk-ts', {
    root: 'packages/sdk-ts',
    js: 'dist/index.js',
    dts: 'dist/index.d.ts',
    source: 'src/index.ts',
    requiredJs: ['export const VERSION', 'export class VerificationError', 'export async function load', 'export async function loadBuffer', 'export default _default'],
    requiredDts: ['export declare const VERSION', 'export declare class VerificationError', 'export declare function load', 'export declare function loadBuffer', 'export default _default'],
    dynamic: true,
  }],
  ['sdk-rn', {
    root: 'packages/sdk-rn',
    js: 'dist/index.js',
    dts: 'dist/index.d.ts',
    source: 'index.ts',
    requiredJs: ['export function setConfig', 'const Kolm =', 'export default Kolm'],
    requiredDts: ['export function setConfig', 'export interface KolmModel', 'export default Kolm'],
    dynamic: false,
  }],
]);

const args = process.argv.slice(2);
const targetId = args.find((arg) => !arg.startsWith('--')) || '';
const json = args.includes('--json');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function lineCount(text) {
  return text.split(/\r?\n/).length;
}

async function verify(target) {
  const pkg = readJson(path.join(ROOT, target.root, 'package.json'));
  const failures = [];
  for (const rel of [target.js, target.dts, target.source]) {
    if (!exists(path.join(target.root, rel))) failures.push(`missing:${rel}`);
  }
  let js = '';
  let dts = '';
  let source = '';
  if (failures.length === 0) {
    js = read(path.join(target.root, target.js));
    dts = read(path.join(target.root, target.dts));
    source = read(path.join(target.root, target.source));
    for (const token of target.requiredJs) {
      if (!js.includes(token)) failures.push(`dist_js_missing:${token}`);
    }
    for (const token of target.requiredDts) {
      if (!dts.includes(token)) failures.push(`dist_dts_missing:${token}`);
    }
    if (pkg.name === 'kolm') {
      const sourceVersion = (source.match(/export const VERSION\s*=\s*"([^"]+)"/) || [])[1] || null;
      const jsVersion = (js.match(/export const VERSION\s*=\s*"([^"]+)"/) || [])[1] || null;
      const dtsVersion = (dts.match(/export declare const VERSION\s*=\s*"([^"]+)"/) || [])[1] || null;
      for (const [label, version] of [['source', sourceVersion], ['dist_js', jsVersion], ['dist_dts', dtsVersion]]) {
        if (version !== pkg.version) failures.push(`${label}_version_mismatch:${version || 'missing'}!=${pkg.version}`);
      }
    }
    if (source.includes('\u0000') || js.includes('\u0000') || dts.includes('\u0000')) failures.push('nul_byte_detected');
  }
  let imported = null;
  if (target.dynamic && failures.length === 0) {
    try {
      const mod = await import(pathToFileURL(path.join(ROOT, target.root, target.js)).href + `?v=${Date.now()}`);
      imported = {
        version: mod.VERSION || null,
        exports: Object.keys(mod).sort(),
      };
      if (mod.VERSION !== pkg.version) failures.push(`import_version_mismatch:${mod.VERSION || 'missing'}!=${pkg.version}`);
      for (const name of ['load', 'loadBuffer', 'canonicalJson', 'VerificationError', 'KolmModel']) {
        if (!(name in mod)) failures.push(`missing_runtime_export:${name}`);
      }
    } catch (e) {
      failures.push(`import_failed:${String(e && e.message || e)}`);
    }
  }
  return {
    target: pkg.name,
    package_version: pkg.version,
    root: target.root,
    ok: failures.length === 0,
    secret_values_included: false,
    files: {
      source: target.source,
      js: target.js,
      dts: target.dts,
    },
    line_counts: failures.length === 0 ? {
      source: lineCount(source),
      js: lineCount(js),
      dts: lineCount(dts),
    } : null,
    imported,
    failures,
  };
}

async function main() {
  if (!TARGETS.has(targetId)) {
    const out = {
      ok: false,
      secret_values_included: false,
      error: 'unknown_target',
      targets: [...TARGETS.keys()],
    };
    console.error(json ? JSON.stringify(out, null, 2) : `unknown target: ${targetId}`);
    process.exit(64);
  }
  const out = await verify(TARGETS.get(targetId));
  if (json) console.log(JSON.stringify(out, null, 2));
  else console.log(`sdk-dist: ${out.ok ? 'ok' : 'failed'} target=${targetId} version=${out.package_version}`);
  if (!out.ok) {
    for (const failure of out.failures) console.error(failure);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`sdk-dist failed: ${String(e && e.message || e)}`);
  process.exit(1);
});
