#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'packages', 'browser-extension');
const OUT = path.join(ROOT, 'build', 'browser-extension');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const json = args.includes('--json') || dryRun;
const writeSourceIcons = args.includes('--write-source-icons');

const REQUIRED_FILES = [
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.js',
  'verifier.html',
  'verifier.js',
  'README.md',
];

const ICON_SIZES = [16, 48, 128];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([len, name, data, crc]);
}

function putPixel(rgba, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= width) return;
  const i = (y * width + x) * 4;
  rgba[i] = color[0];
  rgba[i + 1] = color[1];
  rgba[i + 2] = color[2];
  rgba[i + 3] = color[3];
}

function drawLine(rgba, size, ax, ay, bx, by, color, thickness) {
  const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1);
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const x = Math.round(ax + (bx - ax) * t);
    const y = Math.round(ay + (by - ay) * t);
    for (let yy = -thickness; yy <= thickness; yy += 1) {
      for (let xx = -thickness; xx <= thickness; xx += 1) {
        if (xx * xx + yy * yy <= thickness * thickness) putPixel(rgba, size, x + xx, y + yy, color);
      }
    }
  }
}

function makeIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [5, 12, 10, 255];
  const edge = [35, 58, 50, 255];
  const mark = [51, 255, 177, 255];
  const shade = [18, 32, 28, 255];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const border = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      putPixel(rgba, size, x, y, border ? edge : bg);
      if (!border && x > y + size * 0.34) putPixel(rgba, size, x, y, shade);
    }
  }
  const w = Math.max(1, Math.round(size / 16));
  const left = Math.round(size * 0.31);
  const top = Math.round(size * 0.22);
  const mid = Math.round(size * 0.50);
  const bot = Math.round(size * 0.78);
  const right = Math.round(size * 0.70);
  drawLine(rgba, size, left, top, left, bot, mark, w);
  drawLine(rgba, size, left, mid, right, top, mark, w);
  drawLine(rgba, size, left, mid, right, bot, mark, w);

  const rawRows = [];
  for (let y = 0; y < size; y += 1) {
    rawRows.push(Buffer.from([0]));
    rawRows.push(rgba.subarray(y * size * 4, (y + 1) * size * 4));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rawRows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rootVersion() {
  return readJson(path.join(ROOT, 'package.json')).version;
}

function manifest() {
  return readJson(path.join(SRC, 'manifest.json'));
}

function iconRel(size) {
  return `icons/kolm-${size}.png`;
}

function verifyPlan() {
  const mf = manifest();
  const missing = [];
  for (const rel of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(SRC, rel))) missing.push(rel);
  }
  for (const size of ICON_SIZES) {
    if (mf.icons?.[String(size)] !== iconRel(size)) missing.push(`manifest_icon_mapping:${size}`);
  }
  if (mf.version !== rootVersion()) missing.push(`version_mismatch:${mf.version || 'missing'}!=${rootVersion()}`);
  if (mf.manifest_version !== 3) missing.push('manifest_version_not_mv3');
  const sourceIcons = ICON_SIZES.map((size) => iconRel(size)).filter((rel) => fs.existsSync(path.join(SRC, rel)));
  return {
    spec: 'kolm-browser-extension-build-1',
    ok: missing.length === 0,
    dry_run: dryRun,
    package: 'kolm Verify',
    version: mf.version || null,
    manifest_version: mf.manifest_version || null,
    source: path.relative(ROOT, SRC),
    out_dir: path.relative(ROOT, OUT),
    zip_path: path.relative(ROOT, path.join(OUT, `kolm-verify-${rootVersion()}.zip`)),
    required_files: REQUIRED_FILES,
    icons: ICON_SIZES.map((size) => ({ size, path: iconRel(size), source_present: sourceIcons.includes(iconRel(size)) })),
    source_icons_present: sourceIcons.length === ICON_SIZES.length,
    icons_generated_by_build: true,
    secret_values_included: false,
    missing,
  };
}

async function buildZip(stage, zipPath) {
  const archiver = (await import('archiver')).default;
  await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    archive.directory(stage, false);
    archive.finalize();
  });
}

async function main() {
  const plan = verifyPlan();
  if (dryRun) {
    if (json) console.log(JSON.stringify(plan, null, 2));
    else console.log(`ok=${plan.ok} version=${plan.version} source_icons=${plan.source_icons_present}`);
    process.exit(plan.ok ? 0 : 1);
  }
  if (!plan.ok) {
    console.error(`browser-extension build plan failed: ${plan.missing.join(', ')}`);
    process.exit(1);
  }
  if (writeSourceIcons) {
    const iconDir = path.join(SRC, 'icons');
    fs.mkdirSync(iconDir, { recursive: true });
    for (const size of ICON_SIZES) fs.writeFileSync(path.join(iconDir, `kolm-${size}.png`), makeIcon(size));
  }
  const stage = path.join(OUT, `kolm-verify-${rootVersion()}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const rel of REQUIRED_FILES) fs.copyFileSync(path.join(SRC, rel), path.join(stage, rel));
  fs.mkdirSync(path.join(stage, 'icons'), { recursive: true });
  for (const size of ICON_SIZES) fs.writeFileSync(path.join(stage, iconRel(size)), makeIcon(size));
  const zipPath = path.join(OUT, `kolm-verify-${rootVersion()}.zip`);
  await buildZip(stage, zipPath);
  const out = { ...verifyPlan(), dry_run: false, zip_bytes: fs.statSync(zipPath).size };
  if (json) console.log(JSON.stringify(out, null, 2));
  else console.log(`browser-extension: wrote ${path.relative(ROOT, zipPath)} bytes=${out.zip_bytes}`);
}

main().catch((e) => {
  console.error(`browser-extension build failed: ${String(e && e.message || e)}`);
  process.exit(1);
});
